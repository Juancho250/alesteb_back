// products.controller.js - VERSIÓN MEJORADA
// Los productos se crean sin precio ni stock, que se configuran en Purchase Orders

const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// Utility function to extract Cloudinary public_id from URL
const getPublicIdFromUrl = (url) => {
  try {
    const matches = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
    if (matches && matches[1]) {
      return matches[1];
    }
    
    const splitUrl = url.split('/');
    const lastPart = splitUrl.pop();
    const publicId = lastPart.split('.')[0];
    const folder = splitUrl[splitUrl.length - 1];
    
    return folder !== 'upload' ? `${folder}/${publicId}` : publicId;
  } catch (error) {
    console.error('Error extracting public_id:', error);
    return null;
  }
};

const deleteFromCloudinary = async (url) => {
  try {
    const publicId = getPublicIdFromUrl(url);
    if (publicId) {
      await cloudinary.uploader.destroy(publicId);
      console.log(`✅ Deleted from Cloudinary: ${publicId}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Cloudinary deletion error:', error);
    return false;
  }
};

// ========================================
// GET ALL PRODUCTS (con indicadores de estado)
// ========================================
exports.getAll = async (req, res) => {
  const { categoria, page = 1, limit = 100, search = "" } = req.query;
  const offset = (page - 1) * limit;

  try {
    let whereClause = [];
    let queryParams = [];
    let paramIndex = 1;

    if (categoria) {
      whereClause.push(`c.slug = $${paramIndex}`);
      queryParams.push(categoria);
      paramIndex++;
    }

    if (search) {
      whereClause.push(`(p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereString = whereClause.length > 0 ? `WHERE ${whereClause.join(" AND ")}` : "";

    const queryText = `
      SELECT 
        p.id, p.name, p.price, p.stock, p.category_id,
        p.purchase_price, p.markup_type, p.markup_value,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        
        -- PRECIO FINAL CON DESCUENTOS
        COALESCE(
          (SELECT 
            CASE 
              WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
              WHEN d.type = 'fixed' THEN p.price - d.value
              ELSE p.price
            END
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
               OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND d.active = true
           ORDER BY CASE 
             WHEN d.type = 'percentage' THEN p.price - (p.price * (d.value / 100))
             ELSE p.price - d.value
           END ASC
           LIMIT 1
          ),
          p.price
        ) AS final_price,
        
        -- VALOR DEL DESCUENTO ACTIVO
        (SELECT d.value
         FROM discount_targets dt
         JOIN discounts d ON d.id = dt.discount_id
         WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
             OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
           AND NOW() BETWEEN d.starts_at AND d.ends_at
           AND d.active = true
         LIMIT 1
        ) AS discount_value,
        
        -- 🆕 INDICADORES DE ESTADO
        CASE
          WHEN p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0) THEN 'pending_first_purchase'
          WHEN p.stock = 0 AND p.purchase_price > 0 THEN 'out_of_stock'
          WHEN p.stock > 0 AND p.stock <= 5 THEN 'low_stock'
          ELSE 'in_stock'
        END AS inventory_status

      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereString}
      ORDER BY p.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      db.query(queryText, queryParams),
      db.query(`
        SELECT COUNT(p.id) 
        FROM products p 
        LEFT JOIN categories c ON p.category_id = c.id 
        ${whereString}
      `, queryParams.slice(0, paramIndex - 1))
    ]);

    res.json({
      products: dataResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });

  } catch (error) {
    console.error("GET PRODUCTS ERROR:", error);
    res.status(500).json({ message: "Error al obtener productos" });
  }
};

// ========================================
// CREATE PRODUCT (SIN precio ni stock)
// ========================================
exports.create = async (req, res) => {
  const { name, category_id, description, image_order } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 🆕 Crear producto con valores por defecto
    // Precio y stock = 0 hasta primera Purchase Order
    const productResult = await client.query(
      `INSERT INTO products (
        name, 
        price, 
        stock, 
        category_id, 
        description,
        purchase_price,
        markup_type,
        markup_value
      )
       VALUES ($1, 0, 0, $2, $3, NULL, NULL, NULL) 
       RETURNING id`,
      [name, category_id, description]
    );

    const productId = productResult.rows[0].id;

    if (images.length > 0) {
      let orderMap = {};
      if (image_order) {
        try {
          const orderArray = JSON.parse(image_order);
          orderArray.forEach((filename, index) => {
            orderMap[filename] = index;
          });
        } catch (e) {
          console.log('No image order provided, using upload order');
        }
      }

      const insertImageQuery = `
        INSERT INTO product_images (product_id, url, is_main, display_order)
        VALUES ($1, $2, $3, $4)
      `;

      for (let i = 0; i < images.length; i++) {
        const imageUrl = images[i].path || images[i].secure_url;
        const originalName = images[i].originalname;
        const displayOrder = orderMap[originalName] !== undefined ? orderMap[originalName] : i;

        await client.query(insertImageQuery, [
          productId,
          imageUrl,
          i === 0,
          displayOrder
        ]);
      }
    }

    await client.query("COMMIT");
    
    res.status(201).json({ 
      id: productId,
      message: "Producto agregado al catálogo. Configura precio y stock en 'Órdenes de Compra'."
    });
    
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// ========================================
// UPDATE PRODUCT (precio/stock READ-ONLY)
// ========================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const { 
    name, 
    price,           // ⚠️ Permitido pero con advertencia
    stock,           // ❌ IGNORADO (solo vía Purchase Orders)
    category_id, 
    description, 
    deleted_image_ids, 
    image_order 
  } = req.body;
  const newImages = req.files || [];

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Get current images
    const currentImagesQuery = await client.query(
      "SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY display_order ASC",
      [id]
    );
    const currentImages = currentImagesQuery.rows;
    
    let idsToDelete = [];
    if (deleted_image_ids) {
      idsToDelete = Array.isArray(deleted_image_ids) 
        ? deleted_image_ids 
        : JSON.parse(deleted_image_ids);
    }

    const remainingImagesCount = currentImages.filter(
      img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)
    ).length;
    const totalFinalImages = remainingImagesCount + newImages.length;

    if (totalFinalImages < 1) {
      throw new Error("El producto debe tener al menos una imagen.");
    }

    // 🆕 UPDATE: Solo actualizar información del catálogo
    // Stock se IGNORA (se maneja en Purchase Orders)
    // Precio se permite pero idealmente debería modificarse en Purchase Orders
    await client.query(
      `UPDATE products 
       SET name = $1, 
           price = $2, 
           category_id = $3, 
           description = $4 
       WHERE id = $5`,
      [name, price, category_id, description, id]
    );

    // Delete marked images
    if (idsToDelete.length > 0) {
      const imagesToDelete = currentImages.filter(
        img => idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id)
      );
      
      for (const img of imagesToDelete) {
        await deleteFromCloudinary(img.url);
        await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
      }
    }

    // Insert new images
    if (newImages.length > 0) {
      const insertImageQuery = `
        INSERT INTO product_images (product_id, url, is_main, display_order)
        VALUES ($1, $2, $3, $4)
      `;
      
      const isFirstNew = remainingImagesCount === 0;
      const startOrder = remainingImagesCount;

      for (let i = 0; i < newImages.length; i++) {
        const imageUrl = newImages[i].path || newImages[i].secure_url;
        await client.query(insertImageQuery, [
          id,
          imageUrl,
          isFirstNew && i === 0,
          startOrder + i
        ]);
      }
    }

    // Update image order
    if (image_order) {
      try {
        const orderArray = JSON.parse(image_order);
        for (let i = 0; i < orderArray.length; i++) {
          const imageId = orderArray[i];
          await client.query(
            "UPDATE product_images SET display_order = $1 WHERE id = $2 AND product_id = $3",
            [i, imageId, id]
          );
        }
      } catch (e) {
        console.log('Error updating image order:', e);
      }
    }

    // Ensure main image
    await client.query(
      `UPDATE product_images SET is_main = false WHERE product_id = $1`,
      [id]
    );
    await client.query(
      `UPDATE product_images SET is_main = true 
       WHERE id = (
         SELECT id FROM product_images 
         WHERE product_id = $1 
         ORDER BY display_order ASC 
         LIMIT 1
       )`,
      [id]
    );

    await client.query("COMMIT");
    res.json({ message: "Producto actualizado correctamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("UPDATE PRODUCT ERROR:", error);
    res.status(500).json({ message: error.message || "Error al actualizar producto" });
  } finally {
    client.release();
  }
};

// ========================================
// DELETE PRODUCT
// ========================================
exports.remove = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const imagesResult = await client.query(
      "SELECT url FROM product_images WHERE product_id = $1",
      [id]
    );

    for (const image of imagesResult.rows) {
      await deleteFromCloudinary(image.url);
    }

    const result = await client.query(
      "DELETE FROM products WHERE id = $1",
      [id]
    );

    await client.query("COMMIT");
    res.json({ deleted: result.rowCount });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DELETE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al eliminar producto" });
  } finally {
    client.release();
  }
};

// ========================================
// GET PRODUCT BY ID (con historial)
// ========================================
exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(`
      SELECT 
        p.*,
        c.name AS category_name,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        d.name AS discount_name,
        d.type AS discount_type,
        d.value AS discount_value,
        CASE 
          WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.price - d.value
          ELSE p.price
        END AS final_price,
        
        -- 🆕 ESTADO DEL INVENTARIO
        CASE
          WHEN p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0) THEN 'pending_first_purchase'
          WHEN p.stock = 0 AND p.purchase_price > 0 THEN 'out_of_stock'
          WHEN p.stock > 0 AND p.stock <= 5 THEN 'low_stock'
          ELSE 'in_stock'
        END AS inventory_status
        
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product' AND dt.target_id = p.id::text) OR 
        (dt.target_type = 'category' AND dt.target_id = p.category_id::text)
      )
      LEFT JOIN discounts d ON dt.discount_id = d.id 
        AND NOW() BETWEEN d.starts_at AND d.ends_at
      WHERE p.id = $1
      LIMIT 1
    `, [id]);

    if (!result.rows.length) {
      return res.status(404).json({ message: "No encontrado" });
    }

    const imagesResult = await db.query(
      `SELECT id, url, is_main, display_order 
       FROM product_images 
       WHERE product_id = $1 
       ORDER BY display_order ASC`,
      [id]
    );

    res.json({
      ...result.rows[0],
      images: imagesResult.rows
    });

  } catch (error) {
    console.error("GET PRODUCT BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener producto" });
  }
};

// ========================================
// 🆕 GET PURCHASE HISTORY
// ========================================
exports.getPurchaseHistory = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(`
      SELECT 
        po.id,
        CONCAT('OC-', LPAD(po.id::text, 5, '0')) as order_code,
        po.created_at as date,
        pr.name as provider,
        poi.quantity,
        poi.unit_cost,
        poi.suggested_price as sale_price,
        CASE 
          WHEN poi.markup_type = 'percentage' THEN CONCAT(poi.markup_value::text, '%')
          WHEN poi.markup_type = 'fixed' THEN CONCAT('$', poi.markup_value::text)
          ELSE 'N/A'
        END as markup
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.order_id = po.id
      JOIN providers pr ON po.provider_id = pr.id
      WHERE poi.product_id = $1
      ORDER BY po.created_at DESC
      LIMIT 20
    `, [id]);

    res.json(result.rows);

  } catch (error) {
    console.error("GET PURCHASE HISTORY ERROR:", error);
    res.status(500).json({ message: "Error al obtener historial" });
  }
};

module.exports = exports;