-- =============================================================================
-- AURA 2070 consolidated migrations preflight
--
-- Read-only. Run on a Neon branch or staging database before migrations/aura.
-- =============================================================================

BEGIN READ ONLY;

SELECT
  '00_context' AS section,
  current_database() AS database_name,
  current_schema() AS current_schema,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS transaction_read_only;

WITH required(table_name) AS (
  VALUES
    ('users'),
    ('agent_conversations'),
    ('sales'),
    ('sale_items'),
    ('products'),
    ('product_variants'),
    ('discounts'),
    ('discount_coupons'),
    ('notification_queue'),
    ('page_views'),
    ('subscriptions'),
    ('subscription_plans')
)
SELECT
  '01_required_tables' AS section,
  r.table_name,
  c.oid IS NOT NULL AS exists_in_public,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned_table'
    WHEN 'v' THEN 'view'
    ELSE c.relkind::text
  END AS relation_type,
  c.reltuples::bigint AS approximate_rows
FROM required r
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.table_name
ORDER BY r.table_name;

WITH expected(table_name, column_name) AS (
  VALUES
    ('users', 'id'),
    ('users', 'owner_admin_id'),
    ('agent_conversations', 'id'),
    ('agent_conversations', 'user_id'),
    ('agent_conversations', 'messages'),
    ('agent_conversations', 'updated_at'),
    ('sales', 'id'),
    ('sales', 'owner_admin_id'),
    ('sales', 'customer_id'),
    ('sales', 'payment_status'),
    ('sales', 'delivery_status'),
    ('sales', 'discount_id'),
    ('products', 'id'),
    ('products', 'owner_admin_id'),
    ('products', 'fulfillment_mode'),
    ('product_variants', 'id'),
    ('product_variants', 'product_id'),
    ('discount_coupons', 'scope'),
    ('expenses', 'purchase_order_id'),
    ('notification_queue', 'owner_admin_id'),
    ('notification_queue', 'channel'),
    ('notification_queue', 'event'),
    ('notification_queue', 'status'),
    ('notification_queue', 'reference_id'),
    ('notification_queue', 'rendered_message'),
    ('notification_queue', 'scheduled_for')
)
SELECT
  '02_expected_columns' AS section,
  e.table_name,
  e.column_name,
  c.data_type,
  c.udt_name,
  c.character_maximum_length,
  c.is_nullable,
  c.column_default,
  c.column_name IS NOT NULL AS exists_in_public
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY e.table_name, e.column_name;

SELECT
  '03_notification_enums' AS section,
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN ('notification_channel_type', 'notification_event_type', 'notification_status_type')
ORDER BY t.typname, e.enumsortorder;

SELECT
  '04_existing_aura_tables' AS section,
  rel.relname AS table_name,
  rel.reltuples::bigint AS approximate_rows
FROM pg_class rel
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relkind IN ('r', 'p')
  AND rel.relname IN (
    'aura_runs',
    'ai_usage_daily',
    'marketing_campaigns',
    'marketing_segments',
    'campaign_contents',
    'customer_consents',
    'campaign_recipients',
    'campaign_events',
    'campaign_attributions',
    'aura_actions',
    'ai_jobs',
    'campaign_assets',
    'prediction_runs',
    'prediction_results',
    'daily_product_features',
    'daily_variant_features',
    'daily_store_features',
    'aura_customer_segment_runs',
    'aura_customer_segment_snapshots',
    'aura_send_time_metric_runs',
    'aura_send_time_metric_snapshots',
    'aura_voice_sessions',
    'aura_voice_turns'
  )
ORDER BY rel.relname;

WITH migration_state(sequence_no, migration_name, expected_objects, found_objects) AS (
  SELECT 1, '001_aura_core_consolidated.sql', 3,
    (to_regclass('public.aura_runs') IS NOT NULL)::int
    + (to_regclass('public.ai_usage_daily') IS NOT NULL)::int
    + (EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agent_conversations'
          AND column_name = 'owner_admin_id'
      ))::int
  UNION ALL
  SELECT 2, '002_page_views_tenant_v2.sql', 5,
    (SELECT COUNT(*)::int
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'page_views'
       AND column_name IN (
         'owner_admin_id', 'authenticated_user_id', 'occurred_at',
         'path', 'tenant_resolution_status'
       ))
  UNION ALL
  SELECT 3, '003_aura_campaigns_v2.sql', 7,
    (SELECT COUNT(*)::int
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname IN (
         'marketing_segments', 'marketing_campaigns', 'campaign_contents',
         'customer_consents', 'campaign_recipients', 'campaign_events',
         'campaign_attributions'
       ))
  UNION ALL
  SELECT 4, '004_aura_image_jobs.sql', 2,
    (to_regclass('public.ai_jobs') IS NOT NULL)::int
    + (to_regclass('public.campaign_assets') IS NOT NULL)::int
  UNION ALL
  SELECT 5, '005_aura_actions_outbox_v2.sql', 2,
    (to_regclass('public.aura_actions') IS NOT NULL)::int
    + (to_regclass('public.idx_notification_queue_claim') IS NOT NULL)::int
  UNION ALL
  SELECT 6, '006_predictive_features.sql', 6,
    (SELECT COUNT(*)::int
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname IN (
         'model_versions', 'prediction_runs', 'prediction_results',
         'daily_product_features', 'daily_variant_features', 'daily_store_features'
       ))
  UNION ALL
  SELECT 7, '007_predictive_forecasting.sql', 2,
    (to_regclass('public.idx_prediction_results_latest_demand') IS NOT NULL)::int
    + (to_regclass('public.idx_ai_jobs_recalculate_dedupe_active') IS NOT NULL)::int
  UNION ALL
  SELECT 8, '008_aura_customer_growth.sql', 2,
    (to_regclass('public.aura_customer_segment_runs') IS NOT NULL)::int
    + (to_regclass('public.aura_customer_segment_snapshots') IS NOT NULL)::int
  UNION ALL
  SELECT 9, '009_aura_send_time_optimization.sql', 2,
    (to_regclass('public.aura_send_time_metric_runs') IS NOT NULL)::int
    + (to_regclass('public.aura_send_time_metric_snapshots') IS NOT NULL)::int
  UNION ALL
  SELECT 10, '010_aura_voice_mvp.sql', 2,
    (to_regclass('public.aura_voice_sessions') IS NOT NULL)::int
    + (to_regclass('public.aura_voice_turns') IS NOT NULL)::int
)
SELECT
  '04a_aura_migration_state' AS section,
  current_state.sequence_no,
  current_state.migration_name,
  current_state.found_objects,
  current_state.expected_objects,
  CASE
    WHEN current_state.found_objects > 0
      AND current_state.found_objects < current_state.expected_objects
      THEN 'BLOCKER_PARTIAL'
    WHEN current_state.found_objects = current_state.expected_objects
      AND EXISTS (
        SELECT 1
        FROM migration_state previous_state
        WHERE previous_state.sequence_no < current_state.sequence_no
          AND previous_state.found_objects <> previous_state.expected_objects
      ) THEN 'BLOCKER_OUT_OF_ORDER'
    WHEN current_state.found_objects = 0
      AND EXISTS (
        SELECT 1
        FROM migration_state later_state
        WHERE later_state.sequence_no > current_state.sequence_no
          AND later_state.found_objects > 0
      ) THEN 'BLOCKER_GAP'
    WHEN current_state.found_objects = current_state.expected_objects
      THEN 'APPLIED_VALID_PREFIX'
    ELSE 'NOT_APPLIED'
  END AS migration_state
FROM migration_state current_state
ORDER BY current_state.sequence_no;

SELECT
  '05_agent_conversation_quality' AS section,
  COUNT(*) AS total_conversations,
  COUNT(*) FILTER (WHERE ac.user_id IS NULL) AS null_user_ids,
  COUNT(*) FILTER (WHERE ac.user_id IS NOT NULL AND u.id IS NULL) AS orphan_user_ids,
  COUNT(*) FILTER (WHERE u.id IS NOT NULL AND COALESCE(u.owner_admin_id, u.id) IS NULL) AS unresolved_tenants,
  COUNT(*) FILTER (
    WHERE to_jsonb(ac) ? 'owner_admin_id'
      AND (to_jsonb(ac)->>'owner_admin_id') IS NOT NULL
      AND (to_jsonb(ac)->>'owner_admin_id')::int IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
  ) AS tenant_mismatches
FROM public.agent_conversations ac
LEFT JOIN public.users u ON u.id = ac.user_id;

SELECT
  '06_agent_conversation_problem_rows' AS section,
  to_jsonb(ac)->>'id' AS conversation_id,
  ac.user_id,
  to_jsonb(ac)->>'owner_admin_id' AS current_owner_admin_id,
  COALESCE(u.owner_admin_id, u.id) AS expected_owner_admin_id,
  CASE
    WHEN ac.user_id IS NULL THEN 'NULL_USER_ID'
    WHEN u.id IS NULL THEN 'ORPHAN_USER'
    WHEN COALESCE(u.owner_admin_id, u.id) IS NULL THEN 'UNRESOLVED_TENANT'
    WHEN to_jsonb(ac) ? 'owner_admin_id'
      AND (to_jsonb(ac)->>'owner_admin_id') IS NOT NULL
      AND (to_jsonb(ac)->>'owner_admin_id')::int IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
      THEN 'TENANT_MISMATCH'
  END AS issue
FROM public.agent_conversations ac
LEFT JOIN public.users u ON u.id = ac.user_id
WHERE ac.user_id IS NULL
   OR u.id IS NULL
   OR COALESCE(u.owner_admin_id, u.id) IS NULL
   OR (
     to_jsonb(ac) ? 'owner_admin_id'
     AND (to_jsonb(ac)->>'owner_admin_id') IS NOT NULL
     AND (to_jsonb(ac)->>'owner_admin_id')::int IS DISTINCT FROM COALESCE(u.owner_admin_id, u.id)
   )
ORDER BY conversation_id
LIMIT 100;

SELECT
  '07_notification_queue_legacy_values' AS section,
  channel::text AS channel,
  event::text AS event,
  status::text AS status,
  COUNT(*) AS rows_count
FROM public.notification_queue
GROUP BY channel::text, event::text, status::text
ORDER BY rows_count DESC, channel, event, status;

-- AURA_NOTIFICATION_FINGERPRINT_BEGIN
WITH notification_snapshot_rows AS (
  SELECT nq.id, nq.status::text AS status_text, to_jsonb(nq) AS row_data
  FROM public.notification_queue nq
), notification_row_fingerprints AS (
  SELECT
    id,
    status_text,
    row_data,
    MD5(JSONB_BUILD_ARRAY(
      row_data->'id', row_data->'owner_admin_id', row_data->'recipient_user_id',
      row_data->'recipient_phone', row_data->'recipient_email', row_data->'channel',
      row_data->'event', row_data->'status', row_data->'attempts',
      row_data->'max_attempts', row_data->'sent_at', row_data->'provider',
      row_data->'provider_message_id', row_data->'last_error',
      row_data->'rendered_subject', row_data->'rendered_message', row_data->'payload',
      row_data->'scheduled_for', row_data->'reference_type', row_data->'reference_id',
      row_data->'created_at'
    )::text) AS core_row_fingerprint,
    MD5(JSONB_BUILD_ARRAY(
      row_data->'id', row_data->'campaign_id', row_data->'recipient',
      row_data->'dedupe_key', row_data->'available_at', row_data->'locked_at',
      row_data->'locked_by', row_data->'delivered_at', row_data->'read_at',
      row_data->'clicked_at', row_data->'failed_at', row_data->'error',
      row_data->'reference_key', row_data->'updated_at'
    )::text) AS extended_row_fingerprint
  FROM notification_snapshot_rows
)
SELECT
  '07a_notification_queue_terminal_snapshot' AS section,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE status_text = 'sent') AS sent_rows,
  COUNT(*) FILTER (WHERE status_text = 'failed') AS failed_rows,
  COUNT(*) FILTER (WHERE status_text = 'pending') AS pending_rows,
  SUM(COALESCE((row_data->>'attempts')::int, 0)) AS attempts_total,
  COUNT(*) FILTER (WHERE NULLIF(row_data->>'sent_at', '') IS NOT NULL) AS rows_with_sent_at,
  COUNT(*) FILTER (
    WHERE NULLIF(row_data->>'provider_message_id', '') IS NOT NULL
  ) AS rows_with_provider_message_id,
  MD5(COALESCE(STRING_AGG(core_row_fingerprint, '' ORDER BY id), '')) AS core_fingerprint,
  MD5(COALESCE(STRING_AGG(extended_row_fingerprint, '' ORDER BY id), '')) AS extended_fingerprint
FROM notification_row_fingerprints;
-- AURA_NOTIFICATION_FINGERPRINT_END

SELECT
  '08_notification_queue_dedupe_conflicts' AS section,
  owner_admin_id,
  to_jsonb(notification_queue)->>'dedupe_key' AS dedupe_key,
  COUNT(*) AS duplicate_count
FROM public.notification_queue
WHERE to_jsonb(notification_queue)->>'dedupe_key' IS NOT NULL
GROUP BY owner_admin_id, to_jsonb(notification_queue)->>'dedupe_key'
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, owner_admin_id
LIMIT 100;

SELECT
  '09_page_views_quality' AS section,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE to_jsonb(page_views)->>'owner_admin_id' IS NULL) AS ambiguous_without_tenant,
  COUNT(*) FILTER (WHERE to_jsonb(page_views)->>'occurred_at' IS NULL) AS null_occurred_at,
  COUNT(*) FILTER (WHERE COALESCE(to_jsonb(page_views)->>'path', '') = '') AS null_path,
  COUNT(*) FILTER (WHERE COALESCE(to_jsonb(page_views)->>'session_id', '') = '') AS null_session_id,
  COUNT(*) FILTER (
    WHERE to_jsonb(page_views)->>'tenant_resolution_status' = 'trusted'
      AND to_jsonb(page_views)->>'authenticated_user_id' IS NOT NULL
  ) AS trusted_authenticated_rows
FROM public.page_views;

SELECT
  '10_campaign_partial_tables' AS section,
  rel.relname AS table_name,
  rel.reltuples::bigint AS approximate_rows
FROM pg_class rel
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname LIKE 'campaign_%'
ORDER BY rel.relname;

SELECT
  '11_fk_summary' AS section,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  ref.relname AS referenced_table,
  con.convalidated,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
JOIN pg_class ref ON ref.oid = con.confrelid
WHERE n.nspname = 'public'
  AND con.contype = 'f'
  AND rel.relname IN (
    'agent_conversations',
    'notification_queue',
    'page_views',
    'marketing_campaigns',
    'campaign_recipients',
    'campaign_events',
    'campaign_attributions'
  )
ORDER BY rel.relname, con.conname;

SELECT
  '12_index_summary' AS section,
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'agent_conversations',
    'notification_queue',
    'page_views',
    'aura_runs',
    'ai_usage_daily',
    'ai_jobs',
    'prediction_results'
  )
ORDER BY tablename, indexname;

SELECT
  '13_historical_migration_checks' AS section,
  'expenses.purchase_order_id' AS object_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'purchase_order_id'
  ) AS exists_or_matches
UNION ALL
SELECT
  '13_historical_migration_checks',
  'sales.discount_id',
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'discount_id'
  )
UNION ALL
SELECT
  '13_historical_migration_checks',
  'discount_coupons.scope',
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'discount_coupons' AND column_name = 'scope'
  )
UNION ALL
SELECT
  '13_historical_migration_checks',
  'products.fulfillment_mode default hybrid',
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'fulfillment_mode'
      AND column_default ILIKE '%hybrid%'
  );

COMMIT;
