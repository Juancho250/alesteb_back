const db = require("../config/db");

// Obtener todos los productos
exports.getAll = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        p.*,
        (SELECT url FROM product_images WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
        d.name AS discount_name,
        d.type AS discount_type,
        d.value AS discount_value,
        -- Usamos COALESCE para que si no hay descuento, el precio final sea el original
        CASE 
          WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
          WHEN d.type = 'fixed' THEN p.price - d.value
          ELSE p.price
        END AS final_price
      FROM products p
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product' AND dt.target_id = p.id::text) OR 
        (dt.target_type = 'category' AND dt.target_id = p.category)
      )
      LEFT JOIN discounts d ON dt.discount_id = d.id 
        -- IMPORTANTE: Verifica que la columna 'active' exista en tu tabla 'discounts'
        -- Y que los tipos de fecha coincidan
        AND NOW() BETWEEN d.starts_at AND d.ends_at
      ORDER BY p.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PRODUCTS ERROR:", error);
    res.status(500).json({ message: "Error al obtener productos" });
  }
};

// Crear producto
exports.create = async (req, res) => {
  const { name, price, stock, category } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      INSERT INTO products (name, price, stock, category)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [name, price, stock, category]
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
  const { name, price, stock } = req.body;

  try {
    const result = await db.query(
      `
      UPDATE products
      SET name = $1,
          price = $2,
          stock = $3
      WHERE id = $4
      `,
      [name, price, stock, id]
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
      LEFT JOIN discount_targets dt ON (
        (dt.target_type = 'product' AND dt.target_id = p.id::text) OR 
        (dt.target_type = 'category' AND dt.target_id = p.category)
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

