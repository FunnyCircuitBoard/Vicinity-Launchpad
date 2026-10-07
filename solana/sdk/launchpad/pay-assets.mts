// What people can pay with (LAUNCHPAD-DESIGN.md 9.6 and decision D13), on
// MAINNET. Curves only ever hold their quote token (SOL by default); every
// other asset is swapped into it by Jupiter in the buyer's own transaction,
// so nothing here ever sits in a curve and nobody holds the buyer's money.
//
// Mints, decimals and token programs were read from mainnet account data and
// Jupiter's token API on 6 Oct 2026 (research 3). Before adding an asset:
// check its mint on chain and on Jupiter (tag "verified"), because look-alike
// tickers exist (for example fake "NVDAx" coins on pump.fun and Meteora).
//
// Sources:
//   * Jupiter Tokens API v2: https://lite-api.jup.ag/tokens/v2/search?query=<mint or symbol>
//   * Mainnet account data (getAccountInfo, token program and extensions decoded)
//   * xStocks issuer and availability: https://support.kraken.com/gb/articles/xstocks-availability,
//     https://www.kraken.com/uk/legal/xstocks (not offered to US, UK, Canadian or Australian persons;
//     no shareholder rights)
//   * StonkFun / STONK: https://www.stonkfun.xyz/,
//     https://www.theblock.co/news/defi/2026-09-06-stonk-surges-250-to-140-million-market-cap-as-stonkfun-pulls-volume-to-raydium-and-jupiter-413621
//   * Jupiter routing tests (ExactIn into SOL at maxAccounts 64, 30 and 20): lpc-research/quotes/*.json
//
// Tokenized stocks are offered on an ALLOW-LIST that fails closed (decision
// D13): only to visitors whose country is on STOCK_ALLOWED_COUNTRIES, never
// when the country is unknown, and never in STOCK_BLOCKED_COUNTRIES (the
// issuer's excluded countries and comprehensively sanctioned ones), whatever
// the allow-list says. The default allow-list (the EEA and Switzerland) is a
// placeholder: a lawyer sets the real list before mainnet.
import type { Address } from './accounts.mts';

export type PayAssetKind = 'native' | 'stablecoin' | 'bitcoin' | 'ether' | 'stock' | 'memecoin' | 'vicinity';
export interface PayAsset {
  symbol: string;
  name: string;
  mint: Address;
  decimals: number;
  tokenProgram: 'spl' | 'token2022';
  kind: PayAssetKind;
  /** hidden for visitors from these countries (ISO 3166-1 alpha-2, as Cloudflare's request.cf.country) */
  hiddenIn: readonly string[];
  /** when set, offered ONLY to visitors from these countries (unknown country: hidden) */
  onlyIn?: readonly string[];
  /** a Jupiter route size that found a route into SOL in research (planPayWithAnything still tries 40, 32, 24, then 64) */
  minMaxAccounts?: number;
  /** shown next to the option */
  note?: string;
}

/**
 * Countries where tokenized stocks MAY be offered (allow-list, fails closed).
 * Default: the European Economic Area (the 27 EU countries plus Iceland,
 * Liechtenstein and Norway) and Switzerland, where the issuer (Backed / Kraken
 * xStocks) offers them, the EEA only after an appropriateness questionnaire.
 * PLACEHOLDER: a lawyer confirms or replaces this list before mainnet (D13).
 */
export const STOCK_ALLOWED_COUNTRIES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'CH',
]);
/**
 * Never offered, whatever the allow-list says: the issuer's excluded countries
 * (US, UK, Canada, Australia) and comprehensively sanctioned jurisdictions
 * (OFAC, EU and UN programmes: Cuba, Iran, North Korea, Syria, Russia, Belarus;
 * plus Venezuela and Myanmar). Regions such as Crimea cannot be told apart by
 * country code; the allow-list already excludes Ukraine as a whole.
 */
export const STOCK_BLOCKED_COUNTRIES = Object.freeze(['US', 'GB', 'CA', 'AU', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'VE', 'MM']);
/** @deprecated the old name of STOCK_BLOCKED_COUNTRIES (a block-list alone is not enough; see STOCK_ALLOWED_COUNTRIES) */
export const STOCK_RESTRICTED_COUNTRIES = STOCK_BLOCKED_COUNTRIES;
const STOCK_NOTE = 'Tokenized stock: no shareholder rights. The issuer can pause or move these tokens. Offered only where the issuer and our lawyer allow it.';

const stock = (symbol: string, name: string, mint: Address): PayAsset => ({
  symbol, name, mint, decimals: 8, tokenProgram: 'token2022', kind: 'stock', hiddenIn: STOCK_BLOCKED_COUNTRIES, onlyIn: STOCK_ALLOWED_COUNTRIES, note: STOCK_NOTE,
});

export const WSOL_MINT: Address = 'So11111111111111111111111111111111111111112';
export const VICINITY_MINT: Address = '2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray';

/** The allow-list the site offers (design 9.6: SOL, USDC, USDT, cbBTC, WBTC, ETH, xStocks, STONK, $VICINITY). */
export const PAY_ASSETS: readonly PayAsset[] = Object.freeze([
  { symbol: 'SOL', name: 'Solana', mint: WSOL_MINT, decimals: 9, tokenProgram: 'spl', kind: 'native', hiddenIn: [], note: 'Paid directly: no swap needed for SOL-priced coins.' },
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, tokenProgram: 'spl', kind: 'stablecoin', hiddenIn: [] },
  { symbol: 'USDT', name: 'Tether USD', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, tokenProgram: 'spl', kind: 'stablecoin', hiddenIn: [] },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', decimals: 8, tokenProgram: 'spl', kind: 'bitcoin', hiddenIn: [] },
  { symbol: 'WBTC', name: 'Wrapped BTC (Wormhole Portal)', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8, tokenProgram: 'spl', kind: 'bitcoin', hiddenIn: [] },
  { symbol: 'ETH', name: 'Ether (Wormhole Portal)', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8, tokenProgram: 'spl', kind: 'ether', hiddenIn: [] },
  stock('TSLAx', 'Tesla xStock', 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'),
  stock('AAPLx', 'Apple xStock', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'),
  stock('NVDAx', 'NVIDIA xStock', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
  stock('SPYx', 'SP500 xStock', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'),
  stock('QQQx', 'Nasdaq xStock', 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ'),
  stock('GOOGLx', 'Alphabet xStock', 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'),
  stock('MSTRx', 'MicroStrategy xStock', 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ'),
  stock('COINx', 'Coinbase xStock', 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu'),
  stock('HOODx', 'Robinhood xStock', 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg'),
  stock('CRCLx', 'Circle xStock', 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1'),
  { symbol: 'STONK', name: 'STONK (StonkFun)', mint: '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx', decimals: 9, tokenProgram: 'spl', kind: 'memecoin', hiddenIn: [] },
  { symbol: 'VICINITY', name: 'Vicinity', mint: VICINITY_MINT, decimals: 6, tokenProgram: 'spl', kind: 'vicinity', hiddenIn: [], minMaxAccounts: 40, note: 'Thin liquidity (about $1,800): large payments move its price a lot, and the swap may need its own transaction.' },
]);

export function payAsset(symbolOrMint: string): PayAsset {
  const a = PAY_ASSETS.find((x) => x.symbol === symbolOrMint || x.mint === symbolOrMint);
  if (!a) throw new Error(`${symbolOrMint} is not on the Vicinity pay-with list`);
  return a;
}
/** The pay-with options for a visitor's country (stock tokens only where allowed; hidden when the country is unknown). */
export function payAssetsFor(country: string | null | undefined): PayAsset[] {
  return PAY_ASSETS.filter((a) => mayOffer(a, country));
}
/**
 * True when the asset may be offered to a visitor from `country` (ISO code as
 * Cloudflare's request.cf.country). Fails closed: an asset with an allow-list
 * (`onlyIn`, every stock) is hidden for an unknown country, for "XX" and "T1"
 * (Cloudflare's unknown and Tor), and for any country not on the list; the
 * block-list (`hiddenIn`) always wins.
 */
export function mayOffer(asset: PayAsset, country: string | null | undefined): boolean {
  const c = (country ?? '').trim().toUpperCase();
  if (asset.hiddenIn.includes(c)) return false;
  if (asset.kind === 'stock' && !asset.onlyIn) return false;
  if (asset.onlyIn) return /^[A-Z]{2}$/.test(c) && asset.onlyIn.includes(c);
  return true;
}
