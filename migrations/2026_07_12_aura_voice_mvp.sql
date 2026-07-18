-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/010_aura_voice_mvp.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_voice_mvp.sql. Use migrations/aura/010_aura_voice_mvp.sql.';
END;
$$;
COMMIT;

