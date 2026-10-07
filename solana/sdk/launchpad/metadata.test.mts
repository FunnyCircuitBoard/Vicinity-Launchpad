// metadata.mts: the "Launched on Vicinity" JSON (design 8.2), the on-chain uri
// rule, the program's name and symbol rules, and Meteora partner metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinMetadataJson, coinMetadataUri, coinImageUrl, checkName, checkSymbol, checkMetadataAgainstChain, buildPartnerMetadata, VICINITY_BRAND, MAX_URI_BYTES } from './metadata.mts';
import { coderFor, IDL, constant } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, dbc } from './pda.mjs';

const MINT = 'So11111111111111111111111111111111111111112'.replace('So1', 'Ci7'); // any base58 address
const NYC = { id: 5128581, name: 'New York City', country: 'US', ticker: 'NYC' };

test('the JSON matches design 8.2: Vicinity, its logo, createdOn vicinity.city, network Solana', () => {
  const j = coinMetadataJson({ mint: MINT, name: 'New York City Coin', symbol: 'NYC', city: NYC });
  assert.deepEqual(j, {
    name: 'New York City Coin', symbol: 'NYC',
    description: 'The city coin of New York City. Launched on Vicinity (https://vicinity.city) on Solana.',
    image: `https://vicinity.city/coin-meta/${MINT}.png`, external_url: 'https://vicinity.city/c/5128581',
    createdOn: 'https://vicinity.city', launchpad: 'Vicinity', launchpadLogo: 'https://vicinity.city/brand/vicinity-512.png', network: 'Solana',
    city: { id: 5128581, name: 'New York City', country: 'US', ticker: 'NYC' }, showName: true,
    attributes: [{ trait_type: 'Launchpad', value: 'Vicinity' }, { trait_type: 'Network', value: 'Solana' }, { trait_type: 'City', value: 'New York City' }],
    website: 'https://vicinity.city/c/5128581',
  });
  const withLogo = coinMetadataJson({ mint: MINT, name: 'NYC', symbol: 'NYC', city: NYC, image: 'https://vicinity.city/media/abc.png', pitch: 'Five boroughs, one coin.', twitter: 'https://x.com/nyccoin' });
  assert.equal(withLogo.image, 'https://vicinity.city/media/abc.png');
  assert.match(withLogo.description, /^Five boroughs, one coin\. Launched on Vicinity/);
  assert.equal(withLogo.twitter, 'https://x.com/nyccoin');
});

test('the uri is what the program writes on chain, and fits Metaplex', () => {
  assert.equal(VICINITY_BRAND.metadataPrefix, JSON.parse(constant(IDL.launchpad, 'METADATA_URI_PREFIX')));
  const uri = coinMetadataUri('Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7');
  assert.equal(uri, 'https://vicinity.city/coin-meta/Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7.json');
  assert.ok(Buffer.byteLength(uri) <= MAX_URI_BYTES);
  assert.equal(coinImageUrl('abc'), 'https://vicinity.city/coin-meta/abc.png');
});

test('name and symbol rules are the program\'s (math.rs check_name / check_symbol)', () => {
  assert.equal(checkName('São Paulo'), null);
  assert.equal(checkName('x'.repeat(32)), null);
  assert.match(String(checkName('x'.repeat(33))), /1 to 32 bytes/);
  assert.match(String(checkName('ã'.repeat(17))), /1 to 32 bytes/, '34 bytes in UTF-8');
  assert.match(String(checkName('')), /1 to 32/);
  assert.match(String(checkName('a\nb')), /control/);
  assert.equal(checkSymbol('NYC'), null);
  assert.equal(checkSymbol('ABCDEFGHIJ'), null);
  for (const bad of ['nyc', 'ABCDEFGHIJK', 'NY-C', '', 'É']) assert.ok(checkSymbol(bad), bad);
  assert.throws(() => coinMetadataJson({ mint: MINT, name: 'X', symbol: 'LA', city: NYC }), /city ticker/);
  assert.throws(() => coinMetadataJson({ mint: MINT, name: 'X', symbol: 'NYC', city: NYC, pitch: 'visit https://scam.example' }), /links/);
  assert.throws(() => coinMetadataJson({ mint: MINT, name: 'X', symbol: 'NYC', city: NYC, pitch: `send to ${MINT}` }), /links or addresses/);
});

test('a served JSON is checked against the on-chain metadata', () => {
  const j = coinMetadataJson({ mint: MINT, name: 'NYC Coin', symbol: 'NYC', city: NYC });
  assert.deepEqual(checkMetadataAgainstChain(j, { mint: MINT, name: 'NYC Coin', symbol: 'NYC', uri: coinMetadataUri(MINT) }), []);
  const p = checkMetadataAgainstChain({ ...j, name: 'Other' }, { mint: MINT, name: 'NYC Coin', symbol: 'NYC', uri: 'https://elsewhere/x.json' });
  assert.equal(p.length, 2);
});

test('Meteora partner metadata: "Vicinity", the site and the logo, signed by the dev wallet', () => {
  const ix = buildPartnerMetadata();
  assert.equal(ix.programAddress, PROGRAM_IDS.dbc);
  const signers = ix.accounts.filter((a) => a.role & 2).map((a) => a.address);
  assert.deepEqual([...new Set(signers)], [ADDRESSES.feeRecipient], 'payer and fee claimer: the dev wallet');
  assert.equal(ix.accounts[0].address, dbc.partnerMetadata(ADDRESSES.feeRecipient));
  const d = coderFor(IDL.dbc).instruction.decode(Buffer.from(ix.data)) as { name: string; data: { metadata: { name: string; website: string; logo: string } } };
  assert.equal(d.name, 'create_partner_metadata');
  assert.deepEqual([d.data.metadata.name, d.data.metadata.website, d.data.metadata.logo], ['Vicinity', 'https://vicinity.city', 'https://vicinity.city/brand/vicinity-512.png']);
});
