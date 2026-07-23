"use strict";

const db = require("../../platform/database");

const {
  requireApiPermission,
} = require("../identity/auth");

async function getProducts(req, res) {
  try {
    const adminId = req.apiKey.adminId;
    const { search, page = 1, limit = 20, sort = "name" } = req.query;
    const category = req.query.category || req.query.categoria;
    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";

    if (category) {
      const { rows: catRows } = await db.query(
        `WITH RECURSIVE cat_tree AS (
           SELECT id FROM categories WHERE slug = $1 AND owner_admin_id = $2 AND is_active = true
           UNION ALL
           SELECT c.id FROM categories c
           JOIN cat_tree ct ON c.parent_id = ct.id
           WHERE c.is_active = true AND c.owner_admin_id = $2
         )
         SELECT id FROM cat_tree`,
        [category, adminId]
      );
      if (catRows.length === 0) {
        return res.json({ success: true, data: [], meta: { total: 0, page: parseInt(page), limit: safeLimit, pages: 0 } });
      }
      params.push(catRows.map(r => Number(r.id)));
      where += ` AND p.category_id = ANY($${params.length})`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    const orderMap = {
      name:       "p.name ASC",
      price_asc:  "p.sale_price ASC",
      price_desc: "p.sale_price DESC",
      newest:     "p.created_at DESC",
    };
    const orderBy = orderMap[sort] || "p.name ASC";

    params.push(safeLimit, offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT
           p.id, p.name, p.sku, p.description,
           p.sale_price,
           p.sale_price AS price,
           p.stock,
           GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) AS disponible_inmediato,
           p.has_variants,
           p.fulfillment_mode,
           p.supplier_lead_time_days,
           p.fulfillment_mode IN ('hybrid', 'on_demand') AS can_order_on_demand,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN true ELSE false
           END AS is_on_demand,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN 'on_demand' ELSE 'stock'
           END AS sale_mode,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN 'Venta bajo pedido'
             ELSE 'Disponible para entrega inmediata'
           END AS availability_label,
           -- Vocabulario del catálogo público: on_demand | out | low | normal.
           -- No confundir con stock_status de v_stock_disponible.
           CASE
             WHEN p.fulfillment_mode IN ('hybrid', 'on_demand')
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
               THEN 'on_demand'
             WHEN GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0 THEN 'out'
             WHEN p.stock <= p.min_stock THEN 'low'
             ELSE 'normal'
           END AS stock_status,
           c.name AS category, c.name AS category_name, c.slug AS category_slug,
           (SELECT url FROM product_images
            WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
           COALESCE(
             json_agg(
               DISTINCT jsonb_build_object('url', pi.url, 'is_main', pi.is_main)
             ) FILTER (WHERE pi.id IS NOT NULL), '[]'
           ) AS images,
           COALESCE(
             (SELECT json_agg(DISTINCT jsonb_build_object(
               'variant_id',     pv.id,
               'attribute_slug', at.slug,
               'value',          av.value,
               'display_value',  COALESCE(av.display_value, av.value),
               'hex_color',      av.hex_color,
               'main_image',     (
                 SELECT vi.url FROM variant_images vi
                 WHERE vi.variant_id = pv.id AND vi.is_main = true LIMIT 1
               )
             ))
             FROM product_variants pv
             JOIN variant_attribute_values vav ON vav.variant_id = pv.id
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN attribute_types  at ON at.id = av.attribute_type_id
             WHERE pv.product_id = p.id AND pv.is_active = true AND pv.stock > 0),
             '[]'
           ) AS variant_swatches,
           best_discount.type  AS discount_type,
           best_discount.value AS discount_value,
           COALESCE(best_discount.final_price, p.sale_price) AS final_price
         FROM products p
         LEFT JOIN categories c      ON c.id = p.category_id
         LEFT JOIN product_images pi ON pi.product_id = p.id
         LEFT JOIN LATERAL (
           SELECT d.type, d.value,
             CASE
               WHEN d.type = 'percentage'
                 THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
               WHEN d.type = 'fixed'
                 THEN p.sale_price - d.value
               ELSE p.sale_price
             END AS final_price
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE (
             (dt.target_type = 'product'  AND dt.target_id = p.id::text)
             OR
             (dt.target_type = 'category' AND dt.target_id = p.category_id::text
              AND p.category_id IS NOT NULL)
           )
             AND d.active = true
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND (d.scope = 'web' OR d.scope = 'all')
           ORDER BY final_price ASC
           LIMIT 1
         ) best_discount ON true
         ${where}
         GROUP BY p.id, p.name, p.sku, p.description, p.sale_price,
                  p.stock, p.min_stock, p.has_variants, p.fulfillment_mode,
                  p.supplier_lead_time_days, c.name, c.slug,
                  p.created_at, p.owner_admin_id,
                  best_discount.type, best_discount.value, best_discount.final_price
         ORDER BY ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         ${where}`,
        params.slice(0, -2)
      ),
    ]);

    const total = parseInt(countRow.rows[0].count);

    return res.json({
      success: true,
      data:    rows.rows,
      meta: {
        total,
        page:  parseInt(page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /products", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
}

async function getProductById(req, res) {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.description,
         p.sale_price,
         p.sale_price AS price,
           p.stock,
         GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) AS disponible_inmediato,
         p.has_variants,
         p.fulfillment_mode,
         p.supplier_lead_time_days,
         p.fulfillment_mode IN ('hybrid', 'on_demand') AS can_order_on_demand,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN true ELSE false
         END AS is_on_demand,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN 'on_demand' ELSE 'stock'
         END AS sale_mode,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN 'Venta bajo pedido'
           ELSE 'Disponible para entrega inmediata'
         END AS availability_label,
         -- Vocabulario del catálogo público: on_demand | out | low | normal.
         -- No confundir con stock_status de v_stock_disponible.
         CASE
           WHEN p.fulfillment_mode IN ('hybrid', 'on_demand')
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
             THEN 'on_demand'
           WHEN GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0 THEN 'out'
           WHEN p.stock <= p.min_stock THEN 'low'
           ELSE 'normal'
         END AS stock_status,
         c.name AS category,
         c.name AS category_name,
         c.slug AS category_slug,
         (SELECT url FROM product_images
          WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
         COALESCE(
           (SELECT json_agg(jsonb_build_object('url', pi.url, 'is_main', pi.is_main))
            FROM product_images pi WHERE pi.product_id = p.id),
           '[]'
         ) AS images,
         COALESCE(
           (SELECT json_agg(
             jsonb_build_object(
               'id',         pv.id,
               'sku',        pv.sku,
               'sale_price', COALESCE(pv.sale_price, p.sale_price),
               'price',      COALESCE(pv.sale_price, p.sale_price),
               'stock',      pv.stock,
               'is_active',  pv.is_active,
               'attributes', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object(
                     'type',               at.name,
                     'slug',               at.slug,
                     'icon',               at.icon,
                     'value',              av.value,
                     'display_value',      COALESCE(av.display_value, av.value),
                     'hex_color',          av.hex_color,
                     'attribute_value_id', av.id
                   ) ORDER BY at.id, av.sort_order
                 ), '[]'::json)
                 FROM variant_attribute_values vav
                 JOIN attribute_values av ON av.id = vav.attribute_value_id
                 JOIN attribute_types  at ON at.id = av.attribute_type_id
                 WHERE vav.variant_id = pv.id
               ),
               'images', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                   ORDER BY vi.is_main DESC, vi.display_order
                 ), '[]'::json)
                 FROM variant_images vi WHERE vi.variant_id = pv.id
               )
             )
           )
           FROM product_variants pv
           WHERE pv.product_id = p.id AND pv.is_active = true),
           '[]'
         ) AS variants,
         d.name  AS discount_name,
         d.type  AS discount_type,
         d.value AS discount_value,
         CASE
           WHEN d.type = 'percentage'
             THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
           WHEN d.type = 'fixed' THEN p.sale_price - d.value
           ELSE p.sale_price
         END AS final_price
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN discount_targets dt ON (
         (dt.target_type = 'product'  AND dt.target_id = p.id::text) OR
         (dt.target_type = 'category' AND dt.target_id = p.category_id::text
          AND p.category_id IS NOT NULL)
       )
       LEFT JOIN discounts d
         ON dt.discount_id = d.id
         AND d.active = true
         AND NOW() BETWEEN d.starts_at AND d.ends_at
         AND (d.scope = 'web' OR d.scope = 'all')
       WHERE p.id = $1
         AND p.is_active = true
         AND p.owner_admin_id = $2
       LIMIT 1`,
      [req.params.id, adminId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("[PUBLIC API] GET /products/:id", error);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
}

async function getCategories(req, res) {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         c.id, c.name, c.slug, c.description, c.image_url, c.parent_id,
         COUNT(p.id) FILTER (WHERE p.is_active = true)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.owner_admin_id = $1
       WHERE c.is_active = true
         AND c.owner_admin_id = $1
       GROUP BY c.id, c.name, c.slug, c.description, c.image_url, c.parent_id
       ORDER BY c.name`,
      [adminId]
    );

    const rows = result.rows.map(r => ({
      ...r,
      id:        Number(r.id),
      parent_id: r.parent_id != null ? Number(r.parent_id) : null,
    }));

    const buildTree = (items, parentId = null) =>
      items
        .filter(i => i.parent_id === parentId)
        .map(i => ({ ...i, children: buildTree(items, i.id) }));

    return res.json({ success: true, data: buildTree(rows) });
  } catch (error) {
    console.error("[PUBLIC API] GET /categories", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
}

function registerCatalogRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerCatalogRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/products",
    requireApiPermission("products:read"),
    getProducts
  );

  router.get(
    "/products/:id",
    requireApiPermission("products:read"),
    getProductById
  );

  router.get(
    "/categories",
    requireApiPermission("categories:read"),
    getCategories
  );
}

module.exports = Object.freeze({
  registerCatalogRoutes,
  getProducts,
  getProductById,
  getCategories,
});

