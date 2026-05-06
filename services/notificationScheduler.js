// src/services/notificationScheduler.js
// npm install node-cron
//
// Importar en app.js / server.js:
//   require('./services/notificationScheduler');

const cron = require("node-cron");
const db   = require("../config/db");
const { notifyUser, broadcast, Payloads } = require("./push.service");

// ── Registro de qué ya fue notificado (en memoria, resiste reinicios via BD) ──
// Para evitar spam, llevamos un Set por sesión y usamos la BD como fuente de verdad.

// ─────────────────────────────────────────────────────────────
// HELPER: obtener admins/managers para notificaciones internas
// ─────────────────────────────────────────────────────────────
async function getManagerIds() {
  const { rows } = await db.query(`
    SELECT ur.user_id
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE r.name IN ('admin', 'manager')
  `);
  return rows.map((r) => r.user_id);
}

async function notifyManagers(payload) {
  const managerIds = await getManagerIds();
  if (!managerIds.length) return;
  await Promise.allSettled(managerIds.map((id) => notifyUser(id, payload)));
}

// ─────────────────────────────────────────────────────────────
// TAREA 1: Stock crítico — cada 30 minutos
// ─────────────────────────────────────────────────────────────
cron.schedule("*/30 * * * *", async () => {
  try {
    // Productos sin stock (solo los que cambiaron en los últimos 35 min para no repetir)
    const { rows: outOfStock } = await db.query(`
      SELECT id, name, sku
      FROM products
      WHERE is_active = true
        AND stock = 0
        AND updated_at > NOW() - INTERVAL '35 minutes'
    `);

    for (const p of outOfStock) {
      const payload = Payloads.outOfStock(p.name + (p.sku ? ` (${p.sku})` : ""));
      await notifyManagers(payload).catch(console.error);
    }

    // Productos con stock bajo (recién cruzaron el umbral)
    const { rows: lowStock } = await db.query(`
      SELECT id, name, stock, min_stock, sku
      FROM products
      WHERE is_active = true
        AND stock > 0
        AND stock <= min_stock
        AND updated_at > NOW() - INTERVAL '35 minutes'
    `);

    for (const p of lowStock) {
      const payload = Payloads.lowStock(p.name, p.stock, p.min_stock);
      await notifyManagers(payload).catch(console.error);
    }

    if (outOfStock.length || lowStock.length) {
      console.log(`[Scheduler/Stock] Sin stock: ${outOfStock.length} | Stock bajo: ${lowStock.length}`);
    }
  } catch (err) {
    console.error("[Scheduler/Stock] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 2: Facturas vencidas — diario a las 9:00
// ─────────────────────────────────────────────────────────────
cron.schedule("0 9 * * *", async () => {
  try {
    const { rows } = await db.query(`
      SELECT i.id, i.pending_amount,
             p.name AS provider_name,
             EXTRACT(DAY FROM NOW() - i.due_date)::int AS days_overdue
      FROM invoices i
      LEFT JOIN providers p ON p.id = i.provider_id
      WHERE i.payment_status != 'paid'
        AND i.due_date < NOW()
      ORDER BY days_overdue DESC
      LIMIT 5
    `);

    for (const inv of rows) {
      const payload = Payloads.overdueInvoice(inv.provider_name, inv.pending_amount);
      await notifyManagers(payload).catch(console.error);
    }

    if (rows.length) {
      console.log(`[Scheduler/Invoices] ${rows.length} facturas vencidas notificadas`);
    }
  } catch (err) {
    console.error("[Scheduler/Invoices] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 3: Descuentos que vencen pronto — cada hora
// ─────────────────────────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    // Notificar cuando queden exactamente 24h (ventana de ±35 min para no perder el cron)
    const { rows } = await db.query(`
      SELECT id, name,
             EXTRACT(HOUR FROM ends_at - NOW())::int AS hours_left
      FROM discounts
      WHERE active = true
        AND ends_at BETWEEN NOW() + INTERVAL '23 hours 25 minutes'
                        AND NOW() + INTERVAL '24 hours 35 minutes'
    `);

    for (const d of rows) {
      const payload = Payloads.expiringDiscount(d.name, "24h");
      await notifyManagers(payload).catch(console.error);
    }

    // También: descuentos que vencen en 1h
    const { rows: urgent } = await db.query(`
      SELECT id, name
      FROM discounts
      WHERE active = true
        AND ends_at BETWEEN NOW() + INTERVAL '25 minutes'
                        AND NOW() + INTERVAL '1 hour 35 minutes'
    `);

    for (const d of urgent) {
      const payload = Payloads.expiringDiscount(d.name, "1h");
      await notifyManagers(payload).catch(console.error);
    }
  } catch (err) {
    console.error("[Scheduler/Discounts] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 4: Órdenes de compra sin recibir — diario a las 8:00
// ─────────────────────────────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  try {
    const { rows } = await db.query(`
      SELECT po.order_number, p.name AS provider_name,
             EXTRACT(DAY FROM NOW() - po.order_date)::int AS days_pending
      FROM purchase_orders po
      LEFT JOIN providers p ON p.id = po.provider_id
      WHERE po.status = 'pending'
        AND po.order_date < NOW() - INTERVAL '7 days'
      LIMIT 5
    `);

    for (const po of rows) {
      await notifyManagers({
        title:    `📦 Orden sin recibir (${po.days_pending} días)`,
        body:     `${po.order_number} — ${po.provider_name}`,
        icon:     "/icon-192.png",
        badge:    "/badge-72.png",
        url:      "/tools/providers",
        tag:      "purchase-order-pending",
        severity: po.days_pending > 14 ? "critical" : "warning",
      }).catch(console.error);
    }
  } catch (err) {
    console.error("[Scheduler/PurchaseOrders] Error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TAREA 5: Limpiar suscripciones expiradas — semanal (lunes 3 AM)
// ─────────────────────────────────────────────────────────────
cron.schedule("0 3 * * 1", async () => {
  try {
    const { rowCount } = await db.query(`
      DELETE FROM push_subscriptions
      WHERE is_active = false
        AND updated_at < NOW() - INTERVAL '30 days'
    `);
    console.log(`[Scheduler/Cleanup] ${rowCount} suscripciones expiradas eliminadas`);
  } catch (err) {
    console.error("[Scheduler/Cleanup] Error:", err.message);
  }
});

console.log("[Scheduler] ✅ Tareas cron registradas");