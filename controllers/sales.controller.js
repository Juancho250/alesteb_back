const db = require("../config/db");

exports.createSale = async (req, res) => {
  const { items, total, customer_id, sale_type } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Insertar en sales 
    // Si falla aquí, es porque 'sale_type' no existe en tu tabla 'sales'
    const saleResult = await client.query(
      `INSERT INTO sales (total_amount, customer_id, sale_type, payment_status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [total, customer_id, sale_type || 'fisica', 'paid']
    );
    const saleId = saleResult.rows[0].id;

    // 2. Insertar items
    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, price)
         VALUES ($1, $2, $3, $4)`,
        [saleId, item.id, item.quantity, item.price]
      );

      // 3. Actualizar stock
      await client.query(
        `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
        [item.quantity, item.id]
      );
    }

    // 4. Actualizar total_spent (Opcional - envuelto en try/catch interno)
    try {
      if (customer_id) {
        await client.query(
          `UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2`,
          [total, customer_id]
        );
      }
    } catch (e) { 
      console.log("Nota: No se pudo actualizar total_spent, posiblemente falta la columna."); 
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Venta registrada con éxito", saleId });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR REAL EN BD:", error.message);
    res.status(500).json({ 
      message: "Error al registrar venta", 
      error: error.message // IMPORTANTE: Esto te dirá qué columna falta
    });
  } finally {
    client.release();
  }
};

// ACTUALIZA TAMBIÉN ESTA PARTE PARA QUE NO DE ERROR AL VER EL DETALLE
exports.getSaleById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT p.name, si.quantity, si.price 
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
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


