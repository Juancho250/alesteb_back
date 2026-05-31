// services/inventory.service.js
// Central inventory engine.
// Formula: disponible = stock − stock_reserved − stock_safety
//
// All write operations are atomic (SELECT FOR UPDATE + ledger in one tx).
// applyStockMovement() accepts an existing pg client so callers can embed it
// in their own larger transactions (e.g. sale creation).
// The high-level exports (receivePO, directSale, etc.) manage their own tx.

const db = require('../config/db');

const RESERVATION_TTL_MIN = 15;

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Write one entry to stock_ledger. Must be called inside an open transaction.
 */
async function _writeLedger(client, {
  productId, variantId, movementType, qtyDelta,
  qtyBefore, qtyAfter, referenceType, referenceId, notes, userId, ownerAdminId,
}) {
  await client.query(
    `INSERT INTO stock_ledger
       (product_id, variant_id, movement_type, qty_delta,
        qty_before, qty_after, reference_type, reference_id,
        notes, created_by, owner_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [productId, variantId ?? null, movementType, qtyDelta,
     qtyBefore, qtyAfter, referenceType ?? null, referenceId ?? null,
     notes ?? null, userId ?? null, ownerAdminId],
  );
}

/**
 * Lock product/variant row, apply ±delta to stock, sync parent if variant,
 * write ledger. Must be called inside an open transaction.
 *
 * deltaSign: +1 (entrada) or -1 (salida)
 * Returns { qtyBefore, qtyAfter }
 */
async function _applyStockDelta(client, { productId, variantId, quantity }, deltaSign, movementType, ctx) {
  const delta = deltaSign * quantity;

  let qtyBefore;

  if (variantId) {
    const { rows } = await client.query(
      `SELECT pv.stock, p.owner_admin_id
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1
       FOR UPDATE OF pv`,
      [variantId],
    );
    if (!rows.length) throw _err(`Variante ${variantId} no encontrada`, 'NOT_FOUND');
    if (rows[0].owner_admin_id !== ctx.ownerAdminId) throw _err('Variante de otro tenant', 'FORBIDDEN');

    qtyBefore = rows[0].stock;
    const qtyAfter = qtyBefore + delta;
    if (qtyAfter < 0) throw _err(`Stock insuficiente: ${qtyBefore} disponible`, 'INSUFFICIENT_STOCK');

    await client.query(
      `UPDATE product_variants SET stock = $1, updated_at = NOW() WHERE id = $2`,
      [qtyAfter, variantId],
    );
    // Keep parent in sync (derived cache)
    await client.query(
      `UPDATE products
       SET stock = (SELECT COALESCE(SUM(stock),0) FROM product_variants
                   WHERE product_id = $1 AND is_active = true),
           updated_at = NOW()
       WHERE id = $1`,
      [productId],
    );
    await _writeLedger(client, {
      productId, variantId, movementType, qtyDelta: delta,
      qtyBefore, qtyAfter: qtyBefore + delta, ...ctx,
    });
    return { qtyBefore, qtyAfter: qtyBefore + delta };
  } else {
    const { rows } = await client.query(
      `SELECT stock, owner_admin_id FROM products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    if (!rows.length) throw _err(`Producto ${productId} no encontrado`, 'NOT_FOUND');
    if (rows[0].owner_admin_id !== ctx.ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');

    qtyBefore = rows[0].stock;
    const qtyAfter = qtyBefore + delta;
    if (qtyAfter < 0) throw _err(`Stock insuficiente: ${qtyBefore} disponible`, 'INSUFFICIENT_STOCK');

    await client.query(
      `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2`,
      [qtyAfter, productId],
    );
    await _writeLedger(client, {
      productId, variantId: null, movementType, qtyDelta: delta,
      qtyBefore, qtyAfter, ...ctx,
    });
    return { qtyBefore, qtyAfter };
  }
}

/**
 * Adjust stock_reserved ±delta. No physical stock change. No ledger entry.
 * Must be called inside an open transaction.
 */
async function _adjustReserved(client, { productId, variantId, quantity }, deltaSign, ownerAdminId) {
  const delta = deltaSign * quantity;

  if (variantId) {
    const { rows } = await client.query(
      `SELECT stock_reserved, stock FROM product_variants WHERE id = $1 FOR UPDATE`,
      [variantId],
    );
    if (!rows.length) throw _err(`Variante ${variantId} no encontrada`, 'NOT_FOUND');
    const newReserved = rows[0].stock_reserved + delta;
    if (newReserved < 0) throw _err('stock_reserved no puede ser negativo', 'INVARIANT');
    if (newReserved > rows[0].stock) throw _err('stock_reserved excede stock físico', 'INVARIANT');
    await client.query(
      `UPDATE product_variants SET stock_reserved = $1 WHERE id = $2`,
      [newReserved, variantId],
    );
  } else {
    const { rows } = await client.query(
      `SELECT stock_reserved, stock, owner_admin_id FROM products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    if (!rows.length) throw _err(`Producto ${productId} no encontrado`, 'NOT_FOUND');
    if (rows[0].owner_admin_id !== ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');
    const newReserved = rows[0].stock_reserved + delta;
    if (newReserved < 0) throw _err('stock_reserved no puede ser negativo', 'INVARIANT');
    if (newReserved > rows[0].stock) throw _err('stock_reserved excede stock físico', 'INVARIANT');
    await client.query(
      `UPDATE products SET stock_reserved = $1 WHERE id = $2`,
      [newReserved, productId],
    );
  }
}

/**
 * If product is a bundle, return its components (each multiplied by quantity).
 * Otherwise return the item as-is.
 * Must be called inside an open transaction.
 */
async function _expandBundle(client, { productId, variantId, quantity }) {
  const { rows } = await client.query(
    `SELECT is_bundle FROM products WHERE id = $1`,
    [productId],
  );
  if (!rows.length || !rows[0].is_bundle) return [{ productId, variantId, quantity }];

  const { rows: comps } = await client.query(
    `SELECT product_id, variant_id, quantity AS comp_qty
     FROM bundle_items WHERE bundle_id = $1`,
    [productId],
  );
  if (!comps.length) throw _err(`Bundle ${productId} sin componentes`, 'BUNDLE_EMPTY');

  return comps.map(c => ({
    productId: c.product_id,
    variantId: c.variant_id ?? null,
    quantity:  c.comp_qty * quantity,
  }));
}

function _err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ─── API PÚBLICA ─────────────────────────────────────────────────────────────

/**
 * LOW-LEVEL — used by callers that manage their own transaction.
 * Applies a stock movement (delta + ledger). Does NOT commit.
 * Expands bundles automatically.
 *
 * ctx = { ownerAdminId, userId, referenceType, referenceId, notes }
 */
async function applyStockMovement(client, { productId, variantId, quantity }, deltaSign, movementType, ctx) {
  const targets = await _expandBundle(client, { productId, variantId, quantity });
  for (const t of targets) {
    await _applyStockDelta(client, t, deltaSign, movementType, ctx);
  }
}

/**
 * Recibir orden de compra completa.
 * Suma stock según received_quantity (o quantity si no hay parcial).
 * Marca la PO como received.
 */
async function receivePurchaseOrder(purchaseOrderId, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [po] } = await client.query(
      `SELECT id, status, order_number, owner_admin_id
       FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [purchaseOrderId],
    );
    if (!po) throw _err('PO no encontrada', 'NOT_FOUND');
    if (po.owner_admin_id !== ctx.ownerAdminId) throw _err('PO de otro tenant', 'FORBIDDEN');
    if (po.status === 'received')  throw _err('PO ya recibida', 'ALREADY_DONE');
    if (po.status === 'cancelled') throw _err('PO cancelada', 'INVALID_STATE');

    const { rows: items } = await client.query(
      `SELECT product_id, quantity, received_quantity
       FROM purchase_order_items WHERE purchase_order_id = $1`,
      [purchaseOrderId],
    );

    for (const item of items) {
      const qty = (item.received_quantity != null ? item.received_quantity : item.quantity);
      if (qty <= 0) continue;
      await _applyStockDelta(
        client,
        { productId: item.product_id, variantId: null, quantity: qty },
        +1, 'purchase_received',
        { ...ctx, referenceType: 'purchase_order', referenceId: purchaseOrderId,
          notes: `PO ${po.order_number}` },
      );
    }

    await client.query(
      `UPDATE purchase_orders
       SET status = 'received', received_date = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [purchaseOrderId],
    );

    await client.query('COMMIT');
    return { ok: true, itemsProcessed: items.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Devolución de cliente → suma stock.
 * items: [{ productId, variantId?, quantity }]
 */
async function processReturn(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, +1, 'return', {
          ...ctx,
          referenceType: 'sale', referenceId: saleId,
          notes: `Devolución venta #${saleId}`,
        });
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ajuste manual (conteo físico). delta puede ser positivo o negativo.
 * reason es obligatorio.
 */
async function manualAdjustment({ productId, variantId, delta, reason }, ctx) {
  if (!delta || delta === 0) throw _err('delta no puede ser 0', 'VALIDATION');
  if (!reason?.trim()) throw _err('reason es obligatorio', 'VALIDATION');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const sign = delta > 0 ? +1 : -1;
    const result = await _applyStockDelta(
      client,
      { productId, variantId, quantity: Math.abs(delta) },
      sign, 'manual_adjustment',
      { ...ctx, referenceType: 'manual', notes: reason },
    );
    await client.query('COMMIT');
    return { ok: true, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Crear reserva temporal (checkout iniciado).
 * Valida disponible, sube stock_reserved, crea fila en stock_reservations.
 * Returns { ok, reservationIds, expiresAt }
 */
async function createReservation({ items, sessionId, userId, ownerAdminId, ttlMinutes }) {
  const ttl       = ttlMinutes ?? RESERVATION_TTL_MIN;
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reservationIds = [];

    for (const item of items) {
      const { productId, variantId, quantity } = item;

      // Check disponible
      const { rows: [row] } = variantId
        ? await client.query(
            `SELECT stock, stock_reserved, stock_safety
             FROM product_variants WHERE id = $1 FOR UPDATE`,
            [variantId])
        : await client.query(
            `SELECT stock, stock_reserved, stock_safety, owner_admin_id
             FROM products WHERE id = $1 FOR UPDATE`,
            [productId]);

      if (!row) throw _err('Producto/variante no existe', 'NOT_FOUND');
      if (!variantId && row.owner_admin_id !== ownerAdminId) throw _err('Producto de otro tenant', 'FORBIDDEN');

      const disponible = Math.max(0, row.stock - row.stock_reserved - row.stock_safety);
      if (disponible < quantity) {
        throw _err(`Stock disponible insuficiente (${disponible}) para reservar ${quantity}`, 'INSUFFICIENT_STOCK');
      }

      await _adjustReserved(client, { productId, variantId, quantity }, +1, ownerAdminId);

      // Snapshot del stock físico actual para el ledger
      const stockSnap = row.stock;
      await _writeLedger(client, {
        productId, variantId, movementType: 'reservation_created', qtyDelta: quantity,
        qtyBefore: stockSnap, qtyAfter: stockSnap,
        referenceType: 'reservation', referenceId: null,
        notes: `Reserva TTL ${ttl}min`, userId: userId ?? null, ownerAdminId,
      });

      const { rows: [res] } = await client.query(
        `INSERT INTO stock_reservations
           (owner_admin_id, session_id, user_id, product_id, variant_id, quantity, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [ownerAdminId, sessionId ?? null, userId ?? null, productId, variantId ?? null, quantity, expiresAt],
      );
      reservationIds.push(res.id);
    }

    await client.query('COMMIT');
    return { ok: true, reservationIds, expiresAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Confirmar venta a partir de reservas existentes (checkout completado).
 * Baja stock_reserved + stock_fisico. Marca reservas como confirmed.
 */
async function confirmSaleFromReservations(saleId, reservationIds, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: reservs } = await client.query(
      `SELECT id, owner_admin_id, product_id, variant_id, quantity, status, expires_at
       FROM stock_reservations
       WHERE id = ANY($1) FOR UPDATE`,
      [reservationIds],
    );
    if (reservs.length !== reservationIds.length) throw _err('Reservas no encontradas', 'NOT_FOUND');

    for (const r of reservs) {
      if (r.owner_admin_id !== ctx.ownerAdminId) throw _err('Reserva de otro tenant', 'FORBIDDEN');
      if (r.status !== 'active') throw _err(`Reserva ${r.id} no activa (${r.status})`, 'INVALID_STATE');
      if (r.expires_at < new Date()) throw _err(`Reserva ${r.id} expiró`, 'EXPIRED');

      const target = { productId: r.product_id, variantId: r.variant_id, quantity: r.quantity };

      await _adjustReserved(client, target, -1, ctx.ownerAdminId);
      await _applyStockDelta(client, target, -1, 'reservation_confirmed', {
        ...ctx,
        referenceType: 'sale', referenceId: saleId,
        notes: `Reserva #${r.id} → venta #${saleId}`,
      });

      await client.query(
        `UPDATE stock_reservations
         SET status = 'confirmed', sale_id = $1, confirmed_at = NOW()
         WHERE id = $2`,
        [saleId, r.id],
      );
    }

    await client.query('COMMIT');
    return { ok: true, count: reservs.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Venta directa (POS sin reserva previa).
 * Valida disponible, baja stock, ledger sale_confirmed.
 * Expande bundles.
 */
async function directSale(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, -1, 'sale_confirmed', {
          ...ctx,
          referenceType: 'sale', referenceId: saleId,
        });
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancelar venta ya confirmada → reingresa stock.
 */
async function cancelSale(saleId, items, ctx) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const targets = await _expandBundle(client, item);
      for (const t of targets) {
        await _applyStockDelta(client, t, +1, 'sale_cancelled', {
          ...ctx,
          referenceType: 'sale', referenceId: saleId,
          notes: `Reingreso por cancelación #${saleId}`,
        });
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Liberar una reserva (cliente cancela o TTL vencido).
 * reason: 'cancelled' | 'expired'
 */
async function releaseReservation(reservationId, ctx, reason = 'cancelled') {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [r] } = await client.query(
      `SELECT id, owner_admin_id, product_id, variant_id, quantity, status, stock
       FROM stock_reservations
       JOIN products ON products.id = stock_reservations.product_id
       WHERE stock_reservations.id = $1
       FOR UPDATE OF stock_reservations`,
      [reservationId],
    );
    if (!r) throw _err('Reserva no encontrada', 'NOT_FOUND');
    if (r.owner_admin_id !== ctx.ownerAdminId) throw _err('Reserva de otro tenant', 'FORBIDDEN');

    // Idempotente: si ya no está activa, no hacer nada
    if (r.status !== 'active') {
      await client.query('ROLLBACK');
      return { ok: true, skipped: true };
    }

    await _adjustReserved(client, { productId: r.product_id, variantId: r.variant_id, quantity: r.quantity }, -1, ctx.ownerAdminId);

    const stockSnap = r.stock;
    await _writeLedger(client, {
      productId: r.product_id, variantId: r.variant_id,
      movementType: 'reservation_released', qtyDelta: -r.quantity,
      qtyBefore: stockSnap, qtyAfter: stockSnap,
      referenceType: 'reservation', referenceId: reservationId,
      notes: `Reserva ${reason}`, userId: ctx.userId, ownerAdminId: ctx.ownerAdminId,
    });

    await client.query(
      `UPDATE stock_reservations
       SET status = $1, released_at = NOW()
       WHERE id = $2`,
      [reason === 'expired' ? 'expired' : 'cancelled', reservationId],
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Registrar merma o daño. Baja stock, reason obligatorio.
 */
async function recordDamage({ productId, variantId, quantity, reason }, ctx) {
  if (!reason?.trim()) throw _err('reason es obligatorio para merma', 'VALIDATION');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await _applyStockDelta(
      client,
      { productId, variantId, quantity },
      -1, 'damage_loss',
      { ...ctx, referenceType: 'damage', notes: reason },
    );
    await client.query('COMMIT');
    return { ok: true, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  applyStockMovement,    // low-level: embed in caller's tx
  receivePurchaseOrder,
  processReturn,
  manualAdjustment,
  createReservation,
  confirmSaleFromReservations,
  directSale,
  cancelSale,
  releaseReservation,
  recordDamage,
  RESERVATION_TTL_MIN,
};
