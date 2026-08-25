-- ============================================================================
-- Manna Office Meals — Schema v6 additions (Neon / PostgreSQL)
-- Per-user notification preferences (which kinds, which channels), and
-- the "meal became unavailable → admin suggests alternatives → employee
-- swaps or cancels" flow. Idempotent, run after schema_v5_cart.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES — opt-OUT model: if no row exists for a
-- (user, kind) pair, both channels are treated as enabled. A row only
-- needs to exist when someone has turned something off.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_kind TEXT NOT NULL,
    email_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    in_app_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, notification_kind)
);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS — kind now covers specific order-status events so
-- preferences can target them individually ("email me when someone
-- cancels" vs "email me when something is delivered" are different
-- toggles). Widening the existing CHECK constraint rather than adding a
-- new column keeps every existing consumer of `kind` working as-is.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('lead', 'issue', 'order', 'order_cancelled', 'order_delivered', 'order_swap_needed', 'system'));

-- ----------------------------------------------------------------------------
-- ORDERS — the swap flow. When a meal an order references becomes
-- unavailable, admin flags that specific order with a set of
-- alternative meals to offer instead of leaving the employee stuck.
-- Cleared automatically when the employee swaps or cancels.
-- ----------------------------------------------------------------------------
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS needs_swap BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS swap_alternatives JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS swap_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_needs_swap ON orders(user_id) WHERE needs_swap = TRUE;

-- ============================================================================
-- End of schema v6 additions.
-- ============================================================================
