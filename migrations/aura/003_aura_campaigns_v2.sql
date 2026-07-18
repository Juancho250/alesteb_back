-- =============================================================================
-- AURA Growth campaign drafts, consent and attribution foundation v2
--
-- Non-sending migration. Instagram and TikTok are export-only.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'campaigns v2 preflight failed: public.users is required';
  END IF;
  IF to_regclass('public.sales') IS NULL THEN
    RAISE EXCEPTION 'campaigns v2 preflight failed: public.sales is required';
  END IF;
  IF to_regclass('public.discounts') IS NULL THEN
    RAISE EXCEPTION 'campaigns v2 preflight failed: public.discounts is required';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.marketing_segments (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name VARCHAR(160) NOT NULL,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_size INTEGER NOT NULL DEFAULT 0 CHECK (estimated_size >= 0),
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id UUID PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name VARCHAR(160) NOT NULL,
  objective VARCHAR(120) NOT NULL,
  channel VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  segment_id UUID REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  discount_id INTEGER REFERENCES public.discounts(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  budget NUMERIC(14,2) CHECK (budget IS NULL OR budget >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'COP',
  source_type VARCHAR(40) NOT NULL DEFAULT 'aura_growth',
  ai_generated BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketing_campaigns_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'push', 'instagram', 'tiktok')),
  CONSTRAINT marketing_campaigns_status_check
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  CONSTRAINT marketing_campaigns_currency_check
    CHECK (currency = UPPER(currency))
);

CREATE TABLE IF NOT EXISTS public.campaign_contents (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  headline VARCHAR(180),
  body TEXT NOT NULL,
  call_to_action VARCHAR(140),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_version VARCHAR(40),
  model VARCHAR(100),
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_contents_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'push', 'instagram', 'tiktok')),
  CONSTRAINT campaign_contents_unique_version UNIQUE (campaign_id, channel, version)
);

CREATE TABLE IF NOT EXISTS public.customer_consents (
  id BIGSERIAL PRIMARY KEY,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  source VARCHAR(80) NOT NULL DEFAULT 'manual',
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  proof_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_consents_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'push')),
  CONSTRAINT customer_consents_status_check
    CHECK (status IN ('granted', 'revoked', 'unknown')),
  CONSTRAINT customer_consents_timeline_check
    CHECK (
      (status = 'granted' AND granted_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR status = 'unknown'
    ),
  CONSTRAINT customer_consents_unique_channel UNIQUE (owner_admin_id, user_id, channel)
);

CREATE TABLE IF NOT EXISTS public.campaign_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recipient_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL,
  consent_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_recipients_channel_check
    CHECK (channel IN ('email', 'whatsapp', 'push', 'instagram', 'tiktok')),
  CONSTRAINT campaign_recipients_status_check
    CHECK (status IN ('draft', 'eligible', 'excluded_no_consent', 'excluded_opt_out', 'excluded_missing_contact', 'ready', 'sent', 'skipped', 'failed')),
  CONSTRAINT campaign_recipients_ready_requires_direct_consent
    CHECK (
      status <> 'ready'
      OR (
        channel IN ('email', 'whatsapp', 'push')
        AND consent_snapshot @> '{"status":"granted"}'::jsonb
      )
    ),
  CONSTRAINT campaign_recipients_unique_recipient UNIQUE (campaign_id, recipient_user_id, channel),
  CONSTRAINT campaign_recipients_unique_dedupe UNIQUE (campaign_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS public.campaign_events (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  campaign_recipient_id BIGINT REFERENCES public.campaign_recipients(id) ON DELETE SET NULL,
  recipient_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  external_event_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_events_type_check
    CHECK (event_type IN (
      'drafted', 'exported', 'queued', 'sent', 'delivered', 'opened',
      'read', 'clicked', 'bounced', 'unsubscribed', 'converted', 'failed'
    ))
);

ALTER TABLE public.campaign_events
  DROP CONSTRAINT IF EXISTS campaign_events_type_check;

ALTER TABLE public.campaign_events
  ADD CONSTRAINT campaign_events_type_check
  CHECK (event_type IN (
    'drafted', 'exported', 'queued', 'sent', 'delivered', 'opened',
    'read', 'clicked', 'bounced', 'unsubscribed', 'converted', 'failed'
  ));

CREATE TABLE IF NOT EXISTS public.campaign_attributions (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  owner_admin_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recipient_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  sale_id INTEGER NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  payment_reference TEXT,
  payment_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_model VARCHAR(40) NOT NULL DEFAULT 'last_touch',
  attributed_revenue NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (attributed_revenue >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_attributions_unique_sale UNIQUE (campaign_id, sale_id, attribution_model)
);

CREATE INDEX IF NOT EXISTS idx_marketing_segments_tenant_created
  ON public.marketing_segments(owner_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_tenant_status_created
  ON public.marketing_campaigns(owner_admin_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_tenant_channel_status
  ON public.marketing_campaigns(owner_admin_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_segment
  ON public.marketing_campaigns(segment_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_discount
  ON public.marketing_campaigns(discount_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contents_campaign
  ON public.campaign_contents(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_consents_tenant_channel_status
  ON public.customer_consents(owner_admin_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_customer_consents_user_channel
  ON public.customer_consents(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_tenant_status
  ON public.campaign_recipients(owner_admin_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_user
  ON public.campaign_recipients(owner_admin_id, recipient_user_id, channel);
CREATE INDEX IF NOT EXISTS idx_campaign_events_tenant_type_time
  ON public.campaign_events(owner_admin_id, event_type, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_events_external_dedupe
  ON public.campaign_events(campaign_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_attributions_tenant_time
  ON public.campaign_attributions(owner_admin_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_attributions_sale
  ON public.campaign_attributions(sale_id);

CREATE OR REPLACE FUNCTION public.aura_growth_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.aura_growth_resolved_user_owner(p_user_id INTEGER)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(u.owner_admin_id, u.id)
  FROM public.users u
  WHERE u.id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.validate_marketing_campaign_tenant()
RETURNS TRIGGER AS $$
DECLARE
  actor_owner INTEGER;
  approver_owner INTEGER;
  segment_owner INTEGER;
  discount_owner INTEGER;
BEGIN
  actor_owner := public.aura_growth_resolved_user_owner(NEW.created_by);
  IF actor_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Campaign creator tenant mismatch';
  END IF;

  IF NEW.approved_by IS NOT NULL THEN
    approver_owner := public.aura_growth_resolved_user_owner(NEW.approved_by);
    IF approver_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign approver tenant mismatch';
    END IF;
  END IF;

  IF NEW.segment_id IS NOT NULL THEN
    SELECT owner_admin_id INTO segment_owner
    FROM public.marketing_segments
    WHERE id = NEW.segment_id;
    IF segment_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign segment tenant mismatch';
    END IF;
  END IF;

  IF NEW.discount_id IS NOT NULL THEN
    SELECT owner_admin_id INTO discount_owner
    FROM public.discounts
    WHERE id = NEW.discount_id;
    IF discount_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign discount tenant mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.validate_customer_consent_tenant()
RETURNS TRIGGER AS $$
DECLARE
  user_owner INTEGER;
BEGIN
  user_owner := public.aura_growth_resolved_user_owner(NEW.user_id);
  IF user_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Consent tenant mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.validate_campaign_recipient_safety()
RETURNS TRIGGER AS $$
DECLARE
  campaign_owner INTEGER;
  campaign_channel TEXT;
  user_owner INTEGER;
  consent_status TEXT;
BEGIN
  SELECT owner_admin_id, channel
  INTO campaign_owner, campaign_channel
  FROM public.marketing_campaigns
  WHERE id = NEW.campaign_id;

  IF campaign_owner IS NULL THEN
    RAISE EXCEPTION 'Campaign does not exist';
  END IF;
  IF campaign_owner <> NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Campaign tenant mismatch';
  END IF;
  IF campaign_channel <> NEW.channel THEN
    RAISE EXCEPTION 'Campaign channel mismatch';
  END IF;

  user_owner := public.aura_growth_resolved_user_owner(NEW.recipient_user_id);
  IF user_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Recipient tenant mismatch';
  END IF;

  IF NEW.status = 'ready' THEN
    IF NEW.channel IN ('instagram', 'tiktok') THEN
      RAISE EXCEPTION 'Export-only channels cannot be marked ready for sending';
    END IF;

    SELECT status
    INTO consent_status
    FROM public.customer_consents
    WHERE owner_admin_id = NEW.owner_admin_id
      AND user_id = NEW.recipient_user_id
      AND channel = NEW.channel;

    IF consent_status IS DISTINCT FROM 'granted' THEN
      RAISE EXCEPTION 'Recipient cannot be ready without granted consent';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.validate_campaign_event_tenant()
RETURNS TRIGGER AS $$
DECLARE
  campaign_owner INTEGER;
  recipient_owner INTEGER;
  user_owner INTEGER;
BEGIN
  SELECT owner_admin_id INTO campaign_owner
  FROM public.marketing_campaigns
  WHERE id = NEW.campaign_id;
  IF campaign_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Campaign event tenant mismatch';
  END IF;

  IF NEW.campaign_recipient_id IS NOT NULL THEN
    SELECT owner_admin_id INTO recipient_owner
    FROM public.campaign_recipients
    WHERE id = NEW.campaign_recipient_id;
    IF recipient_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign event recipient tenant mismatch';
    END IF;
  END IF;

  IF NEW.recipient_user_id IS NOT NULL THEN
    user_owner := public.aura_growth_resolved_user_owner(NEW.recipient_user_id);
    IF user_owner IS DISTINCT FROM NEW.owner_admin_id THEN
      RAISE EXCEPTION 'Campaign event user tenant mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.validate_campaign_attribution_sale()
RETURNS TRIGGER AS $$
DECLARE
  campaign_owner INTEGER;
  sale_owner INTEGER;
  sale_customer INTEGER;
  sale_payment_status TEXT;
  sale_delivery_status TEXT;
  sale_total NUMERIC(14,2);
BEGIN
  SELECT owner_admin_id
  INTO campaign_owner
  FROM public.marketing_campaigns
  WHERE id = NEW.campaign_id;

  IF campaign_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Campaign tenant mismatch';
  END IF;

  SELECT owner_admin_id, customer_id, payment_status, delivery_status, total
  INTO sale_owner, sale_customer, sale_payment_status, sale_delivery_status, sale_total
  FROM public.sales
  WHERE id = NEW.sale_id;

  IF sale_owner IS DISTINCT FROM NEW.owner_admin_id THEN
    RAISE EXCEPTION 'Sale tenant mismatch';
  END IF;

  IF sale_customer IS DISTINCT FROM NEW.recipient_user_id THEN
    RAISE EXCEPTION 'Sale customer mismatch';
  END IF;

  IF LOWER(COALESCE(sale_payment_status, '')) <> 'paid'
     OR LOWER(COALESCE(sale_delivery_status, '')) = 'cancelled' THEN
    RAISE EXCEPTION 'Only paid and non-cancelled sales can be attributed';
  END IF;

  IF NEW.attributed_revenue = 0 THEN
    NEW.attributed_revenue = COALESCE(sale_total, 0);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketing_segments_updated_at ON public.marketing_segments;
CREATE TRIGGER trg_marketing_segments_updated_at
BEFORE UPDATE ON public.marketing_segments
FOR EACH ROW EXECUTE FUNCTION public.aura_growth_touch_updated_at();

DROP TRIGGER IF EXISTS trg_marketing_campaigns_updated_at ON public.marketing_campaigns;
CREATE TRIGGER trg_marketing_campaigns_updated_at
BEFORE UPDATE ON public.marketing_campaigns
FOR EACH ROW EXECUTE FUNCTION public.aura_growth_touch_updated_at();

DROP TRIGGER IF EXISTS trg_customer_consents_updated_at ON public.customer_consents;
CREATE TRIGGER trg_customer_consents_updated_at
BEFORE UPDATE ON public.customer_consents
FOR EACH ROW EXECUTE FUNCTION public.aura_growth_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campaign_recipients_updated_at ON public.campaign_recipients;
CREATE TRIGGER trg_campaign_recipients_updated_at
BEFORE UPDATE ON public.campaign_recipients
FOR EACH ROW EXECUTE FUNCTION public.aura_growth_touch_updated_at();

DROP TRIGGER IF EXISTS trg_validate_marketing_campaign_tenant ON public.marketing_campaigns;
CREATE TRIGGER trg_validate_marketing_campaign_tenant
BEFORE INSERT OR UPDATE ON public.marketing_campaigns
FOR EACH ROW EXECUTE FUNCTION public.validate_marketing_campaign_tenant();

DROP TRIGGER IF EXISTS trg_validate_customer_consent_tenant ON public.customer_consents;
CREATE TRIGGER trg_validate_customer_consent_tenant
BEFORE INSERT OR UPDATE ON public.customer_consents
FOR EACH ROW EXECUTE FUNCTION public.validate_customer_consent_tenant();

DROP TRIGGER IF EXISTS trg_validate_campaign_recipient_safety ON public.campaign_recipients;
CREATE TRIGGER trg_validate_campaign_recipient_safety
BEFORE INSERT OR UPDATE ON public.campaign_recipients
FOR EACH ROW EXECUTE FUNCTION public.validate_campaign_recipient_safety();

DROP TRIGGER IF EXISTS trg_validate_campaign_event_tenant ON public.campaign_events;
CREATE TRIGGER trg_validate_campaign_event_tenant
BEFORE INSERT OR UPDATE ON public.campaign_events
FOR EACH ROW EXECUTE FUNCTION public.validate_campaign_event_tenant();

DROP TRIGGER IF EXISTS trg_validate_campaign_attribution_sale ON public.campaign_attributions;
CREATE TRIGGER trg_validate_campaign_attribution_sale
BEFORE INSERT OR UPDATE ON public.campaign_attributions
FOR EACH ROW EXECUTE FUNCTION public.validate_campaign_attribution_sale();

COMMENT ON TABLE public.marketing_campaigns IS
  'AURA Growth campaign drafts. Instagram and TikTok remain export-only in this version.';
COMMENT ON TABLE public.customer_consents IS
  'Tenant-scoped channel consent. Opt-out/revoked state must prevail at estimate and send time.';
COMMENT ON TABLE public.campaign_attributions IS
  'Campaign attribution to paid and non-cancelled sales only.';

COMMIT;
