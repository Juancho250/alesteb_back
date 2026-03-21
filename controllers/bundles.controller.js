// src/controllers/bundles.controller.js
const db = require("../config/db");

// Helper: obtener items de un bundle con info completa
const getBundleItems = async (bundleId) => {
  const result = await db.query(`
    SELECT
      bi.id, bi.quantity, bi.is_gift,
      p.id AS product_id, p.name AS product_name, p.sale_price AS product_price,
      (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.is_main=true LIMIT 1) AS product_image,
      pv.id AS variant_id, pv.sku AS variant_sku, pv.sale_price AS variant_price,
      COALESCE(
        (SELECT json_agg(json_build_object('type', at.name, 'value', av.value, 'hex', av.hex_color))
         FROM variant_attribute_values vav
         JOIN attribute_values av ON av.id = vav.attribute_value_id
         JOIN attribute_types at  ON at.id = av.attribute_type_id
         WHERE vav.variant_id = pv.id), '[]'
      ) AS variant_attributes
    FROM bundle_items bi
    JOIN products p ON p.id = bi.product_id
    LEFT JOIN product_variants pv ON pv.id = bi.variant_id
    WHERE bi.bundle_id = $1
    ORDER BY bi.is_gift ASC, bi.id
  `, [bundleId]);
  return result.rows;
};

// GET /products/:bundleId/bundle-items
exports.getBundleItems = async (req, res) => {
  try {
    const items = await getBundleItems(req.params.bundleId);
    res.json({ success: true, data: items });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error al obtener items del bundle" });
  }
};

// POST /products — crear bundle
// El bundle es un producto normal con is_bundle=true
// body: { name, description, category_id, bundle_price, items: [{product_id, variant_id?, quantity, is_gift}] }
exports.createBundle = async (req, res) => {
  let { name, description, category_id, bundle_price, items } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // ── CORRECCIÓN: parsear items si viene como string (FormData) ──
    if (typeof items === "string") {
      try { items = JSON.parse(items); }
      catch { return res.status(400).json({ success: false, message: "items JSON inválido" }); }
    }
    if (!Array.isArray(items)) items = [];

    if (!name?.trim())                throw new Error("El nombre es requerido");
    if (!bundle_price || Number(bundle_price) <= 0) throw new Error("El precio del bundle es requerido");
    if (items.length < 2)             throw new Error("Un bundle debe tener al menos 2 productos");


    // Crear el producto "bundle"
    const prodRes = await client.query(
      `INSERT INTO products (name, description, category_id, sale_price, stock, is_bundle, bundle_price, has_variants)
       VALUES ($1, $2, $3, $4, 9999, true, $4, false) RETURNING id`,
      [name.trim(), description?.trim() || null, category_id || null, bundle_price]
    );
    const bundleId = prodRes.rows[0].id;

    // Imágenes
    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1,$2,$3,$4)`,
        [bundleId, images[i].path || images[i].secure_url, i === 0, i]
      );
    }

    // Items del bundle
    for (const item of items) {
      if (!item.product_id) throw new Error("Cada item necesita product_id");
      await client.query(
        `INSERT INTO bundle_items (bundle_id, product_id, variant_id, quantity, is_gift)
         VALUES ($1,$2,$3,$4,$5)`,
        [bundleId, item.product_id, item.variant_id || null, item.quantity || 1, item.is_gift || false]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      message: "Bundle creado correctamente",
      data: { id: bundleId }
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[BUNDLE CREATE]", e);
    res.status(400).json({ success: false, message: e.message || "Error al crear bundle" });
  } finally { client.release(); }
};

// PUT /products/:bundleId/bundle-items  — reemplazar items del bundle
exports.updateBundleItems = async (req, res) => {
  const { bundleId } = req.params;
  const { items = [], bundle_price } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    if (bundle_price) {
      await client.query(
        `UPDATE products SET sale_price=$1, bundle_price=$1 WHERE id=$2`,
        [bundle_price, bundleId]
      );
    }

    await client.query(`DELETE FROM bundle_items WHERE bundle_id=$1`, [bundleId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO bundle_items (bundle_id, product_id, variant_id, quantity, is_gift)
         VALUES ($1,$2,$3,$4,$5)`,
        [bundleId, item.product_id, item.variant_id || null, item.quantity || 1, item.is_gift || false]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Bundle actualizado" });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Error al actualizar bundle" });
  } finally { client.release(); }
};