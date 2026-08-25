-- ============================================================================
-- Manna Office Meals — Schema v2 additions (Neon / PostgreSQL)
-- Additive to schema.sql: pilot lead capture, OTP login, breakfast/lunch
-- meal windows, per-employee allowance overrides, meal image support.
--
-- Same conventions as schema.sql: IF NOT EXISTS everywhere, safe to run
-- on every boot, drops nothing. Run AFTER schema.sql (see migrate.ts).
--
-- FIXED: this file used to try to (re-)ADD CONSTRAINT
-- orders_user_date_window_key — UNIQUE(user_id, date, meal_window) — on
-- every boot. That was correct until schema_v5_cart.sql intentionally
-- DROPPED that exact constraint and replaced it with a meal-aware
-- version (UNIQUE user_id, date, meal_window, meal_id) so a cart could
-- hold multiple different meals in one order. Once real cart orders
-- existed, this file's attempt to recreate the old 3-column constraint
-- started failing with a genuine data violation (23505) — not a
-- harmless "already exists" case the old EXCEPTION WHEN duplicate_object
-- guard could catch, since the constraint didn't exist to begin with;
-- the DATA now legitimately violated it. That ADD CONSTRAINT block is
-- removed below — schema_v5_cart.sql is the sole owner of this
-- constraint going forward. The corresponding DROP of the even-older
-- orders_user_id_date_key constraint is harmless and stays, since
-- dropping a constraint that isn't there is a true no-op.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- LEADS (pilot requests from the public landing page)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
                                     id                  TEXT PRIMARY KEY,
                                     company_name        TEXT NOT NULL,
                                     contact_name        TEXT NOT NULL,
                                     email               TEXT NOT NULL,
                                     team_size           TEXT NOT NULL,
                                     status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','approved','declined')),
    notes               TEXT,
    approved_company_id TEXT REFERENCES companies(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- ----------------------------------------------------------------------------
-- OTP CODES (alternative sign-in method alongside magic links)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_codes (
                                         id         TEXT PRIMARY KEY,
                                         user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
CREATE INDEX IF NOT EXISTS idx_otp_codes_user ON otp_codes(user_id, expires_at);

-- ----------------------------------------------------------------------------
-- USERS — notification prefs, phone, department, per-employee allowance
-- override (set via CSV/Excel bulk upload; NULL = use company default)
-- ----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS department TEXT,
    ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allowance_override_lunch INTEGER,
    ADD COLUMN IF NOT EXISTS allowance_override_breakfast INTEGER;

-- ----------------------------------------------------------------------------
-- MEALS — every column from schema.sql's meals table, added defensively
-- since the live table predates several of these (see earlier fix
-- history). meal_window is the new per-meal, per-order concept,
-- distinct from allowance_rules.meal_type.
-- ----------------------------------------------------------------------------
ALTER TABLE meals
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS spice_level TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS allergens JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS dietary JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS image_url TEXT,
    ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';

-- FIXED: this constraint's name (meals_spice_level_check) is exactly
-- what Postgres auto-generates for an inline CHECK on schema.sql's
-- original `spice_level` column definition. The old DO-block-with-
-- EXCEPTION-WHEN-duplicate_object pattern silently kept whatever
-- definition already existed under that name instead of replacing it
-- — harmless here since the values match, but the same pattern caused
-- a real bug on orders_status_check below, so all four CHECK
-- constraints in this file now use DROP CONSTRAINT IF EXISTS + ADD
-- instead, which always ends up with the intended definition
-- regardless of what existed before.
ALTER TABLE meals DROP CONSTRAINT IF EXISTS meals_spice_level_check;
ALTER TABLE meals ADD CONSTRAINT meals_spice_level_check
    CHECK (spice_level IN ('none', 'mild', 'medium', 'hot'));

ALTER TABLE meals DROP CONSTRAINT IF EXISTS meals_meal_window_check;
ALTER TABLE meals ADD CONSTRAINT meals_meal_window_check
    CHECK (meal_window IN ('breakfast', 'lunch'));

-- ----------------------------------------------------------------------------
-- ALLOWANCE RULES — breakfast amount alongside the existing daily_amount
-- (which continues to mean "lunch" for backward compatibility).
-- ----------------------------------------------------------------------------
ALTER TABLE allowance_rules
    ADD COLUMN IF NOT EXISTS daily_amount_breakfast INTEGER;

-- ----------------------------------------------------------------------------
-- ALLOWANCE LEDGER — tracked per (user, date, window) instead of per
-- (user, date), so breakfast and lunch have independent daily balances.
-- ----------------------------------------------------------------------------
ALTER TABLE allowance_ledger
    ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';

DO $$ BEGIN
ALTER TABLE allowance_ledger DROP CONSTRAINT allowance_ledger_user_id_date_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
ALTER TABLE allowance_ledger
    ADD CONSTRAINT allowance_ledger_user_date_window_key
        UNIQUE (user_id, date, meal_window);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- MENU_MEALS / ORDERS / DELIVERIES / COMPANIES — defensive column
-- additions, same drift-repair pattern as meals above.
-- ----------------------------------------------------------------------------
ALTER TABLE menu_meals
    ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch',
    ADD COLUMN IF NOT EXISTS cutoff_time TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS total_amount INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS allowance_covered INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS employee_paid INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS delivery_address TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS cancellable BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';

-- FIXED (the actual bug from the error you hit): orders_status_check is
-- ALSO Postgres's auto-generated name for the original inline CHECK in
-- schema.sql — which almost certainly didn't include 'packed',
-- 'dispatched', or 'failed'. The old DO-block pattern hit "already
-- exists" and kept THAT narrower constraint forever, which is exactly
-- why setting status to 'packed' failed. Drop-then-add guarantees the
-- intended wider definition wins, regardless of history.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN ('pending','confirmed','packed','dispatched','delivered','cancelled','failed'));

-- Drop the oldest (user_id, date) constraint if it's still somehow
-- present — harmless no-op if not. Nothing in this file adds any
-- UNIQUE constraint back onto orders; that's entirely
-- schema_v5_cart.sql's responsibility now (see file header above).
DO $$ BEGIN
ALTER TABLE orders DROP CONSTRAINT orders_user_id_date_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE deliveries
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled',
    ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Same drop-then-add fix, in case schema.sql's original deliveries
-- table had a narrower inline CHECK under this same auto-generated name.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('scheduled','packed','dispatched','delivered','failed'));

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'pilot',
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT 'Lagos',
    ADD COLUMN IF NOT EXISTS employees_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ============================================================================
-- End of schema v2 additions.
-- ============================================================================