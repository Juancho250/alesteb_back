-- =============================================================================
-- AURA Predictive feature foundation
--
-- Creates versioned tenant-aware feature and prediction audit tables.
-- Does not run jobs or backfills.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'predictive features preflight failed: public.users is required';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'predictive features preflight failed: public.products is required';
  END IF;
  IF to_regclass('public.product_variants') IS NULL THEN
    RAISE EXCEPTION 'predictive features preflight failed: public.product_variants is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.model_versions (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  version VARCHAR(80) NOT NULL,
  model_type VARCHAR(60) NOT NULL DEFAULT 'feature_baseline',
  feature_version VARCHAR(80) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  training_window_days INTEGER CHECK (training_window_days IS NULL OR training_window_days > 0),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT model_versions_status_check
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  CONSTRAINT model_versions_unique_name_version UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS public.prediction_runs (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  run_type VARCHAR(40) NOT NULL,
  feature_version VARCHAR(80) NOT NULL,
  model_version_id UUID REFERENCES public.model_versions(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'running',
  date_from DATE,
  date_to DATE,
  requested_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  rows_count INTEGER NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(80),
  error_message_redacted TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prediction_runs_type_check
    CHECK (run_type IN ('feature_daily', 'feature_backfill', 'quality_audit', 'prediction')),
  CONSTRAINT prediction_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT prediction_runs_date_range_check
    CHECK (date_from IS NULL OR date_to IS NULL OR date_from <= date_to)
);

CREATE TABLE IF NOT EXISTS public.daily_product_features (
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  feature_date DATE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  feature_version VARCHAR(80) NOT NULL,
  calculation_run_id UUID REFERENCES public.prediction_runs(id) ON DELETE SET NULL,
  units_sold NUMERIC(14,3) NOT NULL DEFAULT 0,
  gross_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  discounts_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  returns_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  returns_value_estimated NUMERIC(14,2) NOT NULL DEFAULT 0,
  cancelled_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  estimated_margin NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock_initial NUMERIC(14,3),
  stock_final NUMERIC(14,3),
  stock_reserved_final NUMERIC(14,3),
  stock_available_final NUMERIC(14,3),
  stockouts INTEGER NOT NULL DEFAULT 0,
  days_without_sale INTEGER,
  rolling_units_7 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_14 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_30 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_90 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_revenue_7 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_14 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_30 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_90 NUMERIC(14,2) NOT NULL DEFAULT 0,
  avg_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  median_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  stddev_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  trend_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  campaign_events_count INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(14,2),
  price_changed BOOLEAN NOT NULL DEFAULT FALSE,
  lead_time_days INTEGER,
  pending_purchase_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  is_data_sufficient BOOLEAN NOT NULL DEFAULT FALSE,
  completeness_score NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (completeness_score >= 0 AND completeness_score <= 1),
  duplicate_sale_items_count INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fingerprint TEXT,
  first_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recalculation_count INTEGER NOT NULL DEFAULT 0 CHECK (recalculation_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_admin_id, feature_date, product_id, feature_version)
);

CREATE TABLE IF NOT EXISTS public.daily_variant_features (
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  feature_date DATE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  feature_version VARCHAR(80) NOT NULL,
  calculation_run_id UUID REFERENCES public.prediction_runs(id) ON DELETE SET NULL,
  units_sold NUMERIC(14,3) NOT NULL DEFAULT 0,
  gross_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  discounts_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  returns_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  returns_value_estimated NUMERIC(14,2) NOT NULL DEFAULT 0,
  cancelled_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  estimated_margin NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock_initial NUMERIC(14,3),
  stock_final NUMERIC(14,3),
  stock_reserved_final NUMERIC(14,3),
  stock_available_final NUMERIC(14,3),
  stockouts INTEGER NOT NULL DEFAULT 0,
  days_without_sale INTEGER,
  rolling_units_7 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_14 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_30 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_units_90 NUMERIC(14,3) NOT NULL DEFAULT 0,
  rolling_revenue_7 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_14 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_30 NUMERIC(14,2) NOT NULL DEFAULT 0,
  rolling_revenue_90 NUMERIC(14,2) NOT NULL DEFAULT 0,
  avg_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  median_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  stddev_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  trend_units_30 NUMERIC(14,4) NOT NULL DEFAULT 0,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  campaign_events_count INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(14,2),
  price_changed BOOLEAN NOT NULL DEFAULT FALSE,
  lead_time_days INTEGER,
  pending_purchase_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  is_data_sufficient BOOLEAN NOT NULL DEFAULT FALSE,
  completeness_score NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (completeness_score >= 0 AND completeness_score <= 1),
  duplicate_sale_items_count INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fingerprint TEXT,
  first_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recalculation_count INTEGER NOT NULL DEFAULT 0 CHECK (recalculation_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_admin_id, feature_date, variant_id, feature_version)
);

CREATE TABLE IF NOT EXISTS public.daily_store_features (
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  feature_date DATE NOT NULL,
  feature_version VARCHAR(80) NOT NULL,
  calculation_run_id UUID REFERENCES public.prediction_runs(id) ON DELETE SET NULL,
  units_sold NUMERIC(14,3) NOT NULL DEFAULT 0,
  gross_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  discounts_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_allocated NUMERIC(14,2) NOT NULL DEFAULT 0,
  returns_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  cancelled_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  estimated_margin NUMERIC(14,2) NOT NULL DEFAULT 0,
  active_products_count INTEGER NOT NULL DEFAULT 0,
  products_with_sales_count INTEGER NOT NULL DEFAULT 0,
  products_stockout_count INTEGER NOT NULL DEFAULT 0,
  pending_purchase_units NUMERIC(14,3) NOT NULL DEFAULT 0,
  campaign_events_count INTEGER NOT NULL DEFAULT 0,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  is_data_sufficient BOOLEAN NOT NULL DEFAULT FALSE,
  completeness_score NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (completeness_score >= 0 AND completeness_score <= 1),
  duplicate_sale_items_count INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fingerprint TEXT,
  first_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recalculation_count INTEGER NOT NULL DEFAULT 0 CHECK (recalculation_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_admin_id, feature_date, feature_version)
);

CREATE TABLE IF NOT EXISTS public.prediction_results (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.prediction_runs(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  model_version_id UUID REFERENCES public.model_versions(id) ON DELETE SET NULL,
  target_type VARCHAR(30) NOT NULL,
  product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES public.product_variants(id) ON DELETE SET NULL,
  prediction_date DATE NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
  metric VARCHAR(60) NOT NULL,
  predicted_value NUMERIC(18,6) NOT NULL,
  lower_bound NUMERIC(18,6),
  upper_bound NUMERIC(18,6),
  confidence_score NUMERIC(5,4) CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  features_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prediction_results_target_type_check
    CHECK (target_type IN ('store', 'product', 'variant')),
  CONSTRAINT prediction_results_target_required_check
    CHECK (
      (target_type = 'store' AND product_id IS NULL AND variant_id IS NULL)
      OR (target_type = 'product' AND product_id IS NOT NULL AND variant_id IS NULL)
      OR (target_type = 'variant' AND product_id IS NOT NULL AND variant_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_daily_product_features_tenant_date
  ON public.daily_product_features(owner_admin_id, feature_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_product_features_product_date
  ON public.daily_product_features(owner_admin_id, product_id, feature_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_variant_features_tenant_date
  ON public.daily_variant_features(owner_admin_id, feature_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_variant_features_variant_date
  ON public.daily_variant_features(owner_admin_id, variant_id, feature_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_store_features_tenant_date
  ON public.daily_store_features(owner_admin_id, feature_date DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_tenant_started
  ON public.prediction_runs(owner_admin_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_status
  ON public.prediction_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_results_tenant_metric_date
  ON public.prediction_results(owner_admin_id, metric, prediction_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prediction_results_unique_target
  ON public.prediction_results(
    owner_admin_id, run_id, target_type,
    COALESCE(product_id, 0), COALESCE(variant_id, 0),
    prediction_date, horizon_days, metric
  );

CREATE OR REPLACE FUNCTION public.aura_predictive_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_versions_updated_at ON public.model_versions;
CREATE TRIGGER trg_model_versions_updated_at
BEFORE UPDATE ON public.model_versions
FOR EACH ROW EXECUTE FUNCTION public.aura_predictive_touch_updated_at();

DROP TRIGGER IF EXISTS trg_prediction_runs_updated_at ON public.prediction_runs;
CREATE TRIGGER trg_prediction_runs_updated_at
BEFORE UPDATE ON public.prediction_runs
FOR EACH ROW EXECUTE FUNCTION public.aura_predictive_touch_updated_at();

DROP TRIGGER IF EXISTS trg_daily_product_features_updated_at ON public.daily_product_features;
CREATE TRIGGER trg_daily_product_features_updated_at
BEFORE UPDATE ON public.daily_product_features
FOR EACH ROW EXECUTE FUNCTION public.aura_predictive_touch_updated_at();

DROP TRIGGER IF EXISTS trg_daily_variant_features_updated_at ON public.daily_variant_features;
CREATE TRIGGER trg_daily_variant_features_updated_at
BEFORE UPDATE ON public.daily_variant_features
FOR EACH ROW EXECUTE FUNCTION public.aura_predictive_touch_updated_at();

DROP TRIGGER IF EXISTS trg_daily_store_features_updated_at ON public.daily_store_features;
CREATE TRIGGER trg_daily_store_features_updated_at
BEFORE UPDATE ON public.daily_store_features
FOR EACH ROW EXECUTE FUNCTION public.aura_predictive_touch_updated_at();

COMMENT ON TABLE public.daily_product_features IS
  'Versioned tenant-scoped product/day features for AURA Predictive. No backfill is executed by this migration.';
COMMENT ON TABLE public.daily_variant_features IS
  'Versioned tenant-scoped variant/day features for AURA Predictive.';
COMMENT ON TABLE public.daily_store_features IS
  'Versioned tenant-scoped store/day aggregate features for AURA Predictive.';
COMMENT ON COLUMN public.daily_product_features.net_revenue IS
  'Item subtotal minus proportional sale-level discount. Taxes are excluded.';
COMMENT ON COLUMN public.daily_product_features.estimated_margin IS
  'Estimated from sale_items.total_profit. Returns/refunds are not deducted unless represented in source tables.';
COMMENT ON COLUMN public.daily_product_features.data_quality IS
  'Completeness, duplicate and anomaly details used to gate predictions.';

COMMIT;

