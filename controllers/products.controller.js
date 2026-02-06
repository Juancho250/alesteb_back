const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

// Obtener todos los productos con filtros
exports.getAll = async (req, res) => {
  const { categoria } = req.query;

  try {
    let queryText = `
      SELECT 
        p.*,
        c.name AS category_name,
        c.slug AS category_slug,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        best_discount.type AS discount_type,
        best_discount.value AS discount_value,
        COALESCE(best_discount.final_price, p.price) AS final_price
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN LATERAL (
        SELECT d.type, d.value,
          CASE 
            WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
            WHEN d.type = 'fixed' THEN p.price - d.value
            ELSE p.price
          END AS final_price
        FROM discount_targets dt
        JOIN discounts d ON d.id = dt.discount_id
        WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
           OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
          AND NOW() BETWEEN d.starts_at AND d.ends_at
        ORDER BY final_price ASC LIMIT 1
      ) best_discount ON true
    `;

    const queryParams = [];
    
    if (categoria) {
      queryText += ` WHERE c.slug = $1`;
      queryParams.push(categoria);
    }

    queryText += ` ORDER BY p.created_at DESC`;

    const result = await db.query(queryText, queryParams);
    res.json(result.rows);
  } catch (error) {
    console.error("GET PRODUCTS ERROR:", error);
    res.status(500).json({ message: "Error al obtener productos" });
  }
};

// Obtener producto por ID
exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
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
          WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.price - d.value
          ELSE p.price
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

    if (!result.rows.length) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const imagesResult = await db.query(
      `SELECT id, url, is_main FROM product_images WHERE product_id = $1 ORDER BY is_main DESC, display_order ASC`,
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

// Crear producto
exports.create = async (req, res) => {
  const { name, price, stock, category_id, description } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];

  if (images.length === 0) {
    return res.status(400).json({ message: "Debe subir al menos una imagen" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `INSERT INTO products (name, price, stock, category_id, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, price, stock, category_id, description]
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
        i === 0, // Primera imagen = principal
        i
      ]);
    }

    await client.query("COMMIT");
    res.status(201).json({ id: productId, message: "Producto creado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// Función auxiliar para extraer public_id de Cloudinary
const getPublicIdFromUrl = (url) => {
  try {
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
    return null;
  }
};

// Actualizar producto
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, price, stock, category_id, description, deleted_image_ids } = req.body;
  const newImages = req.files || [];

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Validar mínimo de imágenes
    const currentImagesQuery = await client.query(
      "SELECT id, url FROM product_images WHERE product_id = $1", 
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

    // 2. Actualizar datos básicos
    await client.query(
      `UPDATE products 
       SET name = $1, price = $2, stock = $3, category_id = $4, description = $5 
       WHERE id = $6`,
      [name, price, stock, category_id, description, id]
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
    res.json({ message: "Producto actualizado correctamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("UPDATE PRODUCT ERROR:", error);
    res.status(500).json({ message: error.message || "Error al actualizar producto" });
  } finally {
    client.release();
  }
};

// Eliminar producto
exports.remove = async (req, res) => {
  const { id } = req.params;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

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
        }
      }
    }

    // Eliminar producto (CASCADE borrará las imágenes de la BD)
    const result = await client.query("DELETE FROM products WHERE id = $1", [id]);

    await client.query("COMMIT");
    res.json({ deleted: result.rowCount, message: "Producto eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DELETE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al eliminar producto" });
  } finally {
    client.release();
  }
};