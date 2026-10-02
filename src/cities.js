/**
 * The world city list (public/data/cities.json, from GeoNames, CC BY 4.0,
 * grouped by country: { countries, admin, byCountry: { US: [[id, name, admin1, lat, lon, pop], ...] } })
 * plus the rules for claiming a city.
 *
 * Rules (the same numbers are shown on the website):
 *   - the founder amount is the Stake Ladder in src/policy.js (100K to 1M by city size), not a number here
 *   - be inside the city: inside its boundary on the map (public/data/bounds, see src/geo.js).
 *     Cities without a boundary (community-added ones) use the old rule: within CLAIM_RADIUS_KM
 *     of the center (BIG_CITY_RADIUS_KM for 1M+ people)
 *   - one person = one live seat, one city = one live seat
 * The visitor's location is only used for this one check. It is never saved.
 */
export const CLAIM_RADIUS_KM = 25;
export const BIG_CITY_RADIUS_KM = 50;
export const MAX_LOCATION_ACCURACY_M = 20_000;

let textCache = null;
const countryCache = new Map();

/** The raw cities.json text, fetched once per worker instance from the site's own static files. */
async function citiesText(env) {
  if (textCache) return textCache;
  const res = await env.ASSETS.fetch(new Request("https://assets.local/data/cities.json"));
  if (!res.ok) throw new Error("cities_unavailable");
  textCache = await res.text();
  return textCache;
}

/**
 * Cities of ONE country: [{ id, name, country, admin, lat, lon, pop }].
 * Only that country's part of the file is parsed, so this stays fast on the free plan.
 * Returns null if the country isn't in the list.
 */
export async function countryCities(env, cc) {
  if (!/^[A-Z]{2}$/.test(cc || "")) return null;
  if (countryCache.has(cc)) return countryCache.get(cc);
  const text = await citiesText(env);
  const base = text.indexOf('"byCountry":{');
  const at = base < 0 ? -1 : text.indexOf(`"${cc}":[[`, base);
  let list = null;
  if (at >= 0) {
    const from = at + cc.length + 3;
    const end = text.slice(from).search(/\]\](?=,"[A-Z]{2}":\[\[|\}\})/);
    if (end >= 0) {
      const rows = JSON.parse(text.slice(from, from + end + 2));
      list = rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, country: cc, admin: adm, lat, lon, pop }));
    }
  }
  countryCache.set(cc, list);
  return list;
}
/**
 * A country's city boundary file (public/data/bounds/XX.txt, format in geo.js) as text, or null if
 * there isn't one (then claims fall back to the old distance rule). Kept for the worker's lifetime.
 */
const boundsCache = new Map();
export async function countryBounds(env, cc) {
  if (!/^[A-Z]{2}$/.test(cc || "")) return null;
  if (boundsCache.has(cc)) return boundsCache.get(cc);
  const res = await env.ASSETS.fetch(new Request(`https://assets.local/data/bounds/${cc}.txt`));
  const text = res.ok ? await res.text() : null;
  if (boundsCache.size > 40) boundsCache.clear();
  boundsCache.set(cc, text);
  return text;
}
export const _resetCityCache = () => { textCache = null; countryCache.clear(); boundsCache.clear(); };

/** Distance in km between two points on Earth. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const radiusFor = (city) => ((city.pop || 0) >= 1_000_000 ? BIG_CITY_RADIUS_KM : CLAIM_RADIUS_KM);

/** Validate a {lat, lon, accuracy} location sent by the browser. Returns null if unusable. */
export function cleanLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = Number(loc.lat), lon = Number(loc.lon), accuracy = Number(loc.accuracy ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  return { lat, lon, accuracy };
}

/** Same name check used for duplicates: lower case, no accents, no punctuation. */
export const normName = (s) =>
  String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, "");
