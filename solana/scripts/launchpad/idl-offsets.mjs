// Generates src/sol/layout.js: the byte offsets of the account fields the Worker decodes (our Coin, Launchpad and
// LaunchConfig records; Meteora DBC's VirtualPool and PoolConfig) and DBC's error table, walked from the committed IDLs.
// Layouts are bytemuck/borsh with explicit padding: a field's offset is the sum of the sizes before it (u8 1, u16 2, u32 4,
// u64/i64 8, u128 16, pubkey 32, bool 1, arrays and nested structs inline). Anchor accounts start with an 8-byte
// discriminator. Nested fields are flattened as dotted paths (pool_fees.base_fee.cliff_fee_numerator).
//   node scripts/launchpad/idl-offsets.mjs            writes src/sol/layout.js
//   node scripts/launchpad/idl-offsets.mjs --check    exits 1 when the checked-in file differs (a test runs this)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, "..", "..");
const OUT = join(solanaDir, "..", "src", "sol", "layout.js");
const lp = JSON.parse(readFileSync(join(solanaDir, "sdk", "idl", "vicinity_launchpad.json"), "utf8"));
const dbc = JSON.parse(readFileSync(join(solanaDir, "idls", "dynamic_bonding_curve.json"), "utf8"));

const PRIM = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
function size(idl, ty) {
  if (typeof ty === "string") { if (!(ty in PRIM)) throw new Error(`unsupported primitive ${ty}`); return PRIM[ty]; }
  if (ty.array) return size(idl, ty.array[0]) * ty.array[1];
  if (ty.defined) return structFields(idl, ty.defined.name).reduce((s, f) => s + size(idl, f.type), 0);
  throw new Error(`unsupported type ${JSON.stringify(ty)}`);
}
function structFields(idl, name) {
  const def = idl.types.find((x) => x.name === name);
  if (!def || def.type.kind !== "struct") throw new Error(`no struct ${name}`);
  return def.type.fields;
}
/** { "path": { at, type, size, count? } } for a struct starting at `base`; arrays of structs give "curve[i].field". */
function walk(idl, name, base, prefix, out) {
  let at = base;
  for (const f of structFields(idl, name)) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    const ty = f.type;
    if (typeof ty === "string") out[path] = { at, type: ty, size: PRIM[ty] };
    else if (ty.array && typeof ty.array[0] === "string") out[path] = { at, type: ty.array[0], size: PRIM[ty.array[0]], count: ty.array[1] };
    else if (ty.array && ty.array[0].defined) {
      const inner = ty.array[0].defined.name, each = size(idl, ty.array[0]);
      out[path] = { at, type: inner, size: each, count: ty.array[1] };
      for (let i = 0; i < ty.array[1]; i++) walk(idl, inner, at + i * each, `${path}[${i}]`, out);
    } else if (ty.defined) walk(idl, ty.defined.name, at, path, out);
    at += size(idl, ty);
  }
  return at;
}
function account(idl, accountName, structName = accountName) {
  const acc = idl.accounts.find((a) => a.name === accountName);
  if (!acc) throw new Error(`no account ${accountName}`);
  const fields = {};
  const end = walk(idl, structName, 8, "", fields);
  return { discriminator: acc.discriminator, size: end, fields };
}

// Meteora DBC 0.2.2 (mainnet since 16 Oct 2026) split PoolConfig.padding_0 [u8; 14] (bytes 216-229) into the base mint's
// transfer-fee fields below and added four error codes; every other offset is unchanged. solana/idls stays at 0.2.1, the IDL our
// deployed program was built against (no instruction it calls changed), so the 0.2.2 names are laid over it here. A Vicinity
// config has all of them zero (src/lpadmin.js configDiff).
const DBC_022_POOL_CONFIG = [["transfer_fee_basis_points", "u16"], ["transfer_fee_withheld_authority", "u8"], ["migrated_transfer_fee_authority_option", "u8"], ["transfer_fee_flag", "u8"], ["padding_0", "u8", 9]];
const DBC_022_ERRORS = { 6083: "FeeInverseIsIncorrect", 6084: "InvalidTransferFeeParameters", 6085: "ExceededInputAmount", 6086: "InvalidFeeClaimer" };
function poolConfig022(acc) {
  const old = acc.fields.padding_0;
  if (!old || old.at !== 216 || old.size !== 1 || old.count !== 14) throw new Error("PoolConfig.padding_0 is not the 0.2.1 [u8; 14] at 216: check the DBC IDL");
  const fields = {};
  for (const [k, v] of Object.entries(acc.fields)) {
    if (k !== "padding_0") { fields[k] = v; continue; }
    let at = old.at;
    for (const [name, type, count] of DBC_022_POOL_CONFIG) {
      fields[name] = count ? { at, type, size: PRIM[type], count } : { at, type, size: PRIM[type] };
      at += PRIM[type] * (count || 1);
    }
    if (at !== old.at + old.count) throw new Error("the 0.2.2 PoolConfig fields do not fill padding_0");
  }
  return { ...acc, fields };
}
function dbcErrors022(errors) {
  const out = Object.fromEntries(errors.map((e) => [e.code, e.name]));
  for (const [code, name] of Object.entries(DBC_022_ERRORS)) { if (out[code]) throw new Error(`DBC error ${code} is already ${out[code]}`); out[code] = name; }
  return out;
}

// VirtualPool = discriminator + one PoolState field: flatten PoolState itself
const pool = account(dbc, "VirtualPool");
const poolFields = Object.fromEntries(Object.entries(pool.fields).filter(([k]) => k.startsWith("pool_state.")).map(([k, v]) => [k.slice("pool_state.".length), v]));
const layout = {
  generatedFrom: { launchpad: lp.metadata?.name + " " + (lp.metadata?.version || ""), dbc: dbc.metadata?.name + " " + (dbc.metadata?.version || "") + " with the PoolConfig fields and errors of 0.2.2" },
  Coin: account(lp, "Coin"),
  Launchpad: account(lp, "Launchpad"),
  LaunchConfig: account(lp, "LaunchConfig"),
  VirtualPool: { discriminator: pool.discriminator, size: pool.size, fields: poolFields },
  PoolConfig: poolConfig022(account(dbc, "PoolConfig")),
  constants: Object.fromEntries(lp.constants.map((c) => [c.name, c.value.replace(/^"|"$/g, "")])),
  dbcErrors: dbcErrors022(dbc.errors),
  launchpadErrors: Object.fromEntries((lp.errors || []).map((e) => [e.code, e.name])),
};
const text = `/**
 * GENERATED by solana/scripts/launchpad/idl-offsets.mjs from solana/sdk/idl/vicinity_launchpad.json and
 * solana/idls/dynamic_bonding_curve.json (0.2.1, with DBC 0.2.2's PoolConfig transfer-fee fields and errors laid over it): byte
 * offsets of the account fields src/sol/dbc.js decodes, the program constants and the error tables. Do not edit: re-run the
 * script (solana/tests-launchpad/15-worker-builder.test.mjs fails when stale).
 */
export const LAYOUT = ${JSON.stringify(layout, null, 1)};
`;
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(OUT, "utf8"); } catch { cur = ""; }
  if (cur !== text) { console.error("src/sol/layout.js is stale: run node scripts/launchpad/idl-offsets.mjs"); process.exit(1); }
  console.log("src/sol/layout.js is up to date");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: Coin ${layout.Coin.size} B, Launchpad ${layout.Launchpad.size} B, LaunchConfig ${layout.LaunchConfig.size} B, VirtualPool ${layout.VirtualPool.size} B, PoolConfig ${layout.PoolConfig.size} B, ${Object.keys(layout.dbcErrors).length} DBC errors`);
}
