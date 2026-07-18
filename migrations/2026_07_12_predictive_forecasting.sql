-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/007_predictive_forecasting.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_predictive_forecasting.sql. Use migrations/aura/007_predictive_forecasting.sql.';
END;
$$;
COMMIT;

