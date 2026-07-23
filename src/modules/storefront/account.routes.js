"use strict";

const db = require("../../platform/database");

const {
  auth,
} = require("../identity/auth");

async function getUserSalesHistory(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT
         s.id,
         s.sale_number     AS order_code,
         s.sale_date       AS created_at,
         s.total,
         s.amount_paid,
         s.payment_status,
         s.payment_method,
         s.sale_type,
         s.subtotal,
         s.tax_amount,
         s.discount_amount,
         s.credit_due_date,
         s.shipping_address,
         s.shipping_city,
         s.shipping_notes
       FROM sales s
       WHERE s.customer_id = $1
         AND s.owner_admin_id = $2
       ORDER BY s.sale_date DESC`,
      [
        req.user.id,
        req.apiKey.adminId,
      ]
    );

    res.json({
      success: true,
      data: rows,
    });
  }
  catch (error) {
    console.error(
      "[PUBLIC API] GET /sales/user/history:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Error al obtener historial",
    });
  }
}

async function getUserSalesStats(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(DISTINCT s.id) AS total_orders,
         COALESCE(
           SUM(
             CASE
               WHEN s.payment_status = 'paid'
                 THEN s.total
               ELSE 0
             END
           ),
           0
         ) AS total_invested,
         COALESCE(
           SUM(
             CASE
               WHEN s.payment_status = 'pending'
                 THEN s.total
               ELSE 0
             END
           ),
           0
         ) AS pending_amount,
         COALESCE(
           SUM(
             CASE
               WHEN s.payment_status = 'partial'
                 THEN s.total - s.amount_paid
               ELSE 0
             END
           ),
           0
         ) AS partial_pending,
         COUNT(
           DISTINCT CASE
             WHEN s.payment_status = 'paid'
               THEN s.id
           END
         ) AS completed_orders,
         COUNT(
           DISTINCT CASE
             WHEN s.payment_status = 'pending'
               THEN s.id
           END
         ) AS pending_orders,
         COUNT(
           DISTINCT CASE
             WHEN s.payment_status = 'partial'
               THEN s.id
           END
         ) AS partial_orders
       FROM sales s
       WHERE s.customer_id = $1
         AND s.owner_admin_id = $2`,
      [
        req.user.id,
        req.apiKey.adminId,
      ]
    );

    res.json({
      success: true,
      summary: rows[0],
    });
  }
  catch (error) {
    console.error(
      "[PUBLIC API] GET /sales/user/stats:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
    });
  }
}

function registerAccountRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerAccountRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/sales/user/history",
    auth,
    getUserSalesHistory
  );

  router.get(
    "/sales/user/stats",
    auth,
    getUserSalesStats
  );
}

module.exports = Object.freeze({
  registerAccountRoutes,
  getUserSalesHistory,
  getUserSalesStats,
});