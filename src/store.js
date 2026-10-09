/**
 * Vicinity database (Cloudflare D1, binding name "DB"). Tables are created and upgraded automatically.
 *
 * What is saved, and nothing more:
 *   users        → one account per wallet and per Google login / verified e-mail: a display name
 *                  and the home community (its id and name, never the location that found it)
 *   sessions     → who is signed in (only a hash of the cookie) and when the wallet was last proven
 *   pairs        → short-lived "sign in with my phone" codes (10 minutes)
 *   email_codes  → short-lived e-mail sign-in codes (only a hash, 10 minutes)
 *   handoffs     → short-lived links to read the location in the phone's normal browser (10 minutes, src/handoff.js)
 *   posts, votes, reports, media, bans → the local and national feeds
 *   mod_actions, appeals → every moderation action, public, and appeals against them
 *   windows, applications, endorsements, seats, objections → choosing city founders (src/seats.js)
 *   elections, election_votes, manager_terms → electing country managers (src/elections.js)
 *   balance_samples, streaks, blobs → balance history for fair eligibility (src/ledger.js)
 *   snapshots    → Founding Supporter lists (src/snapshot.js)
 *   town_requests → "add my town": the nearest community, never coordinates
 *   follows, blocks, profile_reports, users.bio → member profiles (only while PROFILES=on, see PROFILES_MIGRATION below)
 *   claims, added_cities, requests → the first version (no longer written)
 * Locations of visitors are never saved. Wallets that only "verify" or look up a rank are never saved.
 *
 * The database itself enforces: one live founder per city, one live seat per person,
 * one open application window per city, one account per wallet and per Google login / verified e-mail.
 */
export const SCHEMA = `
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
/**
 * Changes to the database after the first version, in order. Each runs once (recorded in
 * schema_migrations). New columns on existing tables are added with ALTER TABLE; a second server
 * adding the same column at the same moment is harmless ("duplicate column" is ignored).
 */
export const MIGRATIONS = [
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
CREATE INDEX IF NOT EXISTS streaks_active ON streaks (level, wallet, above_since) WHERE above_since IS NOT NULL;
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
`,
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
`,
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
`,
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
`,
  },
  {
    id: "2026-10-01-terms-agree",
    sql: `
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_agreed_at TEXT;
`,
  },
  {
    id: "2026-10-01-profile",
    sql: `
ALTER TABLE users ADD COLUMN contact_email TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_unique ON users (lower(handle)) WHERE handle IS NOT NULL;
`,
  },
  {
    // Hand-offs (src/handoff.js): finish a step in the phone's normal browser. Rows live for minutes.
    id: "2026-10-02-handoffs",
    sql: `
CREATE TABLE IF NOT EXISTS handoffs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  user_id    INTEGER,
  wallet     TEXT,
  purpose    TEXT,
  net        TEXT,
  result     TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_user ON handoffs (user_id, kind);
`,
  },
];

const split = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean);
const schemaReady = new WeakMap();

async function migrate(db) {
  await db.batch(split(SCHEMA).map((s) => db.prepare(s)));
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT id FROM schema_migrations").all()).results.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const s of split(m.sql)) {
      try { await db.prepare(s).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e; }
    }
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, new Date().toISOString()).run();
  }
}

/** Create / upgrade the tables the first time they're needed on this server (safe to repeat). */
export function ensureSchema(db) {
  if (!schemaReady.has(db)) schemaReady.set(db, migrate(db).catch((e) => { schemaReady.delete(db); throw e; }));
  return schemaReady.get(db);
}

/**
 * Sign-up v2 (src/signup.js, src/pwlogin.js). Deliberately NOT in MIGRATIONS: those run on every request of
 * every route, so a failure there takes the whole site down. This one runs only when SIGNUP_FLOW=v2 (see
 * ensureSignupSchema), so with the switch off no new statement ever touches the database, and a failure
 * here can only break the new sign-up. Every statement is safe to repeat. Rule: no semicolon inside a
 * comment or a string in this SQL, because split() cuts on every semicolon.
 *   signups     → one unfinished sign-up (community, terms, Google id or e-mail + password hash), at most 3 hours
 *   auth_limits → one counter per anonymous key (keys are HMACs, never an address or a raw IP)
 */
export const SIGNUP_MIGRATION = {
  id: "2026-10-03-signup-v2",
  sql: `
CREATE TABLE IF NOT EXISTS signups (
  id            TEXT PRIMARY KEY,
  terms_version TEXT,
  terms_at      TEXT,
  loc_city      TEXT,
  loc_name      TEXT,
  loc_country   TEXT,
  loc_choices   TEXT,
  loc_net       TEXT,
  loc_at        TEXT,
  provider      TEXT,
  provider_id   TEXT,
  identity_name TEXT,
  identity_at   TEXT,
  pending_email TEXT,
  pending_pw_hash TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signups_expires ON signups (expires_at);
CREATE TABLE IF NOT EXISTS auth_limits (
  key          TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_window ON auth_limits (window_start);
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE handoffs ADD COLUMN signup_id TEXT;
CREATE INDEX IF NOT EXISTS handoffs_signup ON handoffs (signup_id)
`,
};

const signupReady = new WeakMap();

/**
 * Create the sign-up v2 tables and columns the first time a v2 route needs them (safe to repeat, and to run
 * from two servers at once: "duplicate column" is ignored). Rejects on any other failure and forgets that it
 * tried, so the next v2 request retries. Callers answer 503 signup_unavailable and nothing else is affected.
 */
export function ensureSignupSchema(db) {
  if (!signupReady.has(db)) {
    signupReady.set(db, (async () => {
      await ensureSchema(db); // users and handoffs exist (from the normal migrations)
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first();
      if (done) return;
      for (const s of split(SIGNUP_MIGRATION.sql)) {
        try { await db.prepare(s).run(); }
        catch (e) { if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e; }
      }
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(SIGNUP_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { signupReady.delete(db); throw e; }));
  }
  return signupReady.get(db);
}

/**
 * Member profiles (src/profiles.js, src/profile-core.js). Like the sign-up above, deliberately NOT in MIGRATIONS: it
 * runs only when PROFILES=on (see ensureProfilesSchema), so with the switch off no new statement ever touches the
 * database, and a failure here can only break the new profile routes. Every statement is safe to repeat. Same rule: no
 * semicolon inside a comment or a string in this SQL, because split() cuts on every semicolon.
 *   users.bio        → the 100-character bio on the Vicinity pass
 *   follows          → who follows whom (one row per pair, newest first through created_at)
 *   blocks           → who blocked whom (the blocked member can no longer follow)
 *   profile_reports  → one report per reporter per member, about the bio, for the moderators to read
 *   auth_limits      → the same attempt counters the sign-up uses (src/limits.js), created here too so the profile limits
 *                      work with SIGNUP_FLOW off (whichever switch comes first creates it)
 */
export const PROFILES_MIGRATION = {
  id: "2026-10-03-profiles",
  sql: `
ALTER TABLE users ADD COLUMN bio TEXT;
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee_id, created_at, follower_id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked_id);
CREATE TABLE IF NOT EXISTS profile_reports (
  user_id     INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, reporter_id)
);
CREATE TABLE IF NOT EXISTS auth_limits (
  key          TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_window ON auth_limits (window_start)
`,
};

/**
 * Attempt counters for the public routes (src/guards.js) and for votes (src/social.js): the auth_limits table on its
 * own. Deliberately NOT in MIGRATIONS, for the same reason as SIGNUP_MIGRATION: a migration that runs on every request
 * must never be able to take the whole site down, and a counter table is not worth that. It is created the first time
 * something needs to count (ensureLimitsSchema). It is the very same table the sign-up migration creates, statement for
 * statement, so the two can run in either order and both are safe to repeat. Rule: no semicolon inside a comment or a
 * string in this SQL, because split() cuts on every semicolon.
 */
export const LIMITS_MIGRATION = {
  id: "2026-10-03-auth-limits",
  sql: `
CREATE TABLE IF NOT EXISTS auth_limits (
  key          TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_window ON auth_limits (window_start)
`,
};

const profilesReady = new WeakMap();

/**
 * Create the profile tables and the bio column the first time a profile route needs them (safe to repeat, and to run
 * from two servers at once: "duplicate column" is ignored). Rejects on any other failure and forgets that it tried, so
 * the next request retries. Callers answer 503 profiles_unavailable and nothing else is affected.
 */
export function ensureProfilesSchema(db) {
  if (!profilesReady.has(db)) {
    profilesReady.set(db, (async () => {
      await ensureSchema(db); // users exists (from the normal migrations)
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(PROFILES_MIGRATION.id).first();
      if (done) return;
      for (const s of split(PROFILES_MIGRATION.sql)) {
        try { await db.prepare(s).run(); }
        catch (e) { if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e; }
      }
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(PROFILES_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { profilesReady.delete(db); throw e; }));
  }
  return profilesReady.get(db);
}

/**
 * Launchpad v2 (src/launchpad.js). Like the two above, deliberately NOT in MIGRATIONS: it runs only when LAUNCHPAD_V2=on
 * (see ensureLaunchpadSchema), so with the switch off no new statement ever touches the database, and a failure here can
 * only break the Launchpad list and the holder-count step of the job. Safe to repeat. Same rule: no semicolon inside a
 * comment or a string in this SQL, because split() cuts on every semicolon.
 *   coin_stats → how many wallets hold each launched coin (and $VICINITY), counted by the scheduled job; never a wallet
 */
export const LAUNCHPAD_MIGRATION = {
  id: "2026-10-03-launchpad-v2",
  sql: `
CREATE TABLE IF NOT EXISTS coin_stats (
  mint       TEXT PRIMARY KEY,
  holders    INTEGER,
  updated_at TEXT NOT NULL
)
`,
};

const launchpadReady = new WeakMap();

/**
 * Create the coin_stats table the first time the Launchpad list or the job needs it (safe to repeat, and to run from two
 * servers at once). Rejects on failure and forgets that it tried, so the next request retries. Callers carry on without
 * holder counts (the list) or skip the step (the job); nothing else is affected.
 */
export function ensureLaunchpadSchema(db) {
  if (!launchpadReady.has(db)) {
    launchpadReady.set(db, (async () => {
      await ensureSchema(db); // city_coins exists (from the normal migrations)
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(LAUNCHPAD_MIGRATION.id).first();
      if (done) return;
      for (const s of split(LAUNCHPAD_MIGRATION.sql)) await db.prepare(s).run();
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(LAUNCHPAD_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { launchpadReady.delete(db); throw e; }));
  }
  return launchpadReady.get(db);
}

/**
 * The Launchpad's price history (src/pricehistory.js), also only while LAUNCHPAD_V2=on and only from the routes and the job
 * step that use it (GET /api/coin, GET /api/coin/chart, the job's "market" step): the Launchpad list itself never creates
 * these. Safe to repeat. Same rule: no semicolon inside a comment or a string in this SQL.
 *   price_samples  one row per coin per 10-minute run of the job: the curve's spot price in the pair token (price_native),
 *                  the pair's USD price, the USD price the page shows (price_usd, and usd_src: jupiter, curve or dexscreener),
 *                  what the curve holds (raised), its stage and the slot it was read at. at = unix seconds, on the 10-minute grid.
 *   price_candles  OHLC in the pair token from Raydium LaunchLab's kline (src = raydium): tf 15m, rolled into 4h after 30 days.
 *   market_meta    per coin: its LaunchLab pool, when its kline was backfilled and last read, when the job saw it graduate.
 */
export const MARKET_MIGRATION = {
  id: "2026-10-06-launchpad-market",
  sql: `
CREATE TABLE IF NOT EXISTS price_samples (
  mint         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  slot         INTEGER,
  stage        TEXT,
  price_native REAL,
  pair_usd     REAL,
  price_usd    REAL,
  usd_src      TEXT,
  raised       REAL,
  PRIMARY KEY (mint, at)
);
CREATE TABLE IF NOT EXISTS price_candles (
  mint TEXT NOT NULL,
  tf   TEXT NOT NULL,
  t    INTEGER NOT NULL,
  o    REAL NOT NULL,
  h    REAL NOT NULL,
  l    REAL NOT NULL,
  c    REAL NOT NULL,
  src  TEXT NOT NULL,
  PRIMARY KEY (mint, tf, t)
);
CREATE TABLE IF NOT EXISTS market_meta (
  mint          TEXT PRIMARY KEY,
  pool          TEXT,
  backfilled_at TEXT,
  kline_at      TEXT,
  graduated_at  TEXT
)
`,
};

const marketReady = new WeakMap();

/** Create the price-history tables the first time they are needed (after coin_stats). Same failure rule as ensureLaunchpadSchema. */
export function ensureMarketSchema(db) {
  if (!marketReady.has(db)) {
    marketReady.set(db, (async () => {
      await ensureLaunchpadSchema(db);
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(MARKET_MIGRATION.id).first();
      if (done) return;
      for (const s of split(MARKET_MIGRATION.sql)) await db.prepare(s).run();
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(MARKET_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { marketReady.delete(db); throw e; }));
  }
  return marketReady.get(db);
}

const limitsReady = new WeakMap();

/**
 * Create the auth_limits table the first time a counter is used (safe to repeat, and to run from two servers at once).
 * Rejects on failure and forgets that it tried, so the next call retries. Callers decide what a failure means: the
 * public routes let the request through (src/guards.js), votes answer an error (src/social.js).
 */
export function ensureLimitsSchema(db) {
  if (!limitsReady.has(db)) {
    limitsReady.set(db, (async () => {
      await ensureSchema(db); // schema_migrations exists
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(LIMITS_MIGRATION.id).first();
      if (done) return;
      for (const s of split(LIMITS_MIGRATION.sql)) await db.prepare(s).run();
      await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(LIMITS_MIGRATION.id, new Date().toISOString()).run();
    })().catch((e) => { limitsReady.delete(db); throw e; }));
  }
  return limitsReady.get(db);
}

/**
 * Onboarding v3 (src/signup.js, src/walletlink.js): accounts without a wallet. Like the lazy migrations above, deliberately NOT in
 * MIGRATIONS: it runs only on the first sign-up or wallet-link request (SIGNUP_FLOW=v2), so with the switch off no statement here
 * ever touches the database, and a failure here can only break the new sign-up and the wallet link (callers answer 503
 * signup_unavailable). It is in two parts:
 *   A. two nullable columns on pairs (purpose: 'login' | 'link', user_id): plain ALTERs, "duplicate column" ignored. Old rows read as
 *      login pairs.
 *   B. users.wallet becomes nullable. SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt ONCE, in ONE D1 batch
 *      (= one transaction): the same CREATE TABLE text with `wallet TEXT UNIQUE` instead of `wallet TEXT NOT NULL UNIQUE`, every row
 *      and every id copied (and the AUTOINCREMENT counter carried over, so no id a deleted account once had is ever given out again:
 *      old sessions and posts keep pointing at nobody), the old table dropped, the new one renamed, the three indexes made again
 *      (users_home, users_country, users_handle_unique: nothing else references users, no trigger, no view, no foreign key), and the
 *      migration recorded. A failure anywhere leaves the old table exactly as it was and nothing recorded, so the next request tries
 *      again. The live users table is read from sqlite_master and must have exactly the shape this expects (wallet TEXT NOT NULL
 *      UNIQUE), else nothing is touched and the error says so: this never guesses. SCHEMA's CREATE TABLE IF NOT EXISTS users on the
 *      next cold start is a no-op (the table exists), so wallet stays nullable.
 * Switching back to v1 needs no schema change: v1 always writes a wallet.
 */
export const ONBOARD_MIGRATION = {
  id: "2026-10-09-wallet-optional",
  pairs: ["ALTER TABLE pairs ADD COLUMN purpose TEXT", "ALTER TABLE pairs ADD COLUMN user_id INTEGER"],
  /** The exact piece of the live CREATE TABLE users that changes (and must be there). */
  walletRe: /\bwallet\s+TEXT\s+NOT NULL\s+UNIQUE\b/,
  indexes: [
    "CREATE INDEX IF NOT EXISTS users_home ON users (home_city)",
    "CREATE INDEX IF NOT EXISTS users_country ON users (home_country)",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_handle_unique ON users (lower(handle)) WHERE handle IS NOT NULL",
  ],
};

const onboardReady = new WeakMap();
const isDuplicateColumn = (e) => /duplicate column/i.test(String(e && e.message ? e.message : e));

/** The statements of part B for a users table whose CREATE TABLE text is `sql` and whose columns are `cols` (in order). Exported for the test. */
export function walletOptionalStatements(sql, cols, now) {
  const RE = ONBOARD_MIGRATION.walletRe;
  if (!/^CREATE TABLE (IF NOT EXISTS )?["`]?users["`]?\b/.test(sql) || !RE.test(sql)) throw new Error("unexpected users shape");
  const createNew = sql.replace(/^CREATE TABLE (IF NOT EXISTS )?["`]?users["`]?\b/, "CREATE TABLE users_new").replace(RE, "wallet TEXT UNIQUE");
  const list = cols.join(", ");
  return [
    createNew,
    `INSERT INTO users_new (${list}) SELECT ${list} FROM users`,
    // the AUTOINCREMENT counter goes with the rows: an id that was handed out once (and deleted since) is never handed out again
    "INSERT INTO sqlite_sequence (name, seq) SELECT 'users_new', s.seq FROM sqlite_sequence s WHERE s.name = 'users' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users_new')",
    "UPDATE sqlite_sequence SET seq = (SELECT MAX(seq) FROM sqlite_sequence WHERE name IN ('users', 'users_new')) WHERE name = 'users_new'",
    "DROP TABLE users",
    "ALTER TABLE users_new RENAME TO users",
    ...ONBOARD_MIGRATION.indexes,
    { sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)", params: [ONBOARD_MIGRATION.id, now] },
  ];
}

async function onboardMigrate(db) {
  await ensureSignupSchema(db); // users.password_hash and handoffs.signup_id exist, and schema_migrations
  const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(ONBOARD_MIGRATION.id).first();
  if (done) return;
  // A. pairs: purpose and user_id (safe to repeat, and from two servers at once)
  for (const s of ONBOARD_MIGRATION.pairs) {
    try { await db.prepare(s).run(); }
    catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }
  // B. users.wallet nullable
  const now = new Date().toISOString();
  const info = (await db.prepare("PRAGMA table_info(users)").all()).results;
  const walletCol = info.find((c) => c.name === "wallet");
  if (!walletCol) throw new Error("unexpected users shape");
  if (Number(walletCol.notnull) === 0) { // already nullable (a fresh database after a later SCHEMA change, or a re-run): only the record was missing
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(ONBOARD_MIGRATION.id, now).run();
    return;
  }
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").first();
  const before = Number((await db.prepare("SELECT COUNT(*) AS n FROM users").first()).n);
  const statements = walletOptionalStatements(String(row && row.sql ? row.sql : ""), info.map((c) => c.name), now);
  await db.batch(statements.map((s) => (typeof s === "string" ? db.prepare(s) : db.prepare(s.sql).bind(...s.params))));
  // Advisory (the batch has committed and is recorded): a mismatch here means a human must look, so it is loud.
  const after = (await db.prepare("PRAGMA table_info(users)").all()).results.find((c) => c.name === "wallet");
  const count = Number((await db.prepare("SELECT COUNT(*) AS n FROM users").first()).n);
  if (!after || Number(after.notnull) !== 0 || count !== before) {
    const msg = `users rebuilt but the check failed: wallet notnull=${after ? after.notnull : "?"} rows before=${before} after=${count}`;
    console.error("ONBOARD MIGRATION CHECK FAILED", msg);
    throw new Error(msg);
  }
  console.log("users rebuilt: wallet optional", `rows=${count}`);
}

/**
 * Create the onboarding v3 schema (pairs.purpose/user_id, users.wallet nullable) the first time a v2 sign-up or wallet-link route needs
 * it (safe to repeat, and to run from two servers at once: a second rebuild finds the migration recorded or wallet already nullable).
 * Rejects on any other failure and forgets that it tried, so the next request retries. Callers answer 503 signup_unavailable.
 */
export function ensureOnboardSchema(db) {
  if (!onboardReady.has(db)) onboardReady.set(db, onboardMigrate(db).catch((e) => { onboardReady.delete(db); throw e; }));
  return onboardReady.get(db);
}
