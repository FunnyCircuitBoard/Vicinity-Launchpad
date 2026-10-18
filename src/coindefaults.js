/**
 * A city's ready-made coin, from the Vicinity city list only (COIN_V2_READY, src/coinready.js). Nothing here comes from a request:
 *   ticker        the registry's (public/data/tickers.json via src/tickers.js tickerOf). A city the registry does not know (a town added
 *                 by the community, a "part" of a bigger city) has NO coin here: nothing invents a ticker.
 *   name          the registry city name exactly ("Utica", "Herāt"), except the three names longer than the 32 bytes a coin name may
 *                 have on chain, which NAME_OVERRIDES shortens (test/coin-ready.test.js checks it holds exactly those ids)
 *   city, region, country   the list's own record (src/cities.js cityRecord: GeoNames names, region null where the list has none)
 *   description   "The city coin of Utica, New York, United States." (the region left out when the list has none or it repeats a
 *                 name). System text, never a founder's: the /coin-meta JSON adds the fixed "Launched on Vicinity ..." sentence.
 *   pair          SOL (the only pair the launchpad launches with)
 */
import { tickerOf, tickersAvailable } from "./tickers.js";
import { cityRecord } from "./cities.js";
import { checkName, checkSymbol } from "./coinmeta.js";
import { nameProblem } from "./lpadmin.js";

/** Registry names over 32 UTF-8 bytes, shortened to the name people use. Keyed by GeoNames id. */
export const NAME_OVERRIDES = Object.freeze({
  2917788: "Greifswald", // Universitäts- und Hansestadt Greifswald (40 bytes)
  3518407: "San Martín Texmelucan", // San Martin Texmelucan de Labastida (34 bytes)
  3526357: "Juchitán de Zaragoza", // Heroica Ciudad de Juchitán de Zaragoza (39 bytes)
});
export const DEFAULT_PAIR = "SOL";
export const SOURCE = "Vicinity city list";

/** The default description: city, region and country, each once. */
export function defaultDescription({ name, region, countryName }) {
  const parts = [name];
  for (const p of [region, countryName]) if (p && !parts.includes(p)) parts.push(p);
  return `The city coin of ${parts.join(", ")}.`;
}

/** Why a city has no ready-made coin, in the founder's words. */
export const DEFAULT_GATES = Object.freeze({
  list_unavailable: "The city list couldn't be read just now. Try again in a minute.",
  no_ticker: "This city isn't in the Vicinity city list yet, so it has no registered ticker. Tell us and we'll add it.",
  not_in_list: "This city isn't in the Vicinity city list yet, so it has no ready-made coin. Tell us and we'll add it.",
  bad_name: "This city's name can't be written on the blockchain as it is. Tell us and we'll fix it in the city list.",
});

/**
 * The ready-made coin of `cityId` in country `cc` (the seat's): { ok: true, city, ticker, name, description, pair } or
 * { ok: false, code, message } (DEFAULT_GATES).
 */
export async function coinDefaults(env, cityId, cc) {
  const fail = (code) => ({ ok: false, code, message: DEFAULT_GATES[code] });
  if (!/^\d{1,19}$/.test(String(cityId)) || !/^[A-Z]{2}$/.test(String(cc || ""))) return fail("not_in_list");
  if (!(await tickersAvailable(env))) return fail("list_unavailable");
  const t = await tickerOf(env, cityId);
  if (!t || checkSymbol(t.ticker)) return fail("no_ticker");
  let city;
  try { city = await cityRecord(env, cityId, cc); } catch { return fail("list_unavailable"); }
  if (!city) return fail("not_in_list");
  const name = NAME_OVERRIDES[city.id] || city.name;
  if (nameProblem(name) || checkName(name)) return fail("bad_name");
  return { ok: true, city, ticker: t.ticker, name, description: defaultDescription({ name: city.name, region: city.region, countryName: city.countryName }), pair: DEFAULT_PAIR };
}
