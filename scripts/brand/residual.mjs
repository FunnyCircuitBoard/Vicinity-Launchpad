// The residual "vicinity" report (Citycoin.dev master v5, BR-01, stage S02): every token that contains "vicinity" (any letter case) in a
// file git tracks, put in one class by the rules of docs/citycoin-master/rebrand-inventory.md section 1, the first matching rule winning.
// A token is a run of [$@A-Za-z0-9_.:/|-] around the word; a binary file that contains the word counts as one item.
//
// REPORT ONLY: it prints counts and exits 0 whenever the scan completes, whatever it finds. It becomes a CI gate (unclassified labels
// fail while BRAND=citycoin) with the label migration, stage S48. The rules are heuristics, so a few tokens at class boundaries can
// land in a neighbouring class (rebrand-inventory.md section 1, "Error margin"); the totals per file are exact.
//
//   node scripts/brand/residual.mjs                 counts per class and per area
//   node scripts/brand/residual.mjs --list [class]  every token with path:line and its class (all classes, or the one named)
//   node scripts/brand/residual.mjs --json          the counts as JSON
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLASSES = Object.freeze([
  "migrate-label",          // a visible product label that moves to the new brand (BRAND)
  "migrate-url",            // a host or URL that moves through configuration (SITE_ORIGIN, the mail sender)
  "compatibility-required", // an old value that keeps working (legacy image, /coin-meta URLs, old hosts and statements)
  "persistent-identifier",  // never changes (program names and IDs, resource names, setting names, hash domains, stored values, keys)
  "third-party",            // a name on chain or in someone else's account ($VICINITY, the ticker, the former X account)
  "history",                // a dated record kept as written (release files, audits, devnet records, applied migrations)
  "developer-only",         // comments, developer docs, internal identifiers, CSS hooks: renaming is optional
]);
const LABEL = {
  "migrate-label": "migrate (labels)", "migrate-url": "migrate (URLs)", "compatibility-required": "compatibility-required",
  "persistent-identifier": "persistent identifier", "third-party": "third-party", history: "history", "developer-only": "developer-only",
};

const TOKEN = /[$@A-Za-z0-9_.:/|-]*vicinity[$@A-Za-z0-9_.:/|-]*/gi;
const HISTORY_PATHS = [
  /^solana\/release\/.+(?<!\.so)$/,
  /^solana\/(AUDIT|LAUNCHPAD-AUDIT|LAUNCHPAD-DEVNET|LAUNCHPAD-DESIGN|NOTES-integration)\.md$/,
  /^docs\/(AUDIT|HARDENING-2026-10-03)\.md$/,
  /^solana\/scripts\/launchpad\/devnet-demo-state\.json$/,
  /^migrations\/.+\.sql$/,
  /^countdown\/public\//,
];
const DEPLOYED_PROGRAM = [/^solana\/programs\/vicinity-(launchpad|rewards)\//, /^solana\/sdk\/idl\/vicinity_/, /\.so$/];
const RESOURCE_NAMES = new Set(["vicinity-map", "vicinity-claims", "vicinity-countdown"]);
const SETTING_NAMES = /^(env\.)?VICINITY_(MINT|REQUIRE_SHORT_WINDOWS)$/;
const HASH_DOMAINS = ["vicinity-seat|", "vicinity-election|", "vicinity-supporter|"];
const METADATA_PREFIX = new Set(["https://vicinity.city/coin-meta/", "vicinity.city/coin-meta/"]);
const INTERNAL = new Set(["cache.vicinity.internal", "https://cache.vicinity.internal/", "x-vicinity-max-age", "vicinity-boundary", "--vicinity-boundary", "--vicinity-boundary--"]);
const HOSTS = /vicinity\.city|vicinitycity\.(net|com)|vicinity\.test/i;

const isTestPath = (p) => /^test\//.test(p) || /^solana\/tests/.test(p) || /\.test\.[a-z]+$/.test(p) || /\/tests?\//.test(p);
const isDoc = (p) => /\.(md|txt)$/i.test(p) || /^docs\//.test(p);
const HASH_COMMENT = new Set([".sh", ".toml", ".yml", ".yaml", ".py", ".gitignore"]);

/** Is position `at` of `line` inside a comment? A line comment ("//" not part of "://", or "#" for shell-like files), a JSDoc or block
 *  comment line, or an HTML comment on the same line. */
function inComment(line, at, ext) {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("* ") || t === "*" || t.startsWith("*/")) return true;
  if (HASH_COMMENT.has(ext) && t.startsWith("#")) return true;
  for (let i = line.indexOf("//"); i >= 0 && i < at; i = line.indexOf("//", i + 2)) if (line[i - 1] !== ":" && line[i - 1] !== "\\") return true;
  const open = line.lastIndexOf("<!--", at), close = line.lastIndexOf("-->", at);
  if (open >= 0 && open > close) return true;
  const bo = line.lastIndexOf("/*", at), bc = line.lastIndexOf("*/", at);
  return bo >= 0 && bo > bc && line[bo - 1] !== "\\";
}

/**
 * The class of one token, by the inventory's rules in order. `ctx`: { path, raw, line, at } (the token, its line and its column).
 * Returns { cls, rule }.
 */
export function classifyToken({ path, raw, line = raw, at = 0 }) {
  const ext = extname(path).toLowerCase() || (path.endsWith(".gitignore") ? ".gitignore" : "");
  const core = raw.replace(/[.:]+$/, "");
  const before = line[at - 1] || "", after = line[at + raw.length] || "";
  const quoted = /["'`]/.test(before) && /["'`]/.test(after);
  const comment = inComment(line, at, ext), doc = isDoc(path);
  const hit = (cls, rule) => ({ cls, rule });

  // 1. history by path
  if (HISTORY_PATHS.some((r) => r.test(path))) return hit("history", "history file");
  // 2. deployed program source, IDL and binaries
  if (DEPLOYED_PROGRAM.some((r) => r.test(path))) return hit("persistent-identifier", "deployed program source, IDL or binary");
  // 3. persistent names
  if (/vicinity[_-](launchpad|rewards)/i.test(raw)) return hit("persistent-identifier", "program, crate or IDL name");
  if (RESOURCE_NAMES.has(core)) return hit("persistent-identifier", "Cloudflare resource name");
  if (SETTING_NAMES.test(core)) return hit("persistent-identifier", "setting name");
  if (HASH_DOMAINS.some((d) => raw.startsWith(d))) return hit("persistent-identifier", "hash domain");
  if (METADATA_PREFIX.has(core)) return hit("persistent-identifier", "on-chain metadata URI prefix");
  if (path === "src/common-passwords.js") return hit("persistent-identifier", "blocked-password entry");
  if (core === "vicinity_preview_role") return hit("persistent-identifier", "cookie name");
  if (raw.startsWith("vicinity:city:")) return hit("persistent-identifier", "rewards city tag");
  if (/vicinitycity\.com/i.test(raw) && (path.startsWith("countdown/") || path.startsWith(".github/workflows/deploy-countdown"))) return hit("persistent-identifier", "countdown resource or domain");
  // compatibility-required (taken out of the label and URL classes by explicit rules, inventory section 3.3)
  if (/vicinity-512\.png/i.test(raw)) return hit("compatibility-required", "legacy brand image");
  if (/vicinity\.city\/coin-meta\/\S/i.test(core)) return hit("compatibility-required", "legacy /coin-meta URL");
  if (path === "src/solana.js") return hit("compatibility-required", "old wallet statement");
  if (!comment && path === "solana/sdk/launchpad/metadata.mts") return hit("compatibility-required", "legacy SDK metadata builder");
  if (!comment && path === "src/coinmeta.js") return hit("compatibility-required", "frozen coin-JSON brand");
  if (!comment && path === "src/official.js" && /\bwebsites\s*:/.test(line)) return hit("compatibility-required", "official websites list");
  if (!comment && /FORWARD_HOSTS/.test(line) && !/FORWARD_HOSTS/.test(raw)) return hit("compatibility-required", "old redirect host");
  if (path === "wrangler.jsonc" && /"pattern"/.test(line)) return hit("compatibility-required", "old route");
  if (!comment && path === "src/sol/lpadmin-ix.js" && /VICINITY_PARTNER\s*=/.test(line) && core !== "VICINITY_PARTNER") return hit("compatibility-required", "on-chain partner entry");
  // 4. the legacy token's names and the former X account (outside code comments)
  if (!comment && raw.includes("$VICINITY")) return hit("third-party", "$VICINITY");
  if (!comment && core === "VICINITY" && before !== ">") return hit("third-party", "ticker VICINITY");
  if (!comment && /VicinityCitySOL/i.test(raw)) return hit("third-party", "former X account");
  // 5. hosts outside comments and docs
  if (!comment && !doc && HOSTS.test(raw)) return hit("migrate-url", "host or URL");
  // 6. quoted browser storage keys and quoted "vicinity" API or D1 values (in code; not DOM event names)
  if (quoted && !comment && !doc && /^vicinity([-:._][A-Za-z0-9_.:-]*)?$/.test(raw) && !/(addEventListener|CustomEvent|dispatchEvent|removeEventListener)\s*\(/.test(line)) {
    return hit("persistent-identifier", raw === "vicinity" ? "stored or API value" : "browser storage key");
  }
  // 7. docs, comments and internal identifiers
  if (doc) return hit("developer-only", "developer doc");
  if (comment) return hit("developer-only", "comment");
  if (INTERNAL.has(core)) return hit("developer-only", "internal cache name, header or boundary");
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(core) && !/^(vicinity|Vicinity|VICINITY)$/.test(core)) return hit("developer-only", "internal identifier");
  if (ext === ".css") return hit("developer-only", "CSS hook");
  // 8. anything left that names the product
  if (/Vicinity|VICINITY/.test(raw)) return hit("migrate-label", "visible label");
  return hit("developer-only", "lower-case leftover");
}

/** Every token of one text file: [{ path, line, raw, cls, rule }]. */
export function scanText(path, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/vicinity/i.test(line)) continue;
    for (const m of line.matchAll(TOKEN)) out.push({ path, line: i + 1, raw: m[0], ...classifyToken({ path, raw: m[0], line, at: m.index }) });
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "target", ".wrangler"]);
/** This file: its patterns are rule data, not consumers, so the report leaves it out. */
export const SELF = "scripts/brand/residual.mjs";

/** The files git tracks under `root` (a plain walk when git cannot answer). */
export function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean).sort();
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(join(root, dir))) {
        if (SKIP_DIRS.has(name)) continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (statSync(join(root, rel)).isDirectory()) walk(rel); else out.push(rel);
      }
    };
    walk("");
    return out.sort();
  }
}

/** Every item in the repository at `root`: tokens of text files, plus one item per binary file that contains the word. */
export function scanRepo(root) {
  const items = [];
  let binaries = 0;
  for (const path of trackedFiles(root)) {
    if (path === SELF) continue;
    let buf;
    try { buf = readFileSync(join(root, path)); } catch { continue; } // a tracked file deleted in the working tree
    if (buf.subarray(0, 8000).includes(0)) {
      if (/vicinity/i.test(buf.toString("latin1"))) {
        binaries++;
        items.push({ path, line: 0, raw: "(binary)", ...(/\.so$/.test(path) ? { cls: "persistent-identifier", rule: "release binary" } : HISTORY_PATHS.some((r) => r.test(path)) ? { cls: "history", rule: "history file" } : { cls: "developer-only", rule: "binary file" }) });
      }
      continue;
    }
    items.push(...scanText(path, buf.toString("utf8")));
  }
  return { items, binaries };
}

/** The area of a path, close to rebrand-inventory.md section 2.2. */
export function areaOf(path) {
  if (isTestPath(path) && !path.startsWith("solana/")) return "test/";
  if (/^public\/[^/]+\.html$/.test(path)) return "public/*.html (generated)";
  if (path.startsWith("scripts/pages/")) return "scripts/pages/";
  if (path.startsWith("scripts/")) return "scripts/";
  if (path.startsWith("src/")) return "src/";
  if (path.startsWith("public/")) return "public/";
  if (DEPLOYED_PROGRAM.some((r) => r.test(path)) || path.startsWith("solana/release/")) return "solana/ deployed programs, IDL, release";
  if (path.startsWith("solana/") && isDoc(path)) return "solana/ docs";
  if (path.startsWith("solana/")) return "solana/ SDK, scripts, tests";
  if (path.startsWith("docs/") || path === "README.md") return "docs/ and README.md";
  if (path.startsWith("countdown/")) return "countdown/";
  return "repository config";
}

/** Counts: { total, files, binaries, classes: { cls: { tokens, production, tests } }, areas: { area: { total, cls... } } }. */
export function summarize({ items, binaries }) {
  const classes = Object.fromEntries(CLASSES.map((c) => [c, { tokens: 0, production: 0, tests: 0 }]));
  const areas = {};
  for (const it of items) {
    const c = classes[it.cls];
    c.tokens++;
    if (isTestPath(it.path)) c.tests++; else c.production++;
    const a = (areas[areaOf(it.path)] ||= { total: 0, ...Object.fromEntries(CLASSES.map((k) => [k, 0])) });
    a.total++; a[it.cls]++;
  }
  return { total: items.length, files: new Set(items.map((i) => i.path)).size, binaries, classes, areas };
}

const n = (x) => x.toLocaleString("en-US");
const pad = (s, w, right = false) => (right ? String(s).padStart(w) : String(s).padEnd(w));

function report(s) {
  const lines = [
    `Residual "vicinity" report (report only, exits 0): ${n(s.total)} items in ${n(s.files)} files (${s.binaries} binary).`,
    "",
    `${pad("Class", 26)}${pad("Items", 8, true)}${pad("Production", 12, true)}${pad("Tests", 8, true)}`,
    ...CLASSES.map((c) => `${pad(LABEL[c], 26)}${pad(n(s.classes[c].tokens), 8, true)}${pad(n(s.classes[c].production), 12, true)}${pad(n(s.classes[c].tests), 8, true)}`),
    `${pad("Total", 26)}${pad(n(s.total), 8, true)}`,
    "",
    "Per area (items: total, then the classes in the order above):",
    ...Object.entries(s.areas).sort((x, y) => y[1].total - x[1].total).map(([a, v]) => `  ${pad(a, 42)}${pad(n(v.total), 6, true)}   ${CLASSES.map((c) => pad(v[c] || "-", 5, true)).join("")}`),
  ];
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const args = process.argv.slice(2);
  const scan = scanRepo(root);
  if (args.includes("--json")) console.log(JSON.stringify(summarize(scan), null, 2));
  else if (args.includes("--list")) {
    const only = args[args.indexOf("--list") + 1];
    if (only && !only.startsWith("--") && !CLASSES.includes(only)) console.error(`unknown class "${only}"; one of: ${CLASSES.join(", ")}`);
    for (const it of scan.items) if (!only || only.startsWith("--") || it.cls === only) console.log(`${it.path}:${it.line}\t${it.cls}\t${it.rule}\t${it.raw}`);
  } else console.log(report(summarize(scan)));
  process.exitCode = 0;
}
