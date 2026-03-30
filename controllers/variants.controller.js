// src/controllers/variants.controller.js
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// ─── Helper: obtener variantes completas de un producto ──────────────────────
const getVariantsForProduct = async (productId) => {
  const result = await db.query(`
    SELECT
      pv.id, pv.product_id, pv.sku, pv.sale_price, pv.stock, pv.is_active,
      pv.created_at, pv.updated_at,
      COALESCE(
        json_agg(
          json_build_object(
            'attribute_type',  at.name,
            'attribute_slug',  at.slug,
            'attribute_icon',  at.icon,
            'value',           av.value,
            'display_value',   COALESCE(av.display_value, av.value),
            'hex_color',       av.hex_color,
            'attribute_value_id', av.id
          ) ORDER BY at.id, av.sort_order   -- ✅ fix aquí
        ) FILTER (WHERE av.id IS NOT NULL),
        '[]'
      ) AS attributes,
      (
        SELECT json_agg(json_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                        ORDER BY vi.is_main DESC, vi.display_order)
        FROM variant_images vi WHERE vi.variant_id = pv.id
      ) AS images
    FROM product_variants pv
    LEFT JOIN variant_attribute_values vav ON vav.variant_id = pv.id
    LEFT JOIN attribute_values av  ON av.id  = vav.attribute_value_id
    LEFT JOIN attribute_types  at  ON at.id  = av.attribute_type_id
    WHERE pv.product_id = $1
    GROUP BY pv.id
    ORDER BY pv.id
  `, [productId]);
  return result.rows;
};
// GET /products/:productId/variants
exports.list = async (req, res) => {
  try {
    const variants = await getVariantsForProduct(req.params.productId);
    res.json({ success: true, data: variants });
  } catch (e) {
    console.error("[VARIANTS LIST]", e);
    res.status(500).json({ success: false, message: "Error al obtener variantes" });
  }
};

// POST /products/:productId/variants
// body: { sku?, sale_price?, stock, attribute_value_ids: [1,3,5] }
exports.create = async (req, res) => {
  const { productId } = req.params;
  const { sku, sale_price, stock = 0, attribute_value_ids = [] } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Crear variante
    const vRes = await client.query(
      `INSERT INTO product_variants (product_id, sku, sale_price, stock)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [productId, sku || null, sale_price || null, stock]
    );
    const variantId = vRes.rows[0].id;

    // Asignar atributos
    for (const avId of attribute_value_ids) {
      await client.query(
        `INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES ($1, $2)`,
        [variantId, avId]
      );
    }

    // Marcar el producto como "tiene variantes"
    await client.query(
      `UPDATE products SET has_variants = true WHERE id = $1`,
      [productId]
    );

    await client.query("COMMIT");
    const [variant] = await getVariantsForProduct(productId)
      .then(arr => arr.filter(v => v.id === variantId));
    res.status(201).json({ success: true, data: variant });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[VARIANT CREATE]", e);
    if (e.code === '23505') return res.status(400).json({ success: false, message: "SKU duplicado" });
    res.status(500).json({ success: false, message: "Error al crear variante" });
  } finally { client.release(); }
};

// PUT /products/:productId/variants/:variantId
exports.update = async (req, res) => {
  const { variantId } = req.params;
  const { sku, sale_price, stock, is_active, attribute_value_ids } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE product_variants SET sku=$1, sale_price=$2, stock=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5`,
      [sku || null, sale_price || null, stock, is_active ?? true, variantId]
    );

    if (Array.isArray(attribute_value_ids)) {
      await client.query(`DELETE FROM variant_attribute_values WHERE variant_id = $1`, [variantId]);
      for (const avId of attribute_value_ids) {
        await client.query(
          `INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES ($1, $2)`,
          [variantId, avId]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Variante actualizada" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[VARIANT UPDATE]", e);
    res.status(500).json({ success: false, message: "Error al actualizar variante" });
  } finally { client.release(); }
};

// DELETE /products/:productId/variants/:variantId
exports.remove = async (req, res) => {
  const { productId, variantId } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Eliminar imágenes de Cloudinary
    const imgs = await client.query(`SELECT url FROM variant_images WHERE variant_id=$1`, [variantId]);
    for (const img of imgs.rows) {
      const parts = img.url.split('/upload/');
      if (parts[1]) {
        const publicId = parts[1].split('/').filter(p => !p.startsWith('v')).join('/').replace(/\.[^/.]+$/, '');
        try { await cloudinary.uploader.destroy(publicId); } catch {}
      }
    }

    await client.query(`DELETE FROM product_variants WHERE id=$1`, [variantId]);

    // Si no quedan variantes, desactivar has_variants
    const remaining = await client.query(
      `SELECT COUNT(*) FROM product_variants WHERE product_id=$1`, [productId]
    );
    if (parseInt(remaining.rows[0].count) === 0) {
      await client.query(`UPDATE products SET has_variants=false WHERE id=$1`, [productId]);
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Variante eliminada" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[VARIANT DELETE]", e);
    res.status(500).json({ success: false, message: "Error al eliminar variante" });
  } finally { client.release(); }
};

// GET /attributes — tipos + valores para el selector
exports.getAttributeTypes = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT at.*, COALESCE(json_agg(
        json_build_object('id',av.id,'value',av.value,'display_value',COALESCE(av.display_value,av.value),'hex_color',av.hex_color,'sort_order',av.sort_order)
        ORDER BY av.sort_order
      ) FILTER (WHERE av.id IS NOT NULL), '[]') AS values
      FROM attribute_types at
      LEFT JOIN attribute_values av ON av.attribute_type_id = at.id
      GROUP BY at.id ORDER BY at.id
    `);
    res.json({ success: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error al obtener atributos" });
  }
};

// POST /attributes/:typeId/values  — crear valor de atributo
exports.createAttributeValue = async (req, res) => {
  const { typeId } = req.params;
  const { value, display_value, hex_color, sort_order } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO attribute_values (attribute_type_id, value, display_value, hex_color, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [typeId, value, display_value || null, hex_color || null, sort_order || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error al crear valor" });
  }
};