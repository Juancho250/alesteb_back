"use strict";

const db = require("../../platform/database");
const {
  applyStockMovement,
  resolveAlerts,
} = require("../../../services/inventory.service");

function _err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw _err(`${field} debe ser un entero positivo`, 'VALIDATION');
  return parsed;
}

function _sameId(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

const PROCUREMENT_RELATION_FIELDS = `
  p.id AS product_match_id, p.owner_admin_id AS product_owner_id,
  s.id AS sale_match_id, s.owner_admin_id AS sale_owner_id,
  si.id AS sale_item_match_id, si.sale_id AS sale_item_sale_id,
  si.product_id AS sale_item_product_id, si.variant_id AS sale_item_variant_id,
  pv.id AS variant_match_id, pv.product_id AS variant_product_id`;

const PROCUREMENT_RELATION_JOINS = `
  LEFT JOIN products p
    ON p.id = pro.product_id AND p.owner_admin_id = pro.owner_admin_id
  LEFT JOIN sales s
    ON s.id = pro.sale_id AND s.owner_admin_id = pro.owner_admin_id
  LEFT JOIN sale_items si
    ON si.id = pro.sale_item_id
   AND si.sale_id = pro.sale_id
   AND si.product_id = pro.product_id
  LEFT JOIN product_variants pv
    ON pv.id = pro.variant_id AND pv.product_id = pro.product_id`;

function _validateProcurementRelations(row, ownerAdminId) {
  if (!row.product_match_id || Number(row.product_owner_id) !== ownerAdminId)
    throw _err(`Producto inválido en procurement ${row.id}`, 'DATA_INTEGRITY');
  if (!row.sale_match_id || Number(row.sale_owner_id) !== ownerAdminId)
    throw _err(`Venta inválida en procurement ${row.id}`, 'DATA_INTEGRITY');
  if (
    !row.sale_item_match_id
    || !_sameId(row.sale_item_sale_id, row.sale_id)
    || !_sameId(row.sale_item_product_id, row.product_id)
  ) {
    throw _err(`Sale item inválido en procurement ${row.id}`, 'DATA_INTEGRITY');
  }
  if (
    row.variant_id != null
    && (
      !row.variant_match_id
      || !_sameId(row.variant_product_id, row.product_id)
      || !_sameId(row.sale_item_variant_id, row.variant_id)
    )
  ) {
    throw _err(`Variante inválida en procurement ${row.id}`, 'DATA_INTEGRITY');
  }
  if (row.variant_id == null && row.sale_item_variant_id != null)
    throw _err(`Variante inconsistente en procurement ${row.id}`, 'DATA_INTEGRITY');
}

async function _recalculateSaleProcurementStatus(client, saleId, ownerAdminId) {
  const { rows: [sale] } = await client.query(
    `SELECT has_on_demand_items FROM sales
     WHERE id = $1 AND owner_admin_id = $2`,
    [saleId, ownerAdminId]
  );
  if (!sale) throw _err('Venta no encontrada', 'DATA_INTEGRITY');

  const { rows: pos } = await client.query(
    `SELECT status FROM procurement_orders
     WHERE sale_id = $1 AND owner_admin_id = $2 AND status != 'cancelled'`,
    [saleId, ownerAdminId]
  );

  let status;
  if (!pos.length) {
    status = sale.has_on_demand_items ? 'pending' : 'not_required';
  } else if (pos.every(r => r.status === 'received')) {
    status = 'complete';
  } else if (pos.some(r => ['ordered_to_supplier', 'received'].includes(r.status))) {
    status = 'partial';
  } else {
    status = 'pending';
  }

  const updated = await client.query(
    `UPDATE sales SET procurement_status = $1, updated_at = NOW()
     WHERE id = $2 AND owner_admin_id = $3`,
    [status, saleId, ownerAdminId]
  );
  if (updated.rowCount !== 1)
    throw _err('No se pudo actualizar el estado de procurement', 'DATA_INTEGRITY');
  return status;
}

async function _loadProductProcurements(client, purchaseOrderId, productId, ownerAdminId) {
  const { rows } = await client.query(
    `SELECT pro.id, pro.status, pro.owner_admin_id, pro.purchase_order_id,
            pro.sale_id, pro.sale_item_id, pro.product_id, pro.variant_id,
            pro.quantity, pro.actual_unit_cost,
            ${PROCUREMENT_RELATION_FIELDS}
     FROM procurement_orders pro
     ${PROCUREMENT_RELATION_JOINS}
     WHERE pro.owner_admin_id = $1
       AND pro.purchase_order_id = $2
       AND pro.product_id = $3
     ORDER BY pro.id
     FOR UPDATE OF pro`,
    [ownerAdminId, purchaseOrderId, productId]
  );
  rows.forEach(row => _validateProcurementRelations(row, ownerAdminId));
  return rows;
}

async function _completeProcurement(
  client,
  { procurement, unitCost, purchaseOrder, userId, ownerAdminId }
) {
  const updated = await client.query(
    `UPDATE procurement_orders
     SET status = 'received', actual_unit_cost = $1,
         received_at = NOW(), updated_at = NOW()
     WHERE id = $2
       AND owner_admin_id = $3
       AND purchase_order_id = $4
       AND status = 'ordered_to_supplier'`,
    [unitCost, procurement.id, ownerAdminId, purchaseOrder.id]
  );
  if (updated.rowCount !== 1)
    throw _err('No se pudo completar la orden de procurement', 'DATA_INTEGRITY');

  const saleItemUpdated = await client.query(
    `UPDATE sale_items si
     SET actual_supplier_cost = $1,
         item_delivery_status = 'ready_to_deliver'
     FROM sales s
     WHERE si.id = $2
       AND si.sale_id = $3
       AND si.product_id = $4
       AND si.variant_id IS NOT DISTINCT FROM $5::int
       AND s.id = si.sale_id
       AND s.owner_admin_id = $6`,
    [
      unitCost, procurement.sale_item_id, procurement.sale_id,
      procurement.product_id, procurement.variant_id ?? null, ownerAdminId,
    ]
  );
  if (saleItemUpdated.rowCount !== 1)
    throw _err('No se pudo actualizar el sale item', 'DATA_INTEGRITY');

  await client.query(
    `INSERT INTO expenses
       (expense_type, description, amount, payment_method,
        provider_id, product_id, quantity, purchase_order_id,
        sale_id, sale_item_id, procurement_order_id, expense_date,
        created_by, owner_admin_id, created_at, updated_at)
     SELECT 'cogs_direct',$1,$2,'credit',$3,$4,$5,$6,$7,$8,$9,
            CURRENT_DATE,$10,$11,NOW(),NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM expenses
       WHERE owner_admin_id = $11 AND procurement_order_id = $9
     )`,
    [
      `COGS directo OC #${purchaseOrder.order_number}`,
      Number(procurement.quantity) * unitCost,
      purchaseOrder.provider_id, procurement.product_id, procurement.quantity,
      purchaseOrder.id, procurement.sale_id, procurement.sale_item_id,
      procurement.id, userId ?? null, ownerAdminId,
    ]
  );

  await client.query(
    `UPDATE stock_alerts
     SET resolved = true, resolved_at = NOW()
     WHERE owner_admin_id = $1
       AND procurement_order_id = $2
       AND resolved = false`,
    [ownerAdminId, procurement.id]
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates procurement_orders for every on_demand/hybrid sale_item.
 * Must be called within the caller's open transaction (client = pg client).
 */
async function createProcurementOrdersForSale(saleId, client, ownerAdminId) {
  const safeSaleId = _positiveInteger(saleId, 'saleId');
  const safeOwnerId = _positiveInteger(ownerAdminId, 'ownerAdminId');
  const { rows: [sale] } = await client.query(
    `SELECT id, owner_admin_id, created_by
     FROM sales
     WHERE id = $1 AND owner_admin_id = $2
     FOR UPDATE`,
    [safeSaleId, safeOwnerId]
  );
  if (!sale) throw _err(`Venta ${safeSaleId} no encontrada`, 'NOT_FOUND');

  const { rows: items } = await client.query(
    `SELECT si.id, si.product_id, si.variant_id, si.quantity,
            si.supplier_cost_at_sale, si.fulfillment_mode_snapshot,
            p.id AS product_match_id, p.owner_admin_id AS product_owner_id,
            p.default_supplier_id, p.supplier_lead_time_days,
            pv.id AS variant_match_id, pv.product_id AS variant_product_id,
            provider.id AS supplier_match_id,
            provider.owner_admin_id AS supplier_owner_id
     FROM sale_items si
     LEFT JOIN products p
       ON p.id = si.product_id AND p.owner_admin_id = $2
     LEFT JOIN product_variants pv
       ON pv.id = si.variant_id AND pv.product_id = si.product_id
     LEFT JOIN providers provider
       ON provider.id = p.default_supplier_id AND provider.owner_admin_id = $2
     WHERE si.sale_id = $1
       AND COALESCE(si.fulfillment_mode_snapshot, 'stock') != 'stock'`,
    [safeSaleId, safeOwnerId]
  );
  if (!items.length) return { created: 0 };

  const { rows: existing } = await client.query(
    `SELECT id, sale_item_id, product_id, variant_id, supplier_id, quantity, status
     FROM procurement_orders
     WHERE owner_admin_id = $1 AND sale_id = $2
     ORDER BY id
     FOR UPDATE`,
    [safeOwnerId, safeSaleId]
  );
  const activeBySaleItem = new Map();
  for (const row of existing.filter(order => order.status !== 'cancelled')) {
    if (activeBySaleItem.has(Number(row.sale_item_id)))
      throw _err(`El sale item ${row.sale_item_id} tiene múltiples órdenes activas`, 'DATA_INTEGRITY');
    activeBySaleItem.set(Number(row.sale_item_id), row);
  }

  let created = 0;
  let maxLeadDays = 0;

  for (const item of items) {
    if (!item.product_match_id || Number(item.product_owner_id) !== safeOwnerId)
      throw _err(`Producto ${item.product_id} no pertenece al tenant`, 'FORBIDDEN');
    if (item.variant_id != null && !item.variant_match_id)
      throw _err(`Variante ${item.variant_id} no pertenece al producto`, 'VALIDATION');
    if (item.default_supplier_id != null && !item.supplier_match_id)
      throw _err('El proveedor por defecto no pertenece al tenant', 'FORBIDDEN');

    const quantity = _positiveInteger(item.quantity, 'quantity');
    const leadDays = Math.max(0, Number(item.supplier_lead_time_days ?? 0));
    if (leadDays > maxLeadDays) maxLeadDays = leadDays;
    const current = activeBySaleItem.get(Number(item.id));
    if (current) {
      if (
        !_sameId(current.product_id, item.product_id)
        || !_sameId(current.variant_id, item.variant_id)
        || !_sameId(current.supplier_id, item.default_supplier_id)
        || Number(current.quantity) !== quantity
      ) {
        throw _err(
          `El procurement existente para sale item ${item.id} no coincide con la venta`,
          'DATA_INTEGRITY'
        );
      }
      continue;
    }

    const unitCost = Number(item.supplier_cost_at_sale ?? 0);
    if (!Number.isFinite(unitCost) || unitCost < 0)
      throw _err(`Costo inválido en sale item ${item.id}`, 'DATA_INTEGRITY');
    const expectedDelivery = new Date();
    expectedDelivery.setDate(expectedDelivery.getDate() + leadDays);

    const { rows: [procurement] } = await client.query(
      `INSERT INTO procurement_orders
         (owner_admin_id, sale_id, sale_item_id, product_id, variant_id,
          supplier_id, quantity, estimated_unit_cost, status,
          expected_delivery_date, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,NOW(),NOW())
       RETURNING id`,
      [
        safeOwnerId, safeSaleId, item.id, item.product_id,
        item.variant_id ?? null, item.default_supplier_id ?? null,
        quantity, unitCost, expectedDelivery, sale.created_by ?? null,
      ]
    );

    await client.query(
      `DELETE FROM stock_alerts
       WHERE owner_admin_id = $1
         AND product_id = $2
         AND COALESCE(variant_id, 0) = COALESCE($3::int, 0)
         AND alert_type = 'procurement_needed'`,
      [safeOwnerId, item.product_id, item.variant_id ?? null]
    );
    await client.query(
      `INSERT INTO stock_alerts
         (owner_admin_id, product_id, variant_id, sale_id,
          procurement_order_id, alert_type, threshold, current_value, created_at)
       VALUES ($1,$2,$3,$4,$5,'procurement_needed',$6,0,NOW())`,
      [
        safeOwnerId, item.product_id, item.variant_id ?? null,
        safeSaleId, procurement.id, quantity,
      ]
    );

    created += 1;
  }

  const estimatedDelivery = new Date();
  estimatedDelivery.setDate(estimatedDelivery.getDate() + maxLeadDays);
  const updated = await client.query(
    `UPDATE sales
     SET has_on_demand_items = true,
         procurement_status = 'pending',
         estimated_delivery_date = $1,
         updated_at = NOW()
     WHERE id = $2 AND owner_admin_id = $3`,
    [estimatedDelivery, safeSaleId, safeOwnerId]
  );
  if (updated.rowCount !== 1)
    throw _err('No se pudo actualizar la venta', 'DATA_INTEGRITY');

  return { created };
}

/**
 * Groups pending procurement_orders into a new purchase_order and sends to supplier.
 * purchase_order_items are aggregated by product; variant linkage stays in procurement_orders.
 */
async function groupAndCreatePurchaseOrder({ procurementOrderIds, supplierId, ownerAdminId, createdBy, notes }) {
  if (!Array.isArray(procurementOrderIds) || !procurementOrderIds.length)
    throw _err('procurementOrderIds es requerido', 'VALIDATION');
  const ids = procurementOrderIds.map(id => _positiveInteger(id, 'procurementOrderId'));
  if (new Set(ids).size !== ids.length)
    throw _err('procurementOrderIds no puede contener duplicados', 'VALIDATION');
  const safeSupplierId = _positiveInteger(supplierId, 'supplierId');
  const safeOwnerId = _positiveInteger(ownerAdminId, 'ownerAdminId');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows: [supplier] } = await client.query(
      `SELECT id FROM providers
       WHERE id = $1 AND owner_admin_id = $2
       FOR KEY SHARE`,
      [safeSupplierId, safeOwnerId]
    );
    if (!supplier) throw _err('Proveedor no encontrado', 'NOT_FOUND');

    const { rows: pos } = await client.query(
      `SELECT pro.id, pro.status, pro.supplier_id, pro.owner_admin_id,
              pro.purchase_order_id, pro.quantity, pro.estimated_unit_cost,
              pro.sale_id, pro.product_id, pro.variant_id, pro.sale_item_id,
              p.supplier_lead_time_days,
              ${PROCUREMENT_RELATION_FIELDS}
       FROM procurement_orders pro
       ${PROCUREMENT_RELATION_JOINS}
       WHERE pro.owner_admin_id = $1 AND pro.id = ANY($2::int[])
       ORDER BY pro.id
       FOR UPDATE OF pro`,
      [safeOwnerId, ids]
    );
    if (pos.length !== ids.length)
      throw _err('Una o más órdenes de procurement no encontradas', 'NOT_FOUND');

    for (const po of pos) {
      _validateProcurementRelations(po, safeOwnerId);
      if (!_sameId(po.supplier_id, safeSupplierId))
        throw _err(`Orden ${po.id} pertenece a otro proveedor`, 'SUPPLIER_MISMATCH');
    }

    const linkedIds = new Set(
      pos.map(po => po.purchase_order_id).filter(Boolean).map(Number)
    );
    if (
      linkedIds.size === 1
      && pos.every(po => ['ordered_to_supplier', 'received'].includes(po.status))
    ) {
      const { rows: [purchaseOrder] } = await client.query(
        `SELECT id, order_number FROM purchase_orders
         WHERE id = $1 AND owner_admin_id = $2 AND provider_id = $3`,
        [[...linkedIds][0], safeOwnerId, safeSupplierId]
      );
      if (!purchaseOrder)
        throw _err('La orden de compra enlazada es inválida', 'DATA_INTEGRITY');
      await client.query('COMMIT');
      return { purchaseOrder };
    }
    if (linkedIds.size || pos.some(po => po.status !== 'pending'))
      throw _err('Las órdenes deben estar pendientes y sin orden de compra', 'INVALID_STATE');

    const byProduct = new Map();
    let totalCost = 0;
    let maxLead = 0;
    for (const po of pos) {
      const quantity = _positiveInteger(po.quantity, 'quantity');
      const unitCost = Number(po.estimated_unit_cost ?? 0);
      if (!Number.isFinite(unitCost) || unitCost < 0)
        throw _err(`Costo inválido en procurement ${po.id}`, 'DATA_INTEGRITY');
      const row = byProduct.get(Number(po.product_id)) || {
        productId: Number(po.product_id), quantity: 0, subtotal: 0,
      };
      row.quantity += quantity;
      row.subtotal += quantity * unitCost;
      byProduct.set(row.productId, row);
      totalCost += quantity * unitCost;
      maxLead = Math.max(maxLead, Number(po.supplier_lead_time_days ?? 0));
    }

    const expectedDelivery = new Date();
    expectedDelivery.setDate(expectedDelivery.getDate() + Math.max(0, maxLead));
    const { rows: [purchaseOrder] } = await client.query(
      `WITH next_order AS (
         SELECT nextval(pg_get_serial_sequence('purchase_orders', 'id'))::int AS id
       )
       INSERT INTO purchase_orders
         (id, order_number, status, provider_id, owner_admin_id, subtotal,
          total_cost, payment_status, expected_delivery_date, order_date,
          notes, created_by, created_at, updated_at)
       SELECT id, 'OC-' || LPAD(id::text, 6, '0'), 'pending',
              $1,$2,$3,$3,'pending',$4,CURRENT_DATE,$5,$6,NOW(),NOW()
       FROM next_order
       RETURNING id, order_number`,
      [
        safeSupplierId, safeOwnerId, totalCost, expectedDelivery,
        notes ?? null, createdBy ?? null,
      ]
    );

    for (const row of [...byProduct.values()].sort((a, b) => a.productId - b.productId)) {
      await client.query(
        `INSERT INTO purchase_order_items
           (purchase_order_id, product_id, quantity, unit_cost, subtotal, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [
          purchaseOrder.id, row.productId, row.quantity,
          row.subtotal / row.quantity, row.subtotal,
        ]
      );
    }

    const linked = await client.query(
      `UPDATE procurement_orders
       SET status = 'ordered_to_supplier', purchase_order_id = $1,
           ordered_at = NOW(), updated_at = NOW()
       WHERE owner_admin_id = $2
         AND id = ANY($3::int[])
         AND status = 'pending'
         AND purchase_order_id IS NULL`,
      [purchaseOrder.id, safeOwnerId, ids]
    );
    if (linked.rowCount !== ids.length)
      throw _err('No se pudieron enlazar todas las órdenes', 'DATA_INTEGRITY');

    for (const saleId of new Set(pos.map(po => Number(po.sale_id))))
      await _recalculateSaleProcurementStatus(client, saleId, safeOwnerId);

    await client.query('COMMIT');
    return { purchaseOrder };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Receives a purchase order using purchase_order_id + product_id as the link
 * to one or more procurement_orders.
 */
async function receivePurchaseOrder(purchaseOrderId, items, userId, ownerAdminId) {
  const safePurchaseOrderId = _positiveInteger(purchaseOrderId, 'purchaseOrderId');
  const safeOwnerId = _positiveInteger(ownerAdminId, 'ownerAdminId');
  if (!Array.isArray(items) || !items.length)
    throw _err('items es requerido', 'VALIDATION');

  const seen = new Set();
  const receipts = items.map(item => {
    const poItemId = _positiveInteger(item?.poItemId, 'poItemId');
    const receivedQty = _positiveInteger(item?.receivedQty, 'receivedQty');
    const actualUnitCost = item?.actualUnitCost == null ? null : Number(item.actualUnitCost);
    if (seen.has(poItemId))
      throw _err(`El ítem ${poItemId} está repetido`, 'VALIDATION');
    if (actualUnitCost != null && (!Number.isFinite(actualUnitCost) || actualUnitCost < 0))
      throw _err('actualUnitCost debe ser mayor o igual a cero', 'VALIDATION');
    seen.add(poItemId);
    return { poItemId, receivedQty, actualUnitCost };
  });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [po] } = await client.query(
      `SELECT po.id, po.order_number, po.status, po.provider_id,
              po.owner_admin_id, po.payment_status, po.total_cost
       FROM purchase_orders po
       JOIN providers provider
         ON provider.id = po.provider_id
        AND provider.owner_admin_id = po.owner_admin_id
       WHERE po.id = $1 AND po.owner_admin_id = $2
       FOR UPDATE OF po`,
      [safePurchaseOrderId, safeOwnerId]
    );
    if (!po) throw _err('OC no encontrada', 'NOT_FOUND');
    if (po.status === 'received')  throw _err('OC ya recibida', 'ALREADY_DONE');
    if (po.status === 'cancelled') throw _err('OC cancelada', 'INVALID_STATE');
    if (po.status !== 'pending')
      throw _err(`OC en estado inválido: ${po.status}`, 'INVALID_STATE');

    const { rows: poItems } = await client.query(
      `SELECT poi.id, poi.product_id, poi.quantity, poi.received_quantity,
              poi.unit_cost, poi.subtotal, p.id AS product_match_id,
              p.owner_admin_id AS product_owner_id, p.has_variants
       FROM purchase_order_items poi
       JOIN purchase_orders parent
         ON parent.id = poi.purchase_order_id
        AND parent.owner_admin_id = $2
       LEFT JOIN products p
         ON p.id = poi.product_id
        AND p.owner_admin_id = parent.owner_admin_id
       WHERE poi.purchase_order_id = $1
       ORDER BY poi.id
       FOR UPDATE OF poi`,
      [safePurchaseOrderId, safeOwnerId]
    );
    if (!poItems.length) throw _err('OC sin ítems', 'NOT_FOUND');
    if (poItems.some(item => !item.product_match_id))
      throw _err('La OC contiene productos de otro tenant', 'DATA_INTEGRITY');

    const byId = new Map(poItems.map(item => [Number(item.id), item]));
    const updatedItems = [];
    const affectedProducts = new Set();
    let totalActual = 0;

    for (const receipt of receipts) {
      const poItem = byId.get(receipt.poItemId);
      if (!poItem)
        throw _err(`Ítem ${receipt.poItemId} no encontrado en esta OC`, 'NOT_FOUND');
      const ordered = Number(poItem.quantity);
      const received = Number(poItem.received_quantity ?? 0);
      if (
        !Number.isSafeInteger(ordered)
        || !Number.isSafeInteger(received)
        || received < 0
        || received > ordered
      ) {
        throw _err(`Cantidades inválidas en ítem ${poItem.id}`, 'DATA_INTEGRITY');
      }
      if (receipt.receivedQty > ordered - received)
        throw _err(`La recepción excede la cantidad pendiente del ítem ${poItem.id}`, 'OVER_RECEIPT');

      const previousCost = Number(poItem.unit_cost ?? 0);
      const incomingCost = receipt.actualUnitCost ?? previousCost;
      const nextReceived = received + receipt.receivedQty;
      const weightedCost = (
        (received * previousCost) + (receipt.receivedQty * incomingCost)
      ) / nextReceived;
      const { rows: [updated] } = await client.query(
        `UPDATE purchase_order_items poi
         SET received_quantity = COALESCE(poi.received_quantity, 0) + $1,
             unit_cost = $2,
             subtotal = poi.quantity * $2
         FROM purchase_orders parent
         WHERE poi.id = $3
           AND poi.purchase_order_id = $4
           AND parent.id = poi.purchase_order_id
           AND parent.owner_admin_id = $5
           AND COALESCE(poi.received_quantity, 0) + $1 <= poi.quantity
         RETURNING poi.received_quantity, poi.unit_cost, poi.subtotal`,
        [
          receipt.receivedQty, weightedCost, receipt.poItemId,
          safePurchaseOrderId, safeOwnerId,
        ]
      );
      if (!updated)
        throw _err('La cantidad cambió durante la recepción', 'CONFLICT');

      poItem.received_quantity = updated.received_quantity;
      poItem.unit_cost = updated.unit_cost;
      poItem.subtotal = updated.subtotal;
      updatedItems.push({ poItem, quantity: receipt.receivedQty });
      affectedProducts.add(Number(poItem.product_id));
      totalActual += receipt.receivedQty * incomingCost;
    }

    const affectedSaleIds      = new Set();
    const affectedStockProducts = new Set();

    for (const productId of affectedProducts) {
      const productItems = poItems.filter(item => Number(item.product_id) === productId);
      const procurements = await _loadProductProcurements(
        client, safePurchaseOrderId, productId, safeOwnerId
      );

      if (!procurements.length) {
        if (productItems.some(item => item.has_variants))
          throw _err(`La OC de stock del producto ${productId} no identifica una variante`, 'DATA_INTEGRITY');
        for (const row of updatedItems.filter(item => Number(item.poItem.product_id) === productId)) {
          await applyStockMovement(
            client,
            { productId, variantId: null, quantity: row.quantity },
            +1,
            'purchase_received',
            {
              ownerAdminId: safeOwnerId, userId,
              referenceType: 'purchase_order', referenceId: safePurchaseOrderId,
              notes: `OC #${po.order_number}`,
            }
          );
        }
        const totalQty = productItems.reduce((sum, item) => sum + Number(item.quantity), 0);
        const averageCost = productItems.reduce(
          (sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0
        ) / totalQty;
        const productUpdated = await client.query(
          `UPDATE products SET purchase_price = $1, updated_at = NOW()
           WHERE id = $2 AND owner_admin_id = $3`,
          [averageCost, productId, safeOwnerId]
        );
        if (productUpdated.rowCount !== 1)
          throw _err('Producto no encontrado durante recepción', 'DATA_INTEGRITY');
        affectedStockProducts.add(productId);
        continue;
      }

      const ordered = productItems.reduce((sum, item) => sum + Number(item.quantity), 0);
      const required = procurements.reduce((sum, row) => sum + Number(row.quantity), 0);
      if (ordered !== required)
        throw _err(`La cantidad del producto ${productId} no coincide con procurement`, 'DATA_INTEGRITY');
      if (procurements.some(row => !['ordered_to_supplier', 'received'].includes(row.status)))
        throw _err(`Procurement inválido para el producto ${productId}`, 'DATA_INTEGRITY');

      const received = productItems.reduce(
        (sum, item) => sum + Number(item.received_quantity ?? 0), 0
      );
      if (received < ordered) {
        if (procurements.some(row => row.status === 'received'))
          throw _err(`Procurement recibido antes de completar el producto ${productId}`, 'DATA_INTEGRITY');
        continue;
      }

      const averageCost = productItems.reduce(
        (sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0
      ) / ordered;
      for (const procurement of procurements) {
        if (procurement.status === 'received') continue;
        await _completeProcurement(client, {
          procurement, unitCost: averageCost, purchaseOrder: po,
          userId, ownerAdminId: safeOwnerId,
        });
        affectedSaleIds.add(Number(procurement.sale_id));
      }
    }

    if (affectedStockProducts.size)
      await resolveAlerts(client, [...affectedStockProducts], safeOwnerId);

    const receivedCompletely = poItems.every(
      item => Number(item.received_quantity ?? 0) === Number(item.quantity)
    );
    const status = receivedCompletely ? 'received' : 'pending';
    const totalCost = poItems.reduce((sum, item) => sum + Number(item.subtotal), 0);
    const poUpdated = await client.query(
      `UPDATE purchase_orders
       SET status = $1,
           received_date = CASE WHEN $1 = 'received' THEN CURRENT_DATE ELSE NULL END,
           subtotal = $2, total_cost = $2, updated_at = NOW()
       WHERE id = $3 AND owner_admin_id = $4`,
      [status, totalCost, safePurchaseOrderId, safeOwnerId]
    );
    if (poUpdated.rowCount !== 1)
      throw _err('No se pudo actualizar la OC', 'DATA_INTEGRITY');

    if (po.payment_status !== 'paid' && totalActual > 0) {
      const providerUpdated = await client.query(
        `UPDATE providers SET balance = balance + $1, updated_at = NOW()
         WHERE id = $2 AND owner_admin_id = $3`,
        [totalActual, po.provider_id, safeOwnerId]
      );
      if (providerUpdated.rowCount !== 1)
        throw _err('Proveedor no encontrado durante recepción', 'DATA_INTEGRITY');
    }

    for (const saleId of affectedSaleIds) {
      const procurementStatus = await _recalculateSaleProcurementStatus(
        client, saleId, safeOwnerId
      );
      if (procurementStatus === 'complete') {
        await client.query(
          `UPDATE sales
           SET delivery_status = 'ready_to_deliver', updated_at = NOW()
           WHERE id = $1
             AND owner_admin_id = $2
             AND delivery_status NOT IN ('delivered', 'cancelled')`,
          [saleId, safeOwnerId]
        );
      }
    }

    await client.query('COMMIT');
    return {
      ok: true,
      purchaseOrderId: safePurchaseOrderId,
      affectedSales: [...affectedSaleIds],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Marks a sale as fully delivered and recognizes revenue.
 * Requires procurement_status IN ('not_required', 'complete').
 */
async function markSaleAsDelivered(saleId, _userId, ownerAdminId) {
  const safeSaleId = _positiveInteger(saleId, 'saleId');
  const safeOwnerId = _positiveInteger(ownerAdminId, 'ownerAdminId');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [sale] } = await client.query(
      `SELECT id, owner_admin_id, procurement_status, delivery_status
       FROM sales
       WHERE id = $1 AND owner_admin_id = $2
       FOR UPDATE`,
      [safeSaleId, safeOwnerId]
    );
    if (!sale) throw _err('Venta no encontrada', 'NOT_FOUND');
    if (sale.delivery_status === 'delivered') throw _err('Venta ya entregada', 'ALREADY_DONE');
    if (sale.delivery_status === 'cancelled') throw _err('Venta cancelada', 'INVALID_STATE');
    if (!['not_required', 'complete'].includes(sale.procurement_status)) {
      throw _err(
        `No se puede entregar: procurement aún en estado "${sale.procurement_status}". Deben recibirse todos los ítems del proveedor.`,
        'PROCUREMENT_INCOMPLETE'
      );
    }

    const now = new Date();
    await client.query(
      `UPDATE sales
       SET delivery_status = 'delivered',
           delivered_at = $1,
           revenue_recognized_at = $1,
           updated_at = NOW()
       WHERE id = $2 AND owner_admin_id = $3`,
      [now, safeSaleId, safeOwnerId]
    );
    await client.query(
      `UPDATE sale_items si
       SET item_delivery_status = 'delivered', delivered_at = $1
       FROM sales s
       WHERE si.sale_id = $2
         AND s.id = si.sale_id
         AND s.owner_admin_id = $3`,
      [now, safeSaleId, safeOwnerId]
    );

    await client.query('COMMIT');
    return { ok: true, deliveredAt: now };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a pending procurement order.
 */
async function cancelProcurementOrder(id, reason, _userId, ownerAdminId) {
  const safeId = _positiveInteger(id, 'procurementOrderId');
  const safeOwnerId = _positiveInteger(ownerAdminId, 'ownerAdminId');
  if (!String(reason || '').trim())
    throw _err('El motivo de cancelación es requerido', 'VALIDATION');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [po] } = await client.query(
      `SELECT pro.id, pro.status, pro.owner_admin_id, pro.purchase_order_id,
              pro.sale_id, pro.sale_item_id, pro.product_id, pro.variant_id,
              ${PROCUREMENT_RELATION_FIELDS}
       FROM procurement_orders pro
       ${PROCUREMENT_RELATION_JOINS}
       WHERE pro.id = $1 AND pro.owner_admin_id = $2
       FOR UPDATE OF pro`,
      [safeId, safeOwnerId]
    );
    if (!po) throw _err('Orden de procurement no encontrada', 'NOT_FOUND');
    _validateProcurementRelations(po, safeOwnerId);
    if (po.status === 'received')
      throw _err('No se puede cancelar una orden recibida', 'INVALID_STATE');
    if (po.status !== 'pending' || po.purchase_order_id != null)
      throw _err(`Solo se pueden cancelar órdenes pendientes (actual: ${po.status})`, 'INVALID_STATE');

    const updated = await client.query(
      `UPDATE procurement_orders
       SET status = 'cancelled', cancellation_reason = $1,
           cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $2
         AND owner_admin_id = $3
         AND status = 'pending'
         AND purchase_order_id IS NULL`,
      [String(reason).trim(), safeId, safeOwnerId]
    );
    if (updated.rowCount !== 1)
      throw _err('La orden cambió durante la cancelación', 'CONFLICT');

    await client.query(
      `UPDATE stock_alerts
       SET resolved = true, resolved_at = NOW()
       WHERE owner_admin_id = $1
         AND procurement_order_id = $2
         AND resolved = false`,
      [safeOwnerId, safeId]
    );
    await _recalculateSaleProcurementStatus(client, Number(po.sale_id), safeOwnerId);

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createProcurementOrdersForSale,
  groupAndCreatePurchaseOrder,
  receivePurchaseOrder,
  markSaleAsDelivered,
  cancelProcurementOrder,
};
