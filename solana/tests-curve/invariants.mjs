// The invariant checker and money-flow tracer of the vicinity_curve litesvm
// suites (VICINITY-CURVE-DESIGN.md section 9, L13, 12 intro). World.send runs
// `checkTransaction` after EVERY successful transaction of every test and
// `checkFailedTransaction` after every failed one; `probeLiveness` (I22) runs at
// the end of every test and wherever a test asks for it.
//
// What is checked, per successful transaction:
//   * SOL by the lamport difference of every account in the message (direct
//     lamport moves leave no inner instruction, RT-5): every change must be
//     explained by the fee, the system instructions that actually executed, the
//     native-token transfers that executed, the money events of vicinity_curve
//     (whose destinations are the fixed ones of 6.4) and Anchor's closes of an
//     Approval or a PayoutOptIn to their pinned receivers (I13, I14, I21).
//   * destinations (I14): every inner instruction of a vicinity_curve
//     instruction goes to System, SPL Token, Metaplex (in `launch` only) or the
//     program's own event CPI; every system transfer, account creation,
//     allocation and assignment inside one is pinned: a creation (or Anchor's
//     transfer, allocate and assign over a pre-funded address) only to an
//     account that very instruction creates (by its account table: the
//     Launchpad, a LaunchConfig, an Approval, the Coin, its mint, vault and
//     TickerLock, a PayoutOptIn), from that instruction's payer and for at most
//     the rent of what it creates; a transfer otherwise only to the Coin (the
//     buy's `charged`), FEE_RECIPIENT (the launch fee) or, inside Metaplex's
//     own CPI of `launch`, the metadata account it creates (its rent plus
//     Metaplex's 0.01 SOL fee, 3.10). Anything else is refused. The associated
//     token program's top-level creations are pinned the same way.
//   * tokens from the token instructions that actually executed (top level and
//     every CPI): coins leave a vault only to the buyer's token account inside a
//     `buy`, or by `burn` in `buyback_burn` or the launch's dust burn; no
//     approve, revoke, close, freeze, thaw, set-authority or mint touches a vault
//     or a mint after launch (I14); no coins are delivered to a token account
//     whose owner, delegate or close authority is a role key (I21).
//   * I6 after every Trade and every BuybackBurned event of a coin in its pool
//     phase, in event order (several instructions of one transaction included),
//     from the events' own after-figures; I5's vault == P explicitly at the end
//     of the instruction that graduates a coin.
//   * I20 at run time: the program bytes of vicinity_curve (and of the two
//     programs it reads) are those the World loaded, before and after every
//     transaction, successful or not; the World checks at every load that the
//     binary carries the compiled ids of its cluster and none of the other's.
//   * each coin's state by replaying the transaction's events through the SDK's
//     math port from the state before it: every quote, fee share, drip, counter
//     and after-figure of every Trade, Graduated, BuybackBurned and payout event
//     must equal the port's, and the replayed state must equal the account after
//     the transaction field by field (G01 parity with the program's real results,
//     I12, I15, I16, I17); then the per-coin invariants I1 to I11 on the account
//     and the global ones I19 to I21.
//   * the batch launch approval (I23 to I25, 8.6): the LaunchBatch account walked
//     through every call of the transaction (init_launch_batch, set_launch_approver,
//     publish_launch_batch, clear_launch_batch) from the account before it, each
//     call checked against the seats and the batch state of its moment, and the
//     walk must end at the account after the transaction; every launch_from_batch
//     re-checked from its own instruction data and signer: the batch it names in
//     force at that call (the SDK's batchRefusal), the leaf rebuilt with the SDK and
//     folded through the proof to that batch's root within the depth bound, no
//     Approval for the city at that moment, and the new Coin holding exactly the
//     leaf's founder, config terms, symbol, name and meta_hash.
// Per failed transaction: no account of the message changed except the fee
// payer's fee, and no vicinity_curve account changed at all.
import assert from 'node:assert/strict';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import web3 from '@solana/web3.js';
import * as S from '../sdk/curve/index.mjs';

const { PublicKey } = web3;
const ZERO = S.ADDRESSES.system;
const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Metaplex Token Metadata's own fee, charged to the payer of `launch` into the metadata account (3.10, O17). */
export const METAPLEX_CREATE_FEE = 10_000_000n;
/**
 * I14: what each vicinity_curve instruction may create, by the names of its
 * account table (4.1 to 4.20), and which of its accounts pays. An instruction
 * not listed here makes no system instruction at all, except `buy` (its one
 * transfer of `charged` from `user` to the Coin).
 */
export const CREATES = Object.freeze({
  init_launchpad: { payer: 'payer', accounts: ['launchpad'] },
  add_launch_config: { payer: 'payer', accounts: ['config'] },
  approve_launch: { payer: 'admin', accounts: ['approval'] },
  launch: { payer: 'payer', accounts: ['coin', 'mint', 'coin_vault', 'ticker_lock'], metaplex: 'metadata' },
  launch_from_batch: { payer: 'payer', accounts: ['coin', 'mint', 'coin_vault', 'ticker_lock'], metaplex: 'metadata' },
  opt_in_payout: { payer: 'founder', accounts: ['opt_in'] },
  init_launch_batch: { payer: 'payer', accounts: ['launch_batch'] },
});
/** The two instructions that create a coin (4.10, 4.27). */
export const LAUNCHES = Object.freeze(['launch', 'launch_from_batch']);
// PDA derivations are memoised: the checker derives the same few addresses for every coin after
// every transaction, and each derivation costs a hash and a curve check per bump tried.
const memo = new Map();
const cached = (key, fn) => { let v = memo.get(key); if (v === undefined) { v = fn(); memo.set(key, v); } return v; };
const metadataOf = (mint) => cached(`md:${mint}`, () => S.metadataAddress(mint));
const ataOf = (owner, mint) => cached(`ata:${owner}:${mint}`, () => S.associatedTokenAddress(owner, mint));
const programDataOf = (id) => cached(`pd:${id}`, () => S.findPda([new PublicKey(id).toBuffer()], S.ADDRESSES.upgradeableLoader)[0]);
const accountOf = (t, name) => {
  const i = S.ACCOUNT_TABLES[t.name].findIndex(([n]) => n === name);
  assert.ok(i >= 0, `no account ${name} in ${t.name}`);
  return t.accounts[i];
};
const INSTRUCTION_BY_DISC = new Map(Object.entries(S.INSTRUCTION_DISCRIMINATORS).map(([n, d]) => [Buffer.from(d).toString('hex'), n]));

// ---------------------------------------------------------------- reading accounts
const u64At = (d, at) => Buffer.from(d).readBigUInt64LE(at);
export function tokenAccountInfo(acc) {
  if (!acc || acc.owner !== S.ADDRESSES.token || acc.data.length < 165) return null;
  const d = Buffer.from(acc.data);
  return {
    mint: new PublicKey(d.subarray(0, 32)).toBase58(), owner: new PublicKey(d.subarray(32, 64)).toBase58(), amount: d.readBigUInt64LE(64),
    delegate: d.readUInt32LE(72) === 1 ? new PublicKey(d.subarray(76, 108)).toBase58() : null, state: d[108],
    isNative: d.readUInt32LE(109) === 1, delegatedAmount: d.readBigUInt64LE(121),
    closeAuthority: d.readUInt32LE(129) === 1 ? new PublicKey(d.subarray(133, 165)).toBase58() : null,
  };
}
export function mintInfo(acc) {
  if (!acc || acc.owner !== S.ADDRESSES.token || acc.data.length < 82) return null;
  const d = Buffer.from(acc.data);
  return {
    mintAuthority: d.readUInt32LE(0) === 1 ? new PublicKey(d.subarray(4, 36)).toBase58() : null, supply: d.readBigUInt64LE(36),
    decimals: d[44], isInitialized: d[45] === 1, freezeAuthority: d.readUInt32LE(46) === 1 ? new PublicKey(d.subarray(50, 82)).toBase58() : null,
  };
}
/** Metaplex metadata v1 account: update authority, mint, name, symbol, uri, creators, is_mutable. */
export function readMetadata(data) {
  const b = Buffer.from(data);
  let o = 1;
  const key = () => { const k = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const updateAuthority = key(); const mint = key();
  const name = str(); const symbol = str(); const uri = str();
  const sellerFeeBasisPoints = b.readUInt16LE(o); o += 2;
  const hasCreators = b[o++];
  if (hasCreators) o += 4 + b.readUInt32LE(o) * 34;
  o += 1; // primary_sale_happened
  const isMutable = b[o] === 1;
  return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, hasCreators: hasCreators === 1, isMutable };
}

/**
 * Every vicinity_curve account, decoded, plus each coin's vault and mint (the state the checker compares).
 * With `keys` (the accounts a transaction loads), the vault and mint are read only for the coins the
 * transaction can touch: no other account can change.
 */
export function snapshot(w, keys) {
  const programId = w.programId;
  const accounts = new Map();
  const coins = new Map(); const configs = new Map(); const approvals = new Map(); const tickers = new Map(); const optIns = new Map();
  let launchpad = null; let launchBatch = null;
  for (const a of w.svm.getProgramAccounts(address(programId))) {
    const acc = { address: String(a.address), owner: String(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) };
    accounts.set(acc.address, acc);
    const type = S.accountType(acc, { programId });
    if (type === 'CurveCoin') coins.set(acc.address, { ...S.decodeCurveCoin(acc, { programId }), address: acc.address, lamports: acc.lamports, raw: acc.data });
    else if (type === 'LaunchConfig') configs.set(acc.address, { ...S.decodeLaunchConfig(acc, { programId }), address: acc.address, raw: acc.data });
    else if (type === 'Approval') approvals.set(acc.address, { ...S.decodeApproval(acc, { programId }), address: acc.address, lamports: acc.lamports });
    else if (type === 'TickerLock') tickers.set(acc.address, { ...S.decodeTickerLock(acc, { programId }), address: acc.address, raw: acc.data });
    else if (type === 'PayoutOptIn') optIns.set(acc.address, { ...S.decodePayoutOptIn(acc, { programId }), address: acc.address, lamports: acc.lamports });
    else if (type === 'Launchpad') launchpad = { ...S.decodeLaunchpad(acc, { programId }), address: acc.address };
    else if (type === 'LaunchBatch') launchBatch = { ...S.decodeLaunchBatch(acc, { programId }), address: acc.address, raw: acc.data };
    else assert.fail(`unknown account ${acc.address} owned by vicinity_curve (${acc.data.length} bytes)`);
  }
  for (const c of coins.values()) {
    // the same criterion as checkTransaction's: the Coin, its vault, its mint or its metadata loaded
    if (keys && !(keys.has(c.address) || keys.has(c.vault) || keys.has(c.mint) || keys.has(metadataOf(c.mint)))) { c.vaultAmount = undefined; c.mintInfo = { supply: undefined }; continue; }
    c.vaultAmount = tokenAccountInfo(w.accountInfo(c.vault))?.amount ?? null;
    c.mintInfo = mintInfo(w.accountInfo(c.mint));
  }
  const clock = w.svm.getClock();
  return { slot: BigInt(clock.slot), ts: BigInt(clock.unixTimestamp), accounts, coins, configs, approvals, tickers, optIns, launchpad, launchBatch };
}

// ---------------------------------------------------------------- the transaction
/** Decode a sent transaction: keys, signers, top-level instructions with their inner instructions, log segments and events. */
/**
 * Decode a sent transaction: keys, signers, top-level instructions with their inner instructions, log
 * segments and events, and every call of vicinity_curve, top level or by CPI from another program (a
 * router, G02). Each call carries its own inner instructions (those deeper than it, until the stack
 * returns to its level), its depth and its events; each inner instruction knows the innermost call it
 * belongs to. `steps` lists, in execution order, the indices the checker steps a vault through.
 */
export function decodeTransaction(w, { messageBytes, inner, logs, lookupAddresses = [] }) {
  const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const keys = [...msg.staticAccounts.map(String), ...lookupAddresses.map(String)];
  const nSigners = msg.header.numSignerAccounts;
  const signers = new Set(keys.slice(0, nSigners));
  const segments = splitLogs(logs);
  const calls = []; const steps = [];
  const isEventCpi = (ii) => ii.program === w.programId && ii.data.length >= 8 && S.EVENT_IX_TAG.every((x, k) => ii.data[k] === x);
  const nameOf = (data) => INSTRUCTION_BY_DISC.get(Buffer.from(data).subarray(0, 8).toString('hex')) ?? null;
  const eventsOf = (call) => {
    const out = [];
    for (const ii of call.inner) {
      if (!isEventCpi(ii)) continue;
      const e = S.decodeEventCpi({ programId: ii.program, accounts: ii.accounts, data: ii.data }, { programId: w.programId });
      assert.ok(e, `an event CPI not signed by the event authority (${ii.accounts.join(',')})`);
      assert.ok(S.CPI_EVENTS.includes(e.name), `${e.name} must not be an event CPI`);
      assert.equal(ii.stackHeight, call.depth + 1, `${e.name}: the event CPI comes from the call that emits it`);
      out.push(e);
    }
    return out;
  };
  const top = msg.instructions.map((ix, i) => {
    const program = keys[ix.programAddressIndex];
    const accounts = (ix.accountIndices ?? []).map((k) => keys[k]);
    const data = Buffer.from(ix.data ?? []);
    const innerIxs = (inner[i] ?? []).map((ii) => {
      const c = ii.instruction();
      return { program: keys[c.programIdIndex()], accounts: Array.from(c.accounts()).map((k) => keys[k]), data: Buffer.from(c.data()), stackHeight: ii.stackHeight(), call: null };
    });
    const name = program === w.programId ? nameOf(data) : null;
    const seg = segments[i] ?? [];
    const t = { index: i, program, accounts, data, name, inner: innerIxs, events: [], calls: [], logs: seg, cu: computeOf(seg, program), depth: 1 };
    // the calls of vicinity_curve within this instruction: itself, or CPIs into it (not its own event CPIs)
    const mine = [];
    if (program === w.programId) mine.push({ ...t, inner: innerIxs, top: t });
    else steps.push(i);
    innerIxs.forEach((ii, j) => {
      if (ii.program !== w.programId || isEventCpi(ii)) return;
      const callName = nameOf(ii.data);
      assert.ok(callName, `a CPI into vicinity_curve with an unknown instruction (${ii.data.subarray(0, 8).toString('hex')})`);
      let end = j + 1;
      while (end < innerIxs.length && innerIxs[end].stackHeight > ii.stackHeight) end++;
      mine.push({ index: i + (mine.length + 1) / 1000, program: ii.program, accounts: ii.accounts, data: ii.data, name: callName, inner: innerIxs.slice(j + 1, end), depth: ii.stackHeight, logs: seg, cu: null, top: t, viaCpi: true, innerAt: j });
    });
    // each inner instruction belongs to the innermost call that contains it
    for (const c of mine) for (const ii of c.inner) if (!ii.call || ii.call.depth < c.depth) ii.call = c;
    for (const c of mine) {
      c.events = eventsOf(c);
      if (!c.viaCpi) {
        const logEvents = S.decodeEventLogs(seg, { programId: w.programId });
        for (const e of logEvents) assert.ok(!S.CPI_EVENTS.includes(e.name), `${e.name} must be an event CPI, not a log (4.21)`);
        c.events.push(...logEvents);
      }
      calls.push(c); steps.push(c.index); t.calls.push(c); t.events.push(...c.events);
    }
    for (const ii of innerIxs) {
      if (ii.program === w.programId && isEventCpi(ii)) assert.ok(ii.call, 'an event CPI outside any call of vicinity_curve');
    }
    return t;
  });
  return { keys, signers, feePayer: keys[0], nSignatures: nSigners, top, calls, steps };
}
function splitLogs(logs) {
  const out = [];
  let depth = 0;
  for (const line of logs) {
    const inv = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (inv && inv[2] === '1') { out.push([line]); depth = 1; continue; }
    if (out.length) out[out.length - 1].push(line);
    if (inv) depth = Number(inv[2]);
  }
  return out;
}
function computeOf(seg, program) {
  for (let k = seg.length - 1; k >= 0; k--) {
    const m = new RegExp(`^Program ${program} consumed (\\d+) of (\\d+) compute units$`).exec(seg[k]);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------- failed transactions
/**
 * A failed transaction moved nothing but its fee: the fee payer paid exactly the fee (5,000 lamports per signature)
 * when the transaction ran and failed, and nothing at all when the runtime refused it before execution (`charged`
 * false: its fee payer missing or unable to pay, a bad signature or blockhash, L2); no other account changed.
 */
export function checkFailedTransaction(w, { pre, post, preAccounts, postAccounts, feePayer, nSignatures, label, charged = true }) {
  checkProgramBytes(w, label);
  const fee = charged ? LAMPORTS_PER_SIGNATURE * BigInt(nSignatures) : 0n;
  for (const [k, a] of preAccounts) {
    const b = postAccounts.get(k);
    const want = k === feePayer ? a.lamports - fee : a.lamports;
    assert.equal(b?.lamports ?? 0n, want, `${label} (failed): lamports of ${k} moved`);
    if (a.exists || b?.exists) {
      assert.equal(b?.owner, a.owner, `${label} (failed): owner of ${k} changed`);
      assert.ok(Buffer.from(b?.data ?? []).equals(Buffer.from(a.data ?? [])), `${label} (failed): data of ${k} changed`);
    }
  }
  assert.equal(post.accounts.size, pre.accounts.size, `${label} (failed): vicinity_curve accounts appeared or vanished`);
  for (const [k, a] of pre.accounts) {
    const b = post.accounts.get(k);
    assert.ok(b && b.lamports === a.lamports && b.data.equals(a.data), `${label} (failed): vicinity_curve account ${k} changed`);
  }
}

// ---------------------------------------------------------------- I20 at run time, I21's keys
/**
 * I20: the code of every program the World loaded (its ProgramData after the
 * 45-byte header, which holds the deploy slot and the upgrade authority) is
 * unchanged by any transaction: no upgrade happened, so the compiled ids are
 * the ones the World checked at load (World.recordPrograms).
 */
export const PROGRAM_DATA_HEADER = 45;
export function checkProgramBytes(w, label) {
  for (const [id, code] of w.programBytes ?? []) {
    const pd = w.accountInfo(programDataOf(id));
    assert.ok(pd && pd.data.subarray(PROGRAM_DATA_HEADER).equals(code), `${label}: I20 the code of ${id} changed without an upgrade`);
  }
}
/**
 * The compiled ids a vicinity_curve binary carries (3.2): the ids stored as
 * plain bytes in its read-only data (the program's own, vicinity_rewards',
 * the old program's and Metaplex's) must be those of `cluster`, and none of
 * the other cluster's. FEE_RECIPIENT, LEGACY_LAUNCHPAD and REWARDS_REGISTRY
 * are compared as immediates in the code, not stored whole; the checker sees
 * them at run time instead (every launch fee and withdrawal goes to
 * FEE_RECIPIENT, every approval and launch reads the old Launchpad and the
 * rewards registry at their compiled addresses).
 */
export function compiledIdsProblems(binary, { programId, cluster }) {
  const b = Buffer.from(binary);
  const has = (k) => b.indexOf(new PublicKey(k).toBuffer()) >= 0;
  const out = [];
  const want = S.CLUSTERS[cluster]; const other = S.CLUSTERS[cluster === 'mainnet' ? 'devnet' : 'mainnet'];
  for (const [what, k] of [['program id', programId], ['REWARDS_PROGRAM_ID', want.rewardsProgram], ['LEGACY_PROGRAM_ID', want.legacyProgram], ['METAPLEX_PROGRAM_ID', S.ADDRESSES.metaplex]]) {
    if (!has(k)) out.push(`${what} ${k} missing`);
  }
  for (const [what, k] of [['REWARDS_PROGRAM_ID', other.rewardsProgram], ['LEGACY_PROGRAM_ID', other.legacyProgram], ['LEGACY_LAUNCHPAD', other.legacyLaunchpad], ['REWARDS_REGISTRY', other.rewardsRegistry]]) {
    if (has(k)) out.push(`the other cluster's ${what} ${k} present`);
  }
  return out;
}
/** I21's keys: the World's role keys and whatever the Launchpad names as admin, pending admin, guardian, payout key or launch approver, before or after. */
export function roleKeysOf(w, pre, post) {
  const out = new Set(w.roleKeys());
  for (const lp of [pre?.launchpad, post?.launchpad]) {
    if (!lp) continue;
    for (const k of [lp.admin, lp.pendingAdmin, lp.guardian, lp.payoutAuthority, lp.launchApprover]) if (k && k !== ZERO) out.add(k);
  }
  return [...out];
}

// ---------------------------------------------------------------- I14: destinations of every system instruction
/**
 * Every inner instruction of a vicinity_curve instruction goes to System, SPL
 * Token, Metaplex (only `launch`, only its CreateMetadataAccountsV3) or the
 * program's own event CPI; inside Metaplex only System. Every system
 * instruction is pinned to the accounts that instruction creates (CREATES),
 * the Coin (`buy`), FEE_RECIPIENT (`launch`) or the metadata account Metaplex
 * creates; anything else fails. The associated token program's creations are
 * pinned to the token account it creates.
 */
export function checkDestinations(w, { tx, preAccounts, postAccounts, label }) {
  const rent = (k) => w.svm.minimumBalanceForRentExemption(BigInt(postAccounts.get(k)?.data?.length ?? 0));
  const freshBefore = (k) => { const a = preAccounts.get(k); return !a?.exists || (a.owner === ZERO && a.data.length === 0); };
  const sysOf = (ii) => {
    const tag = ii.data.length >= 4 ? ii.data.readUInt32LE(0) : -1;
    if (tag === 0) return { tag, kind: 'create_account', from: ii.accounts[0], to: ii.accounts[1], amount: ii.data.readBigUInt64LE(4), owner: new PublicKey(ii.data.subarray(20, 52)).toBase58() };
    if (tag === 2) return { tag, kind: 'transfer', from: ii.accounts[0], to: ii.accounts[1], amount: ii.data.readBigUInt64LE(4) };
    if (tag === 1) return { tag, kind: 'assign', to: ii.accounts[0], owner: new PublicKey(ii.data.subarray(4, 36)).toBase58() };
    if (tag === 8) return { tag, kind: 'allocate', to: ii.accounts[0] };
    return { tag, kind: `system instruction ${tag}` };
  };
  for (const t of [...tx.calls, ...tx.top.filter((x) => x.program === S.ADDRESSES.associatedToken)]) {
    if (t.program === w.programId && t.name) {
      const spec = CREATES[t.name];
      const created = new Map(); // address -> owner it must end with
      if (spec) {
        for (const n of spec.accounts) created.set(accountOf(t, n), ['mint', 'coin_vault'].includes(n) ? S.ADDRESSES.token : w.programId);
      }
      const payer = spec ? accountOf(t, spec.payer) : t.name === 'buy' ? accountOf(t, 'user') : null;
      const metadata = spec?.metaplex ? accountOf(t, spec.metaplex) : null;
      const credited = new Map();
      for (const ii of t.inner) {
        if (ii.program === w.programId || ii.program === S.ADDRESSES.token) continue; // event CPIs (decodeTransaction) and token flows (below)
        if (ii.program === S.ADDRESSES.metaplex) {
          assert.ok(metadata && ii.stackHeight === t.depth + 1 && ii.data[0] === 33 && ii.accounts[0] === metadata,
            `${label}: ${t.name} called Metaplex outside launch's CreateMetadataAccountsV3 of its own metadata`);
          continue;
        }
        assert.equal(ii.program, S.ADDRESSES.system, `${label}: I14 ${t.name} called ${ii.program} (only System, SPL Token, Metaplex and its own event CPI)`);
        const s = sysOf(ii);
        const inMetaplex = ii.stackHeight === t.depth + 2 && metadata !== null;
        if (!inMetaplex) assert.equal(ii.stackHeight, t.depth + 1, `${label}: I14 a system instruction at depth ${ii.stackHeight} under ${t.name}`);
        if (s.kind === 'create_account' || s.kind === 'transfer') {
          assert.equal(s.from, payer, `${label}: I14 ${t.name}'s ${s.kind} from ${s.from}, not its payer ${payer}`);
          credited.set(s.to, (credited.get(s.to) ?? 0n) + s.amount);
        }
        if (inMetaplex) {
          assert.ok(['transfer', 'allocate', 'assign'].includes(s.kind) && s.to === metadata, `${label}: I14 Metaplex's ${s.kind} to ${s.to}, not the metadata account it creates`);
          if (s.kind === 'assign') assert.equal(s.owner, S.ADDRESSES.metaplex);
          continue;
        }
        if (t.name === 'buy') {
          assert.ok(s.kind === 'transfer' && s.to === accountOf(t, 'coin'), `${label}: I14 buy's ${s.kind} to ${s.to}, not the Coin`);
          continue;
        }
        if (LAUNCHES.includes(t.name) && s.kind === 'transfer' && s.to === S.ADDRESSES.feeRecipient) continue; // the launch fee (checkLaunch: exactly the config's)
        assert.ok(created.has(s.to), `${label}: I14 ${t.name}'s ${s.kind} to ${s.to}, which it does not create`);
        if (s.kind === 'create_account' || s.kind === 'assign') assert.equal(s.owner, created.get(s.to), `${label}: I14 ${s.to} assigned to ${s.owner}`);
      }
      for (const [k, owner] of created) {
        const a = postAccounts.get(k);
        assert.ok(freshBefore(k) && a?.exists && a.owner === owner, `${label}: I14 ${t.name} did not create ${k} (owner ${a?.owner})`);
        assert.ok((credited.get(k) ?? 0n) <= rent(k), `${label}: I14 ${t.name} paid ${credited.get(k)} into ${k}, more than its rent ${rent(k)}`);
      }
      if (metadata) {
        const a = postAccounts.get(metadata);
        assert.ok(freshBefore(metadata) && a?.exists && a.owner === S.ADDRESSES.metaplex, `${label}: I14 the metadata account was not created`);
        assert.ok((credited.get(metadata) ?? 0n) <= rent(metadata) + METAPLEX_CREATE_FEE, `${label}: I14 ${credited.get(metadata)} paid into the metadata account (rent plus 0.01 SOL at most)`);
      }
    } else if (t.program === S.ADDRESSES.associatedToken) {
      const [payer, ata] = t.accounts;
      for (const ii of t.inner) {
        if (ii.program === S.ADDRESSES.token) continue;
        assert.equal(ii.program, S.ADDRESSES.system, `${label}: the associated token program called ${ii.program}`);
        const s = sysOf(ii);
        assert.ok(['create_account', 'transfer', 'allocate', 'assign'].includes(s.kind) && s.to === ata, `${label}: I14 the associated token program's ${s.kind} to ${s.to}, not the token account it creates`);
        if (s.from) assert.equal(s.from, payer);
        if (s.amount !== undefined) assert.ok(s.amount <= rent(ata), `${label}: I14 more than the token account's rent`);
      }
    }
  }
}

// ---------------------------------------------------------------- successful transactions
export function checkTransaction(w, ctx) {
  const { pre, post, tx, preAccounts, postAccounts, label, opts = {} } = ctx;
  const P = w.P;
  const coinByCity = new Map();
  for (const c of [...pre.coins.values(), ...post.coins.values()]) coinByCity.set(c.cityId, c.address);
  checkProgramBytes(w, label);
  checkDestinations(w, { tx, pre, post, preAccounts, postAccounts, label });
  const roles = roleKeysOf(w, pre, post);

  // ------------------------------------------------ SOL: every lamport change explained (I13, I14, I21)
  const exp = new Map();
  const addD = (k, d) => exp.set(k, (exp.get(k) ?? 0n) + d);
  const fee = LAMPORTS_PER_SIGNATURE * BigInt(tx.nSignatures);
  addD(tx.feePayer, -fee);
  const credits = []; // { to, amount, kind }
  const moves = (from, to, amount, kind) => { addD(from, -amount); addD(to, amount); credits.push({ from, to, amount, kind }); };
  const allIxs = [];
  for (const t of tx.top) { allIxs.push({ ...t, top: t.calls.find((c) => !c.viaCpi) ?? t }); for (const ii of t.inner) allIxs.push({ ...ii, top: ii.call ?? t }); }
  const runningNative = new Map(); // lamports a native token account gained or lost inside the tx
  for (const ix of allIxs) {
    if (ix.program === S.ADDRESSES.system && ix.data.length >= 4) {
      const tag = ix.data.readUInt32LE(0);
      if (tag === 0) moves(ix.accounts[0], ix.accounts[1], ix.data.readBigUInt64LE(4), 'create_account');
      else if (tag === 2) moves(ix.accounts[0], ix.accounts[1], ix.data.readBigUInt64LE(4), 'transfer');
      else if (tag === 3) {
        const seedLen = Number(ix.data.readBigUInt64LE(36));
        moves(ix.accounts[0], ix.accounts[1], ix.data.readBigUInt64LE(44 + seedLen), 'create_account_with_seed');
      } else if (tag === 11) moves(ix.accounts[0], ix.accounts[2], ix.data.readBigUInt64LE(4), 'transfer_with_seed');
      else assert.ok([1, 8, 9, 10].includes(tag), `${label}: unexpected system instruction ${tag}`);
    } else if (ix.program === S.ADDRESSES.token && ix.data.length >= 1) {
      const tag = ix.data[0];
      if (tag === 3 || tag === 12) {
        const src = ix.accounts[0]; const dst = tag === 3 ? ix.accounts[1] : ix.accounts[2];
        const info = tokenAccountInfo(preAccounts.get(src)?.exists ? preAccounts.get(src) : null);
        if (info?.isNative) {
          const amount = ix.data.readBigUInt64LE(1);
          moves(src, dst, amount, 'native token transfer');
          runningNative.set(src, (runningNative.get(src) ?? 0n) - amount);
          runningNative.set(dst, (runningNative.get(dst) ?? 0n) + amount);
        }
      } else if (tag === 9) {
        const src = ix.accounts[0];
        const all = (preAccounts.get(src)?.lamports ?? 0n) + (exp.get(src) ?? 0n);
        moves(src, ix.accounts[1], all, 'close token account');
      }
    }
  }
  // money events of vicinity_curve: the debit helper's direct lamport moves (6.5)
  const coinOfEvent = (e) => { const c = coinByCity.get(e.data.city_id); assert.ok(c, `${label}: ${e.name} for unknown city ${e.data.city_id}`); return c; };
  const moneyOut = new Map(); // coin -> lamports out by events
  const buysIn = new Map(); // coin -> lamports charged by buys
  for (const t of tx.calls) {
    for (const e of t.events) {
      const d = e.data;
      let to = null; let amount = 0n;
      if (e.name === 'Trade' && !d.is_buy) { to = d.user; amount = d.sol_net; assert.equal(t.name, 'sell'); assert.equal(to, t.accounts[0], 'a sell pays its signer `user`'); }
      if (e.name === 'Trade' && d.is_buy) {
        assert.equal(t.name, 'buy');
        const c = coinOfEvent(e);
        const xfer = t.inner.filter((ii) => ii.program === S.ADDRESSES.system && ii.data.readUInt32LE(0) === 2);
        assert.equal(xfer.length, 1, `${label}: a buy makes exactly one system transfer`);
        assert.equal(xfer[0].accounts[0], t.accounts[0], 'from the buyer');
        assert.equal(xfer[0].accounts[1], c, 'to the Coin');
        assert.equal(xfer[0].data.readBigUInt64LE(4), d.sol_amount, 'exactly `charged`');
        buysIn.set(c, (buysIn.get(c) ?? 0n) + d.sol_amount);
      }
      if (e.name === 'PlatformFeesWithdrawn') { to = S.ADDRESSES.feeRecipient; amount = d.amount; assert.equal(t.name, 'withdraw_platform_fees'); }
      if (e.name === 'FounderFeesClaimed') { to = d.founder; amount = d.amount; assert.equal(t.name, 'claim_founder_fees'); assert.equal(to, t.accounts[0], 'the signing founder'); }
      if (e.name === 'FounderPaidOut') { to = d.destination; amount = d.amount; assert.equal(t.name, 'payout_founder_fees'); }
      if (e.name === 'HoldersFeesForwarded') { to = d.rewards_vault; amount = d.amount; assert.equal(t.name, 'forward_holders_fees'); }
      if (to !== null) {
        const c = coinOfEvent(e);
        moves(c, to, amount, e.name);
        moneyOut.set(c, (moneyOut.get(c) ?? 0n) + amount);
        if (e.name === 'FounderPaidOut') {
          const lp = pre.launchpad;
          assert.equal(to, lp.payoutDestination, 'payout only to the configured wallet');
          const oi = pre.optIns.get(P.payoutOptIn(c));
          assert.ok(oi && oi.founder === pre.coins.get(c).founder && oi.agreedDestination === to, 'with an opt-in signed by the current founder naming it');
        }
        if (e.name === 'HoldersFeesForwarded') {
          const r = P.rewardsAccounts(pre.coins.get(c).mint);
          assert.equal(to, r.vault, 'the derived rewards vault');
          const view = S.decodeRewardsCityConfig(w.accountInfo(r.config), { cluster: w.cluster });
          assert.deepEqual(S.rewardsConfigProblems(view, { mint: pre.coins.get(c).mint, vault: r.vault, admin: pre.launchpad.admin }), [], 'a correct rewards config');
        }
      }
    }
  }
  // Anchor closes (Approval, PayoutOptIn) to their pinned receivers; nothing else of ours ever closes (T30)
  for (const [k, a] of pre.accounts) {
    if (post.accounts.has(k)) continue;
    let to;
    if (pre.approvals.has(k)) to = pre.approvals.get(k).rentPayer;
    else if (pre.optIns.has(k)) to = pre.optIns.get(k).founder;
    else assert.fail(`${label}: vicinity_curve account ${k} closed (only an Approval or a PayoutOptIn may close)`);
    moves(k, to, a.lamports, 'close');
  }
  // compare with what really happened. Other programs under no test here (the old vicinity_launchpad,
  // vicinity_rewards, Meteora DBC, Metaplex called directly) may move lamports directly among the accounts
  // of their own top-level instructions (their closes, for example): there the residual must sum to zero
  // and never touch an account of vicinity_curve.
  const PLAIN = new Set([w.programId, S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.associatedToken, S.ADDRESSES.computeBudget]);
  const foreign = new Set();
  for (const t of tx.top) if (!PLAIN.has(t.program)) for (const a of t.accounts) foreign.add(a);
  const keys = new Set([...tx.keys, ...exp.keys()]);
  let residualSum = 0n;
  for (const k of keys) {
    const before = preAccounts.get(k)?.lamports ?? 0n;
    const after = postAccounts.get(k)?.lamports ?? 0n;
    const residual = after - before - (exp.get(k) ?? 0n);
    if (residual !== 0n && foreign.has(k) && !pre.accounts.has(k) && !post.accounts.has(k)) { residualSum += residual; continue; }
    assert.equal(after - before, exp.get(k) ?? 0n, `${label}: lamports of ${k} changed by ${after - before}, explained ${exp.get(k) ?? 0n}`);
  }
  assert.equal(residualSum, 0n, `${label}: other programs' direct lamport moves do not balance`);
  // I21: no lamports to the admin, the guardian, the payout key, the upgrade authority or the keeper
  for (const r of roles) {
    for (const c of credits) {
      if (c.to !== r || c.from === r || c.amount === 0n) continue;
      const ok = c.kind === 'close' && pre.approvals.has(c.from) && pre.approvals.get(c.from).rentPayer === r;
      assert.ok(ok, `${label}: I21 ${c.amount} lamports to role key ${r} (${c.kind})`);
    }
    for (const t of tx.calls) for (const e of t.events) if (e.name === 'Trade') assert.notEqual(e.data.user, r, `${label}: I21 a role key traded`);
  }

  // ------------------------------------------------ tokens (I14)
  const vaults = new Map(); const mints = new Map();
  for (const c of [...pre.coins.values(), ...post.coins.values()]) { vaults.set(c.vault, c.address); mints.set(c.mint, c.address); }
  const tokenFlows = { buyOut: new Map(), sellIn: new Map(), burned: new Map(), holderBurned: new Map(), donated: new Map() };
  const bump = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + v);
  // per coin, the vault's change in each top-level instruction (I5: the vault holds P when the coin graduates)
  const vaultStep = new Map(); const donStep = new Map();
  const stepVault = (coin, index, d) => { const m = vaultStep.get(coin) ?? new Map(); m.set(index, (m.get(index) ?? 0n) + d); vaultStep.set(coin, m); };
  for (const ix of allIxs) {
    if (ix.program === S.ADDRESSES.token2022) {
      assert.ok(!ix.accounts.some((a) => vaults.has(a) || mints.has(a)), `${label}: Token-2022 touched a coin account`);
      continue;
    }
    if (ix.program !== S.ADDRESSES.token || ix.data.length === 0) continue;
    const tag = ix.data[0]; const a = ix.accounts; const topName = ix.top.name;
    const amount = ix.data.length >= 9 ? ix.data.readBigUInt64LE(1) : 0n;
    switch (tag) {
      case 3: case 12: {
        const src = a[0]; const dst = tag === 3 ? a[1] : a[2];
        if (vaults.has(src)) {
          assert.equal(topName, 'buy', `${label}: coins left a vault outside a buy`);
          assert.equal(dst, ix.top.accounts[5], 'only to the buy\'s user_token_account');
          assert.equal(src, ix.top.accounts[4]);
          bump(tokenFlows.buyOut, vaults.get(src), amount);
          stepVault(vaults.get(src), ix.top.index, -amount);
          // I21 (tokens): never to a token account a role key owns, may spend (delegate) or may close
          const to = tokenAccountInfo(postAccounts.get(dst)?.exists ? postAccounts.get(dst) : null);
          assert.ok(to, `${label}: coins delivered to ${dst}, which is not a token account after the transaction`);
          for (const [what, k] of [['owner', to.owner], ['delegate', to.delegate], ['close authority', to.closeAuthority]]) {
            assert.ok(!k || !roles.includes(k), `${label}: I21 coins delivered to a token account whose ${what} is the role key ${k}`);
          }
        }
        if (vaults.has(dst)) {
          if (topName === 'sell') { assert.equal(src, ix.top.accounts[5]); bump(tokenFlows.sellIn, vaults.get(dst), amount); } else {
            assert.ok(opts.tokenDonation, `${label}: tokens sent to a vault outside a sell (an undeclared donation)`);
            bump(tokenFlows.donated, vaults.get(dst), amount);
            const dm = donStep.get(vaults.get(dst)) ?? new Map(); dm.set(ix.top.index, (dm.get(ix.top.index) ?? 0n) + amount); donStep.set(vaults.get(dst), dm);
          }
          stepVault(vaults.get(dst), ix.top.index, amount);
        }
        break;
      }
      case 8: case 15: {
        if (vaults.has(a[0])) {
          assert.ok(topName === 'buyback_burn' || LAUNCHES.includes(topName), `${label}: a burn from a vault outside buyback_burn and a launch`);
          bump(tokenFlows.burned, vaults.get(a[0]), amount);
          stepVault(vaults.get(a[0]), ix.top.index, -amount);
        } else if (mints.has(a[1])) {
          assert.ok(opts.holderBurn, `${label}: an undeclared holder burn`);
          bump(tokenFlows.holderBurned, a[1], amount);
        }
        break;
      }
      case 7: case 14:
        if (mints.has(a[0])) {
          assert.ok(LAUNCHES.includes(topName), `${label}: mint_to outside a launch`);
          assert.equal(a[1], post.coins.get(mints.get(a[0])).vault, 'minted into the vault');
          assert.equal(amount, S.COIN_SUPPLY, 'exactly COIN_SUPPLY, once');
          stepVault(mints.get(a[0]), ix.top.index, amount);
        }
        break;
      case 6:
        if (mints.has(a[0]) || vaults.has(a[0])) {
          assert.ok(LAUNCHES.includes(topName), `${label}: set_authority on a coin account outside a launch`);
          assert.ok(mints.has(a[0]) && ix.data[1] === 0 && ix.data[2] === 0, 'only the mint authority, to None');
        }
        break;
      case 4: case 13: case 5: case 9: case 10: case 11:
        assert.ok(!vaults.has(a[0]) && !(tag >= 10 && mints.has(a[1])), `${label}: token instruction ${tag} on a vault or mint`);
        break;
      case 0: case 20: case 1: case 16: case 18:
        if (mints.has(a[0]) || vaults.has(a[0])) assert.ok(LAUNCHES.includes(topName), `${label}: initialize of a coin account outside a launch`);
        break;
      default: break;
    }
  }

  // declared out-of-band movements count from this transaction on (I9, I10, I11)
  if (opts.lamportDonation) {
    const { coin, amount } = opts.lamportDonation;
    w.lamportDonations.set(coin, (w.lamportDonations.get(coin) ?? 0n) + amount);
  }
  for (const [coin, amount] of tokenFlows.donated) w.tokenDonations.set(coin, (w.tokenDonations.get(coin) ?? 0n) + amount);
  for (const [mint, amount] of tokenFlows.holderBurned) w.holderBurns.set(mint, (w.holderBurns.get(mint) ?? 0n) + amount);

  // ------------------------------------------------ per coin: replay the events, then I1 to I11
  const txSlot = post.slot; const txTs = post.ts;
  const rentMin = w.svm.minimumBalanceForRentExemption(BigInt(S.ACCOUNT_LEN.CurveCoin));
  for (const coin of pre.coins.keys()) assert.ok(post.coins.has(coin), `${label}: Coin ${coin} vanished (I19)`);
  const inTx = new Set(tx.keys);
  for (const [addr, c] of post.coins) {
    const b = pre.coins.get(addr);
    const events = tx.calls.flatMap((t) => t.events.map((e) => ({ ...e, top: t }))).filter((e) => e.data.city_id === c.cityId);
    // A coin none of whose accounts (Coin, vault, mint, metadata) the transaction loaded cannot have
    // changed; it is checked to be byte-identical instead of re-running every invariant (they held
    // after the transaction that last touched it).
    if (b && !events.length && ![addr, c.vault, c.mint, metadataOf(c.mint)].some((k) => inTx.has(k))) {
      assert.ok(c.raw.equals(b.raw) && c.lamports === b.lamports && c.vaultAmount === b.vaultAmount && c.mintInfo.supply === b.mintInfo.supply,
        `${label}: ${c.symbol} changed although the transaction did not load any of its accounts`);
      continue;
    }
    const terms = S.coinTerms(c);
    let st; let ext; let launched = false;
    if (!b) {
      const cl = events.find((e) => e.name === 'CoinLaunched');
      assert.ok(cl, `${label}: a new Coin without CoinLaunched`);
      launched = true;
      checkLaunch(w, { c, cl, pre, label, txSlot, txTs, rentMin, tx, preAccounts });
      st = S.stateAtLaunch(txSlot);
      ext = { founder: c.founder, platformWithdrawn: 0n, founderClaimed: 0n, founderPaidOut: 0n, holdersForwarded: 0n, payoutSeq: 0n, lastPayoutAt: 0n, graduatedAt: 0n, graduationSlot: 0n };
    } else {
      st = S.coinState(b);
      ext = { founder: b.founder, platformWithdrawn: b.platformWithdrawn, founderClaimed: b.founderClaimed, founderPaidOut: b.founderPaidOut, holdersForwarded: b.holdersForwarded, payoutSeq: b.payoutSeq, lastPayoutAt: b.lastPayoutAt, graduatedAt: b.graduatedAt, graduationSlot: b.graduationSlot };
    }
    const supplyBefore = b ? b.mintInfo.supply : S.COIN_SUPPLY - (S.COIN_SUPPLY - terms.curveSupply - terms.poolSupply);
    let burnedInTx = 0n; let graduatedInTx = false; let trades = 0n; let lamportsOut = 0n; let lamportsIn = 0n;
    let tokensOut = 0n; let tokensIn = 0n; let tokensBurned = 0n;
    // I6 per event: X * Y from each pool event's own after-figures never falls below the one before it
    let kPrev = b && b.phase === 1 ? b.poolSol * b.poolTokens : null;
    const kStep = (k, what) => {
      assert.ok(kPrev !== null, `${label}: ${what} in the pool before the pool opened`);
      assert.ok(k >= kPrev, `${label}: I6 X * Y fell from ${kPrev} to ${k} at ${what}`);
      kPrev = k;
    };
    let lastPoolEvent = -1; let graduationIx = -1;
    for (const e of events) {
      const d = e.data;
      if (e.name === 'Trade') {
        trades++;
        assert.equal(d.mint, c.mint); assert.equal(d.phase, st.phase, 'Trade.phase is where it executed');
        assert.equal(d.slot, txSlot); assert.equal(d.timestamp, txTs);
        const A = d.sol_amount; const t = terms.totalFeeBps;
        // I12
        assert.equal(d.fee, (A * t) / S.BPS, 'I12 fee = floor(A t / D)');
        assert.ok(d.fee * S.BPS <= A * t, 'I12 never above t/D');
        assert.equal(d.fee_platform, (A * terms.platformBps) / S.BPS); assert.equal(d.fee_founder, (A * terms.founderBps) / S.BPS);
        assert.equal(d.fee_holders, (A * terms.holdersBps) / S.BPS); assert.equal(d.fee_buyback, (A * terms.buybackBps) / S.BPS);
        const lf = (A * terms.liquidityBps) / S.BPS;
        assert.equal(d.fee_liquidity, d.fee - d.fee_platform - d.fee_founder - d.fee_holders - d.fee_buyback, 'I12 liquidity = the remainder');
        assert.ok(d.fee_liquidity >= lf && d.fee_liquidity <= lf + 4n, 'I12 remainder 0 to 4');
        assert.equal(d.sol_net, A - d.fee, 'I12 sol_net = A - fee');
        assert.ok(d.liquidity_dripped <= (lf < st.liquidityPending ? lf : st.liquidityPending), 'I12 drip bound');
        if (st.phase === 0) assert.equal(d.liquidity_dripped, 0n, 'I12 curve trades drip 0');
        const lBefore = st.liquidityPending; const sBefore = st.tokensSold; const rBefore = st.curveSol; const kBefore = st.poolSol * st.poolTokens; const phaseBefore = st.phase;
        let q;
        if (d.is_buy) {
          assert.ok(d.sol_in >= S.MIN_TRADE_LAMPORTS, 'I12 sol_in >= MIN_TRADE_LAMPORTS');
          assert.ok(d.sol_amount <= d.sol_in, 'I12 charged <= sol_in');
          if (d.sol_amount < d.sol_in) assert.ok(d.partial && d.graduated, 'I12 less than sol_in only on the partial graduating buy');
          assert.equal(d.partial, d.sol_amount < d.sol_in);
          q = S.quoteBuy(terms, st, d.sol_in);
          assert.equal(d.sol_amount, q.charged, 'parity: charged'); assert.equal(d.sol_net, q.net, 'parity: net');
          assert.equal(d.token_amount, q.tokensOut, 'parity: tokens out'); assert.equal(d.graduated, q.graduates, 'parity: graduates');
          lamportsIn += q.charged; tokensOut += q.tokensOut;
          if (d.partial) { // I17
            const cNet = terms.graduationSol - rBefore;
            assert.ok(d.graduated && d.token_amount === terms.curveSupply - sBefore && cNet >= 1n, 'I17 partial fill delivers exactly S - s');
            assert.equal(d.sol_amount, ((cNet - 1n) * S.BPS) / (S.BPS - t) + 1n, 'I17 the gross-up');
            assert.equal(d.sol_amount - d.fee, cNet, 'I17 net exactly c');
          }
          if (q.graduates) { graduatedInTx = true; ext.graduatedAt = txTs; ext.graduationSlot = txSlot; }
        } else {
          assert.equal(d.sol_in, 0n); assert.equal(d.partial, false); assert.equal(d.graduated, false);
          q = S.quoteSell(terms, st, d.token_amount);
          assert.equal(d.sol_amount, q.gross, 'parity: gross'); assert.equal(d.sol_net, q.solOut, 'parity: sol out');
          lamportsOut += q.solOut; tokensIn += d.token_amount;
        }
        assert.deepEqual([d.fee, d.fee_liquidity, d.fee_platform, d.fee_founder, d.fee_holders, d.fee_buyback], [q.split.fee, q.split.liquidity, q.split.platform, q.split.founder, q.split.holders, q.split.buyback], 'parity: split');
        assert.equal(d.liquidity_dripped, q.drip, 'parity: drip');
        st = q.newState;
        assert.deepEqual([d.tokens_sold, d.curve_sol, d.pool_sol, d.pool_tokens, d.liquidity_pending, d.trade_seq],
          [st.tokensSold, st.curveSol, st.poolSol, st.poolTokens, st.liquidityPending, st.tradeSeq], 'parity: after-figures');
        assert.deepEqual([d.virtual_sol_after, d.virtual_tokens_after], S.spotPrice(terms, st), 'parity: virtual reserves after');
        // I16: liquidity_pending rises only in curve trades and falls only in pool trades
        if (phaseBefore === 0) assert.ok(st.liquidityPending >= lBefore, 'I16'); else assert.ok(st.liquidityPending <= lBefore, 'I16');
        if (phaseBefore === 1) assert.ok(st.poolSol * st.poolTokens >= kBefore, 'I6 X*Y never decreases');
        if (phaseBefore === 1) { kStep(d.pool_sol * d.pool_tokens, `Trade ${d.trade_seq}`); lastPoolEvent = e.top.index; }
        if (d.graduated) {
          // I5: the graduating buy ends at s = S, curve_sol = R and opens the pool at exactly (R, P)
          assert.deepEqual([d.tokens_sold, d.curve_sol, d.pool_sol, d.pool_tokens], [terms.curveSupply, terms.graduationSol, terms.graduationSol, terms.poolSupply], `${label}: I5 graduation`);
          kPrev = d.pool_sol * d.pool_tokens; graduationIx = e.top.index;
        }
      } else if (e.name === 'Graduated') {
        assert.ok(graduatedInTx, `${label}: Graduated without a graduating buy`);
        assert.deepEqual([d.pool_sol, d.pool_tokens], [terms.graduationSol, terms.poolSupply], 'I5 the pool opens at (R, P)');
        assert.equal(d.liquidity_pending, st.liquidityPending);
        assert.deepEqual([d.last_virtual_sol, d.last_virtual_tokens], [terms.virtualSol + terms.graduationSol, terms.virtualTokens - terms.curveSupply], 'I5 curve ends at (x0 + R, y0 - S)');
        assert.deepEqual([d.slot, d.timestamp], [txSlot, txTs]);
      } else if (e.name === 'BuybackBurned') {
        assert.equal(e.top.name, 'buyback_burn');
        const before = st;
        const q = S.quoteBuyback(terms, st, txSlot);
        assert.ok(q, `${label}: BuybackBurned where the port finds nothing to do`);
        assert.deepEqual([d.sol_spent, d.tokens_burned, d.cap], [q.spent, q.coins, q.cap], 'parity: buyback');
        // I15
        assert.ok(d.sol_spent >= 1n && d.tokens_burned >= 1n, 'I15 nonzero');
        assert.equal(d.cap, (S.depth(terms, before) * terms.totalFeeBps) / (S.BUYBACK_CAP_DIVISOR * S.BPS), 'I15 cap');
        assert.ok(d.sol_spent <= d.cap && d.sol_spent <= before.buybackPending, 'I15 spent <= cap and <= pending');
        assert.ok(txSlot >= before.lastBuybackSlot + S.BUYBACK_INTERVAL_SLOTS, 'I15 at least 150 slots after the previous run');
        st = q.newState;
        if (st.phase === 0) assert.ok(st.tokensSold <= terms.curveSupply - 1n, 'I15 never graduates');
        assert.equal(d.phase, before.phase);
        assert.deepEqual([d.buyback_pending_after, d.tokens_burned_total], [st.buybackPending, st.tokensBurned]);
        assert.deepEqual([d.virtual_sol_after, d.virtual_tokens_after], S.spotPrice(terms, st));
        if (d.phase === 1) { kStep(d.virtual_sol_after * d.virtual_tokens_after, `BuybackBurned ${st.buybackCount}`); lastPoolEvent = e.top.index; }
        burnedInTx += d.tokens_burned; tokensBurned += d.tokens_burned;
        assert.equal(d.supply_after, supplyBefore - burnedInTx, 'supply_after is mint.supply after the burn');
        assert.deepEqual([d.slot, d.timestamp], [txSlot, txTs]);
      } else if (e.name === 'PlatformFeesWithdrawn') {
        assert.ok(d.amount > 0n && d.amount === st.platformPending, 'withdraws the whole bucket');
        st = { ...st, platformPending: 0n }; ext.platformWithdrawn += d.amount; lamportsOut += d.amount;
        assert.equal(d.total_withdrawn, ext.platformWithdrawn);
      } else if (e.name === 'FounderFeesClaimed') {
        assert.ok(d.amount > 0n && d.amount === st.founderPending);
        assert.equal(d.founder, ext.founder, 'only the founder');
        st = { ...st, founderPending: 0n }; ext.founderClaimed += d.amount; lamportsOut += d.amount;
        assert.equal(d.total_claimed, ext.founderClaimed);
      } else if (e.name === 'FounderPaidOut') {
        assert.ok(d.amount > 0n && d.amount === st.founderPending);
        assert.equal(d.founder, ext.founder);
        assert.ok(txTs >= ext.lastPayoutAt + S.PAYOUT_COOLDOWN_SECS, 'the 24-hour cooldown');
        st = { ...st, founderPending: 0n }; ext.founderPaidOut += d.amount; ext.payoutSeq += 1n; ext.lastPayoutAt = txTs; lamportsOut += d.amount;
        assert.deepEqual([d.total_paid_out, d.seq], [ext.founderPaidOut, ext.payoutSeq]);
      } else if (e.name === 'HoldersFeesForwarded') {
        assert.ok(d.amount > 0n && d.amount === st.holdersPending);
        st = { ...st, holdersPending: 0n }; ext.holdersForwarded += d.amount; lamportsOut += d.amount;
        assert.equal(d.total_forwarded, ext.holdersForwarded);
      } else if (e.name === 'FounderTransferred') {
        assert.equal(e.top.name, 'transfer_founder');
        assert.equal(d.old, ext.founder);
        assert.ok(tx.signers.has(d.old) && tx.signers.has(d.new), 'I2 the founder changes only with both signatures');
        ext.founder = d.new;
      }
    }
    // the replayed state is the account (parity with the program's real results)
    const got = S.coinState(c);
    for (const k of S.STATE_KEYS) assert.equal(got[k], st[k], `${label}: ${c.symbol} ${k} on chain ${got[k]}, replayed ${st[k]}`);
    for (const k of Object.keys(ext)) assert.equal(c[k], ext[k], `${label}: ${c.symbol} ${k} on chain ${c[k]}, replayed ${ext[k]}`);
    // and byte for byte: the account before, with the replayed state and payout fields written at their offsets (F01)
    if (b) assert.ok(encodeCoin(b.raw, st, ext).equals(c.raw), `${label}: ${c.symbol} the Coin's bytes differ from the replayed state`);
    assert.equal(c.tradeSeq - (b?.tradeSeq ?? 0n), trades, 'I16 trade_seq +1 per trade');
    // I6: the account ends at the last pool event's reserves
    if (c.phase === 1 && kPrev !== null) assert.equal(c.poolSol * c.poolTokens, kPrev, `${label}: I6 the pool after the transaction is the last event's`);
    // I5: at the end of the instruction that graduates the coin, the vault holds exactly P (plus donations)
    if (graduationIx >= 0) {
      const steps = vaultStep.get(addr) ?? new Map(); const dons = donStep.get(addr) ?? new Map();
      let running = b ? b.vaultAmount : 0n;
      let donated = (w.tokenDonations.get(addr) ?? 0n) - (tokenFlows.donated.get(addr) ?? 0n);
      for (const idx of tx.steps) {
        running += steps.get(idx) ?? 0n; donated += dons.get(idx) ?? 0n;
        if (idx === graduationIx) break;
      }
      assert.equal(running, terms.poolSupply + donated, `${label}: I5 the vault holds P when ${c.symbol} graduates`);
      if (lastPoolEvent <= graduationIx) {
        assert.deepEqual([c.poolSol, c.poolTokens], [terms.graduationSol, terms.poolSupply], `${label}: I5 (R, P) before any pool trade`);
        assert.equal(c.vaultAmount, terms.poolSupply + (w.tokenDonations.get(addr) ?? 0n), `${label}: I5 the vault holds P before any pool trade`);
      }
    }
    checkCoin(w, { c, b, label, rentMin, launched, graduatedInTx, events });
    // I13: the Coin's lamports change by buys minus outflows (plus declared donations)
    const donated = opts.lamportDonation?.coin === addr ? opts.lamportDonation.amount : 0n;
    if (!launched) {
      assert.equal(c.lamports - b.lamports, lamportsIn - lamportsOut + donated, `${label}: I13 Coin lamports`);
      assert.equal(lamportsIn, buysIn.get(addr) ?? 0n); assert.equal(lamportsOut, moneyOut.get(addr) ?? 0n);
      // coins: out to buyers, in from sellers, burned by buybacks (and declared donations)
      assert.equal(tokenFlows.buyOut.get(addr) ?? 0n, tokensOut, 'tokens out = the buys\' token_amount');
      assert.equal(tokenFlows.sellIn.get(addr) ?? 0n, tokensIn, 'tokens in = the sells\' tokens_in');
      assert.equal(tokenFlows.burned.get(addr) ?? 0n, tokensBurned, 'tokens burned = the buybacks\'');
      assert.equal(c.vaultAmount - b.vaultAmount, tokensIn - tokensOut - tokensBurned + (tokenFlows.donated.get(addr) ?? 0n), 'vault amount');
    }
    const holderBurned = tokenFlows.holderBurned.get(c.mint) ?? 0n;
    if (b) assert.equal(c.mintInfo.supply, b.mintInfo.supply - tokensBurned - holderBurned, `${label}: I15 mint supply falls exactly by the burns`);
  }

  checkGlobal(w, { pre, post, tx, label, preAccounts, postAccounts });
}

/** The arguments of `launch_from_batch` from its instruction data (4.27). */
export function batchLaunchArgs(data) {
  const d = Buffer.from(data);
  let at = 8;
  const u64 = () => { const v = d.readBigUInt64LE(at); at += 8; return v; };
  const str = () => { const n = d.readUInt32LE(at); at += 4; const v = d.subarray(at, at + n).toString('utf8'); at += n; return v; };
  const cityId = u64(); const batchSeq = u64(); const configId = d.readUInt16LE(at); at += 2;
  const name = str(); const symbol = str();
  const metaHash = Uint8Array.from(d.subarray(at, at + 32)); at += 32;
  const n = d.readUInt32LE(at); at += 4;
  const proof = [];
  for (let k = 0; k < n; k++) { proof.push(Uint8Array.from(d.subarray(at, at + 32))); at += 32; }
  assert.equal(at, d.length, 'launch_from_batch data has trailing bytes');
  return { cityId, batchSeq, configId, name, symbol, metaHash, proof };
}

/**
 * CoinLaunched and the new Coin against what the launch consumed (4.10, 4.27, I2, I19, I23): for `launch`, the Approval
 * and its config; for `launch_from_batch`, the call's own arguments and signer (the leaf), checked against the batch in
 * force at that call by checkBatchLaunches (checkGlobal), and the config the call names.
 */
function checkLaunch(w, { c, cl, pre, label, txSlot, txTs, rentMin, tx }) {
  const P = w.P;
  const d = cl.data;
  assert.ok(LAUNCHES.includes(cl.top.name), `${label}: CoinLaunched from ${cl.top.name}`);
  let ap;
  if (cl.top.name === 'launch') {
    ap = pre.approvals.get(P.approval(c.cityId));
    assert.ok(ap, `${label}: launch without an approval`);
    assert.ok(txTs <= ap.expiresAt, 'not expired');
  } else {
    const a = batchLaunchArgs(cl.top.data);
    assert.equal(a.cityId, c.cityId, `${label}: the batch launch's city`);
    // I23: the leaf's fields are what the Coin holds (the signer is the founder)
    ap = { founder: cl.top.accounts[0], symbol: a.symbol, name: a.name, configId: a.configId, metaHash: a.metaHash };
    const ev = cl.top.events.find((e) => e.name === 'LaunchedFromBatch');
    assert.ok(ev, `${label}: launch_from_batch without LaunchedFromBatch`);
    const leaf = S.launchLeaf({ programId: w.programId, batchSeq: a.batchSeq, cityId: a.cityId, founder: ap.founder, configId: a.configId, metaHash: a.metaHash, name: a.name, symbol: a.symbol });
    assert.deepEqual([ev.data.city_id, ev.data.founder, ev.data.mint, ev.data.config_id, ev.data.batch_seq], [c.cityId, ap.founder, c.mint, BigInt(a.configId), a.batchSeq], `${label}: LaunchedFromBatch fields`);
    assert.deepEqual([...ev.data.leaf], [...leaf], `${label}: LaunchedFromBatch.leaf is the leaf of the call`);
    const order = cl.top.events.map((e) => e.name);
    assert.ok(order.indexOf('LaunchedFromBatch') === order.indexOf('CoinLaunched') + 1, `${label}: LaunchedFromBatch right after CoinLaunched`);
  }
  const cfg = pre.configs.get(P.config(ap.configId));
  assert.ok(cfg && cfg.enabled, 'an enabled config');
  assert.equal(c.address, P.coin(c.cityId)); assert.equal(c.bump, P.coinWithBump(c.cityId)[1]);
  assert.equal(c.mint, P.mint(c.address)); assert.equal(c.vault, P.coinVault(c.address));
  assert.equal(c.founder, ap.founder); assert.equal(c.symbol, ap.symbol); assert.equal(c.configId, ap.configId);
  assert.deepEqual([...c.metaHash], [...ap.metaHash], 'meta_hash copied from the approval or the leaf');
  for (const k of ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'totalFeeBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol']) {
    assert.equal(c[k], cfg[k], `terms copied: ${k}`);
  }
  const dust = S.launchDust(S.coinTerms(c));
  assert.equal(c.dustBurned, dust);
  assert.deepEqual([c.layoutVersion, c.phase, c.launchedAt, c.launchSlot, c.lastBuybackSlot, c.rentReserve], [1, 0, txTs, txSlot, txSlot, rentMin]);
  assert.ok(tx.signers.has(ap.founder), 'the approved founder signed');
  // the event
  assert.deepEqual([d.founder, d.mint, d.vault, d.config_id, d.name, d.symbol, d.uri], [c.founder, c.mint, c.vault, BigInt(ap.configId), ap.name, ap.symbol, S.metadataUri(c.mint)]);
  assert.deepEqual([...d.meta_hash], [...ap.metaHash]);
  assert.deepEqual([d.supply_minted, d.dust_burned, d.curve_supply, d.pool_supply, d.graduation_sol, d.virtual_sol, d.virtual_tokens],
    [S.COIN_SUPPLY, dust, c.curveSupply, c.poolSupply, c.graduationSol, c.virtualSol, c.virtualTokens]);
  assert.deepEqual([d.liquidity_bps, d.platform_bps, d.founder_bps, d.holders_bps, d.buyback_bps, d.total_fee_bps],
    [c.liquidityBps, c.platformBps, c.founderBps, c.holdersBps, c.buybackBps, c.totalFeeBps]);
  assert.equal(d.launch_fee, cfg.launchFeeLamports, 'I14 the launch fee equals the config\'s');
  assert.deepEqual([d.slot, d.timestamp], [txSlot, txTs]);
  // the launch fee went to FEE_RECIPIENT and nowhere else (a system transfer from the payer)
  const xfers = cl.top.inner.filter((ii) => ii.program === S.ADDRESSES.system && ii.data.readUInt32LE(0) === 2 && ii.stackHeight === cl.top.depth + 1);
  const feeXfer = xfers.filter((x) => x.accounts[1] === S.ADDRESSES.feeRecipient);
  if (cfg.launchFeeLamports > 0n) {
    assert.equal(feeXfer.length, 1); assert.equal(feeXfer[0].data.readBigUInt64LE(4), cfg.launchFeeLamports); assert.equal(feeXfer[0].accounts[0], cl.top.accounts[1]);
  } else assert.equal(feeXfer.length, 0);
  w.coinMeta.set(c.address, { name: ap.name, symbol: ap.symbol });
  w.frozen.set(c.address, frozenBytes(c.raw));
}

const U128_FIELDS = new Set(['buyVolume', 'sellVolume', 'feesTotal', 'liquidityEarned', 'liquidityAdded', 'platformEarned', 'platformWithdrawn',
  'founderEarned', 'founderClaimed', 'founderPaidOut', 'holdersEarned', 'holdersForwarded', 'buybackEarned', 'buybackSpent']);
const I64_FIELDS = new Set(['graduatedAt', 'lastPayoutAt']);
/** `raw` (a Coin's bytes) with the trade state `st` and the payout fields `ext` written at their offsets (3.7). */
export function encodeCoin(raw, st, ext) {
  const out = Buffer.from(raw);
  const o = S.COIN_OFFSETS;
  const put = (k, v) => {
    if (k === 'phase') out[o.phase] = Number(v);
    else if (k === 'founder') new PublicKey(v).toBuffer().copy(out, o.founder);
    else if (U128_FIELDS.has(k)) { out.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, o[k]); out.writeBigUInt64LE(BigInt(v) >> 64n, o[k] + 8); } else if (I64_FIELDS.has(k)) out.writeBigInt64LE(BigInt(v), o[k]);
    else out.writeBigUInt64LE(BigInt(v), o[k]);
  };
  for (const k of S.STATE_KEYS) put(k, st[k]);
  for (const [k, v] of Object.entries(ext)) put(k, v);
  return out;
}

// layout_version; bumps, config_id, city_id, mint, vault; symbol, the six fee fields, x0, y0, S, P, R, dust_burned;
// launched_at, launch_slot; meta_hash, rent_reserve (I2). `phase` (9) and `founder` (87) are not frozen.
const FROZEN_RANGES = [[8, 9], [10, 87], [119, 189], [261, 277], [565, 605]];
const frozenBytes = (raw) => Buffer.concat(FROZEN_RANGES.map(([a, b]) => Buffer.from(raw).subarray(a, b)));

/** I1 to I11 on one coin after a transaction. */
function checkCoin(w, { c, b, label, rentMin, graduatedInTx }) {
  const t = S.coinTerms(c);
  const s = S.coinState(c);
  const tag = `${label}: ${c.symbol}`;
  // I1
  assert.ok(c.phase === 0 || c.phase === 1);
  if (b) assert.ok(c.phase >= b.phase, `${tag}: I1 phase only goes 0 to 1`);
  if (c.phase === 0) {
    assert.ok(c.tokensSold < t.curveSupply, `${tag}: I1 s < S`);
    assert.deepEqual([c.poolSol, c.poolTokens, c.graduatedAt, c.graduationSlot], [0n, 0n, 0n, 0n], `${tag}: I1 curve phase`);
  } else {
    assert.equal(c.tokensSold, t.curveSupply, `${tag}: I1 s = S`);
    assert.equal(c.curveSol, t.graduationSol, `${tag}: I1 curve_sol = R`);
    assert.ok(c.graduatedAt > 0n && c.graduationSlot > 0n, `${tag}: I1 graduated_at > 0`);
  }
  // I2 frozen terms (byte compare with the launch) and the zero reserved tail
  assert.ok(frozenBytes(c.raw).equals(w.frozen.get(c.address)), `${tag}: I2 frozen fields changed`);
  assert.ok(c.raw.subarray(605).every((x) => x === 0), `${tag}: _reserved not zero`);
  // I3
  assert.equal(t.totalFeeBps, t.liquidityBps + t.platformBps + t.founderBps + t.holdersBps + t.buybackBps, `${tag}: I3`);
  assert.ok(t.totalFeeBps >= 1n && t.totalFeeBps <= 250n && t.platformBps <= 120n && t.founderBps <= 100n, `${tag}: I3 caps`);
  assert.ok(t.founderBps + t.holdersBps + S.MIN_TOTAL_FEE_BPS <= t.totalFeeBps, `${tag}: I3 V2b (the founder's and the holders' shares leave MIN_TOTAL_FEE_BPS)`);
  assert.equal(S.validateConfig({ ...t, launchFeeLamports: 0n }), true, `${tag}: I3 snapshot passes V1 to V11`);
  // I4
  if (c.phase === 0) {
    assert.equal(c.curveSol, S.curveValue(t, c.tokensSold), `${tag}: I4 curve_sol = f(tokens_sold)`);
    assert.ok(c.curveSol <= t.graduationSol - 1n, `${tag}: I4 curve_sol <= R - 1`);
  }
  // I5 (the graduating transaction leaves the pool at (R, P) unless it traded on)
  if (graduatedInTx && b && b.phase === 0) assert.equal(c.phase, 1);
  // I6
  if (c.phase === 1) {
    assert.ok(c.poolSol >= 1n && c.poolTokens >= 1n, `${tag}: I6 reserves positive`);
    const kAfter = c.poolSol * c.poolTokens;
    const kBefore = b && b.phase === 1 ? b.poolSol * b.poolTokens : t.graduationSol * t.poolSupply;
    assert.ok(kAfter >= kBefore, `${tag}: I6 X*Y never decreases`);
  }
  // I7
  assert.equal(c.platformPending, c.platformEarned - c.platformWithdrawn, `${tag}: I7 platform`);
  assert.equal(c.founderPending, c.founderEarned - c.founderClaimed - c.founderPaidOut, `${tag}: I7 founder`);
  assert.equal(c.holdersPending, c.holdersEarned - c.holdersForwarded, `${tag}: I7 holders`);
  assert.equal(c.buybackPending, c.buybackEarned - c.buybackSpent, `${tag}: I7 buyback`);
  assert.equal(c.liquidityPending, c.liquidityEarned - c.liquidityAdded, `${tag}: I7 liquidity`);
  // I8
  assert.equal(c.feesTotal, c.liquidityEarned + c.platformEarned + c.founderEarned + c.holdersEarned + c.buybackEarned, `${tag}: I8`);
  // I9
  const liab = S.liabilities(s);
  const floorRent = c.rentReserve < rentMin ? c.rentReserve : rentMin;
  assert.ok(c.lamports >= floorRent + liab, `${tag}: I9 backing`);
  assert.equal(c.lamports, c.rentReserve + liab + (w.lamportDonations.get(c.address) ?? 0n), `${tag}: I9 lamports = rent_reserve + liabilities (+ donations)`);
  // I10
  const wantVault = c.phase === 0 ? t.curveSupply - c.tokensSold + t.poolSupply : c.poolTokens;
  assert.equal(c.vaultAmount, wantVault + (w.tokenDonations.get(c.address) ?? 0n), `${tag}: I10 vault`);
  const vault = tokenAccountInfo(w.accountInfo(c.vault));
  assert.deepEqual([vault.mint, vault.owner, vault.delegate, vault.closeAuthority, vault.state], [c.mint, c.address, null, null, 1], `${tag}: I10 vault authority, no delegate, no close authority, not frozen`);
  // I11
  const m = c.mintInfo;
  assert.equal(m.supply, S.COIN_SUPPLY - c.dustBurned - c.tokensBurned - (w.holderBurns.get(c.mint) ?? 0n), `${tag}: I11 supply`);
  assert.deepEqual([m.mintAuthority, m.freezeAuthority, m.decimals], [null, null, 6], `${tag}: I11 authorities None, 6 decimals`);
  const md = readMetadata(w.accountInfo(metadataOf(c.mint)).data);
  const meta = w.coinMeta.get(c.address);
  assert.deepEqual([md.isMutable, md.updateAuthority, md.mint, md.name, md.symbol, md.uri, md.sellerFeeBasisPoints, md.hasCreators],
    [false, c.address, c.mint, meta.name, meta.symbol, S.metadataUri(c.mint), 0, false], `${tag}: I11 metadata`);
  // I16 monotone counters
  if (b) {
    for (const k of ['buyVolume', 'sellVolume', 'feesTotal', 'liquidityEarned', 'liquidityAdded', 'platformEarned', 'platformWithdrawn', 'founderEarned',
      'founderClaimed', 'founderPaidOut', 'holdersEarned', 'holdersForwarded', 'buybackEarned', 'buybackSpent', 'tokensBurned', 'buybackCount', 'payoutSeq', 'tradeSeq']) {
      assert.ok(c[k] >= b[k], `${tag}: I16 ${k} decreased`);
    }
  }
}

// The admin instructions of the old vicinity_launchpad and of vicinity_rewards' registry that move a seat
// vicinity_curve reads (their committed IDLs, sdk/idl/: Anchor's `sha256("global:<name>")[..8]`, the same for both
// programs), and the old program's set_pause(launches: Option<bool>, payouts: Option<bool>).
const SEAT_IX = Object.freeze({
  propose_admin: Buffer.from([121, 214, 199, 212, 87, 39, 117, 234]).toString('hex'),
  accept_admin: Buffer.from([112, 42, 45, 90, 116, 181, 13, 170]).toString('hex'),
  set_pause: Buffer.from([63, 32, 154, 2, 56, 103, 79, 45]).toString('hex'),
});
const seatIxName = (data) => { const h = Buffer.from(data).subarray(0, 8).toString('hex'); return Object.keys(SEAT_IX).find((k) => SEAT_IX[k] === h) ?? null; };
const keyAtData = (d, at) => new PublicKey(Buffer.from(d).subarray(at, at + 32)).toBase58();
/** The old program's Launchpad and vicinity_rewards' Registry as the checker reads them: `{ ok, admin, pending, paused }`. */
function seatAccounts(w, accounts) {
  const P = w.P;
  const o = accounts.get(P.cluster.legacyLaunchpad);
  const oldOk = Boolean(o?.exists && o.owner === P.cluster.legacyProgram && o.data.length === S.LEGACY_LAUNCHPAD_LEN && S.LEGACY_LAUNCHPAD_DISCRIMINATOR.every((x, i) => o.data[i] === x));
  const r = accounts.get(P.cluster.rewardsRegistry);
  const regOk = Boolean(r?.exists && r.owner === P.cluster.rewardsProgram && r.data.length === S.REWARDS_REGISTRY_LEN && S.REWARDS_REGISTRY_DISCRIMINATOR.every((x, i) => r.data[i] === x));
  return {
    oldOk, oldAdmin: oldOk ? keyAtData(o.data, S.LEGACY_ADMIN_AT) : null, oldPending: oldOk ? keyAtData(o.data, S.LEGACY_PENDING_ADMIN_AT) : null, oldPaused: oldOk && o.data[S.LEGACY_LAUNCHES_PAUSED_AT] === 1,
    regOk, regAdmin: regOk ? keyAtData(r.data, S.REWARDS_REGISTRY_ADMIN_AT) : null, regPending: regOk ? keyAtData(r.data, S.REWARDS_REGISTRY_PENDING_ADMIN_AT) : null,
  };
}
/**
 * The seats vicinity_curve reads, as they stood at each of its calls (review R5-REG-1, as SM-2 does for the flags):
 * this program's admin, pending admin, guardian and payout keys, the old program's admin, pending admin and launch
 * pause, and the registry's admin and pending admin, from the accounts before the transaction, with every earlier
 * propose_admin, accept_admin, set_guardian, set_payout_config and old set_pause of the same transaction applied in
 * execution order (top-level instructions and, inside each, its inner instructions and CPIs into this program).
 * Returns `{ at: Map(call -> seats), last }`.
 */
export function seatWalk(w, { pre, tx, preAccounts }) {
  const P = w.P;
  const lp = pre.launchpad;
  const s = { admin: lp?.admin ?? null, pendingAdmin: lp?.pendingAdmin ?? ZERO, guardian: lp?.guardian ?? ZERO, payoutAuthority: lp?.payoutAuthority ?? ZERO, payoutDestination: lp?.payoutDestination ?? ZERO, launchApprover: lp?.launchApprover ?? ZERO, ...seatAccounts(w, preAccounts) };
  const at = new Map();
  const order = [];
  const curve = (c) => {
    at.set(c, { ...s });
    order.push(c);
    if (c.name === 'propose_admin') s.pendingAdmin = keyAtData(c.data, 8);
    else if (c.name === 'accept_admin') { s.admin = s.pendingAdmin; s.pendingAdmin = ZERO; }
    else if (c.name === 'set_guardian') s.guardian = keyAtData(c.data, 8);
    else if (c.name === 'set_payout_config') { s.payoutAuthority = keyAtData(c.data, 8); s.payoutDestination = keyAtData(c.data, 40); }
    else if (c.name === 'set_launch_approver') s.launchApprover = keyAtData(c.data, 8);
  };
  const other = (ix) => {
    const name = seatIxName(ix.data);
    if (!name) return;
    if (ix.program === P.cluster.legacyProgram && s.oldOk) {
      if (name === 'propose_admin') s.oldPending = keyAtData(ix.data, 8);
      else if (name === 'accept_admin') { s.oldAdmin = s.oldPending; s.oldPending = ZERO; }
      else if (name === 'set_pause' && ix.data[8] === 1) s.oldPaused = ix.data[9] === 1;
    } else if (ix.program === P.cluster.rewardsProgram && s.regOk) {
      if (name === 'propose_admin') s.regPending = keyAtData(ix.data, 8);
      else if (name === 'accept_admin') { s.regAdmin = s.regPending; s.regPending = ZERO; }
    }
  };
  for (const t of tx.top) {
    if (t.program === w.programId) { const c = t.calls.find((x) => !x.viaCpi); if (c) curve(c); } else other(t);
    t.inner.forEach((ii, j) => { const c = t.calls.find((x) => x.viaCpi && x.innerAt === j); if (c) curve(c); else other(ii); });
  }
  return { at, last: s, order };
}

const MAX_U64 = (1n << 64n) - 1n;
const cloneRecord = (r) => ({ ...r, root: Uint8Array.from(r.root) });
const cloneBatch = (lb) => (lb ? { bump: lb.bump, halted: lb.halted, latest: cloneRecord(lb.latest), previous: cloneRecord(lb.previous) } : null);
const sameRecord = (a, b) => a.seq === b.seq && Buffer.from(a.root).equals(Buffer.from(b.root)) && a.leafCount === b.leafCount && a.validFrom === b.validFrom
  && a.validUntil === b.validUntil && a.publishedAt === b.publishedAt && a.publishedSlot === b.publishedSlot && a.publisher === b.publisher && a.cleared === b.cleared;
const zeroRecord = () => ({ seq: 0n, root: new Uint8Array(32), leafCount: 0, validFrom: 0n, validUntil: 0n, publishedAt: 0n, publishedSlot: 0n, publisher: ZERO, cleared: false });
/**
 * I23 and I24 (8.6): `LaunchBatch` walked through the transaction's calls in execution order (seatWalk's order), from
 * the account before it: init_launch_batch creates it zeroed; set_launch_approver (the admin of its moment) clears both
 * records and lifts the halt; publish_launch_batch (the approver of its moment, the path not halted, the gap-free
 * number, a nonzero root, 1 to 512 leaves, the window of 4.25 at the cluster's clock) moves `latest` to `previous` if
 * it had begun and writes the new record; clear_launch_batch (the admin, the approver or the guardian of its moment)
 * clears both and, with `halt`, halts. Each launch_from_batch is checked against the state of its moment: the
 * approver set, the path not halted, the batch it names in force (the SDK's batchRefusal, 4.27 check 3), the proof
 * within min(9, depth) and folding the leaf rebuilt from the call's data and signer to that batch's root, no Approval
 * for the city at that moment, the founder none of the role keys of that moment. Every event of these calls is
 * compared with the walk. The walk must end at the account after the transaction.
 */
export function batchWalk(w, { pre, post, tx, seats, label }) {
  const P = w.P;
  const now = post.ts; const slot = post.slot;
  let lb = cloneBatch(pre.launchBatch);
  const approvals = new Set([...pre.approvals.values()].map((a) => a.cityId));
  const launchedHere = [];
  const ev = (c, name) => { const e = c.events.filter((x) => x.name === name); assert.equal(e.length, 1, `${label}: ${c.name} emits one ${name}`); return e[0].data; };
  for (const c of seats.order) {
    const m = seats.at.get(c);
    const signer = c.accounts[0];
    const city = () => Buffer.from(c.data).readBigUInt64LE(8);
    switch (c.name) {
      case 'init_launch_batch': {
        assert.equal(lb, null, `${label}: I24 a second LaunchBatch`);
        assert.equal(signer, m.admin, `${label}: init_launch_batch by the admin of its moment`);
        lb = { bump: post.launchBatch?.bump, halted: false, latest: zeroRecord(), previous: zeroRecord() };
        assert.equal(ev(c, 'LaunchBatchInitialized').by, signer);
        break;
      }
      case 'set_launch_approver': {
        assert.ok(lb, `${label}: set_launch_approver without a LaunchBatch`);
        assert.equal(signer, m.admin, `${label}: I24 set_launch_approver by the admin of its moment`);
        const e = ev(c, 'LaunchApproverChanged');
        assert.deepEqual([e.old, e.new, e.latest_seq], [m.launchApprover, keyAtData(c.data, 8), lb.latest.seq], `${label}: LaunchApproverChanged`);
        lb.latest.cleared = true; lb.previous.cleared = true; lb.halted = false;
        break;
      }
      case 'publish_launch_batch': {
        assert.ok(lb, `${label}: a publication without a LaunchBatch`);
        const d = Buffer.from(c.data);
        const rec = { seq: d.readBigUInt64LE(8), root: Uint8Array.from(d.subarray(16, 48)), leafCount: d.readUInt32LE(48), validFrom: d.readBigInt64LE(52),
          validUntil: d.readBigInt64LE(60), publishedAt: now, publishedSlot: slot, publisher: signer, cleared: false };
        assert.ok(m.launchApprover !== ZERO && signer === m.launchApprover, `${label}: I24 a publication not signed by the approver ${m.launchApprover} of its moment`);
        assert.ok(!lb.halted, `${label}: I24 a publication while the batch path was halted`);
        assert.equal(rec.seq, lb.latest.seq + 1n, `${label}: I24 latest.seq grows by exactly 1`);
        assert.ok(rec.seq <= MAX_U64);
        assert.ok(rec.root.some((x) => x !== 0), `${label}: I24 a zero root`);
        assert.ok(rec.leafCount >= 1 && rec.leafCount <= S.MAX_BATCH_LEAVES, `${label}: I24 leaf count ${rec.leafCount}`);
        assert.ok(S.publishWindowOk(now, rec.validFrom, rec.validUntil), `${label}: I24 window ${rec.validFrom}..${rec.validUntil} at ${now}`);
        let replaced = 0n;
        if (lb.latest.seq !== 0n && now >= lb.latest.validFrom) lb.previous = lb.latest; else if (lb.latest.seq !== 0n) replaced = lb.latest.seq;
        lb.latest = rec;
        const e = ev(c, 'LaunchBatchPublished');
        assert.deepEqual([e.seq, toHexB(e.root), e.leaf_count, e.valid_from, e.valid_until, e.publisher, e.published_at, e.previous_seq, e.replaced_seq],
          [rec.seq, toHexB(rec.root), BigInt(rec.leafCount), rec.validFrom, rec.validUntil, signer, now, lb.previous.seq, replaced], `${label}: LaunchBatchPublished`);
        break;
      }
      case 'clear_launch_batch': {
        assert.ok(lb, `${label}: a clear without a LaunchBatch`);
        const allowed = [m.admin, m.launchApprover, m.guardian].filter((k) => k && k !== ZERO);
        assert.ok(allowed.includes(signer), `${label}: I24 a clear by ${signer}, who is not the admin, the approver or the guardian of its moment`);
        lb.latest.cleared = true; lb.previous.cleared = true;
        if (c.data[8] === 1) lb.halted = true;
        const e = ev(c, 'LaunchBatchCleared');
        assert.deepEqual([e.by, e.latest_seq, e.previous_seq, e.halted], [signer, lb.latest.seq, lb.previous.seq, lb.halted], `${label}: LaunchBatchCleared`);
        break;
      }
      case 'approve_launch': approvals.add(city()); break;
      case 'launch': case 'revoke_approval': approvals.delete(city()); break;
      case 'launch_from_batch': {
        // I23: no launch without a valid proof, inside the window, not cleared, not superseded, no pending approval
        const a = batchLaunchArgs(c.data);
        assert.ok(m.launchApprover !== ZERO, `${label}: I23 a batch launch while no launch approver was set`);
        assert.ok(lb, `${label}: I23 a batch launch without a LaunchBatch`);
        const refusal = S.batchRefusal(lb, { launchApprover: m.launchApprover }, a.batchSeq, now);
        assert.equal(refusal, null, `${label}: I23 a batch launch of city ${a.cityId} from batch ${a.batchSeq}, which was not in force (${refusal})`);
        const b = a.batchSeq === lb.latest.seq ? lb.latest : lb.previous;
        assert.ok(a.proof.length <= S.maxProofLen(b.leafCount), `${label}: I23 a proof of ${a.proof.length} hashes for ${b.leafCount} leaves`);
        const leaf = S.launchLeaf({ programId: w.programId, batchSeq: a.batchSeq, cityId: a.cityId, founder: signer, configId: a.configId, metaHash: a.metaHash, name: a.name, symbol: a.symbol });
        assert.ok(S.verifyLaunchProof({ root: b.root, leaf, proof: a.proof, leafCount: b.leafCount }), `${label}: I23 the leaf of city ${a.cityId} does not fold to batch ${a.batchSeq}'s root`);
        assert.ok(!approvals.has(a.cityId), `${label}: I23 a batch launch of city ${a.cityId} while its Approval existed`);
        for (const [what, k] of [['FEE_RECIPIENT', S.ADDRESSES.feeRecipient], ['the guardian', m.guardian], ['the payout key', m.payoutAuthority], ['the launch approver', m.launchApprover]]) {
          if (k && k !== ZERO) assert.notEqual(signer, k, `${label}: I23 the batch launch's founder is ${what} of its moment`);
        }
        assert.equal(toHexB(ev(c, 'LaunchedFromBatch').root), toHexB(b.root), `${label}: LaunchedFromBatch.root`);
        launchedHere.push(a.cityId);
        break;
      }
      default: break;
    }
  }
  // the walk ends at the account after the transaction (it read every write: I24's "written only by")
  const after = post.launchBatch;
  if (!after) assert.equal(lb, null, `${label}: I24 the LaunchBatch vanished`);
  else {
    assert.ok(lb, `${label}: I24 a LaunchBatch appeared outside init_launch_batch`);
    assert.equal(after.address, P.launchBatch(), `${label}: the LaunchBatch address`);
    assert.equal(after.bump, S.findPda([Buffer.from('launch_batch')], w.programId)[1]);
    assert.equal(after.halted, lb.halted, `${label}: I24 the walk's halted`);
    assert.ok(sameRecord(after.latest, lb.latest), `${label}: I24 the walk's latest record`);
    assert.ok(sameRecord(after.previous, lb.previous), `${label}: I24 the walk's previous record`);
    assert.ok(after.raw.subarray(228).every((x) => x === 0), `${label}: LaunchBatch _reserved not zero`);
    // every stored record with seq > 0 holds what a publication may write
    for (const r of [after.latest, after.previous]) {
      if (r.seq === 0n) continue;
      assert.ok(r.root.some((x) => x !== 0) && r.leafCount >= 1 && r.leafCount <= S.MAX_BATCH_LEAVES, `${label}: I24 record ${r.seq}`);
      assert.ok(r.publishedAt + S.BATCH_REVIEW_SECS <= r.validFrom && r.validFrom <= r.publishedAt + S.BATCH_MAX_LEAD_SECS, `${label}: I24 record ${r.seq}'s lead`);
      assert.ok(r.validFrom < r.validUntil && r.validUntil <= r.validFrom + S.BATCH_MAX_VALIDITY_SECS, `${label}: I24 record ${r.seq}'s validity`);
    }
    assert.ok(after.previous.seq < after.latest.seq || (after.previous.seq === 0n && after.latest.seq === 0n), `${label}: I24 previous.seq < latest.seq`);
  }
  return { launchedHere };
}
const toHexB = (b) => Buffer.from(b).toString('hex');

/** I19, I20 and the settings rules after a transaction. */
function checkGlobal(w, { pre, post, tx, label, preAccounts, postAccounts }) {
  const P = w.P;
  const curveIxs = tx.calls;
  const has = (name) => curveIxs.filter((t) => t.name === name);
  // I19: one Coin per city, one TickerLock per ticker, never closed, never together with an Approval
  const cities = new Set();
  for (const c of post.coins.values()) {
    assert.ok(!cities.has(c.cityId)); cities.add(c.cityId);
    const tl = post.tickers.get(P.ticker(c.symbol));
    assert.ok(tl && tl.mint === c.mint && tl.cityId === c.cityId, `${label}: I19 TickerLock of ${c.symbol}`);
    assert.ok(!post.approvals.has(P.approval(c.cityId)), `${label}: I19 an Approval and a Coin for city ${c.cityId}`);
  }
  assert.equal(post.tickers.size, post.coins.size, `${label}: I19 one TickerLock per coin`);
  for (const [k, t] of pre.tickers) assert.ok(post.tickers.has(k) && post.tickers.get(k).raw.equals(t.raw), `${label}: I19 a TickerLock changed or closed`);
  for (const [k, a] of post.approvals) assert.equal(k, P.approval(a.cityId));
  // at every approval and every launch: the old program had no Coin and no Approval for the city, its launches were
  // paused, and its admin was this program's admin with no transfer pending (8.5, GOV-1: only the same multisig could
  // reopen it); the rewards registry's admin too (OPS-1). The seats as they stood at that call (review R5-REG-1): an
  // earlier hand-over step of the same transaction counts, as the program reads it.
  const seats = seatWalk(w, { pre, tx, preAccounts });
  for (const t of [...has('approve_launch'), ...has('launch'), ...has('launch_from_batch')]) {
    const city = t.data.readBigUInt64LE(8);
    const m = seats.at.get(t);
    const empty = (k) => { const a = preAccounts.get(k); return !a?.exists || (a.owner === ZERO && a.data.length === 0); };
    assert.ok(empty(P.legacyCoin(city)) && empty(P.legacyApproval(city)) && m.oldOk && m.oldPaused, `${label}: I19 the old program could launch city ${city}`);
    assert.ok(m.admin && m.oldAdmin === m.admin && m.oldPending === ZERO,
      `${label}: I19 the old program's admin ${m.oldAdmin} (pending ${m.oldPending}) is not this program's admin ${m.admin} at the ${t.name} of city ${city}`);
    // OPS-1: vicinity_rewards' registry admin (the only key that can create the coin's rewards config) was this program's admin, nothing pending
    assert.ok(m.regOk, `${label}: OPS-1 no vicinity_rewards registry at the ${t.name} of city ${city}`);
    assert.ok(m.regAdmin === m.admin && m.regPending === ZERO,
      `${label}: OPS-1 the rewards registry's admin ${m.regAdmin} (pending ${m.regPending}) is not this program's admin ${m.admin} at the ${t.name} of city ${city}`);
  }
  // the walk ends where the accounts are after the transaction (it read every step that moves a seat)
  if (pre.launchpad && post.launchpad) {
    for (const k of ['admin', 'pendingAdmin', 'guardian', 'payoutAuthority', 'payoutDestination', 'launchApprover']) assert.equal(seats.last[k], post.launchpad[k], `${label}: the seat walk's ${k}`);
  }
  if (postAccounts) {
    const after = seatAccounts(w, postAccounts);
    if (seats.last.oldOk && after.oldOk) for (const k of ['oldAdmin', 'oldPending', 'oldPaused']) assert.equal(seats.last[k], after[k], `${label}: the seat walk's ${k}`);
    if (seats.last.regOk && after.regOk) for (const k of ['regAdmin', 'regPending']) assert.equal(seats.last[k], after[k], `${label}: the seat walk's ${k}`);
  }
  // SM-2 (review round 4): every call ran under flags that permit it, as they stood at that call: the Launchpad before
  // the transaction, then each earlier set_pause of the same transaction applied (a successful set_pause stores exactly
  // its Some arguments). buy and launch need buys open, launch launches open, buyback_burn buybacks open (even a no-op
  // run checks the flag first), payout_founder_fees payouts open.
  if (pre.launchpad) {
    const f = { launches: pre.launchpad.launchesPaused, payouts: pre.launchpad.payoutsPaused, buys: pre.launchpad.buysHalted, buybacks: pre.launchpad.buybacksHalted };
    for (const t of curveIxs) {
      if (t.name === 'set_pause') {
        let at = 8;
        for (const k of ['launches', 'payouts', 'buys', 'buybacks']) {
          if (t.data[at] === 1) { f[k] = t.data[at + 1] === 1; at += 2; } else at += 1;
        }
        continue;
      }
      const need = { buy: ['buys'], launch: ['launches', 'buys'], launch_from_batch: ['launches', 'buys'], buyback_burn: ['buybacks'], payout_founder_fees: ['payouts'] }[t.name] ?? [];
      for (const k of need) assert.ok(!f[k], `${label}: SM-2 ${t.name} succeeded while ${k} were ${k === 'launches' || k === 'payouts' ? 'paused' : 'halted'}`);
    }
  }
  // SM-2: what approve_launch and opt_in_payout wrote is what they may write (4.8, 4.18), checked when it appears
  const approveAt = new Map(has('approve_launch').map((t) => [t.data.readBigUInt64LE(8), seats.at.get(t)]));
  for (const [k, ap] of post.approvals) {
    if (pre.approvals.has(k)) continue;
    assert.ok(has('approve_launch').length, `${label}: an Approval appeared outside approve_launch`);
    const lpA = approveAt.get(ap.cityId); // the admin, guardian and payout key at that approve_launch (R5-REG-1)
    assert.ok(lpA, `${label}: SM-2 the approval of city ${ap.cityId} has no approve_launch of that city`);
    assert.ok(ap.cityId >= 1n, `${label}: SM-2 an approval for city 0`);
    for (const [name, key] of [['FEE_RECIPIENT', S.ADDRESSES.feeRecipient], ['the guardian', lpA.guardian], ['the payout key', lpA.payoutAuthority], ['the launch approver', lpA.launchApprover]]) {
      if (key && key !== ZERO) assert.notEqual(ap.founder, key, `${label}: SM-2 the approval of city ${ap.cityId} names ${name} as founder`);
    }
    assert.ok(ap.metaHash.some((x) => x !== 0), `${label}: SM-2 a zero meta_hash`);
    assert.ok(ap.expiresAt > ap.approvedAt && ap.expiresAt <= ap.approvedAt + S.APPROVAL_MAX_SECS, `${label}: SM-2 expiry outside (now, now + 30 days]`);
    assert.equal(ap.approvedAt, post.ts, `${label}: SM-2 approved_at is the clock's`);
    const cfg = pre.configs.get(P.config(ap.configId));
    assert.ok(cfg && cfg.enabled, `${label}: SM-2 the approval names config ${ap.configId}, which is missing or disabled`);
    assert.match(ap.symbol, /^[A-Z0-9]{1,10}$/, `${label}: SM-2 symbol ${ap.symbol}`);
    const nameBytes = Buffer.byteLength(ap.name, 'utf8');
    assert.ok(nameBytes >= 1 && nameBytes <= S.MAX_NAME_LEN && !/[\u0000-\u001f\u007f]/.test(ap.name) && !ap.name.startsWith(' ') && !ap.name.endsWith(' '), `${label}: SM-2 name ${JSON.stringify(ap.name)}`);
    assert.equal(ap.rentPayer, lpA.admin, `${label}: SM-2 the approval's rent payer is not the admin`);
  }
  for (const [k, oi] of post.optIns) {
    if (pre.optIns.has(k)) continue;
    assert.ok(has('opt_in_payout').length, `${label}: a PayoutOptIn appeared outside opt_in_payout`);
    const coin = post.coins.get(oi.coin);
    assert.ok(coin && oi.founder === coin.founder, `${label}: SM-2 the opt-in of ${oi.coin} is not signed by its founder`);
    assert.ok(pre.launchpad.payoutDestination !== ZERO && oi.agreedDestination === pre.launchpad.payoutDestination, `${label}: SM-2 the opt-in agrees to ${oi.agreedDestination}, not the payout wallet`);
    assert.equal(k, P.payoutOptIn(oi.coin));
  }
  // I20: settings
  const lp0 = pre.launchpad; const lp = post.launchpad;
  if (lp) {
    if (lp.payoutAuthority !== ZERO || lp.payoutDestination !== ZERO) {
      assert.ok(lp.payoutAuthority !== ZERO && lp.payoutDestination !== ZERO, `${label}: I20 payout keys both set`);
      assert.ok(![lp.admin, lp.guardian, S.ADDRESSES.feeRecipient].includes(lp.payoutAuthority), `${label}: I20 payout key separate`);
      assert.ok(![lp.payoutAuthority, lp.admin, lp.guardian, S.ADDRESSES.feeRecipient].includes(lp.payoutDestination), `${label}: I20 payout wallet separate`);
    }
    // R5-CONS-1: the guardian's halt never waits for the admin's time lock
    if (lp.guardian !== ZERO) assert.ok(lp.guardian !== lp.admin && lp.guardian !== lp.pendingAdmin, `${label}: I20 the guardian is the admin or the proposed admin`);
    // GOV-2: FEE_RECIPIENT only receives
    for (const [k, v] of [['admin', lp.admin], ['pending admin', lp.pendingAdmin], ['guardian', lp.guardian]]) {
      assert.notEqual(v, S.ADDRESSES.feeRecipient, `${label}: I20 FEE_RECIPIENT is the ${k}`);
    }
    // R2-DIFF-1, SPEC-1: no coin's founder is FEE_RECIPIENT, the guardian, the payout key or the launch approver. The
    // program refuses them at approve_launch, launch, launch_from_batch and transfer_founder; a later set_guardian,
    // set_payout_config or set_launch_approver naming a founder is not detected on chain (8.4), so for those keys this
    // is a rule the tests keep.
    for (const c of post.coins.values()) {
      for (const [k, v] of [['FEE_RECIPIENT', S.ADDRESSES.feeRecipient], ['the guardian', lp.guardian], ['the payout key', lp.payoutAuthority], ['the launch approver', lp.launchApprover]]) {
        if (v && v !== ZERO) assert.notEqual(c.founder, v, `${label}: I20 the founder of city ${c.cityId} is ${k}`);
      }
    }
    // I25: a set launch approver holds no other seat and never touches money (4.24)
    if (lp.launchApprover !== ZERO) {
      for (const [k, v] of [['FEE_RECIPIENT', S.ADDRESSES.feeRecipient], ['the admin', lp.admin], ['the pending admin', lp.pendingAdmin], ['the guardian', lp.guardian],
        ['the payout key', lp.payoutAuthority], ['the payout wallet', lp.payoutDestination]]) {
        if (v && v !== ZERO) assert.notEqual(lp.launchApprover, v, `${label}: I25 the launch approver is ${k}`);
      }
    }
    assert.equal(lp.address, P.launchpad());
  assert.ok(!lp.buybacksHalted || lp.buysHalted, `${label}: I20 buybacks are halted only while buys are (review LL-1)`);
    assert.equal(lp.nextConfigId, post.configs.size, `${label}: I20 next_config_id = number of configs`);
    if (lp0) {
      if (lp.guardian !== lp0.guardian) assert.ok(has('set_guardian').length, `${label}: I20 guardian changed outside set_guardian`);
      if (lp.launchApprover !== lp0.launchApprover) assert.ok(has('set_launch_approver').length, `${label}: I20 the launch approver changed outside set_launch_approver`);
      if (lp.admin !== lp0.admin) assert.ok(has('accept_admin').length, `${label}: admin changed outside accept_admin`);
      if (lp.pendingAdmin !== lp0.pendingAdmin) assert.ok(has('propose_admin').length || has('accept_admin').length, `${label}: pending admin changed`);
      if (lp.payoutAuthority !== lp0.payoutAuthority || lp.payoutDestination !== lp0.payoutDestination) assert.ok(has('set_payout_config').length, `${label}: payout keys changed`);
      const pauses = has('set_pause');
      for (const [k, name] of [['launchesPaused', 'launches'], ['payoutsPaused', 'payouts'], ['buysHalted', 'buys'], ['buybacksHalted', 'buybacks']]) {
        if (lp[k] === lp0[k]) continue;
        assert.ok(pauses.length, `${label}: ${k} changed outside set_pause`);
        const by = pauses.map((t) => t.accounts[0]);
        if ((k === 'buysHalted' || k === 'buybacksHalted') && lp[k]) assert.ok(by.some((s) => s === lp0.guardian || s === lp0.admin), `${label}: I20 ${name} halted only by the guardian or the admin`);
        else if (k === 'buysHalted' || k === 'buybacksHalted') assert.ok(by.includes(lp0.admin), `${label}: I20 ${name} resumed only by the admin`);
        else if (!lp[k]) assert.ok(by.includes(lp0.admin), `${label}: ${name} resumed only by the admin`);
      }
    } else {
      assert.ok(has('init_launchpad').length, `${label}: Launchpad created outside init_launchpad`);
    }
  }
  for (const [k, cfg] of post.configs) {
    const old = pre.configs.get(k);
    if (old && old.raw.equals(cfg.raw)) continue; // unchanged since the transaction that last checked it
    assert.equal(k, P.config(cfg.configId));
    assert.equal(S.validateConfig(S.configParamsOf(cfg)), true, `${label}: I20 config ${cfg.configId} passes V1 to V11`);
    assert.equal(cfg.totalFeeBps, cfg.liquidityBps + cfg.platformBps + cfg.founderBps + cfg.holdersBps + cfg.buybackBps);
    if (old) {
      const a = Buffer.from(old.raw); const b = Buffer.from(cfg.raw);
      a[10] = 0; b[10] = 0;
      assert.ok(a.equals(b), `${label}: I20 a LaunchConfig changed beyond enabled`);
      if (old.enabled !== cfg.enabled) assert.ok(has('set_launch_config_enabled').length, `${label}: enabled changed outside set_launch_config_enabled`);
    } else assert.ok(has('add_launch_config').length, `${label}: a config appeared outside add_launch_config`);
  }
  for (const k of pre.configs.keys()) assert.ok(post.configs.has(k), `${label}: a LaunchConfig closed`);
  // I23, I24: the batch state walked through the transaction, each batch launch held to the batch of its moment
  const walked = batchWalk(w, { pre, post, tx, seats, label });
  // I23: every new Coin comes from a launch that closed its Approval, or from a batch launch the walk accepted
  for (const c of post.coins.values()) {
    if (pre.coins.has(c.address)) continue;
    const viaLaunch = has('launch').some((t) => t.data.readBigUInt64LE(8) === c.cityId) && !post.approvals.has(P.approval(c.cityId));
    const viaBatch = walked.launchedHere.includes(c.cityId);
    assert.ok(viaLaunch !== viaBatch, `${label}: I23 the Coin of city ${c.cityId} came from neither path, or from both`);
  }
}

// ---------------------------------------------------------------- I22 liveness
/**
 * From the current state, by simulation (nothing is committed): on the curve a
 * buy of max_quote_in succeeds and graduates; every holder the world knows can
 * sell what he holds (unless the output would be 0, or he holds 0 lamports and
 * the payout would be below the rent-exempt minimum of an empty account);
 * withdraw_platform_fees and claim_founder_fees succeed (the same rent rule for a
 * founder holding 0 lamports); with a correct rewards
 * config forward_holders_fees succeeds; once the interval has passed and the
 * bucket is not empty buyback_burn burns, or curve_sol == f(S - 1), or the run
 * would buy less than one raw coin at the current price (dust that waits for
 * the bucket to grow, VICINITY-CURVE-NOTES.md 41); expired approvals can be
 * revoked by anyone. Skips buys and buybacks while buys are
 * halted, and everything while the halt-all build is loaded.
 */
export async function probeLiveness(w, { label = 'liveness' } = {}) {
  if (w.haltAllLoaded) return { probes: 0 };
  const snap = snapshot(w);
  const lp = snap.launchpad;
  let probes = 0;
  const sim = async (ixs, signers, what) => {
    const r = await w.simulate(ixs, signers);
    probes++;
    assert.ok(r.ok, `${label}: I22 ${what} failed: ${r.error}`);
    return r;
  };
  for (const c of snap.coins.values()) {
    const terms = S.coinTerms(c); const st = S.coinState(c);
    const tag = `${c.symbol}`;
    if (!lp.buysHalted && c.phase === 0) {
      const g = S.maxQuoteIn(terms, st);
      const probe = await w.probeSigner(g + 10_000_000_000n);
      const r = await sim(w.buyIxs(probe, c, g, 0n), [probe], `${tag} buy of max_quote_in`);
      const after = r.coin(c.address);
      assert.equal(after.phase, 1, `${label}: I22 the max_quote_in buy graduates ${tag}`);
    }
    for (const h of w.holdersOf(c.mint)) {
      const ta = ataOf(h.address, c.mint);
      const bal = tokenAccountInfo(w.accountInfo(ta))?.amount ?? 0n;
      if (bal === 0n) continue;
      const amount = c.phase === 0 && bal > c.tokensSold ? c.tokensSold : bal;
      let q;
      try { q = S.quoteSell(terms, st, amount); } catch (e) { if (e instanceof S.MathError && e.code === 'ZeroOutput') continue; throw e; }
      if (w.lamportsOf(h.address) === 0n && q.solOut < w.svm.minimumBalanceForRentExemption(0n)) continue;
      await sim([w.ix.sell({ user: h.address, coin: c.address, tokensIn: amount, minSolOut: q.solOut })], [h], `${tag} holder ${h.address} sells ${amount}`);
    }
    if (c.platformPending > 0n) await sim([w.ix.withdrawPlatformFees({ coin: c.address })], [], `${tag} withdraw_platform_fees`);
    const founder = w.signerOf(c.founder);
    // a founder holding 0 lamports can receive only at least the rent-exempt minimum of an empty account (6.5, 14.3)
    const claimable = founder && !(w.lamportsOf(founder.address) === 0n && c.founderPending < w.svm.minimumBalanceForRentExemption(0n));
    if (c.founderPending > 0n && claimable) await sim([w.ix.claimFounderFees({ founder: founder.address, coin: c.address })], [founder], `${tag} claim_founder_fees`);
    if (c.holdersPending > 0n) {
      const r = w.P.rewardsAccounts(c.mint);
      const acc = w.accountInfo(r.config);
      let ok = false;
      try { ok = acc && S.rewardsConfigProblems(S.decodeRewardsCityConfig(acc, { cluster: w.cluster }), { mint: c.mint, vault: r.vault, admin: lp.admin }).length === 0; } catch { ok = false; }
      if (ok) await sim(w.ix.forwardHoldersFeesWithSync({ coin: c.address }), [], `${tag} forward_holders_fees + SyncNative`);
    }
    if (!lp.buybacksHalted && c.buybackPending > 0n && snap.slot >= c.lastBuybackSlot + S.BUYBACK_INTERVAL_SLOTS) {
      const q = S.quoteBuyback(terms, st, snap.slot);
      if (q) {
        const r = await sim([w.ix.buybackBurn({ coin: c.address })], [], `${tag} buyback_burn`);
        assert.equal(r.coin(c.address).buybackCount, c.buybackCount + 1n, `${label}: I22 the buyback burns`);
      } else {
        // the two no-ops of 7.1 that are not stuck states: the curve one raw coin before its end (the next buy
        // graduates the coin), and a run of b = min(buyback_pending, cap) that buys less than one raw coin at the
        // current price (in the pool Y * b < X + b, on the curve tokens_for(r + b) <= s): dust that burns once the
        // next trades' shares make the bucket worth a coin (NOTES 41); a cap of 0 or anything else is stuck
        const cap = S.buybackCap(terms, st);
        const b = c.buybackPending < cap ? c.buybackPending : cap;
        const atEnd = c.phase === 0 && c.curveSol === S.curveValue(terms, terms.curveSupply - 1n);
        const dust = b > 0n && (c.phase === 1 ? c.poolTokens * b < c.poolSol + b : S.tokensFor(terms, c.curveSol + b) <= c.tokensSold);
        const why = { phase: c.phase, slot: snap.slot, lastBuybackSlot: c.lastBuybackSlot, buybackPending: c.buybackPending, cap, tokensSold: c.tokensSold, curveSol: c.curveSol, poolSol: c.poolSol, poolTokens: c.poolTokens };
        assert.ok(atEnd || dust, `${label}: I22 buyback stuck for ${tag}: ${JSON.stringify(why, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      }
    }
  }
  for (const a of snap.approvals.values()) {
    if (snap.ts <= a.expiresAt) continue;
    const stranger = await w.probeSigner(1_000_000_000n);
    await sim([w.ix.revokeApproval({ by: stranger.address, cityId: a.cityId, rentPayer: a.rentPayer })], [stranger], `revoke expired approval ${a.cityId}`);
  }
  return { probes };
}
