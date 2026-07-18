-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/001_aura_core_consolidated.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_mvp.sql. Use migrations/aura/001_aura_core_consolidated.sql.';
END;
$$;
COMMIT;

