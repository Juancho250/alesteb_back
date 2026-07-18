-- =============================================================================
-- AURA 2070 consolidated migrations postflight
--
-- Read-only. Run after all migrations/aura files on a Neon branch or staging DB.
-- =============================================================================

BEGIN READ ONLY;

SELECT
  '00_context' AS section,
  current_database() AS database_name,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS transaction_read_only;

WITH expected(table_name) AS (
  VALUES
    ('agent_conversations'),
    ('aura_runs'),
    ('ai_usage_daily'),
    ('page_views'),
    ('marketing_segments'),
    ('marketing_campaigns'),
    ('campaign_contents'),
    ('customer_consents'),
    ('campaign_recipients'),
    ('campaign_events'),
    ('campaign_attributions'),
    ('ai_jobs'),
    ('campaign_assets'),
    ('aura_actions'),
    ('notification_queue'),
    ('model_versions'),
    ('prediction_runs'),
    ('daily_product_features'),
    ('daily_variant_features'),
    ('daily_store_features'),
    ('prediction_results'),
    ('aura_customer_segment_runs'),
    ('aura_customer_segment_snapshots'),
    ('aura_send_time_metric_runs'),
    ('aura_send_time_metric_snapshots'),
    ('aura_voice_sessions'),
    ('aura_voice_turns')
)
SELECT
  '01_expected_tables' AS section,
  e.table_name,
  c.oid IS NOT NULL AS exists_in_public,
  c.reltuples::bigint AS approximate_rows
FROM expected e
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = e.table_name
ORDER BY e.table_name;

WITH expected(table_name, column_name) AS (
  VALUES
    ('agent_conversations', 'owner_admin_id'),
    ('aura_runs', 'request_id'),
    ('aura_runs', 'redacted_input'),
    ('aura_runs', 'structured_output'),
    ('aura_runs', 'tools_used'),
    ('aura_runs', 'estimated_cost'),
    ('aura_runs', 'estimated_cost_usd'),
    ('aura_runs', 'completed_at'),
    ('aura_runs', 'finished_at'),
    ('aura_runs', 'error_message_redacted'),
    ('ai_usage_daily', 'requests'),
    ('ai_usage_daily', 'requests_count'),
    ('ai_usage_daily', 'errors'),
    ('page_views', 'owner_admin_id'),
    ('page_views', 'tenant_resolution_status'),
    ('page_views', 'authenticated_user_id'),
    ('page_views', 'occurred_at'),
    ('notification_queue', 'campaign_id'),
    ('notification_queue', 'dedupe_key'),
    ('notification_queue', 'available_at'),
    ('notification_queue', 'locked_at'),
    ('notification_queue', 'provider_message_id'),
    ('notification_queue', 'reference_key'),
    ('aura_voice_turns', 'audio_retention')
)
SELECT
  '02_expected_columns' AS section,
  e.table_name,
  e.column_name,
  c.data_type,
  c.udt_name,
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
  '03_constraints' AS section,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  con.convalidated,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname IN (
    'agent_conversations',
    'aura_runs',
    'ai_usage_daily',
    'page_views',
    'marketing_campaigns',
    'campaign_recipients',
    'campaign_events',
    'campaign_attributions',
    'notification_queue',
    'ai_jobs',
    'prediction_runs',
    'prediction_results',
    'aura_voice_sessions',
    'aura_voice_turns'
  )
ORDER BY rel.relname, con.conname;

SELECT
  '04_indexes' AS section,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    tablename LIKE 'aura_%'
    OR tablename LIKE 'campaign_%'
    OR tablename IN (
      'agent_conversations',
      'aura_runs',
      'ai_usage_daily',
      'page_views',
      'notification_queue',
      'ai_jobs',
      'prediction_runs',
      'prediction_results',
      'daily_product_features',
      'daily_variant_features',
      'daily_store_features'
    )
  )
ORDER BY tablename, indexname;

WITH claim_index AS (
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'notification_queue'
    AND indexname = 'idx_notification_queue_claim'
)
SELECT
  '04a_notification_queue_claim_index' AS section,
  expected.index_name,
  claim_index.indexdef,
  claim_index.indexname IS NOT NULL AS index_exists,
  POSITION(
    'available_at, scheduled_for, created_at, id'
    IN LOWER(COALESCE(claim_index.indexdef, ''))
  ) > 0 AS expected_columns,
  POSITION(
    'status = ''pending''::notification_status_type'
    IN LOWER(COALESCE(claim_index.indexdef, ''))
  ) > 0 AS constant_pending_predicate,
  COALESCE(claim_index.indexdef, '') !~* 'status[)]?[[:space:]]*::[[:space:]]*text'
    AS no_enum_text_cast,
  COALESCE(claim_index.indexdef, '') !~* '(now[[:space:]]*\(|current_timestamp|current_date|clock_timestamp[[:space:]]*\(|statement_timestamp[[:space:]]*\(|transaction_timestamp[[:space:]]*\(|date_trunc[[:space:]]*\(|timezone[[:space:]]*\(|at[[:space:]]+time[[:space:]]+zone)'
    AS no_temporal_functions
FROM (VALUES ('idx_notification_queue_claim')) AS expected(index_name)
LEFT JOIN claim_index ON claim_index.indexname = expected.index_name;

SELECT
  '04b_invalid_notification_claim_indexes' AS section,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'notification_queue'
  AND indexname <> 'idx_notification_queue_claim'
  AND indexdef ILIKE '%status%'
  AND (indexdef ILIKE '%available_at%' OR indexdef ILIKE '%scheduled_for%')
  AND (
    indexdef ~* 'status[)]?[[:space:]]*::[[:space:]]*text'
    OR indexdef ~* '(now[[:space:]]*\(|current_timestamp|current_date|clock_timestamp[[:space:]]*\(|statement_timestamp[[:space:]]*\(|transaction_timestamp[[:space:]]*\(|date_trunc[[:space:]]*\(|timezone[[:space:]]*\(|at[[:space:]]+time[[:space:]]+zone)'
  )
ORDER BY indexname;

SELECT
  '05_triggers' AS section,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  p.proname AS function_name,
  pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND (
    c.relname LIKE 'aura_%'
    OR c.relname LIKE 'campaign_%'
    OR c.relname IN ('marketing_campaigns', 'customer_consents', 'notification_queue', 'ai_jobs')
  )
ORDER BY c.relname, t.tgname;

SELECT
  '06_functions' AS section,
  p.proname AS function_name,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS result_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
    p.proname LIKE 'aura_%'
    OR p.proname LIKE 'validate_campaign%'
    OR p.proname = 'anonymize_old_page_views'
  )
ORDER BY p.proname;

SELECT
  '07_conversation_tenant_status' AS section,
  COUNT(*) AS total_conversations,
  COUNT(*) FILTER (WHERE owner_admin_id IS NULL) AS without_owner_admin_id
FROM public.agent_conversations;

SELECT
  '08_notification_queue_status' AS section,
  status::text AS status,
  COUNT(*) AS rows_count
FROM public.notification_queue
GROUP BY status::text
ORDER BY status::text;

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
  '08a_notification_queue_terminal_snapshot' AS section,
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
  '09_notification_queue_dedupe_conflicts' AS section,
  owner_admin_id,
  dedupe_key,
  COUNT(*) AS duplicate_count
FROM public.notification_queue
WHERE dedupe_key IS NOT NULL
GROUP BY owner_admin_id, dedupe_key
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC
LIMIT 100;

SELECT
  '09a_notification_queue_active_dedupe_conflicts' AS section,
  owner_admin_id,
  dedupe_key,
  COUNT(*) AS duplicate_count
FROM public.notification_queue
WHERE dedupe_key IS NOT NULL
  AND status IN ('pending', 'queued', 'sending')
GROUP BY owner_admin_id, dedupe_key
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC
LIMIT 100;

SELECT
  '10_page_views_resolution' AS section,
  tenant_resolution_status,
  COUNT(*) AS rows_count,
  COUNT(*) FILTER (WHERE authenticated_user_id IS NOT NULL) AS authenticated_rows
FROM public.page_views
GROUP BY tenant_resolution_status
ORDER BY tenant_resolution_status;

SELECT
  '11_campaign_events_constraint_values' AS section,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
WHERE con.conrelid = 'public.campaign_events'::regclass
  AND con.conname = 'campaign_events_type_check';

SELECT
  '12_dependency_order_check' AS section,
  'ok_if_all_rows_true' AS note,
  to_regclass('public.aura_runs') IS NOT NULL AS core_ok,
  to_regclass('public.marketing_campaigns') IS NOT NULL AS campaigns_ok,
  to_regclass('public.ai_jobs') IS NOT NULL AS ai_jobs_ok,
  to_regclass('public.prediction_results') IS NOT NULL AS predictive_ok,
  to_regclass('public.aura_voice_sessions') IS NOT NULL AS voice_ok;

COMMIT;
