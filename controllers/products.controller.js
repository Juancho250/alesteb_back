// src/controllers/products.controller.js
// ✅ VERSION SEGURA: no usa tablas nuevas (product_variants, etc.) si no existen
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

const getPublicIdFromUrl = (url) => {
  try {
    if (!url || typeof url !== "string") return null;
    const parts = url.split("/upload/");
    if (parts.length < 2) return null;
    return parts[1].split("/").filter(p => !p.startsWith("v")).join("/").replace(/\.[^/.]+$/, "");
  } catch { return null; }
};

const validateProductData = (data, isUpdate = false) => {
  const errors = [];
  if (!isUpdate || data.name !== undefined) {
    if (!data.name?.trim()) errors.push("Nombre es requerido");
    else if (data.name.length > 200) errors.push("Nombre demasiado largo");
  }
  if (!isUpdate || data.sale_price !== undefined) {
    const price = Number(data.sale_price);
    if (isNaN(price) || price < 0) errors.push("Precio inválido");
  }
  if (!isUpdate || data.stock !== undefined) {
    const stock = Number(data.stock);
    if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) errors.push("Stock debe ser entero positivo");
  }
  if (!isUpdate && !data.category_id) errors.push("Categoría es requerida");
  return { isValid: errors.length === 0, errors };
};

// ============================================
// 📋 OBTENER TODOS LOS PRODUCTOS
// ============================================
exports.getAll = async (req, res) => {
  try {
    const { categoria, search, min_price, max_price, limit = 100, offset = 0 } = req.query;

    let queryText = `
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        best_discount.type  AS discount_type,
        best_discount.value AS discount_value,
        COALESCE(best_discount.final_price, p.sale_price) AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN LATERAL (
        SELECT d.type, d.value,
          CASE
            WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
            WHEN d.type = 'fixed'      THEN p.sale_price - d.value
            ELSE p.sale_price
          END AS final_price
        FROM discount_targets dt
        JOIN discounts d ON d.id = dt.discount_id
        WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
           OR  (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
          AND d.active = true AND NOW() BETWEEN d.starts_at AND d.ends_at
        ORDER BY final_price ASC LIMIT 1
      ) best_discount ON true
      WHERE p.is_active = true
    `;

    const queryParams = [];
    let paramIndex = 1;

    if (categoria) {
      queryText += ` AND c.slug = $${paramIndex++}`;
      queryParams.push(categoria);
    }
    if (search) {
      queryText += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    if (min_price) { queryText += ` AND p.sale_price >= $${paramIndex++}`; queryParams.push(Number(min_price)); }
    if (max_price) { queryText += ` AND p.sale_price <= $${paramIndex++}`; queryParams.push(Number(max_price)); }

    queryText += ` ORDER BY p.created_at DESC`;
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(Number(limit), Number(offset));

    const result     = await db.query(queryText, queryParams);
    const countResult = await db.query(
      `SELECT COUNT(*) FROM products p LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = true ${categoria ? "AND c.slug = $1" : ""}`,
      categoria ? [categoria] : []
    );

    // Agregar has_variants e is_bundle solo si las columnas existen
    const rows = result.rows.map(row => ({
      ...row,
      has_variants: row.has_variants ?? false,
      is_bundle:    row.is_bundle    ?? false,
    }));

    res.json({
      success: true,
      data: rows,
      pagination: {
        total:   Number(countResult.rows[0].count),
        limit:   Number(limit),
        offset:  Number(offset),
        hasMore: Number(offset) + rows.length < Number(countResult.rows[0].count),
      },
    });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
};

// ============================================
// 🔍 OBTENER PRODUCTO POR ID
// ============================================
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ success: false, message: "ID inválido" });

    const result = await db.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        d.name AS discount_name, d.type AS discount_type, d.value AS discount_value,
        CASE
          WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value/100)))::numeric,2)
          WHEN d.type = 'fixed'      THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN discount_targets dt ON (
        (dt.target_type='product'  AND dt.target_id=p.id::text) OR
        (dt.target_type='category' AND dt.target_id=p.category_id::text)
      )
      LEFT JOIN discounts d ON dt.discount_id=d.id AND d.active=true AND NOW() BETWEEN d.starts_at AND d.ends_at
      WHERE p.id = $1 LIMIT 1
    `, [id]);

    if (!result.rows.length) return res.status(404).json({ success: false, message: "Producto no encontrado" });

    const product = result.rows[0];

    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images WHERE product_id=$1 ORDER BY is_main DESC, display_order ASC`, [id]
    );

    // Variantes — solo si la tabla existe
    let variants = [];
    try {
      if (product.has_variants) {
        const vResult = await db.query(`
          SELECT pv.id, pv.sku, pv.sale_price, pv.stock, pv.is_active,
            COALESCE(
              json_agg(json_build_object(
                'type', at.name, 'value', av.value,
                'display_value', COALESCE(av.display_value, av.value),
                'hex_color', av.hex_color, 'attribute_value_id', av.id
              ) ORDER BY at.id) FILTER (WHERE av.id IS NOT NULL), '[]'
            ) AS attributes
          FROM product_variants pv
          LEFT JOIN variant_attribute_values vav ON vav.variant_id=pv.id
          LEFT JOIN attribute_values av  ON av.id=vav.attribute_value_id
          LEFT JOIN attribute_types  at  ON at.id=av.attribute_type_id
          WHERE pv.product_id=$1
          GROUP BY pv.id ORDER BY pv.id
        `, [id]);
        variants = vResult.rows;
      }
    } catch (e) {
      console.warn("[VARIANTS] Tabla no disponible aún:", e.message);
    }

    // Bundle items — solo si la tabla existe
    let bundleItems = [];
    try {
      if (product.is_bundle) {
        const bResult = await db.query(`
          SELECT bi.id, bi.quantity, bi.is_gift,
            p2.id AS product_id, p2.name AS product_name, p2.sale_price AS product_price,
            (SELECT url FROM product_images pi WHERE pi.product_id=p2.id AND pi.is_main=true LIMIT 1) AS product_image
          FROM bundle_items bi
          JOIN products p2 ON p2.id=bi.product_id
          WHERE bi.bundle_id=$1 ORDER BY bi.is_gift ASC, bi.id
        `, [id]);
        bundleItems = bResult.rows;
      }
    } catch (e) {
      console.warn("[BUNDLE ITEMS] Tabla no disponible aún:", e.message);
    }

    res.json({
      success: true,
      data: { ...product, images: imagesResult.rows, variants, bundle_items: bundleItems },
    });
  } catch (error) {
    console.error("[GET PRODUCT BY ID ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
};

// ============================================
// ➕ CREAR PRODUCTO
// ============================================
exports.create = async (req, res) => {
  const client = await db.connect();
  try {
    const { name, sale_price, stock = 0, category_id, description, has_variants = false } = req.body;
    const images = Array.isArray(req.files) ? req.files : [];

    const validation = validateProductData(req.body);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    if (images.length === 0 && !(has_variants === "true" || has_variants === true))
      return res.status(400).json({ success: false, message: "Sube al menos una imagen" });

    await client.query("BEGIN");

    const productResult = await client.query(
      `INSERT INTO products (name, sale_price, stock, category_id, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name.trim(), Number(sale_price), Number(stock), category_id, description?.trim() || null]
    );
    const productId = productResult.rows[0].id;

    // Intentar marcar has_variants si la columna existe
    try {
      if (has_variants === "true" || has_variants === true) {
        await client.query(`UPDATE products SET has_variants = true WHERE id = $1`, [productId]);
      }
    } catch (e) { /* columna aún no existe, ignorar */ }

    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1,$2,$3,$4)`,
        [productId, images[i].path || images[i].secure_url, i === 0, i]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ success: true, message: "Producto creado correctamente", data: { id: productId } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE PRODUCT ERROR]", error);
    if (error.code === "23503") return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al crear producto" });
  } finally { client.release(); }
};

// ============================================
// ✏️ ACTUALIZAR PRODUCTO
// ============================================
exports.update = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { name, sale_price, stock, category_id, description, deleted_image_ids } = req.body;
    const newImages = req.files || [];

    if (!id || isNaN(id)) return res.status(400).json({ success: false, message: "ID inválido" });

    const validation = validateProductData(req.body, true);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    await client.query("BEGIN");

    const productExists = await client.query("SELECT id FROM products WHERE id=$1", [id]);
    if (!productExists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    const currentImages = (await client.query("SELECT id, url FROM product_images WHERE product_id=$1", [id])).rows;
    let idsToDelete = [];
    if (deleted_image_ids) {
      try { idsToDelete = Array.isArray(deleted_image_ids) ? deleted_image_ids : JSON.parse(deleted_image_ids); }
      catch { return res.status(400).json({ success: false, message: "deleted_image_ids inválido" }); }
    }

    const remaining = currentImages.filter(img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)).length;
    if (remaining + newImages.length < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "El producto debe tener al menos una imagen" });
    }

    await client.query(
      `UPDATE products SET name=$1, sale_price=$2, stock=$3, category_id=$4, description=$5, updated_at=NOW() WHERE id=$6`,
      [name?.trim() || null, sale_price ? Number(sale_price) : null,
       stock !== undefined ? Number(stock) : null, category_id || null, description?.trim() || null, id]
    );

    for (const img of currentImages.filter(img => idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id))) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
      await client.query("DELETE FROM product_images WHERE id=$1", [img.id]);
    }

    if (newImages.length > 0) {
      const maxOrder = (await client.query("SELECT COALESCE(MAX(display_order),-1) as m FROM product_images WHERE product_id=$1", [id])).rows[0].m;
      for (let i = 0; i < newImages.length; i++) {
        await client.query(
          `INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1,$2,$3,$4)`,
          [id, newImages[i].path || newImages[i].secure_url, remaining === 0 && i === 0, maxOrder + 1 + i]
        );
      }
    }

    const hasMain = await client.query("SELECT id FROM product_images WHERE product_id=$1 AND is_main=true LIMIT 1", [id]);
    if (!hasMain.rowCount) {
      await client.query(
        `UPDATE product_images SET is_main=true WHERE id=(SELECT id FROM product_images WHERE product_id=$1 ORDER BY display_order LIMIT 1)`, [id]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Producto actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE PRODUCT ERROR]", error);
    if (error.code === "23503") return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al actualizar producto" });
  } finally { client.release(); }
};

// ============================================
// 🗑️ ELIMINAR PRODUCTO
// ============================================
exports.remove = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ success: false, message: "ID inválido" });

    await client.query("BEGIN");

    const productExists = await client.query("SELECT id FROM products WHERE id=$1", [id]);
    if (!productExists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    const imgs = await client.query("SELECT url FROM product_images WHERE product_id=$1", [id]);
    for (const img of imgs.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
    }

    await client.query("DELETE FROM products WHERE id=$1", [id]);
    await client.query("COMMIT");
    res.json({ success: true, message: "Producto eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE PRODUCT ERROR]", error);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "No se puede eliminar: tiene ventas asociadas" });
    res.status(500).json({ success: false, message: "Error al eliminar producto" });
  } finally { client.release(); }
};