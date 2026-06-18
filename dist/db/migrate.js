/**
 * src/db/migrate.ts
 * Idempotent schema migrations. Run on startup.
 */
import { dbExec, persistDb } from './index.js';
const SCHEMA = `
-- Companies
CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'pilot' CHECK(plan IN ('pilot','starter','growth','enterprise')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','churned')),
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT 'Lagos',
  employees_count INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  avatar       TEXT,
  portal       TEXT NOT NULL CHECK(portal IN ('employee','hr','ops','admin','studio')),
  company_id   TEXT REFERENCES companies(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deactivated')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Magic link tokens
CREATE TABLE IF NOT EXISTS magic_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions (cookie-based)
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portal     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permissions (seed data)
CREATE TABLE IF NOT EXISTS permissions (
  id    TEXT PRIMARY KEY,
  key   TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  grp   TEXT NOT NULL
);

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  scope        TEXT NOT NULL DEFAULT 'company' CHECK(scope IN ('company','system')),
  company_id   TEXT REFERENCES companies(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Role ↔ Permission join
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- User ↔ Role assignments
CREATE TABLE IF NOT EXISTS role_assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Allowance rules per company
CREATE TABLE IF NOT EXISTS allowance_rules (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT UNIQUE NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  daily_amount          INTEGER NOT NULL DEFAULT 2500,
  monthly_cap_enabled   INTEGER NOT NULL DEFAULT 0,
  monthly_cap           INTEGER,
  meal_type             TEXT NOT NULL DEFAULT 'lunch',
  eligible_days         TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]',
  allow_top_ups         INTEGER NOT NULL DEFAULT 1,
  max_top_up            INTEGER DEFAULT 5000,
  max_meals_per_day     INTEGER NOT NULL DEFAULT 1,
  allow_add_ons         INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Employee allowance ledger (daily balance)
CREATE TABLE IF NOT EXISTS allowance_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  reset_at    TEXT NOT NULL,
  UNIQUE(user_id, date)
);

-- Top-up records
CREATE TABLE IF NOT EXISTS top_ups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     TEXT,
  amount       INTEGER NOT NULL,
  reference    TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Meals
CREATE TABLE IF NOT EXISTS meals (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL,
  spice_level  TEXT NOT NULL DEFAULT 'none' CHECK(spice_level IN ('none','mild','medium','hot')),
  allergens    TEXT NOT NULL DEFAULT '[]',
  dietary      TEXT NOT NULL DEFAULT '[]',
  image_url    TEXT,
  available    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly menus
CREATE TABLE IF NOT EXISTS menus (
  id           TEXT PRIMARY KEY,
  week_start   TEXT UNIQUE NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Menu day ↔ meal join
CREATE TABLE IF NOT EXISTS menu_meals (
  id           TEXT PRIMARY KEY,
  menu_id      TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  meal_id      TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  cutoff_time  TEXT NOT NULL,
  UNIQUE(menu_id, date, meal_id)
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id         TEXT NOT NULL REFERENCES companies(id),
  meal_id            TEXT NOT NULL REFERENCES meals(id),
  meal_name          TEXT NOT NULL,
  date               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','confirmed','packed','dispatched','delivered','cancelled','failed')),
  total_amount       INTEGER NOT NULL,
  allowance_covered  INTEGER NOT NULL DEFAULT 0,
  employee_paid      INTEGER NOT NULL DEFAULT 0,
  delivery_address   TEXT,
  notes              TEXT,
  cancellable        INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deliveries
CREATE TABLE IF NOT EXISTS deliveries (
  id               TEXT PRIMARY KEY,
  order_id         TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK(status IN ('scheduled','packed','dispatched','delivered','failed')),
  delivery_address TEXT NOT NULL DEFAULT '',
  scheduled_for    TEXT NOT NULL,
  notes            TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Issues
CREATE TABLE IF NOT EXISTS issues (
  id          TEXT PRIMARY KEY,
  company_id  TEXT REFERENCES companies(id),
  order_id    TEXT REFERENCES orders(id),
  reporter_id TEXT REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Content Studio entries
CREATE TABLE IF NOT EXISTS content_entries (
  key             TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'markdown' CHECK(type IN ('text','richtext','json','markdown')),
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','unpublished_changes')),
  section         TEXT NOT NULL DEFAULT 'general',
  content         TEXT NOT NULL DEFAULT '',
  edited_by       TEXT NOT NULL DEFAULT 'system',
  last_edited_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_published_at TEXT
);

-- Content revisions
CREATE TABLE IF NOT EXISTS content_revisions (
  id           TEXT PRIMARY KEY,
  entry_key    TEXT NOT NULL REFERENCES content_entries(key) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary      TEXT
);

-- Media assets
CREATE TABLE IF NOT EXISTS media_assets (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  url          TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  alt          TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by  TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token_hash ON magic_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_company_id ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);
CREATE INDEX IF NOT EXISTS idx_deliveries_company_id ON deliveries(company_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_allowance_ledger_user_date ON allowance_ledger(user_id, date);
`;
export function runMigrations() {
    dbExec(SCHEMA);
    persistDb();
    console.log('✓ Database migrations complete');
}
