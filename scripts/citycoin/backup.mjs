#!/usr/bin/env node
/**
 * Citycoin.dev master v5, stage S08: the backup step before each migration. schema-and-api.md section 3.10 step 1 ("Validate a backup and
 * dry-run every migration on a copy of the production database; compare before and after counts and hashes"), master section 07 ("Take/
 * validate backups before migration; dry-run on a copy"), section 37 step 1. The owner's guide is docs/citycoin-master/schema-migrations.md
 * section 8. A feature stage's switch change creates a group (src/cc5schema.js `groupsForFlags`); this runs before that change is deployed.
 *
 *   node scripts/citycoin/backup.mjs [--remote | --local] [--execute] [--database <name>] [--config <wrangler config>]
 *        [--groups cc5-ops,cc5-selection | --flags SELECTION_V5=shadow,...] [--export <file outside the repository>] [--key-file <path>] [--yes]
 *
 * DRY RUN BY DEFAULT: without --execute it prints the steps and the exact commands, and runs, reads and writes nothing. --execute needs
 * --remote (the production database: the owner or credential holder, external dependency E9; never run by the stage that built this) or
 * --local (the local database of the wrangler config). The steps:
 *   1. bookmark   `wrangler d1 time-travel info <db> --json`: the D1 Time Travel bookmark of this moment, printed with its restore command
 *                 (remote only; a local database has no Time Travel)
 *   2. census     the count-and-digest census of the source (scripts/citycoin/census.mjs; with --remote it needs --key-file)
 *   3. export     with --export: `wrangler d1 export <db> --<target> --output <file>`. The file holds member data, so it must be outside
 *                 this repository and every git work tree, must not exist yet, and is created with mode 0600. Its sha256 and size are
 *                 printed. A remote export makes D1 stop serving queries while it runs (seconds for this database).
 *   4. validate   the export is restored into a NEW local database in <file>.restore/ (its own wrangler config; never the source) and
 *                 censused: the backup is valid only when every preserved category digest and every table's row count equal step 2's
 *   5. rehearse   with --groups or --flags: the groups (and their prerequisites) are created on that restored copy by the real runner
 *                 (src/cc5schema.js, through Miniflare's local D1), censused again and compared: preserved data unchanged, only the
 *                 groups' tables added, their records present
 *   then the restore commands (Time Travel to the bookmark, or the export into a new database). Census outputs are written next to
 *   the export (<file>.census-*.json: counts and digests only).
 * EXIT: 0 done (or a dry run); 2 refused (nothing was run); 5 the backup did not validate or the rehearsal did not hold; 1 any other failure.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CC5_GROUPS, CC5_ORDER, CC5_RESERVED, cc5Runner, groupsForFlags } from "../../src/cc5schema.js";
import { CC5_TABLES, compareCensus, loadKey, runCensus, wranglerExecutor, writeNewFile } from "./census.mjs";
import { DEFAULT_CONFIG, Refusal, checkDatabaseName, databaseNameFromConfig, outsideRepository, parseArgs, runWrangler, shellLine, targetOf } from "./lib.mjs";

/** The restored copy's own database (it exists only in <export>.restore/wrangler.json and its local state). */
export const RESTORE_DATABASE = "cc5-restored-copy";
export const RESTORE_ID = "00000000-0000-4000-8000-0000000c5c08";

/** The groups `ids` and their prerequisites, in CC5_ORDER. Refuses an unknown id, and cc5-identity (stage S09 builds it). */
export function groupClosure(ids) {
  const seen = new Set();
  const add = (id) => {
    if (CC5_RESERVED[id]) throw new Refusal(`${id} is not built in this stage (${CC5_RESERVED[id]})`);
    if (!CC5_GROUPS[id]) throw new Refusal(`unknown group ${JSON.stringify(String(id).slice(0, 40))}; the groups are ${Object.keys(CC5_GROUPS).join(", ")}`);
    if (seen.has(id)) return;
    seen.add(id);
    CC5_GROUPS[id].requires.forEach(add);
  };
  ids.forEach(add);
  return CC5_ORDER.filter((id) => seen.has(id));
}

/** --flags NAME=value,NAME=value -> { NAME: value } (the v5 switch names, e.g. SELECTION_V5=shadow). */
export function parseFlags(text) {
  const out = {};
  for (const item of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Z][A-Z0-9_]{1,40})=([A-Za-z0-9_-]{1,40})$/.exec(item);
    if (!m) throw new Refusal(`--flags takes NAME=value pairs separated by commas; refused ${JSON.stringify(item.slice(0, 60))}`);
    out[m[1]] = m[2];
  }
  return out;
}

/** The bookmark in `wrangler d1 time-travel info --json` output ({"bookmark": "00000085-0000024c-00004c6d-8e61117b..."}), or a Refusal. */
export function parseBookmark(stdout) {
  const at = String(stdout).search(/^\s*\{/m);
  let value = null;
  if (at >= 0) { try { value = JSON.parse(String(stdout).slice(at)); } catch { value = null; } }
  const b = value && typeof value.bookmark === "string" ? value.bookmark : "";
  if (!/^[0-9a-f]+(?:-[0-9a-f]+){2,6}$/i.test(b) || b.length > 128) throw new Refusal("the Time Travel answer holds no bookmark this step can read; nothing after it was run");
  return b;
}

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const restoreConfig = (dir) => path.join(dir, "wrangler.json");

/**
 * The plan: what --execute would run, as data. `o`: { database, target, config, exportFile, restoreDir, keyFile, groups, yes }.
 * Each step: { id, title, argv? (wrangler arguments), shell (the line to show), note? }.
 */
export function planBackup(o) {
  const cfg = o.config ? ["--config", o.config] : [];
  const steps = [];
  if (o.target === "remote") {
    steps.push({ id: "bookmark", title: "record the D1 Time Travel bookmark of this moment", argv: ["d1", "time-travel", "info", o.database, "--json", ...cfg] });
  }
  const censusLine = (db, target, config, file) => ["node", "scripts/citycoin/census.mjs", `--${target}`, "--database", db, ...(config ? ["--config", config] : []),
    ...(o.keyFile ? ["--key-file", o.keyFile] : target === "remote" ? ["--key-file", "<key file outside the repository>"] : []), ...(file ? ["--out", file] : [])];
  steps.push({ id: "census-source", title: "census of the source (counts and digests only)", shell: censusLine(o.database, o.target, o.config, o.exportFile && `${o.exportFile}.census-source.json`) });
  if (o.exportFile) {
    steps.push({ id: "export", title: "export to a file outside the repository (mode 0600; holds member data)",
      argv: ["d1", "export", o.database, `--${o.target}`, "--output", o.exportFile, ...cfg, ...(o.yes && o.target === "remote" ? ["--skip-confirmation"] : [])],
      note: o.target === "remote" ? "D1 does not serve queries while a remote export runs (seconds for this database); wrangler asks before it starts unless --yes" : null });
    steps.push({ id: "restore-copy", title: "restore the export into a new local database (never the source)",
      argv: ["d1", "execute", RESTORE_DATABASE, "--local", "--config", restoreConfig(o.restoreDir), "--file", o.exportFile] });
    steps.push({ id: "census-restored", title: "census of the restored copy; valid when every category digest and table row count equals the source's",
      shell: censusLine(RESTORE_DATABASE, "local", restoreConfig(o.restoreDir), `${o.exportFile}.census-restored.json`) });
    if (o.groups.length) {
      steps.push({ id: "rehearse", title: `create ${o.groups.join(", ")} on the restored copy with the runner (src/cc5schema.js ensureCc5Group)` });
      steps.push({ id: "census-rehearsed", title: "census after the rehearsal; preserved data unchanged, only these groups' tables added",
        shell: censusLine(RESTORE_DATABASE, "local", restoreConfig(o.restoreDir), `${o.exportFile}.census-rehearsed.json`) });
    }
  }
  for (const s of steps) if (s.argv) s.shell = ["wrangler", ...s.argv];
  return steps;
}

/** The restore commands for the operator (printed, never run). */
export function restoreCommands(o, bookmark) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const lines = [];
  if (o.target === "remote") {
    lines.push(`in place, to the bookmark (undoes EVERY write made after it, site-wide): ${shellLine(["wrangler", "d1", "time-travel", "restore", o.database, `--bookmark=${bookmark || "<bookmark from step 1>"}`])}`);
    if (o.exportFile) {
      lines.push(`or into a new database, leaving production as it is: ${shellLine(["wrangler", "d1", "create", `${o.database}-restored-${day}`])}`);
      lines.push(`  then: ${shellLine(["wrangler", "d1", "execute", `${o.database}-restored-${day}`, "--remote", `--file=${o.exportFile}`])}`);
    }
  } else if (o.exportFile) {
    lines.push(`into an empty local database (move the config's .wrangler/state folder aside first): ${shellLine(["wrangler", "d1", "execute", o.database, "--local", ...(o.config ? ["--config", o.config] : []), `--file=${o.exportFile}`])}`);
  }
  return lines;
}

/** Miniflare's local D1 over the restored copy's state, the runner creating `groups` in order. Answers the ids now in place. */
async function rehearseWithMiniflare(restoreDir, groups, log) {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const options = { modules: true, script: "export default {}", resourcePersistencePath: path.join(restoreDir, ".wrangler", "state", "v3"), d1Databases: { DATABASE: RESTORE_ID },
    cf: false }; // a placeholder request.cf: nothing is fetched from workers.cloudflare.com
  const mf = new Miniflare(typeof convertV4MiniflareOptions === "function" ? convertV4MiniflareOptions(options) : options);
  try {
    const db = await mf.getD1Database("DATABASE");
    const runner = cc5Runner({ log });
    const done = new Set();
    for (const id of groups) for (const x of await runner(db, id)) done.add(x);
    return CC5_ORDER.filter((id) => done.has(id));
  } finally {
    await mf.dispose();
  }
}

const USAGE = `usage: node scripts/citycoin/backup.mjs [--remote | --local] [--execute] [--database <name>] [--config <wrangler config>]
         [--groups <id,id> | --flags <NAME=value,...>] [--export <file outside the repository>] [--key-file <path>] [--yes]
Without --execute it prints the steps and runs nothing. --execute needs --remote (credential holder only) or --local.
`;

/** The CLI. `io` replaces process I/O, the wrangler runner and the rehearsal in tests. Answers the exit code. */
export async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  const run = io.run || runWrangler;
  const rehearse = io.rehearse || rehearseWithMiniflare;
  const say = (s = "") => out(`${s}\n`);
  try {
    const { opts, positionals } = parseArgs(argv, { flags: ["local", "remote", "execute", "yes", "help"], values: ["database", "config", "groups", "flags", "export", "key-file"] });
    if (opts.help) { out(USAGE); return 0; }
    if (positionals.length) throw new Refusal(`unexpected argument ${positionals[0].slice(0, 60)}\n${USAGE}`);
    const execute = Boolean(opts.execute);
    const target = targetOf(opts, execute ? null : "remote");
    const config = opts.config ? path.resolve(opts.config) : null;
    const database = opts.database ? checkDatabaseName(opts.database) : databaseNameFromConfig(config || DEFAULT_CONFIG);
    if (opts.groups && opts.flags) throw new Refusal("use --groups or --flags, not both");
    const groups = opts.groups ? groupClosure(opts.groups.split(",").map((s) => s.trim()).filter(Boolean))
      : opts.flags ? groupsForFlags(parseFlags(opts.flags)) : [];
    if (target === "remote" && execute && !opts["key-file"]) throw new Refusal("with --remote, pass --key-file <path outside the repository>: the census digests of production data are always keyed");
    const keyFile = opts["key-file"] ? outsideRepository(opts["key-file"], "the census key file") : null;
    let exportFile = null, restoreDir = null;
    if (opts.export) {
      exportFile = outsideRepository(opts.export, "the export file");
      if (existsSync(exportFile) || (() => { try { lstatSync(exportFile); return true; } catch { return false; } })()) throw new Refusal(`the export file ${opts.export} already exists; name a new file`);
      if (!existsSync(path.dirname(exportFile)) || !statSync(path.dirname(exportFile)).isDirectory()) throw new Refusal(`the folder of the export file does not exist: ${path.dirname(exportFile)}`);
      restoreDir = `${exportFile}.restore`;
      for (const f of [restoreDir, ...["source", "restored", "rehearsed"].map((k) => `${exportFile}.census-${k}.json`)]) {
        if (existsSync(f)) throw new Refusal(`${f} already exists; name a new export file`);
      }
    }
    if (groups.length && !exportFile) throw new Refusal("a rehearsal of groups runs on a restored copy: add --export <file outside the repository>");
    const plan = { database, target, config, exportFile, restoreDir, keyFile, groups, yes: Boolean(opts.yes) };
    const steps = planBackup(plan);

    say(`Backup step before a migration: database ${database} (${target})${execute ? "" : ", DRY RUN: nothing was run, read or written"}`);
    say(groups.length ? `Groups the switch change creates (with prerequisites, in order): ${groups.join(", ")}` : "No group named (--groups or --flags): backup only.");
    if (target === "local") say("Time Travel exists only for remote databases: no bookmark for a local database.");
    steps.forEach((s, i) => {
      say(`${i + 1}. ${s.title}`);
      if (s.shell) say(`   ${shellLine(s.shell)}`);
      if (s.note) say(`   (${s.note})`);
    });
    if (!execute) {
      say("Restore, once the steps have run:");
      for (const l of restoreCommands(plan, null)) say(`   ${l}`);
      say("Run again with --execute (and --remote or --local) to run these steps.");
      return 0;
    }

    // --execute
    say("Running the steps:");
    const key = keyFile ? loadKey(keyFile, { onCreate: (f) => err(`created a new census digest key at ${f} (keep it; never commit or share it)\n`) }) : null;
    let bookmark = null;
    if (target === "remote") {
      const r = await run(steps.find((s) => s.id === "bookmark").argv);
      if (r.code !== 0) throw new Error(`wrangler d1 time-travel info failed (exit ${r.code}); nothing after it was run`);
      bookmark = parseBookmark(r.stdout);
      say(`bookmark: ${bookmark} (at ${new Date().toISOString()})`);
    }
    const censusOf = (db, tgt, cfg) => runCensus(wranglerExecutor({ database: db, target: tgt, config: cfg, run }), { database: db, target: tgt, key });
    const save = (file, census) => { if (file) writeNewFile(file, `${JSON.stringify(census, null, 2)}\n`, 0o600); };

    const source = await censusOf(database, target, config);
    save(exportFile && `${exportFile}.census-source.json`, source);
    say(`census of the source: ${Object.keys(source.tables).length} tables; duplicate wallets ${source.counts.duplicate_wallets ?? "n/a"}${exportFile ? `; saved to ${exportFile}.census-source.json` : ""}`);
    if (source.checks.duplicate_wallets_zero === false) say("CHECK FAILED: duplicate wallets exist (must be 0); stop before any migration");

    let status = 0;
    if (exportFile) {
      const fd = openSync(exportFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
      closeSync(fd);
      const ex = await run(steps.find((s) => s.id === "export").argv, { inherit: true });
      chmodSync(exportFile, 0o600);
      if (ex.code !== 0 || statSync(exportFile).size === 0) throw new Error(`wrangler d1 export did not complete (exit ${ex.code}); the restore and the rehearsal were not run`);
      say(`export: ${exportFile} (${statSync(exportFile).size} bytes, sha256 ${sha256File(exportFile)}, mode 0600)`);

      mkdirSync(restoreDir, { mode: 0o700 });
      writeFileSync(restoreConfig(restoreDir), `${JSON.stringify({ name: "cc5-restored-copy", compatibility_date: "2026-09-01",
        d1_databases: [{ binding: "DB", database_name: RESTORE_DATABASE, database_id: RESTORE_ID }] }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const rs = await run(steps.find((s) => s.id === "restore-copy").argv);
      if (rs.code !== 0) throw new Error(`restoring the export into the local copy failed (exit ${rs.code}); the backup is NOT validated`);
      const restored = await censusOf(RESTORE_DATABASE, "local", restoreConfig(restoreDir));
      save(`${exportFile}.census-restored.json`, restored);
      const v = compareCensus(source, restored);
      const valid = v.ok && !v.tables.added.length && !v.tables.removed.length && !v.tables.row_counts_changed.length;
      say(valid ? `backup VALIDATED: the restored copy has the same ${Object.keys(source.tables).length} tables and row counts, and the same digests for ${Object.keys(v.categories).length} categories`
        : `backup NOT validated: categories changed ${JSON.stringify(v.parts_changed)}, tables added ${JSON.stringify(v.tables.added)}, removed ${JSON.stringify(v.tables.removed)}, row counts changed ${JSON.stringify(v.tables.row_counts_changed.map((x) => x.table))}`);
      if (!valid) status = 5;

      if (valid && groups.length) {
        const done = await rehearse(restoreDir, groups, (line) => err(`${line}\n`));
        const after = await censusOf(RESTORE_DATABASE, "local", restoreConfig(restoreDir));
        save(`${exportFile}.census-rehearsed.json`, after);
        const r = compareCensus(restored, after);
        const expected = groups.flatMap((id) => CC5_TABLES[id]);
        const onlyExpected = r.tables.added.every((t) => expected.includes(t)) && expected.every((t) => t in after.tables);
        const countsKept = r.tables.row_counts_changed.every((x) => x.table === "schema_migrations");
        const recorded = groups.every((id) => after.cc5.recorded.includes(id));
        const held = r.ok && onlyExpected && countsKept && recorded && groups.every((id) => done.includes(id));
        say(held ? `rehearsal HELD: ${groups.join(", ")} created on the restored copy (${r.tables.added.length} tables added, records ${after.cc5.recorded.join(", ")}); every preserved category and existing row count unchanged`
          : `rehearsal did NOT hold: categories ${JSON.stringify(r.parts_changed)}, tables added ${JSON.stringify(r.tables.added)}, row counts changed ${JSON.stringify(r.tables.row_counts_changed.map((x) => x.table))}, records ${JSON.stringify(after.cc5.recorded)}`);
        if (!held) status = 5;
      }
      say(`The export and ${restoreDir} hold member data: keep them on the operator's own encrypted disk, never in a repository or a chat, and delete them when this release no longer needs them.`);
    }
    say("Restore:");
    for (const l of restoreCommands(plan, bookmark)) say(`   ${l}`);
    return status;
  } catch (e) {
    if (e instanceof Refusal) { err(`${e.message}\n`); return 2; }
    err(`backup failed: ${String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 400)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
