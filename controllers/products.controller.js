const db = require("../config/db");
const cloudinary = require("../config/cloudinary");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const productCreateSchema = z.object({
  name: z.string()
    .min(3, "El nombre debe tener al menos 3 caracteres")
    .max(200, "El nombre no puede exceder 200 caracteres")
    .trim(),
  category_id: z.union([
    z.number().int().positive(),
    z.string().transform(val => {
      const num = parseInt(val);
      if (isNaN(num) || num <= 0) throw new Error("Categoría inválida");
      return num;
    })
  ]),
  description: z.string()
    .max(2000, "Descripción demasiado larga")
    .trim()
    .optional()
    .or(z.literal(""))
    .transform(val => val || null)
});

// ✅ FIXED: Schema para UPDATE permite campos opcionales
const productUpdateSchema = z.object({
  name: z.string().min(3).max(200).trim().optional(),
  category_id: z.union([
    z.number().int().positive(),
    z.string().transform(val => parseInt(val))
  ]).optional(),
  description: z.string().max(2000).trim().optional().or(z.literal("")).nullable()
});

// ===============================
// UTILIDADES
// ===============================

const getPublicIdFromUrl = (url) => {
  try {
    if (!url || typeof url !== 'string') return null;
    if (!url.includes('cloudinary.com')) return null;
    
    const matches = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
    if (matches && matches[1]) return matches[1];
    
    const splitUrl = url.split('/');
    const lastPart = splitUrl.pop();
    const publicId = lastPart.split('.')[0];
    const folder = splitUrl[splitUrl.length - 1];
    
    return folder !== 'upload' ? `${folder}/${publicId}` : publicId;
  } catch (error) {
    console.error('Error extracting public_id:', error.message);
    return null;
  }
};

const deleteFromCloudinary = async (url) => {
  try {
    if (!url) return false;
    const publicId = getPublicIdFromUrl(url);
    if (!publicId) return false;
    
    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`✅ Deleted from Cloudinary: ${publicId}`, result.result);
    return result.result === 'ok' || result.result === 'not found';
  } catch (error) {
    console.error('❌ Cloudinary deletion error:', error.message);
    return false;
  }
};

// ===============================
// GET ALL
// ===============================

exports.getAll = async (req, res) => {
  try {
    const categoria = req.query.categoria?.trim().substring(0, 200);
    const search = req.query.search?.trim().substring(0, 200);
    const status = req.query.status;
    const min_price = req.query.min_price ? parseFloat(req.query.min_price) : undefined;
    const max_price = req.query.max_price ? parseFloat(req.query.max_price) : undefined;
    
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (categoria) {
      whereConditions.push(`c.slug = $${paramIndex}`);
      queryParams.push(categoria);
      paramIndex++;
    }

    if (search) {
      const sanitizedSearch = search.replace(/[%_\\]/g, '\\$&');
      whereConditions.push(`(p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`);
      queryParams.push(`%${sanitizedSearch}%`);
      paramIndex++;
    }

    if (status) {
      const validStatuses = ['pending_first_purchase', 'out_of_stock', 'low_stock', 'in_stock'];
      if (validStatuses.includes(status)) {
        switch (status) {
          case 'pending_first_purchase':
            whereConditions.push(`(p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0))`);
            break;
          case 'out_of_stock':
            whereConditions.push(`(p.stock = 0 AND p.purchase_price > 0)`);
            break;
          case 'low_stock':
            whereConditions.push(`(p.stock > 0 AND p.stock <= 5)`);
            break;
          case 'in_stock':
            whereConditions.push(`(p.stock > 5)`);
            break;
        }
      }
    }

    if (min_price !== undefined && !isNaN(min_price)) {
      whereConditions.push(`p.price >= $${paramIndex}`);
      queryParams.push(min_price);
      paramIndex++;
    }

    if (max_price !== undefined && !isNaN(max_price)) {
      whereConditions.push(`p.price <= $${paramIndex}`);
      queryParams.push(max_price);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const queryText = `
      SELECT 
        p.id, p.name, p.price, p.stock, p.category_id, p.purchase_price, 
        p.markup_type, p.markup_value, p.description, p.created_at,
        c.name AS category_name, c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        COALESCE((SELECT CASE WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2) WHEN d.type = 'fixed' THEN GREATEST(p.price - d.value, 0) ELSE p.price END FROM discount_targets dt JOIN discounts d ON d.id = dt.discount_id WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text) OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text)) AND NOW() BETWEEN d.starts_at AND d.ends_at AND d.active = true LIMIT 1), p.price) AS final_price,
        (SELECT json_build_object('type', d.type, 'value', d.value, 'name', d.name) FROM discount_targets dt JOIN discounts d ON d.id = dt.discount_id WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text) OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text)) AND NOW() BETWEEN d.starts_at AND d.ends_at AND d.active = true LIMIT 1) AS active_discount,
        CASE WHEN p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0) THEN 'pending_first_purchase' WHEN p.stock = 0 AND p.purchase_price > 0 THEN 'out_of_stock' WHEN p.stock > 0 AND p.stock <= 5 THEN 'low_stock' ELSE 'in_stock' END AS inventory_status
      FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause} ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      db.query(queryText, queryParams),
      db.query(`SELECT COUNT(p.id) as count FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`, queryParams.slice(0, paramIndex - 1))
    ]);

    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      products: dataResult.rows,
      pagination: { total: totalCount, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }
    });

  } catch (error) {
    console.error("GET PRODUCTS ERROR:", error);
    res.status(500).json({ message: "Error al obtener productos" });
  }
};

// ===============================
// CREATE
// ===============================

exports.create = async (req, res) => {
  const client = await db.connect();

  try {
    const validatedData = productCreateSchema.parse({
      ...req.body,
      category_id: parseInt(req.body.category_id)
    });

    const images = Array.isArray(req.files) ? req.files : [];

    if (images.length === 0) {
      return res.status(400).json({ message: "Debe incluir al menos una imagen del producto" });
    }

    if (images.length > 10) {
      return res.status(400).json({ message: "Máximo 10 imágenes por producto" });
    }

    await client.query("BEGIN");

    const categoryCheck = await client.query("SELECT id FROM categories WHERE id = $1", [validatedData.category_id]);

    if (categoryCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    const productResult = await client.query(
      `INSERT INTO products (name, price, stock, category_id, description, purchase_price, markup_type, markup_value, created_at) VALUES ($1, 0, 0, $2, $3, NULL, NULL, NULL, NOW()) RETURNING id, name`,
      [validatedData.name, validatedData.category_id, validatedData.description || null]
    );

    const productId = productResult.rows[0].id;

    let orderMap = {};
    if (req.body.image_order) {
      try {
        const orderArray = JSON.parse(req.body.image_order);
        orderArray.forEach((filename, index) => {
          orderMap[filename] = index;
        });
      } catch (e) {
        console.log('Using default image order');
      }
    }

    for (let i = 0; i < images.length; i++) {
      const imageUrl = images[i].path || images[i].secure_url;
      const originalName = images[i].originalname;
      const displayOrder = orderMap[originalName] !== undefined ? orderMap[originalName] : i;

      await client.query(
        "INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1, $2, $3, $4)",
        [productId, imageUrl, i === 0, displayOrder]
      );
    }

    await client.query("COMMIT");
    
    res.status(201).json({ 
      id: productId,
      name: productResult.rows[0].name,
      message: "Producto creado correctamente",
      images_count: images.length
    });
    
  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos inválidos",
        errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
      });
    }

    console.error("CREATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// ===============================
// UPDATE (FIXED)
// ===============================

exports.update = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // ✅ FIX: Solo validar los campos que realmente necesitan validación
    const dataToValidate = {};
    if (req.body.name) dataToValidate.name = req.body.name;
    if (req.body.category_id) dataToValidate.category_id = parseInt(req.body.category_id);
    if (req.body.description !== undefined) dataToValidate.description = req.body.description;

    const validatedData = productUpdateSchema.parse(dataToValidate);

    const newImages = req.files || [];

    if (newImages.length > 10) {
      return res.status(400).json({ message: "Máximo 10 imágenes por producto" });
    }

    await client.query("BEGIN");

    const productCheck = await client.query("SELECT id FROM products WHERE id = $1", [id]);

    if (productCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    if (validatedData.category_id) {
      const categoryCheck = await client.query("SELECT id FROM categories WHERE id = $1", [validatedData.category_id]);

      if (categoryCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Categoría no encontrada" });
      }
    }

    const currentImagesQuery = await client.query(
      "SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY display_order ASC",
      [id]
    );
    const currentImages = currentImagesQuery.rows;
    
    // ✅ FIX: Parsear deleted_image_ids correctamente
    let idsToDelete = [];
    if (req.body.deleted_image_ids) {
      try {
        const parsed = typeof req.body.deleted_image_ids === 'string' 
          ? JSON.parse(req.body.deleted_image_ids)
          : req.body.deleted_image_ids;
        
        idsToDelete = Array.isArray(parsed) 
          ? parsed.map(id => parseInt(id)).filter(id => !isNaN(id))
          : [];
      } catch (e) {
        console.error('Error parsing deleted_image_ids:', e);
      }
    }

    const remainingImagesCount = currentImages.filter(img => !idsToDelete.includes(img.id)).length;
    const totalFinalImages = remainingImagesCount + newImages.length;

    if (totalFinalImages < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El producto debe tener al menos una imagen" });
    }

    // ✅ FIX: Actualizar solo los campos presentes
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (validatedData.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(validatedData.name);
    }

    if (validatedData.category_id !== undefined) {
      updates.push(`category_id = $${paramCount++}`);
      values.push(validatedData.category_id);
    }

    if (validatedData.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(validatedData.description);
    }

    if (updates.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE products SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
        values
      );
    }

    // Eliminar imágenes
    if (idsToDelete.length > 0) {
      const imagesToDelete = currentImages.filter(img => idsToDelete.includes(img.id));
      
      for (const img of imagesToDelete) {
        await deleteFromCloudinary(img.url);
        await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
      }
    }

    // Agregar nuevas imágenes
    if (newImages.length > 0) {
      const isFirstNew = remainingImagesCount === 0;
      const startOrder = remainingImagesCount;

      for (let i = 0; i < newImages.length; i++) {
        const imageUrl = newImages[i].path || newImages[i].secure_url;
        await client.query(
          "INSERT INTO product_images (product_id, url, is_main, display_order) VALUES ($1, $2, $3, $4)",
          [id, imageUrl, isFirstNew && i === 0, startOrder + i]
        );
      }
    }

    // ✅ FIX: Actualizar orden de imágenes
    if (req.body.image_order) {
      try {
        const orderArray = JSON.parse(req.body.image_order);
        for (let i = 0; i < orderArray.length; i++) {
          const imageId = parseInt(orderArray[i]);
          if (!isNaN(imageId)) {
            await client.query(
              "UPDATE product_images SET display_order = $1 WHERE id = $2 AND product_id = $3",
              [i, imageId, id]
            );
          }
        }
      } catch (e) {
        console.log('Error updating image order:', e.message);
      }
    }

    // Asegurar que hay una imagen principal
    await client.query("UPDATE product_images SET is_main = false WHERE product_id = $1", [id]);
    await client.query(
      `UPDATE product_images SET is_main = true WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY display_order ASC LIMIT 1)`,
      [id]
    );

    await client.query("COMMIT");
    
    res.json({ 
      message: "Producto actualizado correctamente",
      images_added: newImages.length,
      images_deleted: idsToDelete.length
    });

  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos inválidos",
        errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
      });
    }

    console.error("UPDATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al actualizar producto" });
  } finally {
    client.release();
  }
};

// ===============================
// DELETE
// ===============================

exports.remove = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    await client.query("BEGIN");

    const salesCheck = await client.query("SELECT COUNT(*) as count FROM sale_items WHERE product_id = $1", [id]);

    if (parseInt(salesCheck.rows[0].count) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No se puede eliminar: el producto tiene ventas asociadas" });
    }

    const imagesResult = await client.query("SELECT url FROM product_images WHERE product_id = $1", [id]);

    for (const image of imagesResult.rows) {
      await deleteFromCloudinary(image.url);
    }

    const result = await client.query("DELETE FROM products WHERE id = $1 RETURNING id", [id]);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await client.query("COMMIT");
    
    res.json({ message: "Producto eliminado correctamente", id: result.rows[0].id });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DELETE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al eliminar producto" });
  } finally {
    client.release();
  }
};

// ===============================
// GET BY ID
// ===============================

exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        COALESCE((SELECT CASE WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2) WHEN d.type = 'fixed' THEN GREATEST(p.price - d.value, 0) ELSE p.price END FROM discount_targets dt JOIN discounts d ON d.id = dt.discount_id WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text) OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text)) AND NOW() BETWEEN d.starts_at AND d.ends_at AND d.active = true LIMIT 1), p.price) AS final_price,
        CASE WHEN p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0) THEN 'pending_first_purchase' WHEN p.stock = 0 AND p.purchase_price > 0 THEN 'out_of_stock' WHEN p.stock > 0 AND p.stock <= 5 THEN 'low_stock' ELSE 'in_stock' END AS inventory_status
      FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const imagesResult = await db.query(
      "SELECT id, url, is_main, display_order FROM product_images WHERE product_id = $1 ORDER BY display_order ASC",
      [id]
    );

    res.json({ ...result.rows[0], images: imagesResult.rows });

  } catch (error) {
    console.error("GET PRODUCT BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener producto" });
  }
};

module.exports = exports;