-- =============================================================================
-- AURA approvable actions and notification outbox v2
--
-- Strategy for existing notification_queue:
--   Keep existing enum columns when present and extend enum values with
--   ALTER TYPE ADD VALUE IF NOT EXISTS. Keep reference_id as INTEGER to avoid
--   breaking transactional legacy references; add reference_key TEXT for
--   extensible string references.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.aura_actions (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  action_type VARCHAR(80) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending_approval',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash CHAR(64) NOT NULL,
  required_permission VARCHAR(80) NOT NULL,
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(80),
  error_message_redacted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aura_actions_type_check
    CHECK (action_type IN (
      'approve_campaign',
      'schedule_campaign',
      'pause_campaign',
      'create_discount_draft',
      'approve_discount',
      'enqueue_campaign_delivery'
    )),
  CONSTRAINT aura_actions_status_check
    CHECK (status IN (
      'draft', 'pending_approval', 'approved', 'executing', 'completed',
      'rejected', 'expired', 'failed', 'cancelled'
    )),
  CONSTRAINT aura_actions_payload_hash_check
    CHECK (payload_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aura_actions_idempotency
  ON public.aura_actions(owner_admin_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_aura_actions_tenant_status_created
  ON public.aura_actions(owner_admin_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aura_actions_expires
  ON public.aura_actions(expires_at)
  WHERE status IN ('draft', 'pending_approval', 'approved');

DO $extend_enums$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status_type') THEN
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'queued';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'sending';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'sent';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'delivered';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'read';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'clicked';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'failed';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'cancelled';
    ALTER TYPE public.notification_status_type ADD VALUE IF NOT EXISTS 'pending';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_event_type') THEN
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'aura_campaign_delivery';
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'campaign_sent';
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'campaign_delivered';
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'campaign_read';
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'campaign_clicked';
    ALTER TYPE public.notification_event_type ADD VALUE IF NOT EXISTS 'campaign_failed';
  END IF;
END
$extend_enums$;

CREATE TABLE IF NOT EXISTS public.notification_queue (
  id BIGSERIAL PRIMARY KEY
);

ALTER TABLE public.notification_queue
  ADD COLUMN IF NOT EXISTS owner_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS campaign_id UUID,
  ADD COLUMN IF NOT EXISTS recipient JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recipient_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS recipient_phone TEXT,
  ADD COLUMN IF NOT EXISTS recipient_email TEXT,
  ADD COLUMN IF NOT EXISTS channel VARCHAR(30),
  ADD COLUMN IF NOT EXISTS event VARCHAR(120),
  ADD COLUMN IF NOT EXISTS template_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS rendered_subject TEXT,
  ADD COLUMN IF NOT EXISTS rendered_message TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS reference_type VARCHAR(120),
  ADD COLUMN IF NOT EXISTS reference_key TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- reference_id is intentionally kept as integer when it already exists. Add it
-- only for installs that somehow do not have the legacy column.
ALTER TABLE public.notification_queue
  ADD COLUMN IF NOT EXISTS reference_id INTEGER;

-- Backfill only fields introduced or required by the outbox claim path. Do not
-- rewrite historical delivery state, attempts, provider data, content or payload.
UPDATE public.notification_queue
SET available_at = COALESCE(scheduled_for, created_at, NOW())
WHERE available_at IS NULL;

UPDATE public.notification_queue
SET scheduled_for = COALESCE(available_at, created_at, NOW())
WHERE scheduled_for IS NULL;

UPDATE public.notification_queue
SET recipient = '{}'::jsonb
WHERE recipient IS NULL;

UPDATE public.notification_queue
SET updated_at = NOW()
WHERE updated_at IS NULL;

ALTER TABLE public.notification_queue
  ALTER COLUMN available_at SET NOT NULL,
  ALTER COLUMN scheduled_for SET NOT NULL,
  ALTER COLUMN payload SET NOT NULL,
  ALTER COLUMN recipient SET NOT NULL,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN max_attempts SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN rendered_message SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

DO $dedupe_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.notification_queue
    WHERE dedupe_key IS NOT NULL
    GROUP BY owner_admin_id, dedupe_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'notification_queue has duplicate non-null dedupe_key values per tenant';
  END IF;
END
$dedupe_preflight$;

DO $fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.notification_queue'::regclass
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (owner_admin_id) REFERENCES users(id)%'
  ) THEN
    ALTER TABLE public.notification_queue
      ADD CONSTRAINT notification_queue_owner_admin_fkey
      FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.marketing_campaigns') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.notification_queue'::regclass
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (campaign_id) REFERENCES marketing_campaigns(id)%'
  ) THEN
    ALTER TABLE public.notification_queue
      ADD CONSTRAINT notification_queue_campaign_fkey
      FOREIGN KEY (campaign_id) REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.notification_queue'::regclass
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (recipient_user_id) REFERENCES users(id)%'
  ) THEN
    ALTER TABLE public.notification_queue
      ADD CONSTRAINT notification_queue_recipient_user_fkey
      FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$fks$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_queue_dedupe_unique_all
  ON public.notification_queue(owner_admin_id, dedupe_key);

-- Queue eligibility depends on the current time and therefore belongs in the
-- worker query. Keep this predicate immutable and index both scheduling fields.
CREATE INDEX IF NOT EXISTS idx_notification_queue_claim
  ON public.notification_queue(available_at, scheduled_for, created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notification_queue_tenant_campaign
  ON public.notification_queue(owner_admin_id, campaign_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_queue_provider_message
  ON public.notification_queue(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.aura_actions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_aura_actions_updated_at ON public.aura_actions;
CREATE TRIGGER trg_aura_actions_updated_at
BEFORE UPDATE ON public.aura_actions
FOR EACH ROW EXECUTE FUNCTION public.aura_actions_touch_updated_at();

DROP TRIGGER IF EXISTS trg_notification_queue_updated_at ON public.notification_queue;
CREATE TRIGGER trg_notification_queue_updated_at
BEFORE UPDATE ON public.notification_queue
FOR EACH ROW EXECUTE FUNCTION public.aura_actions_touch_updated_at();

COMMENT ON TABLE public.aura_actions IS
  'Human-approvable AURA actions. Chat or voice text confirmation must never execute these actions.';
COMMENT ON COLUMN public.aura_actions.payload_hash IS
  'SHA-256 canonical payload hash verified again before approval execution.';
COMMENT ON COLUMN public.notification_queue.reference_id IS
  'Legacy integer reference id preserved for transactional notifications.';
COMMENT ON COLUMN public.notification_queue.reference_key IS
  'Optional extensible string reference for non-integer external references.';
COMMENT ON TABLE public.notification_queue IS
  'Tenant-aware outbound notification outbox. Workers claim rows atomically and re-check consent before sending.';

COMMIT;
