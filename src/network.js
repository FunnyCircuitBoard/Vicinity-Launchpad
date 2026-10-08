import { distanceKm } from "./cities.js";

/**
 * Network check, using the location Cloudflare sees for the visitor's internet connection.
 * Stops the easy tricks: a VPN or proxy, or faking GPS from another place.
 * Nothing here is stored. Returns an error code, or null when the connection looks local.
 */
// Hosting / VPN networks (not home or mobile internet). Apple and Cloudflare relays are allowed:
// they keep people in their real region.
export const VPN_NETWORK_RE = /\b(amazon|aws|google cloud|microsoft azure|azure|digitalocean|linode|akamai connected cloud|ovh|hetzner|m247|datacamp|cdn77|choopa|vultr|the constant company|leaseweb|contabo|hostinger|g-core|gcore|kamatera|oracle cloud|zenlayer|psychz|quadranet|packethub|tefincom|nordvpn|expressvpn|surfshark|proton ?ag|protonvpn|mullvad|private internet access|ipvanish|cyberghost|windscribe|hide\.me|tzulo|colocrossing|hostwinds|scaleway|frantech|buyvm|ionos cloud|servers\.com|performive|clouvider|xtom|hydra communications|anexia|terrahost)\b/i;
export const MAX_NETWORK_KM = 500;

/**
 * Relays that hide a browser's own internet connection behind theirs: iCloud Private Relay (Safari on an iPhone or a Mac) leaves
 * through Cloudflare, Akamai and Fastly, and Cloudflare's WARP through Cloudflare. They are fine for the location (above), but a
 * page behind one does not share its connection with the other apps of the same phone, so a sign-up can't be carried from it into
 * a wallet app's own browser (src/signup.js, "carry": that is bound to the connection).
 */
export const RELAY_ASNS = new Set([13335, 209242, 36183, 54113]);
export const RELAY_NETWORK_RE = /\b(cloudflare|akamai|fastly|apple)\b/i;
export const isRelayNetwork = (cf) => Boolean(cf && (RELAY_ASNS.has(Number(cf.asn)) || RELAY_NETWORK_RE.test(String(cf.asOrganization || ""))));

export function networkCheck(cf, loc, country) {
  if (!cf) return null; // not on Cloudflare (local tests)
  if (cf.country === "T1") return { error: "vpn_detected" }; // Tor
  if (VPN_NETWORK_RE.test(String(cf.asOrganization || ""))) return { error: "vpn_detected" };
  if (cf.country && cf.country !== "XX" && country && cf.country !== country) return { error: "network_mismatch", networkCountry: cf.country };
  const lat = Number(cf.latitude), lon = Number(cf.longitude);
  if (cf.latitude != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    const km = distanceKm(lat, lon, loc.lat, loc.lon);
    if (km > MAX_NETWORK_KM) return { error: "network_mismatch", networkKm: Math.round(km) };
  }
  return null;
}
