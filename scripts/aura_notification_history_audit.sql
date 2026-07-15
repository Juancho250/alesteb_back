-- =============================================================================
-- AURA notification_queue history audit
--
-- Read-only. Produces aggregate counts and fingerprints without exposing PII.
-- Run after setting NEON_AURA_BRANCH_URL to the direct staging branch URL.
-- =============================================================================

BEGIN READ ONLY;

SELECT
  '00_context' AS section,
  current_database() AS database_name,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS transaction_read_only,
  NOW() AS audited_at;

SELECT
  '01_status_counts' AS section,
  status::text AS status,
  COUNT(*) AS rows_count
FROM public.notification_queue
GROUP BY status::text
ORDER BY status::text;

SELECT
  '02_historical_aggregates' AS section,
  COUNT(*) AS total_rows,
  SUM(COALESCE((to_jsonb(nq)->>'attempts')::int, 0)) AS attempts_total,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'sent_at', '') IS NOT NULL) AS rows_with_sent_at,
  COUNT(*) FILTER (
    WHERE NULLIF(to_jsonb(nq)->>'provider_message_id', '') IS NOT NULL
  ) AS rows_with_provider_message_id,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'last_error', '') IS NOT NULL) AS rows_with_last_error
FROM public.notification_queue nq;

SELECT
  '03_channel_event_counts' AS section,
  channel::text AS channel,
  event::text AS event,
  COUNT(*) AS rows_count
FROM public.notification_queue
GROUP BY channel::text, event::text
ORDER BY channel::text, event::text;

SELECT
  '04_outbox_extension_counts' AS section,
  COUNT(*) FILTER (
    WHERE nq.available_at IS DISTINCT FROM nq.scheduled_for
  ) AS available_at_differs_from_scheduled_for,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'dedupe_key', '') IS NOT NULL) AS rows_with_dedupe_key,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'reference_key', '') IS NOT NULL) AS rows_with_reference_key,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'campaign_id', '') IS NOT NULL) AS rows_with_campaign_id,
  COUNT(*) FILTER (WHERE NULLIF(to_jsonb(nq)->>'locked_at', '') IS NOT NULL) AS rows_with_locked_at
FROM public.notification_queue nq;

WITH notification_snapshot_rows AS (
  SELECT
    nq.id,
    nq.status::text AS status_text,
    nq.attempts::text AS attempts_cast_text,
    nq.sent_at::text AS sent_at_cast_text,
    nq.provider_message_id AS provider_message_id_text,
    to_jsonb(nq) AS row_data
  FROM public.notification_queue nq
), notification_row_fingerprints AS (
  SELECT
    id,
    status_text,
    attempts_cast_text,
    sent_at_cast_text,
    provider_message_id_text,
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
  '05_history_fingerprints' AS section,
  MD5(COALESCE(STRING_AGG(core_row_fingerprint, '' ORDER BY id), '')) AS core_fingerprint,
  MD5(COALESCE(STRING_AGG(extended_row_fingerprint, '' ORDER BY id), '')) AS extended_fingerprint,
  MD5(COALESCE(
    STRING_AGG(
      CONCAT_WS('|',
        id::text,
        status_text,
        COALESCE(row_data->>'attempts', ''),
        COALESCE(row_data->>'sent_at', ''),
        COALESCE(row_data->>'provider_message_id', '')
      ),
      '||' ORDER BY id
    ) FILTER (WHERE status_text IN ('sent', 'failed')),
    ''
  )) AS legacy_preflight_fingerprint,
  MD5(COALESCE(
    STRING_AGG(
      CONCAT_WS('|',
        id::text,
        status_text,
        attempts_cast_text,
        COALESCE(sent_at_cast_text, ''),
        COALESCE(provider_message_id_text, '')
      ),
      '||' ORDER BY id
    ) FILTER (WHERE status_text IN ('sent', 'failed')),
    ''
  )) AS legacy_postflight_fingerprint
FROM notification_row_fingerprints;

WITH queue_rows AS (
  SELECT
    nq.id,
    nq.owner_admin_id,
    nq.recipient_user_id,
    nq.campaign_id,
    nq.dedupe_key,
    nq.status::text AS status_text,
    nq.attempts,
    nq.max_attempts,
    nq.available_at,
    nq.scheduled_for,
    nq.sent_at,
    nq.provider_message_id,
    nq.rendered_message,
    nq.last_error
  FROM public.notification_queue nq
), claim_candidates AS (
  SELECT id
  FROM public.notification_queue
  WHERE status = 'pending'
    AND available_at <= NOW()
    AND scheduled_for <= NOW()
    AND attempts < max_attempts
), duplicate_dedupe AS (
  SELECT owner_admin_id, dedupe_key
  FROM public.notification_queue
  WHERE dedupe_key IS NOT NULL
  GROUP BY owner_admin_id, dedupe_key
  HAVING COUNT(*) > 1
), duplicate_provider_message AS (
  SELECT provider_message_id
  FROM public.notification_queue
  WHERE NULLIF(provider_message_id, '') IS NOT NULL
  GROUP BY provider_message_id
  HAVING COUNT(*) > 1
), metrics AS (
  SELECT
    COUNT(*) FILTER (
      WHERE qr.status_text = 'sent'
        AND qr.attempts = 0
    ) AS sent_with_zero_attempts,
    COUNT(*) FILTER (
      WHERE qr.status_text = 'failed'
        AND qr.attempts = 0
    ) AS failed_with_zero_attempts,
    COUNT(*) FILTER (
      WHERE qr.status_text = 'failed'
        AND qr.attempts = 0
        AND qr.sent_at IS NULL
        AND NULLIF(qr.provider_message_id, '') IS NULL
        AND (
          qr.rendered_message = 'NO_TEMPLATE'
          OR qr.last_error LIKE 'Template no encontrado%'
        )
    ) AS failed_before_provider_attempt,
    COUNT(*) FILTER (
      WHERE qr.status_text IN ('sent', 'failed')
        AND claim_candidates.id IS NOT NULL
    ) AS terminal_rows_claimable,
    COUNT(*) FILTER (
      WHERE qr.status_text = 'sent'
        AND (qr.sent_at IS NULL OR NULLIF(qr.provider_message_id, '') IS NULL)
    ) AS sent_without_provider_evidence,
    COUNT(*) FILTER (WHERE qr.attempts < 0) AS rows_with_negative_attempts,
    COUNT(*) FILTER (WHERE qr.attempts > qr.max_attempts) AS rows_over_max_attempts,
    COUNT(*) FILTER (
      WHERE qr.status_text IN ('sent', 'failed')
        AND (qr.available_at IS NULL OR qr.scheduled_for IS NULL)
    ) AS terminal_rows_without_schedule,
    COUNT(*) FILTER (
      WHERE qr.status_text IN ('sent', 'failed')
        AND duplicate_dedupe.dedupe_key IS NOT NULL
    ) AS terminal_rows_with_duplicate_dedupe_key,
    (SELECT COUNT(*) FROM duplicate_provider_message) AS duplicate_provider_message_id_groups,
    COUNT(*) FILTER (
      WHERE owner_user.id IS NULL
    ) AS rows_with_invalid_owner_admin_id,
    COUNT(*) FILTER (
      WHERE recipient_user.id IS NOT NULL
        AND COALESCE(recipient_user.owner_admin_id, recipient_user.id) <> qr.owner_admin_id
    ) AS recipient_tenant_mismatches,
    COUNT(*) FILTER (
      WHERE qr.campaign_id IS NOT NULL
        AND (
          campaign.id IS NULL
          OR campaign.owner_admin_id <> qr.owner_admin_id
        )
    ) AS campaign_tenant_mismatches
  FROM queue_rows qr
  LEFT JOIN claim_candidates ON claim_candidates.id = qr.id
  LEFT JOIN duplicate_dedupe
    ON duplicate_dedupe.owner_admin_id = qr.owner_admin_id
   AND duplicate_dedupe.dedupe_key = qr.dedupe_key
  LEFT JOIN public.users owner_user ON owner_user.id = qr.owner_admin_id
  LEFT JOIN public.users recipient_user ON recipient_user.id = qr.recipient_user_id
  LEFT JOIN public.marketing_campaigns campaign ON campaign.id = qr.campaign_id
), raw_checks AS (
  SELECT 'sent_with_zero_attempts' AS check_name,
         sent_with_zero_attempts AS rows_count,
         'WARNING_LEGACY' AS finding_classification
  FROM metrics
  UNION ALL
  SELECT 'failed_with_zero_attempts', failed_with_zero_attempts, 'WARNING_LEGACY'
  FROM metrics
  UNION ALL
  SELECT 'failed_before_provider_attempt', failed_before_provider_attempt, 'WARNING_LEGACY'
  FROM metrics
  UNION ALL
  SELECT 'terminal_rows_claimable', terminal_rows_claimable, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'sent_without_provider_evidence', sent_without_provider_evidence, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'rows_with_negative_attempts', rows_with_negative_attempts, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'rows_over_max_attempts', rows_over_max_attempts, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'terminal_rows_without_schedule', terminal_rows_without_schedule, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'terminal_rows_with_duplicate_dedupe_key', terminal_rows_with_duplicate_dedupe_key, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'duplicate_provider_message_id_groups', duplicate_provider_message_id_groups, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'rows_with_invalid_owner_admin_id', rows_with_invalid_owner_admin_id, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'recipient_tenant_mismatches', recipient_tenant_mismatches, 'BLOCKER'
  FROM metrics
  UNION ALL
  SELECT 'campaign_tenant_mismatches', campaign_tenant_mismatches, 'BLOCKER'
  FROM metrics
)
SELECT
  '06_terminal_checks' AS section,
  check_name,
  rows_count,
  CASE
    WHEN rows_count = 0 THEN 'PASS'
    ELSE finding_classification
  END AS classification
FROM raw_checks
ORDER BY check_name;

WITH duplicate_dedupe AS (
  SELECT owner_admin_id, dedupe_key, COUNT(*) AS rows_count
  FROM public.notification_queue
  WHERE dedupe_key IS NOT NULL
  GROUP BY owner_admin_id, dedupe_key
  HAVING COUNT(*) > 1
)
SELECT
  '07_dedupe_summary' AS section,
  COUNT(*) AS duplicate_groups,
  COALESCE(SUM(rows_count), 0) AS rows_in_duplicate_groups
FROM duplicate_dedupe;

COMMIT;
