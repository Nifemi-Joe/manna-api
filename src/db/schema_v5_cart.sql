-- ============================================================================
-- Manna Office Meals — Schema v5 additions (Neon / PostgreSQL)
-- Cart-based ordering: multiple different meals per person per day per
-- window, checked out together as one cart. Idempotent, run after
-- schema.sql, schema_v2_pilot.sql, schema_v3_levels.sql, schema_v4_ops.sql.
--
-- WHY: orders previously had UNIQUE (user_id, date, meal_window) — one
-- order per person per day per window, full stop. That's structurally
-- incompatible with a cart of multiple different meals. This replaces
-- it with UNIQUE (user_id, date, meal_window, meal_id) — one order per
-- distinct MEAL per person per day per window, so a cart of Jollof +
-- Coleslaw + Zobo is three linked rows instead of being blocked
-- entirely after the first item.
--
-- Also adds `quantity` (e.g. 2x a snack) and `cart_id` (groups the
-- rows from one checkout together, so "3 items, ordered together" can
-- be displayed and cancelled as a unit).
-- ============================================================================

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS cart_id TEXT;

DO $$ BEGIN
    ALTER TABLE orders DROP CONSTRAINT orders_user_date_window_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE orders
        ADD CONSTRAINT orders_user_date_window_meal_key
        UNIQUE (user_id, date, meal_window, meal_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_cart ON orders(cart_id) WHERE cart_id IS NOT NULL;

-- ============================================================================
-- End of schema v5 additions.
-- ============================================================================
