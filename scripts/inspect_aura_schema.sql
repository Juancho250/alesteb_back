-- scripts/inspect_aura_schema.sql
-- Inventario read-only de esquema para AURA 2070.
-- No ejecuta DROP, ALTER, DELETE, UPDATE ni INSERT.
-- No lee filas de datos de negocio ni datos personales; solo metadata y conteos aproximados de catalogo.

BEGIN READ ONLY;

SELECT '00_read_only_guard' AS section, current_database() AS database_name, current_schema() AS current_schema;
SHOW transaction_read_only;

-- 01. Matriz de objetos esperados por AURA y dominios relacionados.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'),
    ('agent_conversations'),
    ('ai_usage_daily'),
    ('api_key_logs'),
    ('api_keys'),
    ('attribute_types'),
    ('attribute_values'),
    ('aura_runs'),
    ('banners'),
    ('categories'),
    ('contact_messages'),
    ('discount_coupons'),
    ('discount_targets'),
    ('discounts'),
    ('expenses'),
    ('invoices'),
    ('notification_queue'),
    ('notification_settings'),
    ('notification_templates'),
    ('page_views'),
    ('payment_accounts'),
    ('product_images'),
    ('product_provider_prices'),
    ('product_variants'),
    ('products'),
    ('providers'),
    ('proveedores'),
    ('purchase_order_items'),
    ('purchase_orders'),
    ('push_subscriptions'),
    ('reviews'),
    ('roles'),
    ('sale_items'),
    ('sales'),
    ('stock_ledger'),
    ('stock_reservations'),
    ('subscription_coupons'),
    ('subscription_invoices'),
    ('subscription_plans'),
    ('subscription_usage'),
    ('subscriptions'),
    ('user_roles'),
    ('users'),
    ('variant_attribute_values'),
    ('variant_images'),
    ('v_cashflow_detailed'),
    ('v_expenses_summary'),
    ('v_inventory_valuation'),
    ('v_invoices_summary'),
    ('v_products_full'),
    ('v_profit_analysis'),
    ('v_provider_balance'),
    ('v_sales_full'),
    ('v_stock_disponible')
)
SELECT
  '01_expected_object_matrix' AS section,
  e.object_name,
  COALESCE(n.nspname, 'missing') AS schema_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned_table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized_view'
    WHEN 'f' THEN 'foreign_table'
    ELSE 'missing'
  END AS object_type,
  c.oid IS NOT NULL AS exists_in_database,
  c.reltuples::bigint AS approximate_rows
FROM explicit_names e
LEFT JOIN pg_class c
  ON c.relname = e.object_name
LEFT JOIN pg_namespace n
  ON n.oid = c.relnamespace
 AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY e.object_name, schema_name;

-- 02. Relaciones relacionadas por nombre o lista explicita.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images'), ('v_cashflow_detailed'), ('v_expenses_summary'),
    ('v_inventory_valuation'), ('v_invoices_summary'), ('v_products_full'), ('v_profit_analysis'),
    ('v_provider_balance'), ('v_sales_full'), ('v_stock_disponible')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '02_related_relations' AS section,
  n.nspname AS schema_name,
  c.relname AS relation_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned_table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized_view'
    WHEN 'f' THEN 'foreign_table'
    ELSE c.relkind::text
  END AS relation_type,
  c.reltuples::bigint AS approximate_rows,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (
    c.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE c.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY relation_type, schema_name, relation_name;

-- 03. Columnas, tipos, defaults y nullability.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images'), ('v_cashflow_detailed'), ('v_expenses_summary'),
    ('v_inventory_valuation'), ('v_invoices_summary'), ('v_products_full'), ('v_profit_analysis'),
    ('v_provider_balance'), ('v_sales_full'), ('v_stock_disponible')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
),
target_relations AS (
  SELECT c.table_schema, c.table_name
  FROM information_schema.columns c
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
    AND (
      c.table_name IN (SELECT object_name FROM explicit_names)
      OR EXISTS (
        SELECT 1
        FROM patterns p
        WHERE c.table_name ILIKE '%' || p.pattern || '%'
      )
    )
  GROUP BY c.table_schema, c.table_name
)
SELECT
  '03_columns' AS section,
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  c.datetime_precision,
  c.is_nullable,
  c.column_default,
  c.is_identity,
  c.identity_generation,
  c.is_generated,
  c.generation_expression
FROM information_schema.columns c
JOIN target_relations tr
  ON tr.table_schema = c.table_schema
 AND tr.table_name = c.table_name
ORDER BY c.table_schema, c.table_name, c.ordinal_position;

-- 04. Columnas esperadas por AURA V1 y dominios criticos.
WITH expected_columns(table_name, column_name, purpose) AS (
  VALUES
    ('agent_conversations', 'id', 'aura persistence'),
    ('agent_conversations', 'owner_admin_id', 'tenant scope'),
    ('agent_conversations', 'user_id', 'conversation owner'),
    ('agent_conversations', 'messages', 'conversation history'),
    ('agent_conversations', 'preview', 'conversation list'),
    ('agent_conversations', 'updated_at', 'conversation ordering'),
    ('aura_runs', 'id', 'run id'),
    ('aura_runs', 'request_id', 'request trace'),
    ('aura_runs', 'owner_admin_id', 'tenant scope'),
    ('aura_runs', 'user_id', 'caller'),
    ('aura_runs', 'conversation_id', 'conversation link'),
    ('aura_runs', 'provider', 'ai provider'),
    ('aura_runs', 'model', 'ai model'),
    ('aura_runs', 'status', 'run status'),
    ('aura_runs', 'input_tokens', 'usage'),
    ('aura_runs', 'output_tokens', 'usage'),
    ('aura_runs', 'total_tokens', 'usage'),
    ('aura_runs', 'estimated_cost_usd', 'usage'),
    ('aura_runs', 'latency_ms', 'observability'),
    ('aura_runs', 'error_code', 'failure tracking'),
    ('aura_runs', 'error_message', 'failure tracking'),
    ('aura_runs', 'created_at', 'audit'),
    ('aura_runs', 'finished_at', 'idempotency'),
    ('ai_usage_daily', 'owner_admin_id', 'quota scope'),
    ('ai_usage_daily', 'usage_date', 'quota day'),
    ('ai_usage_daily', 'requests_count', 'quota count'),
    ('ai_usage_daily', 'input_tokens', 'usage'),
    ('ai_usage_daily', 'output_tokens', 'usage'),
    ('ai_usage_daily', 'total_tokens', 'usage'),
    ('ai_usage_daily', 'estimated_cost_usd', 'usage'),
    ('ai_usage_daily', 'updated_at', 'audit'),
    ('sales', 'id', 'sales context'),
    ('sales', 'owner_admin_id', 'tenant scope'),
    ('sales', 'sale_date', 'sales context'),
    ('sales', 'total', 'sales context'),
    ('sales', 'payment_status', 'paid sales filter'),
    ('sales', 'delivery_status', 'pending order filter'),
    ('sale_items', 'sale_id', 'top products'),
    ('sale_items', 'product_id', 'top products'),
    ('sale_items', 'quantity', 'top products'),
    ('sale_items', 'subtotal', 'top products'),
    ('products', 'id', 'product context'),
    ('products', 'owner_admin_id', 'tenant scope'),
    ('products', 'name', 'product context'),
    ('products', 'sku', 'product context'),
    ('products', 'stock', 'low stock'),
    ('products', 'min_stock', 'low stock'),
    ('products', 'is_active', 'catalog filter'),
    ('purchase_orders', 'id', 'supplier orders'),
    ('purchase_orders', 'owner_admin_id', 'tenant scope'),
    ('purchase_orders', 'provider_id', 'supplier orders'),
    ('purchase_orders', 'order_number', 'supplier orders'),
    ('purchase_orders', 'status', 'supplier orders'),
    ('purchase_orders', 'total_cost', 'supplier orders'),
    ('purchase_orders', 'expected_delivery_date', 'supplier orders'),
    ('purchase_orders', 'created_at', 'supplier orders'),
    ('providers', 'id', 'supplier orders'),
    ('providers', 'name', 'supplier orders'),
    ('users', 'id', 'customer count'),
    ('users', 'owner_admin_id', 'tenant scope'),
    ('users', 'created_at', 'recent customers'),
    ('users', 'is_active', 'active users'),
    ('roles', 'id', 'role lookup'),
    ('roles', 'name', 'role lookup'),
    ('user_roles', 'user_id', 'role lookup'),
    ('user_roles', 'role_id', 'role lookup')
)
SELECT
  '04_aura_expected_columns' AS section,
  ec.table_name,
  ec.column_name,
  ec.purpose,
  c.table_schema,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.column_name IS NOT NULL AS exists_in_database
FROM expected_columns ec
LEFT JOIN information_schema.columns c
  ON c.table_name = ec.table_name
 AND c.column_name = ec.column_name
 AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY ec.table_name, ec.column_name, c.table_schema;

-- 05. Primary keys.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '05_primary_keys' AS section,
  n.nspname AS schema_name,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE con.contype = 'p'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (
    rel.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE rel.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY n.nspname, rel.relname, con.conname;

-- 06. Foreign keys.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '06_foreign_keys' AS section,
  n.nspname AS schema_name,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  ref_n.nspname AS referenced_schema,
  ref_rel.relname AS referenced_table,
  pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
JOIN pg_class ref_rel ON ref_rel.oid = con.confrelid
JOIN pg_namespace ref_n ON ref_n.oid = ref_rel.relnamespace
WHERE con.contype = 'f'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (
    rel.relname IN (SELECT object_name FROM explicit_names)
    OR ref_rel.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE rel.relname ILIKE '%' || p.pattern || '%'
         OR ref_rel.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY n.nspname, rel.relname, con.conname;

-- 07. Indices.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '07_indexes' AS section,
  schemaname AS schema_name,
  tablename AS table_name,
  indexname AS index_name,
  indexdef AS index_definition
FROM pg_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND (
    tablename IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE tablename ILIKE '%' || p.pattern || '%'
         OR indexname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY schemaname, tablename, indexname;

-- 08. Constraints no FK/PK.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '08_constraints' AS section,
  n.nspname AS schema_name,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE con.contype NOT IN ('p', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (
    rel.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE rel.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY n.nspname, rel.relname, con.conname;

-- 09. Vistas y definiciones.
WITH explicit_names(object_name) AS (
  VALUES
    ('v_cashflow_detailed'), ('v_expenses_summary'), ('v_inventory_valuation'),
    ('v_invoices_summary'), ('v_products_full'), ('v_profit_analysis'),
    ('v_provider_balance'), ('v_sales_full'), ('v_stock_disponible')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('sale'), ('stock'), ('inventory'), ('product'), ('provider'),
    ('purchase'), ('expense'), ('invoice'), ('finance'), ('cashflow'), ('profit'),
    ('analytics'), ('subscription'), ('notification'), ('discount'), ('campaign')
)
SELECT
  '09_views' AS section,
  n.nspname AS schema_name,
  c.relname AS view_name,
  CASE c.relkind
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized_view'
    ELSE c.relkind::text
  END AS view_type,
  pg_get_viewdef(c.oid, true) AS view_definition
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (
    c.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE c.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY n.nspname, c.relname;

-- 10. Funciones relacionadas por nombre o fuente.
WITH patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('sale'), ('stock'), ('inventory'), ('product'), ('variant'),
    ('user'), ('subscription'), ('notification'), ('discount'), ('campaign'), ('provider'),
    ('purchase'), ('expense'), ('invoice'), ('finance'), ('cashflow'), ('profit'),
    ('page_view'), ('analytics')
)
SELECT
  '10_functions' AS section,
  n.nspname AS schema_name,
  p.proname AS function_name,
  l.lanname AS language_name,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS result_type,
  p.provolatile AS volatility,
  p.prosecdef AS security_definer,
  LEFT(p.prosrc, 4000) AS source_preview
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND EXISTS (
    SELECT 1
    FROM patterns pat
    WHERE p.proname ILIKE '%' || pat.pattern || '%'
       OR p.prosrc ILIKE '%' || pat.pattern || '%'
  )
ORDER BY n.nspname, p.proname;

-- 11. Triggers relacionados.
WITH explicit_names(object_name) AS (
  VALUES
    ('agent_conversations'), ('ai_usage_daily'), ('aura_runs'), ('discounts'), ('expenses'),
    ('notification_queue'), ('notification_templates'), ('page_views'), ('product_variants'),
    ('products'), ('providers'), ('purchase_order_items'), ('purchase_orders'), ('sale_items'),
    ('sales'), ('stock_ledger'), ('stock_reservations'), ('subscription_plans'),
    ('subscription_usage'), ('subscriptions'), ('users')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('sale'), ('stock'), ('inventory'), ('product'), ('variant'),
    ('user'), ('subscription'), ('notification'), ('discount'), ('campaign'), ('provider'),
    ('purchase'), ('expense'), ('invoice'), ('finance'), ('cashflow'), ('profit'),
    ('page_view'), ('analytics')
)
SELECT
  '11_triggers' AS section,
  n.nspname AS schema_name,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  p.proname AS function_name,
  t.tgenabled AS enabled_state,
  pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (
    c.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns pat
      WHERE c.relname ILIKE '%' || pat.pattern || '%'
         OR t.tgname ILIKE '%' || pat.pattern || '%'
         OR p.proname ILIKE '%' || pat.pattern || '%'
    )
  )
ORDER BY n.nspname, c.relname, t.tgname;

-- 12. Conteos aproximados por catalogo.
WITH explicit_names(object_name) AS (
  VALUES
    ('admin_profiles'), ('agent_conversations'), ('ai_usage_daily'), ('api_key_logs'), ('api_keys'),
    ('attribute_types'), ('attribute_values'), ('aura_runs'), ('banners'), ('categories'),
    ('contact_messages'), ('discount_coupons'), ('discount_targets'), ('discounts'), ('expenses'),
    ('invoices'), ('notification_queue'), ('notification_settings'), ('notification_templates'),
    ('page_views'), ('payment_accounts'), ('product_images'), ('product_provider_prices'),
    ('product_variants'), ('products'), ('providers'), ('proveedores'), ('purchase_order_items'),
    ('purchase_orders'), ('push_subscriptions'), ('reviews'), ('roles'), ('sale_items'), ('sales'),
    ('stock_ledger'), ('stock_reservations'), ('subscription_coupons'), ('subscription_invoices'),
    ('subscription_plans'), ('subscription_usage'), ('subscriptions'), ('user_roles'), ('users'),
    ('variant_attribute_values'), ('variant_images')
),
patterns(pattern) AS (
  VALUES
    ('aura'), ('agent'), ('ai_usage'), ('sale'), ('order'), ('stock'), ('inventory'),
    ('product'), ('variant'), ('user'), ('customer'), ('client'), ('subscription'),
    ('plan'), ('page_view'), ('analytics'), ('notification'), ('discount'), ('campaign'),
    ('provider'), ('proveedor'), ('purchase'), ('expense'), ('invoice'), ('finance'),
    ('cashflow'), ('profit'), ('banner'), ('category'), ('api_key')
)
SELECT
  '12_approximate_counts' AS section,
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.reltuples::bigint AS approximate_rows,
  pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size_with_indexes,
  s.n_live_tup AS stats_live_tuples,
  s.n_dead_tup AS stats_dead_tuples,
  s.last_analyze,
  s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND c.relkind IN ('r', 'p')
  AND (
    c.relname IN (SELECT object_name FROM explicit_names)
    OR EXISTS (
      SELECT 1
      FROM patterns p
      WHERE c.relname ILIKE '%' || p.pattern || '%'
    )
  )
ORDER BY c.reltuples DESC NULLS LAST, n.nspname, c.relname;

COMMIT;
