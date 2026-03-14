// src/controllers/notifications.controller.js
const db = require("../config/db");

exports.getAll = async (req, res) => {
  try {
    const [
      outOfStock,
      lowStock,
      pendingOrders,
      overdueInvoices,
      expiringDiscounts,
      expiredDiscounts,
      pendingPurchaseOrders,
      highDebtProviders,
    ] = await Promise.all([

      // 1. Productos sin stock
      db.query(`
        SELECT id, name, stock, sku
        FROM products
        WHERE is_active = true AND stock = 0
        ORDER BY updated_at DESC
        LIMIT 10
      `),

      // 2. Productos con stock bajo (stock > 0 pero <= min_stock)
      db.query(`
        SELECT id, name, stock, min_stock, sku
        FROM products
        WHERE is_active = true AND stock > 0 AND stock <= min_stock
        ORDER BY stock ASC
        LIMIT 10
      `),

      // 3. Pedidos online pendientes de pago
      db.query(`
        SELECT s.id, s.sale_number, s.total, s.sale_date,
               u.name AS customer_name
        FROM sales s
        LEFT JOIN users u ON u.id = s.customer_id
        WHERE s.payment_status = 'pending'
          AND s.sale_type != 'fisica'
        ORDER BY s.sale_date DESC
        LIMIT 10
      `),

      // 4. Facturas vencidas sin pagar
      db.query(`
        SELECT i.id, i.invoice_number, i.total_amount, i.pending_amount,
               i.due_date, i.invoice_type,
               p.name AS provider_name,
               EXTRACT(DAY FROM NOW() - i.due_date)::int AS days_overdue
        FROM invoices i
        LEFT JOIN providers p ON p.id = i.provider_id
        WHERE i.payment_status != 'paid'
          AND i.due_date < NOW()
        ORDER BY i.due_date ASC
        LIMIT 10
      `),

      // 5. Descuentos que vencen en los próximos 3 días
      db.query(`
        SELECT id, name, ends_at,
               EXTRACT(HOUR FROM ends_at - NOW())::int AS hours_left
        FROM discounts
        WHERE active = true
          AND ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        ORDER BY ends_at ASC
        LIMIT 5
      `),

      // 6. Descuentos vencidos pero aún marcados como activos
      db.query(`
        SELECT id, name, ends_at
        FROM discounts
        WHERE active = true AND ends_at < NOW()
        ORDER BY ends_at DESC
        LIMIT 5
      `),

      // 7. Órdenes de compra pendientes de recibir (> 7 días)
      db.query(`
        SELECT po.id, po.order_number, po.order_date,
               po.expected_delivery_date, po.total_cost,
               p.name AS provider_name,
               EXTRACT(DAY FROM NOW() - po.order_date)::int AS days_pending
        FROM purchase_orders po
        LEFT JOIN providers p ON p.id = po.provider_id
        WHERE po.status = 'pending'
          AND po.order_date < NOW() - INTERVAL '7 days'
        ORDER BY po.order_date ASC
        LIMIT 5
      `),

      // 8. Proveedores con deuda alta (> 80% del crédito)
      db.query(`
        SELECT id, name, balance, credit_limit,
               ROUND((balance / NULLIF(credit_limit, 0) * 100)::numeric, 1) AS credit_used_pct
        FROM providers
        WHERE is_active = true
          AND credit_limit > 0
          AND balance >= credit_limit * 0.8
        ORDER BY credit_used_pct DESC
        LIMIT 5
      `),
    ]);

    // Construir array de notificaciones con tipo, severidad y enlace
    const notifications = [];

    outOfStock.rows.forEach(p => {
      notifications.push({
        id: `out-${p.id}`,
        type: "stock",
        severity: "critical",
        title: "Sin stock",
        message: `${p.name}${p.sku ? ` (${p.sku})` : ""} — 0 unidades`,
        link: `/products/${p.id}`,
        created_at: new Date().toISOString(),
      });
    });

    lowStock.rows.forEach(p => {
      notifications.push({
        id: `low-${p.id}`,
        type: "stock",
        severity: "warning",
        title: "Stock bajo",
        message: `${p.name} — ${p.stock} uds (mín. ${p.min_stock})`,
        link: `/products/${p.id}`,
        created_at: new Date().toISOString(),
      });
    });

    pendingOrders.rows.forEach(o => {
      notifications.push({
        id: `order-${o.id}`,
        type: "sale",
        severity: "info",
        title: "Pago pendiente",
        message: `${o.sale_number} — ${o.customer_name || "Cliente"} · $${Number(o.total).toLocaleString("es-CO")}`,
        link: `/history`,
        created_at: o.sale_date,
      });
    });

    overdueInvoices.rows.forEach(i => {
      notifications.push({
        id: `inv-${i.id}`,
        type: "finance",
        severity: i.days_overdue > 30 ? "critical" : "warning",
        title: `Factura vencida hace ${i.days_overdue} días`,
        message: `${i.provider_name || "Sin proveedor"} — $${Number(i.pending_amount).toLocaleString("es-CO")} pendiente`,
        link: `/tools/finance`,
        created_at: i.due_date,
      });
    });

    expiringDiscounts.rows.forEach(d => {
      const h = d.hours_left;
      const label = h < 24 ? `${h}h` : `${Math.ceil(h / 24)} días`;
      notifications.push({
        id: `disc-exp-${d.id}`,
        type: "discount",
        severity: h < 24 ? "warning" : "info",
        title: `Descuento vence en ${label}`,
        message: d.name,
        link: `/tools/discounts`,
        created_at: new Date().toISOString(),
      });
    });

    expiredDiscounts.rows.forEach(d => {
      notifications.push({
        id: `disc-dead-${d.id}`,
        type: "discount",
        severity: "warning",
        title: "Descuento vencido activo",
        message: `"${d.name}" venció pero sigue activo`,
        link: `/tools/discounts`,
        created_at: d.ends_at,
      });
    });

    pendingPurchaseOrders.rows.forEach(po => {
      notifications.push({
        id: `po-${po.id}`,
        type: "purchase",
        severity: "info",
        title: `Orden sin recibir (${po.days_pending} días)`,
        message: `${po.order_number} — ${po.provider_name}`,
        link: `/tools/providers`,
        created_at: po.order_date,
      });
    });

    highDebtProviders.rows.forEach(p => {
      notifications.push({
        id: `debt-${p.id}`,
        type: "finance",
        severity: p.credit_used_pct >= 100 ? "critical" : "warning",
        title: `Proveedor al ${p.credit_used_pct}% de crédito`,
        message: `${p.name} — $${Number(p.balance).toLocaleString("es-CO")} de deuda`,
        link: `/tools/finance`,
        created_at: new Date().toISOString(),
      });
    });

    // Ordenar: critical primero, luego warning, luego info
    const order = { critical: 0, warning: 1, info: 2 };
    notifications.sort((a, b) => order[a.severity] - order[b.severity]);

    res.json({
      success: true,
      count: notifications.length,
      critical: notifications.filter(n => n.severity === "critical").length,
      data: notifications,
    });

  } catch (error) {
    console.error("[NOTIFICATIONS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener notificaciones" });
  }
};