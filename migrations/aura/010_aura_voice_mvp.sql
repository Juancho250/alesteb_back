-- =============================================================================
-- AURA Voice MVP metadata-only schema
--
-- Depends on users, aura_runs and agent_conversations. Does not store audio and
-- does not enable AURA_VOICE_ENABLED.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'voice preflight failed: public.users is required';
  END IF;
  IF to_regclass('public.aura_runs') IS NULL THEN
    RAISE EXCEPTION 'voice preflight failed: public.aura_runs is required';
  END IF;
  IF to_regclass('public.agent_conversations') IS NULL THEN
    RAISE EXCEPTION 'voice preflight failed: public.agent_conversations is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.aura_voice_sessions (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT chk_aura_voice_sessions_status
    CHECK (status IN ('active', 'expired', 'closed'))
);

CREATE TABLE IF NOT EXISTS public.aura_voice_turns (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.aura_voice_sessions(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  aura_run_id UUID REFERENCES public.aura_runs(id) ON DELETE SET NULL,
  conversation_id TEXT,
  request_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  audio_mime_type TEXT NOT NULL,
  audio_size_bytes INTEGER NOT NULL DEFAULT 0,
  audio_duration_seconds NUMERIC(8,2),
  transcript_redacted TEXT,
  response_text_redacted TEXT,
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  tts_model TEXT,
  tts_voice TEXT,
  tts_format TEXT,
  audio_retention TEXT NOT NULL DEFAULT 'not_stored',
  audio_deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_code TEXT,
  error_message_redacted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transcribed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CONSTRAINT chk_aura_voice_turns_status
    CHECK (status IN (
      'received',
      'transcribing',
      'transcribed',
      'responding',
      'synthesizing',
      'completed',
      'blocked_confirmation',
      'failed'
    ))
);

CREATE INDEX IF NOT EXISTS idx_aura_voice_sessions_tenant_user_status
  ON public.aura_voice_sessions (owner_admin_id, user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aura_voice_sessions_expires_at
  ON public.aura_voice_sessions (expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_aura_voice_sessions_conversation
  ON public.aura_voice_sessions (owner_admin_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_aura_voice_turns_request_id_unique
  ON public.aura_voice_turns (request_id);
CREATE INDEX IF NOT EXISTS idx_aura_voice_turns_tenant_session_created
  ON public.aura_voice_turns (owner_admin_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aura_voice_turns_tenant_user_created
  ON public.aura_voice_turns (owner_admin_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aura_voice_turns_aura_run
  ON public.aura_voice_turns (aura_run_id)
  WHERE aura_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aura_voice_turns_expires_at
  ON public.aura_voice_turns (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.aura_voice_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_aura_voice_sessions_updated_at ON public.aura_voice_sessions;
CREATE TRIGGER trg_aura_voice_sessions_updated_at
BEFORE UPDATE ON public.aura_voice_sessions
FOR EACH ROW EXECUTE FUNCTION public.aura_voice_touch_updated_at();

DROP TRIGGER IF EXISTS trg_aura_voice_turns_updated_at ON public.aura_voice_turns;
CREATE TRIGGER trg_aura_voice_turns_updated_at
BEFORE UPDATE ON public.aura_voice_turns
FOR EACH ROW EXECUTE FUNCTION public.aura_voice_touch_updated_at();

COMMENT ON TABLE public.aura_voice_sessions IS
  'Push-to-talk AURA Voice sessions. Tenant-aware and authenticated; no permanent listening.';
COMMENT ON TABLE public.aura_voice_turns IS
  'Metadata-only AURA Voice turn audit. Raw audio and synthesized audio are not stored.';
COMMENT ON COLUMN public.aura_voice_turns.audio_retention IS
  'MVP: not_stored. Audio is processed in memory and discarded at request end.';
COMMENT ON COLUMN public.aura_voice_turns.transcript_redacted IS
  'Redacted transcription; avoid complete PII and secrets.';

COMMIT;

