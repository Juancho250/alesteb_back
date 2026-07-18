-- =============================================================================
-- AURA Growth send-time optimization snapshots
--
-- Depends on 003_aura_campaigns_v2.sql. Does not schedule campaigns or send.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.campaign_events') IS NULL THEN
    RAISE EXCEPTION 'send-time preflight failed: public.campaign_events is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.aura_send_time_metric_runs (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  metric_version VARCHAR(80) NOT NULL,
  timezone VARCHAR(80) NOT NULL,
  timezone_source VARCHAR(40) NOT NULL DEFAULT 'tenant',
  min_observations INTEGER NOT NULL CHECK (min_observations > 0),
  min_campaigns INTEGER NOT NULL CHECK (min_campaigns > 0),
  status VARCHAR(30) NOT NULL DEFAULT 'running',
  rows_count INTEGER NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT aura_send_time_metric_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS public.aura_send_time_metric_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.aura_send_time_metric_runs(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  metric_version VARCHAR(80) NOT NULL,
  channel VARCHAR(30) NOT NULL,
  campaign_type VARCHAR(120) NOT NULL DEFAULT 'generic',
  segment_key VARCHAR(80) NOT NULL DEFAULT 'all_customers',
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  hour_bucket VARCHAR(20) NOT NULL,
  hour_start SMALLINT NOT NULL CHECK (hour_start BETWEEN 0 AND 23),
  hour_end SMALLINT NOT NULL CHECK (hour_end BETWEEN 1 AND 24),
  campaign_count INTEGER NOT NULL DEFAULT 0 CHECK (campaign_count >= 0),
  delivered_count INTEGER NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  clicked_count INTEGER NOT NULL DEFAULT 0 CHECK (clicked_count >= 0),
  converted_count INTEGER NOT NULL DEFAULT 0 CHECK (converted_count >= 0),
  avg_read_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  avg_click_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  avg_conversion_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  performance_score NUMERIC(8,6) NOT NULL DEFAULT 0,
  confidence_level VARCHAR(30) NOT NULL DEFAULT 'insuficiente',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aura_send_time_snapshots_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'push')),
  CONSTRAINT aura_send_time_snapshots_confidence_check
    CHECK (confidence_level IN ('alta', 'media', 'baja', 'insuficiente')),
  CONSTRAINT aura_send_time_snapshots_unique_cell
    UNIQUE (run_id, channel, campaign_type, segment_key, day_of_week, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_aura_send_time_runs_latest
  ON public.aura_send_time_metric_runs(owner_admin_id, as_of_date DESC, metric_version, completed_at DESC)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_aura_send_time_snapshots_lookup
  ON public.aura_send_time_metric_snapshots(
    owner_admin_id, run_id, channel, campaign_type, segment_key, performance_score DESC
  );

COMMENT ON TABLE public.aura_send_time_metric_runs IS
  'Versioned AURA Growth snapshots for observed send-time/channel performance.';
COMMENT ON TABLE public.aura_send_time_metric_snapshots IS
  'Aggregated tenant-aware campaign performance by channel, weekday, time bucket, campaign type and segment. No PII.';
COMMENT ON COLUMN public.aura_send_time_metric_snapshots.performance_score IS
  'Explainable blended observed score using campaign-normalized rates; not a guarantee of future performance.';

COMMIT;

