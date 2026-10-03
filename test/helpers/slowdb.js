// A database that answers a little later than the code runs, like the real one, so requests that arrive
// together really do overlap. Copied from test/email-auth.test.js (which keeps its own private copy), with one
// addition: batch() pauses before and after, and runs the whole batch in one go like D1 does (one transaction,
// never interleaved with another), so parallel batches do not trip over each other on the single test connection.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function slowDb(db, ms = 2) {
  const wrap = (stmt) => ({
    sql: stmt.sql,
    inner: stmt,
    bind: (...p) => wrap(stmt.bind(...p)),
    first: async (...a) => { await sleep(ms); const r = await stmt.first(...a); await sleep(ms); return r; },
    run: async () => { await sleep(ms); const r = await stmt.run(); await sleep(ms); return r; },
    all: async () => { await sleep(ms); const r = await stmt.all(); await sleep(ms); return r; },
  });
  return {
    ...db,
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: async (list) => {
      await sleep(ms);
      const r = await db.batch(list.map((s) => s.inner || s));
      await sleep(ms);
      return r;
    },
  };
}
