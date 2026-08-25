-- ============================================================================
-- Manna Office Meals — Schema v3 additions (Neon / PostgreSQL)
-- Staff levels (per-company tiers with their own default allowance),
-- delegated ordering ("order for a colleague, on my tab"), and
-- authorized overspend (a level can be permitted to exceed the base
-- allowance by a set amount, still company-covered, not employee-paid).
--
-- Same conventions as schema.sql / schema_v2_pilot.sql: IF NOT EXISTS
-- everywhere, safe to run on every boot. Run AFTER both of those (see
-- migrate.ts).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STAFF LEVELS — company-defined tiers (e.g. "Executive", "Senior
-- Staff", "Junior Staff"). Each carries its own default allowance per
-- window, whether people at this level can order on behalf of a
-- colleague, and how far (if at all) they're authorized to exceed their
-- allowance while still having it covered by the company rather than
-- paid out of pocket.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_levels (
    id                        TEXT PRIMARY KEY,
    company_id                TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                      TEXT NOT NULL,
    daily_amount_lunch        INTEGER NOT NULL,
    daily_amount_breakfast    INTEGER,
    can_order_for_others      BOOLEAN NOT NULL DEFAULT FALSE,
    overspend_limit_lunch     INTEGER,
    overspend_limit_breakfast INTEGER,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_staff_levels_company ON staff_levels(company_id);

-- ----------------------------------------------------------------------------
-- USERS — each employee can belong to one level. Resolution order for
-- an employee's allowance (see resolveAllowanceAmount in employee.ts):
--   1. users.allowance_override_lunch/breakfast (per-employee override — highest priority)
--   2. staff_levels.daily_amount_lunch/breakfast (their level's default)
--   3. allowance_rules.daily_amount / daily_amount_breakfast (company default — lowest priority)
-- ----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS level_id TEXT REFERENCES staff_levels(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_level ON users(level_id);

-- ----------------------------------------------------------------------------
-- ORDERS — ordered_by_user_id is the person who actually placed and is
-- paying for the order (their allowance/ledger is what's charged).
-- user_id remains who the meal is FOR. For a normal self-order these
-- are the same person; for a delegated order (an authorized colleague
-- ordering on someone else's behalf, or covering a guest), they differ.
-- Backfilled to user_id for every existing row so nothing already
-- placed becomes ambiguous.
-- ----------------------------------------------------------------------------
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS ordered_by_user_id TEXT REFERENCES users(id);
UPDATE orders SET ordered_by_user_id = user_id WHERE ordered_by_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_ordered_by ON orders(ordered_by_user_id);

-- ============================================================================
-- End of schema v3 additions.
-- ============================================================================
