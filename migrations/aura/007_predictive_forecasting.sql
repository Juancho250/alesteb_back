-- =============================================================================
-- AURA Predictive statistical baseline forecasting
--
-- Depends on 004_aura_image_jobs.sql and 006_predictive_features.sql.
-- Does not run jobs or backfills.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.ai_jobs') IS NULL THEN
    RAISE EXCEPTION 'forecasting preflight failed: public.ai_jobs is required';
  END IF;
  IF to_regclass('public.prediction_runs') IS NULL THEN
    RAISE EXCEPTION 'forecasting preflight failed: public.prediction_runs is required';
  END IF;
  IF to_regclass('public.prediction_results') IS NULL THEN
    RAISE EXCEPTION 'forecasting preflight failed: public.prediction_results is required';
  END IF;
  IF to_regclass('public.daily_product_features') IS NULL THEN
    RAISE EXCEPTION 'forecasting preflight failed: public.daily_product_features is required';
  END IF;
  IF to_regclass('public.daily_variant_features') IS NULL THEN
    RAISE EXCEPTION 'forecasting preflight failed: public.daily_variant_features is required';
  END IF;
END
$preflight$;

ALTER TABLE public.ai_jobs
  DROP CONSTRAINT IF EXISTS ai_jobs_type_check;

ALTER TABLE public.ai_jobs
  ADD CONSTRAINT ai_jobs_type_check
  CHECK (type IN ('aura_image_generate', 'aura_image_edit', 'aura_prediction_recalculate'));

CREATE INDEX IF NOT EXISTS idx_prediction_results_latest_demand
  ON public.prediction_results(owner_admin_id, target_type, metric, horizon_days, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prediction_results_product_latest
  ON public.prediction_results(owner_admin_id, product_id, horizon_days, created_at DESC)
  WHERE target_type = 'product';

CREATE INDEX IF NOT EXISTS idx_prediction_results_variant_latest
  ON public.prediction_results(owner_admin_id, variant_id, horizon_days, created_at DESC)
  WHERE target_type = 'variant';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_jobs_recalculate_dedupe_active
  ON public.ai_jobs(owner_admin_id, type, dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND type = 'aura_prediction_recalculate'
    AND status IN ('queued', 'running');

COMMENT ON INDEX public.idx_prediction_results_latest_demand IS
  'Lookup latest saved AURA Predictive demand forecasts without recalculating in GET requests.';

COMMENT ON INDEX public.idx_ai_jobs_recalculate_dedupe_active IS
  'Active-only dedupe for forecast recalculation jobs. Completed jobs must not block legitimate future recalculations.';

COMMIT;

