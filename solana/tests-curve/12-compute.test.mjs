// C01, C02 (11.1, 11.3): compute units of every instruction, measured on the
// production build in one coin's life (buy and sell before and after
// graduation, the graduating buy, buybacks in both phases, every outflow,
// launch, the settings instructions, the batch launch approval's five
// instructions), each asserted against its 11.1 test
// budget; and the sizes of the website's transactions. The figures are printed
// (and written to target/vcurve-measurements.json) for VICINITY-CURVE-NOTES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBase64EncodedWireTransaction } from '@solana/kit';
import web3 from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { World, S, SOL, LAMPORTS, DAY } from './helpers.mjs';

// 11.1 test budgets (asserted)
const BUDGET = {
  buy: 48_000, 'buy (graduates)': 55_000, sell: 48_000, buyback_burn: 48_000, withdraw_platform_fees: 25_000, claim_founder_fees: 25_000,
  payout_founder_fees: 30_000, forward_holders_fees: 40_000, launch: 230_000, settings: 50_000, launch_from_batch: 250_000,
};

test('C01/C02 compute units per instruction against the 11.1 budgets, and the website\'s transaction sizes', async () => {
  const w = await World.create();
  const rows = [];
  const record = (what, res, budget) => {
    const ix = res.ixCu[0];
    rows.push({ what, cu: ix.cu, txCu: res.cu, size: res.size, budget });
    if (budget) assert.ok(ix.cu <= budget, `${what}: ${ix.cu} CU above the 11.1 budget of ${budget}`);
    return ix.cu;
  };
  const founder = await w.signer(10n);
  // settings instructions
  const stranger = await w.signer(1n);
  record('set_guardian', await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: w.guardian.address })], [w.admin], 'set_guardian'), BUDGET.settings);
  record('set_pause', await w.send([w.ix.setPause({ authority: w.admin.address, payouts: false })], [w.admin], 'set_pause'), BUDGET.settings);
  record('add_launch_config', await w.send([w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: 1, params: S.DEFAULT_CONFIG })], [w.admin], 'add_launch_config'), BUDGET.settings);
  record('set_launch_config_enabled', await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 1, enabled: false })], [w.admin], 'set_launch_config_enabled'), BUDGET.settings);
  await w.approve({ cityId: 800n, founder, name: 'Compute City', symbol: 'CU' });
  rows.push({ what: 'approve_launch', cu: w.lastTx.ixCu[0].cu, txCu: w.lastTx.cu, size: w.lastTx.size, budget: BUDGET.settings });
  assert.ok(w.lastTx.ixCu[0].cu <= BUDGET.settings);
  // launch
  const h = await w.launch({ cityId: 800n, founder });
  record('launch', h.res, BUDGET.launch);
  // curve trades
  const u = await w.signer(500n); const v = await w.signer(500n);
  record('buy (curve, creates the token account in the same transaction)', (await w.buy(u, h, LAMPORTS)).res, BUDGET.buy);
  record('buy (curve)', (await w.buy(u, h, 2n * LAMPORTS)).res, BUDGET.buy);
  record('sell (curve)', (await w.sell(u, h, 1_000_000_000_000n)).res, BUDGET.sell);
  w.warpSlots(200n);
  record('buyback_burn (curve)', await w.buyback(h), BUDGET.buyback_burn);
  // the website's buy and sell transactions (11.3): compute budget limit and price, idempotent token account create, buy
  const webBuy = await w.buildTx([S.setComputeUnitLimit(60_000), S.setComputeUnitPrice(10_000), S.createAssociatedTokenAccountIdempotent({ payer: v.address, owner: v.address, mint: h.mint }),
    w.ix.buy({ user: v.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 1n })], [v], { feePayer: v, budget: false });
  const webBuySize = Buffer.from(getBase64EncodedWireTransaction(webBuy), 'base64').length;
  const webSell = await w.buildTx([S.setComputeUnitLimit(60_000), S.setComputeUnitPrice(10_000), w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 1n, minSolOut: 1n })], [u], { feePayer: u, budget: false });
  const webSellSize = Buffer.from(getBase64EncodedWireTransaction(webSell), 'base64').length;
  assert.ok(webBuySize <= 1232 && webSellSize <= 1232);
  // the graduating buy, then pool trades
  const c = w.coinView(h);
  record('buy (graduates, partial fill)', (await w.buy(v, h, S.maxQuoteIn(S.coinTerms(c), S.coinState(c)) + LAMPORTS)).res, BUDGET['buy (graduates)']);
  assert.equal(w.coinView(h).phase, 1);
  record('buy (pool)', (await w.buy(u, h, LAMPORTS)).res, BUDGET.buy);
  record('sell (pool)', (await w.sell(u, h, 1_000_000_000_000n)).res, BUDGET.sell);
  w.warpSlots(200n);
  record('buyback_burn (pool)', await w.buyback(h), BUDGET.buyback_burn);
  // outflows
  record('withdraw_platform_fees', await w.withdraw(h), BUDGET.withdraw_platform_fees);
  record('claim_founder_fees', await w.claim(h), BUDGET.claim_founder_fees);
  await w.initRewardsCity(h);
  const fwd = await w.forward(h);
  record('forward_holders_fees (+ top-level SyncNative in the transaction)', fwd, BUDGET.forward_holders_fees);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  const oi = await w.send([w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(3) })], [founder], 'opt_in_payout');
  record('opt_in_payout', oi, BUDGET.settings);
  await w.buy(u, h, 3n * LAMPORTS);
  w.warpSecs(DAY);
  record('payout_founder_fees', await w.payout(h, { destination: wallet.address }), BUDGET.payout_founder_fees);
  record('transfer_founder', await w.send([w.ix.transferFounder({ founder: founder.address, newFounder: stranger.address, coin: h.coin })], [founder, stranger], 'transfer_founder'), BUDGET.settings);
  // the batch launch approval (4.23 to 4.27): its four settings instructions and a batch launch with a full proof
  const approver = await w.signer(2n);
  record('init_launch_batch', await w.send([w.ix.initLaunchBatch({ admin: w.admin.address, payer: w.payer.address })], [w.admin], 'init_launch_batch'), BUDGET.settings);
  record('set_launch_approver', await w.send([w.ix.setLaunchApprover({ admin: w.admin.address, approver: approver.address })], [w.admin], 'set_launch_approver'), BUDGET.settings);
  w.approver = approver;
  const bf = await w.signer(10n);
  const many = [{ cityId: 801n, founder: bf, symbol: 'CUBATCH' }];
  for (let i = 0; i < 511; i++) many.push({ cityId: 10_000n + BigInt(i), founder: stranger, symbol: `B${i}` });
  const bt = await w.publishBatch(many);
  record('publish_launch_batch', bt.res, BUDGET.settings);
  w.warpTo(bt.validFrom);
  const lb = await w.launchFromBatch({ batch: bt, cityId: 801n, founder: bf });
  assert.equal(S.launchBatchArgs(bt, 801n).proof.length, 9, 'a full 9-hash proof (512 leaves)');
  record('launch_from_batch (512 leaves, 9-hash proof)', lb.res, BUDGET.launch_from_batch);
  record('clear_launch_batch', await w.send([w.ix.clearLaunchBatch({ authority: w.guardian.address, halt: true })], [w.guardian], 'clear_launch_batch (halt)'), BUDGET.settings);
  const out = { toolchain: 'production build of `anchor build` (target/deploy/vicinity_curve.so)', rows, webBuySize, webSellSize };
  mkdirSync(join(SOL, 'target'), { recursive: true });
  writeFileSync(join(SOL, 'target', 'vcurve-measurements.json'), JSON.stringify(out, null, 2));
  console.log(`C01/C02 measurements\n${rows.map((r) => `${r.what.padEnd(66)} ${String(r.cu).padStart(7)} CU  (tx ${r.txCu} CU, ${r.size} bytes; budget ${r.budget ?? '-'})`).join('\n')}\nwebsite buy transaction ${webBuySize} bytes, website sell transaction ${webSellSize} bytes`);
  await w.finish();
});

test('TL-INFO-1 the launch of a high-bump city (1000, name A, symbol C0) stays within the 230,000 budget and within 11.1\'s measured range; the first buy\'s token-account create costs about 13,430 + 1,500 per extra bump iteration of the owner', async () => {
  const w = await World.create();
  const founder = await w.signer(10n);
  await w.approve({ cityId: 1000n, founder, name: 'A', symbol: 'C0' });
  const h = await w.launch({ cityId: 1000n, founder });
  const cu = h.res.ixCu[0].cu;
  assert.ok(cu <= BUDGET.launch, `launch ${cu} CU within the 230,000 budget`);
  // 11.1 states the range measured over 600 city ids; this city is the worst known one under the localnet id
  const spec = readFileSync(join(SOL, 'VICINITY-CURVE-DESIGN.md'), 'utf8');
  const m = /`launch` ([\d,]+) to ([\d,]+) CU over ([\d,]+) city ids/.exec(spec);
  assert.ok(m, '11.1 states the measured launch range over many city ids');
  const [lo, hi] = [m[1], m[2]].map((x) => Number(x.replaceAll(',', '')));
  assert.ok(cu >= lo && cu <= hi, `city 1000's ${cu} CU inside 11.1's ${lo} to ${hi}`);
  assert.ok(hi > 125_900, 'the range is wider than revision 3\'s single-city figure (review TL-INFO-1)');
  // the idempotent token-account create of a first buy, on top of the buy's own figure (11.1, 11.3)
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    const u = await w.signer(2n);
    const r = await w.buy(u, h, 100_000_000n);
    const ata = r.res.top.find((t) => t.program === S.ADDRESSES.associatedToken);
    const bump = S.findPda([new web3.PublicKey(String(u.address)).toBuffer(), new web3.PublicKey(S.ADDRESSES.token).toBuffer(), new web3.PublicKey(h.mint).toBuffer()], S.ADDRESSES.associatedToken)[1];
    // 1,500 per extra bump iteration is exact; the base is the associated token program's own cost, which differs by a few CU
    // between test runtimes (13,424 locally, 13,433 on the CI runner), so it is checked within a window far narrower than 1,500
    const base = ata.cu - 1_500 * (255 - bump);
    assert.ok(base >= 13_400 && base <= 13_460, `the create costs about 13,430 + 1,500 x ${255 - bump} (base ${base})`);
    sizes.push(ata.cu);
  }
  console.log(`TL-INFO-1: launch of city 1000 ${cu} CU (11.1: ${lo} to ${hi}); token-account creates ${sizes.join(', ')} CU`);
  await w.finish();
});
