const db = require("../config/db");

// ============================================
// CREAR ORDEN DE COMPRA
// ============================================
exports.create = async (req, res) => {
  const {
    provider_id,
    expected_delivery_date,
    payment_method,
    notes,
    items, // [{ product_id, quantity, unit_cost, suggested_sale_price, markup_percentage }]
    tax_amount = 0,
    shipping_cost = 0,
    discount_amount = 0
  } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Validar proveedor
    const providerCheck = await client.query(
      "SELECT id, name FROM providers WHERE id = $1 AND is_active = true",
      [provider_id]
    );

    if (providerCheck.rowCount === 0) {
      throw new Error("Proveedor no encontrado o inactivo");
    }

    // Generar número de orden
    const orderNumber = `OC-${new Date().getFullYear()}-${String(
      await client.query("SELECT nextval('purchase_order_number_seq')").then(r => r.rows[0].nextval)
    ).padStart(6, '0')}`;

    // Calcular totales
    let subtotal = 0;
    for (const item of items) {
      subtotal += item.quantity * item.unit_cost;
    }

    const total_cost = subtotal + tax_amount + shipping_cost - discount_amount;

    // Crear orden de compra
    const orderResult = await client.query(
      `INSERT INTO purchase_orders 
       (order_number, provider_id, expected_delivery_date, subtotal, tax_amount, 
        shipping_cost, discount_amount, total_cost, payment_method, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        orderNumber, provider_id, expected_delivery_date, subtotal, tax_amount,
        shipping_cost, discount_amount, total_cost, payment_method, notes, req.user.id
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Insertar items con cálculos de utilidad
    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_cost;
      
      // Calcular precio de venta sugerido si no viene
      let suggested_sale_price = item.suggested_sale_price;
      let markup_percentage = item.markup_percentage;
      
      if (!suggested_sale_price && markup_percentage) {
        suggested_sale_price = item.unit_cost * (1 + markup_percentage / 100);
      } else if (!markup_percentage && suggested_sale_price) {
        markup_percentage = ((suggested_sale_price - item.unit_cost) / item.unit_cost) * 100;
      }

      const expected_profit_per_unit = suggested_sale_price - item.unit_cost;
      const expected_total_profit = expected_profit_per_unit * item.quantity;

      await client.query(
        `INSERT INTO purchase_order_items 
         (purchase_order_id, product_id, quantity, unit_cost, subtotal, 
          suggested_sale_price, markup_percentage, expected_profit_per_unit, expected_total_profit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          orderId, item.product_id, item.quantity, item.unit_cost, itemSubtotal,
          suggested_sale_price, markup_percentage, expected_profit_per_unit, expected_total_profit
        ]
      );
    }

    // Actualizar balance del proveedor si es a crédito
    if (payment_method === 'credit') {
      await client.query(
        "UPDATE providers SET balance = balance + $1 WHERE id = $2",
        [total_cost, provider_id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Orden de compra creada exitosamente",
      order: orderResult.rows[0],
      order_number: orderNumber
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE PURCHASE ORDER ERROR:", error);
    res.status(500).json({ 
      message: error.message || "Error al crear orden de compra" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// OBTENER TODAS LAS ÓRDENES
// ============================================
exports.getAll = async (req, res) => {
  const { status, provider_id, start_date, end_date } = req.query;

  try {
    let query = `
      SELECT * FROM v_purchase_orders_summary
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (provider_id) {
      query += ` AND provider_id = $${paramIndex}`;
      params.push(provider_id);
      paramIndex++;
    }

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

    query += ` ORDER BY order_date DESC, id DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error("GET PURCHASE ORDERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener órdenes de compra" });
  }
};

// ============================================
// OBTENER ORDEN POR ID
// ============================================
exports.getById = async (req, res) => {
  const { id } = req.params;

  try {
    const orderResult = await db.query(
      "SELECT * FROM v_purchase_orders_summary WHERE id = $1",
      [id]
    );

    if (orderResult.rowCount === 0) {
      return res.status(404).json({ message: "Orden no encontrada" });
    }

    const itemsResult = await db.query(
      `SELECT 
        poi.*,
        p.name AS product_name,
        p.sku,
        p.stock AS current_stock
       FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id
       WHERE poi.purchase_order_id = $1
       ORDER BY poi.id`,
      [id]
    );

    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (error) {
    console.error("GET PURCHASE ORDER BY ID ERROR:", error);
    res.status(500).json({ message: "Error al obtener orden" });
  }
};

// ============================================
// ACTUALIZAR ORDEN
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const {
    expected_delivery_date,
    payment_method,
    notes,
    items,
    tax_amount,
    shipping_cost,
    discount_amount
  } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Verificar que la orden no esté recibida o cancelada
    const orderCheck = await db.query(
      "SELECT status FROM purchase_orders WHERE id = $1",
      [id]
    );

    if (orderCheck.rowCount === 0) {
      throw new Error("Orden no encontrada");
    }

    if (['received', 'cancelled'].includes(orderCheck.rows[0].status)) {
      throw new Error("No se puede editar una orden recibida o cancelada");
    }

    // Recalcular totales
    let subtotal = 0;
    for (const item of items) {
      subtotal += item.quantity * item.unit_cost;
    }

    const total_cost = subtotal + (tax_amount || 0) + (shipping_cost || 0) - (discount_amount || 0);

    // Actualizar orden
    await client.query(
      `UPDATE purchase_orders SET
        expected_delivery_date = $1,
        payment_method = $2,
        notes = $3,
        subtotal = $4,
        tax_amount = $5,
        shipping_cost = $6,
        discount_amount = $7,
        total_cost = $8,
        updated_at = NOW()
       WHERE id = $9`,
      [
        expected_delivery_date, payment_method, notes, subtotal,
        tax_amount, shipping_cost, discount_amount, total_cost, id
      ]
    );

    // Eliminar items antiguos
    await client.query("DELETE FROM purchase_order_items WHERE purchase_order_id = $1", [id]);

    // Insertar items actualizados
    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_cost;
      const expected_profit_per_unit = (item.suggested_sale_price || 0) - item.unit_cost;
      const expected_total_profit = expected_profit_per_unit * item.quantity;

      await client.query(
        `INSERT INTO purchase_order_items 
         (purchase_order_id, product_id, quantity, unit_cost, subtotal, 
          suggested_sale_price, markup_percentage, expected_profit_per_unit, expected_total_profit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id, item.product_id, item.quantity, item.unit_cost, itemSubtotal,
          item.suggested_sale_price, item.markup_percentage, 
          expected_profit_per_unit, expected_total_profit
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Orden actualizada exitosamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("UPDATE PURCHASE ORDER ERROR:", error);
    res.status(500).json({ message: error.message || "Error al actualizar orden" });
  } finally {
    client.release();
  }
};

// ============================================
// APROBAR ORDEN
// ============================================
exports.approve = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `UPDATE purchase_orders SET
        status = 'pending',
        approved_by = $1,
        approved_at = NOW()
       WHERE id = $2 AND status = 'draft'
       RETURNING *`,
      [req.user.id, id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ 
        message: "Orden no encontrada o ya fue aprobada" 
      });
    }

    res.json({ 
      message: "Orden aprobada exitosamente",
      order: result.rows[0]
    });

  } catch (error) {
    console.error("APPROVE PURCHASE ORDER ERROR:", error);
    res.status(500).json({ message: "Error al aprobar orden" });
  }
};

// ============================================
// RECIBIR ORDEN (Actualiza inventario)
// ============================================
exports.receive = async (req, res) => {
  const { id } = req.params;
  const { received_items } = req.body; // [{ product_id, received_quantity }]

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Obtener orden
    const orderResult = await db.query(
      "SELECT * FROM purchase_orders WHERE id = $1",
      [id]
    );

    if (orderResult.rowCount === 0) {
      throw new Error("Orden no encontrada");
    }

    const order = orderResult.rows[0];

    if (order.status === 'received') {
      throw new Error("Esta orden ya fue recibida");
    }

    // Actualizar cantidades recibidas
    for (const item of received_items) {
      await client.query(
        `UPDATE purchase_order_items 
         SET received_quantity = $1
         WHERE purchase_order_id = $2 AND product_id = $3`,
        [item.received_quantity, id, item.product_id]
      );
    }

    // Marcar orden como recibida (el trigger actualizará el stock automáticamente)
    await client.query(
      `UPDATE purchase_orders SET
        status = 'received',
        received_date = CURRENT_DATE,
        updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    // Si el pago está pendiente, actualizar balance del proveedor
    if (order.payment_status === 'pending' && order.payment_method === 'credit') {
      await client.query(
        "UPDATE providers SET balance = balance + $1 WHERE id = $2",
        [order.total_cost, order.provider_id]
      );
    }

    await client.query("COMMIT");

    res.json({ 
      message: "Orden recibida exitosamente. El inventario ha sido actualizado." 
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("RECEIVE PURCHASE ORDER ERROR:", error);
    res.status(500).json({ message: error.message || "Error al recibir orden" });
  } finally {
    client.release();
  }
};

// ============================================
// CANCELAR ORDEN
// ============================================
exports.cancel = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await db.query(
      "SELECT * FROM purchase_orders WHERE id = $1",
      [id]
    );

    if (orderResult.rowCount === 0) {
      throw new Error("Orden no encontrada");
    }

    const order = orderResult.rows[0];

    if (order.status === 'received') {
      throw new Error("No se puede cancelar una orden que ya fue recibida");
    }

    // Actualizar orden
    await client.query(
      `UPDATE purchase_orders SET
        status = 'cancelled',
        notes = CONCAT(COALESCE(notes, ''), E'\n\nCANCELADA: ', $1),
        updated_at = NOW()
       WHERE id = $2`,
      [reason || 'Sin motivo especificado', id]
    );

    // Si había balance a crédito, restarlo
    if (order.payment_method === 'credit' && order.payment_status !== 'paid') {
      await client.query(
        "UPDATE providers SET balance = balance - $1 WHERE id = $2",
        [order.total_cost, order.provider_id]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Orden cancelada exitosamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CANCEL PURCHASE ORDER ERROR:", error);
    res.status(500).json({ message: error.message || "Error al cancelar orden" });
  } finally {
    client.release();
  }
};

// ============================================
// ELIMINAR ORDEN (solo borradores)
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "DELETE FROM purchase_orders WHERE id = $1 AND status = 'draft' RETURNING *",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ 
        message: "Solo se pueden eliminar órdenes en borrador" 
      });
    }

    res.json({ message: "Orden eliminada exitosamente" });

  } catch (error) {
    console.error("DELETE PURCHASE ORDER ERROR:", error);
    res.status(500).json({ message: "Error al eliminar orden" });
  }
};

// ============================================
// REPORTES Y ESTADÍSTICAS
// ============================================

// Resumen de utilidades esperadas
exports.getProfitAnalysis = async (req, res) => {
  const { start_date, end_date, provider_id } = req.query;

  try {
    let query = `
      SELECT 
        po.id,
        po.order_number,
        po.order_date,
        prov.name AS provider_name,
        po.total_cost,
        SUM(poi.expected_total_profit) AS expected_profit,
        ROUND(
          (SUM(poi.expected_total_profit) / NULLIF(po.total_cost, 0) * 100)::numeric, 
          2
        ) AS profit_margin_percentage
      FROM purchase_orders po
      JOIN providers prov ON prov.id = po.provider_id
      LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
      WHERE po.status != 'cancelled'
    `;

    const params = [];
    let paramIndex = 1;

    if (start_date) {
      query += ` AND po.order_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND po.order_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    if (provider_id) {
      query += ` AND po.provider_id = $${paramIndex}`;
      params.push(provider_id);
      paramIndex++;
    }

    query += `
      GROUP BY po.id, po.order_number, po.order_date, prov.name, po.total_cost
      ORDER BY po.order_date DESC
    `;

    const result = await db.query(query, params);
    
    // Calcular totales
    const totals = {
      total_invested: result.rows.reduce((sum, row) => sum + parseFloat(row.total_cost || 0), 0),
      total_expected_profit: result.rows.reduce((sum, row) => sum + parseFloat(row.expected_profit || 0), 0),
    };
    totals.overall_margin = totals.total_invested > 0 
      ? ((totals.total_expected_profit / totals.total_invested) * 100).toFixed(2)
      : 0;

    res.json({
      orders: result.rows,
      summary: totals
    });

  } catch (error) {
    console.error("GET PROFIT ANALYSIS ERROR:", error);
    res.status(500).json({ message: "Error al obtener análisis de utilidades" });
  }
};

// Productos más comprados
exports.getTopProducts = async (req, res) => {
  const { limit = 10 } = req.query;

  try {
    const result = await db.query(
      `SELECT 
        p.id,
        p.name,
        p.sku,
        COUNT(DISTINCT poi.purchase_order_id) AS times_ordered,
        SUM(poi.quantity) AS total_quantity,
        AVG(poi.unit_cost) AS avg_cost,
        SUM(poi.subtotal) AS total_spent
       FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.status != 'cancelled'
       GROUP BY p.id, p.name, p.sku
       ORDER BY total_quantity DESC
       LIMIT $1`,
      [limit]
    );

    res.json(result.rows);

  } catch (error) {
    console.error("GET TOP PRODUCTS ERROR:", error);
    res.status(500).json({ message: "Error al obtener productos top" });
  }
};

// Comparación de precios por proveedor
exports.getPriceComparison = async (req, res) => {
  const { product_id } = req.params;

  try {
    const result = await db.query(
      `SELECT 
        prov.id AS provider_id,
        prov.name AS provider_name,
        poi.unit_cost,
        poi.quantity,
        po.order_date,
        po.order_number
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       JOIN providers prov ON prov.id = po.provider_id
       WHERE poi.product_id = $1 AND po.status != 'cancelled'
       ORDER BY po.order_date DESC
       LIMIT 20`,
      [product_id]
    );

    res.json(result.rows);

  } catch (error) {
    console.error("GET PRICE COMPARISON ERROR:", error);
    res.status(500).json({ message: "Error al obtener comparación de precios" });
  }
};

module.exports = exports;