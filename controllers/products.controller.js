const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// ============================================
// 🛠️ FUNCIONES AUXILIARES
// ============================================

/**
 * Extraer public_id de una URL de Cloudinary
 */
const getPublicIdFromUrl = (url) => {
  try {
    if (!url || typeof url !== 'string') return null;
    
    // Ejemplo: https://res.cloudinary.com/demo/image/upload/v1234567890/folder/image.jpg
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    
    const pathWithVersion = parts[1];
    const pathParts = pathWithVersion.split('/');
    
    // Remover versión (v1234567890) si existe
    const relevantParts = pathParts.filter(part => !part.startsWith('v'));
    
    // Unir path y remover extensión
    const fullPath = relevantParts.join('/');
    return fullPath.replace(/\.[^/.]+$/, '');
  } catch (error) {
    console.error("Error al extraer public_id:", error);
    return null;
  }
};

/**
 * Validar datos de producto
 */
const validateProductData = (data, isUpdate = false) => {
  const errors = [];

  if (!isUpdate || data.name !== undefined) {
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      errors.push('Nombre del producto es requerido');
    } else if (data.name.length > 200) {
      errors.push('Nombre demasiado largo (máximo 200 caracteres)');
    }
  }

  if (!isUpdate || data.sale_price !== undefined) {
    const price = Number(data.sale_price);
    if (isNaN(price) || price < 0) {
      errors.push('Precio debe ser un número positivo');
    }
  }

  if (!isUpdate || data.stock !== undefined) {
    const stock = Number(data.stock);
    if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) {
      errors.push('Stock debe ser un número entero positivo');
    }
  }

  if (!isUpdate && !data.category_id) {
    errors.push('Categoría es requerida');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
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
        best_discount.type AS discount_type,
        best_discount.value AS discount_value,
        COALESCE(best_discount.final_price, p.sale_price) AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN LATERAL (
        SELECT d.type, d.value,
          CASE 
            WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
            WHEN d.type = 'fixed' THEN p.sale_price - d.value
            ELSE p.sale_price
          END AS final_price
        FROM discount_targets dt
        JOIN discounts d ON d.id = dt.discount_id
        WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
           OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
          AND NOW() BETWEEN d.starts_at AND d.ends_at
        ORDER BY final_price ASC LIMIT 1
      ) best_discount ON true
      WHERE 1=1
    `;

    const queryParams = [];
    let paramIndex = 1;

    // Filtro por categoría
    if (categoria) {
      queryText += ` AND c.slug = $${paramIndex}`;
      queryParams.push(categoria);
      paramIndex++;
    }

    // Filtro por búsqueda
    if (search) {
      queryText += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    // Filtro por precio mínimo
    if (min_price) {
      queryText += ` AND p.sale_price >= $${paramIndex}`;
      queryParams.push(Number(min_price));
      paramIndex++;
    }

    // Filtro por precio máximo
    if (max_price) {
      queryText += ` AND p.sale_price <= $${paramIndex}`;
      queryParams.push(Number(max_price));
      paramIndex++;
    }

    queryText += ` ORDER BY p.created_at DESC`;

    // Paginación
    queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(Number(limit), Number(offset));

    const result = await db.query(queryText, queryParams);
    
    // Obtener total de productos (para paginación)
    const countResult = await db.query(
      `SELECT COUNT(*) FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1 ${
        categoria ? 'AND c.slug = $1' : ''
      }`,
      categoria ? [categoria] : []
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: Number(countResult.rows[0].count),
        limit: Number(limit),
        offset: Number(offset),
        hasMore: Number(offset) + result.rows.length < Number(countResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener productos" 
    });
  }
};

// ============================================
// 🔍 OBTENER PRODUCTO POR ID
// ============================================

exports.getById = async (req, res) => {
  try {
    const { id } = req.params;

    // Validar que el ID sea un número válido
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido"
      });
    }

    const result = await db.query(`
      SELECT 
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        d.name AS discount_name,
        d.type AS discount_type,
        d.value AS discount_value,
        CASE 
          WHEN d.type = 'percentage' THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.sale_price - d.value
          ELSE p.sale_price
        END AS final_price
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

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Producto no encontrado" 
      });
    }

    // Obtener todas las imágenes del producto
    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images 
       WHERE product_id = $1 
       ORDER BY is_main DESC, display_order ASC`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        images: imagesResult.rows
      }
    });

  } catch (error) {
    console.error("[GET PRODUCT BY ID ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener producto" 
    });
  }
};

// ============================================
// ➕ CREAR PRODUCTO
// ============================================

exports.create = async (req, res) => {
  const client = await db.connect();

  try {
    const { name, sale_price, stock, category_id, description } = req.body;
    const images = Array.isArray(req.files) ? req.files : [];

    // Validar datos del producto
    const validation = validateProductData(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.errors.join(', ')
      });
    }

    // Validar que haya al menos una imagen
    if (images.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "Debe subir al menos una imagen" 
      });
    }

    await client.query("BEGIN");

    // Crear el producto
    const productResult = await client.query(
      `INSERT INTO products (name, sale_price, stock, category_id, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        name.trim(), 
        Number(sale_price), 
        Number(stock), 
        category_id, 
        description?.trim() || null
      ]
    );

    const productId = productResult.rows[0].id;

    // Insertar imágenes
    const insertImageQuery = `
      INSERT INTO product_images (product_id, url, is_main, display_order)
      VALUES ($1, $2, $3, $4)
    `;

    for (let i = 0; i < images.length; i++) {
      const imageUrl = images[i].path || images[i].secure_url;
      await client.query(insertImageQuery, [
        productId,
        imageUrl,
        i === 0, // Primera imagen es la principal
        i
      ]);
    }

    await client.query("COMMIT");

    res.status(201).json({ 
      success: true,
      message: "Producto creado correctamente",
      data: { id: productId }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE PRODUCT ERROR]", error);
    
    // Si el error es de foreign key (categoría no existe)
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: "La categoría especificada no existe"
      });
    }

    res.status(500).json({ 
      success: false,
      message: "Error al crear producto" 
    });
  } finally {
    client.release();
  }
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

    // Validar ID
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido"
      });
    }

    // Validar datos del producto
    const validation = validateProductData(req.body, true);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.errors.join(', ')
      });
    }

    await client.query("BEGIN");

    // Verificar que el producto existe
    const productExists = await client.query(
      "SELECT id FROM products WHERE id = $1",
      [id]
    );

    if (productExists.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado"
      });
    }

    // 1. Validar mínimo de imágenes
    const currentImagesQuery = await client.query(
      "SELECT id, url FROM product_images WHERE product_id = $1", 
      [id]
    );
    const currentImages = currentImagesQuery.rows;
    
    let idsToDelete = [];
    if (deleted_image_ids) {
      try {
        idsToDelete = Array.isArray(deleted_image_ids) 
          ? deleted_image_ids 
          : JSON.parse(deleted_image_ids);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: "Formato inválido de deleted_image_ids"
        });
      }
    }

    const remainingImagesCount = currentImages.filter(
      img => !idsToDelete.includes(img.id.toString()) && !idsToDelete.includes(img.id)
    ).length;
    
    const totalFinalImages = remainingImagesCount + newImages.length;

    if (totalFinalImages < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "El producto debe tener al menos una imagen"
      });
    }

    // 2. Actualizar datos básicos
    await client.query(
      `UPDATE products 
       SET name = $1, sale_price = $2, stock = $3, category_id = $4, description = $5, updated_at = NOW()
       WHERE id = $6`,
      [
        name?.trim() || null, 
        sale_price ? Number(sale_price) : null, 
        stock !== undefined ? Number(stock) : null, 
        category_id || null, 
        description?.trim() || null, 
        id
      ]
    );

    // 3. Eliminar imágenes marcadas
    if (idsToDelete.length > 0) {
      const imagesToDelete = currentImages.filter(img => 
        idsToDelete.includes(img.id.toString()) || idsToDelete.includes(img.id)
      );
      
      for (const img of imagesToDelete) {
        // Borrar de Cloudinary
        const publicId = getPublicIdFromUrl(img.url);
        if (publicId) {
          try {
            await cloudinary.uploader.destroy(publicId);
          } catch (cloudinaryError) {
            console.error("Error al eliminar de Cloudinary:", cloudinaryError);
            // No fallar la transacción por esto
          }
        }
        
        // Borrar de BD
        await client.query("DELETE FROM product_images WHERE id = $1", [img.id]);
      }
    }

    // 4. Subir nuevas imágenes
    if (newImages.length > 0) {
      const maxDisplayOrder = await client.query(
        "SELECT COALESCE(MAX(display_order), -1) as max_order FROM product_images WHERE product_id = $1",
        [id]
      );
      let nextOrder = maxDisplayOrder.rows[0].max_order + 1;

      const insertImageQuery = `
        INSERT INTO product_images (product_id, url, is_main, display_order) 
        VALUES ($1, $2, $3, $4)
      `;
      
      const isFirstNew = remainingImagesCount === 0;

      for (let i = 0; i < newImages.length; i++) {
        const imageUrl = newImages[i].path || newImages[i].secure_url;
        await client.query(insertImageQuery, [
          id, 
          imageUrl, 
          isFirstNew && i === 0, // Solo si no hay otras y es la primera nueva
          nextOrder + i
        ]);
      }
    }

    // 5. Asegurar que haya una imagen principal
    const hasMain = await client.query(
      "SELECT id FROM product_images WHERE product_id = $1 AND is_main = true LIMIT 1",
      [id]
    );

    if (hasMain.rowCount === 0) {
      await client.query(`
        UPDATE product_images SET is_main = true 
        WHERE id = (
          SELECT id FROM product_images 
          WHERE product_id = $1 
          ORDER BY display_order ASC 
          LIMIT 1
        )
      `, [id]);
    }

    await client.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Producto actualizado correctamente" 
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE PRODUCT ERROR]", error);
    
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: "La categoría especificada no existe"
      });
    }

    res.status(500).json({ 
      success: false,
      message: error.message || "Error al actualizar producto" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🗑️ ELIMINAR PRODUCTO
// ============================================

exports.remove = async (req, res) => {
  const client = await db.connect();

  try {
    const { id } = req.params;

    // Validar ID
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "ID de producto inválido"
      });
    }

    await client.query("BEGIN");

    // Verificar que el producto existe
    const productExists = await client.query(
      "SELECT id FROM products WHERE id = $1",
      [id]
    );

    if (productExists.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado"
      });
    }

    // Obtener imágenes antes de borrar
    const imagesResult = await client.query(
      "SELECT url FROM product_images WHERE product_id = $1",
      [id]
    );

    // Eliminar de Cloudinary
    for (const img of imagesResult.rows) {
      const publicId = getPublicIdFromUrl(img.url);
      if (publicId) {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (cloudinaryError) {
          console.error("Error al eliminar de Cloudinary:", cloudinaryError);
          // No fallar la transacción por esto
        }
      }
    }

    // Eliminar producto (CASCADE borrará las imágenes de la BD)
    const result = await client.query("DELETE FROM products WHERE id = $1", [id]);

    await client.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Producto eliminado correctamente",
      data: { deleted: result.rowCount }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE PRODUCT ERROR]", error);
    
    // Si hay restricción de foreign key (hay ventas con este producto)
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: "No se puede eliminar el producto porque tiene ventas asociadas"
      });
    }

    res.status(500).json({ 
      success: false,
      message: "Error al eliminar producto" 
    });
  } finally {
    client.release();
  }
};