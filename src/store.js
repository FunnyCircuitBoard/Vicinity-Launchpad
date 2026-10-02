// src/store.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
var SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  city_id    TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL UNIQUE,
  city_name  TEXT NOT NULL,
  country    TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS added_cities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  country    TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS added_by_country ON added_cities (country, norm);
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet       TEXT NOT NULL UNIQUE,
  provider     TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  handle       TEXT,
  name         TEXT,
  home_city    TEXT,
  home_name    TEXT,
  home_country TEXT,
  home_at      TEXT,
  early        INTEGER NOT NULL DEFAULT 0,
  badges       TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS users_home ON users (home_city);
CREATE INDEX IF NOT EXISTS users_country ON users (home_country);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  wallet     TEXT,
  user_id    INTEGER,
  proof      TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  id         TEXT PRIMARY KEY,
  pin        TEXT NOT NULL,
  wallet     TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  send_count   INTEGER NOT NULL DEFAULT 0,
  window_start TEXT,
  last_sent_at TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  scope      TEXT NOT NULL,
  place      TEXT NOT NULL,
  country    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  media_id   INTEGER,
  parent_id  INTEGER,
  score      INTEGER NOT NULL DEFAULT 0,
  reports    INTEGER NOT NULL DEFAULT 0,
  replies    INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_feed ON posts (scope, place, kind, created_at);
CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, created_at);
CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id);
CREATE TABLE IF NOT EXISTS votes (
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  weight     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS reports (
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  user_id    INTEGER NOT NULL,
  country    TEXT NOT NULL,
  by_user    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, country)
);
CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  country    TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  near       TEXT,
  status     TEXT NOT NULL DEFAULT 'waiting',
  decided_by INTEGER,
  note       TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS requests_country ON requests (country, status);
`;
var MIGRATIONS = [
  {
    id: "2026-09-27-fair-launch",
    sql: `
ALTER TABLE sessions ADD COLUMN proven_at TEXT;
ALTER TABLE posts ADD COLUMN hidden_until TEXT;
ALTER TABLE posts ADD COLUMN hide_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bans ADD COLUMN expires_at TEXT;
ALTER TABLE bans ADD COLUMN action_id INTEGER;
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  key  TEXT NOT NULL,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, part)
);
CREATE TABLE IF NOT EXISTS balance_samples (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  day      TEXT NOT NULL,
  slot     INTEGER,
  holders  INTEGER NOT NULL,
  hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_samples_day ON balance_samples (day);
CREATE TABLE IF NOT EXISTS streaks (
  wallet      TEXT NOT NULL,
  level       REAL NOT NULL,
  above_since TEXT,
  PRIMARY KEY (wallet, level)
);
CREATE TABLE IF NOT EXISTS used_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_events (
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_user ON rate_events (user_id, kind, at);
CREATE TABLE IF NOT EXISTS windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id    TEXT NOT NULL,
  city_name  TEXT NOT NULL,
  country    TEXT NOT NULL,
  policy     INTEGER NOT NULL,
  threshold  REAL NOT NULL,
  opened_at  TEXT NOT NULL,
  closes_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  kind       TEXT NOT NULL DEFAULT 'standard',
  decided_at TEXT,
  result     TEXT,
  result_hash TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS windows_open_city ON windows (city_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  window_id  INTEGER NOT NULL,
  city_id    TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  wallet     TEXT NOT NULL,
  squad_id   INTEGER,
  pitch      TEXT,
  created_at TEXT NOT NULL,
  withdrawn  INTEGER NOT NULL DEFAULT 0,
  valid      INTEGER,
  endorse_score  REAL,
  contrib_score  REAL,
  stake_score    REAL,
  total      REAL,
  tiebreak   TEXT,
  rank       INTEGER,
  UNIQUE (window_id, user_id)
);
CREATE INDEX IF NOT EXISTS applications_user ON applications (user_id);
CREATE TABLE IF NOT EXISTS endorsements (
  window_id      INTEGER NOT NULL,
  user_id        INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (window_id, user_id)
);
CREATE TABLE IF NOT EXISTS seats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id        TEXT NOT NULL,
  city_name      TEXT NOT NULL,
  country        TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  wallet         TEXT NOT NULL,
  window_id      INTEGER,
  application_id INTEGER,
  policy         INTEGER NOT NULL,
  threshold      REAL NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  appeal_until   TEXT,
  activated_at   TEXT,
  probation_until TEXT,
  grace_until    TEXT,
  graces         TEXT NOT NULL DEFAULT '[]',
  ended_at       TEXT,
  end_reason     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS seats_city_live ON seats (city_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
CREATE UNIQUE INDEX IF NOT EXISTS seats_user_live ON seats (user_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
CREATE TABLE IF NOT EXISTS squads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id      TEXT NOT NULL,
  city_name    TEXT NOT NULL,
  country      TEXT NOT NULL,
  created_by   INTEGER NOT NULL,
  founder_wallet TEXT,
  status       TEXT NOT NULL DEFAULT 'forming',
  created_at   TEXT NOT NULL,
  seated_at    TEXT
);
CREATE TABLE IF NOT EXISTS squad_members (
  squad_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  wallet    TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (squad_id, user_id)
);
CREATE INDEX IF NOT EXISTS squad_members_user ON squad_members (user_id);
CREATE INDEX IF NOT EXISTS seats_country ON seats (country, status);
CREATE TABLE IF NOT EXISTS objections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_by INTEGER,
  decided_at TEXT,
  note       TEXT,
  UNIQUE (seat_id, user_id)
);
CREATE TABLE IF NOT EXISTS elections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  country    TEXT NOT NULL,
  policy     INTEGER NOT NULL,
  opened_at  TEXT NOT NULL,
  closes_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_at TEXT,
  result     TEXT,
  result_hash TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS elections_open_country ON elections (country) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS election_votes (
  election_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  seat_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (election_id, user_id)
);
CREATE TABLE IF NOT EXISTS manager_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  country     TEXT NOT NULL,
  seat_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  election_id INTEGER,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  consecutive INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'upcoming',
  ended_reason TEXT
);
CREATE INDEX IF NOT EXISTS manager_terms_country ON manager_terms (country, status);
CREATE TABLE IF NOT EXISTS mod_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER,
  target_user INTEGER,
  country     TEXT,
  place       TEXT,
  reason      TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  state       TEXT NOT NULL DEFAULT 'done',
  second_id   INTEGER,
  second_at   TEXT
);
CREATE INDEX IF NOT EXISTS mod_actions_country ON mod_actions (country, created_at);
CREATE INDEX IF NOT EXISTS mod_actions_target ON mod_actions (target_type, target_id);
CREATE TABLE IF NOT EXISTS appeals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_by INTEGER,
  decided_at TEXT,
  note       TEXT,
  UNIQUE (action_id, user_id)
);
CREATE TABLE IF NOT EXISTS town_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  country    TEXT NOT NULL,
  near_id    TEXT,
  near_name  TEXT,
  near_km    INTEGER,
  inside     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'waiting',
  decided_by INTEGER,
  note       TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS town_requests_country ON town_requests (country, status);
CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cutoff_at   TEXT NOT NULL,
  policy      INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'provisional',
  activates_at TEXT NOT NULL,
  holders     INTEGER NOT NULL,
  total       REAL NOT NULL,
  samples     INTEGER NOT NULL,
  input_hash  TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  note        TEXT
);
`
  },
  {
    // City coins designed by City Founders (src/coins.js)
    id: "2026-09-27-city-coins",
    sql: `
CREATE TABLE IF NOT EXISTS city_coins (
  city_id      TEXT PRIMARY KEY,
  city_name    TEXT NOT NULL,
  country      TEXT NOT NULL,
  seat_id      INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  pitch        TEXT,
  pair         TEXT NOT NULL,
  color        TEXT NOT NULL,
  media_id     INTEGER,
  mint         TEXT UNIQUE,
  pending_mint TEXT,
  pending_at   TEXT,
  launched_at  TEXT,
  launched_by  INTEGER,
  updated_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`
  },
  {
    id: "2026-10-01-v5-founder-policy",
    sql: `
ALTER TABLE seats ADD COLUMN probation_until TEXT;
ALTER TABLE windows ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE applications ADD COLUMN squad_id INTEGER;
DROP INDEX IF EXISTS seats_city_live;
CREATE UNIQUE INDEX seats_city_live ON seats (city_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
DROP INDEX IF EXISTS seats_user_live;
CREATE UNIQUE INDEX seats_user_live ON seats (user_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
CREATE TABLE IF NOT EXISTS squads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id      TEXT NOT NULL,
  city_name    TEXT NOT NULL,
  country      TEXT NOT NULL,
  created_by   INTEGER NOT NULL,
  founder_wallet TEXT,
  status       TEXT NOT NULL DEFAULT 'forming',
  created_at   TEXT NOT NULL,
  seated_at    TEXT
);
CREATE TABLE IF NOT EXISTS squad_members (
  squad_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  wallet    TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (squad_id, user_id)
);
CREATE INDEX IF NOT EXISTS squad_members_user ON squad_members (user_id);
`
  },
  {
    // Admin dashboard + test lab (src/admin.js): roles, audit trail, token registry, test-row tracking.
    id: "2026-09-30-admin-dashboard",
    sql: `
CREATE TABLE IF NOT EXISTS admin_roles (
  wallet     TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit (created_at);
CREATE TABLE IF NOT EXISTS admin_tokens (
  mint           TEXT PRIMARY KEY,
  city           TEXT NOT NULL,
  founder_wallet TEXT,
  platform       TEXT NOT NULL DEFAULT 'other',
  registered_by  TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_test (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     INTEGER,
  row_id2    INTEGER
);
`
  },
  {
    id: "2026-10-01-terms-agree",
    sql: `
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_agreed_at TEXT;
`
  },
  {
    id: "2026-10-01-profile",
    sql: `
ALTER TABLE users ADD COLUMN contact_email TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_unique ON users (lower(handle)) WHERE handle IS NOT NULL;
`
  }
];
var split = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean);
var schemaReady = /* @__PURE__ */ new WeakMap();
async function migrate(db) {
  await db.batch(split(SCHEMA).map((s) => db.prepare(s)));
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT id FROM schema_migrations").all()).results.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const s of split(m.sql)) {
      try {
        await db.prepare(s).run();
      } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e;
      }
    }
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, (/* @__PURE__ */ new Date()).toISOString()).run();
  }
}
function ensureSchema(db) {
  if (!schemaReady.has(db)) schemaReady.set(db, migrate(db).catch((e) => {
    schemaReady.delete(db);
    throw e;
  }));
  return schemaReady.get(db);
}
export { ensureSchema };
