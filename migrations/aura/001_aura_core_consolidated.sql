-- =============================================================================
-- AURA 2070 core consolidated migration
--
-- Replaces:
--   migrations/2026_07_12_aura_secure_mvp.sql
--   migrations/2026_07_12_aura_mvp.sql
--
-- Contract source:
--   services/auraAudit.service.js
--   services/auraUsage.service.js
--   services/auraOpenAI.service.js
--   services/auraChat.service.js
--   services/auraVoice.service.js
--
-- Canonical conventions:
--   completed_at is the canonical finish timestamp.
--   finished_at is retained as a compatibility mirror.
--   estimated_cost is the canonical USD numeric cost.
--   estimated_cost_usd is retained as a compatibility mirror.
--   error_message_redacted is canonical.
--   error_message is retained as a compatibility mirror.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE
  bad_columns TEXT;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'AURA core preflight failed: public.users is required';
  END IF;

  IF to_regclass('public.agent_conversations') IS NULL THEN
    RAISE EXCEPTION 'AURA core preflight failed: public.agent_conversations is required';
  END IF;

  SELECT string_agg(format('%I.%I:%s', table_name, column_name, udt_name), ', ')
  INTO bad_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'users' AND column_name IN ('id', 'owner_admin_id') AND udt_name <> 'int4')
      OR (table_name = 'agent_conversations' AND column_name = 'user_id' AND udt_name <> 'int4')
      OR (table_name = 'agent_conversations' AND column_name = 'owner_admin_id' AND udt_name <> 'int4')
      OR (table_name = 'aura_runs' AND column_name IN ('id', 'request_id') AND udt_name <> 'uuid')
      OR (table_name = 'ai_usage_daily' AND column_name = 'owner_admin_id' AND udt_name <> 'int4')
    );

  IF bad_columns IS NOT NULL THEN
    RAISE EXCEPTION 'AURA core preflight failed: incompatible column types: %', bad_columns;
  END IF;
END
$preflight$;

-- Serialize the legacy conversation tenant backfill. Put the web process in a
-- short maintenance/read-only window before applying in Neon.
LOCK TABLE public.agent_conversations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.agent_conversations
  ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER;

UPDATE public.agent_conversations ac
SET owner_admin_id = COALESCE(u.owner_admin_id, u.id)
FROM public.users u
WHERE ac.user_id = u.id
  AND ac.owner_admin_id IS NULL;

DO $validate_conversations$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.agent_conversations ac
    LEFT JOIN public.users u ON u.id = ac.user_id
    WHERE ac.user_id IS NULL
       OR u.id IS NULL
       OR COALESCE(u.owner_admin_id, u.id) IS NULL
  ) THEN
    RAISE EXCEPTION 'AURA core aborted: agent_conversations has orphan/null users or unresolved tenants';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.agent_conversations ac
    JOIN public.users u ON u.id = ac.user_id
    WHERE ac.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
  ) THEN
    RAISE EXCEPTION 'AURA core aborted: agent_conversations tenant mismatch found';
  END IF;
END
$validate_conversations$;

ALTER TABLE public.agent_conversations
  ALTER COLUMN owner_admin_id SET NOT NULL;

DO $fk_agent_conversations$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.agent_conversations'::regclass
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (owner_admin_id) REFERENCES users(id)%'
  ) THEN
    ALTER TABLE public.agent_conversations
      ADD CONSTRAINT agent_conversations_owner_admin_id_fkey
      FOREIGN KEY (owner_admin_id)
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;
END
$fk_agent_conversations$;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_tenant_updated
  ON public.agent_conversations (owner_admin_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_tenant_user_updated
  ON public.agent_conversations (owner_admin_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.aura_runs (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  conversation_id TEXT,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  redacted_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  structured_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  tools_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(18,8) NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  error_code TEXT,
  error_message_redacted TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

ALTER TABLE public.aura_runs
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS user_id INTEGER,
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running',
  ADD COLUMN IF NOT EXISTS redacted_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS structured_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tools_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message_redacted TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

UPDATE public.aura_runs
SET
  provider = COALESCE(NULLIF(provider, ''), 'openai'),
  status = COALESCE(NULLIF(status, ''), 'running'),
  redacted_input = COALESCE(redacted_input, '{}'::jsonb),
  structured_output = COALESCE(structured_output, '{}'::jsonb),
  tools_used = COALESCE(tools_used, '[]'::jsonb),
  input_tokens = COALESCE(input_tokens, 0),
  output_tokens = COALESCE(output_tokens, 0),
  total_tokens = GREATEST(COALESCE(total_tokens, 0), COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)),
  estimated_cost = GREATEST(COALESCE(estimated_cost, 0), COALESCE(estimated_cost_usd, 0)),
  estimated_cost_usd = GREATEST(COALESCE(estimated_cost, 0), COALESCE(estimated_cost_usd, 0)),
  error_message_redacted = COALESCE(error_message_redacted, error_message),
  error_message = COALESCE(error_message, error_message_redacted),
  completed_at = COALESCE(completed_at, finished_at),
  finished_at = COALESCE(finished_at, completed_at)
WHERE provider IS NULL
   OR status IS NULL
   OR redacted_input IS NULL
   OR structured_output IS NULL
   OR tools_used IS NULL
   OR input_tokens IS NULL
   OR output_tokens IS NULL
   OR total_tokens IS NULL
   OR estimated_cost IS NULL
   OR estimated_cost_usd IS NULL
   OR estimated_cost <> estimated_cost_usd
   OR error_message_redacted IS NULL
   OR error_message IS NULL
   OR completed_at IS DISTINCT FROM finished_at;

ALTER TABLE public.aura_runs
  ALTER COLUMN request_id SET NOT NULL,
  ALTER COLUMN owner_admin_id SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN model SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN redacted_input SET NOT NULL,
  ALTER COLUMN structured_output SET NOT NULL,
  ALTER COLUMN tools_used SET NOT NULL,
  ALTER COLUMN input_tokens SET NOT NULL,
  ALTER COLUMN output_tokens SET NOT NULL,
  ALTER COLUMN total_tokens SET NOT NULL,
  ALTER COLUMN estimated_cost SET NOT NULL,
  ALTER COLUMN estimated_cost_usd SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

DO $aura_runs_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_request_id_key'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_request_id_key UNIQUE (request_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_status_check'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_status_check
      CHECK (status IN ('running', 'completed', 'failed', 'cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_token_counts_check'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_token_counts_check
      CHECK (input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_estimated_cost_check'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_estimated_cost_check
      CHECK (estimated_cost >= 0 AND estimated_cost_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_latency_check'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_latency_check
      CHECK (latency_ms IS NULL OR latency_ms >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aura_runs'::regclass
      AND conname = 'aura_runs_finish_time_check'
  ) THEN
    ALTER TABLE public.aura_runs
      ADD CONSTRAINT aura_runs_finish_time_check
      CHECK (
        (completed_at IS NULL OR completed_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
      );
  END IF;
END
$aura_runs_constraints$;

CREATE INDEX IF NOT EXISTS idx_aura_runs_tenant_created
  ON public.aura_runs (owner_admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aura_runs_tenant_user_created
  ON public.aura_runs (owner_admin_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aura_runs_tenant_status_created
  ON public.aura_runs (owner_admin_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aura_runs_tenant_conversation_created
  ON public.aura_runs (owner_admin_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_usage_daily (
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  usage_date DATE NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  requests_count INTEGER NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(18,8) NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_request_at TIMESTAMPTZ,
  PRIMARY KEY (owner_admin_id, usage_date)
);

ALTER TABLE public.ai_usage_daily
  ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS usage_date DATE,
  ADD COLUMN IF NOT EXISTS requests INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requests_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errors INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_request_at TIMESTAMPTZ;

UPDATE public.ai_usage_daily
SET
  requests = GREATEST(COALESCE(requests, 0), COALESCE(requests_count, 0)),
  requests_count = GREATEST(COALESCE(requests, 0), COALESCE(requests_count, 0)),
  input_tokens = COALESCE(input_tokens, 0),
  output_tokens = COALESCE(output_tokens, 0),
  total_tokens = GREATEST(COALESCE(total_tokens, 0), COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)),
  estimated_cost = GREATEST(COALESCE(estimated_cost, 0), COALESCE(estimated_cost_usd, 0)),
  estimated_cost_usd = GREATEST(COALESCE(estimated_cost, 0), COALESCE(estimated_cost_usd, 0)),
  errors = COALESCE(errors, 0),
  created_at = COALESCE(created_at, NOW()),
  updated_at = COALESCE(updated_at, NOW())
WHERE requests IS NULL
   OR requests_count IS NULL
   OR input_tokens IS NULL
   OR output_tokens IS NULL
   OR total_tokens IS NULL
   OR estimated_cost IS NULL
   OR estimated_cost_usd IS NULL
   OR estimated_cost <> estimated_cost_usd
   OR errors IS NULL
   OR created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE public.ai_usage_daily
  ALTER COLUMN owner_admin_id SET NOT NULL,
  ALTER COLUMN usage_date SET NOT NULL,
  ALTER COLUMN requests SET NOT NULL,
  ALTER COLUMN requests_count SET NOT NULL,
  ALTER COLUMN input_tokens SET NOT NULL,
  ALTER COLUMN output_tokens SET NOT NULL,
  ALTER COLUMN total_tokens SET NOT NULL,
  ALTER COLUMN estimated_cost SET NOT NULL,
  ALTER COLUMN estimated_cost_usd SET NOT NULL,
  ALTER COLUMN errors SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

DO $ai_usage_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ai_usage_daily'::regclass
      AND conname = 'ai_usage_daily_non_negative_check'
  ) THEN
    ALTER TABLE public.ai_usage_daily
      ADD CONSTRAINT ai_usage_daily_non_negative_check
      CHECK (
        requests >= 0
        AND requests_count >= 0
        AND input_tokens >= 0
        AND output_tokens >= 0
        AND total_tokens >= 0
        AND estimated_cost >= 0
        AND estimated_cost_usd >= 0
        AND errors >= 0
      );
  END IF;
END
$ai_usage_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_daily_tenant_date_unique
  ON public.ai_usage_daily (owner_admin_id, usage_date);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_date
  ON public.ai_usage_daily (usage_date DESC);

COMMENT ON COLUMN public.agent_conversations.owner_admin_id IS
  'Tenant resolved from users.owner_admin_id or users.id. Never accepted from model input.';

COMMENT ON TABLE public.aura_runs IS
  'Tenant-scoped audit and metering record for each AURA request.';

COMMENT ON COLUMN public.aura_runs.estimated_cost IS
  'Canonical estimated USD cost. estimated_cost_usd is retained as compatibility mirror.';

COMMENT ON COLUMN public.aura_runs.completed_at IS
  'Canonical completion timestamp. finished_at is retained as compatibility mirror.';

COMMENT ON TABLE public.ai_usage_daily IS
  'Atomic daily AURA usage totals per tenant.';

COMMIT;
