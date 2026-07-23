"use strict";

const db = require("../../platform/database");

const {
  requireApiPermission,
} = require("../identity/auth");

async function getCustomers(req, res) {
  try {
    const adminId = req.apiKey.adminId;

    const {
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const safeLimit = Math.min(
      parseInt(limit) || 20,
      50
    );

    const offset =
      (
        Math.max(parseInt(page) || 1, 1) -
        1
      ) * safeLimit;

    const params = [adminId];

    let where = `
      WHERE u.owner_admin_id = $1
        AND r.name = 'user'
        AND u.is_active = true
    `;

    if (search) {
      params.push(`%${search}%`);

      where += `
        AND (
          u.name ILIKE $${params.length}
          OR u.email ILIKE $${params.length}
          OR u.phone ILIKE $${params.length}
        )
      `;
    }

    params.push(
      safeLimit,
      offset
    );

    const result = await db.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.phone,
         u.city,
         u.created_at,
         COUNT(DISTINCT s.id)::int AS total_orders,
         COALESCE(SUM(s.total), 0)::numeric AS total_spent
       FROM users u
       LEFT JOIN user_roles ur
         ON ur.user_id = u.id
       LEFT JOIN roles r
         ON r.id = ur.role_id
       LEFT JOIN sales s
         ON s.customer_id = u.id
        AND s.owner_admin_id = $1
       ${where}
       GROUP BY u.id
       ORDER BY total_spent DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  }
  catch (error) {
    console.error(
      "[PUBLIC API] GET /customers",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Error al obtener clientes",
    });
  }
}

function registerCustomerRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerCustomerRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/customers",
    requireApiPermission("customers:read"),
    getCustomers
  );
}

module.exports = Object.freeze({
  registerCustomerRoutes,
  getCustomers,
});