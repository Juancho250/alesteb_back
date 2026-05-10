// src/controllers/products.controller.js
const db         = require("../config/db");
const cloudinary = require("../config/cloudinary");
const { emitDataUpdate }  = require("../config/socket");
const { scopeByOwner, assertOwnership } = require("../middleware/adminScope");

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

const fetchFullProduct = async (id) => {
  const result = await db.query(`
    SELECT
      p.*,
      c.name AS category_name,
      c.slug AS category_slug,
      u.name AS owner_admin_name,
      (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
      best_discount.type  AS discount_type,
      best_discount.value AS discount_value,
      COALESCE(best_discount.final_price, p.sale_price) AS final_price
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN users      u ON u.id = p.owner_admin_id
    LEFT JOIN LATERAL (
      SELECT d.type, d.value,
        CASE
          WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed'      THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
      FROM discount_targets dt
      JOIN discounts d ON d.id = dt.discount_id
      WHERE ((dt.target_type = 'product'  AND dt.target_id = p.id::text)
          OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
        AND d.active = true AND NOW() BETWEEN d.starts_at AND d.ends_at
      ORDER BY final_price ASC LIMIT 1
    ) best_discount ON true
    WHERE p.id = $1
  `, [id]);

  if (!result.rows.length) return null;
  return {
    ...result.rows[0],
    has_variants: result.rows[0].has_variants ?? false,
    is_bundle:    result.rows[0].is_bundle    ?? false,
  };
};

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

// ─────────────────────────────────────────────
// GET /products  — lista paginada
// ─────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const user         = req.user;
    const isSuperAdmin = req.isSuperAdmin ?? user?.roles?.includes("superadmin") ?? false;
    const isAuthed     = !!user;

    const { categoria, search, min_price, max_price } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 12);
    const offset = (page - 1) * limit;

    const queryParams = [];
    let   pi          = 1;

    // ── Scope de tenant ──────────────────────────────────────────────────────
    let tenantClause = "";
    if (isAuthed && !isSuperAdmin) {
      // scopeByOwner devuelve params=[adminId], pero aquí construimos manualmente
      // porque tenemos un pi dinámico
      tenantClause = `AND p.owner_admin_id = $${pi++}`;
      queryParams.push(user.id);
    }

    // ── Filtros adicionales ──────────────────────────────────────────────────
    let filtersClause = "";
    if (categoria) {
      filtersClause += ` AND c.slug = $${pi++}`;
      queryParams.push(categoria);
    }
    if (search) {
      filtersClause += ` AND (p.name ILIKE $${pi} OR p.description ILIKE $${pi})`;
      queryParams.push(`%${search}%`);
      pi++;
    }
    if (min_price) {
      filtersClause += ` AND p.sale_price >= $${pi++}`;
      queryParams.push(Number(min_price));
    }
    if (max_price) {
      filtersClause += ` AND p.sale_price <= $${pi++}`;
      queryParams.push(Number(max_price));
    }

    const limitIdx  = pi;
    const offsetIdx = pi + 1;
    queryParams.push(limit, offset);

    const queryText = `
      SELECT
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        u.name AS owner_admin_name,
        (SELECT url FROM product_images
         WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        best_discount.type  AS discount_type,
        best_discount.value AS discount_value,
        COALESCE(best_discount.final_price, p.sale_price) AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users      u ON u.id = p.owner_admin_id
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
        ORDER BY final_price ASC
        LIMIT 1
      ) best_discount ON true
      WHERE p.is_active = true
        ${tenantClause}
        ${filtersClause}
      ORDER BY p.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    // ── Count (mismos filtros, sin LIMIT/OFFSET) ─────────────────────────────
    const countParams = [];
    let   ci          = 1;
    let   countTenant = "";

    if (isAuthed && !isSuperAdmin) {
      countTenant = `AND p.owner_admin_id = $${ci++}`;
      countParams.push(user.id);
    }

    let countFilters = "";
    if (categoria) { countFilters += ` AND c.slug = $${ci++}`;        countParams.push(categoria); }
    if (search)    {
      countFilters += ` AND (p.name ILIKE $${ci} OR p.description ILIKE $${ci})`;
      countParams.push(`%${search}%`); ci++;
    }

    const [result, countResult] = await Promise.all([
      db.query(queryText, queryParams),
      db.query(
        `SELECT COUNT(*) FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.is_active = true ${countTenant} ${countFilters}`,
        countParams
      ),
    ]);

    const rows = result.rows.map(row => ({
      ...row,
      has_variants: row.has_variants ?? false,
      is_bundle:    row.is_bundle    ?? false,
    }));

    const total = Number(countResult.rows[0].count);

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        totalPages: Math.ceil(total / limit),
        page,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
    });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
};

// ─────────────────────────────────────────────
// GET /products/:id
// ─────────────────────────────────────────────
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ success: false, message: "ID inválido" });

    const isSuperAdmin = req.isSuperAdmin ?? req.user?.roles?.includes("superadmin") ?? false;
    const isAuthed     = !!req.user;

    const ownerClause = (isAuthed && !isSuperAdmin) ? "AND p.owner_admin_id = $2" : "";
    const queryParams = (isAuthed && !isSuperAdmin) ? [id, req.user.id] : [id];

    const result = await db.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        u.name AS owner_admin_name,
        d.name AS discount_name, d.type AS discount_type, d.value AS discount_value,
        CASE
          WHEN d.type = 'percentage'
            THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users      u ON u.id = p.owner_admin_id
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product'  AND dt.target_id = p.id::text) OR
        (dt.target_type = 'category' AND dt.target_id = p.category_id::text
         AND p.category_id IS NOT NULL)
      )
      LEFT JOIN discounts d
        ON dt.discount_id = d.id
        AND d.active = true
        AND NOW() BETWEEN d.starts_at AND d.ends_at
      WHERE p.id = $1 ${ownerClause}
      LIMIT 1
    `, queryParams);

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: "Producto no encontrado" });

    const product = result.rows[0];

    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images
       WHERE product_id = $1 ORDER BY is_main DESC, display_order ASC`,
      [id]
    );

    let variants = [];
    if (product.has_variants) {
      try {
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
          LEFT JOIN variant_attribute_values vav ON vav.variant_id = pv.id
          LEFT JOIN attribute_values av ON av.id = vav.attribute_value_id
          LEFT JOIN attribute_types  at ON at.id = av.attribute_type_id
          WHERE pv.product_id = $1
          GROUP BY pv.id ORDER BY pv.id
        `, [id]);
        variants = vResult.rows;
      } catch (e) { console.warn("[VARIANTS]", e.message); }
    }

    let bundleItems = [];
    if (product.is_bundle) {
      try {
        const bResult = await db.query(`
          SELECT bi.id, bi.quantity, bi.is_gift,
            p2.id AS product_id, p2.name AS product_name, p2.sale_price AS product_price,
            (SELECT url FROM product_images pi
             WHERE pi.product_id = p2.id AND pi.is_main = true LIMIT 1) AS product_image
          FROM bundle_items bi
          JOIN products p2 ON p2.id = bi.product_id
          WHERE bi.bundle_id = $1 ORDER BY bi.is_gift ASC, bi.id
        `, [id]);
        bundleItems = bResult.rows;
      } catch (e) { console.warn("[BUNDLE ITEMS]", e.message); }
    }

    res.json({
      success: true,
      data: { ...product, images: imagesResult.rows, variants, bundle_items: bundleItems },
    });
  } catch (error) {
    console.error("[GET PRODUCT BY ID ERROR]", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
};

// ─────────────────────────────────────────────
// POST /products
// ─────────────────────────────────────────────
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

    // superadmin crea sin tenant (owner_admin_id = null)
    const isSuperAdmin = req.isSuperAdmin ?? req.user?.roles?.includes("superadmin") ?? false;
    const ownerAdminId = isSuperAdmin ? null : req.user.id;

    await client.query("BEGIN");

    const productResult = await client.query(
      `INSERT INTO products
         (name, sale_price, stock, category_id, description, owner_admin_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [name.trim(), Number(sale_price), Number(stock), category_id,
       description?.trim() || null, ownerAdminId, req.user.id]
    );
    const productId = productResult.rows[0].id;

    if (has_variants === "true" || has_variants === true) {
      await client.query("UPDATE products SET has_variants = true WHERE id = $1", [productId]);
    }

    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO product_images (product_id, url, is_main, display_order)
         VALUES ($1, $2, $3, $4)`,
        [productId, images[i].path || images[i].secure_url, i === 0, i]
      );
    }

    await client.query("COMMIT");

    try {
      const fullProduct = await fetchFullProduct(productId);
      emitDataUpdate("products", "created", { id: productId, product: fullProduct });
    } catch (emitErr) {
      console.warn("[Socket] emit fallback:", emitErr.message);
      emitDataUpdate("products", "created", { id: productId, product: null });
    }

    res.status(201).json({ success: true, message: "Producto creado correctamente", data: { id: productId } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE PRODUCT ERROR]", error.message, error.stack);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al crear producto" });
  } finally { client.release(); }
};

// ─────────────────────────────────────────────
// PUT /products/:id
// ─────────────────────────────────────────────
exports.update = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { name, sale_price, stock, category_id, description, deleted_image_ids } = req.body;
    const newImages = req.files || [];

    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    const validation = validateProductData(req.body, true);
    if (!validation.isValid)
      return res.status(400).json({ success: false, message: validation.errors.join(", ") });

    await client.query("BEGIN");

    const isSuperAdmin = req.isSuperAdmin ?? req.user?.roles?.includes("superadmin") ?? false;

    // Verificar existencia y propiedad en un solo query
    if (!isSuperAdmin) {
      const owned = await assertOwnership(client, "products", id, req.user.id, "owner_admin_id");
      if (!owned) {
        await client.query("ROLLBACK");
        const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No autorizado para modificar este producto" })
          : res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    } else {
      const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
      if (!exists) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    }

    const currentImages = (
      await client.query("SELECT id, url FROM product_images WHERE product_id = $1", [id])
    ).rows;

    let idsToDelete = [];
    if (deleted_image_ids) {
      try {
        idsToDelete = Array.isArray(deleted_image_ids)
          ? deleted_image_ids
          : JSON.parse(deleted_image_ids);
      } catch {
        return res.status(400).json({ success: false, message: "deleted_image_ids inválido" });
      }
    }

    const remaining = currentImages.filter(
      img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)
    ).length;

    if (remaining + newImages.length < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "El producto debe tener al menos una imagen" });
    }

    await client.query(
      `UPDATE products
       SET name        = COALESCE($1, name),
           sale_price  = COALESCE($2, sale_price),
           stock       = COALESCE($3, stock),
           category_id = COALESCE($4, category_id),
           description = $5,
           updated_at  = NOW()
       WHERE id = $6`,
      [name?.trim() || null, sale_price !== undefined ? Number(sale_price) : null,
       stock !== undefined ? Number(stock) : null, category_id || null,
       description?.trim() ?? null, id]
    );

    // Eliminar imágenes marcadas y destruirlas en Cloudinary
    for (const img of currentImages.filter(
      img => idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id)
    )) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
      await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
    }

    if (newImages.length > 0) {
      const maxOrder = (
        await client.query(
          "SELECT COALESCE(MAX(display_order), -1) AS m FROM product_images WHERE product_id = $1", [id]
        )
      ).rows[0].m;

      for (let i = 0; i < newImages.length; i++) {
        await client.query(
          `INSERT INTO product_images (product_id, url, is_main, display_order)
           VALUES ($1, $2, $3, $4)`,
          [id, newImages[i].path || newImages[i].secure_url, remaining === 0 && i === 0, maxOrder + 1 + i]
        );
      }
    }

    // Garantizar imagen principal
    const hasMain = await client.query(
      "SELECT id FROM product_images WHERE product_id = $1 AND is_main = true LIMIT 1", [id]
    );
    if (!hasMain.rowCount) {
      await client.query(
        `UPDATE product_images SET is_main = true
         WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY display_order LIMIT 1)`,
        [id]
      );
    }

    await client.query("COMMIT");

    try {
      const fullProduct = await fetchFullProduct(parseInt(id));
      emitDataUpdate("products", "updated", { id: parseInt(id), product: fullProduct });
    } catch (emitErr) {
      console.warn("[Socket] emit fallback:", emitErr.message);
      emitDataUpdate("products", "updated", { id: parseInt(id), product: null });
    }

    res.json({ success: true, message: "Producto actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE PRODUCT ERROR]", error.message, error.stack);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "Categoría no existe" });
    res.status(500).json({ success: false, message: "Error al actualizar producto" });
  } finally { client.release(); }
};

// ─────────────────────────────────────────────
// DELETE /products/:id
// ─────────────────────────────────────────────
exports.remove = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    if (!id || isNaN(id))
      return res.status(400).json({ success: false, message: "ID inválido" });

    await client.query("BEGIN");

    const isSuperAdmin = req.isSuperAdmin ?? req.user?.roles?.includes("superadmin") ?? false;

    if (!isSuperAdmin) {
      const owned = await assertOwnership(client, "products", id, req.user.id, "owner_admin_id");
      if (!owned) {
        await client.query("ROLLBACK");
        const exists = (await client.query("SELECT id FROM products WHERE id = $1", [id])).rowCount;
        return exists
          ? res.status(403).json({ success: false, message: "No autorizado para eliminar este producto" })
          : res.status(404).json({ success: false, message: "Producto no encontrado" });
      }
    }

    const imgs = await client.query("SELECT url FROM product_images WHERE product_id = $1", [id]);
    for (const img of imgs.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) { try { await cloudinary.uploader.destroy(publicId); } catch {} }
    }

    await client.query("DELETE FROM products WHERE id = $1", [id]);
    await client.query("COMMIT");

    emitDataUpdate("products", "deleted", { id: parseInt(id) });
    res.json({ success: true, message: "Producto eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE PRODUCT ERROR]", error.message, error.stack);
    if (error.code === "23503")
      return res.status(400).json({ success: false, message: "No se puede eliminar: tiene ventas asociadas" });
    res.status(500).json({ success: false, message: "Error al eliminar producto" });
  } finally { client.release(); }
};