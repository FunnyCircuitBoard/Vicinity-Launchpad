// L05: launch (4.10, 3.10): every account created; the Metaplex metadata; the
// meta_hash stored and emitted; the supply after the 9.1-coin burn; the mint
// and freeze authorities None; the launch fee to FEE_RECIPIENT; rent and
// rent_reserve; the legacy checks again at launch (an old Approval or Coin made
// after the approval here blocks the launch, and so do open old launches); the
// pool-option config (no burn); account substitutions refused; and C01/C02 for
// the website's launch transaction with the founder's first buy through an
// address lookup table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, metaHash, readMetadata, mintInfo, tokenAccountInfo, LAMPORTS } from './helpers.mjs';

const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

/** An active address lookup table account holding `addresses` (meta of 56 bytes, then the keys). */
function lookupTable(w, addresses, authority) {
  const web3pk = (a) => Buffer.from(S.toKey(a).toBytes());
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0); // ProgramState::LookupTable
  meta.writeBigUInt64LE((1n << 64n) - 1n, 4); // deactivation_slot: never
  meta.writeBigUInt64LE(0n, 12); // last_extended_slot
  meta[20] = 0; // last_extended_slot_start_index
  meta[21] = 1; web3pk(authority).copy(meta, 22); // authority: Some
  const data = Buffer.concat([meta, ...addresses.map(web3pk)]);
  const addr = S.findPda([Buffer.from('test-alt'), Buffer.from(String(addresses.length))], ALT_PROGRAM)[0];
  w.setRaw(addr, data, ALT_PROGRAM);
  return addr;
}

test('L05 launch: accounts, metadata, meta_hash, the 9.1-coin burn, authorities None, launch fee, rent, rent_reserve', async () => {
  const w = await World.create();
  const founder = await w.signer();
  await w.approve({ cityId: 5_128_581n, founder, name: 'New York', symbol: 'NYC', hash: metaHash('nyc.json') });
  const apRent = w.lamportsOf(w.P.approval(5_128_581n));
  const fee0 = w.lamportsOf(S.ADDRESSES.feeRecipient);
  const admin0 = w.lamportsOf(w.admin.address);
  const f0 = w.lamportsOf(founder.address);
  const h = await w.launch({ cityId: 5_128_581n, founder });
  const res = h.res;
  // Coin
  const c = w.coinView(h);
  const rentOf = (n) => w.svm.minimumBalanceForRentExemption(BigInt(n));
  assert.equal(w.accountInfo(h.coin).data.length, 693);
  assert.equal(c.rentReserve, rentOf(693));
  assert.equal(w.lamportsOf(h.coin), c.rentReserve, 'the Coin holds exactly its rent');
  assert.deepEqual([c.phase, c.layoutVersion, c.cityId, c.founder, c.symbol, c.configId, c.dustBurned], [0, 1, 5_128_581n, founder.address, 'NYC', 0, 9_100_000n]);
  assert.deepEqual([...c.metaHash], metaHash('nyc.json'), 'meta_hash stored');
  assert.deepEqual([c.mintBump, c.vaultBump], [S.findPda([Buffer.from('mint'), S.toKey(h.coin).toBuffer()], w.programId)[1], S.findPda([Buffer.from('coin_vault'), S.toKey(h.coin).toBuffer()], w.programId)[1]]);
  // mint: classic SPL Token, 6 decimals, authorities None, supply after the burn
  const m = mintInfo(w.accountInfo(h.mint));
  assert.equal(w.accountInfo(h.mint).owner, S.ADDRESSES.token);
  assert.deepEqual([m.decimals, m.mintAuthority, m.freezeAuthority, m.supply], [6, null, null, 999_999_990_900_000n], 'supply 999,999,990.9 coins');
  // vault: S + P, authority the Coin PDA
  const v = tokenAccountInfo(w.accountInfo(h.vault));
  assert.deepEqual([v.mint, v.owner, v.amount, v.delegate, v.closeAuthority], [h.mint, h.coin, 793_099_990_000_000n + 206_900_000_900_000n, null, null]);
  // ticker lock
  const tl = S.decodeTickerLock(w.accountInfo(w.P.ticker('NYC')), { programId: w.programId });
  assert.deepEqual([tl.cityId, tl.mint], [5_128_581n, h.mint]);
  // Metaplex metadata: immutable, the approved name and symbol, the URI, no creators, update authority the Coin
  const md = readMetadata(w.accountInfo(S.metadataAddress(h.mint)).data);
  assert.deepEqual([md.name, md.symbol, md.uri, md.isMutable, md.updateAuthority, md.hasCreators, md.sellerFeeBasisPoints],
    ['New York', 'NYC', `https://vicinity.city/coin-meta/${h.mint}.json`, false, h.coin, false, 0]);
  // the approval closed, its rent back to the admin
  assert.equal(w.approval(5_128_581n), null);
  assert.equal(w.lamportsOf(w.admin.address) - admin0, apRent);
  // launch fee 0.05 SOL to FEE_RECIPIENT; the founder paid rent, the fee and Metaplex's fee, nothing else
  assert.equal(w.lamportsOf(S.ADDRESSES.feeRecipient) - fee0, 50_000_000n);
  const metaLamports = w.lamportsOf(S.metadataAddress(h.mint));
  const metaplexFee = metaLamports - rentOf(w.accountInfo(S.metadataAddress(h.mint)).data.length);
  const paid = f0 - w.lamportsOf(founder.address);
  assert.equal(paid, rentOf(693) + rentOf(82) + rentOf(165) + rentOf(49) + metaLamports + 50_000_000n, 'rent + launch fee + metadata (rent and Metaplex fee)');
  assert.ok(metaplexFee >= 0n);
  // the event carries the meta hash and the URI (the checker compared every field)
  const ev = res.events.find((e) => e.name === 'CoinLaunched').data;
  assert.deepEqual([...ev.meta_hash], metaHash('nyc.json'));
  assert.equal(ev.uri, `https://vicinity.city/coin-meta/${h.mint}.json`);
  // the token instructions of the launch: one mint_to, one dust burn, one set_authority, nothing else on the mint or vault
  const tokenTags = res.top.find((t) => t.name === 'launch').inner.filter((i) => i.program === S.ADDRESSES.token).map((i) => i.data[0]);
  assert.equal(tokenTags.filter((t) => t === 7).length, 1, 'mint_to once');
  assert.equal(tokenTags.filter((t) => t === 8).length, 1, 'one burn: the dust');
  assert.equal(tokenTags.filter((t) => t === 6).length, 1, 'set_authority once');
  await w.finish();
});

test('L05 who may launch, the pauses, and account substitutions', async () => {
  const w = await World.create();
  const founder = await w.signer(); const other = await w.signer(); const payer = await w.signer();
  await w.approve({ cityId: 40n, founder, symbol: 'SUB' });
  const base = () => w.launchIx({ cityId: 40n, founder });
  await expectFail(() => w.send([w.ix.launch({ founder: other.address, payer: other.address, cityId: 40n, configId: 0, symbol: 'SUB', rentPayer: w.admin.address })], [other], 'another founder'), 'WrongFounder');
  await expectFail(() => w.send([w.ix.launch({ founder: founder.address, cityId: 40n, configId: 0, symbol: 'SUB', rentPayer: other.address })], [founder], 'rent payer'), 'InvalidAddress');
  const sub = async (overrides, ...codes) => expectFail(() => w.send([w.ix.launch({ founder: founder.address, cityId: 40n, configId: 0, symbol: 'SUB', rentPayer: w.admin.address, overrides })], [founder], `substitute ${Object.keys(overrides)}`), ...codes);
  await sub({ metadata: S.metadataAddress(w.P.coinAccounts(41n).mint) }, 'InvalidAddress');
  await sub({ fee_recipient: other.address }, 'InvalidAddress');
  await sub({ metadata_program: S.ADDRESSES.token }, 'InvalidAddress');
  await sub({ token_program: S.ADDRESSES.token2022 }, 'InvalidProgramId', /Program ID|InvalidProgramId/);
  await sub({ coin: w.P.coin(41n) }, 'ConstraintSeeds');
  await sub({ mint: w.P.coinAccounts(41n).mint }, 'ConstraintSeeds');
  await sub({ coin_vault: w.P.coinAccounts(41n).vault }, 'ConstraintSeeds');
  await sub({ ticker_lock: w.P.ticker('OTHER') }, 'ConstraintSeeds');
  await sub({ config: w.P.config(1) }, 'AccountNotInitialized', 'ConstraintSeeds');
  await sub({ legacy_coin: w.P.legacyCoin(41n) }, 'InvalidAddress');
  // pauses: launches paused, buys halted (guardian), each refuses
  await w.send([w.ix.setPause({ authority: w.admin.address, launches: true })], [w.admin], 'pause launches');
  await expectFail(() => w.send([base()], [founder], 'launch while paused'), 'LaunchesPaused');
  await w.send([w.ix.setPause({ authority: w.admin.address, launches: false })], [w.admin], 'resume launches');
  await w.send([w.ix.setPause({ authority: w.guardian.address, buys: true })], [w.guardian], 'guardian halts buys');
  await expectFail(() => w.send([base()], [founder], 'launch while buys halted'), 'BuysHalted');
  await w.send([w.ix.setPause({ authority: w.admin.address, buys: false })], [w.admin], 'admin clears');
  // a separate payer pays everything; the founder only signs
  const f0 = w.lamportsOf(founder.address);
  await w.launch({ cityId: 40n, founder, payer });
  assert.equal(w.lamportsOf(founder.address), f0, 'the founder paid nothing');
  await w.finish();
});

test('L05 the legacy checks run again at launch: an old Approval or Coin made after the approval here, or open old launches, block it', async () => {
  const w = await World.create({ dbcProgram: true });
  const founder = await w.signer(); const oldFounder = await w.signer();
  await w.approve({ cityId: 50n, founder, symbol: 'LGA' });
  await w.approve({ cityId: 51n, founder, symbol: 'LGB' });
  // the old program approves city 50 after the approval here
  await w.legacyApprove({ cityId: 50n, founder: oldFounder });
  await expectFail(() => w.launch({ cityId: 50n, founder }), 'LegacyApprovalExists');
  // its launches reopened: every launch here stops at once
  await w.legacyPause(false);
  await expectFail(() => w.launch({ cityId: 51n, founder }), 'LegacyLaunchesOpen');
  // ... and it launches city 50 itself (DBC), then pauses again: city 50 is taken forever
  await w.legacyLaunch({ cityId: 50n, founder: oldFounder });
  await w.legacyPause(true);
  await expectFail(() => w.launch({ cityId: 50n, founder }), 'LegacyCoinExists');
  // city 51 launches once the old launches are paused again
  await w.launch({ cityId: 51n, founder });
  await w.finish();
});

test('L05 the pool-option config O3 (c): no burn, supply exactly 10^15', async () => {
  const w = await World.create();
  const id = await w.addConfig({ ...S.DEFAULT_CONFIG, virtualSol: 30_000_855_424n, virtualTokens: 1_073_025_615_141_714n, poolSupply: 206_900_010_000_000n });
  const founder = await w.signer();
  const h = await w.launchCoin({ cityId: 60n, founder, symbol: 'POOLC', configId: id });
  const c = w.coinView(h);
  assert.deepEqual([c.dustBurned, c.configId, c.poolSupply], [0n, id, 206_900_010_000_000n]);
  assert.equal(mintInfo(w.accountInfo(h.mint)).supply, S.COIN_SUPPLY);
  assert.equal(w.tokenBalance(h.vault), S.COIN_SUPPLY);
  const tags = h.res.top.find((t) => t.name === 'launch').inner.filter((i) => i.program === S.ADDRESSES.token).map((i) => i.data[0]);
  assert.ok(!tags.includes(8), 'no burn instruction');
  // the whole curve: graduation at exactly 85 SOL with this config too
  const u = await w.signer(200n);
  const r = await w.buy(u, h, 100n * LAMPORTS);
  assert.equal(r.q.graduates, true);
  assert.deepEqual([w.coinView(h).poolSol, w.coinView(h).poolTokens], [85_000_000_000n, 206_900_010_000_000n]);
  await w.finish();
});

test('C01/C02 launch, then launch + token account + first buy in one transaction through a lookup table', async () => {
  const w = await World.create();
  const founder = await w.signer(100n);
  await w.approve({ cityId: 70n, founder, symbol: 'ALT' });
  await w.approve({ cityId: 71n, founder, symbol: 'ALT2' });
  const solo = await w.launch({ cityId: 70n, founder, label: 'launch (alone)' });
  const launchCu = solo.res.ixCu[0].cu;
  assert.ok(launchCu <= 230_000, `launch ${launchCu} CU within the 11.1 test budget`);
  const table = lookupTable(w, [
    S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.associatedToken, S.ADDRESSES.metaplex, S.ADDRESSES.computeBudget, S.ADDRESSES.rentSysvar,
    w.P.eventAuthority(), w.programId, S.ADDRESSES.feeRecipient, w.P.launchpad(), S.CLUSTERS.mainnet.legacyLaunchpad, w.P.config(0),
  ], w.admin.address);
  const tables = { [table]: [S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.associatedToken, S.ADDRESSES.metaplex, S.ADDRESSES.computeBudget,
    S.ADDRESSES.rentSysvar, w.P.eventAuthority(), w.programId, S.ADDRESSES.feeRecipient, w.P.launchpad(), S.CLUSTERS.mainnet.legacyLaunchpad, w.P.config(0)] };
  const h = w.handle(71n, founder);
  const ixs = [w.launchIx({ cityId: 71n, founder }), ...w.buyIxs(founder, h, LAMPORTS, 0n)];
  // without the table the transaction is too close to (or over) the 1,232-byte limit (11.3)
  const plain = await w.buildTx(ixs, [founder], { cu: 400_000 });
  const { getBase64EncodedWireTransaction } = await import('@solana/kit');
  const plainSize = Buffer.from(getBase64EncodedWireTransaction(plain), 'base64').length;
  const res = await w.send(ixs, [founder], 'launch + ATA + first buy (lookup table)', { cu: 400_000, lookupTables: tables });
  assert.ok(res.size <= 1232, `with the table: ${res.size} bytes`);
  assert.ok(res.cu <= 400_000, `launch + ATA + buy ${res.cu} CU within the suggested client limit`);
  assert.equal(w.balanceOf(founder, h.mint), 33_774_693_369_781n, 'the atomic first buy (E1)');
  w.measurements = { launchCu, launchSize: solo.res.size, comboCu: res.cu, comboIxCu: res.ixCu, comboSize: res.size, comboSizeWithoutTable: plainSize };
  console.log('C01/C02', JSON.stringify(w.measurements));
  await w.finish();
});
