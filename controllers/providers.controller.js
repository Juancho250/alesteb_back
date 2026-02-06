const db = require("../config/db");

// ============================================
// OBTENER TODOS LOS PROVEEDORES
// ============================================
exports.getAll = async (req, res) => {
  const { is_active, category } = req.query;

  try {
    let query = "SELECT * FROM v_provider_balance WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (is_active !== undefined) {
      query += ` AND is_active = $${paramIndex}`;
      params.push(is_active === 'true');
      paramIndex++;
    }

    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    query += " ORDER BY name ASC";

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error("GET PROVIDERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener proveedores" });
  }
};

// ============================================
// OBTENER PROVEEDOR POR ID
// ============================================
exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "SELECT * FROM v_provider_balance WHERE id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error("GET PROVIDER BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener proveedor" });
  }
};

// ============================================
// CREAR PROVEEDOR
// ============================================
exports.create = async (req, res) => {
  const {
    name, category, phone, email, address, contact_person,
    tax_id, credit_limit, payment_terms_days, lead_time_days, notes
  } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO providers 
       (name, category, phone, email, address, contact_person, tax_id, 
        credit_limit, payment_terms_days, lead_time_days, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        name, category, phone, email, address, contact_person, tax_id,
        credit_limit || 0, payment_terms_days || 30, lead_time_days || 7, notes
      ]
    );

    res.status(201).json({
      message: "Proveedor creado exitosamente",
      provider: result.rows[0]
    });

  } catch (error) {
    console.error("CREATE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al crear proveedor" });
  }
};

// ============================================
// ACTUALIZAR PROVEEDOR
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const {
    name, category, phone, email, address, contact_person, tax_id,
    credit_limit, payment_terms_days, lead_time_days, reliability_score,
    is_active, notes
  } = req.body;

  try {
    const result = await db.query(
      `UPDATE providers SET
        name = $1, category = $2, phone = $3, email = $4, address = $5,
        contact_person = $6, tax_id = $7, credit_limit = $8, 
        payment_terms_days = $9, lead_time_days = $10, 
        reliability_score = $11, is_active = $12, notes = $13,
        updated_at = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        name, category, phone, email, address, contact_person, tax_id,
        credit_limit, payment_terms_days, lead_time_days, reliability_score,
        is_active, notes, id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json({
      message: "Proveedor actualizado exitosamente",
      provider: result.rows[0]
    });

  } catch (error) {
    console.error("UPDATE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al actualizar proveedor" });
  }
};

// ============================================
// ELIMINAR PROVEEDOR
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar si tiene órdenes de compra asociadas
    const ordersCheck = await db.query(
      "SELECT COUNT(*) as count FROM purchase_orders WHERE provider_id = $1",
      [id]
    );

    if (parseInt(ordersCheck.rows[0].count) > 0) {
      return res.status(400).json({
        message: "No se puede eliminar el proveedor porque tiene órdenes de compra asociadas. Considere desactivarlo en su lugar."
      });
    }

    const result = await db.query(
      "DELETE FROM providers WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json({ message: "Proveedor eliminado exitosamente" });

  } catch (error) {
    console.error("DELETE PROVIDER ERROR:", error);
    res.status(500).json({ message: "Error al eliminar proveedor" });
  }
};

// ============================================
// REGISTRAR PAGO A PROVEEDOR
// ============================================
exports.registerPayment = async (req, res) => {
  const { provider_id, amount, payment_method, reference_number, notes, purchase_order_id } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Verificar proveedor
    const providerCheck = await client.query(
      "SELECT id, balance FROM providers WHERE id = $1",
      [provider_id]
    );

    if (providerCheck.rowCount === 0) {
      throw new Error("Proveedor no encontrado");
    }

    const currentBalance = parseFloat(providerCheck.rows[0].balance);

    if (amount > currentBalance) {
      throw new Error("El monto del pago excede el balance actual del proveedor");
    }

    // Registrar pago
    await client.query(
      `INSERT INTO provider_payments 
       (provider_id, purchase_order_id, amount, payment_method, reference_number, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [provider_id, purchase_order_id || null, amount, payment_method, reference_number, notes, req.user.id]
    );

    // Actualizar balance del proveedor
    await client.query(
      "UPDATE providers SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
      [amount, provider_id]
    );

    // Si hay una orden específica, actualizar su estado de pago
    if (purchase_order_id) {
      const orderResult = await client.query(
        "SELECT total_cost, payment_status FROM purchase_orders WHERE id = $1",
        [purchase_order_id]
      );

      if (orderResult.rowCount > 0) {
        const order = orderResult.rows[0];
        
        // Calcular total pagado de esta orden
        const paidResult = await client.query(
          "SELECT COALESCE(SUM(amount), 0) as total_paid FROM provider_payments WHERE purchase_order_id = $1",
          [purchase_order_id]
        );

        const totalPaid = parseFloat(paidResult.rows[0].total_paid);
        const totalCost = parseFloat(order.total_cost);

        let newPaymentStatus = 'pending';
        if (totalPaid >= totalCost) {
          newPaymentStatus = 'paid';
        } else if (totalPaid > 0) {
          newPaymentStatus = 'partial';
        }

        await client.query(
          "UPDATE purchase_orders SET payment_status = $1 WHERE id = $2",
          [newPaymentStatus, purchase_order_id]
        );
      }
    }

    await client.query("COMMIT");

    res.json({ 
      message: "Pago registrado exitosamente",
      new_balance: currentBalance - amount
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("REGISTER PAYMENT ERROR:", error);
    res.status(500).json({ message: error.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ============================================
// OBTENER HISTORIAL DE PAGOS DE UN PROVEEDOR
// ============================================
exports.getPaymentHistory = async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        pp.*,
        po.order_number,
        u.name AS registered_by
      FROM provider_payments pp
      LEFT JOIN purchase_orders po ON po.id = pp.purchase_order_id
      LEFT JOIN users u ON u.id = pp.created_by
      WHERE pp.provider_id = $1
    `;

    const params = [id];
    let paramIndex = 2;

    if (start_date) {
      query += ` AND pp.created_at >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND pp.created_at <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    query += " ORDER BY pp.created_at DESC";

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error("GET PAYMENT HISTORY ERROR:", error);
    res.status(500).json({ message: "Error al obtener historial de pagos" });
  }
};

// ============================================
// OBTENER HISTORIAL DE COMPRAS POR PROVEEDOR
// ============================================
exports.getPurchaseHistory = async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date, status } = req.query;

  try {
    let query = `
      SELECT * FROM v_purchase_orders_summary
      WHERE provider_id = $1
    `;

    const params = [id];
    let paramIndex = 2;

    if (start_date) {
      query += ` AND order_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND order_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += " ORDER BY order_date DESC";

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error("GET PURCHASE HISTORY ERROR:", error);
    res.status(500).json({ message: "Error al obtener historial de compras" });
  }
};

// ============================================
// COMPARACIÓN DE PRECIOS ENTRE PROVEEDORES
// ============================================
exports.getPriceComparison = async (req, res) => {
  const { product_id } = req.query;

  try {
    const result = await db.query(
      `SELECT 
        prov.id AS provider_id,
        prov.name AS provider_name,
        prov.category,
        prov.reliability_score,
        prov.lead_time_days,
        poi.unit_cost AS last_price,
        po.order_date AS last_order_date,
        AVG(poi.unit_cost) AS avg_price,
        MIN(poi.unit_cost) AS min_price,
        MAX(poi.unit_cost) AS max_price,
        COUNT(DISTINCT po.id) AS times_purchased
       FROM providers prov
       JOIN purchase_orders po ON po.provider_id = prov.id
       JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE poi.product_id = $1 AND po.status != 'cancelled'
       GROUP BY prov.id, prov.name, prov.category, prov.reliability_score, 
                prov.lead_time_days, poi.unit_cost, po.order_date
       ORDER BY prov.name, po.order_date DESC`,
      [product_id]
    );

    res.json(result.rows);

  } catch (error) {
    console.error("GET PRICE COMPARISON ERROR:", error);
    res.status(500).json({ message: "Error al obtener comparación de precios" });
  }
};

// ============================================
// ESTADÍSTICAS DEL PROVEEDOR
// ============================================
exports.getStats = async (req, res) => {
  const { id } = req.params;

  try {
    const statsResult = await db.query(
      `SELECT 
        COUNT(DISTINCT po.id) AS total_orders,
        COUNT(DISTINCT CASE WHEN po.status = 'received' THEN po.id END) AS completed_orders,
        COUNT(DISTINCT CASE WHEN po.status = 'pending' THEN po.id END) AS pending_orders,
        SUM(CASE WHEN po.status = 'received' THEN po.total_cost ELSE 0 END) AS total_spent,
        AVG(CASE WHEN po.status = 'received' THEN po.total_cost END) AS avg_order_value,
        SUM(pp.amount) AS total_paid,
        (SELECT balance FROM providers WHERE id = $1) AS current_balance
       FROM purchase_orders po
       LEFT JOIN provider_payments pp ON pp.provider_id = po.provider_id
       WHERE po.provider_id = $1`,
      [id]
    );

    const topProductsResult = await db.query(
      `SELECT 
        p.id,
        p.name,
        p.sku,
        SUM(poi.quantity) AS total_quantity,
        AVG(poi.unit_cost) AS avg_cost
       FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.provider_id = $1 AND po.status != 'cancelled'
       GROUP BY p.id, p.name, p.sku
       ORDER BY total_quantity DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      summary: statsResult.rows[0],
      top_products: topProductsResult.rows
    });

  } catch (error) {
    console.error("GET PROVIDER STATS ERROR:", error);
    res.status(500).json({ message: "Error al obtener estadísticas" });
  }
};

module.exports = exports;