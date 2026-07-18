-- Validate AURA Predictive features against original sales and stock sources.
--
-- Usage:
--   psql "$NEON_DB_URL" -X \
--     -v owner_admin_id=101 \
--     -v date_from="'2026-07-01'" \
--     -v date_to="'2026-07-14'" \
--     -v feature_version="'predictive_features_v1'" \
--     -f scripts/validate_predictive_features.sql

\echo 'AURA Predictive validation: product features vs sales/sale_items'

WITH params AS (
  SELECT
    :owner_admin_id::int AS owner_admin_id,
    :date_from::date AS date_from,
    :date_to::date AS date_to,
    :feature_version::text AS feature_version
),
valid_sales AS (
  SELECT s.*
  FROM sales s
  JOIN params p ON p.owner_admin_id = s.owner_admin_id
  WHERE s.sale_date::date BETWEEN p.date_from AND p.date_to
    AND s.payment_status = 'paid'
    AND LOWER(COALESCE(s.payment_status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
    AND LOWER(COALESCE(s.status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
    AND LOWER(COALESCE(s.delivery_status::text, '')) NOT IN ('cancelled', 'canceled')
),
source_product AS (
  SELECT
    vs.owner_admin_id,
    vs.sale_date::date AS feature_date,
    si.product_id,
    SUM(si.quantity)::numeric(14,3) AS units_sold,
    ROUND(SUM(si.subtotal)::numeric, 2) AS gross_revenue,
    ROUND(SUM(
      CASE
        WHEN COALESCE(vs.subtotal, 0) > 0
          THEN COALESCE(vs.discount_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
        ELSE 0
      END
    )::numeric, 2) AS discounts_allocated,
    ROUND(SUM(COALESCE(si.total_profit, 0))::numeric, 2) AS estimated_margin
  FROM valid_sales vs
  JOIN sale_items si ON si.sale_id = vs.id
  GROUP BY vs.owner_admin_id, vs.sale_date::date, si.product_id
),
feature_product AS (
  SELECT
    dpf.owner_admin_id,
    dpf.feature_date,
    dpf.product_id,
    dpf.units_sold,
    dpf.gross_revenue,
    dpf.discounts_allocated,
    dpf.estimated_margin,
    dpf.stock_final,
    dpf.stock_available_final,
    dpf.completeness_score,
    dpf.data_quality
  FROM daily_product_features dpf
  JOIN params p
    ON p.owner_admin_id = dpf.owner_admin_id
   AND p.feature_version = dpf.feature_version
  WHERE dpf.feature_date BETWEEN p.date_from AND p.date_to
)
SELECT
  COALESCE(fp.feature_date, sp.feature_date) AS feature_date,
  COALESCE(fp.product_id, sp.product_id) AS product_id,
  COALESCE(sp.units_sold, 0) AS source_units,
  COALESCE(fp.units_sold, 0) AS feature_units,
  COALESCE(sp.gross_revenue, 0) AS source_gross_revenue,
  COALESCE(fp.gross_revenue, 0) AS feature_gross_revenue,
  COALESCE(sp.discounts_allocated, 0) AS source_discounts,
  COALESCE(fp.discounts_allocated, 0) AS feature_discounts,
  COALESCE(sp.estimated_margin, 0) AS source_margin,
  COALESCE(fp.estimated_margin, 0) AS feature_margin,
  COALESCE(fp.completeness_score, 0) AS completeness_score,
  fp.data_quality
FROM feature_product fp
FULL OUTER JOIN source_product sp
  ON sp.owner_admin_id = fp.owner_admin_id
 AND sp.feature_date = fp.feature_date
 AND sp.product_id = fp.product_id
WHERE ABS(COALESCE(sp.units_sold, 0) - COALESCE(fp.units_sold, 0)) > 0.001
   OR ABS(COALESCE(sp.gross_revenue, 0) - COALESCE(fp.gross_revenue, 0)) > 0.01
   OR ABS(COALESCE(sp.discounts_allocated, 0) - COALESCE(fp.discounts_allocated, 0)) > 0.01
   OR ABS(COALESCE(sp.estimated_margin, 0) - COALESCE(fp.estimated_margin, 0)) > 0.01
ORDER BY feature_date DESC, product_id;

\echo 'AURA Predictive validation: stock snapshot sanity'

WITH params AS (
  SELECT
    :owner_admin_id::int AS owner_admin_id,
    :date_from::date AS date_from,
    :date_to::date AS date_to,
    :feature_version::text AS feature_version
)
SELECT
  dpf.feature_date,
  dpf.product_id,
  p.stock AS current_product_stock,
  p.stock_reserved AS current_reserved,
  GREATEST(0, COALESCE(p.stock,0) - COALESCE(p.stock_reserved,0) - COALESCE(p.stock_safety,0)) AS current_available,
  dpf.stock_final,
  dpf.stock_reserved_final,
  dpf.stock_available_final,
  dpf.data_quality
FROM daily_product_features dpf
JOIN products p
  ON p.id = dpf.product_id
 AND p.owner_admin_id = dpf.owner_admin_id
JOIN params prm
  ON prm.owner_admin_id = dpf.owner_admin_id
 AND prm.feature_version = dpf.feature_version
WHERE dpf.feature_date BETWEEN prm.date_from AND prm.date_to
  AND dpf.feature_date = CURRENT_DATE
  AND (
    dpf.stock_final IS DISTINCT FROM p.stock
    OR dpf.stock_reserved_final IS DISTINCT FROM p.stock_reserved
    OR dpf.stock_available_final IS DISTINCT FROM GREATEST(0, COALESCE(p.stock,0) - COALESCE(p.stock_reserved,0) - COALESCE(p.stock_safety,0))
  )
ORDER BY dpf.product_id;
