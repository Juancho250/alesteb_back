'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = require.resolve('../src/platform/database');
const inventoryPath = require.resolve('../src/modules/inventory/inventory.service');
const socketPath = require.resolve('../config/socket');

let state;
let snapshot;
let failPurchaseItem;
const calls = [];
const stockMovements = [];
const socketEvents = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function seed() {
  return {
    counters: { procurement: 30, purchaseOrder: 500, purchaseItem: 700, expense: 900 },
    providers: [
      { id: 5, owner_admin_id: 101, balance: 0 },
      { id: 205, owner_admin_id: 202, balance: 0 },
    ],
    products: [
      {
        id: 10, owner_admin_id: 101, has_variants: false,
        default_supplier_id: 5, supplier_lead_time_days: 4, purchase_price: 20,
      },
      {
        id: 20, owner_admin_id: 101, has_variants: true,
        default_supplier_id: 5, supplier_lead_time_days: 7, purchase_price: 30,
      },
      {
        id: 210, owner_admin_id: 202, has_variants: false,
        default_supplier_id: 205, supplier_lead_time_days: 3, purchase_price: 90,
      },
    ],
    variants: [
      { id: 201, product_id: 20 },
      { id: 202, product_id: 20 },
      { id: 999, product_id: 210 },
    ],
    sales: [
      {
        id: 1, owner_admin_id: 101, created_by: 11,
        has_on_demand_items: true, procurement_status: 'pending',
        delivery_status: 'pending',
      },
      {
        id: 2, owner_admin_id: 101, created_by: 11,
        has_on_demand_items: true, procurement_status: 'pending',
        delivery_status: 'pending',
      },
      {
        id: 201, owner_admin_id: 202, created_by: 22,
        has_on_demand_items: true, procurement_status: 'pending',
        delivery_status: 'pending',
      },
    ],
    saleItems: [],
    procurements: [],
    purchaseOrders: [],
    purchaseItems: [],
    expenses: [],
  };
}

function addSaleItem({
  id, saleId, productId, variantId = null, quantity = 1, unitCost = 20,
}) {
  state.saleItems.push({
    id, sale_id: saleId, product_id: productId, variant_id: variantId,
    quantity, supplier_cost_at_sale: unitCost,
    fulfillment_mode_snapshot: 'on_demand', item_delivery_status: 'pending',
  });
}

function addProcurement({
  id, ownerAdminId = 101, saleId, saleItemId, productId,
  variantId = null, supplierId = 5, quantity = 1, unitCost = 20,
  status = 'pending', purchaseOrderId = null,
}) {
  state.procurements.push({
    id, owner_admin_id: ownerAdminId, sale_id: saleId,
    sale_item_id: saleItemId, product_id: productId, variant_id: variantId,
    supplier_id: supplierId, purchase_order_id: purchaseOrderId,
    quantity, estimated_unit_cost: unitCost, actual_unit_cost: null, status,
  });
}

function relation(row) {
  const product = state.products.find(
    item => item.id === row.product_id && item.owner_admin_id === row.owner_admin_id
  );
  const sale = state.sales.find(
    item => item.id === row.sale_id && item.owner_admin_id === row.owner_admin_id
  );
  const saleItem = state.saleItems.find(
    item => item.id === row.sale_item_id
      && item.sale_id === row.sale_id
      && item.product_id === row.product_id
  );
  const variant = row.variant_id == null
    ? null
    : state.variants.find(
        item => item.id === row.variant_id && item.product_id === row.product_id
      );
  return {
    ...row,
    product_match_id: product?.id ?? null,
    product_owner_id: product?.owner_admin_id ?? null,
    supplier_lead_time_days: product?.supplier_lead_time_days ?? null,
    sale_match_id: sale?.id ?? null,
    sale_owner_id: sale?.owner_admin_id ?? null,
    sale_item_match_id: saleItem?.id ?? null,
    sale_item_sale_id: saleItem?.sale_id ?? null,
    sale_item_product_id: saleItem?.product_id ?? null,
    sale_item_variant_id: saleItem?.variant_id ?? null,
    variant_match_id: variant?.id ?? null,
    variant_product_id: variant?.product_id ?? null,
  };
}

async function query(rawSql, params = []) {
  const sql = String(rawSql).replace(/\s+/g, ' ').trim();
  calls.push({ sql, params: clone(params) });

  if (sql === 'BEGIN') {
    snapshot = clone(state);
    return result();
  }
  if (sql === 'COMMIT') {
    snapshot = null;
    return result();
  }
  if (sql === 'ROLLBACK') {
    if (snapshot) state = snapshot;
    snapshot = null;
    return result();
  }

  if (sql.includes('SELECT id, owner_admin_id, created_by FROM sales')) {
    const sale = state.sales.find(
      row => row.id === Number(params[0]) && row.owner_admin_id === Number(params[1])
    );
    return result(sale ? [{ ...sale }] : []);
  }

  if (sql.includes('FROM sale_items si') && sql.includes('fulfillment_mode_snapshot')) {
    const owner = Number(params[1]);
    const rows = state.saleItems
      .filter(row => row.sale_id === Number(params[0]))
      .map(row => {
        const product = state.products.find(
          item => item.id === row.product_id && item.owner_admin_id === owner
        );
        const variant = state.variants.find(
          item => item.id === row.variant_id && item.product_id === row.product_id
        );
        const provider = state.providers.find(
          item => item.id === product?.default_supplier_id && item.owner_admin_id === owner
        );
        return {
          ...row,
          product_match_id: product?.id ?? null,
          product_owner_id: product?.owner_admin_id ?? null,
          default_supplier_id: product?.default_supplier_id ?? null,
          supplier_lead_time_days: product?.supplier_lead_time_days ?? null,
          variant_match_id: variant?.id ?? null,
          variant_product_id: variant?.product_id ?? null,
          supplier_match_id: provider?.id ?? null,
          supplier_owner_id: provider?.owner_admin_id ?? null,
        };
      });
    return result(rows);
  }

  if (sql.includes('SELECT id, sale_item_id, product_id, variant_id')) {
    return result(state.procurements.filter(
      row => row.owner_admin_id === Number(params[0]) && row.sale_id === Number(params[1])
    ).map(row => ({ ...row })));
  }

  if (sql.includes('INSERT INTO procurement_orders')) {
    const row = {
      id: ++state.counters.procurement,
      owner_admin_id: Number(params[0]),
      sale_id: Number(params[1]),
      sale_item_id: Number(params[2]),
      product_id: Number(params[3]),
      variant_id: params[4] == null ? null : Number(params[4]),
      supplier_id: params[5] == null ? null : Number(params[5]),
      purchase_order_id: null,
      quantity: Number(params[6]),
      estimated_unit_cost: Number(params[7]),
      actual_unit_cost: null,
      status: 'pending',
    };
    state.procurements.push(row);
    return result([{ id: row.id }]);
  }

  if (sql.includes('DELETE FROM stock_alerts') || sql.includes('INSERT INTO stock_alerts'))
    return result([], 1);

  if (sql.includes('SET has_on_demand_items = true')) {
    const sale = state.sales.find(
      row => row.id === Number(params[1]) && row.owner_admin_id === Number(params[2])
    );
    if (!sale) return result([], 0);
    sale.has_on_demand_items = true;
    sale.procurement_status = 'pending';
    return result([], 1);
  }

  if (sql.includes('FROM providers') && sql.includes('FOR KEY SHARE')) {
    const provider = state.providers.find(
      row => row.id === Number(params[0]) && row.owner_admin_id === Number(params[1])
    );
    return result(provider ? [{ id: provider.id }] : []);
  }

  if (sql.includes('FROM procurement_orders pro') && sql.includes('pro.estimated_unit_cost')) {
    const ids = params[1].map(Number);
    return result(state.procurements
      .filter(row => row.owner_admin_id === Number(params[0]) && ids.includes(row.id))
      .sort((a, b) => a.id - b.id)
      .map(relation));
  }

  if (sql.includes('SELECT id, order_number FROM purchase_orders')) {
    const row = state.purchaseOrders.find(
      item => item.id === Number(params[0])
        && item.owner_admin_id === Number(params[1])
        && item.provider_id === Number(params[2])
    );
    return result(row ? [{ id: row.id, order_number: row.order_number }] : []);
  }

  if (sql.includes('WITH next_order AS') && sql.includes('INSERT INTO purchase_orders')) {
    const id = ++state.counters.purchaseOrder;
    const row = {
      id, order_number: `OC-${String(id).padStart(6, '0')}`, status: 'pending',
      provider_id: Number(params[0]), owner_admin_id: Number(params[1]),
      subtotal: Number(params[2]), total_cost: Number(params[2]),
      payment_status: 'pending',
    };
    state.purchaseOrders.push(row);
    return result([{ id, order_number: row.order_number }]);
  }

  if (sql.includes('INSERT INTO purchase_order_items')) {
    if (failPurchaseItem) {
      failPurchaseItem = false;
      throw new Error('forced purchase item failure');
    }
    state.purchaseItems.push({
      id: ++state.counters.purchaseItem,
      purchase_order_id: Number(params[0]),
      product_id: Number(params[1]),
      quantity: Number(params[2]),
      unit_cost: Number(params[3]),
      subtotal: Number(params[4]),
      received_quantity: 0,
    });
    return result([], 1);
  }

  if (sql.includes("SET status = 'ordered_to_supplier'")) {
    let count = 0;
    for (const row of state.procurements) {
      if (
        row.owner_admin_id === Number(params[1])
        && params[2].map(Number).includes(row.id)
        && row.status === 'pending'
        && row.purchase_order_id == null
      ) {
        row.status = 'ordered_to_supplier';
        row.purchase_order_id = Number(params[0]);
        count += 1;
      }
    }
    return result([], count);
  }

  if (sql.startsWith('SELECT status FROM procurement_orders')) {
    return result(state.procurements
      .filter(
        row => row.sale_id === Number(params[0])
          && row.owner_admin_id === Number(params[1])
          && row.status !== 'cancelled'
      )
      .map(row => ({ status: row.status })));
  }

  if (sql.startsWith('SELECT has_on_demand_items FROM sales')) {
    const sale = state.sales.find(
      row => row.id === Number(params[0]) && row.owner_admin_id === Number(params[1])
    );
    return result(sale ? [{ has_on_demand_items: sale.has_on_demand_items }] : []);
  }

  if (sql.startsWith('UPDATE sales SET procurement_status')) {
    const sale = state.sales.find(
      row => row.id === Number(params[1]) && row.owner_admin_id === Number(params[2])
    );
    if (!sale) return result([], 0);
    sale.procurement_status = params[0];
    return result([], 1);
  }

  if (sql.includes('FROM purchase_orders po') && sql.includes('JOIN providers provider')) {
    const row = state.purchaseOrders.find(
      item => item.id === Number(params[0])
        && item.owner_admin_id === Number(params[1])
        && state.providers.some(
          provider => provider.id === item.provider_id
            && provider.owner_admin_id === item.owner_admin_id
        )
    );
    return result(row ? [{ ...row }] : []);
  }

  if (
    sql.includes('FROM purchase_order_items poi')
    && sql.includes('p.has_variants')
  ) {
    const po = state.purchaseOrders.find(
      row => row.id === Number(params[0]) && row.owner_admin_id === Number(params[1])
    );
    if (!po) return result();
    return result(state.purchaseItems
      .filter(row => row.purchase_order_id === po.id)
      .map(row => {
        const product = state.products.find(
          item => item.id === row.product_id && item.owner_admin_id === po.owner_admin_id
        );
        return {
          ...row,
          product_match_id: product?.id ?? null,
          product_owner_id: product?.owner_admin_id ?? null,
          has_variants: product?.has_variants ?? null,
        };
      }));
  }

  if (sql.startsWith('UPDATE purchase_order_items poi')) {
    const row = state.purchaseItems.find(
      item => item.id === Number(params[2])
        && item.purchase_order_id === Number(params[3])
        && state.purchaseOrders.some(
          po => po.id === item.purchase_order_id && po.owner_admin_id === Number(params[4])
        )
    );
    if (!row || row.received_quantity + Number(params[0]) > row.quantity) return result();
    row.received_quantity += Number(params[0]);
    row.unit_cost = Number(params[1]);
    row.subtotal = row.quantity * row.unit_cost;
    return result([{
      received_quantity: row.received_quantity,
      unit_cost: row.unit_cost,
      subtotal: row.subtotal,
    }]);
  }

  if (sql.includes('FROM procurement_orders pro') && sql.includes('pro.actual_unit_cost')) {
    return result(state.procurements
      .filter(
        row => row.owner_admin_id === Number(params[0])
          && row.purchase_order_id === Number(params[1])
          && row.product_id === Number(params[2])
      )
      .map(relation));
  }

  if (sql.includes("SET status = 'received'") && sql.startsWith('UPDATE procurement_orders')) {
    const row = state.procurements.find(
      item => item.id === Number(params[1])
        && item.owner_admin_id === Number(params[2])
        && item.purchase_order_id === Number(params[3])
        && item.status === 'ordered_to_supplier'
    );
    if (!row) return result([], 0);
    row.status = 'received';
    row.actual_unit_cost = Number(params[0]);
    return result([], 1);
  }

  if (sql.startsWith('UPDATE sale_items si') && sql.includes('ready_to_deliver')) {
    const row = state.saleItems.find(
      item => item.id === Number(params[1])
        && item.sale_id === Number(params[2])
        && item.product_id === Number(params[3])
        && (item.variant_id ?? null) === (params[4] ?? null)
        && state.sales.some(
          sale => sale.id === item.sale_id && sale.owner_admin_id === Number(params[5])
        )
    );
    if (!row) return result([], 0);
    row.actual_supplier_cost = Number(params[0]);
    row.item_delivery_status = 'ready_to_deliver';
    return result([], 1);
  }

  if (sql.includes('INSERT INTO expenses')) {
    if (!state.expenses.some(
      row => row.owner_admin_id === Number(params[10])
        && row.procurement_order_id === Number(params[8])
    )) {
      state.expenses.push({
        id: ++state.counters.expense,
        amount: Number(params[1]),
        purchase_order_id: Number(params[5]),
        procurement_order_id: Number(params[8]),
        owner_admin_id: Number(params[10]),
      });
    }
    return result([], 1);
  }

  if (sql.startsWith('UPDATE stock_alerts')) return result([], 1);

  if (sql.startsWith('UPDATE products SET purchase_price')) {
    const row = state.products.find(
      item => item.id === Number(params[1]) && item.owner_admin_id === Number(params[2])
    );
    if (!row) return result([], 0);
    row.purchase_price = Number(params[0]);
    return result([], 1);
  }

  if (sql.startsWith('UPDATE purchase_orders')) {
    const row = state.purchaseOrders.find(
      item => item.id === Number(params[2]) && item.owner_admin_id === Number(params[3])
    );
    if (!row) return result([], 0);
    row.status = params[0];
    row.subtotal = Number(params[1]);
    row.total_cost = Number(params[1]);
    return result([], 1);
  }

  if (sql.startsWith('UPDATE providers SET balance')) {
    const row = state.providers.find(
      item => item.id === Number(params[1]) && item.owner_admin_id === Number(params[2])
    );
    if (!row) return result([], 0);
    row.balance += Number(params[0]);
    return result([], 1);
  }

  if (sql.includes("SET delivery_status = 'ready_to_deliver'")) {
    const row = state.sales.find(
      item => item.id === Number(params[0]) && item.owner_admin_id === Number(params[1])
    );
    if (row) row.delivery_status = 'ready_to_deliver';
    return result([], row ? 1 : 0);
  }

  if (
    sql.includes('FROM procurement_orders pro')
    && sql.includes('WHERE pro.id = $1')
  ) {
    const row = state.procurements.find(
      item => item.id === Number(params[0]) && item.owner_admin_id === Number(params[1])
    );
    return result(row ? [relation(row)] : []);
  }

  if (sql.includes("SET status = 'cancelled'")) {
    const row = state.procurements.find(
      item => item.id === Number(params[1])
        && item.owner_admin_id === Number(params[2])
        && item.status === 'pending'
        && item.purchase_order_id == null
    );
    if (!row) return result([], 0);
    row.status = 'cancelled';
    return result([], 1);
  }

  if (
    sql.includes('SELECT poi.id, poi.quantity, poi.received_quantity')
    && sql.includes('JOIN purchase_orders po')
  ) {
    const providerRoute = sql.includes('po.provider_id');
    const owner = providerRoute && params.length === 2 ? null : Number(params[1]);
    const providerId = providerRoute ? Number(params[params.length - 1]) : null;
    const po = state.purchaseOrders.find(
      row => row.id === Number(params[0])
        && (owner == null || row.owner_admin_id === owner)
        && (providerId == null || row.provider_id === providerId)
    );
    return result(po
      ? state.purchaseItems
          .filter(row => row.purchase_order_id === po.id)
          .map(row => ({
            ...row,
            provider_id: po.provider_id,
            owner_admin_id: po.owner_admin_id,
            status: po.status,
          }))
      : []);
  }

  throw new Error(`Unexpected query: ${sql.slice(0, 180)}`);
}

const fakeDb = {
  query,
  async connect() {
    return { query, release() {} };
  },
};

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakeDb,
};
require.cache[inventoryPath] = {
  id: inventoryPath,
  filename: inventoryPath,
  loaded: true,
  exports: {
    async applyStockMovement(_client, target, _sign, _type, ctx) {
      stockMovements.push({ target: clone(target), ctx: clone(ctx) });
    },
    async resolveAlerts() {},
  },
};
require.cache[socketPath] = {
  id: socketPath,
  filename: socketPath,
  loaded: true,
  exports: {
    emitDataUpdate(...args) {
      socketEvents.push(args);
    },
  },
};

const {
  service: procurement,
  controller: procurementController,
} = require('../src/modules/procurement');

const providersController = require('../src/modules/providers').controller;

test.beforeEach(() => {
  state = seed();
  snapshot = null;
  failPurchaseItem = false;
  calls.length = 0;
  stockMovements.length = 0;
  socketEvents.length = 0;
});

test('creation is tenant-aware, validates variants and is idempotent', async () => {
  addSaleItem({ id: 11, saleId: 1, productId: 10, quantity: 2 });
  addSaleItem({
    id: 12, saleId: 1, productId: 20, variantId: 201, quantity: 3,
  });

  assert.deepEqual(
    await procurement.createProcurementOrdersForSale(1, fakeDb, 101),
    { created: 2 }
  );
  assert.deepEqual(
    await procurement.createProcurementOrdersForSale(1, fakeDb, 101),
    { created: 0 }
  );
  assert.equal(state.procurements.length, 2);
  assert.deepEqual(state.procurements.map(row => row.variant_id), [null, 201]);

  await assert.rejects(
    () => procurement.createProcurementOrdersForSale(201, fakeDb, 101),
    error => error.code === 'NOT_FOUND'
  );

  state.saleItems = [];
  addSaleItem({ id: 13, saleId: 1, productId: 20, variantId: 999 });
  await assert.rejects(
    () => procurement.createProcurementOrdersForSale(1, fakeDb, 101),
    error => error.code === 'VALIDATION'
  );
});

function seedGroupedProcurements() {
  addSaleItem({
    id: 21, saleId: 1, productId: 20, variantId: 201, quantity: 2, unitCost: 20,
  });
  addSaleItem({
    id: 22, saleId: 2, productId: 20, variantId: 202, quantity: 3, unitCost: 30,
  });
  addProcurement({
    id: 31, saleId: 1, saleItemId: 21, productId: 20,
    variantId: 201, quantity: 2, unitCost: 20,
  });
  addProcurement({
    id: 32, saleId: 2, saleItemId: 22, productId: 20,
    variantId: 202, quantity: 3, unitCost: 30,
  });
}

test('grouping aggregates by product and retry does not duplicate items', async () => {
  seedGroupedProcurements();
  const input = {
    procurementOrderIds: [31, 32],
    supplierId: 5,
    ownerAdminId: 101,
    createdBy: 11,
  };
  const first = await procurement.groupAndCreatePurchaseOrder(input);
  const retry = await procurement.groupAndCreatePurchaseOrder(input);

  assert.equal(first.purchaseOrder.id, retry.purchaseOrder.id);
  assert.equal(state.purchaseOrders.length, 1);
  assert.equal(state.purchaseItems.length, 1);
  assert.deepEqual(state.purchaseItems[0], {
    id: 701,
    purchase_order_id: first.purchaseOrder.id,
    product_id: 20,
    quantity: 5,
    unit_cost: 26,
    subtotal: 130,
    received_quantity: 0,
  });
  assert.deepEqual(state.procurements.map(row => row.variant_id), [201, 202]);
});

test('grouping rejects another tenant and rolls back atomically', async () => {
  addSaleItem({ id: 221, saleId: 201, productId: 210 });
  addProcurement({
    id: 31, ownerAdminId: 202, saleId: 201, saleItemId: 221,
    productId: 210, supplierId: 205,
  });
  await assert.rejects(
    () => procurement.groupAndCreatePurchaseOrder({
      procurementOrderIds: [31], supplierId: 5, ownerAdminId: 101, createdBy: 11,
    }),
    error => error.code === 'NOT_FOUND'
  );

  state = seed();
  addSaleItem({ id: 21, saleId: 1, productId: 10, quantity: 2 });
  addProcurement({
    id: 31, saleId: 1, saleItemId: 21, productId: 10, quantity: 2,
  });
  failPurchaseItem = true;
  await assert.rejects(
    () => procurement.groupAndCreatePurchaseOrder({
      procurementOrderIds: [31], supplierId: 5, ownerAdminId: 101, createdBy: 11,
    }),
    /forced purchase item failure/
  );
  assert.equal(state.purchaseOrders.length, 0);
  assert.equal(state.procurements[0].status, 'pending');
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('partial and complete receipt preserve variant links and accounting', async () => {
  seedGroupedProcurements();
  const { purchaseOrder } = await procurement.groupAndCreatePurchaseOrder({
    procurementOrderIds: [31, 32], supplierId: 5, ownerAdminId: 101, createdBy: 11,
  });
  const poItemId = state.purchaseItems[0].id;

  const partial = await procurement.receivePurchaseOrder(
    purchaseOrder.id,
    [{ poItemId, receivedQty: 2, actualUnitCost: 27 }],
    11,
    101
  );
  assert.deepEqual(partial, {
    ok: true, purchaseOrderId: purchaseOrder.id, affectedSales: [],
  });
  assert.equal(state.purchaseOrders[0].status, 'pending');
  assert.ok(state.procurements.every(row => row.status === 'ordered_to_supplier'));
  assert.equal(state.expenses.length, 0);

  const complete = await procurement.receivePurchaseOrder(
    purchaseOrder.id,
    [{ poItemId, receivedQty: 3, actualUnitCost: 30 }],
    11,
    101
  );
  assert.deepEqual(complete, {
    ok: true, purchaseOrderId: purchaseOrder.id, affectedSales: [1, 2],
  });
  assert.equal(state.purchaseOrders[0].status, 'received');
  assert.ok(state.procurements.every(row => row.status === 'received'));
  assert.ok(state.saleItems.every(row => row.item_delivery_status === 'ready_to_deliver'));
  assert.equal(state.expenses.reduce((sum, row) => sum + row.amount, 0), 144);
  assert.equal(state.providers[0].balance, 144);
  assert.equal(stockMovements.length, 0);
});

test('stock receipt supports non-variants and rejects ambiguous variants', async () => {
  state.purchaseOrders.push({
    id: 501, order_number: 'OC-000501', status: 'pending',
    provider_id: 5, owner_admin_id: 101, payment_status: 'pending',
  });
  state.purchaseItems.push({
    id: 701, purchase_order_id: 501, product_id: 10,
    quantity: 2, unit_cost: 20, subtotal: 40, received_quantity: 0,
  });
  await procurement.receivePurchaseOrder(
    501, [{ poItemId: 701, receivedQty: 2 }], 11, 101
  );
  assert.equal(stockMovements.length, 1);
  assert.equal(stockMovements[0].target.variantId, null);

  state = seed();
  state.purchaseOrders.push({
    id: 501, order_number: 'OC-000501', status: 'pending',
    provider_id: 5, owner_admin_id: 101, payment_status: 'pending',
  });
  state.purchaseItems.push({
    id: 701, purchase_order_id: 501, product_id: 20,
    quantity: 1, unit_cost: 30, subtotal: 30, received_quantity: 0,
  });
  await assert.rejects(
    () => procurement.receivePurchaseOrder(
      501, [{ poItemId: 701, receivedQty: 1 }], 11, 101
    ),
    error => error.code === 'DATA_INTEGRITY'
  );
  assert.equal(state.purchaseItems[0].received_quantity, 0);
});

test('over-receipt, cancelled orders and cross-tenant receipt are rejected', async () => {
  state.purchaseOrders.push(
    {
      id: 501, order_number: 'OC-000501', status: 'pending',
      provider_id: 5, owner_admin_id: 101, payment_status: 'pending',
    },
    {
      id: 502, order_number: 'OC-000502', status: 'cancelled',
      provider_id: 5, owner_admin_id: 101, payment_status: 'pending',
    },
    {
      id: 503, order_number: 'OC-000503', status: 'pending',
      provider_id: 205, owner_admin_id: 202, payment_status: 'pending',
    }
  );
  state.purchaseItems.push({
    id: 701, purchase_order_id: 501, product_id: 10,
    quantity: 2, unit_cost: 20, subtotal: 40, received_quantity: 0,
  });

  await assert.rejects(
    () => procurement.receivePurchaseOrder(
      501, [{ poItemId: 701, receivedQty: 3 }], 11, 101
    ),
    error => error.code === 'OVER_RECEIPT'
  );
  await assert.rejects(
    () => procurement.receivePurchaseOrder(
      502, [{ poItemId: 701, receivedQty: 1 }], 11, 101
    ),
    error => error.code === 'INVALID_STATE'
  );
  await assert.rejects(
    () => procurement.receivePurchaseOrder(
      503, [{ poItemId: 701, receivedQty: 1 }], 11, 101
    ),
    error => error.code === 'NOT_FOUND'
  );
  assert.equal(state.purchaseItems[0].received_quantity, 0);
});

test('cancellation is tenant-aware and cannot cancel a received order', async () => {
  addSaleItem({ id: 21, saleId: 1, productId: 10 });
  addProcurement({ id: 31, saleId: 1, saleItemId: 21, productId: 10 });

  assert.deepEqual(
    await procurement.cancelProcurementOrder(31, 'Cliente canceló', 11, 101),
    { ok: true }
  );
  assert.equal(state.procurements[0].status, 'cancelled');
  assert.equal(state.sales[0].procurement_status, 'pending');

  state.procurements[0].status = 'received';
  await assert.rejects(
    () => procurement.cancelProcurementOrder(31, 'No aplica', 11, 101),
    error => error.code === 'INVALID_STATE'
  );
  await assert.rejects(
    () => procurement.cancelProcurementOrder(31, 'No aplica', 22, 202),
    error => error.code === 'NOT_FOUND'
  );
});

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function withServiceMethod(name, replacement, fn) {
  const original = procurement[name];
  procurement[name] = replacement;
  try {
    await fn();
  } finally {
    procurement[name] = original;
  }
}

test('procurement HTTP success contracts keep status and envelope', async () => {
  await withServiceMethod(
    'groupAndCreatePurchaseOrder',
    async () => ({ purchaseOrder: { id: 501, order_number: 'OC-000501' } }),
    async () => {
      const res = response();
      await procurementController.groupPurchaseOrder({
        body: { procurementOrderIds: [31], supplierId: 5 },
        adminId: 101,
        user: { id: 11 },
      }, res);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.body, {
        success: true,
        message: 'Orden de compra OC-000501 creada',
        data: { id: 501, order_number: 'OC-000501' },
      });
    }
  );

  state.purchaseOrders.push({
    id: 501, status: 'pending', provider_id: 5,
    owner_admin_id: 101, payment_status: 'pending',
  });
  state.purchaseItems.push({
    id: 701, purchase_order_id: 501, product_id: 10,
    quantity: 2, received_quantity: 0, unit_cost: 20, subtotal: 40,
  });
  for (const requestedQty of [1, 2]) {
    await withServiceMethod(
      'receivePurchaseOrder',
      async () => ({ ok: true, purchaseOrderId: 501, affectedSales: [] }),
      async () => {
        const res = response();
        await procurementController.receivePurchaseOrder({
          params: { id: '501' },
          body: { received_quantities: { 701: requestedQty } },
          adminId: 101,
          user: { id: 11 },
        }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body), ['success', 'message', 'data']);
        assert.equal(res.body.success, true);
        assert.equal(res.body.message, 'Orden de compra recibida correctamente');
        assert.deepEqual(res.body.data, {
          ok: true, purchaseOrderId: 501, affectedSales: [],
        });
      }
    );
  }

  await withServiceMethod('cancelProcurementOrder', async () => ({ ok: true }), async () => {
    const res = response();
    await procurementController.cancel({
      params: { id: '31' },
      body: { reason: 'Cliente canceló' },
      adminId: 101,
      user: { id: 11 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      success: true,
      message: 'Orden de procurement cancelada',
    });
  });
});

test('HTTP tenant errors are sanitized and provider receipt keeps its contract', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withServiceMethod('groupAndCreatePurchaseOrder', async () => {
      const error = new Error('Orden no disponible para este tenant');
      error.code = 'FORBIDDEN';
      throw error;
    }, async () => {
      const res = response();
      await procurementController.groupPurchaseOrder({
        body: { procurementOrderIds: [31], supplierId: 5 },
        adminId: 101,
        user: { id: 11 },
      }, res);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, {
        success: false,
        message: 'Orden no disponible para este tenant',
      });
      assert.doesNotMatch(JSON.stringify(res.body), /SELECT|owner_admin_id|password/i);
    });

    state.purchaseOrders.push({
      id: 501, order_number: 'OC-000501', status: 'pending',
      provider_id: 5, owner_admin_id: 101, payment_status: 'pending',
    });
    state.purchaseItems.push({
      id: 701, purchase_order_id: 501, product_id: 10,
      quantity: 2, received_quantity: 0, unit_cost: 20, subtotal: 40,
    });
    let receivedOwnerAdminId;
    await withServiceMethod(
      'receivePurchaseOrder',
      async (_orderId, _items, _userId, ownerAdminId) => {
        receivedOwnerAdminId = ownerAdminId;
        return { ok: true, purchaseOrderId: 501, affectedSales: [] };
      },
      async () => {
        const res = response();
        await providersController.receivePurchaseOrder({
          params: { id: '5', orderId: '501' },
          body: { received_quantities: { 701: 1 } },
          adminId: 101,
          user: { id: 11 },
        }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body), ['success', 'message', 'data']);
        assert.equal(res.body.message, 'Orden recibida exitosamente');
        assert.equal(socketEvents[0][2].status, 'pending');
        assert.equal(receivedOwnerAdminId, 101);

        const superadminRes = response();
        await providersController.receivePurchaseOrder({
          params: { id: '5', orderId: '501' },
          body: { received_quantities: { 701: 2 } },
          isSuperAdmin: true,
          adminId: 999,
          user: { id: 999 },
        }, superadminRes);
        assert.equal(superadminRes.statusCode, 200);
        assert.equal(receivedOwnerAdminId, 101);
        assert.equal(socketEvents[1][3], 101);
      }
    );
  } finally {
    console.error = originalError;
  }
});

test('source contract uses only real columns and trusted tenant callers', () => {
  const root = path.join(__dirname, '..');

  const service = fs.readFileSync(
    path.join(
      root,
      'src',
      'modules',
      'procurement',
      'procurement.service.js'
    ),
    'utf8'
  );

  const compact = service.replace(/\s+/g, ' ');

  const sales = fs.readFileSync(
    path.join(root, 'src', 'modules', 'sales', 'sales.controller.js'),
    'utf8'
  );

  const publicApi = fs.readFileSync(
    path.join(
      root,
      'src',
      'modules',
      'storefront',
      'storefront.routes.js'
    ),
    'utf8'
  );

  const procurementRoutes = fs.readFileSync(
    path.join(
      root,
      'src',
      'modules',
      'procurement',
      'procurement.routes.js'
    ),
    'utf8'
  );

  const providerRoutes = fs.readFileSync(
    path.join(root, 'src', 'modules', 'providers', 'providers.routes.js'),
    'utf8'
  );

  assert.doesNotMatch(
    service,
    /\bpoi\.(variant_id|procurement_order_id|updated_at)\b/i
  );

  assert.doesNotMatch(
    compact,
    /(?:INSERT|UPDATE)[^;`]*purchase_order_items[^;`]*\b(?:variant_id|procurement_order_id|updated_at)\b/i
  );

  assert.doesNotMatch(
    compact,
    /UPDATE sale_items[^;`]*\bupdated_at\b/i
  );

  assert.match(
    service,
    /pro\.owner_admin_id = \$1[\s\S]*pro\.purchase_order_id = \$2[\s\S]*pro\.product_id = \$3/
  );

  assert.match(
    sales,
    /createProcurementOrdersForSale\(saleId, client, ownerAdminId\)/
  );

  assert.match(
    publicApi,
    /createProcurementOrdersForSale\(saleId, procClient, adminId\)/
  );

  assert.match(
    procurementRoutes,
    /router\.post\(\s*["']\/purchase-orders\/:id\/receive["']\s*,\s*requireManager\s*,\s*ctrl\.receivePurchaseOrder\s*\)/
  );

  assert.match(
    providerRoutes,
    /router\.patch\s*\(\"\/:id\/purchase-orders\/:orderId\/receive\",\s+requireManager,\s+ctrl\.receivePurchaseOrder\)/
  );
});
