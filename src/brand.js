/**
 * The product's visible names, in one place (Citycoin.dev master v5, stage S02; rebrand-inventory.md L01-L04, L12). Read from the
 * setting BRAND like the other switches (trimmed, any letter case).
 *
 * BRAND unset (or blank) is today's label set, byte for byte: "Vicinity", "Vicinity.city", "vicinity.city" and the tagline
 * "One city. One coin. One community.". It is the only label set in this stage. The Citycoin.dev set is added with the label migration
 * (stage S48, BRAND=citycoin), so until then any other value also gives today's labels and names the refusal in `problem`
 * (BRAND_UNKNOWN): nothing visible can change by accident.
 *
 * Only visible labels live here. Persistent identifiers never follow BRAND (rebrand-inventory.md sections 3.3 and 3.4; pinned by
 * test/persist-guard.test.js): program names and IDs, the /coin-meta/ URL prefix and the legacy coin-JSON brand, /brand/vicinity-512.png,
 * stored "vicinity" values, signed-message and hash domains, storage keys and cookie names. Origins and hosts are src/site-config.js.
 *
 * Used today by the page layout (scripts/pages/build.mjs, from the settings of wrangler.jsonc) and the mail sender's display name
 * (src/mail.js).
 */

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };

/** Today's labels. */
export const LEGACY_BRAND = deepFreeze({
  key: "",
  productName: "Vicinity",                       // in sentences: "Vicinity never asks …", "Vicinity on X", the header
  shortName: "Vicinity",                         // where space is short (app name, tab bar)
  domain: "vicinity.city",                       // the address as a visible label ("read by vicinity.city")
  siteLabel: "Vicinity.city",                    // the name on the copyright line
  senderName: "Vicinity",                        // the display name of outgoing mail
  tagline: "One city. One coin. One community.",
});

/** Every label set, by BRAND value ("" = unset). */
export const BRANDS = deepFreeze({ "": LEGACY_BRAND });

const FIELDS = ["productName", "shortName", "domain", "siteLabel", "senderName", "tagline"];

/** The label set of a Worker environment (or of the page build's settings): a frozen BRANDS entry plus `value` and `problem`. */
export function brandOf(env) {
  const value = String((env && env.BRAND) ?? "").trim().toLowerCase();
  const known = Object.hasOwn(BRANDS, value);
  return Object.freeze({ ...(known ? BRANDS[value] : LEGACY_BRAND), value, problem: known ? null : "BRAND_UNKNOWN" });
}

/**
 * The labels the page layout writes, made from one label set. With LEGACY_BRAND every string is exactly today's.
 * (Plain text: the layout escapes what it writes into markup.)
 */
export function brandLabels(b) {
  for (const f of FIELDS) if (typeof b?.[f] !== "string" || !b[f].trim()) throw new Error(`brand: ${f} must be a non-empty string`);
  return Object.freeze({
    homeTitle: `${b.productName} — ${b.tagline}`,
    pageTitle: (title) => `${title} · ${b.productName}`,
    homeLink: `${b.productName} home`,
    headerName: b.productName,
    copyright: `${b.siteLabel} © 2026. All rights reserved.`,
    socialList: `${b.productName} on social media`,
    socialLink: (network, handle) => `${b.productName} on ${network} (${handle}), opens in a new tab`,
    safety: `${b.productName} never asks for your recovery phrase or private key.`,
  });
}
