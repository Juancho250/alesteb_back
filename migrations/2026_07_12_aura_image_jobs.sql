-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/004_aura_image_jobs.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_image_jobs.sql. Use migrations/aura/004_aura_image_jobs.sql.';
END;
$$;
COMMIT;

