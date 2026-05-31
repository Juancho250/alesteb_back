// services/inventory.jobs.js
// Two cron jobs for the inventory engine:
//   1. Release expired reservations (every minute)
//   2. Create stock alerts for low/out-of-stock products (every 15 min)
const cron = require('node-cron');
const db   = require('../config/db');
const inv  = require('./inventory.service');

// ─── Job 1: liberar reservas vencidas ────────────────────────────────────────
function startReservationCleanupJob() {
  cron.schedule('* * * * *', async () => {
    let released = 0;
    try {
      const { rows: expired } = await db.query(
        `SELECT id, owner_admin_id
         FROM stock_reservations
         WHERE status = 'active' AND expires_at < NOW()
         LIMIT 100`,
      );

      for (const r of expired) {
        try {
          await inv.releaseReservation(r.id, { ownerAdminId: r.owner_admin_id, userId: 0 }, 'expired');
          released++;
        } catch (err) {
          console.error('[inventory-cleanup] error liberando reserva', r.id, err.message);
        }
      }
      if (released > 0) console.log(`[inventory-cleanup] liberadas ${released} reservas`);
    } catch (err) {
      console.error('[inventory-cleanup] error en job:', err.message);
    }
  });
}

// ─── Job 2: alertas de stock bajo ────────────────────────────────────────────
function startLowStockAlertJob() {
  cron.schedule('*/15 * * * *', async () => {
    let created = 0;
    try {
      // Products/variants where disponible <= min_stock and no unresolved alert exists
      const { rows } = await db.query(`
        SELECT v.owner_admin_id,
               v.product_id,
               v.variant_id,
               v.disponible,
               v.stock_fisico,
               v.min_stock
        FROM v_stock_disponible v
        WHERE v.disponible <= COALESCE(v.min_stock, 0)
          AND NOT EXISTS (
            SELECT 1 FROM stock_alerts a
            WHERE a.product_id = v.product_id
              AND a.variant_id IS NOT DISTINCT FROM v.variant_id
              AND a.resolved   = false
              AND a.alert_type IN ('low_stock', 'out_of_stock')
          )
      `);

      for (const row of rows) {
        try {
          const alertType = row.stock_fisico <= 0 ? 'out_of_stock' : 'low_stock';
          await db.query(
            `INSERT INTO stock_alerts
               (owner_admin_id, product_id, variant_id, alert_type, threshold, current_value)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [row.owner_admin_id, row.product_id, row.variant_id,
             alertType, row.min_stock ?? 0, row.disponible],
          );
          created++;
        } catch (err) {
          console.error('[inventory-alerts] error creando alerta producto', row.product_id, err.message);
        }
      }
      if (created > 0) console.log(`[inventory-alerts] creadas ${created} alertas`);
    } catch (err) {
      console.error('[inventory-alerts] error en job:', err.message);
    }
  });
}

function startInventoryJobs() {
  startReservationCleanupJob();
  startLowStockAlertJob();
  console.log('[inventory-jobs] reservation-cleanup (1min) + low-stock-alerts (15min) iniciados');
}

module.exports = { startInventoryJobs };
