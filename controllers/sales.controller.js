// src/controllers/sales.controller.js
const db = require("../config/db");
const { sendOrderConfirmationEmail, sendPaymentConfirmedEmail } = require("../config/emailConfig");

const fmt = (n) => Number(n ?? 0).toLocaleString("es-CO");

// ── Helpers de tenant ─────────────────────────────────────────────────────────
const isSA      = (req) => req.user?.roles?.includes("superadmin");
const isManager = (req) =>
  req.user?.roles?.some((r) => ["superadmin", "admin", "gerente"].includes(r));

/**
 * Devuelve la cláusula SQL + params para filtrar ventas por admin propietario.
 * superadmin → sin filtro
 * admin/gerente → solo ventas cuyo owner_admin_id coincida
 */
const tenantSalesClause = (req, startIdx = 1) => {
  if (isSA(req)) return { clause: "", params: [], nextIdx: startIdx };
  return {
    clause:  `AND s.owner_admin_id = $${startIdx}`,
    params:  [req.user.id],
    nextIdx: startIdx + 1,
  };
};

// ── Sincronizar estado de pago ────────────────────────────────────────────────
/**
 * Recalcula y actualiza payment_status + amount_paid de una venta
 * según la suma real de sale_payments. Llama siempre dentro de una tx.
 */
async function syncPaymentStatus(client, saleId) {
  const { rows: payRows } = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM sale_payments WHERE sale_id = $1",
    [saleId]
  );
  const paid = Number(payRows[0].paid);

  const { rows: saleRows } = await client.query(
    "SELECT total FROM sales WHERE id = $1 FOR UPDATE",
    [saleId]
  );
  if (!saleRows.length) throw new Error(`Venta ${saleId} no encontrada al sincronizar`);
  const total = Number(saleRows[0].total);

  const status =
    paid <= 0       ? "pending" :
    paid < total    ? "partial" :
                      "paid";

  await client.query(
    "UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3",
    [paid, status, saleId]
  );
  return { paid, status };
}

// ── Helper: verificar acceso a una venta concreta ────────────────────────────
// Retorna "ok" | "not_found" | "forbidden"
async function checkSaleAccess(req, saleId, client = db) {
  const { rows } = await client.query(
    "SELECT id, owner_admin_id, customer_id FROM sales WHERE id = $1",
    [saleId]
  );
  if (!rows.length) return "not_found";
  if (isSA(req))    return "ok";

  // Admin/gerente: solo sus ventas
  if (isManager(req)) {
    return String(rows[0].owner_admin_id) === String(req.user.id) ? "ok" : "forbidden";
  }
  // Usuario final: solo sus propios pedidos
  return String(rows[0].customer_id) === String(req.user.id) ? "ok" : "forbidden";
}

// ============================================
// 📋 OBTENER TODAS LAS VENTAS
// Admin/gerente: sus ventas    Superadmin: todas
// ============================================
exports.getAllSales = async (req, res) => {
  try {
    if (!isManager(req))
      return res.status(403).json({ success: false, message: "No autorizado" });

    const tc  = tenantSalesClause(req, 1);
    const { page = 1, limit = 50, payment_status, sale_type, start_date, end_date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let idx = tc.nextIdx;
    const params = [...tc.params];
    let filters = "";

    if (payment_status) { filters += ` AND s.payment_status = $${idx++}`; params.push(payment_status); }
    if (sale_type)      { filters += ` AND s.sale_type = $${idx++}`;      params.push(sale_type); }
    if (start_date)     { filters += ` AND s.sale_date >= $${idx++}`;     params.push(start_date); }
    if (end_date)       { filters += ` AND s.sale_date <= $${idx++}`;     params.push(end_date); }

    const query = `
      SELECT
        s.id, s.sale_number, s.customer_id,
        s.sale_date        AS created_at,
        s.total,           s.amount_paid,
        s.payment_status,  s.payment_method,
        s.sale_type,       s.subtotal,
        s.tax_amount,      s.discount_amount,
        s.credit_due_date, s.credit_notes,
        s.shipping_address, s.shipping_city, s.shipping_notes,
        u.name  AS customer_name,
        u.email AS customer_email,
        seller.name AS seller_name,
        adm.name    AS owner_admin_name
      FROM sales s
      LEFT JOIN users u      ON u.id = s.customer_id
      LEFT JOIN users seller ON seller.id = s.created_by
      LEFT JOIN users adm    ON adm.id = s.owner_admin_id
      WHERE 1=1 ${tc.clause} ${filters}
      ORDER BY s.sale_date DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    params.push(parseInt(limit), offset);

    const [salesRes, countRes] = await Promise.all([
      db.query(query, params),
      db.query(
        `SELECT COUNT(*) FROM sales s WHERE 1=1 ${tc.clause} ${filters}`,
        [...tc.params, ...(payment_status ? [payment_status] : []),
                       ...(sale_type      ? [sale_type]      : []),
                       ...(start_date     ? [start_date]     : []),
                       ...(end_date       ? [end_date]       : [])]
      ),
    ]);

    res.json({
      success: true,
      data: salesRes.rows,
      pagination: {
        total:      Number(countRes.rows[0].count),
        page:       parseInt(page),
        limit:      parseInt(limit),
        totalPages: Math.ceil(Number(countRes.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("GET ALL SALES ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
};

// ============================================
// 📦 HISTORIAL DE PEDIDOS DEL USUARIO FINAL
// Solo devuelve sus propios pedidos.
// Si lo llama un admin, requiere que ese userId
// pertenezca a su tenant (owner_admin_id).
// ============================================
exports.getUserOrderHistory = async (req, res) => {
  const { userId } = req.query;
  if (!userId)
    return res.status(400).json({ success: false, message: "userId requerido" });

  try {
    // Verificar que el usuario objetivo pertenezca al admin (si no es superadmin)
    if (!isSA(req) && isManager(req)) {
      const { rows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
        [userId, req.user.id]
      );
      if (!rows.length)
        return res.status(403).json({ success: false, message: "No autorizado para ver pedidos de este usuario" });
    }

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
    res.json({ success: true, data: rows });
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
    // Misma verificación de tenant que getUserOrderHistory
    if (!isSA(req) && isManager(req)) {
      const { rows } = await db.query(
        "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
        [userId, req.user.id]
      );
      if (!rows.length)
        return res.status(403).json({ success: false, message: "No autorizado" });
    }

    const { rows } = await db.query(
      `SELECT
        COUNT(DISTINCT s.id)                                                               AS total_orders,
        COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0)  AS total_invested,
        COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0)  AS pending_amount,
        COALESCE(SUM(CASE WHEN s.payment_status = 'partial' THEN (s.total - s.amount_paid) ELSE 0 END), 0) AS partial_pending,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END) AS completed_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) AS pending_orders,
        COUNT(DISTINCT CASE WHEN s.payment_status = 'partial' THEN s.id END) AS partial_orders
       FROM sales s WHERE s.customer_id = $1`,
      [userId]
    );
    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error("GET USER STATS ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
};

// ============================================
// 🛒 CREAR PEDIDO / VENTA
// Inyecta owner_admin_id del token (null si superadmin)
// ============================================
exports.createOrder = async (req, res) => {
  const {
    customer_id,
    items,
    discount_amount = 0,
    tax_amount      = 0,
    sale_type       = "online",
    payment_method  = "cash",
    credit_due_date = null,
    credit_notes    = null,
    initial_payment = 0,
    shipping_address,
    shipping_city,
    shipping_notes,
  } = req.body;

  if (!customer_id || !items?.length)
    return res.status(400).json({ success: false, message: "Datos incompletos" });

  const isFiado  = payment_method === "fiado";
  const isOnline = sale_type === "online" || sale_type === "web";

  if (isFiado && !credit_due_date)
    return res.status(400).json({
      success: false,
      message: "Se requiere fecha límite de pago para ventas a crédito",
    });

  // Verificar que el cliente pertenezca al admin (si aplica)
  if (!isSA(req) && isManager(req)) {
    const { rows: custCheck } = await db.query(
      "SELECT id FROM users WHERE id = $1 AND owner_admin_id = $2",
      [customer_id, req.user.id]
    );
    if (!custCheck.length)
      return res.status(403).json({ success: false, message: "El cliente no pertenece a tu panel" });
  }

  // owner_admin_id: superadmin crea sin dueño (venta global), admin se marca a sí mismo
  const ownerAdminId = isSA(req) ? null : req.user.id;

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
      // Verificar que el producto también pertenezca al admin
      const ownerCheck = isSA(req) ? "" : "AND p.owner_admin_id = $2";
      const prodParams  = isSA(req) ? [item.product_id] : [item.product_id, req.user.id];

      const { rows: prodRows } = await client.query(
        `SELECT id, name, sku, sale_price, stock, purchase_price, has_variants
         FROM products p WHERE p.id = $1 AND p.is_active = true ${ownerCheck}`,
        prodParams
      );
      if (!prodRows.length)
        throw new Error(`Producto ${item.product_id} no encontrado, inactivo o no autorizado`);
      const product = prodRows[0];

      let variantId  = null;
      let unitCost   = Number(product.purchase_price ?? 0);
      let availStock = Number(product.stock);

      // Precio: respeta el que manda el frontend (ya tiene descuento); cae a DB como respaldo
      let unitPrice = item.unit_price != null
        ? Number(item.unit_price)
        : Number(product.sale_price);

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
        variantId  = v.id;
        availStock = Number(v.stock);
        if (item.unit_price == null && v.sale_price != null) unitPrice = Number(v.sale_price);
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
        product_id:     product.id,
        variant_id:     variantId,
        name:           product.name,
        sku:            product.sku,
        quantity:       item.quantity,
        unit_price:     unitPrice,
        unit_cost:      unitCost,
        subtotal:       itemSubtotal,
        profit_per_unit: unitPrice - unitCost,
        total_profit:   (unitPrice - unitCost) * item.quantity,
      });
    }

    const total   = subtotal - Number(discount_amount) + Number(tax_amount);
    const initPay = Math.min(Number(initial_payment) || 0, total);

    // ── Estado de pago inicial ────────────────────────────────
    let finalPaymentStatus, dbPaymentMethod, amountPaidInitial;

    if (isOnline) {
      finalPaymentStatus = "pending";
      dbPaymentMethod    = "credit";
      amountPaidInitial  = 0;
    } else if (isFiado) {
      dbPaymentMethod = "credit";
      if (initPay <= 0)        { finalPaymentStatus = "pending"; amountPaidInitial = 0; }
      else if (initPay < total){ finalPaymentStatus = "partial"; amountPaidInitial = initPay; }
      else                     { finalPaymentStatus = "paid";    amountPaidInitial = total; }
    } else {
      finalPaymentStatus = "paid";
      dbPaymentMethod    = ["cash", "transfer", "credit", "check"].includes(payment_method)
        ? payment_method : "cash";
      amountPaidInitial  = total;
    }

    // ── Número de venta (secuencia segura dentro de la tx) ────
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
        created_by, owner_admin_id,
        shipping_address, shipping_city, shipping_notes,
        credit_due_date, credit_notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id`,
      [
        saleNumber, customer_id, subtotal, tax_amount, discount_amount,
        total, amountPaidInitial, dbPaymentMethod, finalPaymentStatus, sale_type,
        req.user?.id ?? customer_id,
        ownerAdminId,
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
        // Resincronizar stock agregado del producto padre
        await client.query(
          `UPDATE products SET
             stock = (SELECT COALESCE(SUM(pv.stock), 0)
                      FROM product_variants pv
                      WHERE pv.product_id = $1 AND pv.is_active = true),
             updated_at = NOW()
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

    // ── Registrar pago automático (venta local o abono fiado) ─
    if (amountPaidInitial > 0) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          saleId, amountPaidInitial, dbPaymentMethod,
          isFiado ? "Abono inicial sobre crédito" : "Pago completo en tienda",
          req.user?.id ?? null,
        ]
      );
    }

    await client.query("COMMIT");

    const orderCode = `AL-${saleNumber.slice(4)}`;

    // ── Emails (best-effort, fuera de la tx) ─────────────────
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
    // Stock insuficiente y similares son errores del cliente (400), no del servidor (500)
    const isClientError = err.message && !err.message.startsWith("Error");
    res.status(isClientError ? 400 : 500).json({
      success: false,
      message: err.message || "Error al crear la venta",
    });
  } finally {
    client.release();
  }
};

// ============================================
// 💳 WEBHOOK WOMPI — confirmar pago online
// ============================================
exports.wompiWebhook = async (req, res) => {
  const crypto     = require("crypto");
  const secret     = process.env.WOMPI_EVENTS_SECRET ?? "";
  const sigHeader  = req.headers["x-event-checksum"] ?? "";
  const timestamp  = req.headers["x-event-timestamp"] ?? "";

  // Verificar firma HMAC-SHA256
  if (secret) {
    const bodyStr  = JSON.stringify(req.body);
    const signature = crypto
      .createHash("sha256")
      .update(`${timestamp}${bodyStr}${secret}`)
      .digest("hex");
    if (signature !== sigHeader) {
      console.warn("WOMPI WEBHOOK: firma inválida");
      return res.status(401).json({ success: false, message: "Firma inválida" });
    }
  }

  const { event, data } = req.body ?? {};

  if (event !== "transaction.updated")         return res.sendStatus(200);
  if (data?.transaction?.status !== "APPROVED") return res.sendStatus(200);

  const reference   = data.transaction?.reference ?? "";
  const amountCOP   = Number(data.transaction?.amount_in_cents ?? 0) / 100;

  if (!reference || !amountCOP) return res.sendStatus(200);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

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

    // Idempotencia: si ya estaba pagada no hacemos nada
    if (sale.payment_status === "paid") {
      await client.query("ROLLBACK");
      return res.sendStatus(200);
    }

    // ON CONFLICT evita duplicar pagos si Wompi re-envía el webhook
    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, created_by)
       VALUES ($1, $2, 'credit', 'Pago aprobado por Wompi', NULL)
       ON CONFLICT DO NOTHING`,
      [sale.id, amountCOP]
    );

    const { status } = await syncPaymentStatus(client, sale.id);
    await client.query("COMMIT");

    console.log(`WOMPI WEBHOOK: venta ${reference} → ${status}`);

    if (status === "paid") {
      const { rows: info } = await db.query(
        `SELECT s.total, s.sale_number, u.name, u.email
         FROM sales s JOIN users u ON u.id = s.customer_id
         WHERE s.id = $1`,
        [sale.id]
      );
      if (info[0]?.email) {
        sendPaymentConfirmedEmail?.(info[0].email, info[0].name, {
          orderCode: `AL-${info[0].sale_number?.slice(4)}`,
          total:     info[0].total,
          items:     [],
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
// Solo el admin dueño de la venta (o superadmin)
// ============================================
exports.registerPayment = async (req, res) => {
  const { id } = req.params;
  const { amount, payment_method = "cash", notes = null, payment_date } = req.body;

  if (!amount || Number(amount) <= 0)
    return res.status(400).json({ success: false, message: "Monto inválido" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verificar acceso antes de cualquier escritura
    const access = await checkSaleAccess(req, id, client);
    if (access === "not_found") {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Venta no encontrada" });
    }
    if (access === "forbidden") {
      await client.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "No autorizado para registrar pagos en esta venta" });
    }

    const { rows: saleRows } = await client.query(
      "SELECT id, total, amount_paid, payment_status FROM sales WHERE id = $1 FOR UPDATE",
      [id]
    );
    const sale = saleRows[0];

    if (sale.payment_status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Esta venta ya está pagada por completo" });
    }

    if (sale.payment_status === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No se puede abonar a una venta cancelada" });
    }

    const pending = Number(sale.total) - Number(sale.amount_paid);
    // No permitir abono mayor al pendiente (truncar silenciosamente era confuso)
    if (Number(amount) > pending)
      return res.status(400).json({
        success: false,
        message: `El monto excede el saldo pendiente ($${fmt(pending)})`,
      });

    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, payment_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id, Number(amount), payment_method, notes,
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
        : `Abono de $${fmt(Number(amount))} registrado. Pendiente: $${fmt(Number(sale.total) - paid)}`,
      data: { amount_paid: paid, payment_status: status, new_payment: Number(amount) },
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
    const access = await checkSaleAccess(req, id);
    if (access === "not_found") return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden") return res.status(403).json({ success: false, message: "No autorizado" });

    const { rows: saleRows } = await db.query(
      `SELECT s.id, s.sale_number, s.total, s.amount_paid, s.payment_status,
              s.payment_method, s.credit_due_date, s.credit_notes, s.sale_type,
              s.subtotal, s.discount_amount, s.tax_amount,
              u.name AS customer_name
       FROM sales s LEFT JOIN users u ON u.id = s.customer_id
       WHERE s.id = $1`,
      [id]
    );
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
    const access = await checkSaleAccess(req, id);
    if (access === "not_found") return res.status(404).json({ success: false, message: "Venta no encontrada" });
    if (access === "forbidden") return res.status(403).json({ success: false, message: "No autorizado" });

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
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET ORDER DETAIL ERROR:", err);
    res.status(500).json({ success: false, message: "Error al obtener detalle" });
  }
};

// ============================================
// ❌ CANCELAR PEDIDO (solo pending / partial)
// Admin solo cancela los suyos; superadmin cualquiera.
// Usuario final cancela los propios (si no están pagados).
// ============================================
exports.cancelOrder = async (req, res) => {
  const { id }      = req.params;
  const { user_id } = req.body;
  const client      = await db.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id, customer_id, payment_status, owner_admin_id FROM sales WHERE id = $1",
      [id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Pedido no encontrado" });
    }
    const order = rows[0];

    // ── Verificar autorización ────────────────────────────────
    if (!isSA(req)) {
      if (isManager(req)) {
        // Admin/gerente: solo puede cancelar ventas de su propio tenant
        if (String(order.owner_admin_id) !== String(req.user.id)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ success: false, message: "No autorizado para cancelar este pedido" });
        }
      } else {
        // Usuario final: solo sus propios pedidos
        if (String(order.customer_id) !== String(user_id ?? req.user?.id)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ success: false, message: "Sin permiso para cancelar este pedido" });
        }
      }
    }

    if (!["pending", "partial"].includes(order.payment_status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Solo se pueden cancelar pedidos pendientes o parciales",
      });
    }

    // ── Restaurar stock ───────────────────────────────────────
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
          `UPDATE products SET
             stock = (SELECT COALESCE(SUM(pv.stock), 0)
                      FROM product_variants pv
                      WHERE pv.product_id = $1 AND pv.is_active = true),
             updated_at = NOW()
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

    // Marcar como cancelado (no eliminamos, mantenemos el historial)
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