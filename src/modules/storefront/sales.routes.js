"use strict";

const db = require("../../platform/database");

const {
  requireApiPermission,
  auth,
} = require("../identity/auth");

const inv =
  require("../inventory").service;

const {
  service: procurement,
} = require("../procurement");

const {
  notifyTenant,
  Payloads,
} = require("../notifications").push;

const {
  enqueueNotification,
} = require("../notifications").service;

async function getSales(req, res) {
  try {
    const adminId                           = req.apiKey.adminId;
    const { page = 1, limit = 20, status } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where    = "WHERE s.owner_admin_id = $1";

    if (status) {
      params.push(status);
      where += ` AND s.payment_status = $${params.length}`;
    }

    params.push(safeLimit, offset);

    const result = await db.query(
      `SELECT
         s.id, s.sale_number, s.sale_date,
         s.subtotal, s.discount_amount, s.total,
         s.payment_method, s.payment_status, s.sale_type,
         s.shipping_address, s.customer_phone,
         COUNT(si.id)::int                  AS items_count,
         COALESCE(SUM(si.quantity), 0)::int AS units_total
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY s.sale_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data:    result.rows,
      meta: { page: parseInt(page), limit: safeLimit },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /sales", error);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
}

async function createSale(req, res) {
  const client = await db.connect();
  let clientReleased = false;
  try {
    const adminId = req.apiKey.adminId;
    const {
      items,
      session_id:     sessionId,
      customer_phone,
      shipping_address,
      shipping_city,
      shipping_notes,
      payment_method = "transfer",
      coupon_code,
      discount_id:    reqDiscountId,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Se requiere al menos un item", code: "MISSING_ITEMS" });
    }

    await client.query("BEGIN");

    let subtotal    = 0;
    const saleItems = [];

    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity < 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cada item requiere product_id y quantity válidos", code: "INVALID_ITEM" });
      }

      const productRes = await client.query(
        `SELECT id, name, sale_price, stock, stock_reserved, stock_safety, purchase_price, has_variants, fulfillment_mode
         FROM products
         WHERE id = $1 AND is_active = true AND owner_admin_id = $2`,
        [item.product_id, adminId]
      );

      if (productRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Producto ID ${item.product_id} no encontrado`, code: "PRODUCT_NOT_FOUND" });
      }

      const product = productRes.rows[0];
      let variantId = null;
      let unitPrice = Number(product.sale_price);
      const unitCost = Number(product.purchase_price ?? 0);
      let disponible = Math.max(0, product.stock - product.stock_reserved - (product.stock_safety ?? 0));

      if (product.has_variants) {
        if (!item.variant_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: `"${product.name}" tiene variantes — especifica variant_id`, code: "VARIANT_REQUIRED" });
        }
        const varRes = await client.query(
          `SELECT id, sale_price, stock, stock_reserved, stock_safety
           FROM product_variants WHERE id = $1 AND product_id = $2 AND is_active = true`,
          [item.variant_id, item.product_id]
        );
        if (!varRes.rowCount) {
          await client.query("ROLLBACK");
          return res.status(404).json({ success: false, message: `Variante ${item.variant_id} no encontrada o inactiva`, code: "VARIANT_NOT_FOUND" });
        }
        const variant = varRes.rows[0];
        variantId = variant.id;
        if (variant.sale_price != null) unitPrice = Number(variant.sale_price);
        disponible = Math.max(0, variant.stock - variant.stock_reserved - (variant.stock_safety ?? 0));
      }

      // Hybrid: if physical stock covers the order → stock path, otherwise → procurement
      const fulfillmentSnapshot = disponible >= item.quantity ? 'stock' : 'on_demand';

      const itemSubtotal = unitPrice * item.quantity;
      subtotal += itemSubtotal;
      saleItems.push({
        product_id:       product.id,
        variant_id:       variantId,
        quantity:         item.quantity,
        unit_price:       unitPrice,
        unit_cost:        unitCost,
        subtotal:         itemSubtotal,
        profit_unit:      unitPrice - unitCost,
        total_profit:     (unitPrice - unitCost) * item.quantity,
        fulfillment_mode: fulfillmentSnapshot,
      });
    }

    let discountAmount = 0;
    let discountId     = null;
    const now          = new Date();

    if (coupon_code) {
      const couponRes = await client.query(
        `SELECT id, type, value, min_purchase_amount, max_discount_amount
         FROM discounts
         WHERE code = $1 AND owner_admin_id = $2 AND active = true
           AND starts_at <= $3 AND ends_at >= $3
           AND (scope = 'web' OR scope = 'all')
           AND (usage_limit IS NULL OR times_used < usage_limit)
         FOR UPDATE`,
        [coupon_code.toUpperCase().trim(), adminId, now]
      );

      if (couponRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cupón inválido o expirado", code: "INVALID_COUPON" });
      }

      const coupon = couponRes.rows[0];

      if (coupon.min_purchase_amount && subtotal < parseFloat(coupon.min_purchase_amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Compra mínima requerida: $${coupon.min_purchase_amount}`, code: "MIN_PURCHASE_NOT_MET" });
      }

      if (coupon.type === "percentage") {
        discountAmount = (subtotal * coupon.value) / 100;
        if (coupon.max_discount_amount) discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount_amount));
      } else {
        discountAmount = parseFloat(coupon.value);
      }
      discountAmount = Math.min(Math.round(discountAmount), subtotal);

      discountId = coupon.id;
      await client.query("UPDATE discounts SET times_used = times_used + 1 WHERE id = $1", [coupon.id]);

    } else if (reqDiscountId) {
      const discountRes = await client.query(
        `SELECT id, type, value, min_purchase_amount, max_discount_amount
         FROM discounts
         WHERE id = $1 AND owner_admin_id = $2 AND active = true
           AND starts_at <= $3 AND ends_at >= $3
           AND (scope = 'web' OR scope = 'all')
           AND (usage_limit IS NULL OR times_used < usage_limit)
         FOR UPDATE`,
        [reqDiscountId, adminId, now]
      );

      if (discountRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Descuento inválido, expirado o no disponible para canal web", code: "INVALID_DISCOUNT" });
      }

      const discount = discountRes.rows[0];

      if (discount.min_purchase_amount && subtotal < parseFloat(discount.min_purchase_amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Compra mínima requerida: $${discount.min_purchase_amount}`, code: "MIN_PURCHASE_NOT_MET" });
      }

      if (discount.type === "percentage") {
        discountAmount = (subtotal * discount.value) / 100;
        if (discount.max_discount_amount) discountAmount = Math.min(discountAmount, parseFloat(discount.max_discount_amount));
      } else {
        discountAmount = parseFloat(discount.value);
      }
      discountAmount = Math.min(Math.round(discountAmount), subtotal);

      discountId = discount.id;
      await client.query("UPDATE discounts SET times_used = times_used + 1 WHERE id = $1", [discount.id]);
    }

    const total      = Math.max(0, subtotal - discountAmount);
    const saleNumber = `WEB-${adminId}-${Date.now()}`;

    // MEDIO-1: liberar reservas activas de la sesión dentro de la misma tx
    // para que stock_reserved quede en sync antes del descuento de stock físico.
    if (sessionId) {
      const { rows: releasedRes } = await client.query(
        `DELETE FROM stock_reservations
         WHERE session_id = $1 AND status = 'active' AND owner_admin_id = $2
         RETURNING product_id, variant_id, quantity`,
        [sessionId, adminId]
      );
      for (const r of releasedRes) {
        if (r.variant_id) {
          await client.query(
            `UPDATE product_variants
             SET stock_reserved = GREATEST(0, stock_reserved - $1)
             WHERE id = $2`,
            [r.quantity, r.variant_id]
          );
        } else {
          await client.query(
            `UPDATE products
             SET stock_reserved = GREATEST(0, stock_reserved - $1)
             WHERE id = $2`,
            [r.quantity, r.product_id]
          );
        }
      }
    }

    const saleRes = await client.query(
      `INSERT INTO sales (
         sale_number, subtotal, discount_amount, discount_id, total,
         payment_method, payment_status, sale_type,
         shipping_address, shipping_city, shipping_notes,
         customer_phone, owner_admin_id, created_by, customer_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending','web',$7,$8,$9,$10,$11,$11,$12)
       RETURNING id, sale_number, subtotal, discount_amount, total`,
      [saleNumber, subtotal, discountAmount, discountId, total, payment_method,
       shipping_address || null, shipping_city || null,
       shipping_notes || null, customer_phone || null, adminId,
       req.user.id]
    );

    const saleId = saleRes.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, variant_id, quantity, unit_price, unit_cost, subtotal, profit_per_unit, total_profit, discount_id, fulfillment_mode_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [saleId, item.product_id, item.variant_id ?? null, item.quantity, item.unit_price, item.unit_cost, item.subtotal, item.profit_unit, item.total_profit, discountId, item.fulfillment_mode]
      );
      // Only deduct physical stock for items that are fulfilled from inventory
      if (item.fulfillment_mode !== 'on_demand') {
        await inv.applyStockMovement(
          client,
          { productId: item.product_id, variantId: item.variant_id ?? null, quantity: item.quantity },
          -1, 'sale_confirmed',
          { ownerAdminId: adminId, userId: req.user?.id ?? 0,
            referenceType: 'sale', referenceId: saleId }
        );
      }
    }

    await client.query("COMMIT");
    client.release();
    clientReleased = true;

    const hasOnDemandItems = saleItems.some(i => i.fulfillment_mode === 'on_demand');

    // ── Auto-crear procurement orders (nueva tx, no bloquea la respuesta) ──────
    if (hasOnDemandItems) {
      const { rows: [prof] } = await db.query(
        `SELECT auto_create_procurement_orders FROM admin_profiles WHERE user_id = $1`,
        [adminId]
      );
      const autoCreate = prof?.auto_create_procurement_orders ?? true;

      if (autoCreate) {
        const procClient = await db.connect();
        try {
          await procClient.query('BEGIN');
          await procurement.createProcurementOrdersForSale(saleId, procClient, adminId);
          await procClient.query('COMMIT');
        } catch (procErr) {
          await procClient.query('ROLLBACK');
          console.error('[PUBLIC API] procurement auto-create error:', procErr.message);
          // Marcar la venta con procurement_status pending aunque falle la creación
          await db.query(
            `UPDATE sales SET procurement_status = 'pending', has_on_demand_items = true WHERE id = $1`,
            [saleId]
          ).catch(() => {});
        } finally {
          procClient.release();
        }
      }
    }

    // ── Push notification al admin (fire-and-forget) ───────────────────────────
    const pushPayload = hasOnDemandItems
      ? {
          title:    '🔔 Nueva venta — pedir al proveedor',
          body:     `${saleRes.rows[0].sale_number} · $${Number(saleRes.rows[0].total).toLocaleString('es-CO')}`,
          icon:     '/icon-192.png',
          badge:    '/badge-72.png',
          url:      '/procurement',
          tag:      'new-on-demand-sale',
          severity: 'warning',
        }
      : Payloads.newOnlineOrder(saleRes.rows[0].sale_number, saleRes.rows[0].total);
    notifyTenant(adminId, pushPayload).catch(() => {});

    // ── WhatsApp enqueue (fire-and-forget) ────────────────────────────────────
    const waEvent = hasOnDemandItems ? 'new_on_demand_sale' : 'new_sale';
    enqueueNotification({
      ownerAdminId:    adminId,
      recipientUserId: adminId,
      event:           waEvent,
      channel:         'whatsapp',
      payload: {
        sale_number:   saleRes.rows[0].sale_number,
        total:         `$${Number(saleRes.rows[0].total).toLocaleString('es-CO')}`,
        items_list:    saleItems.map(i => `• Producto #${i.product_id} × ${i.quantity}`).join('\n'),
        pending_count: String(saleItems.filter(i => i.fulfillment_mode === 'on_demand').length),
      },
      templateKey:   waEvent,
      referenceType: 'sale',
      referenceId:   saleId,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: "Venta registrada correctamente",
      data: {
        sale_id:         saleId,
        sale_number:     saleRes.rows[0].sale_number,
        subtotal:        saleRes.rows[0].subtotal,
        discount_amount: saleRes.rows[0].discount_amount,
        total:           saleRes.rows[0].total,
        has_on_demand_items: hasOnDemandItems,
      },
    });
  } catch (error) {
    if (!clientReleased) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
    console.error("[PUBLIC API] POST /sales", error);
    res.status(500).json({ success: false, message: "Error al registrar la venta" });
  }
}

function registerSalesRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function" ||
    typeof router.post !== "function"
  ) {
    throw new TypeError(
      "registerSalesRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/sales",
    requireApiPermission("sales:read"),
    getSales
  );

  router.post(
    "/sales",
    requireApiPermission("sales:write"),
    auth,
    createSale
  );
}

module.exports = Object.freeze({
  registerSalesRoutes,
  getSales,
  createSale,
});

