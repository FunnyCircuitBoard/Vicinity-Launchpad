// Citycoin.dev master v5, stage S08: the schema groups of src/cc5schema.js on a COPY of the production database's shape. The copy is the
// production schema read on 24 October 2026 (test/fixtures/prod-schema-2026-10-24.sql, schema only) plus synthetic rows in every one of its
// 55 tables (test/helpers/cc5-d1copy.js: fake wallets, fake members, posts, coins; no member data). Every test runs twice:
//   - on Cloudflare's local D1 inside workerd (Miniflare, installed with wrangler): the real runner runs inside the Workers runtime;
//     skipped, with the reason, only when workerd cannot start here;
//   - on Node's SQLite (always).
// Nothing here reaches a remote resource: Miniflare runs a temporary local database and never fetches anything (cf: false).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CC5_GROUPS, CC5_ORDER, CC5_RESERVED, cc5Runner } from "../src/cc5schema.js";
import {
  buildCopy, docModel, docReference, docRow, insertStep, makeExecutorForReference, miniflareEngine, nodeEngine, normSql, recordedErrorNames,
  sharedValues,
} from "./helpers/cc5-d1copy.js";

const DBS = ["MAIN", "PREP", "KEPT", "CONS", "RACE", "FAIL", "REAL", "HOLE"];
const IDS = CC5_ORDER.filter((id) => CC5_GROUPS[id]); // section 3.10 step 2, cc5-identity (stage S09) reserved
const objectName = (s) => (/^CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(s) || [])[1];
const CC5_NAMES = new Set(IDS.flatMap((id) => CC5_GROUPS[id].statements).map(objectName));
const closure = (id) => {
  const seen = new Set();
  const add = (x) => { if (seen.has(x)) return; seen.add(x); CC5_GROUPS[x].requires.forEach(add); };
  add(id);
  return IDS.filter((x) => seen.has(x));
};

const engines = [];
const node = nodeEngine(DBS);
engines.push({ name: node.name, engine: node, skip: false });
let mf = null, mfSkip = false;
try { mf = await miniflareEngine(DBS); }
catch (e) { mfSkip = `miniflare local D1 unavailable here, so only node:sqlite ran: ${e.message}`; }
engines.unshift({ name: "miniflare local D1", engine: mf, skip: mfSkip });
after(async () => { if (mf) await mf.dispose(); });

/** One promise per engine and key: the copies are built once and shared by the tests that need them. */
const memo = new Map();
const once = (e, key, fn) => {
  const k = `${e.name}|${key}`;
  if (!memo.has(k)) memo.set(k, fn());
  return memo.get(k);
};
const byName = (snap) => new Map(snap.objects.map((o) => [o.name, o]));

/** MAIN: the copy before, every group applied in order by the module's own runner, the copy after; PREP: what today's ensureSchema adds. */
function mainRun(e) {
  return once(e, "main", async () => {
    const call = e.engine.call;
    const loaded = await buildCopy(e.engine, "MAIN");
    const before = await call({ op: "snapshot", db: "MAIN" });
    const reserved = await call({ op: "ensure", db: "MAIN", ids: Object.keys(CC5_RESERVED), isolate: "quiet" });
    const applied = await call({ op: "ensure", db: "MAIN", ids: IDS, isolate: "default" });
    const afterSnap = await call({ op: "snapshot", db: "MAIN" });
    await buildCopy(e.engine, "PREP");
    const prepBefore = await call({ op: "snapshot", db: "PREP" });
    await call({ op: "prepare", db: "PREP" });
    const prepAfter = await call({ op: "snapshot", db: "PREP" });
    const prepNames = new Set(prepBefore.objects.map((o) => o.name));
    return { loaded, before, reserved, applied, after: afterSnap, ensureSchemaAdds: prepAfter.objects.filter((o) => !prepNames.has(o.name)).map((o) => o.name) };
  });
}
/** A copy with every group applied (fresh isolate), for the tests that write rows. */
function migratedCopy(e, db) {
  return once(e, `copy-${db}`, async () => {
    await buildCopy(e.engine, db);
    const r = await e.engine.call({ op: "ensure", db, ids: IDS, isolate: "fresh" });
    assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
    return e.engine.call({ op: "snapshot", db });
  });
}
const cc5Objects = (snap) => snap.objects.filter((o) => CC5_NAMES.has(o.name) || CC5_NAMES.has(o.tbl_name));

for (const e of engines) {
  const t = (name, fn) => test(`${e.name}: ${name}`, { skip: e.skip }, fn);

  t("the copy is the production shape with synthetic rows in every table: 88 objects loaded, every table non-empty, D1's pragmas", async () => {
    const { loaded, before } = await mainRun(e);
    assert.equal(loaded, 88, "the schema read has 88 objects");
    const tables = Object.keys(before.tables);
    assert.equal(tables.filter((x) => x !== "sqlite_sequence").length, 55);
    for (const x of tables) assert.ok(before.tables[x].count >= 2, `${x} has rows (${before.tables[x].count})`);
    assert.ok(before.migrations.some((m) => m.id === "2026-10-09-expiry-indexes"));
    assert.ok(!before.migrations.some((m) => /^cc5-/.test(m.id)));
    // the conditions the append-only design is built for (schema-migrations.md section 4): no recursive triggers, foreign keys enforced
    assert.deepEqual(before.pragmas, { recursive_triggers: 0, foreign_keys: 1 });
  });

  t("every group applies on the copy in the section 3.10 order: cc5-identity answers group_not_built, each id resolves to itself and its prerequisites, statements run in order and the records land in order", async () => {
    const { before, reserved, applied, after: snap } = await mainRun(e);
    assert.deepEqual(reserved.results.map((r) => [r.id, r.ok, r.error && r.error.reason, r.error && r.error.status, r.error && r.error.code]),
      [["cc5-identity", false, "group_not_built", 503, "not_enabled"]]);
    assert.deepEqual(reserved.seen, [], "a reserved id touches nothing");
    assert.deepEqual(applied.results.map((r) => [r.id, r.ok, r.value]), IDS.map((id) => [id, true, closure(id)]));
    // every statement of every group ran exactly once, in CC5_ORDER and in each group's own order
    const created = applied.seen.filter((s) => CC5_NAMES.has(objectName(s)));
    assert.deepEqual(created, IDS.flatMap((id) => CC5_GROUPS[id].statements));
    const records = snap.migrations.slice(before.migrations.length).map((m) => m.id);
    assert.deepEqual(records, IDS, "one record per group, in the order of section 3.10");
    assert.ok(snap.migrations.slice(before.migrations.length).every((m) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.applied_at)));
  });

  t("re-running is a no-op: the same isolate issues no statement at all; a new isolate reads the seven records, creates and writes nothing; the copy stays identical", async () => {
    const { after: snap } = await mainRun(e);
    const same = await e.engine.call({ op: "ensure", db: "MAIN", ids: IDS, isolate: "default" });
    assert.deepEqual(same.results.map((r) => r.value), IDS.map(closure));
    assert.deepEqual(same.seen, [], "cached per isolate");
    const fresh = await e.engine.call({ op: "ensure", db: "MAIN", ids: [...IDS].reverse(), isolate: "fresh" });
    assert.ok(fresh.results.every((r) => r.ok));
    assert.ok(fresh.seen.length > 0);
    assert.deepEqual(fresh.seen.filter((s) => CC5_NAMES.has(objectName(s)) || /^(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b/i.test(s)), [],
      "no group statement and no write: only today's ensureSchema (CREATE ... IF NOT EXISTS of the existing tables) and record reads");
    assert.deepEqual(await e.engine.call({ op: "snapshot", db: "MAIN" }), snap);
  });

  t("nothing existing changes: every existing table keeps its columns, row count and sha256 over its sorted rows, every existing object is byte-identical, schema_migrations only gains the seven records", async () => {
    const { before, after: snap, ensureSchemaAdds } = await mainRun(e);
    for (const [name, b] of Object.entries(before.tables)) {
      if (name === "schema_migrations") continue;
      assert.deepEqual(snap.tables[name], b, `${name}: columns, ${b.count} rows and their hash unchanged`);
    }
    assert.deepEqual(snap.tables.schema_migrations.columns, before.tables.schema_migrations.columns);
    assert.deepEqual(snap.migrations.slice(0, before.migrations.length), before.migrations, "existing records untouched");
    assert.equal(snap.tables.schema_migrations.count, before.tables.schema_migrations.count + IDS.length);
    const now = byName(snap);
    for (const o of before.objects) assert.deepEqual(now.get(o.name), o, `${o.type} ${o.name} unchanged`);
    // what was added: the groups' objects and SQLite's automatic indexes of their keys, nothing else. The runner runs today's ensureSchema
    // first; on this shape it adds nothing, because the copy records the same migration ids production has (so streaks_active, declared inside
    // the already-recorded 2026-09-27-fair-launch migration, stays missing, as in the read: schema-migrations.md section 5)
    assert.deepEqual(ensureSchemaAdds, []);
    assert.ok(!now.has("streaks_active") && !before.objects.some((o) => o.name === "streaks_active"));
    const old = new Set(before.objects.map((o) => o.name));
    const added = snap.objects.filter((o) => !old.has(o.name));
    const unexplained = added.filter((o) => !CC5_NAMES.has(o.name) && !(o.type === "index" && o.sql === null && CC5_NAMES.has(o.tbl_name)));
    assert.deepEqual(unexplained, []);
    assert.equal(added.filter((o) => CC5_NAMES.has(o.name)).length, CC5_NAMES.size, "all 88 group objects");
  });

  t("the schema after all groups matches the doc: parsed from sqlite_master and the PRAGMAs, every table, column, CHECK, key and index is section 3's, the doc's own triggers are word for word, and every other trigger only refuses", async () => {
    const { after: snap } = await mainRun(e);
    const ref = docReference();
    const refExec = makeExecutorForReference(ref);
    const refSnap = await refExec({ op: "snapshot", db: "REF" });
    const docTables = refSnap.objects.filter((o) => o.type === "table" && o.name !== "sqlite_sequence").map((o) => o.name).sort();
    assert.equal(docTables.length, 26);
    const mine = cc5Objects(snap);
    assert.deepEqual(mine.filter((o) => o.type === "table").map((o) => o.name).sort(), docTables);
    // tables, named indexes and the doc's triggers: the text sqlite_master stores, whitespace aside
    const refByName = byName(refSnap), myByName = byName(snap);
    for (const o of refSnap.objects.filter((x) => x.sql && x.name !== "sqlite_sequence")) {
      assert.ok(myByName.has(o.name), `${o.type} ${o.name} exists`);
      assert.equal(normSql(myByName.get(o.name).sql), normSql(o.sql), `${o.type} ${o.name} as section 3 writes it`);
    }
    // columns (name, type, NOT NULL, default, key position), every index (unique, partial, origin) and its columns, from the PRAGMAs
    const myStructure = await e.engine.call({ op: "structure", db: "MAIN", tables: docTables });
    const refStructure = await refExec({ op: "structure", db: "REF", tables: docTables });
    assert.deepEqual(myStructure, refStructure);
    // every index the copy has on a doc table is one the doc defines (named, or SQLite's automatic one for a key)
    for (const o of mine.filter((x) => x.type === "index")) assert.ok(refByName.has(o.name), `index ${o.name} comes from the doc`);
    // the triggers beyond the doc's: BEFORE triggers on a doc table that only RAISE(ABORT) with a name the stage record lists
    const names = new Set(recordedErrorNames());
    const extra = mine.filter((o) => o.type === "trigger" && !refByName.has(o.name));
    assert.equal(extra.length + refSnap.objects.filter((o) => o.type === "trigger").length, 47);
    for (const o of extra) {
      const m = /^CREATE TRIGGER (\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+) (?:WHEN [\s\S]+ )?BEGIN SELECT RAISE\(ABORT, '([a-z_]+)'\); END$/.exec(o.sql);
      assert.ok(m, `${o.name} only refuses: ${o.sql.slice(0, 80)}`);
      assert.ok(docTables.includes(m[3]) && m[1].startsWith(`${m[3]}_`), `${o.name} is on its own table`);
      assert.ok(names.has(m[4]), `${o.name} raises ${m[4]}, a name schema-migrations.md lists`);
    }
    assert.equal(mine.filter((o) => o.type === "index" && o.sql).length, 15);
  });

  t("every append-only and kept table refuses UPDATE, DELETE, INSERT OR REPLACE, REPLACE and upsert rewrites (and INSERT OR IGNORE, UPDATE OR REPLACE) with its named error, and its rows stay byte-identical", async () => {
    const snap = await migratedCopy(e, "KEPT");
    const model = docModel();
    // each kept table, its row in the kept state, its error name, and the update that must be refused
    const SPEC = [
      ["founder_records", "founder_record_immutable", {}],
      ["manager_application_events", "manager_application_event_append_only", {}],
      ["activity_events", "activity_event_append_only", {}],
      ["city_metadata_versions", "metadata_version_append_only", {}],
      ["city_metadata_request_events", "metadata_request_event_append_only", {}],
      ["city_launches", "launch_record_immutable", {}],
      ["selection_cities", "city_already_founded", { status: "founded" }],
      ["selection_receipts", "receipt_immutable", { verifier_digest: "verified-digest-1" }],
      ["city_metadata_active", "metadata_frozen_after_launch", { launched_mint: "launched-mint-1" }],
      ["country_managers", "country_manager_append_only", {}], // an active manager: only the ending update is allowed
      ["hourly_runs", "hourly_run_permanent", {}, "utc_hour"], // status and progress may move; the keys may not
      ["hourly_samples", "hourly_sample_permanent", {}, "segment"],
      ["hourly_actions", "hourly_action_permanent", { status: "confirmed" }],
      ["hourly_leaves", "hourly_leaf_permanent", { status: "paid" }],
    ];
    // the spec covers every table that carries an overwrite guard
    const guarded = [...new Set(snap.objects.filter((o) => o.type === "trigger" && /_no_overwrite$/.test(o.name)).map((o) => o.tbl_name))].sort();
    assert.deepEqual(SPEC.map((s) => s[0]).sort(), guarded);
    let attempts = 0;
    for (const [table, name, over, keyToChange] of SPEC) {
      const m = model[table];
      const key = m.keys.find((k) => k.kind === "pk").cols;
      const kept = docRow(m, 1, over);
      const other = docRow(m, 2);
      const free = m.columns.find((c) => c.notNull && c.type === "TEXT" && !c.check && !m.keys.some((k) => k.cols.includes(c.name)));
      const changed = { ...kept, [free.name]: `${kept[free.name]}-rewritten` };
      const setup = await e.engine.call({ op: "exec", db: "KEPT", steps: [insertStep("INSERT INTO", table, kept), insertStep("INSERT INTO", table, other, "", table)] });
      assert.ok(setup.every((s) => s.ok), `${table}: ${JSON.stringify(setup)}`);
      const hash = setup[1].check;
      const where = key.map((c) => `${c} = ?`).join(" AND ");
      const keyVals = key.map((c) => kept[c]);
      const upd = keyToChange || free.name;
      const steps = [
        ["UPDATE", { sql: `UPDATE ${table} SET ${upd} = ? WHERE ${where}`, params: [typeof kept[upd] === "number" ? kept[upd] + 1000 : `${kept[upd]}-x`, ...keyVals] }],
        ["DELETE", { sql: `DELETE FROM ${table} WHERE ${where}`, params: keyVals }],
        ["INSERT OR REPLACE", insertStep("INSERT OR REPLACE INTO", table, changed)],
        ["REPLACE", insertStep("REPLACE INTO", table, changed)],
        ["upsert DO UPDATE", insertStep("INSERT INTO", table, changed, ` ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${free.name} = excluded.${free.name}`)],
        ["INSERT OR IGNORE", insertStep("INSERT OR IGNORE INTO", table, changed)],
        ["ON CONFLICT DO NOTHING", insertStep("INSERT INTO", table, changed, " ON CONFLICT DO NOTHING")],
        ["UPDATE OR REPLACE onto the kept key", { sql: `UPDATE OR REPLACE ${table} SET ${key.map((c) => `${c} = ?`).join(", ")} WHERE ${key.map((c) => `${c} = ?`).join(" AND ")}`, params: [...keyVals, ...key.map((c) => other[c])] }],
      ];
      const res = await e.engine.call({ op: "exec", db: "KEPT", steps: steps.map(([, s]) => ({ ...s, check: table })) });
      res.forEach((r, i) => {
        attempts++;
        assert.equal(r.ok, false, `${table}: ${steps[i][0]} must be refused`);
        assert.match(r.error, new RegExp(`\\b${name}\\b`), `${table}: ${steps[i][0]} refused with ${name}: ${r.error}`);
        assert.deepEqual(r.check, hash, `${table}: ${steps[i][0]} left every row byte-identical`);
      });
    }
    assert.equal(attempts, SPEC.length * 8);
    // the same statements work on a table the doc keeps mutable, so the refusals above are the triggers', not the statements'
    const free = await e.engine.call({ op: "exec", db: "KEPT", steps: [
      { sql: "INSERT INTO activity_totals (user_id, total, by_category, computed_at, policy_version) VALUES (1, 2, '{}', 't', 'v')" },
      { sql: "INSERT OR REPLACE INTO activity_totals (user_id, total, by_category, computed_at, policy_version) VALUES (1, 4, '{}', 't', 'v')" },
      { sql: "INSERT INTO activity_totals (user_id, total, by_category, computed_at, policy_version) VALUES (1, 6, '{}', 't', 'v') ON CONFLICT (user_id) DO UPDATE SET total = excluded.total" },
      { sql: "UPDATE activity_totals SET total = 8 WHERE user_id = 1" },
      { sql: "DELETE FROM activity_totals WHERE user_id = 1" },
    ] });
    assert.deepEqual(free.map((r) => r.ok), [true, true, true, true, true]);
  });

  t("CHECK, NOT NULL and UNIQUE reject every row the doc forbids: each CHECK list and range, each NOT NULL column, each key, unique index and partial unique index of sections 3.2 to 3.8", async () => {
    const snap = await migratedCopy(e, "CONS");
    const model = docModel();
    const guardNames = {};
    for (const o of snap.objects.filter((x) => x.type === "trigger")) (guardNames[o.tbl_name] ||= new Set()).add((/RAISE\(ABORT, '([a-z_]+)'\)/.exec(o.sql) || [])[1]);
    const counts = { check: 0, range: 0, notNull: 0, key: 0, partial: 0, accepted: 0 };
    for (const m of Object.values(model)) {
      const t0 = m.name;
      const uniqueErr = new RegExp(`UNIQUE constraint failed|${[...(guardNames[t0] || [])].join("|") || "(?!)"}`);
      let k = 1000;
      const steps = [];
      const want = [];
      const add = (step, ok, re, what) => { steps.push(step); want.push({ ok, re, what }); };
      add(insertStep("INSERT INTO", t0, docRow(m, k++)), true, null, "a valid row");
      for (const c of m.columns) {
        if (c.check && c.check.in) {
          add(insertStep("INSERT INTO", t0, docRow(m, k++, { [c.name]: `not_${c.name}` })), false, /CHECK constraint failed/, `${c.name} outside its list`); counts.check++;
          for (const v of c.check.in) { add(insertStep("INSERT INTO", t0, docRow(m, k++, { [c.name]: v })), true, null, `${c.name} = ${v}`); counts.accepted++; }
        }
        if (c.check && c.check.between) {
          const [lo, hi] = c.check.between;
          for (const v of [lo - 1, hi + 1]) { add(insertStep("INSERT INTO", t0, docRow(m, k++, { [c.name]: v })), false, /CHECK constraint failed/, `${c.name} = ${v}`); counts.range++; }
          for (const v of [lo, hi]) { add(insertStep("INSERT INTO", t0, docRow(m, k++, { [c.name]: v })), true, null, `${c.name} = ${v}`); counts.accepted++; }
        }
        if (c.notNull) { add(insertStep("INSERT INTO", t0, docRow(m, k++, { [c.name]: null })), false, /NOT NULL constraint failed/, `${c.name} NULL`); counts.notNull++; }
      }
      for (const key of [...m.keys.map((x) => x.cols), ...m.uniqueIndexes.filter((x) => !x.where).map((x) => x.cols)]) {
        const vals = sharedValues(m, key, k + 500);
        add(insertStep("INSERT INTO", t0, docRow(m, k++, vals)), true, null, `first row on (${key})`);
        add(insertStep("INSERT INTO", t0, docRow(m, k++, vals)), false, uniqueErr, `second row on (${key})`); counts.key++;
      }
      for (const ix of m.uniqueIndexes.filter((x) => x.where)) {
        let inside, outside;
        let w;
        if ((w = /^(\w+) = '([^']*)'$/.exec(ix.where))) { inside = { [w[1]]: w[2] }; outside = { [w[1]]: m.columns.find((c) => c.name === w[1]).check.in.find((v) => v !== w[2]) }; }
        else if ((w = /^(\w+) IN \((.*)\)$/.exec(ix.where))) {
          const list = [...w[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
          inside = { [w[1]]: list[0] }; outside = { [w[1]]: m.columns.find((c) => c.name === w[1]).check.in.find((v) => !list.includes(v)) };
        } else if ((w = /^(\w+) IS NULL$/.exec(ix.where))) { inside = { [w[1]]: null }; outside = { [w[1]]: `${w[1]}-set` }; }
        const vals = sharedValues(m, ix.cols, k + 700);
        add(insertStep("INSERT INTO", t0, docRow(m, k++, { ...vals, ...inside })), true, null, `${ix.name}: first row inside`);
        add(insertStep("INSERT INTO", t0, docRow(m, k++, { ...vals, ...inside })), false, uniqueErr, `${ix.name}: second row inside`); counts.partial++;
        add(insertStep("INSERT INTO", t0, docRow(m, k++, { ...vals, ...outside })), true, null, `${ix.name}: a row outside the index`);
      }
      const res = await e.engine.call({ op: "exec", db: "CONS", steps });
      res.forEach((r, i) => {
        const w0 = want[i];
        if (w0.ok) assert.ok(r.ok, `${t0}: ${w0.what} is accepted: ${r.error}`);
        else { assert.equal(r.ok, false, `${t0}: ${w0.what} is refused`); assert.match(r.error, w0.re, `${t0}: ${w0.what}`); }
      });
    }
    // the walk is not vacuous: 26 CHECK lists (107 allowed values accepted), 4 ranges (each end refused one past it), 211 NOT NULL columns,
    // 45 keys and non-partial unique indexes, the 5 partial unique indexes
    assert.deepEqual(counts, { check: 26, range: 8, notNull: 211, key: 45, partial: 5, accepted: 107 });
  });

  t("open item O9, pinned: a single-column PRIMARY KEY without NOT NULL accepts NULL (SQLite's legacy rule, on D1 too), so writers always bind the key", async () => {
    await migratedCopy(e, "CONS");
    const model = docModel();
    const loose = Object.values(model).flatMap((m) => m.columns.filter((c) => c.pk && !c.notNull && !c.autoinc).map((c) => [m, c]));
    assert.deepEqual(loose.map(([m, c]) => `${m.name}.${c.name} ${c.type}`).sort(), [
      "activity_totals.user_id INTEGER", "city_metadata_active.city_id TEXT", "city_review_locks.city_id TEXT", "founder_records.city_id TEXT",
      "hourly_actions.action_key TEXT", "job_leases.name TEXT", "launch_preparations.id TEXT", "selection_cities.city_id TEXT", "selection_receipts.cycle_id INTEGER",
    ]);
    const steps = loose.map(([m, c]) => insertStep("INSERT INTO", m.name, docRow(m, 5000, { [c.name]: null })));
    const res = await e.engine.call({ op: "exec", db: "CONS", steps });
    // TEXT keys take NULL; an INTEGER PRIMARY KEY (the rowid) is given the next number instead: either way the row is not refused
    assert.deepEqual(res.map((r) => r.ok), loose.map(() => true), JSON.stringify(res));
  });

  t("two runners at once (two requests, each racing every group from new isolates, plus a second runtime on the same D1) all succeed and record each group once", async () => {
    await buildCopy(e.engine, "RACE");
    const reference = cc5Objects((await mainRun(e)).after);
    const races = [
      e.engine.call({ op: "race", db: "RACE", ids: [...IDS, ...IDS].reverse() }),
      e.engine.call({ op: "race", db: "RACE", ids: IDS }),
    ];
    // on workerd, the same database from Node as well (Miniflare's proxy): the runner in two runtimes at once
    if (e.engine.proxy) races.push(e.engine.proxy("RACE").then((db) => cc5Runner({ log: () => {} })(db, "cc5-selection")).then((v) => [{ id: "cc5-selection", ok: true, value: [...v] }]));
    const results = (await Promise.all(races)).flat();
    for (const r of results) assert.ok(r.ok, `${r.id}: ${JSON.stringify(r.error)}`);
    for (const r of results) assert.deepEqual(r.value, closure(r.id));
    const snap = await e.engine.call({ op: "snapshot", db: "RACE" });
    const ids = snap.migrations.map((m) => m.id).filter((id) => /^cc5-/.test(id)).sort();
    assert.deepEqual(ids, [...IDS].sort(), "each group recorded exactly once");
    assert.deepEqual(cc5Objects(snap), reference, "the same objects as one runner in order");
  });

  t("a failure injected mid-group leaves no schema_migrations row for that group (nor for a prerequisite that failed), keeps what already existed, and a retry completes to the same end state", async () => {
    await buildCopy(e.engine, "FAIL");
    const { before, after: clean } = await mainRun(e);
    const call = (o) => e.engine.call({ op: "ensure", db: "FAIL", isolate: "isolate-1", ...o });
    const recorded = async () => (await e.engine.call({ op: "objects", db: "FAIL" })).records.filter((id) => /^cc5-/.test(id)).sort();
    const tables = async () => new Set((await e.engine.call({ op: "objects", db: "FAIL" })).names);
    const stepOf = (id, re) => CC5_GROUPS[id].statements.findIndex((s) => re.test(s));

    // 1. a prerequisite fails (cc5-ops, at its second statement): neither group is recorded
    let r = await call({ ids: ["cc5-hourly"], failOn: "^CREATE TABLE IF NOT EXISTS idempotency_keys\\b", failTimes: 1 });
    assert.deepEqual(pick(r.results[0].error), { reason: "prerequisite_failed", group: "cc5-hourly", failed: "cc5-ops", step: 1, status: 503, code: "not_enabled" });
    assert.match(r.results[0].error.cause, /Network connection lost/);
    assert.deepEqual(await recorded(), []);
    assert.ok((await tables()).has("job_leases") && !(await tables()).has("idempotency_keys"), "the statement before the failure ran (each is safe to run again)");

    // 2. mid-group, a group without prerequisites (cc5-metadata, at its third table)
    const midStep = stepOf("cc5-metadata", /^CREATE TABLE IF NOT EXISTS city_metadata_uploads\b/);
    assert.ok(midStep > 0 && midStep < CC5_GROUPS["cc5-metadata"].statements.length - 1, "really mid-group");
    r = await call({ ids: ["cc5-metadata"], failOn: "^CREATE TABLE IF NOT EXISTS city_metadata_uploads\\b", failTimes: 1 });
    assert.deepEqual(pick(r.results[0].error), { reason: "statement_failed", group: "cc5-metadata", failed: "cc5-metadata", step: midStep, status: 503, code: "not_enabled" });
    assert.deepEqual(await recorded(), [], "no row for the failed group");
    let names = await tables();
    assert.ok(names.has("city_metadata_versions") && names.has("city_metadata_active") && !names.has("city_metadata_uploads") && !names.has("city_metadata_requests"));

    // 3. mid-group with its prerequisites done: they are recorded, the group is not (cc5-launch, at its overwrite guard)
    r = await call({ ids: ["cc5-launch"], failOn: "^CREATE TRIGGER IF NOT EXISTS city_launches_no_overwrite\\b", failTimes: 1 });
    assert.deepEqual(pick(r.results[0].error), { reason: "statement_failed", group: "cc5-launch", failed: "cc5-launch", step: stepOf("cc5-launch", /city_launches_no_overwrite/), status: 503, code: "not_enabled" });
    assert.deepEqual(await recorded(), ["cc5-metadata", "cc5-ops"]);

    // 4. every statement succeeds but the record fails: still no row
    r = await call({ ids: ["cc5-activity"], failOn: "^INSERT OR IGNORE INTO schema_migrations\\b", failTimes: 1 });
    assert.equal(r.results[0].error.reason, "record_failed");
    assert.deepEqual(await recorded(), ["cc5-metadata", "cc5-ops"]);

    // the failures were forgotten: the same isolate retries every group and each completes
    r = await call({ ids: IDS });
    assert.deepEqual(r.results.map((x) => [x.id, x.ok]), IDS.map((id) => [id, true]));
    assert.deepEqual(await recorded(), [...IDS].sort());
    const end = await e.engine.call({ op: "snapshot", db: "FAIL" });
    assert.deepEqual(cc5Objects(end), cc5Objects(clean), "the same objects as a clean run");
    for (const [name, b] of Object.entries(before.tables)) if (name !== "schema_migrations") assert.deepEqual(end.tables[name], b, `${name} unchanged`);
  });

  t("a real engine error mid-group (a stray table without the expected columns) leaves no record; once it is removed the retry completes", async () => {
    await buildCopy(e.engine, "REAL");
    const stray = await e.engine.call({ op: "exec", db: "REAL", steps: [{ sql: "CREATE TABLE city_metadata_requests (id INTEGER PRIMARY KEY)" }] });
    assert.ok(stray[0].ok);
    let r = await e.engine.call({ op: "ensure", db: "REAL", isolate: "isolate-r", ids: ["cc5-metadata"] });
    const err = r.results[0].error;
    assert.equal(err.reason, "statement_failed");
    assert.equal(err.step, CC5_GROUPS["cc5-metadata"].statements.findIndex((s) => /city_metadata_requests_open/.test(s)));
    assert.match(err.cause, /no such column/);
    assert.ok(!(await e.engine.call({ op: "objects", db: "REAL" })).records.some((id) => /^cc5-/.test(id)));
    await e.engine.call({ op: "exec", db: "REAL", steps: [{ sql: "DROP TABLE city_metadata_requests" }] });
    r = await e.engine.call({ op: "ensure", db: "REAL", isolate: "isolate-r", ids: ["cc5-metadata"] });
    assert.ok(r.results[0].ok);
    const snap = await e.engine.call({ op: "snapshot", db: "REAL" });
    const clean = cc5Objects((await mainRun(e)).after).filter((o) => CC5_GROUPS["cc5-metadata"].statements.some((s) => objectName(s) === o.name || objectName(s) === o.tbl_name));
    assert.deepEqual(cc5Objects(snap), clean);
  });

  t("why the overwrite guard exists, shown on this engine: without it INSERT OR REPLACE silently rewrites a founder record (its DELETE trigger never fires); with it the same statement is refused", async () => {
    await buildCopy(e.engine, "HOLE");
    await e.engine.call({ op: "ensure", db: "HOLE", isolate: "fresh", ids: ["cc5-selection"] });
    const m = docModel().founder_records;
    const row = docRow(m, 1);
    const guard = CC5_GROUPS["cc5-selection"].statements.find((s) => objectName(s) === "founder_records_no_overwrite");
    const replace = insertStep("INSERT OR REPLACE INTO", "founder_records", { ...row, snapshot_hash: "rewritten" }, "", "founder_records");
    const res = await e.engine.call({ op: "exec", db: "HOLE", steps: [
      { sql: "DROP TRIGGER founder_records_no_overwrite" },
      insertStep("INSERT INTO", "founder_records", row, "", "founder_records"),
      replace,
      { sql: "SELECT 1", check: "founder_records" },
      { sql: guard },
      replace,
    ] });
    assert.deepEqual(res.slice(0, 5).map((r) => r.ok), [true, true, true, true, true]);
    assert.notDeepEqual(res[2].check, res[1].check, "the hole: REPLACE rewrote the kept record");
    assert.equal(res[2].check.count, 1);
    assert.equal(res[5].ok, false);
    assert.match(res[5].error, /founder_record_immutable/);
    assert.deepEqual(res[5].check, res[3].check);
  });
}

function pick(err) {
  const { reason, group, failed, step, status, code } = err;
  return { reason, group, failed, step, status, code };
}
