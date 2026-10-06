// The Vicinity keeper ("crank"): graduation and the daily fee run
// (LAUNCHPAD-DESIGN.md 10.2 and 12.1).
//
// Everything here is permissionless. The keeper wallet only pays network fees
// and rent; it signs nothing else, receives nothing and has no power over any
// money. Anyone (including Meteora's own keepers) may do the same steps; the
// keeper exists so that Vicinity's coins never wait for someone else.
//
// One pass:
//   1. read every `Coin` of our program and the Meteora and rewards accounts
//      it depends on (through a `reader`, so the same code runs against a real
//      RPC node and against the in-process test VM);
//   2. plan, per coin:
//        migrate          the curve is complete and not yet graduated
//        withdrawLeftover graduated and the unsold dust is still in DBC
//                         (it can only go to the dev wallet)
//        harvestCurve     the city has curve fees waiting, or its share of
//                         the completion surplus
//        harvestPool      graduated: the city's DAMM v2 position (daily pass)
//        forward          the holders pot has (or will have) money and the
//                         city's rewards config passes the program's checks;
//                         otherwise the coin is reported, never sent, so one
//                         bad coin cannot make a batch fail;
//   3. pack the steps into transactions that fit Solana's 1,232-byte limit.
//
// The minute pass (daily = false) does steps that should not wait:
// graduation, the leftover and the surplus. The daily pass does everything.
import anchor from '@coral-xyz/anchor';
import web3 from '@solana/web3.js';
import * as C from './client.mjs';
import { IDL, decodeAccount } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, damm, pdas, rewardsPdas } from './pda.mjs';
import { surplusShares } from './curve.mjs';

const { PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram } = web3;
const bs58 = anchor.utils.bytes.bs58;
const big = (x) => BigInt(x.toString());

/** DBC `migration_progress` values (state/virtual_pool.rs). */
export const MigrationProgress = Object.freeze({ PreBondingCurve: 0, PostBondingCurve: 1, LockedVesting: 2, CreatedPool: 3 });
/** Solana's packet limit for one transaction. */
export const MAX_TX_BYTES = 1232;
/** Compute budgets (measured in tests-launchpad, with headroom). */
export const CU = Object.freeze({ migrate: 400_000, harvestCurve: 110_000, harvestPool: 110_000, forward: 40_000, leftover: 60_000, perTx: 1_200_000 });

// ---------------------------------------------------------------- readers
/**
 * A reader over a @solana/web3.js `Connection` (what scripts/launchpad/crank.mjs uses).
 * Both readers return accounts as { address, owner, lamports, data: Buffer }.
 */
export function connectionReader(connection, { commitment = 'confirmed' } = {}) {
  return {
    async getProgramAccounts(programId, { memcmp = [], dataSize } = {}) {
      const filters = memcmp.map(({ offset, bytes }) => ({ memcmp: { offset, bytes: typeof bytes === 'string' ? bytes : bs58.encode(Buffer.from(bytes)) } }));
      if (dataSize !== undefined) filters.push({ dataSize });
      const res = await connection.getProgramAccounts(new PublicKey(programId), { commitment, filters });
      return res.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), owner: account.owner.toBase58(), lamports: BigInt(account.lamports), data: Buffer.from(account.data) }));
    },
    async getMultipleAccounts(addresses) {
      const out = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), commitment);
        infos.forEach((acc, j) => out.push(acc ? { address: chunk[j], owner: acc.owner.toBase58(), lamports: BigInt(acc.lamports), data: Buffer.from(acc.data) } : null));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- state
const accountDiscriminator = (idl, name) => Buffer.from(idl.accounts.find((a) => a.name === name).discriminator);
const keyAt = (data, at) => new PublicKey(data.subarray(at, at + 32)).toBase58();
const u64At = (data, at) => data.readBigUInt64LE(at);

/** Mirror of the program's `check_rewards_config` plus the vault checks Anchor runs in `forward_holders_fees`. */
export function checkRewardsConfig(coin, cfgAccount, vaultAccount, rewardsProgram = PROGRAM_IDS.rewards) {
  if (!cfgAccount) return 'no rewards config yet (vicinity_rewards init_city has not run for this coin)';
  if (cfgAccount.owner !== rewardsProgram) return 'rewards config is not owned by vicinity_rewards';
  let c;
  try { c = decodeAccount(IDL.rewards, 'CityConfig', cfgAccount.data); } catch { return 'rewards config is not a vicinity_rewards CityConfig'; }
  const R = rewardsPdas(rewardsProgram);
  if (c.city_coin_mint.toBase58() !== coin.mint) return 'rewards config belongs to another coin';
  if (!('Holders' in c.reward_model || 'holders' in c.reward_model) || c.founder_bps !== 0) return 'rewards config is not Holders-only with a 0% founder share (forward refuses it; the pot keeps collecting)';
  if (c.reward_mint.toBase58() !== coin.quoteMint) return 'rewards config pays in another token than the coin\'s quote token';
  if (c.vault.toBase58() !== R.vault(R.city(coin.mint))) return 'rewards config names another vault';
  if (!vaultAccount || vaultAccount.owner !== PROGRAM_IDS.token) return 'rewards vault missing';
  if (keyAt(vaultAccount.data, 0) !== coin.quoteMint || keyAt(vaultAccount.data, 32) !== R.city(coin.mint)) return 'rewards vault has the wrong mint or owner';
  return null;
}

/**
 * Read every Vicinity coin and what the keeper needs to know about it.
 * Coins come only from our program's `Coin` accounts (the registry), so pools
 * created around our program under the Vicinity config are never touched.
 */
export async function loadState(reader, { launchpadProgram = PROGRAM_IDS.launchpad, rewardsProgram = PROGRAM_IDS.rewards } = {}) {
  const P = pdas(launchpadProgram);
  const R = rewardsPdas(rewardsProgram);
  const raw = await reader.getProgramAccounts(launchpadProgram, { memcmp: [{ offset: 0, bytes: accountDiscriminator(IDL.launchpad, 'Coin') }] });
  const coins = raw.map((a) => {
    const d = decodeAccount(IDL.launchpad, 'Coin', a.data);
    return {
      address: a.address, cityId: big(d.city_id), founder: d.founder.toBase58(), mint: d.mint.toBase58(), quoteMint: d.quote_mint.toBase58(),
      dbcConfig: d.dbc_config.toBase58(), dbcPool: d.dbc_pool.toBase58(), holdersPot: P.holdersPot(a.address), founderVault: P.founderVault(a.address),
    };
  }).sort((x, y) => (x.cityId < y.cityId ? -1 : x.cityId > y.cityId ? 1 : 0));

  const configs = [...new Set(coins.map((c) => c.dbcConfig))];
  const want = [
    ...coins.map((c) => c.dbcPool), ...configs, ...coins.map((c) => c.holdersPot),
    ...coins.map((c) => R.city(c.mint)), ...coins.map((c) => R.vault(R.city(c.mint))),
  ];
  const got = await reader.getMultipleAccounts(want);
  const byAddr = new Map(want.map((a, i) => [a, got[i]]));
  const cfgByAddr = new Map(configs.map((a) => {
    const c = decodeAccount(IDL.dbc, 'PoolConfig', byAddr.get(a).data);
    return [a, { migrationQuoteThreshold: big(c.migration_quote_threshold), creatorTradingFeePercentage: BigInt(c.creator_trading_fee_percentage) }];
  }));

  for (const c of coins) {
    const ps = decodeAccount(IDL.dbc, 'VirtualPool', byAddr.get(c.dbcPool).data).pool_state;
    c.pool = {
      quoteReserve: big(ps.quote_reserve), creatorQuoteFee: big(ps.creator_quote_fee), isMigrated: ps.is_migrated,
      migrationProgress: ps.migration_progress, isWithdrawLeftover: ps.is_withdraw_leftover, isCreatorWithdrawSurplus: ps.is_creator_withdraw_surplus,
    };
    c.config = cfgByAddr.get(c.dbcConfig);
    c.complete = c.pool.quoteReserve >= c.config.migrationQuoteThreshold;
    c.creatorSurplus = surplusShares(c.pool.quoteReserve, c.config.migrationQuoteThreshold, c.config.creatorTradingFeePercentage).creator;
    const pot = byAddr.get(c.holdersPot);
    c.potBalance = pot ? u64At(pot.data, 64) : 0n;
    c.rewardsProblem = checkRewardsConfig(c, byAddr.get(R.city(c.mint)), byAddr.get(R.vault(R.city(c.mint))), rewardsProgram);
    c.positions = c.pool.isMigrated ? await findCityPositions(reader, c) : [];
  }
  return { coins, launchpadProgram, rewardsProgram };
}

/**
 * The DAMM v2 positions the city owns: Token-2022 accounts held by the Coin
 * PDA with exactly one position NFT, whose position is in a pool of this
 * coin's pair. Found by owner, so it works whoever ran the graduation and
 * whatever NFT mints they used.
 */
export async function findCityPositions(reader, coin) {
  const nftAccounts = await reader.getProgramAccounts(PROGRAM_IDS.token2022, { memcmp: [{ offset: 32, bytes: new PublicKey(coin.address).toBytes() }] });
  const held = nftAccounts.filter((a) => a.data.length >= 165 && a.data[108] === 1 && u64At(a.data, 64) === 1n)
    .map((a) => ({ nftAccount: a.address, nftMint: keyAt(a.data, 0) }));
  if (held.length === 0) return [];
  const positions = await reader.getMultipleAccounts(held.map((h) => damm.position(h.nftMint)));
  const out = [];
  for (let i = 0; i < held.length; i++) {
    const p = positions[i];
    if (!p || p.owner !== PROGRAM_IDS.damm) continue;
    const pos = decodeAccount(IDL.damm, 'Position', p.data);
    if (pos.nft_mint.toBase58() !== held[i].nftMint) continue;
    const [poolAcc] = await reader.getMultipleAccounts([pos.pool.toBase58()]);
    if (!poolAcc || poolAcc.owner !== PROGRAM_IDS.damm) continue;
    const pool = decodeAccount(IDL.damm, 'Pool', poolAcc.data);
    if (pool.token_a_mint.toBase58() !== coin.mint || pool.token_b_mint.toBase58() !== coin.quoteMint) continue;
    out.push({ ...held[i], position: damm.position(held[i].nftMint), pool: pos.pool.toBase58() });
  }
  return out;
}

// ---------------------------------------------------------------- plan
/**
 * Decide what to do. Returns { steps, notes }: `steps` in execution order,
 * `notes` explain coins that need a person (for example a missing rewards config).
 */
export function planKeeper(state, { daily = true } = {}) {
  const steps = [];
  const notes = [];
  for (const c of state.coins) {
    const p = c.pool;
    if (c.complete && !p.isMigrated) {
      if (p.migrationProgress === MigrationProgress.LockedVesting) steps.push({ kind: 'migrate', coin: c });
      else notes.push({ cityId: c.cityId, note: `curve complete but migration progress is ${p.migrationProgress} (expected 2); Vicinity configs have no locked vesting, so this needs a look` });
    }
    const migratedOrMigrating = p.isMigrated || (c.complete && p.migrationProgress === MigrationProgress.LockedVesting);
    if (migratedOrMigrating && !p.isWithdrawLeftover) steps.push({ kind: 'withdrawLeftover', coin: c });
    const curveDue = p.creatorQuoteFee > 0n || (c.complete && !p.isCreatorWithdrawSurplus && c.creatorSurplus > 0n);
    const fee = [];
    if (curveDue && (daily || c.complete)) fee.push({ kind: 'harvestCurve', coin: c });
    if (daily) for (const pos of c.positions) fee.push({ kind: 'harvestPool', coin: c, position: pos });
    const potWillHaveMoney = c.potBalance > 0n || fee.length > 0;
    if (potWillHaveMoney && (daily || fee.length > 0)) {
      if (c.rewardsProblem) notes.push({ cityId: c.cityId, note: `holders pot not forwarded: ${c.rewardsProblem}` });
      else fee.push({ kind: 'forward', coin: c });
    }
    steps.push(...fee);
  }
  return { steps, notes };
}

// ---------------------------------------------------------------- transactions
/** @solana/kit-shaped instruction -> web3.js TransactionInstruction. */
export function toWeb3Instruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: (a.role & 2) !== 0, isWritable: (a.role & 1) !== 0 })),
    data: Buffer.from(ix.data),
  });
}
/**
 * Exact wire size of a v0 transaction (no lookup tables) with these
 * instructions, a compute-limit instruction and every signature; Infinity when
 * it cannot be encoded at all (web3.js refuses anything over the packet size).
 */
export function transactionSize(ixs, payer) {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ...ixs.map(toWeb3Instruction)];
  try {
    const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
    return new VersionedTransaction(msg).serialize().length;
  } catch (e) {
    if (e instanceof RangeError) return Infinity;
    throw e;
  }
}

function stepInstructions(step, payer) {
  const c = step.coin;
  switch (step.kind) {
    case 'withdrawLeftover':
      return [
        C.createAtaIdempotent({ payer, owner: ADDRESSES.feeRecipient, mint: c.mint }),
        C.withdrawLeftover({ dbcPool: c.dbcPool, dbcConfig: c.dbcConfig, coinMint: c.mint, receiverAccount: ata(ADDRESSES.feeRecipient, c.mint) }),
      ];
    case 'harvestCurve':
      return [C.harvestCurveFees({ payer, coin: c })];
    case 'harvestPool':
      return [C.harvestPoolFees({ payer, coin: c, dammPool: step.position.pool, positionNftMint: step.position.nftMint, overrides: { position_nft_account: step.position.nftAccount } })];
    case 'forward':
      return [C.forwardHoldersFees({ coin: c })];
    default:
      throw new Error(`no instructions for ${step.kind}`);
  }
}
const stepCu = { withdrawLeftover: CU.leftover, harvestCurve: CU.harvestCurve, harvestPool: CU.harvestPool, forward: CU.forward };

/**
 * Turn a plan into transactions. Each graduation is its own transaction (two
 * fresh position-NFT keypairs from `newSigner()` sign it) and goes first.
 * Every other step is packed in plan order while the transaction stays within
 * `maxBytes` and the compute budget. Order is never changed, and transactions
 * are sent one after another, so a coin's harvest always runs before its
 * forward even when they land in different transactions.
 *
 * Returns [{ label, instructions, signers, cu, bytes }]; `signers` are the
 * extra signers besides the payer.
 */
export async function buildTransactions(plan, { payer, newSigner, maxBytes = MAX_TX_BYTES }) {
  const txs = [];
  for (const s of plan.steps.filter((x) => x.kind === 'migrate')) {
    const [n1, n2] = [await newSigner(), await newSigner()];
    const c = s.coin;
    const ix = C.migrateToDammV2({ payer, dbcPool: c.dbcPool, dbcConfig: c.dbcConfig, coinMint: c.mint, quoteMint: c.quoteMint, firstNftMint: n1.address, secondNftMint: n2.address });
    txs.push({ label: `migrate city ${c.cityId}`, instructions: [ix], signers: [n1, n2], cu: CU.migrate, bytes: transactionSize([ix], payer) });
  }
  let cur = null;
  const flush = () => { if (cur) txs.push(cur); cur = null; };
  for (const s of plan.steps.filter((x) => x.kind !== 'migrate')) {
    const ixs = stepInstructions(s, payer);
    const cu = stepCu[s.kind];
    const label = `city ${s.coin.cityId} ${s.kind}`;
    if (cur) {
      const both = [...cur.instructions, ...ixs];
      const bytes = transactionSize(both, payer);
      if (bytes <= maxBytes && cur.cu + cu <= CU.perTx) {
        cur.instructions = both; cur.cu += cu; cur.bytes = bytes; cur.label += `, ${label}`;
        continue;
      }
      flush();
    }
    const bytes = transactionSize(ixs, payer);
    if (bytes > maxBytes) throw new Error(`${label} alone is ${bytes} bytes, over ${maxBytes}`);
    cur = { label, instructions: ixs, signers: [], cu, bytes };
  }
  flush();
  return txs;
}

/**
 * One keeper pass: read, plan, build, send. `send(instructions, signers, { cu, label })`
 * is supplied by the caller (the script signs with the keeper wallet; tests use
 * the in-process VM). With `dryRun` nothing is sent and the transactions are returned.
 */
export async function runKeeper({ reader, payer, newSigner, send, daily = true, dryRun = false, maxBytes = MAX_TX_BYTES }) {
  const state = await loadState(reader);
  const plan = planKeeper(state, { daily });
  const txs = await buildTransactions(plan, { payer, newSigner, maxBytes });
  const results = [];
  if (!dryRun) {
    for (const tx of txs) {
      try {
        results.push({ label: tx.label, ok: true, result: await send(tx.instructions, tx.signers, { cu: tx.cu, label: tx.label }) });
      } catch (e) {
        // one failed transaction never stops the pass; the next pass retries it
        results.push({ label: tx.label, ok: false, error: String(e.message ?? e).split('\n')[0] });
      }
    }
  }
  return { coins: state.coins.length, steps: plan.steps.map((s) => ({ kind: s.kind, cityId: s.coin.cityId })), notes: plan.notes, transactions: txs, results };
}
