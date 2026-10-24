// The executor of the S08 D1-copy tests (test/cc5-d1copy.test.js; harness in test/helpers/cc5-d1copy.js). One module, two engines:
//   - inside workerd: Miniflare loads this file as the Worker (with src/cc5schema.js and src/store.js), each local D1 database is a
//     binding, and every operation is one POST to the Worker. So the real runner (src/cc5schema.js) and every statement run inside the
//     Workers runtime against Cloudflare's local D1, and a whole list of statements costs one round trip.
//   - in Node: makeExecutor({ NAME: d1(), ... }) over test/helpers/d1.js (Node's SQLite), when workerd is not available or for speed.
// The operations (all JSON in, JSON out; a BLOB parameter is { $blob: "<hex>" }):
//   load     { db, statements }                 run a list of statements in one batch (a restore of the schema read)
//   seed     { db, rows: { table: [row] } }     INSERT every row in one batch
//   objects  { db }                             the object names and the schema_migrations ids only (cheap)
//   snapshot { db }                             sqlite_master (local D1's own _cf_* objects left out) and, for every table, its columns,
//                                               row count and a sha256 over its rows (each row as SQLite's quote() of every column,
//                                               sorted); also the schema_migrations rows and two pragmas
//   structure{ db, tables }                     PRAGMA table_xinfo, index_list and index_xinfo of each table
//   exec     { db, steps: [{ sql, params, check }] }  each step on its own; { ok, changes } or { ok: false, error }; with `check` (a table
//                                               name) also that table's { count, sha256 } after the step
//   prepare  { db }                             today's ensureSchema (src/store.js) only
//   ensure   { db, ids, isolate, failOn, failTimes, failMessage }  ensure each id in turn with the runner of `isolate`: "default" (the
//                                               module's runner with its own defaults: the runner ensureCc5Group runs behind its switch
//                                               gate, which the copy's settings never open), a name (a runner of its own, kept across
//                                               operations: one simulated isolate), or "fresh" (a new runner and a new database object: a
//                                               new isolate). failOn (a regular expression source) makes the matching statements throw
//                                               failMessage, failTimes times. Answers the result or the error of each id and every
//                                               statement issued.
//   gated    { db, ids, vars }                  ensureCc5Group itself (the Worker's entry, gate included) with env = vars + the database
//   race     { db, ids }                        ensure every id at once, each from a new isolate
import { CC5_GROUPS, cc5Runner, ensureCc5Group } from "../../src/cc5schema.js";
import { ensureSchema } from "../../src/store.js";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const fromHex = (h) => new Uint8Array(String(h).match(/../g).map((x) => parseInt(x, 16)));
const param = (v) => (v !== null && typeof v === "object" && typeof v.$blob === "string" ? fromHex(v.$blob) : v);
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

function errorOf(e) {
  if (!e || typeof e !== "object") return { message: String(e) };
  const out = { name: e.name, message: String(e.message) };
  for (const k of ["reason", "group", "failed", "inner", "step", "status", "code"]) if (e[k] !== undefined) out[k] = e[k];
  if (e.cause !== undefined) out.cause = String((e.cause && e.cause.message) || e.cause);
  return out;
}

/** A database object that records every statement and can be told to fail some (an injected D1 failure). */
export function recorder(db) {
  const state = { seen: [], fail: null };
  const check = (sql) => {
    state.seen.push(sql);
    const f = state.fail;
    if (f && f.left > 0 && f.re.test(sql)) { f.left--; throw new Error(f.message); }
  };
  const wrap = (stmt, sql) => ({
    inner: stmt,
    sql,
    bind: (...p) => wrap(stmt.bind(...p), sql),
    run: async () => { check(sql); return stmt.run(); },
    first: async (c) => { check(sql); return c === undefined ? stmt.first() : stmt.first(c); },
    all: async () => { check(sql); return stmt.all(); },
    raw: async (o) => { check(sql); return stmt.raw(o); },
  });
  const wrapped = {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (list) => { for (const s of list) check(s.sql); return db.batch(list.map((s) => s.inner)); },
    exec: async (q) => { check(q); return db.exec(q); },
  };
  return { db: wrapped, state };
}

/** Every table's columns, row count and row hash; the objects; schema_migrations. Counts and hashes only, never a row (except schema_migrations). */
async function snapshot(db) {
  const objects = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name").all()).results;
  const tables = {};
  for (const o of objects.filter((x) => x.type === "table")) tables[o.name] = await tableHash(db, o.name);
  const migrations = tables.schema_migrations ? (await db.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).results : [];
  const pragma = async (p) => Object.values((await db.prepare(`PRAGMA ${p}`).all()).results[0] || {})[0];
  return { objects, tables, migrations, pragmas: { recursive_triggers: await pragma("recursive_triggers"), foreign_keys: await pragma("foreign_keys") } };
}

export async function tableHash(db, table) {
  const columns = (await db.prepare(`PRAGMA table_info(${ident(table)})`).all()).results.map((c) => c.name);
  const expr = columns.map((c) => `quote(${ident(c)})`).join(" || ',' || ");
  const lines = (await db.prepare(`SELECT ${expr} AS line FROM ${ident(table)}`).all()).results.map((r) => r.line);
  lines.sort();
  return { columns, count: lines.length, sha256: await sha256Hex(`${columns.join(",")}\n${lines.join("\n")}`) };
}

async function structure(db, tables) {
  const out = {};
  for (const t of tables) {
    const xinfo = (await db.prepare(`PRAGMA table_xinfo(${ident(t)})`).all()).results;
    const indexes = [];
    for (const ix of (await db.prepare(`PRAGMA index_list(${ident(t)})`).all()).results) {
      indexes.push({ ...ix, columns: (await db.prepare(`PRAGMA index_xinfo(${ident(ix.name)})`).all()).results });
    }
    out[t] = { xinfo, indexes };
  }
  return out;
}

/** The executor over a set of D1 bindings ({ NAME: D1Database }). State (the simulated isolates) lives as long as the executor. */
export function makeExecutor(env) {
  const isolates = new Map(); // `${db}|${name}` -> { runner, rec }
  const binding = (name) => {
    const db = env[name];
    if (!db || typeof db.prepare !== "function") throw new Error(`no database ${name}`);
    return db;
  };
  const isolate = (db, name) => {
    if (name === "fresh") return { runner: cc5Runner({ log: () => {} }), rec: recorder(binding(db)) };
    const key = `${db}|${name}`;
    if (!isolates.has(key)) isolates.set(key, { runner: cc5Runner({ log: () => {} }), rec: recorder(binding(db)) });
    return isolates.get(key);
  };

  return async function execute(op) {
    switch (op.op) {
      case "load": {
        const db = binding(op.db);
        await db.batch(op.statements.map((s) => db.prepare(s)));
        return { ok: true, count: op.statements.length };
      }
      case "seed": {
        const db = binding(op.db);
        const list = [];
        for (const [table, rows] of Object.entries(op.rows)) {
          for (const row of rows) {
            const cols = Object.keys(row);
            list.push(db.prepare(`INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => param(row[c]))));
          }
        }
        await db.batch(list);
        return { ok: true, count: list.length };
      }
      case "snapshot": return snapshot(binding(op.db));
      case "objects": {
        const db = binding(op.db);
        const names = (await db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name);
        const records = (await db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all()).results.map((r) => r.id);
        return { names, records };
      }
      case "structure": return structure(binding(op.db), op.tables);
      case "exec": {
        const db = binding(op.db);
        const out = [];
        for (const s of op.steps) {
          let r;
          try {
            const res = await db.prepare(s.sql).bind(...(s.params || []).map(param)).run();
            r = { ok: true, changes: res && res.meta ? res.meta.changes : null };
          } catch (e) {
            r = { ok: false, error: String((e && e.message) || e) };
          }
          if (s.check) r.check = await tableHash(db, s.check);
          out.push(r);
        }
        return out;
      }
      case "prepare": {
        await ensureSchema(binding(op.db));
        return { ok: true };
      }
      case "ensure": {
        const iso = isolate(op.db, op.isolate || "default");
        iso.rec.state.seen = [];
        iso.rec.state.fail = op.failOn ? { re: new RegExp(op.failOn), left: op.failTimes ?? Infinity, message: op.failMessage || "D1_ERROR: Network connection lost." } : null;
        const results = [];
        try {
          for (const id of op.ids) {
            try { results.push({ id, ok: true, value: [...(await iso.runner(iso.rec.db, id))] }); }
            catch (e) { results.push({ id, ok: false, error: errorOf(e) }); }
          }
        } finally {
          iso.rec.state.fail = null;
        }
        return { results, seen: iso.rec.state.seen };
      }
      case "gated": {
        const rec = recorder(binding(op.db));
        const results = [];
        for (const id of op.ids) {
          try { results.push({ id, ok: true, value: [...(await ensureCc5Group({ ...op.vars, DB: rec.db }, id))] }); }
          catch (e) { results.push({ id, ok: false, error: errorOf(e) }); }
        }
        return { results, seen: rec.state.seen };
      }
      case "race": {
        const runs = op.ids.map((id) => {
          const iso = isolate(op.db, "fresh");
          return iso.runner(iso.rec.db, id).then((v) => ({ id, ok: true, value: [...v] }), (e) => ({ id, ok: false, error: errorOf(e) }));
        });
        return Promise.all(runs);
      }
      case "groups": return Object.fromEntries(Object.entries(CC5_GROUPS).map(([id, g]) => [id, g.statements.length]));
      default: throw new Error(`unknown operation ${op.op}`);
    }
  };
}

let workerExecutor = null;
export default {
  async fetch(request, env) {
    workerExecutor ??= makeExecutor(env);
    try {
      return Response.json({ ok: true, value: await workerExecutor(await request.json()) });
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.stack) || e) }, { status: 500 });
    }
  },
};
