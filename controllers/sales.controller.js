const db = require("../config/db");

// 1. INSERTAR VENTAS
exports.createSale = async (req, res) => {
  const { items, total, sale_type, customer_id } = req.body;

  const client = await db.connect();

  try {
    if (!items || items.length === 0) {
      return res.status(400).json({ message: "La venta no tiene productos" });
    }

    if (!customer_id) {
      return res.status(400).json({ message: "Debes seleccionar un cliente" });
    }

    await client.query("BEGIN");

    const pStatus = (sale_type === "online") ? "pending" : "paid";

    const saleResult = await client.query(
      `INSERT INTO sales (total, customer_id, sale_type, payment_status)
      VALUES ($1, $2, $3, $4)
      RETURNING id`,
      [total, customer_id, sale_type || "fisica", pStatus]
    );

    const saleId = saleResult.rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price)
        VALUES ($1, $2, $3, $4)`,
        [saleId, item.id, item.quantity, item.price]
      );

      const stockResult = await client.query(
        `UPDATE products 
        SET stock = stock - $1 
        WHERE id = $2 AND stock >= $1`,
        [item.quantity, item.id]
      );

      if (stockResult.rowCount === 0) {
        throw new Error(`Stock insuficiente para el producto ID: ${item.id}`);
      }
    }

    await client.query(
      `UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2`,
      [total, customer_id]
    );

    await client.query("COMMIT");
    res.status(201).json({ 
      message: "Venta registrada con éxito", 
      saleId,
      orderCode: `AL-${saleId}-${new Date().getFullYear()}`
    });

  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
};

// 2. Obtener historial del usuario (sin autenticación, usar query param)
exports.getUserSales = async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  try {
    const result = await db.query(
      `SELECT id, total, sale_type, payment_status, created_at 
      FROM sales 
      WHERE customer_id = $1 
      ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener pedidos" });
  }
};

// 3. Estadísticas del usuario
exports.getUserStats = async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  try {
    const summary = await db.query(
      `SELECT 
        COUNT(*) as total_orders, 
        SUM(total) as total_invested,
        (SELECT name FROM products WHERE id = (
          SELECT product_id FROM sale_items si 
          JOIN sales s ON s.id = si.sale_id 
          WHERE s.customer_id = $1 GROUP BY product_id ORDER BY SUM(quantity) DESC LIMIT 1
        )) as favorite_product
      FROM sales WHERE customer_id = $1`,
      [userId]
    );

    const chart = await db.query(
      `SELECT 
        TO_CHAR(created_at, 'Mon') as month, 
        SUM(total) as amount 
      FROM sales 
      WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '6 months'
      GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC`,
      [userId]
    );

    res.json({ summary: summary.rows[0], chart: chart.rows });
  } catch (error) {
    res.status(500).json({ message: "Error al generar estadísticas" });
  }
};

// 4. Obtener detalles de venta por ID
exports.getSaleById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT p.name, si.quantity, si.unit_price
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" });
    }

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 5. Obtener todas las ventas
exports.getSales = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id,
        s.total as total,
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
    res.status(500).json({ message: "Error al obtener ventas" });
  }
};