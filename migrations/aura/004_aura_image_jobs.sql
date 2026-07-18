-- =============================================================================
-- AURA Growth image jobs
--
-- Must run after 003_aura_campaigns_v2.sql.
-- Jobs are asynchronous and processed by worker.ai.js.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.marketing_campaigns') IS NULL THEN
    RAISE EXCEPTION 'image jobs preflight failed: public.marketing_campaigns is required';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'image jobs preflight failed: public.products is required';
  END IF;
  IF to_regclass('public.product_variants') IS NULL THEN
    RAISE EXCEPTION 'image jobs preflight failed: public.product_variants is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.ai_jobs (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  type VARCHAR(60) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 1000),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0 AND max_attempts <= 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  error_code VARCHAR(80),
  error_message_redacted TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_jobs_type_check
    CHECK (type IN ('aura_image_generate', 'aura_image_edit')),
  CONSTRAINT ai_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ai_jobs_terminal_time_check
    CHECK (
      (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
      OR status IN ('queued', 'running')
    )
);

CREATE TABLE IF NOT EXISTS public.campaign_assets (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  campaign_id UUID REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES public.product_variants(id) ON DELETE SET NULL,
  asset_type VARCHAR(40) NOT NULL DEFAULT 'image',
  source VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  original_asset_url TEXT,
  generated_asset_url TEXT,
  cloudinary_public_id TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  format VARCHAR(30),
  prompt TEXT,
  prompt_version VARCHAR(40),
  model VARCHAR(100),
  moderation_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT campaign_assets_asset_type_check
    CHECK (asset_type IN ('image')),
  CONSTRAINT campaign_assets_source_check
    CHECK (source IN ('aura_generated', 'aura_edited')),
  CONSTRAINT campaign_assets_status_check
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'deleted')),
  CONSTRAINT campaign_assets_moderation_status_check
    CHECK (moderation_status IN ('pending', 'approved', 'flagged', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_claim
  ON public.ai_jobs(status, available_at, priority, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_ai_jobs_tenant_created
  ON public.ai_jobs(owner_admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_locked
  ON public.ai_jobs(status, locked_at)
  WHERE status = 'running';

-- Active dedupe excludes completed jobs so a finished image generation does not
-- block a legitimate later generation with the same dedupe key. The old draft
-- index name is dropped because it included completed jobs.
DROP INDEX IF EXISTS public.idx_ai_jobs_dedupe_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_jobs_dedupe_active
  ON public.ai_jobs(owner_admin_id, type, dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_campaign_assets_tenant_created
  ON public.campaign_assets(owner_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign
  ON public.campaign_assets(owner_admin_id, campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_assets_product
  ON public.campaign_assets(owner_admin_id, product_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_campaign_assets_cloudinary_public_id
  ON public.campaign_assets(cloudinary_public_id)
  WHERE cloudinary_public_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.aura_image_jobs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.validate_campaign_asset_tenant()
RETURNS TRIGGER AS $$
DECLARE
  campaign_owner INTEGER;
  product_owner INTEGER;
  variant_owner INTEGER;
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    SELECT owner_admin_id INTO campaign_owner
    FROM public.marketing_campaigns
    WHERE id = NEW.campaign_id;
    IF campaign_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign asset tenant mismatch';
    END IF;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT owner_admin_id INTO product_owner
    FROM public.products
    WHERE id = NEW.product_id;
    IF product_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Product asset tenant mismatch';
    END IF;
  END IF;

  IF NEW.variant_id IS NOT NULL THEN
    SELECT p.owner_admin_id INTO variant_owner
    FROM public.product_variants pv
    JOIN public.products p ON p.id = pv.product_id
    WHERE pv.id = NEW.variant_id;
    IF variant_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Variant asset tenant mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_jobs_updated_at ON public.ai_jobs;
CREATE TRIGGER trg_ai_jobs_updated_at
BEFORE UPDATE ON public.ai_jobs
FOR EACH ROW EXECUTE FUNCTION public.aura_image_jobs_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_assets_updated_at ON public.campaign_assets;
CREATE TRIGGER trg_campaign_assets_updated_at
BEFORE UPDATE ON public.campaign_assets
FOR EACH ROW EXECUTE FUNCTION public.aura_image_jobs_touch_updated_at();

DROP TRIGGER IF EXISTS trg_validate_campaign_asset_tenant ON public.campaign_assets;
CREATE TRIGGER trg_validate_campaign_asset_tenant
BEFORE INSERT OR UPDATE ON public.campaign_assets
FOR EACH ROW EXECUTE FUNCTION public.validate_campaign_asset_tenant();

COMMENT ON TABLE public.ai_jobs IS
  'Tenant-aware asynchronous AI job queue. Workers claim rows with FOR UPDATE SKIP LOCKED.';
COMMENT ON TABLE public.campaign_assets IS
  'Generated or edited AURA Growth campaign images. Original catalog images are never overwritten.';

COMMIT;
