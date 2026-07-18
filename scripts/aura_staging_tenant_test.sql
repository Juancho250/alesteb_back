\set ON_ERROR_STOP on
\pset pager off
\echo 'AURA tenant integrity test: read-only, transaction-scoped'

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $required_tables$
DECLARE
  required_name TEXT;
BEGIN
  FOREACH required_name IN ARRAY ARRAY[
    'users', 'agent_conversations', 'marketing_campaigns', 'marketing_segments',
    'customer_consents', 'campaign_recipients', 'products', 'campaign_assets',
    'sales', 'campaign_attributions', 'notification_queue', 'ai_jobs',
    'prediction_results', 'aura_voice_sessions'
  ] LOOP
    IF to_regclass('public.' || required_name) IS NULL THEN
      RAISE EXCEPTION 'BLOCKER required table missing: public.%', required_name;
    END IF;
  END LOOP;
END
$required_tables$;

DO $tenant_integrity$
DECLARE
  check_name TEXT;
  bad_count BIGINT;
BEGIN
  FOR check_name, bad_count IN
    SELECT 'agent_conversations_user_tenant', COUNT(*)
    FROM public.agent_conversations ac
    LEFT JOIN public.users u ON u.id = ac.user_id
    WHERE u.id IS NULL
       OR ac.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)

    UNION ALL
    SELECT 'marketing_segments_creator_tenant', COUNT(*)
    FROM public.marketing_segments ms
    LEFT JOIN public.users u ON u.id = ms.created_by
    WHERE u.id IS NULL
       OR ms.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)

    UNION ALL
    SELECT 'marketing_campaigns_relations_tenant', COUNT(*)
    FROM public.marketing_campaigns mc
    LEFT JOIN public.users creator ON creator.id = mc.created_by
    LEFT JOIN public.users approver ON approver.id = mc.approved_by
    LEFT JOIN public.marketing_segments ms ON ms.id = mc.segment_id
    WHERE creator.id IS NULL
       OR mc.owner_admin_id IS DISTINCT FROM COALESCE(creator.owner_admin_id, creator.id)
       OR (approver.id IS NOT NULL AND mc.owner_admin_id IS DISTINCT FROM COALESCE(approver.owner_admin_id, approver.id))
       OR (mc.approved_by IS NOT NULL AND approver.id IS NULL)
       OR (ms.id IS NOT NULL AND ms.owner_admin_id IS DISTINCT FROM mc.owner_admin_id)
       OR (mc.segment_id IS NOT NULL AND ms.id IS NULL)

    UNION ALL
    SELECT 'customer_consents_user_tenant', COUNT(*)
    FROM public.customer_consents cc
    LEFT JOIN public.users u ON u.id = cc.user_id
    WHERE u.id IS NULL
       OR cc.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)

    UNION ALL
    SELECT 'campaign_recipients_relations_tenant', COUNT(*)
    FROM public.campaign_recipients cr
    LEFT JOIN public.marketing_campaigns mc ON mc.id = cr.campaign_id
    LEFT JOIN public.users u ON u.id = cr.recipient_user_id
    WHERE mc.id IS NULL
       OR u.id IS NULL
       OR cr.owner_admin_id IS DISTINCT FROM mc.owner_admin_id
       OR cr.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)

    UNION ALL
    SELECT 'products_owner_exists', COUNT(*)
    FROM public.products p
    LEFT JOIN public.users owner_user ON owner_user.id = p.owner_admin_id
    WHERE p.owner_admin_id IS NULL OR owner_user.id IS NULL

    UNION ALL
    SELECT 'campaign_assets_relations_tenant', COUNT(*)
    FROM public.campaign_assets ca
    LEFT JOIN public.marketing_campaigns mc ON mc.id = ca.campaign_id
    LEFT JOIN public.products p ON p.id = ca.product_id
    LEFT JOIN public.product_variants pv ON pv.id = ca.variant_id
    LEFT JOIN public.products vp ON vp.id = pv.product_id
    WHERE (ca.campaign_id IS NOT NULL AND (mc.id IS NULL OR mc.owner_admin_id IS DISTINCT FROM ca.owner_admin_id))
       OR (ca.product_id IS NOT NULL AND (p.id IS NULL OR p.owner_admin_id IS DISTINCT FROM ca.owner_admin_id))
       OR (ca.variant_id IS NOT NULL AND (pv.id IS NULL OR vp.owner_admin_id IS DISTINCT FROM ca.owner_admin_id))

    UNION ALL
    SELECT 'sales_customer_tenant', COUNT(*)
    FROM public.sales s
    LEFT JOIN public.users u ON u.id = s.customer_id
    WHERE s.owner_admin_id IS NULL
       OR (s.customer_id IS NOT NULL AND (u.id IS NULL OR s.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)))

    UNION ALL
    SELECT 'campaign_attributions_relations_tenant', COUNT(*)
    FROM public.campaign_attributions ca
    LEFT JOIN public.marketing_campaigns mc ON mc.id = ca.campaign_id
    LEFT JOIN public.sales s ON s.id = ca.sale_id
    LEFT JOIN public.users u ON u.id = ca.recipient_user_id
    WHERE mc.id IS NULL OR s.id IS NULL OR u.id IS NULL
       OR ca.owner_admin_id IS DISTINCT FROM mc.owner_admin_id
       OR ca.owner_admin_id IS DISTINCT FROM s.owner_admin_id
       OR ca.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
       OR s.customer_id IS DISTINCT FROM ca.recipient_user_id

    UNION ALL
    SELECT 'notification_queue_relations_tenant', COUNT(*)
    FROM public.notification_queue nq
    LEFT JOIN public.marketing_campaigns mc ON mc.id = nq.campaign_id
    LEFT JOIN public.users u ON u.id = nq.recipient_user_id
    WHERE nq.owner_admin_id IS NULL
       OR (nq.campaign_id IS NOT NULL AND (mc.id IS NULL OR mc.owner_admin_id IS DISTINCT FROM nq.owner_admin_id))
       OR (nq.recipient_user_id IS NOT NULL AND (u.id IS NULL OR nq.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)))

    UNION ALL
    SELECT 'ai_jobs_user_tenant', COUNT(*)
    FROM public.ai_jobs j
    LEFT JOIN public.users u ON u.id = j.user_id
    WHERE j.owner_admin_id IS NULL
       OR u.id IS NULL
       OR j.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)

    UNION ALL
    SELECT 'prediction_results_relations_tenant', COUNT(*)
    FROM public.prediction_results pr
    LEFT JOIN public.prediction_runs run ON run.id = pr.run_id
    LEFT JOIN public.products p ON p.id = pr.product_id
    LEFT JOIN public.product_variants pv ON pv.id = pr.variant_id
    LEFT JOIN public.products vp ON vp.id = pv.product_id
    WHERE run.id IS NULL
       OR run.owner_admin_id IS DISTINCT FROM pr.owner_admin_id
       OR (pr.product_id IS NOT NULL AND (p.id IS NULL OR p.owner_admin_id IS DISTINCT FROM pr.owner_admin_id))
       OR (pr.variant_id IS NOT NULL AND (pv.id IS NULL OR vp.owner_admin_id IS DISTINCT FROM pr.owner_admin_id))

    UNION ALL
    SELECT 'voice_sessions_relations_tenant', COUNT(*)
    FROM public.aura_voice_sessions avs
    LEFT JOIN public.users u ON u.id = avs.user_id
    LEFT JOIN public.agent_conversations ac ON ac.id::text = avs.conversation_id
    WHERE u.id IS NULL
       OR avs.owner_admin_id IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
       OR (avs.conversation_id IS NOT NULL AND (ac.id IS NULL OR ac.owner_admin_id IS DISTINCT FROM avs.owner_admin_id))
  LOOP
    RAISE NOTICE '%: %', check_name, CASE WHEN bad_count = 0 THEN 'PASS' ELSE 'BLOCKER (' || bad_count || ')' END;
    IF bad_count <> 0 THEN
      RAISE EXCEPTION 'BLOCKER tenant integrity check % found % row(s)', check_name, bad_count;
    END IF;
  END LOOP;
END
$tenant_integrity$;

DO $dedupe_integrity$
DECLARE
  duplicate_count BIGINT;
  index_definition TEXT;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT owner_admin_id, dedupe_key
    FROM public.notification_queue
    WHERE dedupe_key IS NOT NULL
    GROUP BY owner_admin_id, dedupe_key
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count <> 0 THEN
    RAISE EXCEPTION 'BLOCKER notification_queue duplicate dedupe keys within tenant: %', duplicate_count;
  END IF;

  SELECT indexdef INTO index_definition
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_notification_queue_dedupe_unique_all';
  IF index_definition IS NULL OR index_definition !~* '\(owner_admin_id, dedupe_key\)' THEN
    RAISE EXCEPTION 'BLOCKER notification_queue tenant-aware dedupe index missing or incompatible';
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT owner_admin_id, type, dedupe_key
    FROM public.ai_jobs
    WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
    GROUP BY owner_admin_id, type, dedupe_key
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count <> 0 THEN
    RAISE EXCEPTION 'BLOCKER ai_jobs active duplicate dedupe keys within tenant: %', duplicate_count;
  END IF;

  RAISE NOTICE 'tenant-aware dedupe contracts: PASS';
END
$dedupe_integrity$;

SELECT 'PASS' AS result,
       'No cross-tenant relationships or active same-tenant dedupe duplicates detected' AS detail;

ROLLBACK;
\echo 'AURA_STAGING_TENANT_TEST_PASS'
