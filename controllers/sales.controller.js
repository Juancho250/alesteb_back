const db = require("../config/db");

// Crear venta
// Crear venta
exports.createSale = async (req, res) => {
  // Ahora recibimos customer_id y sale_type desde el Modal del Frontend
  const { items, total, customer_id, sale_type } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Venta vacía" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Insertar en la tabla sales incluyendo el cliente y tipo de venta
    const saleResult = await client.query(
      `
      INSERT INTO sales (total_amount, customer_id, sale_type, payment_status)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [total, customer_id, sale_type || 'fisica', 'paid']
    );

    const saleId = saleResult.rows[0].id;

    // 2. Insertar items y actualizar stock
    for (const item of items) {
      await client.query(
        `
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price)
        VALUES ($1, $2, $3, $4)
        `,
        [saleId, item.id, item.quantity, item.price]
      );

      // 3. Actualizar stock
      const stockResult = await client.query(
        `
        UPDATE products
        SET stock = stock - $1
        WHERE id = $2 AND stock >= $1
        `,
        [item.quantity, item.id]
      );

      if (stockResult.rowCount === 0) {
        throw new Error(`Stock insuficiente para el producto ID: ${item.id}`);
      }
    }

    // 4. ACTUALIZAR ESTADÍSTICAS DEL CLIENTE (Opcional pero recomendado)
    if (customer_id) {
      await client.query(
        `
        UPDATE users 
        SET total_spent = total_spent + $1,
            orders_count = orders_count + 1,
            last_purchase = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [total, customer_id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Venta registrada con éxito",
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
        s.total_amount as total,
        s.sale_type,
        s.created_at,
        u.name as customer_name,
        (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS items_count
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
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
