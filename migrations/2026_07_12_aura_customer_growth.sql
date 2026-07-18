-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/008_aura_customer_growth.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_customer_growth.sql. Use migrations/aura/008_aura_customer_growth.sql.';
END;
$$;
COMMIT;

