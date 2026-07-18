-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/009_aura_send_time_optimization.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_send_time_optimization.sql. Use migrations/aura/009_aura_send_time_optimization.sql.';
END;
$$;
COMMIT;

