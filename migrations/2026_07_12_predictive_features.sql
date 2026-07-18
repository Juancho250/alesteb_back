-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/006_predictive_features.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_predictive_features.sql. Use migrations/aura/006_predictive_features.sql.';
END;
$$;
COMMIT;

