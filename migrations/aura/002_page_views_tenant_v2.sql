-- =============================================================================
-- AURA analytics tenant hardening v2
--
-- Fixes the earlier migration behavior that could null authenticated_user_id on
-- valid trusted rows during reruns.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'page_views v2 preflight failed: public.users is required';
  END IF;

  IF to_regclass('public.page_views') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'page_views' AND column_name = 'id'
    ) THEN
      RAISE EXCEPTION 'page_views v2 preflight failed: page_views.id is required';
    END IF;
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.page_views (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(120),
  page VARCHAR(500),
  page_label VARCHAR(255),
  referrer VARCHAR(500),
  referrer_label VARCHAR(255),
  time_on_prev INTEGER,
  user_id INTEGER,
  device VARCHAR(20),
  screen_w INTEGER,
  screen_h INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE public.page_views
  ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS analytics_key_id INTEGER,
  ADD COLUMN IF NOT EXISTS visitor_id VARCHAR(120),
  ADD COLUMN IF NOT EXISTS authenticated_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(40) NOT NULL DEFAULT 'page_view',
  ADD COLUMN IF NOT EXISTS path VARCHAR(500),
  ADD COLUMN IF NOT EXISTS product_id INTEGER,
  ADD COLUMN IF NOT EXISTS utm_source VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(120),
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tenant_resolution_status VARCHAR(30) NOT NULL DEFAULT 'ambiguous_legacy';

ALTER TABLE public.page_views
  ALTER COLUMN session_id TYPE VARCHAR(120),
  ALTER COLUMN visitor_id TYPE VARCHAR(120),
  ALTER COLUMN path TYPE VARCHAR(500),
  ALTER COLUMN page TYPE VARCHAR(500),
  ALTER COLUMN referrer TYPE VARCHAR(500),
  ALTER COLUMN utm_source TYPE VARCHAR(120),
  ALTER COLUMN utm_medium TYPE VARCHAR(120),
  ALTER COLUMN utm_campaign TYPE VARCHAR(120);

-- Backfill only structural fields. Trusted rows keep authenticated_user_id.
UPDATE public.page_views
SET
  session_id = COALESCE(NULLIF(session_id, ''), 'legacy-' || id::text),
  page = COALESCE(NULLIF(page, ''), NULLIF(path, ''), '/'),
  path = COALESCE(NULLIF(path, ''), NULLIF(page, ''), '/'),
  occurred_at = COALESCE(occurred_at, created_at::timestamptz, NOW()),
  event_type = COALESCE(NULLIF(event_type, ''), 'page_view'),
  tenant_resolution_status = CASE
    WHEN tenant_resolution_status = 'trusted' AND owner_admin_id IS NOT NULL THEN 'trusted'
    WHEN owner_admin_id IS NULL THEN 'ambiguous_legacy'
    ELSE COALESCE(NULLIF(tenant_resolution_status, ''), 'ambiguous_legacy')
  END,
  authenticated_user_id = CASE
    WHEN tenant_resolution_status = 'trusted' AND owner_admin_id IS NOT NULL THEN authenticated_user_id
    ELSE NULL
  END
WHERE session_id IS NULL OR session_id = ''
   OR page IS NULL OR page = ''
   OR path IS NULL OR path = ''
   OR occurred_at IS NULL
   OR event_type IS NULL OR event_type = ''
   OR tenant_resolution_status IS NULL OR tenant_resolution_status = ''
   OR (tenant_resolution_status <> 'trusted' AND authenticated_user_id IS NOT NULL);

ALTER TABLE public.page_views
  ALTER COLUMN session_id SET NOT NULL,
  ALTER COLUMN page SET NOT NULL,
  ALTER COLUMN path SET NOT NULL,
  ALTER COLUMN event_type SET NOT NULL,
  ALTER COLUMN tenant_resolution_status SET NOT NULL,
  ALTER COLUMN occurred_at SET DEFAULT NOW(),
  ALTER COLUMN occurred_at SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'chk_page_views_tenant_resolution_status'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT chk_page_views_tenant_resolution_status
      CHECK (tenant_resolution_status IN ('trusted', 'ambiguous_legacy', 'unresolved'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'chk_page_views_event_type'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT chk_page_views_event_type
      CHECK (event_type IN (
        'page_view',
        'product_view',
        'search',
        'add_to_cart',
        'checkout',
        'order_success',
        'custom'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'fk_page_views_owner_admin'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT fk_page_views_owner_admin
      FOREIGN KEY (owner_admin_id)
      REFERENCES public.users(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'fk_page_views_authenticated_user'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT fk_page_views_authenticated_user
      FOREIGN KEY (authenticated_user_id)
      REFERENCES public.users(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;

  IF to_regclass('public.api_keys') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'fk_page_views_analytics_key'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT fk_page_views_analytics_key
      FOREIGN KEY (analytics_key_id)
      REFERENCES public.api_keys(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;

  IF to_regclass('public.products') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.page_views'::regclass
      AND conname = 'fk_page_views_product'
  ) THEN
    ALTER TABLE public.page_views
      ADD CONSTRAINT fk_page_views_product
      FOREIGN KEY (product_id)
      REFERENCES public.products(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$constraints$;

DO $validate_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.page_views pv
    LEFT JOIN public.users u ON u.id = pv.owner_admin_id
    WHERE pv.owner_admin_id IS NOT NULL AND u.id IS NULL
  ) THEN
    ALTER TABLE public.page_views VALIDATE CONSTRAINT fk_page_views_owner_admin;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.page_views pv
    LEFT JOIN public.users u ON u.id = pv.authenticated_user_id
    WHERE pv.authenticated_user_id IS NOT NULL AND u.id IS NULL
  ) THEN
    ALTER TABLE public.page_views VALIDATE CONSTRAINT fk_page_views_authenticated_user;
  END IF;

  IF to_regclass('public.api_keys') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_views_analytics_key')
     AND NOT EXISTS (
       SELECT 1
       FROM public.page_views pv
       LEFT JOIN public.api_keys ak ON ak.id = pv.analytics_key_id
       WHERE pv.analytics_key_id IS NOT NULL AND ak.id IS NULL
     ) THEN
    ALTER TABLE public.page_views VALIDATE CONSTRAINT fk_page_views_analytics_key;
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_page_views_product')
     AND NOT EXISTS (
       SELECT 1
       FROM public.page_views pv
       LEFT JOIN public.products p ON p.id = pv.product_id
       WHERE pv.product_id IS NOT NULL AND p.id IS NULL
     ) THEN
    ALTER TABLE public.page_views VALIDATE CONSTRAINT fk_page_views_product;
  END IF;
END
$validate_fks$;

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_occurred
  ON public.page_views (owner_admin_id, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_session
  ON public.page_views (owner_admin_id, session_id, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_visitor
  ON public.page_views (owner_admin_id, visitor_id, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND visitor_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_path
  ON public.page_views (owner_admin_id, path, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_event
  ON public.page_views (owner_admin_id, event_type, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_tenant_product
  ON public.page_views (owner_admin_id, product_id, occurred_at DESC)
  WHERE owner_admin_id IS NOT NULL AND product_id IS NOT NULL AND tenant_resolution_status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_page_views_resolution_status
  ON public.page_views (tenant_resolution_status, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.anonymize_old_page_views(retention_days INTEGER DEFAULT 180)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.page_views
  SET
    authenticated_user_id = NULL,
    visitor_id = NULL,
    session_id = 'expired-' || id::text,
    referrer = NULL,
    referrer_label = NULL,
    utm_source = NULL,
    utm_medium = NULL,
    utm_campaign = NULL,
    screen_w = NULL,
    screen_h = NULL
  WHERE occurred_at < NOW() - make_interval(days => GREATEST(retention_days, 1))
    AND (
      authenticated_user_id IS NOT NULL
      OR visitor_id IS NOT NULL
      OR session_id NOT LIKE 'expired-%'
      OR referrer IS NOT NULL
      OR referrer_label IS NOT NULL
      OR utm_source IS NOT NULL
      OR utm_medium IS NOT NULL
      OR utm_campaign IS NOT NULL
      OR screen_w IS NOT NULL
      OR screen_h IS NOT NULL
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

COMMENT ON TABLE public.page_views IS
  'Storefront analytics events. Trusted rows require owner_admin_id resolved from JWT or analytics:write API key.';
COMMENT ON COLUMN public.page_views.owner_admin_id IS
  'Trusted tenant id. Legacy rows with NULL owner_admin_id remain ambiguous and must stay out of campaigns, churn and predictions.';
COMMENT ON COLUMN public.page_views.tenant_resolution_status IS
  'trusted for tenant-resolved rows; ambiguous_legacy for historical rows not safely assigned.';
COMMENT ON COLUMN public.page_views.user_id IS
  'Legacy untrusted body field. Do not use for reporting, campaigns or predictions.';
COMMENT ON COLUMN public.page_views.authenticated_user_id IS
  'Validated user id from JWT and tenant membership only. Reruns preserve trusted values.';
COMMENT ON FUNCTION public.anonymize_old_page_views(INTEGER) IS
  'Basic retention helper. Recommended monthly with 180 days: SELECT public.anonymize_old_page_views(180);';

COMMIT;

