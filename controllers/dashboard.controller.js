const db = require("../config/db");

// ===============================
// DASHBOARD (ADMIN)
// ===============================
// Retorna en una sola respuesta:
//   - todaySales: total recaudado hoy (ventas pagadas)
//   - salesByDay:  últimos 7 días con totales
//   - topProducts: 5 productos más vendidos por cantidad

exports.getDashboard = async (req, res) => {
  try {
    // ─── Total hoy (solo ventas pagadas) ──────────────────────────
    const todayResult = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS total
       FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
        AND payment_status   = 'paid'`
    );

    // ─── Ventas por día (últimos 7 días) ──────────────────────────
    const salesByDayResult = await db.query(
      `SELECT
         DATE(created_at)          AS day,
         COALESCE(SUM(total), 0)   AS total
       FROM sales
      WHERE created_at     >= CURRENT_DATE - INTERVAL '6 days'
        AND payment_status = 'paid'
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC`
    );

    // ─── Top 5 productos por cantidad vendida ─────────────────────
    const topProductsResult = await db.query(
      `SELECT
         p.name,
         SUM(si.quantity) AS qty
       FROM sale_items si
       JOIN products    p ON p.id = si.product_id
       JOIN sales       s ON s.id = si.sale_id
      WHERE s.payment_status = 'paid'
      GROUP BY p.id, p.name
      ORDER BY qty DESC
      LIMIT 5`
    );

    res.json({
      todaySales:  parseFloat(todayResult.rows[0].total),
      salesByDay:  salesByDayResult.rows,
      topProducts: topProductsResult.rows,
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ message: "Error al cargar dashboard" });
  }
};