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
  opt_in_payout: { payer: 'founder', accounts: ['opt_in'] },
});
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

/** Every vicinity_curve account, decoded, plus each coin's vault and mint (the state the checker compares). */
export function snapshot(w) {
  const programId = w.programId;
  const accounts = new Map();
  const coins = new Map(); const configs = new Map(); const approvals = new Map(); const tickers = new Map(); const optIns = new Map();
  let launchpad = null;
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
    else assert.fail(`unknown account ${acc.address} owned by vicinity_curve (${acc.data.length} bytes)`);
  }
  for (const c of coins.values()) {
    c.vaultAmount = tokenAccountInfo(w.accountInfo(c.vault))?.amount ?? null;
    c.mintInfo = mintInfo(w.accountInfo(c.mint));
  }
  const clock = w.svm.getClock();
  return { slot: BigInt(clock.slot), ts: BigInt(clock.unixTimestamp), accounts, coins, configs, approvals, tickers, optIns, launchpad };
}

// ---------------------------------------------------------------- the transaction
/** Decode a sent transaction: keys, signers, top-level instructions with their inner instructions, log segments and events. */
export function decodeTransaction(w, { messageBytes, inner, logs, lookupAddresses = [] }) {
  const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const keys = [...msg.staticAccounts.map(String), ...lookupAddresses.map(String)];
  const nSigners = msg.header.numSignerAccounts;
  const signers = new Set(keys.slice(0, nSigners));
  const segments = splitLogs(logs);
  const top = msg.instructions.map((ix, i) => {
    const program = keys[ix.programAddressIndex];
    const accounts = (ix.accountIndices ?? []).map((k) => keys[k]);
    const data = Buffer.from(ix.data ?? []);
    const innerIxs = (inner[i] ?? []).map((ii) => {
      const c = ii.instruction();
      return { program: keys[c.programIdIndex()], accounts: Array.from(c.accounts()).map((k) => keys[k]), data: Buffer.from(c.data()), stackHeight: ii.stackHeight() };
    });
    const name = program === w.programId ? INSTRUCTION_BY_DISC.get(data.subarray(0, 8).toString('hex')) ?? null : null;
    const seg = segments[i] ?? [];
    // events: money events by event CPI, settings events by emit! (M20, 4.21)
    const cpiEvents = [];
    for (const ii of innerIxs) {
      if (ii.program !== w.programId) continue;
      const e = S.decodeEventCpi({ programId: ii.program, accounts: ii.accounts, data: ii.data }, { programId: w.programId });
      assert.ok(e, `inner instruction to vicinity_curve that is not an event CPI signed by the event authority (${ii.accounts.join(',')})`);
      assert.ok(S.CPI_EVENTS.includes(e.name), `${e.name} must not be an event CPI`);
      cpiEvents.push(e);
    }
    const logEvents = program === w.programId ? S.decodeEventLogs(seg, { programId: w.programId }) : [];
    for (const e of logEvents) assert.ok(!S.CPI_EVENTS.includes(e.name), `${e.name} is a money event and must be an event CPI, not a log`);
    const cu = computeOf(seg, program);
    return { index: i, program, accounts, data, name, inner: innerIxs, events: [...cpiEvents, ...logEvents], logs: seg, cu };
  });
  return { keys, signers, feePayer: keys[0], nSignatures: nSigners, top };
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
export function checkFailedTransaction(w, { pre, post, preAccounts, postAccounts, feePayer, nSignatures, label }) {
  checkProgramBytes(w, label);
  const fee = LAMPORTS_PER_SIGNATURE * BigInt(nSignatures);
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
    const pd = w.accountInfo(S.findPda([new PublicKey(id).toBuffer()], S.ADDRESSES.upgradeableLoader)[0]);
    assert.ok(pd && pd.data.subarray(PROGRAM_DATA_HEADER).equals(code), `${label}: I20 the code of ${id} changed without an upgrade`);
  }
}
/**
 * The compiled ids a vicinity_curve binary carries (3.2): the ids stored as
 * plain bytes in its read-only data (the program's own, vicinity_rewards',
 * the old program's and Metaplex's) must be those of `cluster`, and none of
 * the other cluster's. FEE_RECIPIENT and LEGACY_LAUNCHPAD are compared as
 * immediates in the code, not stored whole; the checker sees them at run time
 * instead (every launch fee and withdrawal goes to FEE_RECIPIENT, every
 * approval and launch reads the old Launchpad at its compiled address).
 */
export function compiledIdsProblems(binary, { programId, cluster }) {
  const b = Buffer.from(binary);
  const has = (k) => b.indexOf(new PublicKey(k).toBuffer()) >= 0;
  const out = [];
  const want = S.CLUSTERS[cluster]; const other = S.CLUSTERS[cluster === 'mainnet' ? 'devnet' : 'mainnet'];
  for (const [what, k] of [['program id', programId], ['REWARDS_PROGRAM_ID', want.rewardsProgram], ['LEGACY_PROGRAM_ID', want.legacyProgram], ['METAPLEX_PROGRAM_ID', S.ADDRESSES.metaplex]]) {
    if (!has(k)) out.push(`${what} ${k} missing`);
  }
  for (const [what, k] of [['REWARDS_PROGRAM_ID', other.rewardsProgram], ['LEGACY_PROGRAM_ID', other.legacyProgram], ['LEGACY_LAUNCHPAD', other.legacyLaunchpad]]) {
    if (has(k)) out.push(`the other cluster's ${what} ${k} present`);
  }
  return out;
}
/** I21's keys: the World's role keys and whatever the Launchpad names as admin, pending admin, guardian or payout key, before or after. */
export function roleKeysOf(w, pre, post) {
  const out = new Set(w.roleKeys());
  for (const lp of [pre?.launchpad, post?.launchpad]) {
    if (!lp) continue;
    for (const k of [lp.admin, lp.pendingAdmin, lp.guardian, lp.payoutAuthority]) if (k && k !== ZERO) out.add(k);
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
  for (const t of tx.top) {
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
          assert.ok(metadata && ii.stackHeight === 2 && ii.data[0] === 33 && ii.accounts[0] === metadata,
            `${label}: ${t.name} called Metaplex outside launch's CreateMetadataAccountsV3 of its own metadata`);
          continue;
        }
        assert.equal(ii.program, S.ADDRESSES.system, `${label}: I14 ${t.name} called ${ii.program} (only System, SPL Token, Metaplex and its own event CPI)`);
        const s = sysOf(ii);
        const inMetaplex = ii.stackHeight === 3 && metadata !== null;
        if (!inMetaplex) assert.equal(ii.stackHeight, 2, `${label}: I14 a system instruction at depth ${ii.stackHeight} under ${t.name}`);
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
        if (t.name === 'launch' && s.kind === 'transfer' && s.to === S.ADDRESSES.feeRecipient) continue; // the launch fee (checkLaunch: exactly the config's)
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
  for (const t of tx.top) { allIxs.push({ ...t, top: t }); for (const ii of t.inner) allIxs.push({ ...ii, top: t }); }
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
  for (const t of tx.top) {
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
    for (const t of tx.top) for (const e of t.events) if (e.name === 'Trade') assert.notEqual(e.data.user, r, `${label}: I21 a role key traded`);
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
          assert.ok(topName === 'buyback_burn' || topName === 'launch', `${label}: a burn from a vault outside buyback_burn and launch`);
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
          assert.equal(topName, 'launch', `${label}: mint_to outside launch`);
          assert.equal(a[1], post.coins.get(mints.get(a[0])).vault, 'minted into the vault');
          assert.equal(amount, S.COIN_SUPPLY, 'exactly COIN_SUPPLY, once');
          stepVault(mints.get(a[0]), ix.top.index, amount);
        }
        break;
      case 6:
        if (mints.has(a[0]) || vaults.has(a[0])) {
          assert.equal(topName, 'launch', `${label}: set_authority on a coin account outside launch`);
          assert.ok(mints.has(a[0]) && ix.data[1] === 0 && ix.data[2] === 0, 'only the mint authority, to None');
        }
        break;
      case 4: case 13: case 5: case 9: case 10: case 11:
        assert.ok(!vaults.has(a[0]) && !(tag >= 10 && mints.has(a[1])), `${label}: token instruction ${tag} on a vault or mint`);
        break;
      case 0: case 20: case 1: case 16: case 18:
        if (mints.has(a[0]) || vaults.has(a[0])) assert.equal(topName, 'launch', `${label}: initialize of a coin account outside launch`);
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
  for (const [addr, c] of post.coins) {
    const b = pre.coins.get(addr);
    const events = tx.top.flatMap((t) => t.events.map((e) => ({ ...e, top: t }))).filter((e) => e.data.city_id === c.cityId);
    const terms = S.coinTerms(c);
    let st; let ext; let launched = false;
    if (!b) {
      const cl = events.find((e) => e.name === 'CoinLaunched');
      assert.ok(cl, `${label}: a new Coin without CoinLaunched`);
      launched = true;
      checkLaunch(w, { c, cl, pre, label, txSlot, txTs, rentMin, tx });
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
    assert.equal(c.tradeSeq - (b?.tradeSeq ?? 0n), trades, 'I16 trade_seq +1 per trade');
    // I6: the account ends at the last pool event's reserves
    if (c.phase === 1 && kPrev !== null) assert.equal(c.poolSol * c.poolTokens, kPrev, `${label}: I6 the pool after the transaction is the last event's`);
    // I5: at the end of the instruction that graduates the coin, the vault holds exactly P (plus donations)
    if (graduationIx >= 0) {
      const steps = vaultStep.get(addr) ?? new Map(); const dons = donStep.get(addr) ?? new Map();
      let running = b ? b.vaultAmount : 0n;
      let donated = (w.tokenDonations.get(addr) ?? 0n) - (tokenFlows.donated.get(addr) ?? 0n);
      for (const t of tx.top) {
        running += steps.get(t.index) ?? 0n; donated += dons.get(t.index) ?? 0n;
        if (t.index === graduationIx) break;
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

  checkGlobal(w, { pre, post, tx, label, preAccounts });
}

/** CoinLaunched and the new Coin against the approval and the config it consumed (4.10, I2, I19). */
function checkLaunch(w, { c, cl, pre, label, txSlot, txTs, rentMin, tx }) {
  const P = w.P;
  const d = cl.data;
  assert.equal(cl.top.name, 'launch');
  const ap = pre.approvals.get(P.approval(c.cityId));
  assert.ok(ap, `${label}: launch without an approval`);
  const cfg = pre.configs.get(P.config(ap.configId));
  assert.ok(cfg && cfg.enabled, 'an enabled config');
  assert.equal(c.address, P.coin(c.cityId)); assert.equal(c.bump, P.coinWithBump(c.cityId)[1]);
  assert.equal(c.mint, P.mint(c.address)); assert.equal(c.vault, P.coinVault(c.address));
  assert.equal(c.founder, ap.founder); assert.equal(c.symbol, ap.symbol); assert.equal(c.configId, ap.configId);
  assert.deepEqual([...c.metaHash], [...ap.metaHash], 'meta_hash copied from the approval');
  for (const k of ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'totalFeeBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol']) {
    assert.equal(c[k], cfg[k], `terms copied: ${k}`);
  }
  const dust = S.launchDust(S.coinTerms(c));
  assert.equal(c.dustBurned, dust);
  assert.deepEqual([c.layoutVersion, c.phase, c.launchedAt, c.launchSlot, c.lastBuybackSlot, c.rentReserve], [1, 0, txTs, txSlot, txSlot, rentMin]);
  assert.ok(tx.signers.has(ap.founder), 'the approved founder signed');
  assert.ok(txTs <= ap.expiresAt, 'not expired');
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
  const xfers = cl.top.inner.filter((ii) => ii.program === S.ADDRESSES.system && ii.data.readUInt32LE(0) === 2 && ii.stackHeight === 2);
  const feeXfer = xfers.filter((x) => x.accounts[1] === S.ADDRESSES.feeRecipient);
  if (cfg.launchFeeLamports > 0n) {
    assert.equal(feeXfer.length, 1); assert.equal(feeXfer[0].data.readBigUInt64LE(4), cfg.launchFeeLamports); assert.equal(feeXfer[0].accounts[0], cl.top.accounts[1]);
  } else assert.equal(feeXfer.length, 0);
  w.coinMeta.set(c.address, { name: ap.name, symbol: ap.symbol });
  w.frozen.set(c.address, frozenBytes(c.raw));
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
  const md = readMetadata(w.accountInfo(S.metadataAddress(c.mint)).data);
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

/** I19, I20 and the settings rules after a transaction. */
function checkGlobal(w, { pre, post, tx, label, preAccounts }) {
  const P = w.P;
  const curveIxs = tx.top.filter((t) => t.program === w.programId);
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
  // at every approval and every launch: the old program had no Coin and no Approval for the city and its launches were paused
  for (const t of [...has('approve_launch'), ...has('launch')]) {
    const city = t.data.readBigUInt64LE(8);
    const empty = (k) => { const a = preAccounts.get(k); return !a?.exists || (a.owner === ZERO && a.data.length === 0); };
    const lpOld = preAccounts.get(P.cluster.legacyLaunchpad);
    const paused = lpOld?.exists && lpOld.owner === P.cluster.legacyProgram && lpOld.data.length === S.LEGACY_LAUNCHPAD_LEN
      && S.LEGACY_LAUNCHPAD_DISCRIMINATOR.every((x, i) => lpOld.data[i] === x) && lpOld.data[S.LEGACY_LAUNCHES_PAUSED_AT] === 1;
    assert.ok(empty(P.legacyCoin(city)) && empty(P.legacyApproval(city)) && paused, `${label}: I19 the old program could launch city ${city}`);
  }
  // I20: settings
  const lp0 = pre.launchpad; const lp = post.launchpad;
  if (lp) {
    if (lp.payoutAuthority !== ZERO || lp.payoutDestination !== ZERO) {
      assert.ok(lp.payoutAuthority !== ZERO && lp.payoutDestination !== ZERO, `${label}: I20 payout keys both set`);
      assert.ok(lp.payoutAuthority !== lp.admin && lp.payoutAuthority !== S.ADDRESSES.feeRecipient, `${label}: I20 payout key separate`);
      assert.ok(![lp.payoutAuthority, lp.admin, S.ADDRESSES.feeRecipient].includes(lp.payoutDestination), `${label}: I20 payout wallet separate`);
    }
    assert.equal(lp.address, P.launchpad());
    assert.equal(lp.nextConfigId, post.configs.size, `${label}: I20 next_config_id = number of configs`);
    if (lp0) {
      if (lp.guardian !== lp0.guardian) assert.ok(has('set_guardian').length, `${label}: I20 guardian changed outside set_guardian`);
      if (lp.admin !== lp0.admin) assert.ok(has('accept_admin').length, `${label}: admin changed outside accept_admin`);
      if (lp.pendingAdmin !== lp0.pendingAdmin) assert.ok(has('propose_admin').length || has('accept_admin').length, `${label}: pending admin changed`);
      if (lp.payoutAuthority !== lp0.payoutAuthority || lp.payoutDestination !== lp0.payoutDestination) assert.ok(has('set_payout_config').length, `${label}: payout keys changed`);
      const pauses = has('set_pause');
      for (const [k, name] of [['launchesPaused', 'launches'], ['payoutsPaused', 'payouts'], ['buysHalted', 'buys']]) {
        if (lp[k] === lp0[k]) continue;
        assert.ok(pauses.length, `${label}: ${k} changed outside set_pause`);
        const by = pauses.map((t) => t.accounts[0]);
        if (k === 'buysHalted' && lp.buysHalted) assert.ok(by.some((s) => s === lp0.guardian || s === lp0.admin), `${label}: I20 buys halted only by the guardian or the admin`);
        else if (k === 'buysHalted') assert.ok(by.includes(lp0.admin), `${label}: I20 buys resumed only by the admin`);
        else if (!lp[k]) assert.ok(by.includes(lp0.admin), `${label}: ${name} resumed only by the admin`);
      }
    } else {
      assert.ok(has('init_launchpad').length, `${label}: Launchpad created outside init_launchpad`);
    }
  }
  for (const [k, cfg] of post.configs) {
    assert.equal(k, P.config(cfg.configId));
    assert.equal(S.validateConfig(S.configParamsOf(cfg)), true, `${label}: I20 config ${cfg.configId} passes V1 to V11`);
    assert.equal(cfg.totalFeeBps, cfg.liquidityBps + cfg.platformBps + cfg.founderBps + cfg.holdersBps + cfg.buybackBps);
    const old = pre.configs.get(k);
    if (old) {
      const a = Buffer.from(old.raw); const b = Buffer.from(cfg.raw);
      a[10] = 0; b[10] = 0;
      assert.ok(a.equals(b), `${label}: I20 a LaunchConfig changed beyond enabled`);
      if (old.enabled !== cfg.enabled) assert.ok(has('set_launch_config_enabled').length, `${label}: enabled changed outside set_launch_config_enabled`);
    } else assert.ok(has('add_launch_config').length, `${label}: a config appeared outside add_launch_config`);
  }
  for (const k of pre.configs.keys()) assert.ok(post.configs.has(k), `${label}: a LaunchConfig closed`);
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
 * bucket is not empty buyback_burn burns or curve_sol == f(S - 1); expired
 * approvals can be revoked by anyone. Skips buys and buybacks while buys are
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
      const ta = S.associatedTokenAddress(h.address, c.mint);
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
    if (!lp.buysHalted && c.buybackPending > 0n && snap.slot >= c.lastBuybackSlot + S.BUYBACK_INTERVAL_SLOTS) {
      const q = S.quoteBuyback(terms, st, snap.slot);
      if (q) {
        const r = await sim([w.ix.buybackBurn({ coin: c.address })], [], `${tag} buyback_burn`);
        assert.equal(r.coin(c.address).buybackCount, c.buybackCount + 1n, `${label}: I22 the buyback burns`);
      } else {
        assert.ok(c.phase === 0 && c.curveSol === S.curveValue(terms, terms.curveSupply - 1n), `${label}: I22 buyback stuck for ${tag}`);
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
