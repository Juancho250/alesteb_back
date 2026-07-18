-- =============================================================================
-- AURA secure MVP - pre-migration schema inspection (read-only)
--
-- Run before migrations/2026_07_12_aura_secure_mvp.sql:
--   psql "$NEON_DB_URL" -X -v ON_ERROR_STOP=1 \
--     -f scripts/inspect-aura-schema.sql
--
-- This file contains SELECT statements only. It does not create or alter objects.
-- Review every result, especially the final data-quality checks, before migration.
-- =============================================================================

-- 1. PostgreSQL context. Useful when reviewing supported DDL and active schema.
SELECT
  current_database() AS database_name,
  current_schema() AS active_schema,
  current_setting('server_version') AS server_version;

-- 2. Confirm that every source/target table exists and identify its kind.
WITH expected(table_name) AS (
  VALUES
    ('agent_conversations'),
    ('users'),
    ('subscriptions'),
    ('subscription_plans'),
    ('subscription_usage'),
    ('aura_runs'),
    ('ai_usage_daily')
)
SELECT
  e.table_name,
  c.oid IS NOT NULL AS exists_in_public,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
    WHEN 'f' THEN 'foreign table'
    ELSE NULL
  END AS relation_kind
FROM expected e
LEFT JOIN pg_catalog.pg_namespace n
  ON n.nspname = 'public'
LEFT JOIN pg_catalog.pg_class c
  ON c.relnamespace = n.oid
 AND c.relname = e.table_name
ORDER BY e.table_name;

-- 3. Exact columns, PostgreSQL types, defaults and nullability.
SELECT
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.is_identity,
  c.identity_generation,
  c.is_generated,
  c.generation_expression,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  c.datetime_precision
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN (
    'agent_conversations',
    'users',
    'subscriptions',
    'subscription_plans',
    'subscription_usage',
    'aura_runs',
    'ai_usage_daily'
  )
ORDER BY c.table_name, c.ordinal_position;

-- 4. Primary keys, unique/check constraints and foreign-key actions/validation.
SELECT
  n.nspname AS schema_name,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  CASE con.contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'c' THEN 'CHECK'
    WHEN 'x' THEN 'EXCLUDE'
    ELSE con.contype::text
  END AS constraint_type,
  con.convalidated AS is_validated,
  pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rel
  ON rel.oid = con.conrelid
JOIN pg_catalog.pg_namespace n
  ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname IN (
    'agent_conversations',
    'users',
    'subscriptions',
    'subscription_plans',
    'subscription_usage',
    'aura_runs',
    'ai_usage_daily'
  )
ORDER BY rel.relname, constraint_type, con.conname;

-- 5. All indexes, including uniqueness, partial predicates and index method.
SELECT
  n.nspname AS schema_name,
  tbl.relname AS table_name,
  idx.relname AS index_name,
  am.amname AS index_method,
  i.indisprimary AS is_primary,
  i.indisunique AS is_unique,
  i.indisvalid AS is_valid,
  pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
  pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class tbl
  ON tbl.oid = i.indrelid
JOIN pg_catalog.pg_class idx
  ON idx.oid = i.indexrelid
JOIN pg_catalog.pg_namespace n
  ON n.oid = tbl.relnamespace
JOIN pg_catalog.pg_am am
  ON am.oid = idx.relam
WHERE n.nspname = 'public'
  AND tbl.relname IN (
    'agent_conversations',
    'users',
    'subscriptions',
    'subscription_plans',
    'subscription_usage',
    'aura_runs',
    'ai_usage_daily'
  )
ORDER BY tbl.relname, idx.relname;

-- 6. User/tenant type compatibility required by the migration.
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (
    (c.table_name = 'users' AND c.column_name IN ('id', 'owner_admin_id'))
    OR
    (c.table_name = 'agent_conversations'
      AND c.column_name IN ('id', 'user_id', 'owner_admin_id'))
    OR
    (c.table_name IN ('subscriptions', 'subscription_usage')
      AND c.column_name = 'admin_id')
  )
ORDER BY c.table_name, c.ordinal_position;

-- 7. Feature/status columns used by the AURA subscription guard.
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (
    (c.table_name = 'subscription_plans' AND c.column_name = 'has_ai_agent')
    OR
    (c.table_name = 'subscriptions'
      AND c.column_name IN ('admin_id', 'plan_id', 'status'))
    OR
    (c.table_name = 'subscription_usage' AND c.column_name = 'admin_id')
  )
ORDER BY c.table_name, c.ordinal_position;

-- 8. agent_conversations backfill readiness.
-- to_jsonb is intentional: this query also works before owner_admin_id exists.
-- A non-zero unresolved_users or conflicting_existing_tenants blocks migration.
SELECT
  COUNT(*) AS total_conversations,
  COUNT(*) FILTER (
    WHERE to_jsonb(ac) ->> 'user_id' IS NULL
  ) AS null_user_ids,
  COUNT(*) FILTER (
    WHERE to_jsonb(ac) ->> 'user_id' IS NOT NULL
      AND u.id IS NULL
  ) AS unresolved_users,
  COUNT(*) FILTER (
    WHERE u.id IS NOT NULL
      AND COALESCE(to_jsonb(u) ->> 'owner_admin_id', to_jsonb(u) ->> 'id') IS NULL
  ) AS unresolved_tenants,
  COUNT(*) FILTER (
    WHERE to_jsonb(ac) ->> 'owner_admin_id' IS NULL
      AND u.id IS NOT NULL
  ) AS rows_to_backfill,
  COUNT(*) FILTER (
    WHERE to_jsonb(ac) ->> 'owner_admin_id' IS NOT NULL
      AND to_jsonb(ac) ->> 'owner_admin_id'
          IS DISTINCT FROM COALESCE(
            to_jsonb(u) ->> 'owner_admin_id',
            to_jsonb(u) ->> 'id'
          )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.name = 'superadmin'
      )
  ) AS conflicting_existing_tenants
FROM public.agent_conversations ac
LEFT JOIN public.users u
  ON to_jsonb(u) ->> 'id' = to_jsonb(ac) ->> 'user_id';

-- 9. Show only problematic conversation identifiers; no messages or PII.
SELECT
  to_jsonb(ac) ->> 'id' AS conversation_id,
  to_jsonb(ac) ->> 'user_id' AS user_id,
  to_jsonb(ac) ->> 'owner_admin_id' AS current_owner_admin_id,
  COALESCE(
    to_jsonb(u) ->> 'owner_admin_id',
    to_jsonb(u) ->> 'id'
  ) AS expected_owner_admin_id,
  CASE
    WHEN to_jsonb(ac) ->> 'user_id' IS NULL THEN 'NULL_USER_ID'
    WHEN u.id IS NULL THEN 'USER_NOT_FOUND'
    WHEN COALESCE(to_jsonb(u) ->> 'owner_admin_id', to_jsonb(u) ->> 'id') IS NULL
      THEN 'TENANT_NOT_RESOLVED'
    WHEN to_jsonb(ac) ->> 'owner_admin_id' IS NOT NULL
      AND to_jsonb(ac) ->> 'owner_admin_id'
          IS DISTINCT FROM COALESCE(
            to_jsonb(u) ->> 'owner_admin_id',
            to_jsonb(u) ->> 'id'
          )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.name = 'superadmin'
      )
      THEN 'TENANT_MISMATCH'
  END AS issue
FROM public.agent_conversations ac
LEFT JOIN public.users u
  ON to_jsonb(u) ->> 'id' = to_jsonb(ac) ->> 'user_id'
WHERE to_jsonb(ac) ->> 'user_id' IS NULL
   OR u.id IS NULL
   OR COALESCE(to_jsonb(u) ->> 'owner_admin_id', to_jsonb(u) ->> 'id') IS NULL
   OR (
     to_jsonb(ac) ->> 'owner_admin_id' IS NOT NULL
     AND to_jsonb(ac) ->> 'owner_admin_id'
         IS DISTINCT FROM COALESCE(
           to_jsonb(u) ->> 'owner_admin_id',
           to_jsonb(u) ->> 'id'
         )
     AND NOT EXISTS (
       SELECT 1
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = u.id AND r.name = 'superadmin'
     )
   )
ORDER BY conversation_id;

-- 10. Subscription uniqueness/referential checks used by plan and quota guards.
SELECT
  'subscriptions_duplicate_admin' AS check_name,
  COUNT(*) AS issue_count
FROM (
  SELECT admin_id
  FROM public.subscriptions
  GROUP BY admin_id
  HAVING COUNT(*) > 1
) duplicates
UNION ALL
SELECT
  'subscriptions_missing_admin_user',
  COUNT(*)
FROM public.subscriptions s
LEFT JOIN public.users u
  ON to_jsonb(u) ->> 'id' = to_jsonb(s) ->> 'admin_id'
WHERE u.id IS NULL
UNION ALL
SELECT
  'subscriptions_missing_plan',
  COUNT(*)
FROM public.subscriptions s
LEFT JOIN public.subscription_plans sp
  ON to_jsonb(sp) ->> 'id' = to_jsonb(s) ->> 'plan_id'
WHERE sp.id IS NULL
UNION ALL
SELECT
  'subscription_usage_duplicate_admin',
  COUNT(*)
FROM (
  SELECT admin_id
  FROM public.subscription_usage
  GROUP BY admin_id
  HAVING COUNT(*) > 1
) duplicates
UNION ALL
SELECT
  'subscription_usage_missing_admin_user',
  COUNT(*)
FROM public.subscription_usage su
LEFT JOIN public.users u
  ON to_jsonb(u) ->> 'id' = to_jsonb(su) ->> 'admin_id'
WHERE u.id IS NULL
ORDER BY check_name;
