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
  category_id: z.number()
    .int()
    .positive("Categoría inválida"),
  description: z.string()
    .max(2000, "Descripción demasiado larga")
    .trim()
    .optional(),
  image_order: z.string()
    .optional()
});

const productUpdateSchema = z.object({
  name: z.string()
    .min(3, "El nombre debe tener al menos 3 caracteres")
    .max(200, "El nombre no puede exceder 200 caracteres")
    .trim()
    .optional(),
  price: z.number()
    .min(0, "El precio no puede ser negativo")
    .max(999999999, "Precio demasiado alto")
    .optional(),
  category_id: z.number()
    .int()
    .positive()
    .optional(),
  description: z.string()
    .max(2000, "Descripción demasiado larga")
    .trim()
    .optional(),
  deleted_image_ids: z.string()
    .or(z.array(z.union([z.string(), z.number()])))
    .optional(),
  image_order: z.string()
    .optional()
});

// ===============================
// UTILIDADES
// ===============================

const getPublicIdFromUrl = (url) => {
  try {
    if (!url) return null;
    
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
    console.error('Error extracting public_id:', {
      message: error.message,
      url
    });
    return null;
  }
};

const deleteFromCloudinary = async (url) => {
  try {
    if (!url) return false;
    
    const publicId = getPublicIdFromUrl(url);
    if (publicId) {
      await cloudinary.uploader.destroy(publicId);
      console.log(`✅ Deleted from Cloudinary: ${publicId}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Cloudinary deletion error:', {
      message: error.message,
      url
    });
    return false;
  }
};

// ===============================
// GET ALL PRODUCTS
// ===============================

exports.getAll = async (req, res) => {
  try {
    const { 
      categoria, 
      page = 1, 
      limit = 100, 
      search = "",
      status,
      min_price,
      max_price
    } = req.query;

    // Validar paginación
    const validPage = Math.max(1, parseInt(page) || 1);
    const validLimit = Math.min(100, Math.max(1, parseInt(limit) || 100));
    const offset = (validPage - 1) * validLimit;

    let whereClause = [];
    let queryParams = [];
    let paramIndex = 1;

    // Filtro por categoría (slug)
    if (categoria) {
      whereClause.push(`c.slug = $${paramIndex}`);
      queryParams.push(categoria);
      paramIndex++;
    }

    // Búsqueda por texto
    if (search.trim()) {
      whereClause.push(`(p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`);
      queryParams.push(`%${search.trim()}%`);
      paramIndex++;
    }

    // Filtro por estado de inventario
    if (status) {
      const validStatuses = ['pending_first_purchase', 'out_of_stock', 'low_stock', 'in_stock'];
      if (validStatuses.includes(status)) {
        switch (status) {
          case 'pending_first_purchase':
            whereClause.push(`p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0)`);
            break;
          case 'out_of_stock':
            whereClause.push(`p.stock = 0 AND p.purchase_price > 0`);
            break;
          case 'low_stock':
            whereClause.push(`p.stock > 0 AND p.stock <= 5`);
            break;
          case 'in_stock':
            whereClause.push(`p.stock > 5`);
            break;
        }
      }
    }

    // Filtro por rango de precios
    if (min_price && !isNaN(parseFloat(min_price))) {
      whereClause.push(`p.price >= $${paramIndex}`);
      queryParams.push(parseFloat(min_price));
      paramIndex++;
    }

    if (max_price && !isNaN(parseFloat(max_price))) {
      whereClause.push(`p.price <= $${paramIndex}`);
      queryParams.push(parseFloat(max_price));
      paramIndex++;
    }

    const whereString = whereClause.length > 0 ? `WHERE ${whereClause.join(" AND ")}` : "";

    const queryText = `
      SELECT 
        p.id, 
        p.name, 
        p.price, 
        p.stock, 
        p.category_id,
        p.purchase_price, 
        p.markup_type, 
        p.markup_value,
        p.created_at,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        
        -- Precio final con descuentos activos
        COALESCE(
          (SELECT 
            CASE 
              WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
              WHEN d.type = 'fixed' THEN GREATEST(p.price - d.value, 0)
              ELSE p.price
            END
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE ((dt.target_type = 'product' AND dt.target_id = p.id)
               OR (dt.target_type = 'category' AND dt.target_id = p.category_id))
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
        
        -- Información del descuento activo
        (SELECT json_build_object(
          'type', d.type,
          'value', d.value,
          'name', d.name
        )
         FROM discount_targets dt
         JOIN discounts d ON d.id = dt.discount_id
         WHERE ((dt.target_type = 'product' AND dt.target_id = p.id)
             OR (dt.target_type = 'category' AND dt.target_id = p.category_id))
           AND NOW() BETWEEN d.starts_at AND d.ends_at
           AND d.active = true
         LIMIT 1
        ) AS active_discount,
        
        -- Estado del inventario
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

    queryParams.push(validLimit, offset);

    // Ejecutar queries en paralelo
    const [dataResult, countResult] = await Promise.all([
      db.query(queryText, queryParams),
      db.query(`
        SELECT COUNT(p.id) 
        FROM products p 
        LEFT JOIN categories c ON p.category_id = c.id 
        ${whereString}
      `, queryParams.slice(0, paramIndex - 1))
    ]);

    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      products: dataResult.rows,
      pagination: {
        total: totalCount,
        page: validPage,
        limit: validLimit,
        totalPages: Math.ceil(totalCount / validLimit),
        hasNext: validPage < Math.ceil(totalCount / validLimit),
        hasPrev: validPage > 1
      }
    });

  } catch (error) {
    console.error("GET PRODUCTS ERROR:", {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    res.status(500).json({ message: "Error al obtener productos" });
  }
};

// ===============================
// CREATE PRODUCT
// ===============================

exports.create = async (req, res) => {
  const client = await db.connect();

  try {
    // Validar datos
    const validatedData = productCreateSchema.parse({
      ...req.body,
      category_id: parseInt(req.body.category_id)
    });

    const images = Array.isArray(req.files) ? req.files : [];

    if (images.length === 0) {
      return res.status(400).json({ 
        message: "Debe incluir al menos una imagen del producto" 
      });
    }

    if (images.length > 10) {
      return res.status(400).json({ 
        message: "Máximo 10 imágenes por producto" 
      });
    }

    await client.query("BEGIN");

    // Verificar que la categoría existe
    const categoryCheck = await client.query(
      "SELECT id FROM categories WHERE id = $1",
      [validatedData.category_id]
    );

    if (categoryCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    // Crear producto con valores por defecto
    const productResult = await client.query(
      `INSERT INTO products (
        name, 
        price, 
        stock, 
        category_id, 
        description,
        purchase_price,
        markup_type,
        markup_value,
        created_at
      )
       VALUES ($1, 0, 0, $2, $3, NULL, NULL, NULL, NOW()) 
       RETURNING id, name`,
      [validatedData.name, validatedData.category_id, validatedData.description || null]
    );

    const productId = productResult.rows[0].id;

    // Procesar orden de imágenes
    let orderMap = {};
    if (validatedData.image_order) {
      try {
        const orderArray = JSON.parse(validatedData.image_order);
        orderArray.forEach((filename, index) => {
          orderMap[filename] = index;
        });
      } catch (e) {
        console.log('Using default image order');
      }
    }

    // Insertar imágenes
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
        i === 0, // Primera imagen es main por defecto
        displayOrder
      ]);
    }

    await client.query("COMMIT");
    
    res.status(201).json({ 
      id: productId,
      name: productResult.rows[0].name,
      message: "Producto agregado al catálogo. Configura precio y stock en 'Órdenes de Compra'.",
      images_count: images.length
    });
    
  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("CREATE PRODUCT ERROR:", {
      message: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// ===============================
// UPDATE PRODUCT
// ===============================

exports.update = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // Validar datos
    const validatedData = productUpdateSchema.parse({
      ...req.body,
      category_id: req.body.category_id ? parseInt(req.body.category_id) : undefined,
      price: req.body.price ? parseFloat(req.body.price) : undefined
    });

    const newImages = req.files || [];

    if (newImages.length > 10) {
      return res.status(400).json({ 
        message: "Máximo 10 imágenes por producto" 
      });
    }

    await client.query("BEGIN");

    // Verificar que el producto existe
    const productCheck = await client.query(
      "SELECT id FROM products WHERE id = $1",
      [id]
    );

    if (productCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    // Verificar categoría si se actualiza
    if (validatedData.category_id) {
      const categoryCheck = await client.query(
        "SELECT id FROM categories WHERE id = $1",
        [validatedData.category_id]
      );

      if (categoryCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Categoría no encontrada" });
      }
    }

    // Obtener imágenes actuales
    const currentImagesQuery = await client.query(
      "SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY display_order ASC",
      [id]
    );
    const currentImages = currentImagesQuery.rows;
    
    // Procesar eliminación de imágenes
    let idsToDelete = [];
    if (validatedData.deleted_image_ids) {
      idsToDelete = Array.isArray(validatedData.deleted_image_ids) 
        ? validatedData.deleted_image_ids 
        : JSON.parse(validatedData.deleted_image_ids);
      
      // Convertir a números
      idsToDelete = idsToDelete.map(id => parseInt(id)).filter(id => !isNaN(id));
    }

    const remainingImagesCount = currentImages.filter(
      img => !idsToDelete.includes(img.id)
    ).length;
    const totalFinalImages = remainingImagesCount + newImages.length;

    if (totalFinalImages < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        message: "El producto debe tener al menos una imagen" 
      });
    }

    // Construir query de actualización
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (validatedData.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(validatedData.name);
    }

    if (validatedData.price !== undefined) {
      updates.push(`price = $${paramCount++}`);
      values.push(validatedData.price);
    }

    if (validatedData.category_id !== undefined) {
      updates.push(`category_id = $${paramCount++}`);
      values.push(validatedData.category_id);
    }

    if (validatedData.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(validatedData.description);
    }

    // Actualizar producto si hay cambios
    if (updates.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE products SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
        values
      );
    }

    // Eliminar imágenes marcadas
    if (idsToDelete.length > 0) {
      const imagesToDelete = currentImages.filter(img => idsToDelete.includes(img.id));
      
      for (const img of imagesToDelete) {
        await deleteFromCloudinary(img.url);
        await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
      }
    }

    // Insertar nuevas imágenes
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

    // Actualizar orden de imágenes
    if (validatedData.image_order) {
      try {
        const orderArray = JSON.parse(validatedData.image_order);
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
    
    res.json({ 
      message: "Producto actualizado correctamente",
      images_added: newImages.length,
      images_deleted: idsToDelete.length
    });

  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("UPDATE PRODUCT ERROR:", {
      message: error.message,
      productId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: error.message || "Error al actualizar producto" });
  } finally {
    client.release();
  }
};

// ===============================
// DELETE PRODUCT
// ===============================

exports.remove = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    await client.query("BEGIN");

    // Verificar que no tenga ventas asociadas
    const salesCheck = await client.query(
      "SELECT COUNT(*) as count FROM sale_items WHERE product_id = $1",
      [id]
    );

    if (parseInt(salesCheck.rows[0].count) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        message: "No se puede eliminar: el producto tiene ventas asociadas" 
      });
    }

    // Obtener y eliminar imágenes
    const imagesResult = await client.query(
      "SELECT url FROM product_images WHERE product_id = $1",
      [id]
    );

    for (const image of imagesResult.rows) {
      await deleteFromCloudinary(image.url);
    }

    // Eliminar producto (las imágenes se eliminan por CASCADE)
    const result = await client.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await client.query("COMMIT");
    
    res.json({ 
      message: "Producto eliminado correctamente",
      id: result.rows[0].id
    });

  } catch (error) {
    await client.query("ROLLBACK");
    
    console.error("DELETE PRODUCT ERROR:", {
      message: error.message,
      productId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al eliminar producto" });
  } finally {
    client.release();
  }
};

// ===============================
// GET PRODUCT BY ID
// ===============================

exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(`
      SELECT 
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        
        -- Información del descuento
        (SELECT json_build_object(
          'id', d.id,
          'name', d.name,
          'type', d.type,
          'value', d.value,
          'starts_at', d.starts_at,
          'ends_at', d.ends_at
        )
         FROM discount_targets dt
         JOIN discounts d ON dt.discount_id = d.id
         WHERE ((dt.target_type = 'product' AND dt.target_id = p.id)
             OR (dt.target_type = 'category' AND dt.target_id = p.category_id))
           AND NOW() BETWEEN d.starts_at AND d.ends_at
           AND d.active = true
         ORDER BY CASE 
           WHEN d.type = 'percentage' THEN p.price - (p.price * (d.value / 100))
           ELSE p.price - d.value
         END ASC
         LIMIT 1
        ) AS active_discount,
        
        -- Precio final
        COALESCE(
          (SELECT 
            CASE 
              WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
              WHEN d.type = 'fixed' THEN GREATEST(p.price - d.value, 0)
              ELSE p.price
            END
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE ((dt.target_type = 'product' AND dt.target_id = p.id)
               OR (dt.target_type = 'category' AND dt.target_id = p.category_id))
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND d.active = true
           LIMIT 1
          ),
          p.price
        ) AS final_price,
        
        -- Estado del inventario
        CASE
          WHEN p.stock = 0 AND (p.purchase_price IS NULL OR p.purchase_price = 0) THEN 'pending_first_purchase'
          WHEN p.stock = 0 AND p.purchase_price > 0 THEN 'out_of_stock'
          WHEN p.stock > 0 AND p.stock <= 5 THEN 'low_stock'
          ELSE 'in_stock'
        END AS inventory_status
        
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    // Obtener todas las imágenes
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
    console.error("GET PRODUCT BY ID ERROR:", {
      message: error.message,
      productId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener producto" });
  }
};

// ===============================
// GET PURCHASE HISTORY
// ===============================

exports.getPurchaseHistory = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

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
        END as markup,
        (poi.suggested_price - poi.unit_cost) as unit_profit,
        CASE
          WHEN poi.unit_cost > 0 THEN
            ROUND(((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100)::numeric, 2)
          ELSE 0
        END as profit_margin_percent
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.order_id = po.id
      JOIN providers pr ON po.provider_id = pr.id
      WHERE poi.product_id = $1
      ORDER BY po.created_at DESC
      LIMIT 50
    `, [id]);

    res.json(result.rows);

  } catch (error) {
    console.error("GET PURCHASE HISTORY ERROR:", {
      message: error.message,
      productId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener historial de compras" });
  }
};

module.exports = exports;