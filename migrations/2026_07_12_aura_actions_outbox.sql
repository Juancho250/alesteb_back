-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/005_aura_actions_outbox_v2.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_aura_actions_outbox.sql. Use migrations/aura/005_aura_actions_outbox_v2.sql.';
END;
$$;
COMMIT;

