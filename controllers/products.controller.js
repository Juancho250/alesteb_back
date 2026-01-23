const db = require("../config/db");

// Obtener todos los productos
// controllers/products.controller.js

exports.getAll = async (req, res) => {
  const { categoria } = req.query; // Capturamos el slug de la URL (?categoria=slug)

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
    
    // Si viene categoría, añadimos el WHERE usando el slug
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

// Crear producto
exports.create = async (req, res) => {
  const { name, price, stock, category_id, description } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      INSERT INTO products (name, price, stock, category_id, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [name, price, stock, category_id, description]
    );

    const productId = productResult.rows[0].id;

    if (images.length > 0) {
      const insertImageQuery = `
        INSERT INTO product_images (product_id, url, is_main)
        VALUES ($1, $2, $3)
      `;

      for (let i = 0; i < images.length; i++) {
        const imageUrl = images[i].path || images[i].secure_url;

        await client.query(insertImageQuery, [
          productId,
          imageUrl,
          i === 0 // primera imagen = principal
        ]);
      }
    }

    await client.query("COMMIT");

    res.status(201).json({ id: productId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al crear producto" });
  } finally {
    client.release();
  }
};

// Actualizar producto
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, price, stock, category_id, description } = req.body;

  try {
    const result = await db.query(
      `
      UPDATE products
      SET name = $1,
          price = $2,
          stock = $3,
          category_id = $4,
          description = $5
      WHERE id = $6
      `,
      [name, price, stock, category_id, description, id]
    );

    res.json({ updated: result.rowCount });
  } catch (error) {
    console.error("UPDATE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al actualizar producto" });
  }
};


// Eliminar producto
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "DELETE FROM products WHERE id = $1",
      [id]
    );

    res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error("DELETE PRODUCT ERROR:", error);
    res.status(500).json({ message: "Error al eliminar producto" });
  }
};

exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(`
      SELECT 
        p.*,
        c.name AS category_name, -- ✅ Obtenemos nombre de categoría
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
      LEFT JOIN categories c ON p.category_id = c.id -- ✅ Unión con categorías
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product' AND dt.target_id = p.id::text) OR 
        (dt.target_type = 'category' AND dt.target_id = p.category_id::text) -- ✅ Cambio a category_id
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
      `SELECT id, url, is_main FROM product_images WHERE product_id = $1`,
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

