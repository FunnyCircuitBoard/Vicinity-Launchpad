-- Production D1 schema (sqlite_master, schema only, no rows), read 2026-10-24 ~11:55 UTC
CREATE TABLE added_cities (
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
CREATE TABLE admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE admin_roles (
  wallet     TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL
);
CREATE TABLE admin_test (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     INTEGER,
  row_id2    INTEGER
);
CREATE TABLE admin_tokens (
  mint           TEXT PRIMARY KEY,
  city           TEXT NOT NULL,
  founder_wallet TEXT,
  platform       TEXT NOT NULL DEFAULT 'other',
  registered_by  TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE appeals (
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
CREATE TABLE applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  window_id  INTEGER NOT NULL,
  city_id    TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  wallet     TEXT NOT NULL,
  pitch      TEXT,
  created_at TEXT NOT NULL,
  withdrawn  INTEGER NOT NULL DEFAULT 0,
  valid      INTEGER,
  endorse_score  REAL,
  contrib_score  REAL,
  stake_score    REAL,
  total      REAL,
  tiebreak   TEXT,
  rank       INTEGER, squad_id INTEGER,
  UNIQUE (window_id, user_id)
);
CREATE TABLE auth_limits (
  key          TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE TABLE balance_samples (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  day      TEXT NOT NULL,
  slot     INTEGER,
  holders  INTEGER NOT NULL,
  hash     TEXT NOT NULL
);
CREATE TABLE bans (
  user_id    INTEGER NOT NULL,
  country    TEXT NOT NULL,
  by_user    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL, expires_at TEXT, action_id INTEGER,
  PRIMARY KEY (user_id, country)
);
CREATE TABLE blobs (
  key  TEXT NOT NULL,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, part)
);
CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE city_coins (
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
, logo_status TEXT, logo_reason TEXT, logo_note TEXT, logo_reviewed_at TEXT, logo_reviewed_by INTEGER, logo_hash TEXT, approved_media_id INTEGER);
CREATE TABLE claims (
  city_id    TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL UNIQUE,
  city_name  TEXT NOT NULL,
  country    TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE TABLE coin_stats (
  mint       TEXT PRIMARY KEY,
  holders    INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE election_votes (
  election_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  seat_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (election_id, user_id)
);
CREATE TABLE elections (
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
CREATE TABLE email_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  send_count   INTEGER NOT NULL DEFAULT 0,
  window_start TEXT,
  last_sent_at TEXT
);
CREATE TABLE endorsements (
  window_id      INTEGER NOT NULL,
  user_id        INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (window_id, user_id)
);
CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  email      TEXT,
  city       TEXT,
  country    TEXT,
  user_id    INTEGER,
  page       TEXT,
  ua         TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE handoffs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  user_id    INTEGER,
  wallet     TEXT,
  purpose    TEXT,
  net        TEXT,
  result     TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
, signup_id TEXT, opener TEXT, country TEXT, refused_at TEXT);
CREATE TABLE lp_approvals_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster    TEXT NOT NULL,
    program_id TEXT NOT NULL,
    city_id    TEXT NOT NULL,
    action     TEXT NOT NULL,
    founder    TEXT,
    name       TEXT,
    symbol     TEXT,
    expires_at TEXT,
    signature  TEXT NOT NULL UNIQUE,
    by_wallet  TEXT NOT NULL,
    at         TEXT NOT NULL
  );
CREATE TABLE lp_coins (
  cluster     TEXT NOT NULL,
  program_id  TEXT NOT NULL,
  city_id     TEXT NOT NULL,
  mint        TEXT NOT NULL UNIQUE,
  coin        TEXT NOT NULL,
  founder     TEXT NOT NULL,
  name        TEXT,
  symbol      TEXT,
  quote_mint  TEXT NOT NULL,
  dbc_config  TEXT NOT NULL,
  dbc_pool    TEXT NOT NULL,
  launch_sig  TEXT,
  launched_at TEXT,
  recorded_at TEXT NOT NULL,
  meta_json   TEXT,
  meta_at     TEXT,
  PRIMARY KEY (cluster, program_id, city_id)
);
CREATE TABLE lp_setup (
    cluster    TEXT NOT NULL,
    program_id TEXT NOT NULL,
    step       TEXT NOT NULL,
    address    TEXT,
    signature  TEXT,
    by_wallet  TEXT NOT NULL,
    at         TEXT NOT NULL,
    PRIMARY KEY (cluster, program_id, step)
  );
CREATE TABLE manager_terms (
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
CREATE TABLE market_meta (
  mint          TEXT PRIMARY KEY,
  pool          TEXT,
  backfilled_at TEXT,
  kline_at      TEXT,
  graduated_at  TEXT
);
CREATE TABLE media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE mod_actions (
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
CREATE TABLE mutes (
  muter_id   INTEGER NOT NULL,
  muted_id   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);
CREATE TABLE notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT,
  text       TEXT NOT NULL,
  href       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE TABLE objections (
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
CREATE TABLE pairs (
  id         TEXT PRIMARY KEY,
  pin        TEXT NOT NULL,
  wallet     TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
, purpose TEXT, user_id INTEGER);
CREATE TABLE posts (
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
, hidden_until TEXT, hide_confirmed INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
CREATE TABLE price_candles (
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
CREATE TABLE price_samples (
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
CREATE TABLE profile_reports (
  user_id     INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, reporter_id)
);
CREATE TABLE rate_events (
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE TABLE reports (
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE requests (
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
CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE seats (
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
  grace_until    TEXT,
  graces         TEXT NOT NULL DEFAULT '[]',
  ended_at       TEXT,
  end_reason     TEXT
, probation_until TEXT);
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  wallet     TEXT,
  user_id    INTEGER,
  proof      TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
, proven_at TEXT, made_by TEXT);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE signups (
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
CREATE TABLE snapshots (
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
CREATE TABLE squad_members (
  squad_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  wallet    TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (squad_id, user_id)
);
CREATE TABLE squads (
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
CREATE TABLE streaks (
  wallet      TEXT NOT NULL,
  level       REAL NOT NULL,
  above_since TEXT,
  PRIMARY KEY (wallet, level)
);
CREATE TABLE town_requests (
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
CREATE TABLE used_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE user_logins (
  user_id     INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (provider, provider_id),
  UNIQUE (user_id, provider)
);
CREATE TABLE "users" (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT UNIQUE,
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
  created_at   TEXT NOT NULL, terms_version TEXT, terms_agreed_at TEXT, contact_email TEXT, phone TEXT, password_hash TEXT, bio TEXT, wallet_at TEXT, wallet_via TEXT, wallet_app TEXT, password_at TEXT, national_ack_at TEXT, notice_prefs TEXT,
  UNIQUE (provider, provider_id)
);
CREATE TABLE votes (
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  weight     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id    TEXT NOT NULL,
  city_name  TEXT NOT NULL,
  country    TEXT NOT NULL,
  policy     INTEGER NOT NULL,
  threshold  REAL NOT NULL,
  opened_at  TEXT NOT NULL,
  closes_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_at TEXT,
  result     TEXT,
  result_hash TEXT
, kind TEXT NOT NULL DEFAULT 'standard');
CREATE INDEX added_by_country ON added_cities (country, norm);
CREATE INDEX admin_audit_created ON admin_audit (created_at);
CREATE INDEX applications_user ON applications (user_id);
CREATE INDEX auth_limits_window ON auth_limits (window_start);
CREATE INDEX balance_samples_day ON balance_samples (day);
CREATE INDEX blocks_blocked ON blocks (blocked_id);
CREATE UNIQUE INDEX elections_open_country ON elections (country) WHERE status = 'open';
CREATE INDEX feedback_status ON feedback (status, id);
CREATE INDEX follows_followee ON follows (followee_id, created_at, follower_id);
CREATE INDEX handoffs_expires ON handoffs (expires_at);
CREATE INDEX handoffs_signup ON handoffs (signup_id);
CREATE INDEX handoffs_user ON handoffs (user_id, kind);
CREATE INDEX manager_terms_country ON manager_terms (country, status);
CREATE INDEX mod_actions_country ON mod_actions (country, created_at);
CREATE INDEX mod_actions_target ON mod_actions (target_type, target_id);
CREATE INDEX notices_user ON notices (user_id, id);
CREATE INDEX pairs_expires ON pairs (expires_at);
CREATE INDEX posts_feed ON posts (scope, place, kind, created_at);
CREATE INDEX posts_parent ON posts (parent_id);
CREATE INDEX posts_user ON posts (user_id, created_at);
CREATE INDEX rate_events_user ON rate_events (user_id, kind, at);
CREATE INDEX requests_country ON requests (country, status);
CREATE UNIQUE INDEX seats_city_live ON seats (city_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
CREATE INDEX seats_country ON seats (country, status);
CREATE UNIQUE INDEX seats_user_live ON seats (user_id) WHERE status IN ('provisional', 'active', 'grace', 'steward');
CREATE INDEX sessions_expires ON sessions (expires_at);
CREATE INDEX signups_expires ON signups (expires_at);
CREATE INDEX squad_members_user ON squad_members (user_id);
CREATE INDEX town_requests_country ON town_requests (country, status);
CREATE INDEX users_country ON users (home_country);
CREATE UNIQUE INDEX users_handle_unique ON users (lower(handle)) WHERE handle IS NOT NULL;
CREATE INDEX users_home ON users (home_city);
CREATE UNIQUE INDEX windows_open_city ON windows (city_id) WHERE status = 'open';
