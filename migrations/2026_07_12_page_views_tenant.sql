-- SUPERSEDED: do not apply.
-- Replaced by migrations/aura/002_page_views_tenant_v2.sql.

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'Skipping superseded migration 2026_07_12_page_views_tenant.sql. Use migrations/aura/002_page_views_tenant_v2.sql.';
END;
$$;
COMMIT;

