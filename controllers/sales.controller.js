const db = require("../config/db");
const { sendOrderConfirmationEmail, sendPaymentConfirmedEmail } = require("../config/emailConfig");

// ============================================
// 📋 OBTENER TODAS LAS VENTAS (PARA HISTORIAL)
// ============================================
exports.getAllSales = async (req, res) => {
  try {
    let query;
    let params = [];

    if (req.user?.roles?.includes("admin") || req.user?.roles?.includes("gerente")) {
      query = `
        SELECT
          s.id,
          s.sale_number,
          s.customer_id,
          s.sale_date         AS created_at,
          s.total,
          s.payment_status,
          s.payment_method,
          s.sale_type,
          s.subtotal,
          s.tax_amount,
          s.discount_amount,
          s.shipping_address,
          s.shipping_city,
          s.shipping_notes,
          u.name              AS customer_name,
          u.email             AS customer_email
        FROM sales s
        LEFT JOIN users u ON s.customer_id = u.id
        ORDER BY s.sale_date DESC
      `;
    } else if (req.user?.id) {
      query = `
        SELECT
          s.id,
          s.sale_number,
          s.customer_id,
          s.sale_date         AS created_at,
          s.total,
          s.payment_status,
          s.payment_method,
          s.sale_type,
          s.subtotal,
          s.tax_amount,
          s.discount_amount,
          s.shipping_address,
          s.shipping_city,
          s.shipping_notes,
          u.name              AS customer_name,
          u.email             AS customer_email
        FROM sales s
        LEFT JOIN users u ON s.customer_id = u.id
        WHERE s.customer_id = $1
        ORDER BY s.sale_date DESC
      `;
      params = [req.user.id];
    } else {
      return res.status(403).json({ success: false, message: "No autorizado para ver ventas" });
    }

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (error) {
    console.error("GET ALL SALES ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
};

// ============================================
// 📦 OBTENER HISTORIAL DE PEDIDOS DEL USUARIO
// ============================================
exports.getUserOrderHistory = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId es requerido" });
  }

  try {
    const result = await db.query(
      `SELECT
        s.id,
        s.sale_number            AS order_code,
        s.sale_date              AS created_at,
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
    res.status(500).json({ success: false, message: "Error al obtener historial de pedidos" });
  }
};

// ============================================
// 📊 OBTENER ESTADÍSTICAS DEL USUARIO
// ============================================
exports.getUserStats = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId es requerido" });
  }

  try {
    const result = await db.query(
      `SELECT
        COUNT(DISTINCT s.id)                                                               AS total_orders,
        COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0)  AS total_invested,
        COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0)  AS pending_amount,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END)               AS completed_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END)               AS pending_orders
      FROM sales s
      WHERE s.customer_id = $1`,
      [userId]
    );

    res.json({ summary: result.rows[0] });
  } catch (error) {
    console.error("GET USER STATS ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
};

// ============================================
// 🛒 CREAR PEDIDO — pago siempre vía Wompi
// ============================================
exports.createOrder = async (req, res) => {
  const {
    customer_id,
    items,
    discount_amount = 0,
    tax_amount      = 0,
    sale_type       = "online",
    shipping_address,
    shipping_city,
    shipping_notes,
  } = req.body;

  if (!customer_id || !items || items.length === 0) {
    return res.status(400).json({ success: false, message: "Datos incompletos para crear el pedido" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Datos del cliente
    const customerResult = await client.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [customer_id]
    );
    if (customerResult.rows.length === 0) throw new Error("Cliente no encontrado");
    const customer = customerResult.rows[0];

    // 2. Validar ítems y calcular totales
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const productResult = await client.query(
        `SELECT id, name, sku, sale_price, stock, purchase_price, has_variants
         FROM products WHERE id = $1 AND is_active = true`,
        [item.product_id]
      );
      if (productResult.rows.length === 0)
        throw new Error(`Producto ${item.product_id} no encontrado o inactivo`);

      const product = productResult.rows[0];

      let variantId  = null;
      let unitPrice  = Number(product.sale_price);
      let unitCost   = Number(product.purchase_price ?? 0);
      let availStock = Number(product.stock);
      let variantSku = null;

      if (item.variant_id) {
        const variantResult = await client.query(
          `SELECT id, sku, sale_price, stock
           FROM product_variants
           WHERE id = $1 AND product_id = $2 AND is_active = true`,
          [item.variant_id, item.product_id]
        );
        if (variantResult.rows.length === 0)
          throw new Error(`Variante ${item.variant_id} no encontrada o inactiva`);

        const variant = variantResult.rows[0];
        variantId  = variant.id;
        variantSku = variant.sku;
        availStock = Number(variant.stock);
        if (variant.sale_price !== null && variant.sale_price !== undefined) {
          unitPrice = Number(variant.sale_price);
        }
      } else if (product.has_variants) {
        throw new Error(`El producto "${product.name}" tiene variantes — debes seleccionar una`);
      }

      if (availStock < item.quantity)
        throw new Error(
          `Stock insuficiente para "${product.name}"${variantId ? " (variante seleccionada)" : ""}. Disponible: ${availStock}`
        );

      const itemSubtotal = unitPrice * item.quantity;
      subtotal += itemSubtotal;

      validatedItems.push({
        product_id:      product.id,
        variant_id:      variantId,
        name:            product.name,
        sku:             variantSku || product.sku,
        quantity:        item.quantity,
        unit_price:      unitPrice,
        unit_cost:       unitCost,
        subtotal:        itemSubtotal,
        profit_per_unit: unitPrice - unitCost,
        total_profit:    (unitPrice - unitCost) * item.quantity,
      });
    }

    const total = subtotal - Number(discount_amount) + Number(tax_amount);

    // 3. Número de venta
    const saleNumberResult = await client.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 5) AS INTEGER)), 0) + 1 AS next_num FROM sales WHERE sale_number LIKE 'VEN-%'"
    );
    const saleNumber = `VEN-${String(saleNumberResult.rows[0].next_num).padStart(6, "0")}`;

    // 4. Crear venta
    // payment_method = 'credit' (Wompi maneja tarjeta/PSE)
    // payment_status = 'pending' siempre — el webhook de Wompi lo cambia a 'paid'
    const saleResult = await client.query(
      `INSERT INTO sales (
        sale_number, customer_id, subtotal, tax_amount, discount_amount,
        total, payment_method, payment_status, sale_type, created_by,
        shipping_address, shipping_city, shipping_notes
      ) VALUES ($1,$2,$3,$4,$5,$6,'credit','pending',$7,$8,$9,$10,$11)
      RETURNING id`,
      [
        saleNumber, customer_id, subtotal, tax_amount, discount_amount,
        total, sale_type, customer_id,
        shipping_address || null, shipping_city || null, shipping_notes || null,
      ]
    );
    const saleId = saleResult.rows[0].id;

    // 5. Insertar ítems + reducir stock
    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO sale_items (
          sale_id, product_id, variant_id, quantity, unit_price, unit_cost,
          subtotal, profit_per_unit, total_profit
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          saleId, item.product_id, item.variant_id ?? null,
          item.quantity, item.unit_price, item.unit_cost,
          item.subtotal, item.profit_per_unit, item.total_profit,
        ]
      );

      if (item.variant_id) {
        await client.query(
          "UPDATE product_variants SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.variant_id]
        );
        await client.query(
          `UPDATE products
           SET stock = (
             SELECT COALESCE(SUM(pv.stock), 0)
             FROM product_variants pv
             WHERE pv.product_id = $1 AND pv.is_active = true
           ), updated_at = NOW()
           WHERE id = $1`,
          [item.product_id]
        );
      } else {
        await client.query(
          "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.product_id]
        );
      }
    }

    await client.query("COMMIT");

    const orderCode = `AL-${saleNumber.slice(4)}`;

    // 6. Email de confirmación del pedido (best-effort)
    if (customer.email) {
      sendOrderConfirmationEmail(customer.email, customer.name, {
        orderCode,
        total,
        items:           validatedItems,
        shippingAddress: shipping_address,
        shippingCity:    shipping_city,
        shippingNotes:   shipping_notes,
        paymentMethod:   "wompi",
      }).catch(err => console.error("Email confirmación falló (non-blocking):", err));
    }

    res.status(201).json({
      success: true,
      message: "Pedido creado exitosamente. Redirigiendo al pago…",
      data: { sale_id: saleId, sale_number: saleNumber, order_code: orderCode, total, payment_status: "pending" },
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE ORDER ERROR:", error);
    res.status(500).json({ success: false, message: error.message || "Error al crear el pedido" });
  } finally {
    client.release();
  }
};

// ============================================
// 📄 DETALLE DE VENTA
// ============================================
exports.getOrderDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT
        si.id,
        si.product_id,
        si.variant_id,
        si.quantity,
        si.unit_price,
        si.subtotal,
        si.discount_amount,
        p.name,
        p.sku,
        pv.sku AS variant_sku,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'attribute_type', at.name,
                'value',          av.value,
                'display_value',  COALESCE(av.display_value, av.value),
                'hex_color',      av.hex_color
              ) ORDER BY at.id
            )
            FROM variant_attribute_values vav
            JOIN attribute_values av ON av.id = vav.attribute_value_id
            JOIN attribute_types  at ON at.id = av.attribute_type_id
            WHERE vav.variant_id = si.variant_id
          ),
          '[]'
        ) AS variant_attributes,
        (
          SELECT pi.url
          FROM product_images pi
          WHERE pi.product_id = p.id AND pi.is_main = true
          LIMIT 1
        ) AS main_image
      FROM sale_items si
      INNER JOIN products p  ON si.product_id = p.id
      LEFT  JOIN product_variants pv ON pv.id = si.variant_id
      WHERE si.sale_id = $1
      ORDER BY si.id`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("GET ORDER DETAIL ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener detalle del pedido" });
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
      "SELECT product_id, variant_id, quantity FROM sale_items WHERE sale_id = $1",
      [id]
    );

    for (const item of items.rows) {
      if (item.variant_id) {
        await client.query(
          "UPDATE product_variants SET stock = stock + $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.variant_id]
        );
        await client.query(
          `UPDATE products
           SET stock = (
             SELECT COALESCE(SUM(pv.stock), 0)
             FROM product_variants pv
             WHERE pv.product_id = $1 AND pv.is_active = true
           ), updated_at = NOW()
           WHERE id = $1`,
          [item.product_id]
        );
      } else {
        await client.query(
          "UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.product_id]
        );
      }
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

module.exports = exports;