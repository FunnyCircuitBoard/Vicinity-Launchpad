// F01 and F02 at full scale (VICINITY-CURVE-DESIGN.md 12.5): random sequences
// over every one of the 26 instructions in litesvm, valid and invalid, with
// the invariant checker after every transaction and a reference model of
// every coin, and of the LaunchBatch account, run side by side.
//
//   * Every step picks an action at random (seeded): trades of every size
//     (below the minimum, dust, the completing buy and past it, all of a
//     balance, more than a balance), buyback runs at random slots, the three
//     payouts, the payout path, founder transfers, approvals, revocations,
//     launches, configs (valid and invalid, F03 in passing), pauses by every
//     key, guardian and payout settings, admin hand-overs (and the admin's other
//     seats following it: the old program's admin, 8.5, and each city's rewards
//     authority, 4.2), lamport and coin
//     donations, holder burns and transfers, clock warps, bundles of several
//     instructions in one transaction, and invalid variants (F02): one account
//     of a valid instruction replaced by another plausible account, or its
//     authority replaced by another signer.
//   * The batch launch approval (4.23 to 4.27): the launch approver set,
//     rotated, removed or offered a key that holds another seat; publications
//     valid and invalid (a stranger, a skipped or repeated number, a zero root,
//     a leaf count out of range or not the list's, a window too soon, too far
//     or too long); clears by every key, with and without the halt; the clock
//     moved to a batch's window edges; batch launches valid and invalid (a
//     founder not the leaf's, a name, ticker, config or metadata hash not the
//     leaf's, a proof cut or padded, another batch's number, a city with its
//     coin or a pending approval, a locked ticker, a founder holding a role);
//     and role keys offered to the approver's seat and back (ApproverHoldsRole).
//     The model predicts every outcome and error in the program's order, and
//     after every transaction LaunchBatch's 260 bytes must equal the model's.
//   * The model (F01): each coin's state is kept by the SDK's math port from
//     each action's own inputs (never from the events), predicts whether each
//     trade, crank and payout succeeds or fails and with which error, and after
//     every transaction the Coin's 693 bytes must equal the model's state
//     written over the bytes launch wrote. A failed transaction must have been
//     predicted to fail; an invalid variant must fail and move nothing, unless
//     its replaced account is one the instruction legitimately leaves open
//     (FREE_SLOTS: a buy may deliver to any token account of the mint; a
//     withdrawal of another coin is that coin's withdrawal).
//   * The checker of invariants.mjs runs after every transaction (I1 to I21,
//     the money-flow tracer, destinations, the byte comparison of the replayed
//     events), and the I22 liveness probe every `probeEvery` steps.
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, TxError, LAMPORTS, DAY, metaHash } from './helpers.mjs';
import { encodeCoin } from './invariants.mjs';

const { PublicKey } = web3;
const ZERO = S.ADDRESSES.system;

/** mulberry32: a small seeded generator; every draw goes through it. */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** A log-uniform BigInt in [10^lo, 10^hi]. */
    log: (lo, hi) => BigInt(Math.floor(10 ** (lo + (hi - lo) * next()))),
    /** A BigInt in [0, n). */
    below: (n) => (n <= 0n ? 0n : BigInt(Math.floor(next() * Number(n > 2n ** 52n ? 2n ** 52n : n))) * (n > 2n ** 52n ? n / 2n ** 52n : 1n)),
    weighted: (table) => {
      const total = table.reduce((s, [w]) => s + w, 0);
      let x = next() * total;
      for (const [w, v] of table) { if ((x -= w) < 0) return v; }
      return table[table.length - 1][1];
    },
  };
  return r;
}

/**
 * Slots an invalid variant may replace and still succeed legitimately, because the account itself names the
 * object acted on and the instruction checks the signer's right to that object (the checker still checks
 * everything): a buy may deliver to any token account of the mint (14.3); withdraw is permissionless and
 * every other account derives from the coin; a founder who founded two coins may claim or hand over either;
 * the admin enables or disables whichever config it names.
 */
export const FREE_SLOTS = Object.freeze({
  buy: new Set(['user_token_account']),
  withdraw_platform_fees: new Set(['coin']),
  claim_founder_fees: new Set(['coin']),
  transfer_founder: new Set(['coin']),
  set_launch_config_enabled: new Set(['config']),
});
/** The single authority of an instruction (the slot a wrong-signer variant replaces). */
const AUTHORITY = Object.freeze({
  propose_admin: 'admin', set_guardian: 'admin', set_payout_config: 'admin', add_launch_config: 'admin', set_launch_config_enabled: 'admin',
  approve_launch: 'admin', claim_founder_fees: 'founder', opt_in_payout: 'founder', transfer_founder: 'founder', payout_founder_fees: 'payout_authority',
  launch: 'founder', accept_admin: 'new_admin',
  set_launch_approver: 'admin', publish_launch_batch: 'approver', clear_launch_batch: 'authority', launch_from_batch: 'founder',
});

const errorIn = (e, name) => new RegExp(`\\b${name}\\b`).test(`${e.logs.join('\n')}\n${e.errText}`);
const clone = (x) => (x === null || typeof x !== 'object' || x instanceof Uint8Array ? x : Array.isArray(x) ? x.map(clone) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v)])));

export class Fuzz {
  static async create({ seed = 1, coins = 3, traders = 6, probeEvery = 50, log = false } = {}) {
    const w = await World.create();
    w.probeEach = false;
    const f = new Fuzz(w, makeRng(seed), { probeEvery, log, seed });
    await f.setup({ coins, traders });
    return f;
  }

  constructor(w, rnd, o) {
    this.w = w; this.r = rnd; this.o = o;
    this.model = new Map(); // coin -> { terms, st, ext, raw }
    this.coins = []; // handles
    this.approvalsMade = [];
    this.founders = new Map(); // coin -> signer (current founder)
    this.bm = null; // the model of LaunchBatch (decoded form)
    this.batches = new Map(); // published seq -> the SDK's built batch, plus `founders` (city -> signer)
    this.nextCity = 9_000_000n;
    this.symbols = 0;
    this.stats = { steps: 0, txs: 0, ok: 0, failed: 0, predictedFail: 0, invalid: 0, invalidRefused: 0, freeAccepted: 0, byAction: {} };
    this.rent0 = w.svm.minimumBalanceForRentExemption(0n);
    this.ataRent = w.svm.minimumBalanceForRentExemption(165n);
  }

  // ------------------------------------------------------------------ setup
  async setup({ coins, traders }) {
    const w = this.w;
    this.traders = [];
    for (let i = 0; i < traders; i++) this.traders.push(await w.signer(20_000n));
    // a trader holding almost nothing and one holding nothing (the rent rules of 14.3)
    this.traders.push(await w.signer(0n));
    const poor = await w.signer(0n); w.svm.airdrop(poor.address, 3_000_000n); this.traders.push(poor);
    this.strangers = [await w.signer(5n), await w.signer(5n)];
    this.payoutKey = await w.signer(5n); this.payoutKey2 = await w.signer(5n); this.payoutWallet = await w.signer(1n);
    await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: this.payoutKey.address, payoutDestination: this.payoutWallet.address })], [w.admin], 'set_payout_config');
    w.payoutKey = this.payoutKey;
    // the batch launch approval (4.23 to 4.27): LaunchBatch, two approver keys, mostly one of them set from the start
    this.approverKeys = [await w.signer(5n), await w.signer(5n)];
    this.fillerFounder = await w.signer(500n);
    await w.send([w.ix.initLaunchBatch({ admin: w.admin.address, payer: w.payer.address })], [w.admin], 'init_launch_batch');
    if (this.r.chance(0.85)) await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: this.approverKeys[0].address })], [w.admin], 'set_launch_approver');
    this.bm = w.launchBatch();
    this.batchRaw = Buffer.from(w.accountInfo(w.P.launchBatch()).data);
    // configs: #0, random shares on #0's curve, and a small curve that graduates quickly
    this.configs = [0];
    for (let k = 0; k < 40 && this.configs.length < 2; k++) {
      const p = { ...S.DEFAULT_CONFIG, liquidityBps: BigInt(this.r.int(121)), platformBps: BigInt(this.r.int(121)), founderBps: BigInt(this.r.int(101)), holdersBps: BigInt(this.r.int(121)), buybackBps: BigInt(this.r.int(61)) };
      if (S.configRule(p) === null) this.configs.push(await w.addConfig(p));
    }
    const small = this.derivedConfig(2_000_000_000n + this.r.below(8_000_000_000n));
    if (small) this.configs.push(await w.addConfig(small));
    for (let i = 0; i < coins; i++) await this.launchNew({ rewards: i === 1 ? 'wrong' : i === 2 ? 'none' : 'ok' });
  }

  /** A valid config with random shares on a curve of graduation target `r` found by 5.9's search (or null). */
  derivedConfig(r, tries = 20) {
    for (let k = 0; k < tries; k++) {
      const p = 10_000_000_000_000n + this.r.below(440_000_000_000_000n);
      const s = S.COIN_SUPPLY - p - (this.r.chance(0.5) ? 0n : this.r.below(S.MAX_DUST_RAW + 1n));
      let curve;
      try { curve = S.deriveCurve(s, p, r, 64n); } catch { continue; }
      const params = {
        liquidityBps: BigInt(this.r.int(121)), platformBps: BigInt(this.r.int(121)), founderBps: BigInt(this.r.int(101)), holdersBps: BigInt(this.r.int(121)), buybackBps: BigInt(this.r.int(61)),
        virtualSol: curve[0], virtualTokens: curve[1], curveSupply: s, poolSupply: p, graduationSol: r, launchFeeLamports: this.r.below(S.MAX_LAUNCH_FEE_LAMPORTS + 1n),
      };
      if (S.configRule(params) === null) return params;
    }
    return null;
  }

  symbol() { this.symbols++; return `F${this.symbols.toString(36).toUpperCase()}`; }

  /** Approve and launch a coin (setup and the occasional fresh coin), with a rewards config: 'ok', 'wrong' or 'none'. */
  async launchNew({ rewards = 'ok' } = {}) {
    const w = this.w;
    const founder = await w.signer(50n);
    const cityId = this.nextCity++;
    const configId = this.r.pick(this.configs.filter((c) => w.config(c).enabled)) ?? 0;
    await w.approve({ cityId, founder, configId, symbol: this.symbol() });
    const h = await w.launch({ cityId, founder });
    this.registerLaunch(h.coin, founder);
    if (rewards !== 'none') await this.initRewards(h, rewards === 'ok');
    return h;
  }
  registerLaunch(coin, founder) {
    const w = this.w;
    const c = w.coinView({ coin });
    const h = { ...w.handle(c.cityId, founder), founder };
    this.coins.push(h);
    this.founders.set(h.coin, founder);
    this.model.set(h.coin, {
      terms: S.coinTerms(c), st: S.stateAtLaunch(c.launchSlot), raw: Buffer.from(w.accountInfo(h.coin).data),
      ext: { founder: c.founder, platformWithdrawn: 0n, founderClaimed: 0n, founderPaidOut: 0n, holdersForwarded: 0n, payoutSeq: 0n, lastPayoutAt: 0n, graduatedAt: 0n, graduationSlot: 0n },
    });
    return h;
  }
  /** vicinity_rewards init_city for a coin: the config forward_holders_fees accepts, or a Creator one it refuses forever. */
  async initRewards(h, correct) {
    const w = this.w;
    const R = w.rewardsPdas();
    const config = R.city(h.mint);
    const admin = w.launchpad().admin;
    const authority = w.signerOf(admin);
    await w.send([w.rewardsIx('init_city', { reward_model: { [correct ? 'Holders' : 'Creator']: {} }, founder_bps: correct ? 0 : 10_000, city_tag: Array(32).fill(0) }, {
      payer: w.payer.address, admin: this.registryAdmin().address, registry: R.registry, authority: admin, founder: String(h.founder.address), city_coin_mint: h.mint,
      reward_mint: S.ADDRESSES.nativeMint, config, vault: R.vault(config), token_program: S.ADDRESSES.token, system_program: S.ADDRESSES.system,
    })], authority.address === this.registryAdmin().address ? [this.registryAdmin()] : [this.registryAdmin(), authority], 'rewards init_city');
  }
  /** vicinity_rewards' registry admin as it stands (it follows this program's admin, OPS-1). */
  registryAdmin() { return this.w.signerOf(this.w.registryAdmins().admin); }

  // ------------------------------------------------------------------ the model
  now() { const c = this.w.svm.getClock(); return { slot: BigInt(c.slot), ts: BigInt(c.unixTimestamp) }; }
  lamports(a) { return this.w.lamportsOf(a); }
  /**
   * Apply one instruction to a model copy `m` (a Map clone); returns `{ ok }` or `{ fail, err }`.
   * `ctx` carries the lamports each user has left inside a bundle.
   */
  predict(m, op, ctx) {
    const w = this.w;
    const lp = ctx.lp;
    const { slot, ts } = this.now();
    const coinModel = op.coin ? m.get(op.coin) : null;
    const left = (a) => ctx.lam.get(a) ?? this.lamports(a);
    const fail = (err, why) => ({ fail: true, err, why });
    switch (op.kind) {
      case 'buy': {
        // the order the runtime and the program check in: the token account's creation (paid by the user), then
        // Anchor's account checks, then the handler (halt, minimum, the quote, slippage), then the transfer
        const k = `${op.user}:${op.mint}`;
        let have = left(op.user);
        if (ctx.ataMissing.has(k)) {
          if (have < this.ataRent) return fail(null, `cannot pay the token account (${have})`);
          have -= this.ataRent;
        } else if (!(w.exists(w.ata(op.user, op.mint)) || ctx.created.has(k))) return fail('AccountNotInitialized');
        if (lp.buysHalted) return fail('BuysHalted');
        if (op.solIn < S.MIN_TRADE_LAMPORTS) return fail('TradeTooSmall');
        let q;
        try { q = S.quoteBuy(coinModel.terms, coinModel.st, op.solIn); } catch (e) { if (e instanceof S.MathError) return fail(S.programErrorOf(e)); throw e; }
        if (q.tokensOut < op.minOut) return fail('SlippageExceeded');
        if (have < q.charged) return fail(null, `holds ${have}, charged ${q.charged}`);
        ctx.lam.set(op.user, have - q.charged);
        if (ctx.ataMissing.delete(k)) ctx.created.add(k);
        ctx.tok.set(k, (ctx.tok.get(k) ?? this.w.balanceOf(op.user, op.mint)) + q.tokensOut);
        coinModel.st = q.newState;
        if (q.graduates) { coinModel.ext.graduatedAt = ts; coinModel.ext.graduationSlot = slot; }
        return { ok: true };
      }
      case 'sell': {
        const k = `${op.user}:${op.mint}`;
        if (!(w.exists(w.ata(op.user, op.mint)) || ctx.created.has(k))) return fail('AccountNotInitialized');
        let q;
        try { q = S.quoteSell(coinModel.terms, coinModel.st, op.tokensIn); } catch (e) { if (e instanceof S.MathError) return fail(S.programErrorOf(e)); throw e; }
        if (q.solOut < op.minOut) return fail('SlippageExceeded');
        const bal = ctx.tok.get(k) ?? this.w.balanceOf(op.user, op.mint);
        if (bal < op.tokensIn) return fail(null, `holds ${bal} coins`);
        ctx.lam.set(op.user, left(op.user) + q.solOut); ctx.tok.set(k, bal - op.tokensIn);
        coinModel.st = q.newState;
        return { ok: true };
      }
      case 'buyback': {
        if (lp.buybacksHalted) return fail('BuybacksHalted');
        const q = S.quoteBuyback(coinModel.terms, coinModel.st, slot);
        if (q) coinModel.st = q.newState;
        return { ok: true };
      }
      case 'withdraw': {
        const a = coinModel.st.platformPending;
        coinModel.st = { ...coinModel.st, platformPending: 0n }; coinModel.ext.platformWithdrawn += a;
        return { ok: true };
      }
      case 'claim': {
        const by = String(op.signer.address);
        if (by !== coinModel.ext.founder) return fail('WrongFounder');
        const a = coinModel.st.founderPending;
        if (a > 0n) ctx.lam.set(by, left(by) + a);
        coinModel.st = { ...coinModel.st, founderPending: 0n }; coinModel.ext.founderClaimed += a;
        return { ok: true };
      }
      case 'forward': {
        const r = w.P.rewardsAccounts(op.mint);
        const acc = w.accountInfo(r.config);
        let ok = false;
        try { ok = !!acc && S.rewardsConfigProblems(S.decodeRewardsCityConfig(acc, { cluster: w.cluster }), { mint: op.mint, vault: r.vault, admin: lp.admin }).length === 0; } catch { ok = false; }
        if (!ok) return fail(null);
        const a = coinModel.st.holdersPending;
        coinModel.st = { ...coinModel.st, holdersPending: 0n }; coinModel.ext.holdersForwarded += a;
        return { ok: true };
      }
      case 'payout': {
        // Anchor's account checks first (the opt-in exists, the wallet is the configured one and system-owned), then the handler
        const oiAcc = w.accountInfo(w.P.payoutOptIn(op.coin));
        if (!oiAcc) return fail('AccountNotInitialized');
        if (op.destination !== lp.payoutDestination) return fail('DestinationMismatch');
        if ((w.accountInfo(op.destination)?.owner ?? ZERO) !== ZERO) return fail('InvalidAddress');
        if (lp.payoutAuthority === ZERO || String(op.signer.address) !== lp.payoutAuthority) return fail('Unauthorized');
        if (lp.payoutsPaused) return fail('PayoutsPaused');
        const oi = S.decodePayoutOptIn(oiAcc, { programId: w.programId });
        if (oi.founder !== coinModel.ext.founder) return fail('OptInFounderMismatch');
        if (oi.agreedDestination !== lp.payoutDestination) return fail('DestinationMismatch');
        if (ts < coinModel.ext.lastPayoutAt + S.PAYOUT_COOLDOWN_SECS) return fail('PayoutTooSoon');
        const a = coinModel.st.founderPending;
        if (a === 0n) return { ok: true };
        ctx.lam.set(op.destination, left(op.destination) + a);
        coinModel.st = { ...coinModel.st, founderPending: 0n };
        coinModel.ext.founderPaidOut += a; coinModel.ext.payoutSeq += 1n; coinModel.ext.lastPayoutAt = ts;
        return { ok: true };
      }
      case 'transfer_founder':
        if (String(op.signer.address) !== coinModel.ext.founder) return fail('WrongFounder');
        // the founder seat (R2-DIFF-1, SPEC-1): never FEE_RECIPIENT, the guardian or the payout key
        if (String(op.newFounder) === String(S.ADDRESSES.feeRecipient)) return fail('FeeRecipientRole');
        if ([lp.guardian, lp.payoutAuthority, lp.launchApprover].includes(String(op.newFounder))) return fail('FounderHoldsRole');
        coinModel.ext.founder = op.newFounder;
        return { ok: true };
      case 'add_config': {
        if (String(op.signer.address) !== lp.admin) return fail('Unauthorized');
        const rule = S.configRule(op.params);
        if (rule) { try { S.validateConfig(op.params); } catch (e) { return fail(e.programError); } }
        return { ok: true };
      }
      case 'set_pause': {
        const allowed = pauseAllowed(String(op.signer.address), lp, op.flags);
        if (!allowed) return fail('Unauthorized');
        // review LL-1: buybacks are halted only while buys are, whatever the signer may set
        const buys = op.flags.buys ?? lp.buysHalted; const buybacks = op.flags.buybacks ?? lp.buybacksHalted;
        if (buybacks && !buys) return fail('BuybackHaltWithoutBuyHalt');
        return { ok: true };
      }
      case 'init_launchpad': return fail(null);
      // ---------------------------------------------------------------- the batch launch approval (4.23 to 4.27)
      case 'set_launch_approver': {
        if (String(op.signer.address) !== lp.admin) return fail('Unauthorized');
        const a = op.approver;
        if (a !== ZERO) {
          if (a === String(S.ADDRESSES.feeRecipient)) return fail('FeeRecipientRole');
          if ([lp.admin, lp.pendingAdmin, lp.guardian, lp.payoutAuthority, lp.payoutDestination].some((k) => k !== ZERO && k === a)) return fail('ApproverHoldsRole');
        }
        ctx.bm.latest.cleared = true; ctx.bm.previous.cleared = true; ctx.bm.halted = false;
        return { ok: true };
      }
      case 'publish': {
        const by = String(op.signer.address);
        if (lp.launchApprover === ZERO || by !== lp.launchApprover) return fail('Unauthorized');
        if (ctx.bm.halted) return fail('BatchesHalted');
        if (op.seq !== ctx.bm.latest.seq + 1n) return fail('BatchSeqMismatch');
        if (op.root.every((x) => x === 0)) return fail('BadBatchRoot');
        if (op.leafCount < 1 || op.leafCount > S.MAX_BATCH_LEAVES) return fail('BadLeafCount');
        if (!S.publishWindowOk(ts, op.validFrom, op.validUntil)) return fail('BadBatchWindow');
        const rec = { seq: op.seq, root: Uint8Array.from(op.root), leafCount: op.leafCount, validFrom: op.validFrom, validUntil: op.validUntil, publishedAt: ts, publishedSlot: slot, publisher: by, cleared: false };
        // 8.6: a begun latest becomes previous; a pending one is replaced
        if (ctx.bm.latest.seq !== 0n && ts >= ctx.bm.latest.validFrom) ctx.bm.previous = ctx.bm.latest;
        ctx.bm.latest = rec;
        return { ok: true };
      }
      case 'clear': {
        const by = String(op.signer.address);
        const may = by === lp.admin || (lp.launchApprover !== ZERO && by === lp.launchApprover) || (lp.guardian !== ZERO && by === lp.guardian);
        if (!may) return fail('Unauthorized');
        ctx.bm.latest.cleared = true; ctx.bm.previous.cleared = true;
        if (op.halt) ctx.bm.halted = true;
        return { ok: true };
      }
      case 'batch_launch': {
        // Anchor's account checks first (their order is not modelled: two at once predict some failure), then the handler's in its order
        const anchor = [];
        if (w.approval(op.cityId)) anchor.push('ApprovalPending');
        const cfg = w.exists(w.P.config(op.configId)) ? w.config(op.configId) : null;
        if (!cfg) anchor.push('AccountNotInitialized'); else if (!cfg.enabled) anchor.push('ConfigDisabled');
        if (w.exists(w.P.coin(op.cityId))) anchor.push(null);
        if (w.exists(w.P.ticker(op.symbol))) anchor.push(null);
        const old = w.accountInfo(w.legacyPdas().launchpad);
        if (old.data[S.LEGACY_LAUNCHES_PAUSED_AT] !== 1) anchor.push('LegacyLaunchesOpen');
        const oa = w.legacyAdmins(); if (oa.admin !== lp.admin || oa.pendingAdmin !== ZERO) anchor.push('LegacyAdminMismatch');
        const ra = w.registryAdmins(); if (ra.admin !== lp.admin || ra.pendingAdmin !== ZERO) anchor.push('RewardsRegistryAdminMismatch');
        if (anchor.length) return fail(anchor.length === 1 ? anchor[0] : null, `account checks: ${anchor.join(', ')}`);
        if (lp.launchesPaused) return fail('LaunchesPaused');
        if (lp.buysHalted) return fail('BuysHalted');
        const refusal = S.batchRefusal(ctx.bm, lp, op.batchSeq, ts);
        if (refusal) return fail(refusal);
        const founder = String(op.signer.address);
        if (founder === String(S.ADDRESSES.feeRecipient)) return fail('FeeRecipientRole');
        if ([lp.guardian, lp.payoutAuthority, lp.launchApprover].some((k) => k !== ZERO && k === founder)) return fail('FounderHoldsRole');
        const b = op.batchSeq === ctx.bm.latest.seq ? ctx.bm.latest : ctx.bm.previous;
        if (op.proof.length > S.maxProofLen(b.leafCount)) return fail('ProofTooLong');
        const leaf = S.launchLeaf({ programId: w.programId, batchSeq: op.batchSeq, cityId: op.cityId, founder, configId: op.configId, metaHash: op.metaHash, name: op.name, symbol: op.symbol });
        if (!S.verifyLaunchProof({ root: b.root, leaf, proof: op.proof, leafCount: b.leafCount })) return fail('InvalidProof');
        return { ok: true };
      }
      default: return op.expect ? fail(op.expect) : { any: true };
    }
  }

  // ------------------------------------------------------------------ actions
  liveCoins() { return this.coins; }
  coinOf() { return this.r.pick(this.coins); }
  holderOf(h) { const hs = this.w.holdersOf(h.mint).filter((u) => this.w.balanceOf(u, h.mint) > 0n); return hs.length ? this.r.pick(hs) : this.r.pick(this.traders); }

  buyOp(h, user = this.r.pick(this.traders)) {
    const w = this.w; const m = this.model.get(h.coin); const r = this.r;
    let solIn;
    const k = r.int(60);
    if (k <= 2) solIn = r.below(S.MIN_TRADE_LAMPORTS + 1n);
    else if (k <= 4 && m.st.phase === 0) { const q = S.maxQuoteIn(m.terms, m.st); solIn = r.chance(0.5) ? q : q + r.below(q / 2n + 1n); }
    else if (k === 5 && m.st.phase === 0) { const q = S.maxQuoteIn(m.terms, m.st); solIn = q > 1000n ? q - 1n - r.below(1000n) : q; }
    else if (k <= 7) solIn = this.lamports(user.address) - r.below(this.rent0 * 2n);
    else solIn = r.log(5, Math.log10(Number(m.terms.graduationSol)) - 1.3);
    if (solIn < 0n) solIn = 0n;
    let minOut = 0n;
    if (r.chance(0.08)) { try { minOut = S.quoteBuy(m.terms, m.st, solIn).tokensOut + (r.chance(0.5) ? 1n : 0n); } catch { minOut = 1n; } }
    const ata = w.ata(user.address, h.mint);
    const ixs = [];
    const missing = !w.exists(ata);
    if (missing) ixs.push(S.createAssociatedTokenAccountIdempotent({ payer: user.address, owner: user.address, mint: h.mint }));
    ixs.push(w.ix.buy({ user: user.address, coin: h.coin, userTokenAccount: ata, solIn, minTokensOut: minOut }));
    return { kind: 'buy', coin: h.coin, mint: h.mint, user: user.address, signer: user, solIn, minOut, ixs, missing, holder: user, h };
  }
  sellOp(h, user = this.holderOf(h)) {
    const w = this.w; const r = this.r; const m = this.model.get(h.coin);
    const bal = w.balanceOf(user, h.mint);
    let tokensIn;
    const k = r.int(12);
    if (k === 0) tokensIn = 1n + r.below(5_000n);
    else if (k === 1) tokensIn = bal;
    else if (k === 2) tokensIn = bal + 1n + r.below(1_000_000n);
    else if (k === 3) tokensIn = 0n;
    else tokensIn = (bal * BigInt(1 + r.int(1000))) / 1000n;
    let minOut = 0n;
    if (r.chance(0.08)) { try { minOut = S.quoteSell(m.terms, m.st, tokensIn).solOut + (r.chance(0.5) ? 1n : 0n); } catch { minOut = 1n; } }
    return { kind: 'sell', coin: h.coin, mint: h.mint, user: user.address, signer: user, tokensIn, minOut, h,
      ixs: [w.ix.sell({ user: user.address, coin: h.coin, userTokenAccount: w.ata(user.address, h.mint), tokensIn, minSolOut: minOut })] };
  }
  buybackOp(h) { return { kind: 'buyback', coin: h.coin, h, ixs: [this.w.ix.buybackBurn({ coin: h.coin })] }; }
  withdrawOp(h) { return { kind: 'withdraw', coin: h.coin, h, ixs: [this.w.ix.withdrawPlatformFees({ coin: h.coin })] }; }
  claimOp(h) {
    const founder = this.founders.get(h.coin);
    const signer = this.r.chance(0.9) ? founder : this.r.pick(this.traders);
    return { kind: 'claim', coin: h.coin, h, signer, signers: [signer], ixs: [this.w.ix.claimFounderFees({ founder: signer.address, coin: h.coin })], signerAddr: signer.address };
  }
  forwardOp(h) { return { kind: 'forward', coin: h.coin, mint: h.mint, h, ixs: this.w.ix.forwardHoldersFeesWithSync({ coin: h.coin }) }; }
  payoutOp(h) {
    const w = this.w; const lp = w.launchpad();
    const key = this.r.chance(0.9) && lp.payoutAuthority !== ZERO ? w.signerOf(lp.payoutAuthority) ?? this.payoutKey : this.r.pick(this.traders);
    const destination = this.r.chance(0.9) && lp.payoutDestination !== ZERO ? lp.payoutDestination : this.r.pick(this.traders).address;
    return { kind: 'payout', coin: h.coin, h, signer: key, signers: [key], destination, ixs: [w.ix.payoutFounderFees({ payoutAuthority: key.address, coin: h.coin, destination })] };
  }

  /**
   * The payout path end to end (4.18 to 4.20), as consecutive steps: a stale opt-in revoked, the current founder
   * opting in to the configured wallet, a day passing, the payout. Each step is predicted like any other.
   */
  payoutFlow(h) {
    const w = this.w;
    const steps = [];
    const oiAcc = w.accountInfo(w.P.payoutOptIn(h.coin));
    const lp = w.launchpad();
    const founder = this.founders.get(h.coin);
    const oi = oiAcc ? S.decodePayoutOptIn(oiAcc, { programId: w.programId }) : null;
    if (oi && (oi.founder !== String(founder.address) || oi.agreedDestination !== lp.payoutDestination)) {
      steps.push({ label: 'revoke a stale opt-in', ops: [{ kind: 'revoke_opt_in', ixs: [] }], signers: [founder],
        ixs: [w.ix.revokePayoutOptIn({ by: founder.address, coin: h.coin, optInFounder: oi.founder })] });
    }
    if (!oi || steps.length) {
      steps.push(() => ({ label: 'opt_in_payout', ops: [{ kind: 'opt_in', ixs: [] }], signers: [this.founders.get(h.coin)],
        ixs: [w.ix.optInPayout({ founder: this.founders.get(h.coin).address, coin: h.coin, expectedDestination: w.launchpad().payoutDestination, refHash: metaHash(`flow${this.stats.steps}`) })] }));
    }
    steps.push(() => { w.warpSecs(S.PAYOUT_COOLDOWN_SECS + 1n); return { ...this.payoutOneStep(h) }; });
    return steps;
  }
  /** A launch end to end: the admin approves a fresh city on an enabled config, its founder launches it at once. */
  async launchFlow() {
    const w = this.w;
    const founder = await w.signer(30n);
    const cityId = this.nextCity++;
    const lp = w.launchpad();
    const enabled = this.configs.filter((c) => w.config(c).enabled);
    if (!enabled.length) return null;
    const configId = this.r.pick(enabled);
    const admin = w.signerOf(lp.admin);
    const symbol = this.symbol();
    this.approvalsMade.push({ cityId, founder });
    return [
      { label: 'approve_launch (flow)', ops: [{ kind: 'approve', ixs: [] }], signers: [admin],
        ixs: [w.ix.approveLaunch({ admin: admin.address, cityId, founder: founder.address, configId, name: `City ${cityId}`, symbol, metaHash: metaHash(`${cityId}`), expiresAt: w.now() + DAY })] },
      () => {
        const ap = w.approval(cityId);
        if (!ap) return null;
        return { label: 'launch (flow)', ops: [{ kind: 'launch', cityId, signer: founder, ixs: [] }], signers: [founder],
          ixs: [w.ix.launch({ founder: founder.address, payer: founder.address, cityId, configId: ap.configId, symbol: ap.symbol, rentPayer: ap.rentPayer })] };
      },
    ];
  }
  payoutOneStep(h) { const op = this.payoutOp(h); return { label: 'payout', ops: [op], ixs: op.ixs, signers: op.signers }; }

  /**
   * The admin's other seats follow it, as steps (4.2, 8.2, 8.5; NOTES 42 and 44): the old program's admin
   * (`propose_admin` by its current admin, `accept_admin` by this program's admin: until then approvals and
   * launches here fail with LegacyAdminMismatch), vicinity_rewards' registry admin (the same two steps: until
   * then they fail with RewardsRegistryAdminMismatch, OPS-1) and each city's rewards authority (`propose_authority`,
   * `accept_authority`: until then forward_holders_fees fails and the holders' money waits). A step may stop
   * after the proposal (`legacyAccept`, `rewardsAccept` false), leaving a transfer pending for a later run.
   * Every step is computed when it runs, from the chain.
   */
  followPlans({ legacyAccept = true, registryAccept = true, rewardsAccept = true } = {}) {
    const w = this.w;
    const steps = [];
    const follow = (label, signer, ix) => ({ label, ops: [{ kind: 'follow' }], signers: [signer], ixs: [ix] });
    steps.push(() => {
      const admin = w.launchpad().admin; const old = w.legacyAdmins(); const from = w.signerOf(old.admin);
      if (old.admin === admin || old.pendingAdmin === admin || !from) return null;
      return follow('legacy propose_admin (follow the admin)', from, w.legacyIx('propose_admin', { new_admin: new PublicKey(admin) }, { admin: old.admin, launchpad: w.legacyPdas().launchpad }));
    });
    if (legacyAccept) {
      steps.push(() => {
        const admin = w.launchpad().admin; const old = w.legacyAdmins();
        if (old.admin === admin || old.pendingAdmin !== admin) return null;
        return follow('legacy accept_admin (follow the admin)', w.signerOf(admin), w.legacyIx('accept_admin', {}, { new_admin: admin, launchpad: w.legacyPdas().launchpad }));
      });
    }
    const registry = w.rewardsPdas().registry;
    steps.push(() => {
      const admin = w.launchpad().admin; const reg = w.registryAdmins(); const from = w.signerOf(reg.admin);
      if (reg.admin === admin || reg.pendingAdmin === admin || !from) return null;
      return follow('rewards registry propose_admin (follow the admin)', from, w.rewardsIx('propose_admin', { new_admin: new PublicKey(admin) }, { admin: reg.admin, registry }));
    });
    if (registryAccept) {
      steps.push(() => {
        const admin = w.launchpad().admin; const reg = w.registryAdmins();
        if (reg.admin === admin || reg.pendingAdmin !== admin) return null;
        return follow('rewards registry accept_admin (follow the admin)', w.signerOf(admin), w.rewardsIx('accept_admin', {}, { new_admin: admin, registry }));
      });
    }
    for (const h of this.coins) {
      const config = w.P.rewardsAccounts(h.mint).config;
      const view = () => { try { return S.decodeRewardsCityConfig(w.accountInfo(config), { cluster: w.cluster }); } catch { return null; } };
      steps.push(() => {
        const v = view(); const admin = w.launchpad().admin;
        if (!v || v.authority === admin || v.pendingAuthority === admin || !w.signerOf(v.authority)) return null;
        return follow(`rewards propose_authority ${h.cityId} (follow the admin)`, w.signerOf(v.authority), w.rewardsIx('propose_authority', { new_authority: new PublicKey(admin) }, { authority: v.authority, config }));
      });
      if (rewardsAccept) {
        steps.push(() => {
          const v = view(); const admin = w.launchpad().admin;
          if (!v || v.authority === admin || v.pendingAuthority !== admin) return null;
          return follow(`rewards accept_authority ${h.cityId} (follow the admin)`, w.signerOf(admin), w.rewardsIx('accept_authority', {}, { new_authority: admin, config }));
        });
      }
      // a transfer left pending by an earlier admin while the authority is already the admin: cancelled
      steps.push(() => {
        const v = view(); const admin = w.launchpad().admin;
        if (!v || v.authority !== admin || v.pendingAuthority === ZERO) return null;
        return follow(`rewards cancel a stale authority transfer ${h.cityId}`, w.signerOf(admin), w.rewardsIx('propose_authority', { new_authority: new PublicKey(ZERO) }, { authority: admin, config }));
      });
    }
    return steps;
  }

  // ------------------------------------------------------------------ the batch launch approval (4.23 to 4.27)
  /** `set_launch_approver` by the admin (or not): one of the two approver keys, none, or a key holding another seat. */
  async setApproverPlan() {
    const w = this.w; const r = this.r; const lp = w.launchpad();
    const admin = r.chance(0.93) ? w.signerOf(lp.admin) : r.pick([...this.strangers, this.approverKeys[0]]);
    const k = r.int(20);
    const approver = k < 12 ? String(this.approverKeys[0].address) : k < 16 ? String(this.approverKeys[1].address) : k < 17 ? ZERO
      : r.pick([lp.admin, lp.guardian, lp.payoutAuthority, lp.payoutDestination, lp.pendingAdmin, String(S.ADDRESSES.feeRecipient)].filter((x) => x !== ZERO));
    return { kind: 'set_launch_approver', signer: admin, approver, ixs: [w.ix.setLaunchApprover({ admin: admin.address, approver })] };
  }
  /**
   * The day's list built with the SDK for the next number and published by the approver, valid or not. Entries are
   * mostly fresh cities and founders; some name a city that has its coin, a city with a pending approval, a locked
   * ticker, a disabled config or a founder holding a role (the publication does not look at entries: the launch fails).
   */
  async publishPlan() {
    const w = this.w; const r = this.r; const lp = w.launchpad(); const bm = this.bm;
    const next = bm.latest.seq + 1n;
    const n = r.chance(0.12) ? 16 + r.int(80) : 1 + r.int(4);
    const pending = this.approvalsMade.filter((a) => w.approval(a.cityId));
    const list = []; const cities = new Set(); const symbols = new Set();
    for (let i = 0; i < n; i++) {
      const k = r.int(50);
      let cityId = this.nextCity++;
      if (k === 0 && this.coins.length) cityId = r.pick(this.coins).cityId;
      else if (k === 1 && pending.length) cityId = r.pick(pending).cityId;
      let symbol = this.symbol();
      if (k === 2 && this.coins.length) symbol = w.coinView(r.pick(this.coins)).symbol;
      let founder = i < 6 ? await w.signer(30n) : this.fillerFounder;
      if (k === 3) founder = r.pick([w.signerOf(lp.guardian), w.signerOf(lp.launchApprover), w.signerOf(lp.payoutAuthority)].filter(Boolean)) ?? founder;
      if (cities.has(cityId) || symbols.has(symbol)) continue;
      cities.add(cityId); symbols.add(symbol);
      list.push({ cityId, founder, symbol, name: `Batch City ${cityId}`, configId: r.pick(this.configs), metaHash: metaHash(`b${cityId}:${symbol}`) });
    }
    const built = S.buildLaunchBatch(w.batchEntries(list), { programId: w.programId, batchSeq: next });
    built.founders = new Map(list.map((e) => [BigInt(e.cityId), e.founder]));
    const t = w.now();
    let win = S.defaultPublishWindow(t);
    if (r.chance(0.3)) { const f = t + S.BATCH_REVIEW_SECS + r.below(S.BATCH_MAX_LEAD_SECS - S.BATCH_REVIEW_SECS + 1n); win = { validFrom: f, validUntil: f + 1n + r.below(S.BATCH_MAX_VALIDITY_SECS) }; }
    let seq = next; let root = built.root; let leafCount = built.leafCount;
    let signer = w.signerOf(lp.launchApprover) ?? this.approverKeys[0];
    const v = r.int(100);
    if (v < 4) seq = r.chance(0.5) ? bm.latest.seq : next + 1n;
    else if (v < 6) root = new Uint8Array(32);
    else if (v < 8) leafCount = r.chance(0.5) ? 0 : S.MAX_BATCH_LEAVES + 1;
    else if (v < 10) leafCount = r.chance(0.5) ? Math.max(1, built.leafCount - 1) : built.leafCount + 1; // accepted; proofs then fit or not
    else if (v < 16) {
      const f = t + S.BATCH_REVIEW_SECS + 60n;
      win = r.pick([
        { validFrom: t + S.BATCH_REVIEW_SECS - 1n, validUntil: t + S.BATCH_REVIEW_SECS + DAY },
        { validFrom: t + S.BATCH_MAX_LEAD_SECS + 1n, validUntil: t + S.BATCH_MAX_LEAD_SECS + DAY },
        { validFrom: f, validUntil: f },
        { validFrom: f, validUntil: f + S.BATCH_MAX_VALIDITY_SECS + 1n },
        { validFrom: t + S.BATCH_REVIEW_SECS, validUntil: t + S.BATCH_REVIEW_SECS + S.BATCH_MAX_VALIDITY_SECS },
      ]);
    } else if (v < 20) signer = r.pick([w.signerOf(lp.admin), w.signerOf(lp.guardian) ?? w.guardian, this.approverKeys[1], r.pick(this.traders)]);
    return { kind: 'publish', signer, seq, root, leafCount, ...win, built,
      ixs: [w.ix.publishLaunchBatch({ approver: signer.address, seq, root, leafCount, ...win })] };
  }
  /** `clear_launch_batch` by the approver, the admin, the guardian or someone else, sometimes with the halt. */
  clearPlan() {
    const w = this.w; const r = this.r; const lp = w.launchpad();
    const who = r.weighted([[3, w.signerOf(lp.launchApprover)], [2, w.signerOf(lp.admin)], [2, w.signerOf(lp.guardian)], [1, r.pick(this.traders)], [1, this.approverKeys[1]]].filter(([, x]) => x));
    const halt = r.chance(0.25);
    return { kind: 'clear', signer: who, halt, ixs: [w.ix.clearLaunchBatch({ authority: who.address, halt })] };
  }
  /** Entries of the stored batches whose city has no coin yet: `{ seq, built, e }`. */
  batchCandidates() {
    const out = [];
    for (const [seq, built] of this.batches) for (const e of built.entries) if (!this.w.exists(this.w.P.coin(e.cityId))) out.push({ seq, built, e });
    return out;
  }
  /** A batch launch: mostly a city of the batch in force by its founder with his proof; sometimes one field not the leaf's. */
  batchLaunchPlan() {
    const w = this.w; const r = this.r;
    if (this.coins.length >= 16) return null;
    const all = this.batchCandidates();
    if (!all.length) return null;
    const lp = w.launchpad();
    const L = this.bm.latest;
    // mostly the founder comes once the day's list is in force
    if (L.seq !== 0n && !L.cleared && w.now() < L.validFrom && r.chance(0.6)) w.warpTo(L.validFrom + BigInt(r.int(3_600)));
    const now = w.now();
    const inForce = all.filter((c) => S.batchRefusal(this.bm, lp, c.seq, now) === null);
    const c = inForce.length && r.chance(0.85) ? r.pick(inForce) : r.pick(all);
    const args = S.launchBatchArgs(c.built, c.e.cityId);
    let founder = c.built.founders.get(c.e.cityId);
    const edit = {};
    const v = r.int(100);
    if (v < 5) founder = r.pick(this.traders.slice(0, 6));
    else if (v < 7) edit.name = `${args.name}x`;
    else if (v < 9) edit.symbol = this.symbol();
    else if (v < 10) edit.configId = r.pick(this.configs);
    else if (v < 11) edit.metaHash = metaHash(`other${this.stats.steps}`);
    else if (v < 13 && args.proof.length) edit.proof = args.proof.slice(0, -1);
    else if (v < 15) edit.proof = [...args.proof, Uint8Array.from(metaHash(`pad${this.stats.steps}`))];
    else if (v < 16 && this.batches.size > 1) edit.batchSeq = r.pick([...this.batches.keys()].filter((x) => x !== c.seq));
    const a = { ...args, ...edit };
    return { kind: 'batch_launch', signer: founder, cityId: a.cityId, batchSeq: a.batchSeq, configId: a.configId, name: a.name, symbol: a.symbol, metaHash: a.metaHash, proof: a.proof,
      ixs: [w.ix.launchFromBatch({ ...a, founder: founder.address, payer: founder.address })] };
  }
  /** The clock moved to an edge of the latest batch's window (its start, inside it, its last second, just past it). */
  batchWarp() {
    const w = this.w; const L = this.bm.latest; const now = w.now();
    if (L.seq === 0n) return;
    const ts = [L.validFrom, L.validFrom + BigInt(this.r.int(7_200)), L.validUntil, L.validUntil + 1n].filter((t) => t > now);
    if (ts.length) w.warpTo(this.r.pick(ts));
  }

  /** One random action as a plan `{ label, ops, ixs, signers, opts, invalid? }`. */
  async nextPlan() {
    const w = this.w; const r = this.r;
    const h = this.coinOf();
    const action = r.weighted([
      [22, 'buy'], [18, 'sell'], [7, 'buyback'], [3, 'withdraw'], [3, 'claim'], [3, 'forward'], [3, 'payout'],
      [1.5, 'opt_in'], [0.7, 'revoke_opt_in'], [0.7, 'transfer_founder'], [1.5, 'approve'], [0.8, 'revoke_approval'], [1.2, 'launch'],
      [1.2, 'add_config'], [0.6, 'set_enabled'], [2, 'set_pause'], [0.3, 'set_guardian'], [0.3, 'set_payout_config'], [0.3, 'admin_handover'], [0.3, 'follow_admin'],
      [0.4, 'legacy_pause'], [0.8, 'donate_lamports'], [0.6, 'donate_coins'], [0.6, 'holder_burn'], [0.8, 'holder_transfer'], [4, 'warp'], [4, 'bundle'], [0.1, 'init_launchpad'],
      [0.4, 'set_launch_approver'], [2.5, 'publish'], [0.4, 'clear'], [3, 'batch_launch'], [1.5, 'batch_warp'],
      [14, 'invalid'],
    ]);
    const one = (op, label = op.kind) => ({ label, ops: [op], ixs: op.ixs, signers: op.signers ?? (op.signer ? [op.signer] : []) });
    switch (action) {
      case 'buy': return one(this.buyOp(h));
      case 'sell': return one(this.sellOp(h));
      case 'buyback': if (r.chance(0.7)) w.warpSlots(r.chance(0.5) ? 150n : BigInt(r.int(400))); return { ...one(this.buybackOp(h)), opts: { feePayer: w.keeper } };
      case 'withdraw': return { ...one(this.withdrawOp(h)), opts: { feePayer: w.keeper } };
      case 'claim': return one(this.claimOp(h));
      case 'forward': return { ...one(this.forwardOp(h)), opts: { feePayer: w.keeper } };
      case 'payout':
        if (r.chance(0.5)) return this.payoutFlow(h);
        return one(this.payoutOp(h));
      case 'opt_in': {
        const founder = this.founders.get(h.coin); const lp = w.launchpad();
        const dest = r.chance(0.85) ? lp.payoutDestination : this.r.pick(this.traders).address;
        return one({ kind: 'opt_in', coin: h.coin, signer: founder, ixs: [w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: dest, refHash: metaHash(`ref${this.stats.steps}`) })] });
      }
      case 'revoke_opt_in': {
        const oiAcc = w.accountInfo(w.P.payoutOptIn(h.coin));
        const oi = oiAcc ? S.decodePayoutOptIn(oiAcc, { programId: w.programId }) : null;
        const by = r.chance(0.8) ? this.founders.get(h.coin) : r.pick(this.traders);
        return one({ kind: 'revoke_opt_in', coin: h.coin, signer: by, ixs: [w.ix.revokePayoutOptIn({ by: by.address, coin: h.coin, optInFounder: oi?.founder ?? by.address })] });
      }
      case 'transfer_founder': {
        const founder = this.founders.get(h.coin);
        const ap = w.signerOf(w.launchpad().launchApprover);
        const next = ap && r.chance(0.05) ? ap : r.chance(0.5) ? await w.signer(5n) : r.pick(this.traders);
        return one({ kind: 'transfer_founder', coin: h.coin, signer: founder, signers: [founder, next], newFounder: next.address, newSigner: next,
          ixs: [w.ix.transferFounder({ founder: founder.address, newFounder: next.address, coin: h.coin })] });
      }
      case 'approve': {
        if (this.coins.length + this.approvalsMade.length > 10) return this.nextPlan();
        const founder = await w.signer(30n);
        const cityId = r.chance(0.1) && this.coins.length ? r.pick(this.coins).cityId : this.nextCity++;
        const symbol = r.chance(0.08) && this.coins.length ? w.coinView(r.pick(this.coins)).symbol : this.symbol();
        const configId = r.chance(0.9) ? r.pick(this.configs) : w.launchpad().nextConfigId; // a config that does not exist
        const ttl = r.chance(0.3) ? BigInt(r.int(3_600)) : r.chance(0.05) ? 40n * DAY : BigInt(r.int(7 * 86_400));
        const lp = w.launchpad();
        const admin = w.signerOf(lp.admin);
        this.approvalsMade.push({ cityId, founder });
        return one({ kind: 'approve', signer: admin, cityId, founder,
          ixs: [w.ix.approveLaunch({ admin: admin.address, cityId, founder: founder.address, configId, name: `City ${cityId}`, symbol, metaHash: metaHash(`${cityId}`), expiresAt: w.now() + ttl })] });
      }
      case 'revoke_approval': {
        const pending = this.approvalsMade.filter((a) => w.approval(a.cityId));
        if (!pending.length) return this.nextPlan();
        const a = r.pick(pending); const ap = w.approval(a.cityId);
        const by = r.chance(0.5) ? w.signerOf(w.launchpad().admin) : r.pick(this.strangers);
        return one({ kind: 'revoke_approval', signer: by, ixs: [w.ix.revokeApproval({ by: by.address, cityId: a.cityId, rentPayer: ap.rentPayer })] });
      }
      case 'launch': {
        if (r.chance(0.5) && this.coins.length < 10) return this.launchFlow();
        const pending = this.approvalsMade.filter((a) => w.approval(a.cityId));
        if (!pending.length) return this.nextPlan();
        const a = r.pick(pending); const ap = w.approval(a.cityId);
        const founder = r.chance(0.9) ? a.founder : r.pick(this.traders);
        return one({ kind: 'launch', signer: founder, cityId: a.cityId, approvalFounder: a.founder,
          ixs: [w.ix.launch({ founder: founder.address, payer: founder.address, cityId: a.cityId, configId: ap.configId, symbol: ap.symbol, rentPayer: ap.rentPayer })] });
      }
      case 'add_config': {
        const lp = w.launchpad();
        if (lp.nextConfigId > 12) return this.nextPlan();
        let params = r.chance(0.5) ? this.derivedConfig(1_000_000_000n + r.below(50_000_000_000n), 4) : null;
        if (!params) params = { ...S.DEFAULT_CONFIG };
        if (r.chance(0.6)) {
          const k = r.pick(['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'launchFeeLamports']);
          params = { ...params, [k]: k.endsWith('Bps') ? BigInt(r.int(300)) : r.chance(0.5) ? params[k] + 1n : params[k] - 1n };
        }
        const admin = r.chance(0.95) ? w.signerOf(lp.admin) : r.pick(this.traders);
        return one({ kind: 'add_config', signer: admin, params, ixs: [w.ix.addLaunchConfig({ admin: admin.address, payer: w.payer.address, configId: lp.nextConfigId, params })], signers: [admin] });
      }
      case 'set_enabled': {
        const id = r.int(w.launchpad().nextConfigId);
        const admin = w.signerOf(w.launchpad().admin);
        return one({ kind: 'set_enabled', signer: admin, ixs: [w.ix.setLaunchConfigEnabled({ admin: admin.address, configId: id, enabled: r.chance(0.7) })] });
      }
      case 'set_pause': {
        const lp = w.launchpad();
        const who = r.weighted([[4, w.signerOf(lp.admin)], [2, w.signerOf(lp.guardian) ?? w.guardian], [1, w.signerOf(lp.payoutAuthority) ?? this.payoutKey], [1, r.pick(this.traders)], [0.5, w.signerOf(lp.launchApprover)]].filter(([, x]) => x));
        const v = () => (r.chance(0.5) ? null : r.chance(0.5));
        // the admin mostly clears: trading should not stay halted for long
        const flags = who.address === lp.admin && r.chance(0.6) ? { launches: false, payouts: false, buys: false, buybacks: false } : { launches: v(), payouts: v(), buys: v(), buybacks: v() };
        return one({ kind: 'set_pause', signer: who, flags, ixs: [w.ix.setPause({ authority: who.address, ...flags })] });
      }
      case 'set_guardian': {
        const admin = w.signerOf(w.launchpad().admin);
        const ap = w.launchpad().launchApprover;
        if (ap !== ZERO && r.chance(0.08)) return one({ kind: 'set_guardian', signer: admin, expect: 'ApproverHoldsRole', ixs: [w.ix.setGuardian({ admin: admin.address, guardian: ap })] });
        const g = r.chance(0.8) ? w.guardian : r.chance(0.5) ? await w.signer(1n) : { address: ZERO };
        return one({ kind: 'set_guardian', signer: admin, ixs: [w.ix.setGuardian({ admin: admin.address, guardian: g.address })] });
      }
      case 'set_payout_config': {
        const admin = w.signerOf(w.launchpad().admin);
        const ap = w.launchpad().launchApprover;
        if (ap !== ZERO && r.chance(0.08)) {
          const asKey = r.chance(0.5);
          return one({ kind: 'set_payout_config', signer: admin, expect: 'ApproverHoldsRole',
            ixs: [w.ix.setPayoutConfig({ admin: admin.address, payoutAuthority: asKey ? ap : this.payoutKey.address, payoutDestination: asKey ? this.payoutWallet.address : ap })] });
        }
        const off = r.chance(0.2);
        const key = off ? ZERO : r.chance(0.8) ? this.payoutKey.address : this.payoutKey2.address;
        const dest = off ? ZERO : r.chance(0.9) ? this.payoutWallet.address : r.pick([admin.address, S.ADDRESSES.feeRecipient, this.r.pick(this.traders).address]);
        return one({ kind: 'set_payout_config', signer: admin, ixs: [w.ix.setPayoutConfig({ admin: admin.address, payoutAuthority: key, payoutDestination: dest })] });
      }
      case 'admin_handover': {
        const lp = w.launchpad();
        const admin = w.signerOf(lp.admin);
        if (lp.pendingAdmin !== ZERO && w.signerOf(lp.pendingAdmin) && r.chance(0.7)) {
          const next = w.signerOf(lp.pendingAdmin);
          return one({ kind: 'accept_admin', signer: next, ixs: [w.ix.acceptAdmin({ newAdmin: next.address })] });
        }
        if (lp.launchApprover !== ZERO && r.chance(0.08)) return one({ kind: 'propose_admin', signer: admin, expect: 'ApproverHoldsRole', ixs: [w.ix.proposeAdmin({ admin: admin.address, newAdmin: lp.launchApprover })] });
        const next = r.chance(0.2) ? { address: ZERO } : await w.signer(5n);
        return one({ kind: 'propose_admin', signer: admin, ixs: [w.ix.proposeAdmin({ admin: admin.address, newAdmin: next.address })] });
      }
      case 'legacy_pause': {
        // the old program's launches opened or paused again by its admin (8.5): approvals and launches here
        // must then fail (the checker's I19 holds every successful one to it)
        const paused = r.chance(0.7);
        const oldAdmin = w.signerOf(w.legacyAdmins().admin) ?? w.admin;
        return { label: `legacy set_pause ${paused}`, ops: [{ kind: 'legacy', ixs: [] }],
          ixs: [w.legacyIx('set_pause', { launches: paused, payouts: null }, { authority: oldAdmin.address, launchpad: w.legacyPdas().launchpad })], signers: [oldAdmin] };
      }
      case 'follow_admin': {
        const steps = this.followPlans({ legacyAccept: r.chance(0.85), registryAccept: r.chance(0.85), rewardsAccept: r.chance(0.85) });
        return steps.length ? steps : this.nextPlan();
      }
      case 'donate_lamports': {
        const from = r.pick(this.traders.slice(0, 6));
        const spare = this.lamports(from.address) - this.rent0;
        if (spare < 2n) return this.nextPlan();
        const amount = 1n + r.below(spare < 5_000_000_000n ? spare : 5_000_000_000n);
        return { label: 'lamport donation', ops: [{ kind: 'donation' }], ixs: [systemTransfer(from.address, h.coin, amount)], signers: [from], opts: { lamportDonation: { coin: h.coin, amount } } };
      }
      case 'donate_coins': {
        const u = this.holderOf(h); const bal = w.balanceOf(u, h.mint);
        if (bal === 0n) return this.nextPlan();
        return { label: 'coin donation', ops: [{ kind: 'donation' }], ixs: [tokenTransfer(w.ata(u.address, h.mint), h.mint, h.vault, u.address, 1n + this.r.below(bal))], signers: [u], opts: { tokenDonation: true } };
      }
      case 'holder_burn': {
        const u = this.holderOf(h); const bal = w.balanceOf(u, h.mint);
        if (bal === 0n) return this.nextPlan();
        return { label: 'holder burn', ops: [{ kind: 'donation' }], ixs: [tokenBurn(w.ata(u.address, h.mint), h.mint, u.address, 1n + this.r.below(bal))], signers: [u], opts: { holderBurn: true } };
      }
      case 'holder_transfer': {
        const u = this.holderOf(h); const v = r.pick(this.traders); const bal = w.balanceOf(u, h.mint);
        if (bal === 0n || u.address === v.address) return this.nextPlan();
        w.addHolder(h.mint, v);
        return { label: 'holder transfer', ops: [{ kind: 'donation' }],
          ixs: [S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: v.address, mint: h.mint }), tokenTransfer(w.ata(u.address, h.mint), h.mint, w.ata(v.address, h.mint), u.address, 1n + this.r.below(bal))],
          signers: [u] };
      }
      case 'warp': {
        if (r.chance(0.7)) w.warpSlots(BigInt(1 + r.int(400))); else w.warpSecs(r.chance(0.3) ? DAY + BigInt(r.int(3_600)) : BigInt(r.int(20_000)));
        return null;
      }
      case 'bundle': {
        const ops = [];
        const n = 2 + r.int(3);
        for (let k = 0; k < n; k++) {
          const c = this.coinOf();
          const kind = r.weighted([[5, 'buy'], [4, 'sell'], [2, 'buyback'], [1, 'withdraw'], [1, 'claim']]);
          const op = kind === 'buy' ? this.buyOp(c) : kind === 'sell' ? this.sellOp(c) : kind === 'buyback' ? this.buybackOp(c) : kind === 'withdraw' ? this.withdrawOp(c) : this.claimOp(c);
          // inside one transaction a user's token account must exist up front for a sell, and a buy creates it at most once
          if (op.kind === 'buy' && op.missing && ops.some((o) => o.kind === 'buy' && o.user === op.user && o.mint === op.mint)) op.ixs = op.ixs.slice(-1);
          ops.push(op);
        }
        const signers = []; const seen = new Set();
        for (const o of ops) for (const s of o.signers ?? (o.signer ? [o.signer] : [])) if (!seen.has(String(s.address))) { seen.add(String(s.address)); signers.push(s); }
        if (signers.length > 6) return this.nextPlan();
        return { label: `bundle ${ops.map((o) => o.kind).join('+')}`, ops, ixs: ops.flatMap((o) => o.ixs), signers };
      }
      case 'set_launch_approver': return one(await this.setApproverPlan());
      case 'publish': return one(await this.publishPlan());
      case 'clear': return one(this.clearPlan());
      case 'batch_launch': { const op = this.batchLaunchPlan(); return op ? one(op) : this.nextPlan(); }
      case 'batch_warp': this.batchWarp(); return null;
      case 'init_launchpad':
        return one({ kind: 'init_launchpad', ixs: [w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })], signers: [w.admin, w.deployer] });
      case 'invalid': return this.invalidPlan(h);
      default: throw new Error(action);
    }
  }

  /** F02: a valid instruction with one account replaced, or its authority replaced by another signer. */
  async invalidPlan(h) {
    const w = this.w; const r = this.r;
    const lp = w.launchpad();
    const admin = w.signerOf(lp.admin);
    const founder = this.founders.get(h.coin);
    const pending = this.approvalsMade.filter((a) => w.approval(a.cityId));
    const bases = [
      () => this.buyOp(h), () => this.sellOp(h), () => this.buybackOp(h), () => this.withdrawOp(h), () => this.claimOp(h), () => this.forwardOp(h), () => this.payoutOp(h),
      () => ({ kind: 'opt_in', signer: founder, ixs: [w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: lp.payoutDestination, refHash: metaHash('x') })] }),
      () => ({ kind: 'transfer_founder', signer: founder, signers: [founder, this.traders[0]], ixs: [w.ix.transferFounder({ founder: founder.address, newFounder: this.traders[0].address, coin: h.coin })] }),
      () => ({ kind: 'set_pause', signer: admin, ixs: [w.ix.setPause({ authority: admin.address, buys: false, buybacks: false })] }),
      () => ({ kind: 'set_guardian', signer: admin, ixs: [w.ix.setGuardian({ admin: admin.address, guardian: w.guardian.address })] }),
      () => ({ kind: 'add_config', signer: admin, ixs: [w.ix.addLaunchConfig({ admin: admin.address, payer: w.payer.address, configId: lp.nextConfigId, params: S.DEFAULT_CONFIG })] }),
      () => ({ kind: 'set_enabled', signer: admin, ixs: [w.ix.setLaunchConfigEnabled({ admin: admin.address, configId: 0, enabled: true })] }),
      () => ({ kind: 'approve', signer: admin, ixs: [w.ix.approveLaunch({ admin: admin.address, cityId: this.nextCity + 500n, founder: founder.address, configId: 0, name: 'X', symbol: this.symbol(), metaHash: metaHash('x'), expiresAt: w.now() + DAY })] }),
    ];
    if (pending.length) {
      const a = r.pick(pending); const ap = w.approval(a.cityId);
      bases.push(() => ({ kind: 'launch', signer: a.founder, ixs: [w.ix.launch({ founder: a.founder.address, payer: a.founder.address, cityId: a.cityId, configId: ap.configId, symbol: ap.symbol, rentPayer: ap.rentPayer })] }));
      bases.push(() => ({ kind: 'revoke_approval', signer: admin, ixs: [w.ix.revokeApproval({ by: admin.address, cityId: a.cityId, rentPayer: ap.rentPayer })] }));
    }
    // the batch launch approval's instructions (4.23 to 4.27)
    const ap = w.signerOf(lp.launchApprover);
    if (ap && !this.bm.halted) {
      bases.push(() => { const f = w.now() + S.BATCH_REVIEW_SECS + 600n; return { kind: 'publish', signer: ap, ixs: [w.ix.publishLaunchBatch({ approver: ap.address, seq: this.bm.latest.seq + 1n, root: metaHash(`f02 ${this.stats.steps}`), leafCount: 3, validFrom: f, validUntil: f + DAY })] }; });
    }
    bases.push(() => ({ kind: 'clear', signer: admin, ixs: [w.ix.clearLaunchBatch({ authority: admin.address, halt: false })] }));
    bases.push(() => ({ kind: 'set_launch_approver', signer: admin, ixs: [w.ix.setLaunchApprover({ admin: admin.address, approver: this.approverKeys[0].address })] }));
    const inForce = this.batchCandidates().filter((c) => S.batchRefusal(this.bm, lp, c.seq, w.now()) === null);
    if (inForce.length) {
      const c = r.pick(inForce); const a = S.launchBatchArgs(c.built, c.e.cityId); const f = c.built.founders.get(c.e.cityId);
      bases.push(() => ({ kind: 'batch_launch', signer: f, ixs: [w.ix.launchFromBatch({ ...a, founder: f.address, payer: f.address })] }));
    }
    const base = r.pick(bases)();
    const ixIndex = base.ixs.length - 1 - (base.kind === 'forward' ? 1 : 0); // the vicinity_curve instruction (forward is followed by SyncNative)
    const ix = base.ixs[ixIndex];
    const name = Object.entries(S.INSTRUCTION_DISCRIMINATORS).find(([, d]) => d.every((x, i) => ix.data[i] === x))[0];
    const table = S.ACCOUNT_TABLES[name];
    const signers = base.signers ?? (base.signer ? [base.signer] : []);
    // a wrong signer for an instruction with one authority, or a replaced non-signer account
    if (AUTHORITY[name] && r.chance(0.3)) {
      const slot = table.findIndex(([n]) => n === AUTHORITY[name]);
      const authorised = new Set([lp.admin, lp.pendingAdmin, lp.payoutAuthority, lp.launchApprover, w.coinView(h).founder].filter((k) => k !== ZERO));
      if (name === 'clear_launch_batch' && lp.guardian !== ZERO) authorised.add(lp.guardian); // the guardian may clear too
      const other = r.pick([...this.traders, ...this.strangers, w.guardian, w.keeper].filter((s) => !authorised.has(String(s.address)) && s.address !== ix.accounts[slot].address));
      const ixs = base.ixs.map((x, i) => (i !== ixIndex ? x : { ...x, accounts: x.accounts.map((a, j) => (j === slot ? { ...a, address: String(other.address) } : a)) }));
      return { label: `F02 ${name}: ${AUTHORITY[name]} replaced by another signer`, ops: [{ kind: 'invalid' }], ixs, signers: [...signers.filter((s) => s.address !== other.address), other], invalid: { name, slot: AUTHORITY[name] } };
    }
    const slots = table.map(([n, role], i) => ({ n, role, i })).filter((s) => s.role !== S.Role.RS && s.role !== S.Role.WS);
    const s = r.pick(slots);
    const candidates = this.candidates(h).filter((c) => c !== ix.accounts[s.i].address);
    const sub = r.pick(candidates);
    const ixs = base.ixs.map((x, i) => (i !== ixIndex ? x : { ...x, accounts: x.accounts.map((a, j) => (j === s.i ? { ...a, address: sub } : a)) }));
    return { label: `F02 ${name}: ${s.n} -> ${sub.slice(0, 8)}`, ops: [{ kind: 'invalid' }], ixs, signers, invalid: { name, slot: s.n, sub, base } };
  }

  /** Plausible wrong accounts: everything a confused or hostile client could name. */
  candidates(h) {
    const w = this.w;
    if (!this._fixed) {
      const P = w.P;
      this._fixed = [
        P.launchpad(), P.launchBatch(), P.eventAuthority(), P.programData(), w.programId, S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram, S.CLUSTERS.mainnet.legacyLaunchpad,
        S.CLUSTERS.devnet.rewardsProgram, S.CLUSTERS.devnet.legacyLaunchpad, S.CLUSTERS.mainnet.rewardsRegistry, S.CLUSTERS.devnet.rewardsRegistry, S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.token2022, S.ADDRESSES.associatedToken, S.ADDRESSES.metaplex,
        S.ADDRESSES.nativeMint, S.ADDRESSES.feeRecipient, S.ADDRESSES.rentSysvar, 'SysvarC1ock11111111111111111111111111111111', S.ADDRESSES.computeBudget,
        new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      ];
    }
    const out = [...this._fixed];
    for (const c of this.coins) {
      out.push(c.coin, c.mint, c.vault, w.P.payoutOptIn(c.coin), S.metadataAddress(c.mint), w.P.rewardsAccounts(c.mint).config, w.P.rewardsAccounts(c.mint).vault, w.P.legacyCoin(c.cityId));
    }
    for (const id of this.configs) out.push(w.P.config(id));
    // the batch path's slots: another city's approval PDA, a batch city's (F02 of 12.5)
    for (const c of this.coins.slice(0, 4)) out.push(w.P.approval(c.cityId));
    for (const { e } of this.batchCandidates().slice(0, 4)) out.push(w.P.approval(e.cityId), w.P.coin(e.cityId));
    // role keys themselves (system accounts), but token accounts only of traders and the payout wallet: a buy
    // may deliver to any token account of the mint (FREE_SLOTS), and the checker refuses deliveries to role keys (I21)
    for (const u of [w.admin, w.guardian, this.payoutKey]) out.push(String(u.address));
    for (const u of [...this.traders.slice(0, 3), this.payoutWallet]) {
      out.push(String(u.address), w.ata(u.address, h.mint), w.ata(u.address, this.r.pick(this.coins).mint));
    }
    out.push(w.ata(h.coin, h.mint), w.ata(h.vault, h.mint));
    return [...new Set(out.map(String))];
  }

  // ------------------------------------------------------------------ running
  async step() {
    const w = this.w;
    this.stats.steps++;
    if (this.stats.steps % 2_000 === 0) for (const s of [w.payer, w.keeper, ...this.traders.slice(0, 6)]) w.svm.airdrop(s.address, 10_000n * LAMPORTS);
    const plan = this.queue?.length ? this.queue.shift() : await this.nextPlan();
    if (!plan) return;
    if (Array.isArray(plan)) { this.queue = plan.slice(1); return this.execute(plan[0]); }
    return this.execute(plan);
  }

  async execute(plan) {
    const w = this.w;
    if (typeof plan === 'function') { plan = await plan(); if (!plan) return; }
    const act = plan.invalid ? 'invalid' : plan.ops.length > 1 ? 'bundle' : plan.ops[0].kind;
    const st = this.stats.byAction[act] ?? (this.stats.byAction[act] = { ok: 0, fail: 0 });
    // the model's prediction, on a copy
    const m = new Map([...this.model].map(([k, v]) => [k, clone(v)]));
    const ctx = { lp: w.launchpad(), bm: clone(this.bm), lam: new Map(), tok: new Map(), created: new Set(), ataMissing: new Set(plan.ops.filter((o) => o.missing).map((o) => `${o.user}:${o.mint}`)) };
    let predicted = { ok: true }; let anyOutcome = false;
    if (!plan.invalid) {
      for (const op of plan.ops) {
        if (op.kind === 'donation') continue;
        const p = this.predict(m, op, ctx);
        if (p.any) { anyOutcome = true; continue; }
        if (p.fail) { predicted = { ...p, op: describe(op) }; break; }
      }
      // the runtime's rent rule applies to each account's balance at the end of the transaction: a rent-exempt or
      // empty system account may not end holding lamports below the rent-exempt minimum
      if (!predicted.fail) {
        for (const [a, end] of ctx.lam) {
          const start = this.lamports(a);
          if (end > 0n && end < this.rent0 && (start === 0n || start >= this.rent0 || end > start)) { predicted = { fail: true, err: null, op: a, why: `ends at ${end} lamports from ${start}` }; break; }
        }
      }
    }
    let res; let err;
    try { res = await w.send(plan.ixs, plan.signers, `step ${this.stats.steps}: ${plan.label}`, plan.opts ?? {}); } catch (e) {
      // an invalid variant the client library refuses to build (a program id marked writable, ...) never reaches the chain
      if (plan.invalid && !(e instanceof TxError) && /writable|signer|signature/i.test(String(e.message))) { this.stats.invalid++; this.stats.invalidUnbuildable = (this.stats.invalidUnbuildable ?? 0) + 1; return; }
      if (!(e instanceof TxError)) throw e;
      err = e;
    }
    this.stats.txs++;
    if (err) {
      this.stats.failed++; st.fail++;
      this.compareBatch(plan.label);
      if (plan.invalid) { this.stats.invalid++; this.stats.invalidRefused++; return; }
      if (predicted.fail) {
        this.stats.predictedFail++;
        if (predicted.err) assert.ok(errorIn(err, predicted.err), `step ${this.stats.steps} ${plan.label}: the model expected ${predicted.err}, the program said:\n${err.message}`);
        return;
      }
      if (anyOutcome) return;
      assert.fail(`step ${this.stats.steps} ${plan.label}: the model expected success, the program refused:\n${err.message}`);
    }
    this.stats.ok++; st.ok++;
    if (plan.invalid) {
      this.compareBatch(plan.label);
      this.stats.invalid++;
      // Anchor's #[event_cpi] `program` account is read only by the event self-CPI, which fails without it; an
      // instruction that emits nothing (a payout or crank with nothing to do) accepts any account there and changes
      // nothing (the checker has verified that no balance and no account of the program moved)
      if (plan.invalid.slot === 'program' && res.events.length === 0) { this.stats.noopProgramSlot = (this.stats.noopProgramSlot ?? 0) + 1; return; }
      const free = FREE_SLOTS[plan.invalid.name]?.has(plan.invalid.slot);
      assert.ok(free, `F02 step ${this.stats.steps}: ${plan.label} was accepted (slot ${plan.invalid.slot} of ${plan.invalid.name} replaced by ${plan.invalid.sub ?? 'another signer'})`);
      this.stats.freeAccepted++;
      // re-sync the model with what a legitimate variant did (a withdrawal of another coin, a buy delivered elsewhere)
      this.resync(res);
      return;
    }
    assert.ok(!predicted.fail, `step ${this.stats.steps} ${plan.label}: the model expected ${predicted.err ?? 'a failure'} of ${predicted.op} (${predicted.why ?? ''}), the program accepted it`);
    // apply to the model and compare every coin the transaction touched, byte for byte
    if (anyOutcome) this.afterAny(plan, res); else for (const [k, v] of m) this.model.set(k, v);
    this.bm = ctx.bm;
    for (const op of plan.ops) {
      if (op.kind === 'publish') {
        this.batches.set(op.seq, op.built);
        for (const k of [...this.batches.keys()]) if (k + 3n < op.seq) this.batches.delete(k);
      }
      if (op.kind === 'batch_launch') { const c = w.P.coin(op.cityId); this.registerLaunch(c, op.signer); this.pendingRewards = c; }
      if (op.kind === 'buy' && op.holder) w.addHolder(op.mint, op.holder);
      if (op.kind === 'transfer_founder') this.founders.set(op.coin, op.newSigner);
      if (op.kind === 'accept_admin') {
        w.admin = op.signer;
        // the admin's other seats follow it (4.2, 8.2, 8.5), mostly at once, sometimes later (follow_admin)
        if (this.r.chance(0.8)) this.queue = [...(this.queue ?? []), ...this.followPlans()];
      }
    }
    this.compare(res);
    this.compareBatch(plan.label);
  }

  /** LaunchBatch's 260 bytes against the model's (F01 for the batch path). */
  compareBatch(label) {
    const w = this.w;
    const raw = Buffer.from(w.accountInfo(w.P.launchBatch()).data);
    const want = encodeLaunchBatch(this.batchRaw, this.bm);
    if (!want.equals(raw)) {
      const show = (b) => JSON.stringify(b, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      assert.fail(`F01 step ${this.stats.steps} ${label}: LaunchBatch differs from the model\nchain ${show(w.launchBatch())}\nmodel ${show(this.bm)}`);
    }
  }

  /** After an instruction the model does not predict (settings, approvals, launches): adopt what the chain did. */
  afterAny(plan, res) {
    const w = this.w;
    for (const op of plan.ops) {
      if (op.kind === 'launch') {
        const c = w.P.coin(op.cityId);
        this.registerLaunch(c, op.signer);
        this.approvalsMade = this.approvalsMade.filter((a) => a.cityId !== op.cityId);
        this.pendingRewards = c;
      }
      if (op.kind === 'transfer_founder') this.model.get(op.coin).ext.founder = op.newFounder;
    }
    void res;
  }

  /** A legitimate "invalid" variant succeeded: take the coin states from the chain (the checker has verified them). */
  resync(res) {
    for (const e of res.events) {
      const h = this.coins.find((c) => c.cityId === e.data.city_id);
      if (!h) continue;
      const c = this.w.coinView(h);
      const mdl = this.model.get(h.coin);
      mdl.st = S.coinState(c);
      for (const k of Object.keys(mdl.ext)) mdl.ext[k] = c[k];
      if (e.name === 'FounderTransferred') this.founders.set(h.coin, this.w.signerOf(c.founder));
    }
  }

  compare(res) {
    const w = this.w;
    const touched = new Set(res.top.flatMap((t) => t.accounts));
    for (const h of this.coins) {
      if (!touched.has(h.coin)) continue;
      const mdl = this.model.get(h.coin);
      const raw = w.accountInfo(h.coin).data;
      const want = encodeCoin(mdl.raw, mdl.st, mdl.ext);
      if (!want.equals(raw)) {
        const c = w.coinView(h); const got = S.coinState(c);
        const diff = S.STATE_KEYS.filter((k) => got[k] !== mdl.st[k]).map((k) => `${k}: chain ${got[k]} model ${mdl.st[k]}`);
        const extDiff = Object.keys(mdl.ext).filter((k) => c[k] !== mdl.ext[k]).map((k) => `${k}: chain ${c[k]} model ${mdl.ext[k]}`);
        assert.fail(`F01 step ${this.stats.steps}: the Coin ${c.symbol} differs from the model: ${[...diff, ...extDiff].join('; ')}`);
      }
    }
  }

  async run(steps) {
    for (let i = 0; i < steps; i++) {
      await this.step();
      if (this.pendingRewards) {
        const c = this.pendingRewards; this.pendingRewards = null;
        const h = this.coins.find((x) => x.coin === c);
        if (this.r.chance(0.8)) await this.initRewards(h, this.r.chance(0.9));
      }
      if (this.o.probeEvery && this.stats.steps % this.o.probeEvery === 0) await this.w.probe(`fuzz step ${this.stats.steps}`);
      if (this.o.log && this.stats.steps % 1_000 === 0) console.log(`fuzz seed ${this.o.seed}: ${this.stats.steps} steps, ${JSON.stringify(this.summary())}`);
    }
    await this.w.probe('end of fuzz');
    return this.summary();
  }

  summary() {
    const { byAction, ...rest } = this.stats;
    return { ...rest, coins: this.coins.length, graduated: this.coins.filter((h) => this.w.coinView(h).phase === 1).length, byAction };
  }
}

const describe = (op) => JSON.stringify(Object.fromEntries(Object.entries(op).filter(([k]) => !['ixs', 'h', 'signer', 'signers', 'holder', 'newSigner', 'params', 'built', 'proof', 'root'].includes(k))), (k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** `LaunchBatch` (3.11) written from the model over the account's first bytes (discriminator, bump, reserved). */
export function encodeLaunchBatch(raw, bm) {
  const out = Buffer.from(raw);
  out[9] = bm.halted ? 1 : 0;
  const rec = (x, at) => {
    out.writeBigUInt64LE(BigInt(x.seq), at); Buffer.from(x.root).copy(out, at + 8); out.writeUInt32LE(Number(x.leafCount), at + 40);
    out.writeBigInt64LE(BigInt(x.validFrom), at + 44); out.writeBigInt64LE(BigInt(x.validUntil), at + 52); out.writeBigInt64LE(BigInt(x.publishedAt), at + 60);
    out.writeBigUInt64LE(BigInt(x.publishedSlot), at + 68); new PublicKey(x.publisher).toBuffer().copy(out, at + 76); out[at + 108] = x.cleared ? 1 : 0;
  };
  rec(bm.latest, 10); rec(bm.previous, 119);
  return out;
}

/** pause_allowed of the program (helpers.rs), for the model. */
function pauseAllowed(signer, lp, { launches, payouts, buys, buybacks }) {
  if (signer === lp.admin) return true;
  const asPayout = lp.payoutAuthority !== ZERO && signer === lp.payoutAuthority && launches == null && payouts === true && buys == null && buybacks == null;
  const onlyTrue = (v) => v == null || v === true;
  const asGuardian = lp.guardian !== ZERO && signer === lp.guardian && payouts == null && onlyTrue(launches) && onlyTrue(buys) && onlyTrue(buybacks)
    && (launches != null || buys != null || buybacks != null);
  return asPayout || asGuardian;
}

export function systemTransfer(from, to, lamports) {
  const d = Buffer.alloc(12); d.writeUInt32LE(2, 0); d.writeBigUInt64LE(BigInt(lamports), 4);
  return { programAddress: S.ADDRESSES.system, accounts: [{ address: String(from), role: S.Role.WS }, { address: String(to), role: S.Role.W }], data: new Uint8Array(d) };
}
export function tokenTransfer(src, mint, dst, owner, amount) {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(BigInt(amount), 1); d[9] = 6;
  return { programAddress: S.ADDRESSES.token, accounts: [{ address: src, role: S.Role.W }, { address: mint, role: S.Role.R }, { address: dst, role: S.Role.W }, { address: String(owner), role: S.Role.RS }], data: new Uint8Array(d) };
}
export function tokenBurn(acc, mint, owner, amount) {
  const d = Buffer.alloc(9); d[0] = 8; d.writeBigUInt64LE(BigInt(amount), 1);
  return { programAddress: S.ADDRESSES.token, accounts: [{ address: acc, role: S.Role.W }, { address: mint, role: S.Role.W }, { address: String(owner), role: S.Role.RS }], data: new Uint8Array(d) };
}
export { generateKeyPairSigner };
