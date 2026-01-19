const db = require("../config/db");

// Crear venta
exports.createSale = async (req, res) => {
  const { items, total } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Venta vacía" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Crear venta
    const saleResult = await client.query(
      `
      INSERT INTO sales (total)
      VALUES ($1)
      RETURNING id
      `,
      [total]
    );

    const saleId = saleResult.rows[0].id;

    // Insertar items y actualizar stock
    for (const item of items) {
      // Insertar item
      await client.query(
        `
        INSERT INTO sale_items (sale_id, product_id, quantity, price)
        VALUES ($1, $2, $3, $4)
        `,
        [saleId, item.id, item.quantity, item.price]
      );

      // Actualizar stock (seguro)
      const stockResult = await client.query(
        `
        UPDATE products
        SET stock = stock - $1
        WHERE id = $2 AND stock >= $1
        `,
        [item.quantity, item.id]
      );

      if (stockResult.rowCount === 0) {
        throw new Error(`Stock insuficiente para producto ${item.id}`);
      }
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Venta registrada",
      saleId
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE SALE ERROR:", error);

    res.status(500).json({
      message: error.message || "Error al registrar venta"
    });
  } finally {
    client.release();
  }
};

// Obtener todas las ventas
exports.getSales = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id,
        s.total,
        s.created_at,
        COUNT(si.id) AS items
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET SALES ERROR:", error);
    res.status(500).json({ message: "Error al obtener ventas" });
  }
};

// Obtener venta por ID
exports.getSaleById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `
      SELECT 
        p.name,
        si.quantity,
        si.price
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      `,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET SALE BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener venta" });
  }
};
