-- =============================================================================
-- AURA Customer Growth: RFM snapshots, churn and repurchase scores
--
-- Stores analysis snapshots only. No raw contact PII and no sends.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'customer growth preflight failed: public.users is required';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'customer growth preflight failed: public.products is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.aura_customer_segment_runs (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  segment_version VARCHAR(80) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'running',
  rows_count INTEGER NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT aura_customer_segment_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS public.aura_customer_segment_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.aura_customer_segment_runs(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  segment_version VARCHAR(80) NOT NULL,
  segment_key VARCHAR(60) NOT NULL,
  segment_label VARCHAR(100) NOT NULL,
  recency_days INTEGER CHECK (recency_days IS NULL OR recency_days >= 0),
  frequency INTEGER NOT NULL DEFAULT 0 CHECK (frequency >= 0),
  monetary NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monetary >= 0),
  recency_score SMALLINT CHECK (recency_score IS NULL OR recency_score BETWEEN 1 AND 5),
  frequency_score SMALLINT CHECK (frequency_score IS NULL OR frequency_score BETWEEN 1 AND 5),
  monetary_score SMALLINT CHECK (monetary_score IS NULL OR monetary_score BETWEEN 1 AND 5),
  rfm_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  habitual_repurchase_days NUMERIC(8,2),
  days_overdue NUMERIC(8,2),
  churn_score NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (churn_score >= 0 AND churn_score <= 100),
  churn_level VARCHAR(30) NOT NULL,
  repurchase_score NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (repurchase_score >= 0 AND repurchase_score <= 100),
  repurchase_level VARCHAR(30) NOT NULL,
  trend_label VARCHAR(40) NOT NULL DEFAULT 'unknown',
  primary_product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
  primary_category_id INTEGER,
  factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_used JSONB NOT NULL DEFAULT '{}'::jsonb,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  example_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aura_customer_segment_snapshots_unique_customer UNIQUE (run_id, customer_id),
  CONSTRAINT aura_customer_segment_snapshots_churn_level_check
    CHECK (churn_level IN ('bajo', 'medio', 'alto', 'critico', 'insuficiente')),
  CONSTRAINT aura_customer_segment_snapshots_repurchase_level_check
    CHECK (repurchase_level IN ('baja', 'media', 'alta', 'insuficiente'))
);

CREATE INDEX IF NOT EXISTS idx_aura_customer_segment_runs_latest
  ON public.aura_customer_segment_runs(owner_admin_id, as_of_date DESC, segment_version, completed_at DESC)
  WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_aura_customer_segments_tenant_segment
  ON public.aura_customer_segment_snapshots(owner_admin_id, as_of_date DESC, segment_key);
CREATE INDEX IF NOT EXISTS idx_aura_customer_segments_tenant_churn
  ON public.aura_customer_segment_snapshots(owner_admin_id, as_of_date DESC, churn_level, churn_score DESC);
CREATE INDEX IF NOT EXISTS idx_aura_customer_segments_tenant_repurchase
  ON public.aura_customer_segment_snapshots(owner_admin_id, as_of_date DESC, repurchase_level, repurchase_score DESC);
CREATE INDEX IF NOT EXISTS idx_aura_customer_segments_customer_history
  ON public.aura_customer_segment_snapshots(owner_admin_id, customer_id, as_of_date DESC);

CREATE OR REPLACE FUNCTION public.validate_aura_customer_growth_tenant()
RETURNS TRIGGER AS $$
DECLARE
  customer_owner INTEGER;
  product_owner INTEGER;
BEGIN
  SELECT COALESCE(owner_admin_id, id) INTO customer_owner
  FROM public.users
  WHERE id = NEW.customer_id;

  IF customer_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Customer growth tenant mismatch';
  END IF;

  IF NEW.primary_product_id IS NOT NULL THEN
    SELECT owner_admin_id INTO product_owner
    FROM public.products
    WHERE id = NEW.primary_product_id;

    IF product_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Customer growth product tenant mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_aura_customer_growth_tenant ON public.aura_customer_segment_snapshots;
CREATE TRIGGER trg_validate_aura_customer_growth_tenant
BEFORE INSERT OR UPDATE ON public.aura_customer_segment_snapshots
FOR EACH ROW EXECUTE FUNCTION public.validate_aura_customer_growth_tenant();

COMMENT ON TABLE public.aura_customer_segment_runs IS
  'Historical AURA Customer Growth runs. New runs preserve segment traceability.';
COMMENT ON TABLE public.aura_customer_segment_snapshots IS
  'Tenant-aware RFM, churn and repurchase snapshots. Stores customer ids and metrics only; no raw email or phone.';
COMMENT ON COLUMN public.aura_customer_segment_snapshots.churn_score IS
  'Explainable heuristic score, not a calibrated probability.';
COMMENT ON COLUMN public.aura_customer_segment_snapshots.repurchase_score IS
  'Explainable opportunity score, not a calibrated probability.';

COMMIT;

