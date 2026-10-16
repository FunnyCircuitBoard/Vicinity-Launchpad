// TS01-TS05: the Wallet tab's Send (src/walletsend.js planSend, the Worker's own instruction builders and message compiler) against the
// real System, SPL Token and Associated Token programs, in process (litesvm, like 15-worker-builder.test.mjs): the transactions the
// Worker builds are signed by the sender and run, and the balances move exactly as the summary said.
//   TS01 SOL to a wallet that exists: the recipient gets the amount, the sender pays the amount and the fee the summary names
//   TS02 a token to a wallet WITHOUT its token account: the account is created (paid by the sender, the rent the summary names), the
//        tokens arrive, the sender keeps what the summary says in tokens and in SOL
//   TS03 a token to a wallet WITH its token account: no account is made, no rent, the tokens move exactly
//   TS04 SOL "everything" (Max): the sender's account is emptied to the lamport, the recipient gets it all
//   TS05 the rules mirror the network: a transfer that leaves dust, or opens a wallet with less than the minimum, is refused by the
//        chain itself (InsufficientFundsForRent), and planSend refuses the same amounts before any wallet opens; an old rent-paying
//        wallet is only topped up to the minimum or more (the network refuses a credit that leaves it rent-paying; litesvm 1.5.0 does
//        not model that one, so only the planner's refusal and the accepted top-up run here); transfer-checked refuses a wrong decimals claim
//   TS06 SOL already sitting at the recipient's token-account address: the account is made around it and the sender pays only the
//        rest of the rent, exactly what the summary says; the summary's lines name an address nobody has used
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import { address, lamports, generateKeyPairSigner, signBytes } from '@solana/kit';
import { mintData, tokenAccountData } from './helpers.mjs';
import { CU, FRESH_LINE, RENT_ATA_LAMPORTS, RENT_MIN_LAMPORTS, SOL, accountOf, planSend } from '../../src/walletsend.js';
import { PROGRAM_IDS, ata } from '../../src/sol/pda.js';
import { setComputeUnitLimit, systemTransfer, transferChecked } from '../../src/sol/ix.js';
import { compileLegacy, decodeHeader, wrapUnsigned } from '../../src/sol/message.js';
import { readU64 } from '../../src/sol/bytes.js';

const LAMPORTS = 1_000_000_000n;
const CU_PRICE = 100_000n; // the live LAUNCHPAD_CU_PRICE
const big = (k, v) => (typeof v === 'bigint' ? String(v) : v);

describe('19 the Wallet tab\'s Send against the real programs', () => {
  let svm, sender, mint, senderAta, used, fresh, withAta, withAtaAcct;
  /** An account as the Worker reads it from the chain (src/walletsend.js accountOf), or null when it does not exist. */
  const acc = (addr) => { const a = svm.getAccount(address(String(addr))); return a.exists ? accountOf({ owner: String(a.programAddress), lamports: a.lamports, executable: a.executable, data: new Uint8Array(a.data) }) : null; };
  const sol = (addr) => { const a = acc(addr); return a ? a.lamports : 0n; };
  const tokens = (tokenAccount) => { const a = acc(tokenAccount); return a ? readU64(a.data, 64) : null; };
  const setRaw = (addr, data, owner, lam) => { const d = new Uint8Array(data); svm.setAccount({ address: address(String(addr)), lamports: lamports(lam ?? svm.minimumBalanceForRentExemption(BigInt(d.length))), programAddress: address(String(owner)), executable: false, data: d, space: BigInt(d.length) }); };
  /** Compile the plan the way the route does (legacy, the sender pays), sign with the sender's key and run it; the bytes the wallet would see. */
  async function send(instructions, signer = sender) {
    const message = compileLegacy({ payer: signer.address, instructions, blockhash: svm.latestBlockhash() });
    const tx = wrapUnsigned(message);
    const h = decodeHeader(tx);
    assert.deepEqual([h.numSignatures, h.staticKeys[0]], [1, signer.address], 'one signer: the sender');
    const sig = await signBytes(signer.keyPair.privateKey, message);
    const res = svm.sendTransaction({ messageBytes: message, signatures: { [signer.address]: sig } });
    svm.expireBlockhash();
    if (typeof res.err === 'function') { const e = new Error(`failed: ${String(res.err())}\n  ${res.meta().logs().slice(-8).join('\n  ')}`); e.logs = res.meta().logs(); e.err = String(res.err()); throw e; }
    return { cu: Number(res.computeUnitsConsumed()), bytes: tx.length };
  }
  const SOL_ASSET = { id: SOL, label: 'SOL', symbol: 'SOL', name: 'Solana', decimals: 9 };
  const tokenAsset = () => ({ id: mint, mint, label: '$VICINITY', symbol: 'VICINITY', name: 'Vicinity', decimals: 6 });
  /** The chain as the route reads it for a token send. */
  const tokenChain = async (to) => { const toAta = await ata(to, mint); return { chain: { sender: acc(sender.address), to: acc(to), mint: acc(mint), senderAta: acc(senderAta), toAta: acc(toAta) }, addresses: { senderAta, toAta } }; };

  before(async () => {
    svm = new LiteSVM();
    sender = await generateKeyPairSigner(); svm.airdrop(sender.address, lamports(2n * LAMPORTS));
    used = await generateKeyPairSigner(); svm.airdrop(used.address, lamports(LAMPORTS));
    withAta = await generateKeyPairSigner(); svm.airdrop(withAta.address, lamports(LAMPORTS));
    fresh = await generateKeyPairSigner(); // never airdropped: no account on the chain
    mint = (await generateKeyPairSigner()).address;
    setRaw(mint, mintData({ decimals: 6, supply: 1_000_000_000_000_000n }), PROGRAM_IDS.token);
    senderAta = await ata(sender.address, mint);
    setRaw(senderAta, tokenAccountData({ mint, owner: sender.address, amount: 25_000_000_000n }), PROGRAM_IDS.token);
    withAtaAcct = await ata(withAta.address, mint);
    setRaw(withAtaAcct, tokenAccountData({ mint, owner: withAta.address, amount: 5_000_000n }), PROGRAM_IDS.token);
    assert.equal(svm.minimumBalanceForRentExemption(0n), RENT_MIN_LAMPORTS, 'the rent-exempt minimum of a wallet, as the Worker states it');
    assert.equal(svm.minimumBalanceForRentExemption(165n), RENT_ATA_LAMPORTS, 'the rent of a token account, as the Worker states it');
  });

  it('TS01 SOL to a wallet that exists moves exactly the amount; the sender pays the amount plus the fee the summary names', async () => {
    const before = { sender: sol(sender.address), to: sol(used.address) };
    const plan = await planSend({ sender: sender.address, to: used.address, asset: SOL_ASSET, amount: '0.5', chain: { sender: acc(sender.address), to: acc(used.address) }, cuPrice: CU_PRICE });
    assert.equal(plan.ok, true, JSON.stringify(plan, big));
    assert.deepEqual(plan.summary.lines, ['Send 0.5 SOL', 'No Vicinity fee. Network fee about 0.000006 SOL.', `You keep ${plan.summary.remaining.amount} SOL after this send.`]);
    const r = await send(plan.instructions);
    assert.equal(sol(used.address) - before.to, 500_000_000n, 'the recipient got exactly 0.5 SOL');
    assert.equal(before.sender - sol(sender.address), 500_000_000n + BigInt(plan.summary.fee.lamports), 'the sender paid the amount and exactly the fee the summary named (signature and priority fee)');
    assert.equal(sol(sender.address), BigInt(plan.summary.remainingSol.replace('.', '').padEnd(10, '0')), 'what the summary said would remain, to the lamport');
    assert.ok(r.cu <= CU.sol, `${r.cu} compute units within the ${CU.sol} limit`);
    assert.ok(r.cu > 0);
  });

  it('TS02 a token to a wallet without its token account: the account is created and paid by the sender (the rent the summary names), the tokens arrive, the sender keeps what the summary says', async () => {
    const toAta = await ata(used.address, mint);
    assert.equal(acc(toAta), null, 'no token account yet');
    const before = { senderSol: sol(sender.address), toSol: sol(used.address), senderTok: tokens(senderAta) };
    const { chain, addresses } = await tokenChain(used.address);
    const plan = await planSend({ sender: sender.address, to: used.address, asset: tokenAsset(), amount: '1000', chain, addresses, cuPrice: CU_PRICE });
    assert.equal(plan.ok, true, JSON.stringify(plan, big));
    assert.equal(plan.instructions.length, 4, 'the budget, its price, the account, the transfer');
    assert.deepEqual(plan.summary.rent, { lamports: String(RENT_ATA_LAMPORTS), sol: '0.00203928' });
    assert.ok(plan.summary.lines.includes('+0.00204 SOL one-time account rent for the recipient.'));
    const r = await send(plan.instructions);
    const created = acc(toAta);
    assert.ok(created, 'the recipient\'s token account exists now');
    assert.equal(created.owner, PROGRAM_IDS.token);
    assert.equal(created.lamports, RENT_ATA_LAMPORTS, 'its rent, exactly what the summary said the sender pays');
    assert.equal(tokens(toAta), 1_000_000_000n, 'exactly 1,000 tokens arrived');
    assert.equal(before.senderTok - tokens(senderAta), 1_000_000_000n);
    assert.equal(tokens(senderAta), BigInt(plan.summary.remaining.amount) * 1_000_000n, `the sender keeps ${plan.summary.remaining.amount} tokens, as said`);
    assert.equal(before.senderSol - sol(sender.address), BigInt(plan.summary.fee.lamports) + RENT_ATA_LAMPORTS, 'the sender paid the fee and the rent, nothing else');
    assert.equal(sol(sender.address), BigInt(plan.summary.remainingSol.replace('.', '').padEnd(10, '0')), 'the SOL the summary said would remain');
    assert.equal(sol(used.address), before.toSol, 'the recipient\'s own SOL did not move');
    assert.ok(r.cu <= CU.tokenWithAccount, `${r.cu} compute units within the ${CU.tokenWithAccount} limit`);
  });

  it('TS03 a token to a wallet with its token account: no account is made, no rent, the tokens move exactly', async () => {
    const before = { senderSol: sol(sender.address), senderTok: tokens(senderAta), toTok: tokens(withAtaAcct), toAtaLamports: acc(withAtaAcct).lamports };
    const { chain, addresses } = await tokenChain(withAta.address);
    const plan = await planSend({ sender: sender.address, to: withAta.address, asset: tokenAsset(), amount: '0.5', chain, addresses, cuPrice: CU_PRICE });
    assert.equal(plan.ok, true, JSON.stringify(plan, big));
    assert.equal(plan.instructions.length, 3, 'the budget, its price, the transfer: no account to make');
    assert.equal(plan.summary.rent, null);
    assert.ok(!plan.summary.lines.includes(FRESH_LINE), 'a wallet the chain knows: no line about an unused address');
    const r = await send(plan.instructions);
    assert.equal(tokens(withAtaAcct) - before.toTok, 500_000n);
    assert.equal(before.senderTok - tokens(senderAta), 500_000n);
    assert.equal(acc(withAtaAcct).lamports, before.toAtaLamports, 'no rent paid: the account was there');
    assert.equal(before.senderSol - sol(sender.address), BigInt(plan.summary.fee.lamports), 'the fee alone');
    assert.ok(r.cu <= CU.token, `${r.cu} compute units within the ${CU.token} limit`);
  });

  it('TS05 the rules mirror the network: dust, a new wallet below the minimum and a wrong decimals claim fail on the chain, and planSend refuses them first', async () => {
    const have = sol(sender.address);
    // a raw transfer that would leave the sender with less than the minimum (but more than nothing): the chain refuses it
    const dustAmount = have - 6000n - 100_000n; // 0.0001 SOL would remain
    await assert.rejects(send([setComputeUnitLimit(CU.sol), systemTransfer(sender.address, used.address, dustAmount)]), (e) => /InsufficientFundsForRent/.test(e.err));
    const planDust = await planSend({ sender: sender.address, to: used.address, asset: SOL_ASSET, amount: (Number(dustAmount) / 1e9).toFixed(9), chain: { sender: acc(sender.address), to: acc(used.address) }, cuPrice: CU_PRICE });
    assert.deepEqual([planDust.ok, planDust.error], [false, 'leaves_dust']);
    // a wallet nobody has used yet cannot be opened with less than the minimum
    await assert.rejects(send([setComputeUnitLimit(CU.sol), systemTransfer(sender.address, fresh.address, RENT_MIN_LAMPORTS - 1n)]), (e) => /InsufficientFundsForRent/.test(e.err));
    const planLow = await planSend({ sender: sender.address, to: fresh.address, asset: SOL_ASSET, amount: '0.00089087', chain: { sender: acc(sender.address), to: null }, cuPrice: CU_PRICE });
    assert.deepEqual([planLow.ok, planLow.error], [false, 'amount_below_rent']);
    assert.equal(sol(fresh.address), 0n, 'nothing moved');
    // transfer-checked carries the decimals the Worker read from the mint: a wrong claim is refused by the token program itself
    const wrong = transferChecked({ source: senderAta, mint, destination: withAtaAcct, owner: sender.address, amount: 1n, decimals: 9 });
    await assert.rejects(send([setComputeUnitLimit(CU.token), wrong]), (e) => /MintDecimalsMismatch|custom program error: 0x12|Custom\(18\)|Custom: 18/.test(e.err + e.logs.join('\n')));
    assert.equal(sol(sender.address), have - 3n * 5000n, 'each failed transaction cost its signature fee and nothing else; no amount moved');
    assert.equal(tokens(withAtaAcct), 5_500_000n, 'the wrong-decimals transfer moved nothing');
    // an old rent-paying wallet (below the minimum, still there): the network takes no credit that leaves it rent-paying ("cannot remain
    // RentPaying if credited"), so planSend asks for at least what brings it to the minimum; that top-up runs and lands exactly there
    const paying = await generateKeyPairSigner();
    setRaw(paying.address, new Uint8Array(0), PROGRAM_IDS.system, 500_000n);
    const planPaying = await planSend({ sender: sender.address, to: paying.address, asset: SOL_ASSET, amount: '0.0001', chain: { sender: acc(sender.address), to: acc(paying.address) }, cuPrice: CU_PRICE });
    assert.deepEqual([planPaying.ok, planPaying.error, planPaying.min], [false, 'amount_below_rent', '0.00039088'], 'planSend refuses it first, naming what would bring the wallet to the minimum');
    const planEnough = await planSend({ sender: sender.address, to: paying.address, asset: SOL_ASSET, amount: '0.00039088', chain: { sender: acc(sender.address), to: acc(paying.address) }, cuPrice: CU_PRICE });
    assert.equal(planEnough.ok, true, JSON.stringify(planEnough, big));
    await send(planEnough.instructions);
    assert.equal(sol(paying.address), RENT_MIN_LAMPORTS, 'brought exactly to the minimum');
  });

  it('TS06 SOL already at the recipient\'s token-account address: the account is made around it, the sender pays the rest of the rent the summary names; an unused address is said in the lines', async () => {
    const to = await generateKeyPairSigner(); // never airdropped: an address nobody has used
    const toAta = await ata(to.address, mint);
    setRaw(toAta, new Uint8Array(0), PROGRAM_IDS.system, 1_000_000n); // someone sent 0.001 SOL to the derived address
    const before = { senderSol: sol(sender.address), senderTok: tokens(senderAta) };
    const { chain, addresses } = await tokenChain(to.address);
    assert.equal(chain.to, null); assert.equal(chain.toAta.owner, PROGRAM_IDS.system);
    const plan = await planSend({ sender: sender.address, to: to.address, asset: tokenAsset(), amount: '2', chain, addresses, cuPrice: CU_PRICE });
    assert.equal(plan.ok, true, JSON.stringify(plan, big));
    assert.equal(plan.rent, RENT_ATA_LAMPORTS - 1_000_000n, 'only what is missing');
    assert.deepEqual(plan.summary.rent, { lamports: '1039280', sol: '0.00103928' });
    assert.deepEqual(plan.summary.lines, ['Send 2 $VICINITY', 'No Vicinity fee. Network fee about 0.000011 SOL.', '+0.00104 SOL one-time account rent for the recipient.', FRESH_LINE, 'You keep 23,997.5 $VICINITY after this send.', `Your SOL after the fee and the rent: about ${plan.summary.remainingSol} SOL.`]);
    assert.equal(plan.summary.remaining.amount, '23997.5');
    assert.equal(plan.instructions.length, 4, 'the account is still created (around the SOL already there)');
    const r = await send(plan.instructions);
    const created = acc(toAta);
    assert.equal(created.owner, PROGRAM_IDS.token);
    assert.equal(created.lamports, RENT_ATA_LAMPORTS, 'the rent-exempt amount, no more: the SOL that was there counted');
    assert.equal(tokens(toAta), 2_000_000n);
    assert.equal(before.senderSol - sol(sender.address), BigInt(plan.summary.fee.lamports) + plan.rent, 'the sender paid the fee and exactly the rent the summary named');
    assert.equal(sol(sender.address), BigInt(plan.summary.remainingSol.replace('.', '').padEnd(10, '0')));
    assert.equal(before.senderTok - tokens(senderAta), 2_000_000n);
    assert.equal(acc(to.address), null, 'the recipient\'s own wallet account is not created by a token send');
    assert.ok(r.cu <= CU.tokenWithAccount, `${r.cu} compute units within the ${CU.tokenWithAccount} limit`);
  });

  it('TS04 SOL "everything" (Max) empties the sender\'s account to the lamport and the recipient gets it all', async () => {
    const have = sol(sender.address), before = sol(fresh.address);
    const plan = await planSend({ sender: sender.address, to: fresh.address, asset: SOL_ASSET, all: true, chain: { sender: acc(sender.address), to: acc(fresh.address) }, cuPrice: CU_PRICE });
    assert.equal(plan.ok, true, JSON.stringify(plan, big));
    assert.equal(plan.amountRaw, have - BigInt(plan.summary.fee.lamports));
    assert.deepEqual(plan.summary.remaining, { amount: '0', label: 'SOL' });
    assert.deepEqual(plan.summary.lines, [`Send ${plan.summary.amount} SOL`, 'No Vicinity fee. Network fee about 0.000006 SOL.', FRESH_LINE, 'You keep no SOL after this send: your wallet is emptied.'], 'an address nobody has used: said in the lines');
    await send(plan.instructions);
    assert.equal(sol(fresh.address) - before, plan.amountRaw, 'the recipient (a wallet nobody had used) got everything but the fee');
    assert.equal(acc(sender.address), null, 'the sender\'s account holds nothing and is gone');
  });
});
