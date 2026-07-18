-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/003_aura_campaigns_v2.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_campaigns.sql. Use migrations/aura/003_aura_campaigns_v2.sql.';
END;
$$;
COMMIT;

