const db = require("../config/db");
const { sendOrderConfirmationEmail } = require("../config/emailConfig");

// ============================================
// 📦 OBTENER HISTORIAL DE PEDIDOS DEL USUARIO
// ============================================
exports.getUserOrderHistory = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      message: "userId es requerido",
    });
  }

  try {
    const result = await db.query(
      `SELECT 
        s.id,
        s.sale_number         AS order_code,
        s.sale_date           AS created_at,
        s.total,
        s.payment_status,
        s.payment_method,
        s.sale_type,
        s.subtotal,
        s.tax_amount,
        s.discount_amount,
        s.shipping_address,
        s.shipping_city,
        s.shipping_notes
      FROM sales s
      WHERE s.customer_id = $1
      ORDER BY s.sale_date DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET USER ORDER HISTORY ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener historial de pedidos",
    });
  }
};

// ============================================
// 📊 OBTENER ESTADÍSTICAS DEL USUARIO
// ============================================
exports.getUserStats = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      message: "userId es requerido",
    });
  }

  try {
    const result = await db.query(
      `SELECT 
        COUNT(DISTINCT s.id) AS total_orders,
        COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0) AS total_invested,
        COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0) AS pending_amount,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END) AS completed_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) AS pending_orders
      FROM sales s
      WHERE s.customer_id = $1`,
      [userId]
    );

    res.json({ summary: result.rows[0] });
  } catch (error) {
    console.error("GET USER STATS ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
    });
  }
};

// ============================================
// 📄 OBTENER DETALLE DE UN PEDIDO (CON ITEMS)
// ============================================
exports.getOrderDetail = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT 
        si.id,
        si.product_id,
        si.quantity,
        si.unit_price,
        si.subtotal,
        si.discount_amount,
        p.name,
        p.sku,
        (
          SELECT pi.url 
          FROM product_images pi 
          WHERE pi.product_id = p.id 
            AND pi.is_main = true 
          LIMIT 1
        ) AS main_image
      FROM sale_items si
      INNER JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = $1
      ORDER BY si.id`,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET ORDER DETAIL ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener detalle del pedido",
    });
  }
};

// ============================================
// 🛒 CREAR PEDIDO/VENTA (VENTAS FÍSICAS Y ONLINE)
// ✅ CORREGIDO: Ahora acepta tanto ventas físicas como online
// ============================================
exports.createOrder = async (req, res) => {
  const {
    customer_id,
    items,
    payment_method = "cash",
    discount_amount  = 0,
    tax_amount       = 0,
    sale_type        = "online",  // "fisica" o "online"
    shipping_address,
    shipping_city,
    shipping_notes,
  } = req.body;

  // Validaciones
  if (!customer_id || !items || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Datos incompletos para crear el pedido",
    });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Obtener datos del cliente
    const customerResult = await client.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [customer_id]
    );
    if (customerResult.rows.length === 0) {
      throw new Error("Cliente no encontrado");
    }
    const customer = customerResult.rows[0];

    // 2. Validar productos y calcular totales
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const productResult = await client.query(
        "SELECT id, name, sku, sale_price, stock, purchase_price FROM products WHERE id = $1 AND is_active = true",
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`Producto ${item.product_id} no encontrado o inactivo`);
      }

      const product = productResult.rows[0];

      if (product.stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para ${product.name}. Disponible: ${product.stock}`
        );
      }

      // ✅ CORREGIDO: Usar el precio del producto de la DB, no el enviado por el frontend
      const itemSubtotal = product.sale_price * item.quantity;
      subtotal += itemSubtotal;

      validatedItems.push({
        product_id:     product.id,
        name:           product.name,
        sku:            product.sku,
        quantity:       item.quantity,
        unit_price:     product.sale_price,
        unit_cost:      product.purchase_price || 0,
        subtotal:       itemSubtotal,
        profit_per_unit: product.sale_price - (product.purchase_price || 0),
        total_profit:   (product.sale_price - (product.purchase_price || 0)) * item.quantity,
      });
    }

    const total = subtotal - discount_amount + tax_amount;

    // 3. Generar número de venta
    const saleNumberResult = await client.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 5) AS INTEGER)), 0) + 1 AS next_num FROM sales WHERE sale_number LIKE 'VEN-%'"
    );
    const saleNumber = `VEN-${String(saleNumberResult.rows[0].next_num).padStart(6, "0")}`;

    // 4. Crear venta
    // ✅ CORREGIDO: Para ventas físicas, el pago es inmediato (paid), para online es pending
    const payment_status = sale_type === "fisica" ? "paid" : "pending";

    const saleResult = await client.query(
      `INSERT INTO sales (
        sale_number,
        customer_id,
        subtotal,
        tax_amount,
        discount_amount,
        total,
        payment_method,
        payment_status,
        sale_type,
        created_by,
        shipping_address,
        shipping_city,
        shipping_notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id`,
      [
        saleNumber,
        customer_id,
        subtotal,
        tax_amount,
        discount_amount,
        total,
        payment_method,
        payment_status,
        sale_type,
        customer_id,
        shipping_address || null,
        shipping_city    || null,
        shipping_notes   || null,
      ]
    );

    const saleId = saleResult.rows[0].id;

    // 5. Insertar items y reducir stock
    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO sale_items (
          sale_id, product_id, quantity, unit_price, unit_cost,
          subtotal, profit_per_unit, total_profit
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          saleId,
          item.product_id,
          item.quantity,
          item.unit_price,
          item.unit_cost,
          item.subtotal,
          item.profit_per_unit,
          item.total_profit,
        ]
      );

      // ✅ Reducir stock automáticamente
      await client.query(
        "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
        [item.quantity, item.product_id]
      );
    }

    await client.query("COMMIT");

    // 6. Código público de orden (AL-XXXXXX)
    const orderCode = `AL-${saleNumber.slice(4)}`;

    // 7. Enviar email de confirmación solo para pedidos online (best-effort)
    if (sale_type === "online" && customer.email) {
      sendOrderConfirmationEmail(customer.email, customer.name, {
        orderCode,
        total,
        items: validatedItems,
        shippingAddress: shipping_address,
        shippingCity:    shipping_city,
        shippingNotes:   shipping_notes,
        paymentMethod:   payment_method,
      }).catch(err => console.error("Email confirmación falló (non-blocking):", err));
    }

    res.status(201).json({
      success: true,
      message: sale_type === "fisica" ? "Venta realizada exitosamente" : "Pedido creado exitosamente",
      data: {
        sale_id:     saleId,
        sale_number: saleNumber,
        order_code:  orderCode,
        total,
        payment_status
      },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE ORDER ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Error al crear el pedido",
    });
  } finally {
    client.release();
  }
};

// ============================================
// ❌ CANCELAR PEDIDO (SOLO SI ESTÁ PENDING)
// ============================================
exports.cancelOrder = async (req, res) => {
  const { id }      = req.params;
  const { user_id } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const orderCheck = await client.query(
      "SELECT id, customer_id, payment_status FROM sales WHERE id = $1",
      [id]
    );

    if (orderCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }

    const order = orderCheck.rows[0];

    if (order.customer_id !== parseInt(user_id) && !req.user?.roles?.includes("admin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "No tienes permiso para cancelar este pedido" });
    }

    if (order.payment_status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Solo se pueden cancelar pedidos pendientes" });
    }

    // Restaurar stock
    const items = await client.query(
      "SELECT product_id, quantity FROM sale_items WHERE sale_id = $1",
      [id]
    );
    for (const item of items.rows) {
      await client.query(
        "UPDATE products SET stock = stock + $1 WHERE id = $2",
        [item.quantity, item.product_id]
      );
    }

    await client.query("UPDATE sales SET payment_status = 'cancelled' WHERE id = $1", [id]);
    await client.query("COMMIT");

    res.json({ success: true, message: "Pedido cancelado exitosamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CANCEL ORDER ERROR:", error);
    res.status(500).json({ success: false, message: "Error al cancelar el pedido" });
  } finally {
    client.release();
  }
};

// ============================================
// 💰 CONFIRMAR PAGO (Admin/Gerente)
// ============================================
exports.confirmPayment = async (req, res) => {
  const { id }             = req.params;
  const { payment_method } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const orderCheck = await client.query(
      "SELECT id, payment_status, total FROM sales WHERE id = $1",
      [id]
    );

    if (orderCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }

    if (orderCheck.rows[0].payment_status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "El pedido ya fue procesado" });
    }

    await client.query(
      "UPDATE sales SET payment_status = 'paid', payment_method = $1 WHERE id = $2",
      [payment_method || "cash", id]
    );

    await client.query("COMMIT");

    res.json({ success: true, message: "Pago confirmado exitosamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CONFIRM PAYMENT ERROR:", error);
    res.status(500).json({ success: false, message: "Error al confirmar el pago" });
  } finally {
    client.release();
  }
};

module.exports = exports;