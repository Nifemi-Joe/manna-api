-- ============================================================================
-- Manna Office Meals — Full Schema (Neon / PostgreSQL)
-- Generated to exactly match src/routes/*.ts and src/services/auth.ts.
-- Safe to run on a fresh Neon database, top to bottom. Drops nothing.
--
-- IMPORTANT: if you already ran a prior schema script on this database,
-- drop those tables first (see DROP block at the bottom, commented out)
-- or run this on a fresh Neon project/branch to avoid column conflicts.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- not required (we use nanoid TEXT ids) but harmless

-- ----------------------------------------------------------------------------
-- COMPANIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    slug             TEXT NOT NULL UNIQUE,
    plan             TEXT NOT NULL DEFAULT 'pilot'
                     CHECK (plan IN ('pilot','starter','growth','enterprise')),
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','churned')),
    address          TEXT NOT NULL DEFAULT '',
    city             TEXT NOT NULL DEFAULT 'Lagos',
    employees_count  INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- USERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    avatar      TEXT,
    portal      TEXT NOT NULL CHECK (portal IN ('employee','hr','ops','admin','studio')),
    company_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','deactivated')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);

-- ----------------------------------------------------------------------------
-- MAGIC LINK TOKENS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS magic_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token_hash ON magic_tokens(token_hash);

-- ----------------------------------------------------------------------------
-- SESSIONS (cookie-based)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portal     TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- ----------------------------------------------------------------------------
-- PERMISSIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
    id    TEXT PRIMARY KEY,
    key   TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    grp   TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- ROLES / RBAC
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    scope       TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company','system')),
    company_id  TEXT REFERENCES companies(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS role_assignments (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    -- NOTE: deliberately NOT unique on (user_id, role_id) — a user can be
    -- re-assigned the same role after a prior assignment was deactivated,
    -- and the app does not de-duplicate this itself.
);
CREATE INDEX IF NOT EXISTS idx_role_assignments_user_id ON role_assignments(user_id);

-- ----------------------------------------------------------------------------
-- ALLOWANCE RULES (per company)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowance_rules (
    id                   TEXT PRIMARY KEY,
    company_id           TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    daily_amount         INTEGER NOT NULL DEFAULT 2500,
    monthly_cap_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
    monthly_cap          INTEGER,
    meal_type            TEXT NOT NULL DEFAULT 'lunch',
    eligible_days        JSONB NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]',
    allow_top_ups        BOOLEAN NOT NULL DEFAULT TRUE,
    max_top_up           INTEGER DEFAULT 5000,
    max_meals_per_day    INTEGER NOT NULL DEFAULT 1,
    allow_add_ons        BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- ALLOWANCE LEDGER (daily balance per employee)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowance_ledger (
    id       TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date     DATE NOT NULL,
    amount   INTEGER NOT NULL,
    used     INTEGER NOT NULL DEFAULT 0,
    reset_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_allowance_ledger_user_date ON allowance_ledger(user_id, date);

-- ----------------------------------------------------------------------------
-- TOP-UP RECORDS (Paystack)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS top_ups (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id   TEXT,
    amount     INTEGER NOT NULL,
    reference  TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- MEALS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meals (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       INTEGER NOT NULL,
    spice_level TEXT NOT NULL DEFAULT 'none' CHECK (spice_level IN ('none','mild','medium','hot')),
    allergens   JSONB NOT NULL DEFAULT '[]',
    dietary     JSONB NOT NULL DEFAULT '[]',
    image_url   TEXT,
    available   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- MENUS (weekly schedule)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menus (
    id           TEXT PRIMARY KEY,
    week_start   DATE NOT NULL UNIQUE,
    published    BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_meals (
    id          TEXT PRIMARY KEY,
    menu_id     TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    date        DATE NOT NULL,
    meal_id     TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    cutoff_time TIMESTAMPTZ NOT NULL,
    UNIQUE (menu_id, date, meal_id)
);
CREATE INDEX IF NOT EXISTS idx_menu_meals_menu_id ON menu_meals(menu_id);
CREATE INDEX IF NOT EXISTS idx_menu_meals_date ON menu_meals(date);

-- ----------------------------------------------------------------------------
-- ORDERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id        TEXT NOT NULL REFERENCES companies(id),
    meal_id           TEXT NOT NULL REFERENCES meals(id),
    meal_name         TEXT NOT NULL,
    date              DATE NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','packed','dispatched','delivered','cancelled','failed')),
    total_amount      INTEGER NOT NULL,
    allowance_covered INTEGER NOT NULL DEFAULT 0,
    employee_paid     INTEGER NOT NULL DEFAULT 0,
    delivery_address  TEXT,
    notes             TEXT,
    cancellable       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- one non-cancelled order per employee per day
    UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_company_id ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);

-- ----------------------------------------------------------------------------
-- DELIVERIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
    id               TEXT PRIMARY KEY,
    order_id         TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    company_id       TEXT NOT NULL REFERENCES companies(id),
    status           TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','packed','dispatched','delivered','failed')),
    delivery_address TEXT NOT NULL DEFAULT '',
    scheduled_for    TIMESTAMPTZ NOT NULL,
    notes            TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_company_id ON deliveries(company_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

-- ----------------------------------------------------------------------------
-- ISSUES (ops incident tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issues (
    id          TEXT PRIMARY KEY,
    company_id  TEXT REFERENCES companies(id),
    order_id    TEXT REFERENCES orders(id),
    reporter_id TEXT REFERENCES users(id),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_issues_company_id ON issues(company_id);

-- ----------------------------------------------------------------------------
-- CONTENT STUDIO ENTRIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_entries (
    key                TEXT PRIMARY KEY,
    type               TEXT NOT NULL DEFAULT 'markdown' CHECK (type IN ('text','richtext','json','markdown')),
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished_changes')),
    section            TEXT NOT NULL DEFAULT 'general',
    content            TEXT NOT NULL DEFAULT '',
    edited_by          TEXT NOT NULL DEFAULT 'system',
    last_edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_published_at  TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- CONTENT REVISIONS (publish history / rollback)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_revisions (
    id           TEXT PRIMARY KEY,
    entry_key    TEXT NOT NULL REFERENCES content_entries(key) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    published_by TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    summary      TEXT
);

-- ----------------------------------------------------------------------------
-- MEDIA ASSETS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    url         TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    alt         TEXT,
    tags        JSONB NOT NULL DEFAULT '[]',
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by TEXT NOT NULL
);

-- ============================================================================
-- End of schema.
-- ============================================================================