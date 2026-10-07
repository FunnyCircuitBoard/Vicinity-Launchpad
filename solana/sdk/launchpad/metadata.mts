// Vicinity branding for city coins (LAUNCHPAD-DESIGN.md section 8).
//
// On chain, our program writes each coin's Metaplex metadata once, at launch,
// and it can never change: name (the founder's coin name), symbol (the city
// ticker) and uri = https://vicinity.city/coin-meta/<mint>.json. This module
// builds the JSON the site serves at that URL (what wallets, explorers and
// Jupiter read for the image, "Launched on Vicinity", createdOn and the
// network), the matching icon and coin-page URLs, and the one-time Meteora
// partner metadata ("Vicinity" with its logo) the dev wallet signs.
import { buildIx, IDL } from './idl.mjs';
import { ADDRESSES, dbc } from './pda.mjs';
import type { Address } from './accounts.mts';
import type { Ix } from './trade.mts';

export const VICINITY_BRAND = Object.freeze({
  name: 'Vicinity',
  site: 'https://vicinity.city',
  /** square PNG on a solid background, at least 512 px (wallets do not render SVG); rendered from public/logo.svg */
  logo: 'https://vicinity.city/brand/vicinity-512.png',
  network: 'Solana',
  /** must equal the program constant METADATA_URI_PREFIX */
  metadataPrefix: 'https://vicinity.city/coin-meta/',
});

export const MAX_NAME_BYTES = 32;
export const MAX_SYMBOL_BYTES = 10;
/** Metaplex's limit on the uri field. */
export const MAX_URI_BYTES = 200;

/** The on-chain metadata uri our program builds for a mint (math.rs `metadata_uri`). */
export function coinMetadataUri(mint: Address): string {
  return `${VICINITY_BRAND.metadataPrefix}${mint}.json`;
}
export function coinImageUrl(mint: Address): string {
  return `${VICINITY_BRAND.metadataPrefix}${mint}.png`;
}
export function coinPageUrl(cityId: bigint | number): string {
  return `${VICINITY_BRAND.site}/c/${cityId}`;
}

const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The program's name rule (math.rs check_name): 1 to 32 bytes, no control characters. */
export function checkName(name: string): string | null {
  if (name.length === 0 || utf8Len(name) > MAX_NAME_BYTES) return `name must be 1 to ${MAX_NAME_BYTES} bytes (UTF-8)`;
  if (CONTROL.test(name)) return 'name must not contain control characters';
  return null;
}
/** The program's symbol rule (math.rs check_symbol): 1 to 10 of A-Z and 0-9, the city ticker. */
export function checkSymbol(symbol: string): string | null {
  return /^[A-Z0-9]{1,10}$/.test(symbol) ? null : `symbol must be 1 to ${MAX_SYMBOL_BYTES} characters of A-Z and 0-9`;
}

export interface CityInfo { id: bigint | number; name: string; country?: string; ticker: string }
export interface CoinMetadataInput {
  mint: Address;
  /** the on-chain name (the founder's coin name, at most 32 bytes) */
  name: string;
  /** the on-chain symbol (the city ticker) */
  symbol: string;
  city: CityInfo;
  /** the founder's approved logo URL; default: the coin's icon URL on vicinity.city (decision D12) */
  image?: string;
  /** the founder's short pitch (no links); default "The city coin of <city>." */
  pitch?: string;
  twitter?: string;
  telegram?: string;
}
export interface CoinMetadataJson {
  name: string; symbol: string; description: string; image: string; external_url: string;
  createdOn: string; launchpad: string; launchpadLogo: string; network: string;
  city: { id: number; name: string; country?: string; ticker: string };
  showName: boolean;
  attributes: { trait_type: string; value: string }[];
  twitter?: string; telegram?: string; website: string;
}

/**
 * The JSON served at https://vicinity.city/coin-meta/<mint>.json (design 8.2).
 * `name` and `symbol` must equal the on-chain values for ever; the site serves
 * this only for mints that have an on-chain Coin record.
 */
export function coinMetadataJson(i: CoinMetadataInput): CoinMetadataJson {
  const nameErr = checkName(i.name), symErr = checkSymbol(i.symbol);
  if (nameErr) throw new Error(nameErr);
  if (symErr) throw new Error(symErr);
  if (i.symbol !== i.city.ticker) throw new Error(`symbol ${i.symbol} must be the city ticker ${i.city.ticker}`);
  if (i.pitch && /https?:|www\.|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(i.pitch)) throw new Error('the pitch must not contain links or addresses');
  const cityId = Number(i.city.id);
  const lead = i.pitch ? `${i.pitch.trim()} ` : `The city coin of ${i.city.name}. `;
  const out: CoinMetadataJson = {
    name: i.name,
    symbol: i.symbol,
    description: `${lead}Launched on Vicinity (${VICINITY_BRAND.site}) on Solana.`,
    image: i.image ?? coinImageUrl(i.mint),
    external_url: coinPageUrl(cityId),
    createdOn: VICINITY_BRAND.site,
    launchpad: VICINITY_BRAND.name,
    launchpadLogo: VICINITY_BRAND.logo,
    network: VICINITY_BRAND.network,
    city: { id: cityId, name: i.city.name, ...(i.city.country ? { country: i.city.country } : {}), ticker: i.city.ticker },
    showName: true,
    attributes: [
      { trait_type: 'Launchpad', value: VICINITY_BRAND.name },
      { trait_type: 'Network', value: VICINITY_BRAND.network },
      { trait_type: 'City', value: i.city.name },
    ],
    website: coinPageUrl(cityId),
  };
  if (i.twitter) out.twitter = i.twitter;
  if (i.telegram) out.telegram = i.telegram;
  return out;
}

/**
 * Check a served JSON against the coin's on-chain metadata (name, symbol, uri):
 * returns the list of problems, empty when it is consistent.
 */
export function checkMetadataAgainstChain(json: Partial<CoinMetadataJson>, chain: { mint: Address; name: string; symbol: string; uri: string }): string[] {
  const p: string[] = [];
  if (chain.uri !== coinMetadataUri(chain.mint)) p.push(`on-chain uri ${chain.uri} is not the Vicinity uri`);
  if (json.name !== chain.name) p.push(`name differs from on chain (${json.name} vs ${chain.name})`);
  if (json.symbol !== chain.symbol) p.push(`symbol differs from on chain (${json.symbol} vs ${chain.symbol})`);
  if (json.createdOn !== VICINITY_BRAND.site) p.push('createdOn is not https://vicinity.city');
  if (json.launchpad !== VICINITY_BRAND.name) p.push('launchpad is not Vicinity');
  if (json.network !== VICINITY_BRAND.network) p.push('network is not Solana');
  if (!json.image || !/^https:\/\//.test(json.image)) p.push('image must be an https URL');
  return p;
}

/**
 * Meteora partner metadata for the dev wallet (design 8.3): the name, website
 * and logo Meteora and Jupiter show for the Vicinity config(s). The dev wallet
 * (the config's fee_claimer) must sign; about 0.002 SOL of rent, once.
 */
export function buildPartnerMetadata({ payer = ADDRESSES.feeRecipient, feeClaimer = ADDRESSES.feeRecipient }: { payer?: Address; feeClaimer?: Address } = {}): Ix {
  return buildIx(IDL.dbc, 'create_partner_metadata', {
    metadata: { padding: Array(96).fill(0), name: VICINITY_BRAND.name, website: VICINITY_BRAND.site, logo: VICINITY_BRAND.logo },
  }, {
    partner_metadata: dbc.partnerMetadata(feeClaimer), payer, fee_claimer: feeClaimer, event_authority: dbc.eventAuthority(), program: IDL.dbc.address,
  }) as Ix;
}
