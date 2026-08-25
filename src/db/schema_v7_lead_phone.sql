-- ============================================================================
-- Manna Office Meals — Schema v7 additions (Neon / PostgreSQL)
-- Phone number on leads, so sales can actually call a pilot request
-- instead of only having an email address on file.
-- ============================================================================

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS phone TEXT;

-- ============================================================================
-- End of schema v7 additions.
-- ============================================================================
