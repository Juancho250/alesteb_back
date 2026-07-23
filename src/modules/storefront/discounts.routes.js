"use strict";

const db = require("../../platform/database");

async function getDiscounts(req, res) {
  try {
    const adminId = req.apiKey.adminId;
    const now     = new Date();

    const result = await db.query(
      `SELECT
         d.id, d.name, d.code, d.type, d.value, d.scope,
         d.min_purchase_amount, d.max_discount_amount,
         d.starts_at, d.ends_at,
         d.usage_limit, d.times_used,
         d.description,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'target_type', dt.target_type,
             'target_id',   dt.target_id
           ))
           FROM discount_targets dt
           WHERE dt.discount_id = d.id),
           '[]'
         ) AS targets
       FROM discounts d
       WHERE d.active = true
         AND d.owner_admin_id = $1
         AND d.starts_at <= $2
         AND d.ends_at   >= $2
         AND (d.scope = 'web' OR d.scope = 'all')
         AND (d.usage_limit IS NULL OR d.times_used < d.usage_limit)
       ORDER BY d.ends_at ASC`,
      [adminId, now]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /discounts", error);
    res.status(500).json({ success: false, message: "Error al obtener descuentos" });
  }
}

async function validateDiscount(req, res) {
  try {
    const adminId          = req.apiKey.adminId;
    const { code, amount } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: "Código requerido" });
    }

    const now = new Date();

    const result = await db.query(
      `SELECT
         id, name, code, type, value,
         min_purchase_amount, max_discount_amount,
         usage_limit, times_used
       FROM discounts
       WHERE code = $1
         AND owner_admin_id = $2
         AND active = true
         AND starts_at <= $3
         AND ends_at   >= $3
         AND (scope = 'web' OR scope = 'all')
         AND (usage_limit IS NULL OR times_used < usage_limit)`,
      [code.toUpperCase().trim(), adminId, now]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Cupón inválido, expirado o no disponible",
        code:    "INVALID_COUPON",
      });
    }

    const discount = result.rows[0];

    if (amount && parseFloat(amount) < parseFloat(discount.min_purchase_amount)) {
      return res.status(400).json({
        success: false,
        message: `Compra mínima requerida: $${discount.min_purchase_amount}`,
        code:    "MIN_PURCHASE_NOT_MET",
      });
    }

    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = (parseFloat(amount || 0) * discount.value) / 100;
      if (discount.max_discount_amount) {
        discountAmount = Math.min(discountAmount, parseFloat(discount.max_discount_amount));
      }
    } else {
      discountAmount = parseFloat(discount.value);
    }

    return res.json({
      success: true,
      data: {
        ...discount,
        discount_amount: parseFloat(discountAmount.toFixed(2)),
        final_amount:    parseFloat((parseFloat(amount || 0) - discountAmount).toFixed(2)),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] POST /discounts/validate", error);
    res.status(500).json({ success: false, message: "Error al validar cupón" });
  }
}

function registerDiscountRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function" ||
    typeof router.post !== "function"
  ) {
    throw new TypeError(
      "registerDiscountRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/discounts",
    getDiscounts
  );

  router.post(
    "/discounts/validate",
    validateDiscount
  );
}

module.exports = Object.freeze({
  registerDiscountRoutes,
  getDiscounts,
  validateDiscount,
});

