// Attack tests of 12.4 on accounts and authorities (section 10): X03 fake and
// look-alike mints (with X36's closest testable shape: a perfect look-alike made
// outside the program, with the same name, symbol and URI, is refused by every
// instruction and is not in the registry), X06 metadata address substitution at
// launch, X29 re-initialisation of every account, X30 close and revival
// attempts, X37 a later metadata edit, X38 Unicode spoofing in names, X39 mint
// and freeze authority, X54 aliased accounts, X55 pre-funded PDAs and vault,
// X60 re-entrancy (closest shape: what every money instruction calls), X64
// init_launchpad by a stranger.
//
// Every refusal goes through World.send, whose failed-transaction check
// asserts that no account of the message moved (but the fee payer's fee) and
// no vicinity_curve account changed; `refuse` below also compares the bytes and
// lamports of the accounts each attack aims at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { address, generateKeyPairSigner } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, S, expectFail, mintInfo, readMetadata, tokenAccountInfo, metaHash, LAMPORTS, DAY } from './helpers.mjs';

const { PublicKey } = web3;
const R = S.Role;

// ---------------------------------------------------------------- local helpers
const u64b = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32b = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pkb = (a) => new PublicKey(String(a)).toBuffer();
const borshStr = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32b(b.length), b]); };
const ix = (programAddress, accounts, data) => ({ programAddress, accounts: accounts.map(([address, role]) => ({ address: String(address), role })), data: new Uint8Array(data) });
const tok = (accounts, data) => ix(S.ADDRESSES.token, accounts, data);
const T = {
  transfer: (src, dst, owner, n) => tok([[src, R.W], [dst, R.W], [owner, R.RS]], Buffer.concat([Buffer.from([3]), u64b(n)])),
  approve: (src, delegate, owner, n) => tok([[src, R.W], [delegate, R.R], [owner, R.RS]], Buffer.concat([Buffer.from([4]), u64b(n)])),
  setAuthority: (acc, current, type, next) => tok([[acc, R.W], [current, R.RS]], Buffer.concat([Buffer.from([6, type]), next ? Buffer.concat([Buffer.from([1]), pkb(next)]) : Buffer.from([0])])),
  mintTo: (mint, dst, authority, n) => tok([[mint, R.W], [dst, R.W], [authority, R.RS]], Buffer.concat([Buffer.from([7]), u64b(n)])),
  burn: (acc, mint, owner, n) => tok([[acc, R.W], [mint, R.W], [owner, R.RS]], Buffer.concat([Buffer.from([8]), u64b(n)])),
  close: (acc, dst, owner) => tok([[acc, R.W], [dst, R.W], [owner, R.RS]], [9]),
  freeze: (acc, mint, authority) => tok([[acc, R.W], [mint, R.R], [authority, R.RS]], [10]),
  initMint2: (mint, decimals, authority) => tok([[mint, R.W]], Buffer.concat([Buffer.from([20, decimals]), pkb(authority), Buffer.from([0])])),
  initAccount3: (acc, mint, owner) => tok([[acc, R.W], [mint, R.R]], Buffer.concat([Buffer.from([18]), pkb(owner)])),
};
const sys = {
  transfer: (from, to, n) => ix(S.ADDRESSES.system, [[from, R.WS], [to, R.W]], Buffer.concat([u32b(2), u64b(n)])),
  createAccount: (from, acc, lamports, space, owner) => ix(S.ADDRESSES.system, [[from, R.WS], [acc, R.WS]], Buffer.concat([u32b(0), u64b(lamports), u64b(space), pkb(owner)])),
};
/** Metaplex CreateMetadataAccountV3 (instruction 33) for a mint the signer controls. */
const metaplexCreate = ({ metadata, mint, authority, payer, name, symbol, uri }) => ix(S.ADDRESSES.metaplex,
  [[metadata, R.W], [mint, R.R], [authority, R.RS], [payer, R.WS], [authority, R.RS], [S.ADDRESSES.system, R.R], [S.ADDRESSES.rentSysvar, R.R]],
  Buffer.concat([Buffer.from([33]), borshStr(name), borshStr(symbol), borshStr(uri), Buffer.from([0, 0]), Buffer.from([0, 0, 0]), Buffer.from([1]), Buffer.from([0])]));
/** Metaplex UpdateMetadataAccountV2 (instruction 15): only a new update authority. */
const metaplexUpdate = ({ metadata, authority, newAuthority, data }) => ix(S.ADDRESSES.metaplex, [[metadata, R.W], [authority, R.RS]],
  Buffer.concat([Buffer.from([15]), data ? Buffer.concat([Buffer.from([1]), data]) : Buffer.from([0]), Buffer.from([1]), pkb(newAuthority), Buffer.from([0]), Buffer.from([0])]));

const fingerprint = (w, addrs) => addrs.map((a) => { const x = w.accountInfo(a); return x ? `${a}:${x.lamports}:${x.owner}:${x.data.toString('hex')}` : `${a}:none`; });
/** The attack must fail with one of `codes`, and none of `watch` may change (beyond the checker's own failed-transaction check). */
async function refuse(w, watch, fn, ...codes) {
  const before = fingerprint(w, watch);
  const e = await expectFail(fn, ...codes);
  assert.deepEqual(fingerprint(w, watch), before, 'an attacked account changed');
  return e;
}
const coinAccounts = (h) => [h.coin, h.mint, h.vault, S.metadataAddress(h.mint)];

// ---------------------------------------------------------------- X03, X36
test('X03, X36: a fake mint, and a perfect look-alike made outside the program (same name, symbol and URI), are refused by every instruction and are not in the registry', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1500n, symbol: 'REAL', name: 'Real City' });
  const u = await w.signer(100n); const attacker = await w.signer(100n);
  const b = await w.buy(u, h, 5n * LAMPORTS);
  // the look-alike: a classic SPL mint with 6 decimals, created and minted for real by the attacker, with Metaplex
  // metadata carrying exactly the official name, symbol and even the official URI
  const fake = await generateKeyPairSigner();
  const rentMint = w.svm.minimumBalanceForRentExemption(82n);
  await w.send([sys.createAccount(attacker.address, fake.address, rentMint, 82n, S.ADDRESSES.token), T.initMint2(fake.address, 6, attacker.address)], [attacker, fake], 'look-alike mint');
  const fakeAta = S.associatedTokenAddress(attacker.address, fake.address);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: attacker.address, owner: attacker.address, mint: fake.address }),
    T.mintTo(fake.address, fakeAta, attacker.address, 1_000_000_000_000n)], [attacker], 'look-alike supply');
  const fakeMeta = S.metadataAddress(fake.address);
  await w.send([metaplexCreate({ metadata: fakeMeta, mint: fake.address, authority: attacker.address, payer: attacker.address, name: 'Real City', symbol: 'REAL', uri: S.metadataUri(h.mint) })],
    [attacker], 'look-alike metadata');
  const md = readMetadata(w.accountInfo(fakeMeta).data);
  assert.deepEqual([md.name, md.symbol, md.uri], ['Real City', 'REAL', S.metadataUri(h.mint)], 'outside the program a perfect look-alike can exist (T36)');
  // the attacker's own token account of the real mint, for the sell attempts
  const watch = [...coinAccounts(h), fake.address, fakeAta, S.associatedTokenAddress(u.address, h.mint)];
  const buy = (overrides, user = u) => () => w.send([w.ix.buy({ user: user.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides })], [user], `buy with ${Object.keys(overrides)}`);
  const sell = (overrides, user = u, n = 1_000_000n) => () => w.send([w.ix.sell({ user: user.address, coin: h.coin, tokensIn: n, minSolOut: 0n, overrides })], [user], `sell with ${Object.keys(overrides)}`);
  // the mint slot is pinned to coin.mint
  await refuse(w, watch, buy({ mint: fake.address }), 'InvalidAddress');
  await refuse(w, watch, buy({ mint: fake.address, user_token_account: fakeAta }, attacker), 'InvalidAddress');
  await refuse(w, watch, sell({ mint: fake.address, user_token_account: fakeAta }, attacker, 1_000_000n), 'InvalidAddress');
  await refuse(w, watch, () => w.send([w.ix.buybackBurn({ coin: h.coin, overrides: { mint: fake.address } })], [], 'buyback with the look-alike mint', { feePayer: w.keeper }), 'InvalidAddress');
  // the real mint with a token account of the look-alike: the user account must hold this coin's mint
  await refuse(w, watch, buy({ user_token_account: fakeAta }, attacker), 'WrongTokenAccount');
  await refuse(w, watch, sell({ user_token_account: fakeAta }, attacker, 1_000_000n), 'WrongTokenAccount');
  // the look-alike's coins in the vault are not this coin's coins: a direct transfer into the vault is refused by SPL Token (mint mismatch)
  await refuse(w, watch, () => w.send([T.transfer(fakeAta, h.vault, attacker.address, 1_000_000n)], [attacker], 'look-alike coins into the vault'), /not associated with this Mint|mint mismatch|0x3\b/i);
  // the registry: the TickerLock and the Coin of the ticker name the real mint; the look-alike has neither
  const tl = S.decodeTickerLock(w.accountInfo(w.P.ticker('REAL')), { programId: w.programId });
  assert.equal(tl.mint, h.mint);
  const registry = w.svm.getProgramAccounts(address(w.programId)).map((a) => ({ owner: w.programId, data: a.data }))
    .filter((a) => S.accountType(a, { programId: w.programId }) === 'CurveCoin').map((a) => S.decodeCurveCoin(a, { programId: w.programId }).mint);
  assert.deepEqual(registry, [h.mint], 'the only coin in the registry is the real one');
  assert.ok(!registry.includes(fake.address));
  // the real coin still trades
  await w.sell(u, h, b.q.tokensOut / 2n, { label: 'real sell' });
  await w.finish();
});

// ---------------------------------------------------------------- X06
test('X06 metadata address at launch: every substitute of the Metaplex PDA is refused; nothing is created', async () => {
  const w = await World.create();
  const founder = await w.signer(10n);
  await w.approve({ cityId: 1510n, founder, symbol: 'META' });
  const { coin, mint, vault } = w.P.coinAccounts(1510n);
  const right = S.metadataAddress(mint);
  const wrong = {
    'a random key': (await generateKeyPairSigner()).address,
    'another city\'s metadata': S.metadataAddress(w.P.coinAccounts(1511n).mint),
    'the metadata seeds under SPL Token': S.findPda([Buffer.from('metadata'), pkb(S.ADDRESSES.metaplex), pkb(mint)], S.ADDRESSES.token)[0],
    'the master edition PDA of the mint': S.findPda([Buffer.from('metadata'), pkb(S.ADDRESSES.metaplex), pkb(mint), Buffer.from('edition')], S.ADDRESSES.metaplex)[0],
    'the metadata of the Coin address': S.metadataAddress(coin),
    'the mint itself': mint,
  };
  const watch = [coin, mint, vault, right, w.P.approval(1510n), w.P.ticker('META')];
  for (const [what, addr] of Object.entries(wrong)) {
    await refuse(w, watch, () => w.send([w.ix.launch({ founder: founder.address, cityId: 1510n, configId: 0, symbol: 'META', rentPayer: w.admin.address, overrides: { metadata: addr } })], [founder], `launch with ${what}`),
      'InvalidAddress', 'ConstraintSeeds', /already in use/);
    assert.equal(w.exists(coin), false, `${what}: no Coin was created`);
  }
  // the Metaplex program slot: another executable program is refused before any CPI
  for (const prog of [S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram, S.ADDRESSES.token]) {
    await refuse(w, watch, () => w.send([w.ix.launch({ founder: founder.address, cityId: 1510n, configId: 0, symbol: 'META', rentPayer: w.admin.address, overrides: { metadata_program: prog } })], [founder], `launch with metadata_program ${prog.slice(0, 6)}`), 'InvalidAddress');
  }
  // the other fixed slots of launch: the Rent sysvar, System, the fee recipient
  const randomKey = (await generateKeyPairSigner()).address;
  for (const [slot, addr, ...codes] of [['rent', randomKey, 'AccountSysvarMismatch', /sysvar|Sysvar/], ['rent', S.ADDRESSES.system, 'AccountSysvarMismatch', /sysvar|Sysvar/],
    ['system_program', S.ADDRESSES.token, 'InvalidProgramId'], ['fee_recipient', founder.address, 'InvalidAddress'], ['legacy_launchpad', randomKey, 'InvalidAddress'], ['legacy_approval', w.P.legacyApproval(1511n), 'InvalidAddress']]) {
    await refuse(w, watch, () => w.send([w.ix.launch({ founder: founder.address, cityId: 1510n, configId: 0, symbol: 'META', rentPayer: w.admin.address, overrides: { [slot]: addr } })], [founder], `launch with ${slot} := ${addr.slice(0, 6)}`), ...codes);
  }
  const h = await w.launch({ cityId: 1510n, founder });
  assert.equal(readMetadata(w.accountInfo(right).data).mint, h.mint);
  await w.finish();
});

// ---------------------------------------------------------------- X29
test('X29 re-initialisation of every account is refused (plain init everywhere): Launchpad, LaunchConfig, Approval, Coin, mint, vault, TickerLock, PayoutOptIn', async () => {
  const w = await World.create();
  const founder = await w.signer(10n);
  const h = await w.launchCoin({ cityId: 1520n, founder, symbol: 'INIT' });
  const u = await w.signer(50n);
  await w.buy(u, h, 3n * LAMPORTS);
  const all = () => [w.P.launchpad(), w.P.config(0), ...coinAccounts(h), w.P.ticker('INIT')];
  // Launchpad: a second init_launchpad, even by the upgrade authority, with another admin
  const stranger = await w.signer(5n);
  await refuse(w, all(), () => w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: stranger.address, upgradeAuthority: w.deployer.address, guardian: stranger.address })], [stranger, w.deployer], 're-init Launchpad'), /already in use/);
  // LaunchConfig: the seed is next_config_id, so an existing config can never be named again
  await refuse(w, all(), () => w.send([w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: 0, params: { ...S.DEFAULT_CONFIG, platformBps: 120n, liquidityBps: 0n } })], [w.admin], 're-init config #0'), 'ConstraintSeeds', /already in use/);
  // Approval: a second approval for a pending city
  await w.approve({ cityId: 1521n, founder, symbol: 'PEND' });
  const apBytes = w.accountInfo(w.P.approval(1521n)).data;
  await refuse(w, [w.P.approval(1521n)], () => w.approve({ cityId: 1521n, founder: stranger, symbol: 'PEND2' }), /already in use/);
  assert.ok(w.accountInfo(w.P.approval(1521n)).data.equals(apBytes));
  // Coin, mint, vault: a launched city can never be approved again ...
  await refuse(w, all(), () => w.approve({ cityId: 1520n, founder: stranger, symbol: 'AGAIN' }), 'CoinAlreadyLaunched');
  // ... and even an Approval written out of band for it (no instruction can create one) meets plain init on the Coin
  const ap = w.accountInfo(w.P.approval(1521n));
  const forged = Buffer.from(ap.data); forged.writeBigUInt64LE(1520n, 8); pkb(stranger.address).copy(forged, 16);
  const [forgedAddr, forgedBump] = S.findPda([Buffer.from('approval'), u64b(1520n)], w.programId);
  const apView = S.decodeApproval({ owner: w.programId, data: forged }, { programId: w.programId });
  const bumpAt = 114 + 4 + Buffer.byteLength(apView.name) + 4 + Buffer.byteLength(apView.symbol) + 16;
  forged[bumpAt] = forgedBump;
  w.setRaw(forgedAddr, forged, w.programId, ap.lamports);
  await refuse(w, all(), () => w.send([w.ix.launch({ founder: stranger.address, cityId: 1520n, configId: 0, symbol: 'PEND', rentPayer: w.admin.address })], [stranger], 're-init Coin, mint and vault through a forged approval'), /already in use/);
  w.setRaw(forgedAddr, Buffer.alloc(0), S.ADDRESSES.system, 0n);
  // TickerLock: two approvals may name one ticker; the second launch meets plain init on the lock
  const f2 = await w.signer(10n);
  await w.approve({ cityId: 1522n, founder: f2, symbol: 'PEND' });
  await w.launch({ cityId: 1521n, founder });
  const lock = w.accountInfo(w.P.ticker('PEND')).data;
  await refuse(w, [w.P.ticker('PEND'), ...Object.values(w.P.coinAccounts(1522n))], () => w.launch({ cityId: 1522n, founder: f2 }), /already in use/);
  assert.ok(w.accountInfo(w.P.ticker('PEND')).data.equals(lock), 'the lock still names the first coin');
  // PayoutOptIn: twice is refused; after a revoke a new one is a new account (and the cooldown lives on the Coin, X51)
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  const opt = (label) => w.send([w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(9) })], [founder], label);
  await opt('opt in');
  const oi = w.accountInfo(w.P.payoutOptIn(h.coin)).data;
  await refuse(w, [w.P.payoutOptIn(h.coin)], () => opt('opt in again'), /already in use/);
  assert.ok(w.accountInfo(w.P.payoutOptIn(h.coin)).data.equals(oi));
  await w.finish();
});

// ---------------------------------------------------------------- X30, X39
test('X30, X39: nobody can close, freeze, delegate, re-authorise, mint into or burn from a coin\'s accounts; the mint has no mint or freeze authority; a closed approval cannot be revived', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1530n, symbol: 'SHUT' });
  const u = await w.signer(50n); const attacker = await w.signer(50n);
  await w.buy(u, h, 5n * LAMPORTS);
  await w.buy(attacker, h, LAMPORTS);
  const uAta = S.associatedTokenAddress(u.address, h.mint);
  const aAta = S.associatedTokenAddress(attacker.address, h.mint);
  const watch = [...coinAccounts(h), uAta];
  const tx = (ixs, label) => () => w.send(ixs, [attacker], label);
  const OWNER = /owner does not match|0x4\b/i;
  // the vault: every authority instruction signed by the attacker is refused (the authority is the Coin PDA, which only the program signs)
  await refuse(w, watch, tx([T.close(h.vault, attacker.address, attacker.address)], 'close the vault'), OWNER, /non-native account can only be closed if its balance is zero|0xb\b/i);
  await refuse(w, watch, tx([T.transfer(h.vault, aAta, attacker.address, 1n)], 'transfer out of the vault'), OWNER);
  await refuse(w, watch, tx([T.burn(h.vault, h.mint, attacker.address, 1n)], 'burn from the vault'), OWNER);
  await refuse(w, watch, tx([T.approve(h.vault, attacker.address, attacker.address, 1n)], 'delegate the vault'), OWNER);
  await refuse(w, watch, tx([T.setAuthority(h.vault, attacker.address, 3, attacker.address)], 'set the vault\'s close authority'), OWNER);
  await refuse(w, watch, tx([T.setAuthority(h.vault, attacker.address, 2, attacker.address)], 'take the vault\'s owner'), OWNER);
  // the mint: no mint authority, no freeze authority (I11); every attempt is refused
  const m = mintInfo(w.accountInfo(h.mint));
  assert.deepEqual([m.mintAuthority, m.freezeAuthority], [null, null]);
  await refuse(w, watch, tx([T.mintTo(h.mint, aAta, attacker.address, 1n)], 'mint more'), /fixed supply|0x5\b/i);
  await refuse(w, watch, tx([T.setAuthority(h.mint, attacker.address, 0, attacker.address)], 'take the mint authority'), /fixed supply|0x5\b/i);
  await refuse(w, watch, tx([T.setAuthority(h.mint, attacker.address, 1, attacker.address)], 'take the freeze authority'), /cannot freeze|0x10\b/i);
  await refuse(w, watch, tx([T.freeze(uAta, h.mint, attacker.address)], 'freeze a holder'), /cannot freeze|0x10\b/i);
  await refuse(w, watch, tx([T.freeze(h.vault, h.mint, attacker.address)], 'freeze the vault'), /cannot freeze|0x10\b/i);
  // the Coin: owned by vicinity_curve; a system transfer out of it needs a signature nobody can give, and no instruction closes it
  const coinIx = sys.transfer(h.coin, attacker.address, 1n);
  const e = await expectFail(() => w.send([{ ...coinIx, accounts: [{ address: h.coin, role: R.W }, coinIx.accounts[1]] }], [attacker], 'system transfer out of the Coin'));
  assert.ok(/MissingRequiredSignature|signature|from must not carry data|Transfer: `from` must not carry data|InvalidAccountData|instruction requires/i.test(`${e.logs.join('\n')}\n${e.errText}`), e.message);
  // revival: the launch closed the approval; a new approval for the city is refused for good
  await refuse(w, watch, () => w.approve({ cityId: 1530n, founder: attacker, symbol: 'SHUT2' }), 'CoinAlreadyLaunched');
  // the holder's own account is the holder's: he may close it once empty, which touches no coin account
  await w.sell(attacker, h, w.balanceOf(attacker, h.mint), { label: 'attacker sells all' });
  await w.send([T.close(aAta, attacker.address, attacker.address)], [attacker], 'attacker closes his empty token account');
  const v = tokenAccountInfo(w.accountInfo(h.vault));
  assert.deepEqual([v.owner, v.delegate, v.closeAuthority, v.state], [h.coin, null, null, 1]);
  await w.finish();
});

// ---------------------------------------------------------------- X37
test('X37 the metadata cannot be edited later: Metaplex refuses every update (immutable, update authority the Coin PDA); name, symbol, URI and meta_hash stay', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1540n, symbol: 'IMMU', name: 'Immutable' });
  const attacker = await w.signer(10n);
  const meta = S.metadataAddress(h.mint);
  const watch = [meta, h.coin];
  const hash0 = [...w.coinView(h).metaHash];
  const dataV2 = Buffer.concat([borshStr('Hacked'), borshStr('IMMU'), borshStr('https://evil.example/x.json'), Buffer.from([0, 0]), Buffer.from([0, 0, 0])]);
  await refuse(w, watch, () => w.send([metaplexUpdate({ metadata: meta, authority: attacker.address, newAuthority: attacker.address })], [attacker], 'take the update authority'),
    /update authority|immutable|0x7\b|0x2c\b|IncorrectOwner|Invalid/i);
  await refuse(w, watch, () => w.send([metaplexUpdate({ metadata: meta, authority: attacker.address, newAuthority: attacker.address, data: dataV2 })], [attacker], 'rewrite the name and URI'),
    /update authority|immutable|0x7\b|0x2c\b|Invalid/i);
  const md = readMetadata(w.accountInfo(meta).data);
  assert.deepEqual([md.name, md.symbol, md.uri, md.isMutable, md.updateAuthority], ['Immutable', 'IMMU', S.metadataUri(h.mint), false, h.coin]);
  assert.deepEqual([...w.coinView(h).metaHash], hash0, 'the approved meta_hash stays in the Coin');
  await w.finish();
});

// ---------------------------------------------------------------- X38
test('X38 Unicode spoofing: every control, invisible (default-ignorable or format) and blank character, and a leading, trailing or doubled space, is refused in a name; ordinary UTF-8 city names pass', async () => {
  const w = await World.create();
  const founder = await w.signer(10n);
  const send = (cityId, name, symbol) => w.send([w.ix.approveLaunch({ admin: w.admin.address, cityId, founder: founder.address, configId: 0, name, symbol, metaHash: metaHash(name), expiresAt: w.now() + DAY })], [w.admin], `approve ${JSON.stringify(name)}`);
  const bad = [0x00, 0x09, 0x0a, 0x1b, 0x7f, 0x85, 0x9f, 0xad, 0x600, 0x605, 0x61c, 0x6dd, 0x70f, 0x890, 0x8e2, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0x110bd, 0x13430, 0x1bca0,
    0x1d173, 0xe0001, 0xe0041, 0xe007f,
    // review FA-1: the rest of Unicode's default-ignorable code points (the Hangul fillers, the combining grapheme joiner,
    // Khmer inherent vowels, Mongolian and other variation selectors, reserved ignorables) and blank characters
    0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2065, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xfff0, 0xfff8, 0xe0000, 0xe0100, 0xe0fff,
    0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x2800, 0x3000, 0x1d159];
  let city = 1550n;
  for (const cp of bad) {
    for (const name of [`Pa${String.fromCodePoint(cp)}ris`, `Paris${String.fromCodePoint(cp)}`]) {
      await expectFail(() => send(city, name, 'PARIS'), 'BadName');
      assert.equal(w.approval(city), null);
    }
  }
  // the review's names, which looked exactly like "Paris" in the approval and in the immutable metadata; blank names; spaces
  for (const name of ['Paris\u3164', 'Pari\u034Fs', '\u3164\u3164\u3164', ' ', ' Paris', 'Paris ', 'New  York']) {
    await expectFail(() => send(city, name, 'PARIS'), 'BadName');
    assert.equal(w.approval(city), null);
  }
  for (const name of ['São Paulo', 'Zürich', '東京', 'Москва', 'Kraków-Śródmieście', "N'Djamena", 'New York City Coin', 'x'.repeat(32), 'é'.repeat(16)]) {
    city++;
    await send(city, name, `C${city}`);
    assert.equal(w.approval(city).name, name);
  }
  await expectFail(() => send(city + 1n, 'é'.repeat(16) + 'x', 'LONG'), 'BadName');
  // the longest multi-byte name launches: Metaplex takes the same 32 bytes, unchanged
  const h = await w.launch({ cityId: city, founder });
  assert.equal(readMetadata(w.accountInfo(S.metadataAddress(h.mint)).data).name, 'é'.repeat(16));
  await w.finish();
});

// ---------------------------------------------------------------- X54
test('X54 aliased accounts: the vault, the Coin PDA\'s token accounts, the Coin or the opt-in in another slot are refused; the Coin PDA never signs from outside', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1560n, symbol: 'ALIAS' });
  const u = await w.signer(50n);
  await w.buy(u, h, 5n * LAMPORTS);
  const uAta = S.associatedTokenAddress(u.address, h.mint);
  const coinAta = S.associatedTokenAddress(h.coin, h.mint);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: u.address, owner: h.coin, mint: h.mint })], [u], 'an ATA of the Coin PDA');
  // a token account at a fresh address with the Coin PDA as owner (any account whose authority is the Coin)
  const other = await generateKeyPairSigner();
  await w.send([sys.createAccount(u.address, other.address, w.svm.minimumBalanceForRentExemption(165n), 165n, S.ADDRESSES.token), T.initAccount3(other.address, h.mint, h.coin)], [u, other], 'another token account owned by the Coin PDA');
  const watch = [...coinAccounts(h), uAta, coinAta, other.address];
  const buy = (o) => () => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides: o })], [u], `buy ${JSON.stringify(o).slice(0, 60)}`);
  const sell = (o) => () => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 1_000_000n, minSolOut: 0n, overrides: o })], [u], `sell ${JSON.stringify(o).slice(0, 60)}`);
  for (const ta of [h.vault, coinAta, other.address]) {
    await refuse(w, watch, buy({ user_token_account: ta }), 'SameAccount');
    await refuse(w, watch, sell({ user_token_account: ta }), 'SameAccount', 'WrongTokenAccount');
  }
  // the user's own token account in the vault slot; the vault in the mint slot; the Launchpad and the Coin swapped
  await refuse(w, watch, buy({ coin_vault: uAta }), 'InvalidAddress');
  await refuse(w, watch, sell({ coin_vault: uAta }), 'InvalidAddress');
  await refuse(w, watch, buy({ mint: h.vault }), 'AccountDidNotDeserialize', 'InvalidAddress', /deserialize|Discriminator|InvalidAccountData/i);
  await refuse(w, watch, buy({ coin: w.P.launchpad() }), 'AccountDiscriminatorMismatch', 'ConstraintSeeds', /Discriminator|deserialize/i);
  await refuse(w, watch, buy({ launchpad: h.coin }), 'AccountDiscriminatorMismatch', 'ConstraintSeeds', /Discriminator|deserialize/i);
  await refuse(w, watch, sell({ launchpad: h.coin }), 'ConstraintSeeds');
  // the Coin as the platform fee recipient, a sell's buyer-side account or the payout wallet
  await refuse(w, watch, () => w.send([w.ix.withdrawPlatformFees({ coin: h.coin, overrides: { fee_recipient: h.coin } })], [], 'withdraw to the Coin', { feePayer: w.keeper }), 'InvalidAddress', /AccountLoadedTwice|loaded twice/i);
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(5) })], [h.founder], 'opt in');
  // the admin points the payout wallet at program-owned accounts (the Coin itself, the opt-in): no opt-in names them, and they are not System-owned
  for (const dest of [h.coin, w.P.payoutOptIn(h.coin), h.vault]) {
    await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: dest })], [w.admin], `payout wallet := ${dest.slice(0, 6)}`);
    await refuse(w, [...watch, dest], () => w.payout(h, { destination: dest, label: `payout to ${dest.slice(0, 6)}` }), 'DestinationMismatch', 'InvalidAddress', /AccountLoadedTwice|loaded twice/i);
  }
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'payout wallet back');
  // the same account in two writable slots of a sell: the vault as both the vault and the user's account
  await refuse(w, watch, sell({ user_token_account: h.vault, coin_vault: h.vault }), 'SameAccount', 'WrongTokenAccount');
  // the Coin PDA as the signing authority of a token transfer: no transaction can carry its signature
  const signed = T.transfer(h.vault, uAta, h.coin, 1n);
  await assert.rejects(() => w.send([signed], [], 'transfer signed by the Coin PDA'), /signer|signature|missing/i);
  await w.payout(h, { destination: wallet.address });
  await w.finish();
});

// ---------------------------------------------------------------- X55
test('X55 pre-funded PDAs: lamports sent ahead to the Launchpad, a config, an approval, the Coin, its mint, vault, ticker lock, metadata and opt-in never block init; the Coin keeps the surplus as an uncounted donation', async () => {
  const w = await World.create({ initLaunchpad: false });
  const attacker = await w.signer(100n);
  const rent = (n) => w.svm.minimumBalanceForRentExemption(BigInt(n));
  const fund = (to, n, label, o = {}) => w.send([sys.transfer(attacker.address, to, n)], [attacker], `pre-fund ${label}`, o);
  // the Launchpad and config #0 before they exist
  await fund(w.P.launchpad(), rent(0), 'Launchpad (the minimum an empty account may hold)');
  await w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })], [w.admin, w.deployer], 'init_launchpad over a pre-funded PDA');
  await fund(w.P.config(0), rent(144) + 5n, 'config #0 (above rent)');
  await w.addConfig(S.DEFAULT_CONFIG);
  assert.equal(w.lamportsOf(w.P.config(0)), rent(144) + 5n, 'the config keeps the extra lamports');
  // two cities: one pre-funded below the Coin's rent (absorbed into the rent), one above it (a donation)
  const founder = await w.signer(50n);
  const coins = {};
  const below = rent(0) + 1_000n; const above = rent(693) + 777_777n;
  for (const [cityId, sym, coinFund] of [[1570n, 'PREA', below], [1571n, 'PREB', above]]) {
    const { coin, mint, vault } = w.P.coinAccounts(cityId);
    await fund(w.P.approval(cityId), rent(0) + 3n, `approval ${cityId}`);
    // the part of a pre-funded Coin above its rent is surplus that no counter sees (I9 with donations); below it, init absorbs it
    // into the rent. A pre-funded Coin address is still empty for approve_launch (System-owned, no data): fund one before the approval
    const fundCoin = () => fund(coin, coinFund, `Coin ${cityId}`, { lamportDonation: { coin, amount: coinFund > rent(693) ? coinFund - rent(693) : 0n } });
    if (sym === 'PREA') await fundCoin();
    await w.approve({ cityId, founder, symbol: sym });
    if (sym !== 'PREA') await fundCoin();
    await fund(mint, rent(0) + 11n, `mint ${cityId}`);
    await fund(vault, rent(165) + 9n, `vault ${cityId}`);
    await fund(w.P.ticker(sym), rent(0) + 13n, `ticker ${sym}`);
    await fund(S.metadataAddress(mint), rent(0) + 17n, `metadata ${cityId}`);
    const h = await w.launch({ cityId, founder });
    const c = w.coinView(h);
    assert.equal(c.rentReserve, rent(693), 'rent_reserve is the rent figure, never the balance');
    assert.equal(w.lamportsOf(h.coin), c.rentReserve + (coinFund > rent(693) ? coinFund - rent(693) : 0n));
    assert.equal(tokenAccountInfo(w.accountInfo(h.vault)).amount, c.curveSupply + c.poolSupply, 'the vault holds S + P');
    assert.equal(readMetadata(w.accountInfo(S.metadataAddress(h.mint)).data).mint, h.mint);
    coins[sym] = h;
  }
  // the donation never changes a price or an amount: the same trades on both coins give the same state
  const u = await w.signer(500n);
  for (const sol of [3n, 7n]) for (const h of [coins.PREA, coins.PREB]) await w.buy(u, h, sol * LAMPORTS, { label: `buy ${sol} SOL ${h.cityId}` });
  assert.deepEqual(S.coinState(w.coinView(coins.PREA)), S.coinState(w.coinView(coins.PREB)), 'identical state with and without the pre-funded surplus');
  // the opt-in PDA pre-funded: opting in still works; its lamports (with the donation) return to the founder on revoke
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  await fund(w.P.payoutOptIn(coins.PREB.coin), rent(0) + 21n, 'opt-in');
  await w.send([w.ix.optInPayout({ founder: founder.address, coin: coins.PREB.coin, expectedDestination: wallet.address, refHash: Array(32).fill(3) })], [founder], 'opt in over a pre-funded PDA');
  // every exit still pays exactly its amount; the surplus stays in the Coin
  await w.claim(coins.PREB, founder);
  await w.withdraw(coins.PREB);
  await w.sell(u, coins.PREB, w.balanceOf(u, coins.PREB.mint) / 2n, { label: 'sell from the pre-funded coin' });
  const c = w.coinView(coins.PREB);
  assert.equal(w.lamportsOf(coins.PREB.coin), c.rentReserve + S.liabilities(S.coinState(c)) + 777_777n);
  await w.finish();
});

// ---------------------------------------------------------------- X60
test('X60 re-entrancy (closest testable shape): every money instruction calls only System, SPL Token, Metaplex and its own event CPI; no slot can make it call another program', async () => {
  const w = await World.create();
  const founder = await w.signer(200n);
  await w.approve({ cityId: 1580n, founder, symbol: 'CPI' });
  const results = [];
  const keep = async (p) => { const r = await p; results.push(r); return r; };
  const h = await w.launch({ cityId: 1580n, founder });
  results.push(h.res);
  const u = await w.signer(500n);
  await w.initRewardsCity(h);
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  await w.send([w.ix.optInPayout({ founder: founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(1) })], [founder], 'opt in');
  const b = await w.buy(u, h, 10n * LAMPORTS); results.push(b.res);
  results.push((await w.sell(u, h, b.q.tokensOut / 3n)).res);
  w.warpSlots(200n);
  await keep(w.buyback(h));
  await keep(w.withdraw(h));
  await keep(w.claim(h, founder));
  await keep(w.forward(h));
  results.push((await w.buy(u, h, 2n * LAMPORTS)).res);
  await keep(w.payout(h, { destination: wallet.address }));
  results.push((await w.buy(u, h, 100n * LAMPORTS, { label: 'graduating buy' })).res);
  const allowed = new Set([S.ADDRESSES.system, S.ADDRESSES.token, S.ADDRESSES.metaplex, w.programId]);
  for (const r of results) {
    for (const t of r.top.filter((x) => x.program === w.programId)) {
      for (const ii of t.inner) {
        assert.ok(allowed.has(ii.program), `${t.name} called ${ii.program}`);
        if (ii.program === w.programId) assert.deepEqual(ii.accounts, [w.P.eventAuthority()], `${t.name}: a self-CPI is only the event CPI`);
        if (ii.program === S.ADDRESSES.metaplex) assert.equal(t.name, 'launch', 'Metaplex only in launch');
      }
    }
  }
  // program slots filled with real, executable programs that could call back: refused before any CPI
  const watch = coinAccounts(h);
  for (const prog of [S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram, w.programId, S.ADDRESSES.metaplex]) {
    await refuse(w, watch, () => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides: { token_program: prog } })], [u], `buy, token_program := ${prog.slice(0, 6)}`), 'InvalidProgramId');
    await refuse(w, watch, () => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides: { system_program: prog } })], [u], `buy, system_program := ${prog.slice(0, 6)}`), 'InvalidProgramId');
    await refuse(w, watch, () => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 1_000_000n, minSolOut: 0n, overrides: { token_program: prog } })], [u], `sell, token_program := ${prog.slice(0, 6)}`), 'InvalidProgramId');
    if (prog !== w.programId) {
      await refuse(w, watch, () => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides: { program: prog } })], [u], `buy, program := ${prog.slice(0, 6)}`));
    }
  }
  await w.finish();
});

// ---------------------------------------------------------------- X64
test('X64 init_launchpad by a stranger: front-running, a fake ProgramData, and an immutable program are all refused; only the upgrade authority initialises', async () => {
  const w = await World.create({ initLaunchpad: false });
  const stranger = await w.signer(10n);
  const lp = w.P.launchpad();
  const init = (upgradeAuthority, signers, label, overrides) => w.send([w.ix.initLaunchpad({ payer: stranger.address, admin: stranger.address, upgradeAuthority, guardian: stranger.address, overrides })], signers, label, { feePayer: stranger });
  // the stranger races the deployer, naming himself the upgrade authority
  await refuse(w, [lp], () => init(stranger.address, [stranger], 'stranger front-runs'), 'NotUpgradeAuthority');
  // a fake ProgramData: a loader-owned account elsewhere naming the stranger, and another program's real ProgramData
  const pd = w.accountInfo(w.P.programData());
  const fakePd = Buffer.from(pd.data); pkb(stranger.address).copy(fakePd, 13);
  const fakeAddr = (await generateKeyPairSigner()).address;
  w.setRaw(fakeAddr, fakePd, S.ADDRESSES.upgradeableLoader, pd.lamports);
  await refuse(w, [lp], () => init(stranger.address, [stranger], 'fake ProgramData', { program_data: fakeAddr }), 'NotUpgradeAuthority');
  const rewardsPd = S.findPda([pkb(S.CLUSTERS.mainnet.rewardsProgram)], S.ADDRESSES.upgradeableLoader)[0];
  await refuse(w, [lp], () => init(w.deployer.address, [stranger, w.deployer], 'another program\'s ProgramData', { program_data: rewardsPd }), 'NotUpgradeAuthority');
  // the deployer's signature with a stranger as admin is fine for the program (the admin signs); without the admin's signature it is not
  const noAdminSig = w.ix.initLaunchpad({ payer: stranger.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: stranger.address, overrides: { admin: { address: w.admin.address, role: R.R } } });
  await refuse(w, [lp], () => w.send([noAdminSig], [stranger, w.deployer], 'admin not signing', { feePayer: stranger }), /MissingRequiredSignature|signer/i);
  // an immutable program (no upgrade authority) can never be initialised, not even by the former authority
  const immutable = Buffer.from(pd.data); immutable[12] = 0;
  w.setRaw(w.P.programData(), immutable, S.ADDRESSES.upgradeableLoader, pd.lamports);
  await refuse(w, [lp], () => init(w.deployer.address, [stranger, w.deployer], 'immutable program'), 'NotUpgradeAuthority');
  w.setRaw(w.P.programData(), pd.data, S.ADDRESSES.upgradeableLoader, pd.lamports);
  assert.equal(w.exists(lp), false, 'nothing created');
  await w.send([w.ix.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, guardian: w.guardian.address })], [w.admin, w.deployer], 'init_launchpad');
  assert.equal(w.launchpad().admin, w.admin.address);
  await w.finish();
});
