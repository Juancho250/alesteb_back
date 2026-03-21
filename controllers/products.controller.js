// src/controllers/products.controller.js
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// ─── Helper: extraer public_id de URL de Cloudinary ──────────────────────────
const getPublicIdFromUrl = (url) => {
  try {
    if (!url || typeof url !== "string") return null;
    const parts = url.split("/upload/");
    if (parts.length < 2) return null;
    return parts[1].split("/").filter(p => !p.startsWith("v")).join("/").replace(/\.[^/.]+$/, "");
  } catch { return null; }
};

// ─── Helper: validar datos de producto ───────────────────────────────────────
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
        COALESCE(best_discount.final_price, p.sale_price) AS final_price,
        -- Stock total sumando variantes (si las tiene)
        CASE WHEN p.has_variants THEN
          COALESCE((SELECT SUM(pv.stock) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = true), 0)
        ELSE p.stock END AS total_stock,
        -- Conteo de variantes activas
        COALESCE((SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = true), 0) AS variants_count
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

    queryText += ` ORDER BY p.is_bundle ASC, p.created_at DESC`;
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(Number(limit), Number(offset));

    const result = await db.query(queryText, queryParams);
    const countResult = await db.query(
      `SELECT COUNT(*) FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = true ${categoria ? "AND c.slug = $1" : ""}`,
      categoria ? [categoria] : []
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total:   Number(countResult.rows[0].count),
        limit:   Number(limit),
        offset:  Number(offset),
        hasMore: Number(offset) + result.rows.length < Number(countResult.rows[0].count),
      },
    });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
};

// ============================================
// 🔍 OBTENER PRODUCTO POR ID (con variantes y bundle items)
// ============================================
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ success: false, message: "ID inválido" });

    // Datos base del producto
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

    // Imágenes
    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images WHERE product_id=$1 ORDER BY is_main DESC, display_order ASC`, [id]
    );

    // Variantes (si tiene)
    let variants = [];
    if (product.has_variants) {
      const vResult = await db.query(`
        SELECT pv.id, pv.sku, pv.sale_price, pv.stock, pv.is_active,
          COALESCE(
            json_agg(json_build_object(
              'type', at.name, 'slug', at.slug, 'icon', at.icon,
              'value', av.value, 'display_value', COALESCE(av.display_value, av.value),
              'hex_color', av.hex_color, 'attribute_value_id', av.id
            ) ORDER BY at.id) FILTER (WHERE av.id IS NOT NULL), '[]'
          ) AS attributes,
          (SELECT json_agg(json_build_object('id',vi.id,'url',vi.url,'is_main',vi.is_main))
           FROM variant_images vi WHERE vi.variant_id=pv.id) AS images
        FROM product_variants pv
        LEFT JOIN variant_attribute_values vav ON vav.variant_id=pv.id
        LEFT JOIN attribute_values av  ON av.id=vav.attribute_value_id
        LEFT JOIN attribute_types  at  ON at.id=av.attribute_type_id
        WHERE pv.product_id=$1
        GROUP BY pv.id ORDER BY pv.id
      `, [id]);
      variants = vResult.rows;
    }

    // Bundle items (si es bundle)
    let bundleItems = [];
    if (product.is_bundle) {
      const bResult = await db.query(`
        SELECT bi.id, bi.quantity, bi.is_gift,
          p2.id AS product_id, p2.name AS product_name, p2.sale_price AS product_price,
          (SELECT url FROM product_images pi WHERE pi.product_id=p2.id AND pi.is_main=true LIMIT 1) AS product_image,
          pv.id AS variant_id, pv.sku AS variant_sku,
          COALESCE(
            (SELECT json_agg(json_build_object('type',at.name,'value',av.value,'hex',av.hex_color))
             FROM variant_attribute_values vav
             JOIN attribute_values av ON av.id=vav.attribute_value_id
             JOIN attribute_types at ON at.id=av.attribute_type_id
             WHERE vav.variant_id=pv.id), '[]'
          ) AS variant_attributes
        FROM bundle_items bi
        JOIN products p2 ON p2.id=bi.product_id
        LEFT JOIN product_variants pv ON pv.id=bi.variant_id
        WHERE bi.bundle_id=$1 ORDER BY bi.is_gift ASC, bi.id
      `, [id]);
      bundleItems = bResult.rows;
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
// ➕ CREAR PRODUCTO (simple o con indicador de variantes)
// ============================================
exports.create = async (req, res) => {
  const client = await db.connect();
  try {
    const { name, sale_price, stock = 0, category_id, description, has_variants = false } = req.body;
    const images = Array.isArray(req.files) ? req.files : [];

    const validation = validateProductData(req.body);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    // Si tiene variantes, no exigimos imagen (puede subirlas por variante)
    if (images.length === 0 && !has_variants)
      return res.status(400).json({ success: false, message: "Sube al menos una imagen" });

    await client.query("BEGIN");

    const productResult = await client.query(
      `INSERT INTO products (name, sale_price, stock, category_id, description, has_variants)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name.trim(), Number(sale_price), Number(stock), category_id, description?.trim() || null,
       has_variants === "true" || has_variants === true]
    );
    const productId = productResult.rows[0].id;

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

    const productExists = await client.query("SELECT id, has_variants FROM products WHERE id=$1", [id]);
    if (!productExists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    // Gestión de imágenes
    const currentImages = (await client.query("SELECT id, url FROM product_images WHERE product_id=$1", [id])).rows;
    let idsToDelete = [];
    if (deleted_image_ids) {
      try { idsToDelete = Array.isArray(deleted_image_ids) ? deleted_image_ids : JSON.parse(deleted_image_ids); }
      catch { return res.status(400).json({ success: false, message: "deleted_image_ids inválido" }); }
    }

    const remaining = currentImages.filter(img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)).length;
    const hasVariants = productExists.rows[0].has_variants;

    if (!hasVariants && remaining + newImages.length < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "El producto debe tener al menos una imagen" });
    }

    // Actualizar datos
    await client.query(
      `UPDATE products SET name=$1, sale_price=$2, stock=$3, category_id=$4, description=$5, updated_at=NOW() WHERE id=$6`,
      [name?.trim() || null, sale_price ? Number(sale_price) : null,
       stock !== undefined ? Number(stock) : null, category_id || null, description?.trim() || null, id]
    );

    // Eliminar imágenes marcadas
    for (const img of currentImages.filter(img => idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id))) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
      await client.query("DELETE FROM product_images WHERE id=$1", [img.id]);
    }

    // Insertar nuevas imágenes
    if (newImages.length > 0) {
      const maxOrder = (await client.query("SELECT COALESCE(MAX(display_order),-1) as m FROM product_images WHERE product_id=$1", [id])).rows[0].m;
      for (let i = 0; i < newImages.length; i++) {
        await client.query(
          `INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1,$2,$3,$4)`,
          [id, newImages[i].path || newImages[i].secure_url, remaining === 0 && i === 0, maxOrder + 1 + i]
        );
      }
    }

    // Asegurar imagen principal
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
// 🗑️ ELIMINAR PRODUCTO (también limpia variantes y bundle_items)
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

    // Eliminar imágenes de variantes de Cloudinary
    const varImgs = await client.query(
      `SELECT vi.url FROM variant_images vi
       JOIN product_variants pv ON pv.id=vi.variant_id WHERE pv.product_id=$1`, [id]
    );
    for (const img of varImgs.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
    }

    // Eliminar imágenes del producto de Cloudinary
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