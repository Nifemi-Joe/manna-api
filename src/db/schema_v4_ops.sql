-- ============================================================================
-- Manna Office Meals — Schema v4 additions (Neon / PostgreSQL)
-- Working days / holidays, a real notifications table, and persisting
-- the overspend-covered amount on orders (previously only computed
-- in-memory during order placement, never written to the row).
-- Idempotent, same conventions as the other schema files. Run after
-- schema.sql, schema_v2_pilot.sql, and schema_v3_levels.sql.
-- ============================================================================

ALTER TABLE allowance_rules
    ADD COLUMN IF NOT EXISTS eligible_days JSONB NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]';

CREATE TABLE IF NOT EXISTS company_holidays (
    id         TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    date       DATE NOT NULL,
    label      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, date)
);
CREATE INDEX IF NOT EXISTS idx_company_holidays_company ON company_holidays(company_id, date);

CREATE TABLE IF NOT EXISTS notifications (
    id                TEXT PRIMARY KEY,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL CHECK (kind IN ('lead', 'issue', 'order', 'system')),
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    link              TEXT,
    read_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(recipient_user_id) WHERE read_at IS NULL;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS overspend_covered INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- End of schema v4 additions.
-- ============================================================================
