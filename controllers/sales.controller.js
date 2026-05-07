// src/controllers/sales.controller.js
const db = require("../config/db");
const { sendOrderConfirmationEmail, sendPaymentConfirmedEmail } = require("../config/emailConfig");

const fmt = (n) => Number(n ?? 0).toLocaleString("es-CO");

/**
 * Recalcula y actualiza payment_status + amount_paid de una venta
 * según la suma real de sale_payments.
 */
async function syncPaymentStatus(client, saleId) {
  const { rows } = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM sale_payments WHERE sale_id = $1",
    [saleId]
  );
  const paid = Number(rows[0].paid);

  const { rows: saleRows } = await client.query(
    "SELECT total FROM sales WHERE id = $1",
    [saleId]
  );
  const total = Number(saleRows[0].total);

  let status;
  if (paid <= 0)         status = "pending";
  else if (paid < total) status = "partial";
  else                   status = "paid";

  await client.query(
    "UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3",
    [paid, status, saleId]
  );
  return { paid, status };
}

// ============================================
// 📋 OBTENER TODAS LAS VENTAS
// ============================================
exports.getAllSales = async (req, res) => {
  try {
    let query, params = [];

    const isManager =
      req.user?.roles?.includes("admin") ||
      req.user?.roles?.includes("gerente");

    if (isManager) {
      query = `
        SELECT
          s.id, s.sale_number, s.customer_id,
          s.sale_date        AS created_at,
          s.total,           s.amount_paid,
          s.payment_status,  s.payment_method,
          s.sale_type,       s.subtotal,
          s.tax_amount,      s.discount_amount,
          s.credit_due_date, s.credit_notes,
          s.shipping_address, s.shipping_city, s.shipping_notes,
          u.name AS customer_name, u.email AS customer_email
        FROM sales s
        LEFT JOIN users u ON s.customer_id = u.id
        ORDER BY s.sale_date DESC
      `;
    } else if (req.user?.id) {
      query = `
        SELECT
          s.id, s.sale_number, s.customer_id,
          s.sale_date        AS created_at,
          s.total,           s.amount_paid,
          s.payment_status,  s.payment_method,
          s.sale_type,       s.subtotal,
          s.tax_amount,      s.discount_amount,
          s.credit_due_date,
          s.shipping_address, s.shipping_city, s.shipping_notes,
          u.name AS customer_name, u.email AS customer_email
        FROM sales s
        LEFT JOIN users u ON s.customer_id = u.id
        WHERE s.customer_id = $1
        ORDER BY s.sale_date DESC
      `;
      params = [req.user.id];
    } else {
      return res.status(403).json({ success: false, message: "No autorizado" });
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("GET ALL SALES ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
};

// ============================================
// 📦 HISTORIAL DE PEDIDOS DEL USUARIO
// ============================================
exports.getUserOrderHistory = async (req, res) => {
  const { userId } = req.query;
  if (!userId)
    return res.status(400).json({ success: false, message: "userId requerido" });

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.sale_number AS order_code, s.sale_date AS created_at,
              s.total, s.amount_paid, s.payment_status, s.payment_method,
              s.sale_type, s.subtotal, s.tax_amount, s.discount_amount,
              s.credit_due_date, s.shipping_address, s.shipping_city, s.shipping_notes
       FROM sales s
       WHERE s.customer_id = $1
       ORDER BY s.sale_date DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET USER ORDER HISTORY ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener historial" });
  }
};

// ============================================
// 📊 ESTADÍSTICAS DEL USUARIO
// ============================================
exports.getUserStats = async (req, res) => {
  const { userId } = req.query;
  if (!userId)
    return res.status(400).json({ success: false, message: "userId requerido" });

  try {
    const { rows } = await db.query(
      `SELECT
        COUNT(DISTINCT s.id)                                                               AS total_orders,
        COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0)  AS total_invested,
        COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0)  AS pending_amount,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END)               AS completed_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END)               AS pending_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'partial' THEN s.id END)               AS partial_orders
       FROM sales s WHERE s.customer_id = $1`,
      [userId]
    );
    res.json({ summary: rows[0] });
  } catch (err) {
    console.error("GET USER STATS ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
};

// ============================================
// 🛒 CREAR PEDIDO / VENTA
// ============================================
exports.createOrder = async (req, res) => {
  const {
    customer_id,
    items,
    discount_amount      = 0,
    tax_amount           = 0,
    sale_type            = "online",
    payment_method       = "cash",
    credit_due_date      = null,
    credit_notes         = null,
    initial_payment      = 0,
    shipping_address,
    shipping_city,
    shipping_notes,
  } = req.body;

  if (!customer_id || !items?.length)
    return res.status(400).json({ success: false, message: "Datos incompletos" });

  const isFiado  = payment_method === "fiado";
  const isOnline = sale_type === "online" || sale_type === "web";
  const isLocal  = sale_type === "fisica";

  // Fiado requiere fecha límite
  if (isFiado && !credit_due_date)
    return res.status(400).json({
      success: false,
      message: "Se requiere fecha límite de pago para ventas a crédito",
    });

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // ── Cliente ──────────────────────────────────────────────
    const { rows: custRows } = await client.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [customer_id]
    );
    if (!custRows.length) throw new Error("Cliente no encontrado");
    const customer = custRows[0];

    // ── Validar ítems y calcular totales ─────────────────────
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const { rows: prodRows } = await client.query(
        `SELECT id, name, sku, sale_price, stock, purchase_price, has_variants
         FROM products WHERE id = $1 AND is_active = true`,
        [item.product_id]
      );
      if (!prodRows.length)
        throw new Error(`Producto ${item.product_id} no encontrado o inactivo`);
      const product = prodRows[0];

      let variantId  = null;
      let unitPrice  = Number(product.sale_price);
      let unitCost   = Number(product.purchase_price ?? 0);
      let availStock = Number(product.stock);
      let variantSku = null;

      if (item.variant_id) {
        const { rows: varRows } = await client.query(
          `SELECT id, sku, sale_price, stock
           FROM product_variants
           WHERE id = $1 AND product_id = $2 AND is_active = true`,
          [item.variant_id, item.product_id]
        );
        if (!varRows.length)
          throw new Error(`Variante ${item.variant_id} no encontrada o inactiva`);
        const v = varRows[0];
        variantId = v.id; variantSku = v.sku; availStock = Number(v.stock);
        if (v.sale_price != null) unitPrice = Number(v.sale_price);
      } else if (product.has_variants) {
        throw new Error(`"${product.name}" tiene variantes — selecciona una`);
      }

      if (availStock < item.quantity)
        throw new Error(
          `Stock insuficiente para "${product.name}". Disponible: ${availStock}`
        );

      const itemSubtotal = unitPrice * item.quantity;
      subtotal += itemSubtotal;

      validatedItems.push({
        product_id: product.id, variant_id: variantId,
        name: product.name, sku: variantSku || product.sku,
        quantity: item.quantity, unit_price: unitPrice, unit_cost: unitCost,
        subtotal: itemSubtotal,
        profit_per_unit: unitPrice - unitCost,
        total_profit:   (unitPrice - unitCost) * item.quantity,
      });
    }

    const total    = subtotal - Number(discount_amount) + Number(tax_amount);
    const initPay  = Math.min(Number(initial_payment) || 0, total);

    // ── Determinar estado de pago ─────────────────────────────
    let finalPaymentStatus;
    let dbPaymentMethod;
    let amountPaidInitial;

    if (isOnline) {
      // Wompi: queda pendiente hasta que el webhook confirme
      finalPaymentStatus = "pending";
      dbPaymentMethod    = "credit";
      amountPaidInitial  = 0;

    } else if (isFiado) {
      // Crédito con posible abono inicial
      dbPaymentMethod = "credit";
      if (initPay <= 0) {
        finalPaymentStatus = "pending";
        amountPaidInitial  = 0;
      } else if (initPay < total) {
        finalPaymentStatus = "partial";
        amountPaidInitial  = initPay;
      } else {
        finalPaymentStatus = "paid";
        amountPaidInitial  = total;
      }

    } else {
      // ✅ Venta local (admin): siempre queda pagada de inmediato
      finalPaymentStatus = "paid";
      dbPaymentMethod    = ["cash", "transfer", "credit", "check"].includes(payment_method)
        ? payment_method : "cash";
      amountPaidInitial  = total;
    }

    // ── Número de venta ───────────────────────────────────────
    const { rows: numRows } = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 5) AS INTEGER)), 0) + 1 AS n
       FROM sales WHERE sale_number LIKE 'VEN-%'`
    );
    const saleNumber = `VEN-${String(numRows[0].n).padStart(6, "0")}`;

    // ── Insertar venta ────────────────────────────────────────
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (
        sale_number, customer_id, subtotal, tax_amount, discount_amount,
        total, amount_paid, payment_method, payment_status, sale_type,
        created_by, shipping_address, shipping_city, shipping_notes,
        credit_due_date, credit_notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id`,
      [
        saleNumber, customer_id, subtotal, tax_amount, discount_amount,
        total,
        amountPaidInitial,
        dbPaymentMethod,
        finalPaymentStatus,
        sale_type,
        req.user?.id ?? customer_id,
        shipping_address ?? null, shipping_city ?? null, shipping_notes ?? null,
        isFiado ? credit_due_date : null,
        isFiado ? credit_notes    : null,
      ]
    );
    const saleId = saleRows[0].id;

    // ── Insertar ítems + reducir stock ────────────────────────
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
          `UPDATE products SET stock = (
             SELECT COALESCE(SUM(pv.stock),0) FROM product_variants pv
             WHERE pv.product_id = $1 AND pv.is_active = true
           ), updated_at = NOW() WHERE id = $1`,
          [item.product_id]
        );
      } else {
        await client.query(
          "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.product_id]
        );
      }
    }

    // ── Registrar pago automático (local o abono fiado) ───────
    if (amountPaidInitial > 0) {
      const payNote = isFiado
        ? `Abono inicial sobre crédito`
        : `Pago completo en tienda`;

      await client.query(
        `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [saleId, amountPaidInitial, dbPaymentMethod, payNote, req.user?.id ?? null]
      );
    }

    await client.query("COMMIT");

    const orderCode = `AL-${saleNumber.slice(4)}`;

    // ── Emails (best-effort) ─────────────────────────────────
    if (customer.email) {
      if (finalPaymentStatus === "paid" && !isFiado) {
        sendPaymentConfirmedEmail?.(customer.email, customer.name, {
          orderCode, total, items: validatedItems,
        }).catch(() => {});
      } else {
        sendOrderConfirmationEmail(customer.email, customer.name, {
          orderCode, total, items: validatedItems,
          shippingAddress: shipping_address, shippingCity: shipping_city,
          shippingNotes:   shipping_notes,
          paymentMethod:   isFiado ? "fiado" : "wompi",
          creditDueDate:   credit_due_date,
          initialPayment:  initPay,
        }).catch(() => {});
      }
    }

    res.status(201).json({
      success: true,
      message: isOnline
        ? "Pedido creado. Redirigiendo al pago…"
        : isFiado
          ? `Venta a crédito registrada${initPay > 0 ? `. Abono de $${fmt(initPay)} registrado.` : ""}`
          : "Venta registrada y pagada ✓",
      data: {
        sale_id:        saleId,
        sale_number:    saleNumber,
        order_code:     orderCode,
        total,
        amount_paid:    amountPaidInitial,
        payment_status: finalPaymentStatus,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CREATE ORDER ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Error al crear la venta" });
  } finally {
    client.release();
  }
};

// ============================================
// 💳 WEBHOOK WOMPI — confirmar pago online
// ============================================
/**
 * POST /api/sales/wompi-webhook
 * Wompi envía un evento cuando el pago se aprueba.
 * Debes verificar la firma antes de procesar.
 *
 * Variables de entorno:
 *   WOMPI_EVENTS_SECRET — para verificar la firma HMAC-SHA256
 */
exports.wompiWebhook = async (req, res) => {
  // ── 1. Verificar firma ────────────────────────────────────
  const crypto   = require("crypto");
  const secret   = process.env.WOMPI_EVENTS_SECRET ?? "";
  const sigHeader = req.headers["x-event-checksum"] ?? "";

  // Wompi firma: sha256( timestamp + properties + secret )
  // Asegúrate de recibir el body como raw buffer para verificar
  const bodyStr   = JSON.stringify(req.body);
  const timestamp = req.headers["x-event-timestamp"] ?? "";
  const signature = crypto
    .createHash("sha256")
    .update(`${timestamp}${bodyStr}${secret}`)
    .digest("hex");

  if (secret && signature !== sigHeader) {
    console.warn("WOMPI WEBHOOK: firma inválida");
    return res.status(401).json({ success: false, message: "Firma inválida" });
  }

  const { event, data } = req.body ?? {};

  // Solo nos interesan transacciones aprobadas
  if (event !== "transaction.updated") return res.sendStatus(200);
  if (data?.transaction?.status !== "APPROVED") return res.sendStatus(200);

  // Wompi devuelve en reference el sale_number (configúralo en el checkout)
  const reference = data.transaction?.reference ?? "";   // e.g. "VEN-000042"
  const amountCents = Number(data.transaction?.amount_in_cents ?? 0);
  const amountCOP   = amountCents / 100;

  if (!reference || !amountCOP) return res.sendStatus(200);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Buscar la venta por sale_number
    const { rows: saleRows } = await client.query(
      "SELECT id, total, payment_status FROM sales WHERE sale_number = $1",
      [reference]
    );

    if (!saleRows.length) {
      console.warn(`WOMPI WEBHOOK: venta ${reference} no encontrada`);
      await client.query("ROLLBACK");
      return res.sendStatus(200);
    }

    const sale = saleRows[0];

    if (sale.payment_status === "paid") {
      // Ya estaba pagada (idempotencia)
      await client.query("ROLLBACK");
      return res.sendStatus(200);
    }

    // Registrar el pago
    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
       VALUES ($1, $2, 'credit', 'Pago aprobado por Wompi', NULL)
       ON CONFLICT DO NOTHING`,
      [sale.id, amountCOP]
    );

    // Sincronizar estado
    const { status } = await syncPaymentStatus(client, sale.id);

    await client.query("COMMIT");
    console.log(`WOMPI WEBHOOK: venta ${reference} → ${status}`);

    // Enviar email de confirmación (best-effort)
    if (status === "paid") {
      const { rows: info } = await db.query(
        `SELECT s.id, s.total, u.name, u.email,
                s.sale_number
         FROM sales s JOIN users u ON u.id = s.customer_id
         WHERE s.id = $1`,
        [sale.id]
      );
      if (info[0]?.email) {
        sendPaymentConfirmedEmail?.(info[0].email, info[0].name, {
          orderCode: `AL-${info[0].sale_number?.slice(4)}`,
          total: info[0].total,
          items: [],
        }).catch(() => {});
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("WOMPI WEBHOOK ERROR:", err);
    return res.sendStatus(500);
  } finally {
    client.release();
  }
};

// ============================================
// 💰 REGISTRAR ABONO / PAGO PARCIAL
// ============================================
exports.registerPayment = async (req, res) => {
  const { id }     = req.params;
  const { amount, payment_method = "cash", notes = null, payment_date } = req.body;

  if (!amount || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: "Monto inválido" });

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows: saleRows } = await client.query(
      "SELECT id, total, amount_paid, payment_status FROM sales WHERE id = $1",
      [id]
    );
    if (!saleRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Venta no encontrada" });
    }
    const sale = saleRows[0];

    if (sale.payment_status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Esta venta ya está pagada por completo" });
    }

    const pending = Number(sale.total) - Number(sale.amount_paid);
    const payAmt  = Math.min(Number(amount), pending);

    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, payment_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id, payAmt, payment_method, notes,
        payment_date ?? new Date().toISOString().slice(0, 10),
        req.user?.id ?? null,
      ]
    );

    const { paid, status } = await syncPaymentStatus(client, id);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: status === "paid"
        ? "¡Venta saldada completamente! ✓"
        : `Abono de $${fmt(payAmt)} registrado. Pendiente: $${fmt(Number(sale.total) - paid)}`,
      data: { amount_paid: paid, payment_status: status, new_payment: payAmt },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("REGISTER PAYMENT ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Error al registrar el pago" });
  } finally {
    client.release();
  }
};

// ============================================
// 📋 HISTORIAL DE PAGOS DE UNA VENTA
// ============================================
exports.getSalePayments = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: saleRows } = await db.query(
      `SELECT s.id, s.sale_number, s.total, s.amount_paid, s.payment_status,
              s.payment_method, s.credit_due_date, s.credit_notes, s.sale_type,
              s.subtotal, s.discount_amount, s.tax_amount,
              u.name AS customer_name
       FROM sales s LEFT JOIN users u ON u.id = s.customer_id
       WHERE s.id = $1`,
      [id]
    );
    if (!saleRows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    const sale = saleRows[0];

    const { rows: payments } = await db.query(
      `SELECT sp.id, sp.amount, sp.payment_method, sp.notes,
              sp.payment_date, sp.created_at,
              u.name AS recorded_by
       FROM sale_payments sp
       LEFT JOIN users u ON u.id = sp.created_by
       WHERE sp.sale_id = $1
       ORDER BY sp.payment_date ASC, sp.created_at ASC`,
      [id]
    );

    res.json({
      success: true,
      data: {
        sale: {
          ...sale,
          pending_amount: Number(sale.total) - Number(sale.amount_paid),
          is_fiado: !!sale.credit_due_date,
        },
        payments,
      },
    });

  } catch (err) {
    console.error("GET SALE PAYMENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener pagos" });
  }
};

// ============================================
// 📄 DETALLE DE ÍTEMS DE UNA VENTA
// ============================================
exports.getOrderDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT
        si.id, si.product_id, si.variant_id, si.quantity,
        si.unit_price, si.subtotal, si.discount_amount,
        p.name, p.sku,
        pv.sku AS variant_sku,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'attribute_type', at.name, 'value', av.value,
              'display_value',  COALESCE(av.display_value, av.value),
              'hex_color',      av.hex_color
            ) ORDER BY at.id
          )
          FROM variant_attribute_values vav
          JOIN attribute_values av ON av.id = vav.attribute_value_id
          JOIN attribute_types  at ON at.id = av.attribute_type_id
          WHERE vav.variant_id = si.variant_id
        ), '[]') AS variant_attributes,
        (SELECT pi.url FROM product_images pi
         WHERE pi.product_id = p.id AND pi.is_main = true LIMIT 1) AS main_image
       FROM sale_items si
       INNER JOIN products p ON si.product_id = p.id
       LEFT  JOIN product_variants pv ON pv.id = si.variant_id
       WHERE si.sale_id = $1
       ORDER BY si.id`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET ORDER DETAIL ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener detalle" });
  }
};

// ============================================
// ❌ CANCELAR PEDIDO (solo pendientes / parciales)
// ============================================
exports.cancelOrder = async (req, res) => {
  const { id }      = req.params;
  const { user_id } = req.body;
  const client      = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id, customer_id, payment_status FROM sales WHERE id = $1",
      [id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }
    const order = rows[0];

    const isAdmin =
      req.user?.roles?.includes("admin") ||
      req.user?.roles?.includes("gerente");

    if (order.customer_id !== parseInt(user_id) && !isAdmin) {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "Sin permiso para cancelar este pedido" });
    }

    if (!["pending", "partial"].includes(order.payment_status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Solo se pueden cancelar pedidos pendientes o parciales",
      });
    }

    // Restaurar stock
    const { rows: items } = await client.query(
      "SELECT product_id, variant_id, quantity FROM sale_items WHERE sale_id = $1",
      [id]
    );

    for (const item of items) {
      if (item.variant_id) {
        await client.query(
          "UPDATE product_variants SET stock = stock + $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.variant_id]
        );
        await client.query(
          `UPDATE products SET stock = (
             SELECT COALESCE(SUM(pv.stock),0) FROM product_variants pv
             WHERE pv.product_id = $1 AND pv.is_active = true
           ), updated_at = NOW() WHERE id = $1`,
          [item.product_id]
        );
      } else {
        await client.query(
          "UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2",
          [item.quantity, item.product_id]
        );
      }
    }

    await client.query(
      "UPDATE sales SET payment_status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [id]
    );
    await client.query("COMMIT");

    res.json({ success: true, message: "Pedido cancelado. Stock restaurado." });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({ success: false, message: "Error al cancelar el pedido" });
  } finally {
    client.release();
  }
};

module.exports = exports;