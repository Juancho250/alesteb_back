// routes/inventory.routes.js
// All routes require JWT (auth) + adminScope. Superadmin bypasses tenant checks.
const express  = require('express');
const router   = express.Router();
const db       = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth.middleware');
const { requireFeature } = require("../middleware/subscription.middleware");
const { adminScope }         = require('../middleware/adminScope');
const inv      = require('../services/inventory.service');

router.use(auth, adminScope);
router.use(requireFeature("has_inventory"));

// ─── Util ─────────────────────────────────────────────────────────────────────
function send(res, err) {
  if (err?.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ success: false, message: err.message, code: err.code });
  if (err?.code === 'NOT_FOUND')          return res.status(404).json({ success: false, message: err.message });
  if (err?.code === 'FORBIDDEN')          return res.status(403).json({ success: false, message: err.message });
  if (err?.code === 'VALIDATION')         return res.status(400).json({ success: false, message: err.message });
  if (err?.code === 'ALREADY_DONE')       return res.status(409).json({ success: false, message: err.message });
  if (err?.code === 'INVALID_STATE')      return res.status(409).json({ success: false, message: err.message });
  console.error('[inventory]', err);
  return res.status(500).json({ success: false, message: err.message ?? 'Error de inventario' });
}

// ─── LECTURA ──────────────────────────────────────────────────────────────────

// GET /api/inventory/products  — vista completa con disponible
router.get('/products', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.adminId;
    const { rows } = await db.query(
      `SELECT * FROM v_stock_disponible
       WHERE owner_admin_id = $1
       ORDER BY name ASC`,
      [ownerId],
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/availability?productId=&variantId=
router.get('/availability', async (req, res) => {
  try {
    const productId = Number(req.query.productId);
    const variantId = req.query.variantId ? Number(req.query.variantId) : null;
    if (!productId) return res.status(400).json({ success: false, message: 'productId requerido' });

    const conditions = variantId
      ? ['product_id = $1', 'variant_id = $2']
      : ['product_id = $1', 'variant_id IS NULL'];
    const params = variantId ? [productId, variantId] : [productId];

    if (!req.isSuperAdmin) {
      conditions.push(`owner_admin_id = $${params.length + 1}`);
      params.push(req.adminId);
    }

    const { rows } = await db.query(
      `SELECT * FROM v_stock_disponible WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    );
    res.json({ success: true, data: rows[0] ?? null });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/ledger?productId=&limit=50
router.get('/ledger', requireAdmin, async (req, res) => {
  try {
    const ownerId   = req.adminId;
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const limit     = Math.min(Number(req.query.limit) || 50, 500);

    const params  = productId ? [ownerId, productId, limit] : [ownerId, limit];
    const filter  = productId ? 'AND product_id = $2' : '';
    const limitPh = productId ? '$3' : '$2';

    const { rows } = await db.query(
      `SELECT sl.*, p.name AS product_name, pv.sku AS variant_sku
       FROM stock_ledger sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN product_variants pv ON pv.id = sl.variant_id
       WHERE sl.owner_admin_id = $1 ${filter}
       ORDER BY sl.created_at DESC
       LIMIT ${limitPh}`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/valuation  — valorización total del inventario (v_inventory_valuation)
router.get('/valuation', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM v_inventory_valuation WHERE owner_admin_id = $1`,
      [req.adminId],
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// GET /api/inventory/alerts  — alertas no resueltas del tenant
router.get('/alerts', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sa.*, p.name AS product_name, pv.sku AS variant_sku
       FROM stock_alerts sa
       JOIN products p ON p.id = sa.product_id
       LEFT JOIN product_variants pv ON pv.id = sa.variant_id
       WHERE sa.owner_admin_id = $1 AND sa.resolved = false
       ORDER BY sa.created_at DESC`,
      [req.adminId],
    );
    res.json({ success: true, data: rows });
  } catch (err) { send(res, err); }
});

// PATCH /api/inventory/alerts/:id/resolve
router.patch('/alerts/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE stock_alerts SET resolved = true, resolved_at = NOW()
       WHERE id = $1 AND owner_admin_id = $2`,
      [req.params.id, req.adminId],
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Alerta no encontrada' });
    res.json({ success: true, message: 'Alerta resuelta' });
  } catch (err) { send(res, err); }
});

// ─── ENTRADAS ─────────────────────────────────────────────────────────────────

// POST /api/inventory/purchase-order/:id/receive
router.post('/purchase-order/:id/receive', requireAdmin, async (req, res) => {
  try {
    const result = await inv.receivePurchaseOrder(Number(req.params.id), {
      ownerAdminId: req.adminId,
      userId:       req.user.id,
    });
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/adjustment
// body: { productId, variantId?, delta, reason }
router.post('/adjustment', requireAdmin, async (req, res) => {
  try {
    const { productId, variantId, delta, reason } = req.body;
    if (!productId || delta == null) {
      return res.status(400).json({ success: false, message: 'productId y delta son requeridos' });
    }
    const parsedDelta = Number(delta);
    if (!Number.isFinite(parsedDelta) || !Number.isInteger(parsedDelta)) {
      return res.status(400).json({ success: false, message: 'delta debe ser un número entero válido', code: 'VALIDATION' });
    }
    const result = await inv.manualAdjustment(
      { productId: Number(productId), variantId: variantId ? Number(variantId) : null,
        delta: parsedDelta, reason },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/damage
// body: { productId, variantId?, quantity, reason }
router.post('/damage', requireAdmin, async (req, res) => {
  try {
    const { productId, variantId, quantity, reason } = req.body;
    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: 'productId y quantity son requeridos' });
    }
    const parsedQty = Number(quantity);
    if (!Number.isFinite(parsedQty) || !Number.isInteger(parsedQty) || parsedQty <= 0) {
      return res.status(400).json({ success: false, message: 'quantity debe ser un entero positivo válido', code: 'VALIDATION' });
    }
    const result = await inv.recordDamage(
      { productId: Number(productId), variantId: variantId ? Number(variantId) : null,
        qty: parsedQty, reason },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/return
// body: { saleId, items: [{ productId, variantId?, quantity }] }
router.post('/return', requireAdmin, async (req, res) => {
  try {
    const { saleId, items } = req.body;
    if (!saleId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'saleId e items son requeridos' });
    }
    const result = await inv.processReturn(Number(saleId), items, {
      ownerAdminId: req.adminId,
      userId:       req.user.id,
    });
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// POST /api/inventory/initial-stock
// body: { productId, variantId?, quantity, purchasePrice?, reason }
router.post('/initial-stock', requireAdmin, async (req, res) => {
  try {
    const { productId, variantId, quantity, purchasePrice, reason } = req.body;
    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: 'productId y quantity son requeridos' });
    }
    const result = await inv.registerInitialStock(
      { productId:     Number(productId),
        variantId:     variantId ? Number(variantId) : null,
        quantity:      Number(quantity),
        purchasePrice: purchasePrice != null ? Number(purchasePrice) : null,
        reason },
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

// ─── RESERVAS (admin) ─────────────────────────────────────────────────────────

// POST /api/inventory/sales/:id/confirm-from-reservations
// body: { reservationIds: number[] }
router.post('/sales/:id/confirm-from-reservations', async (req, res) => {
  try {
    const { reservationIds } = req.body;
    if (!Array.isArray(reservationIds) || !reservationIds.length) {
      return res.status(400).json({ success: false, message: 'reservationIds es requerido' });
    }
    const result = await inv.confirmSaleFromReservations(
      Number(req.params.id),
      reservationIds,
      { ownerAdminId: req.adminId, userId: req.user.id },
    );
    res.json({ success: true, data: result });
  } catch (err) { send(res, err); }
});

module.exports = router;
