/**
 * src/db/migrations/002_pilot_and_meal_windows.ts
 *
 * Additive migration for:
 *   - Pilot request leads (public landing-page form → admin approval)
 *   - OTP login codes (alternative to magic links)
 *   - Breakfast/lunch meal windows
 *
 * IMPORTANT: I don't have your existing migrate.ts or the original table
 * DDL, so this is written as a standalone, idempotent function you call
 * from your existing runMigrations() (see WIRING_NOTE.ts in this folder).
 * Everything here uses IF NOT EXISTS / IF EXISTS so it's safe to run
 * against a database that already has some of this, and safe to re-run.
 *
 * One assumption I can't verify without seeing your schema: the unique
 * constraint on allowance_ledger is guessed as
 * `allowance_ledger_user_id_date_key` (Postgres's default auto-generated
 * name for a UNIQUE(user_id, date) constraint). If this migration errors
 * on that DROP CONSTRAINT line, open migrate.ts, find the real
 * constraint/index name, and swap it in.
 */

import { dbExec } from '../index.js';

export async function runPilotAndMealWindowMigration(): Promise<void> {
  // ── Leads (pilot requests from the public landing page) ─────────────
  await dbExec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      team_size TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', -- new | contacted | approved | declined
      notes TEXT,
      approved_company_id TEXT REFERENCES companies(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await dbExec(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);`);

  // ── OTP codes (alternative sign-in method alongside magic links) ────
  await dbExec(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await dbExec(`CREATE INDEX IF NOT EXISTS idx_otp_codes_user ON otp_codes(user_id, expires_at);`);

  // ── Breakfast / lunch meal windows ───────────────────────────────────
  // Each meal now belongs to a specific window rather than being generic.
  await dbExec(`
    ALTER TABLE meals
      ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';
  `);
  await dbExec(`
    DO $$ BEGIN
      ALTER TABLE meals ADD CONSTRAINT meals_meal_window_check
        CHECK (meal_window IN ('breakfast', 'lunch'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // Allowance rules split by window — daily_amount is kept as-is (treated
  // as the lunch amount for backward compatibility with existing rows);
  // daily_amount_breakfast is new and nullable (NULL = breakfast not
  // covered by this company's plan).
  await dbExec(`
    ALTER TABLE allowance_rules
      ADD COLUMN IF NOT EXISTS daily_amount_breakfast INTEGER;
  `);

  // Ledger now tracks usage per (user, date, window) instead of per
  // (user, date) — an employee can have separate breakfast and lunch
  // allowances on the same day.
  await dbExec(`
    ALTER TABLE allowance_ledger
      ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';
  `);
  await dbExec(`
    DO $$ BEGIN
      ALTER TABLE allowance_ledger DROP CONSTRAINT allowance_ledger_user_id_date_key;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;
  `);
  await dbExec(`
    DO $$ BEGIN
      ALTER TABLE allowance_ledger
        ADD CONSTRAINT allowance_ledger_user_date_window_key
        UNIQUE (user_id, date, meal_window);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // menu_meals also gets meal_window so admins can schedule breakfast and
  // lunch cutoffs independently on the same date.
  await dbExec(`
    ALTER TABLE menu_meals
      ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';
  `);

  // Orders need to know which window they were placed for too, so
  // cancellation can credit the right ledger bucket and so an employee
  // can have one breakfast order and one lunch order on the same date.
  await dbExec(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS meal_window TEXT NOT NULL DEFAULT 'lunch';
  `);
  await dbExec(`
    DO $$ BEGIN
      DROP INDEX IF EXISTS orders_user_id_date_key;
      ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_date_key;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);
  await dbExec(`
    DO $$ BEGIN
      ALTER TABLE orders
        ADD CONSTRAINT orders_user_date_window_key
        UNIQUE (user_id, date, meal_window);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // Employees opt in/out of daily notification emails and SMS, plus a
  // phone number to send SMS to.
  await dbExec(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Per-employee allowance override — set during CSV/Excel bulk upload
  // when a company wants different spend limits per person rather than
  // one flat company-wide amount. NULL = use the company's default rule.
  await dbExec(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS allowance_override_lunch INTEGER,
      ADD COLUMN IF NOT EXISTS allowance_override_breakfast INTEGER,
      ADD COLUMN IF NOT EXISTS department TEXT;
  `);
}
