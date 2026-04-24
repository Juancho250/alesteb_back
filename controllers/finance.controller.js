const db = require("../config/db");

const fmtNum = (v) => parseFloat(v) || 0;

// ============================================
// 📊 RESUMEN FINANCIERO
// ============================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const hasDateFilter = start_date && end_date;
  const dateParams = hasDateFilter ? [start_date, end_date] : [];

  const salesDateFilter = hasDateFilter ? "AND s.sale_date BETWEEN $1 AND $2" : "";
  const invoicesDateFilter = hasDateFilter ? "WHERE invoice_date BETWEEN $1 AND $2" : "";
  const expensesDateFilter = hasDateFilter ? "WHERE expense_date BETWEEN $1 AND $2" : "";

  try {
    const [salesResult, invoicesResult, pendingResult, inventoryResult, expensesResult, providerDebtResult] =
      await Promise.all([
        db.query(
          `SELECT
             COALESCE(SUM(s.total), 0) AS total_sales,
             COALESCE(SUM(si.unit_cost * si.quantity), 0) AS total_cogs,
             COUNT(DISTINCT s.id) AS sales_count
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           WHERE s.payment_status = 'paid' ${salesDateFilter}`,
          dateParams
        ),
        db.query(
          `SELECT
             COALESCE(SUM(CASE WHEN invoice_type = 'service' THEN total_amount - pending_amount ELSE 0 END), 0) AS services_paid,
             COALESCE(SUM(CASE WHEN invoice_type = 'purchase' THEN total_amount - pending_amount ELSE 0 END), 0) AS purchases_paid,
             COUNT(*) AS invoices_count
           FROM invoices
           ${invoicesDateFilter}`,
          dateParams
        ),
        db.query(
          `SELECT COALESCE(SUM(pending_amount), 0) AS total_pending FROM invoices WHERE payment_status != 'paid'`
        ),
        db.query(
          `SELECT
             COALESCE(SUM(stock * COALESCE(purchase_price, 0)), 0) AS inventory_value,
             COUNT(*) AS products_count
           FROM products WHERE is_active = true`
        ),
        db.query(
          `SELECT COALESCE(SUM(amount), 0) AS total_expenses FROM expenses ${expensesDateFilter}`,
          dateParams
        ),
        db.query(
          `SELECT COALESCE(SUM(balance), 0) AS provider_total, COUNT(*) FILTER (WHERE balance > 0) AS providers_with_debt
           FROM providers WHERE is_active = true`
        ),
      ]);

    const sales = salesResult.rows[0];
    const invoices = invoicesResult.rows[0];
    const pending = pendingResult.rows[0];
    const inventory = inventoryResult.rows[0];
    const expensesRow = expensesResult.rows[0];
    const providerDebt = providerDebtResult.rows[0];

    const totalSales = fmtNum(sales.total_sales);
    const cogs = fmtNum(sales.total_cogs);
    const grossProfit = totalSales - cogs;
    const operatingExpenses = fmtNum(invoices.services_paid) + fmtNum(expensesRow.total_expenses);
    const netProfit = grossProfit - operatingExpenses;

    res.json({
      revenue: {
        total: totalSales,
        sales_count: parseInt(sales.sales_count || 0),
        cogs,
      },
      profitability: {
        gross_profit: grossProfit,
        gross_margin_pct: totalSales > 0 ? +((grossProfit / totalSales) * 100).toFixed(2) : 0,
        net_profit: netProfit,
        net_margin_pct: totalSales > 0 ? +((netProfit / totalSales) * 100).toFixed(2) : 0,
      },
      expenses: {
        operating: operatingExpenses,
        services: fmtNum(invoices.services_paid),
        purchases: fmtNum(invoices.purchases_paid),
        direct: fmtNum(expensesRow.total_expenses),
      },
      debt: {
        pending_invoices: fmtNum(pending.total_pending),
        provider_total: fmtNum(providerDebt.provider_total),
        providers_with_debt: parseInt(providerDebt.providers_with_debt || 0),
      },
      assets: {
        inventory_value: fmtNum(inventory.inventory_value),
        products_count: parseInt(inventory.products_count || 0),
      },
    });
  } catch (err) {
    console.error("[SUMMARY ERROR]", err);
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ============================================
// 📄 LISTAR FACTURAS
// ============================================
exports.getInvoices = async (req, res) => {
  const { type, status, start_date, end_date, limit = 100, offset = 0 } = req.query;

  let where = [];
  let params = [];
  let paramIndex = 1;

  if (type) { where.push(`invoice_type = $${paramIndex}`); params.push(type); paramIndex++; }
  if (status) { where.push(`payment_status = $${paramIndex}`); params.push(status); paramIndex++; }
  if (start_date && end_date) {
    where.push(`invoice_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
    params.push(start_date, end_date);
    paramIndex += 2;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const result = await db.query(
      `SELECT
         i.*,
         p.name AS provider_name,
         COALESCE(
           (SELECT json_agg(json_build_object(
              'product_id', ii.product_id,
              'product_name', prod.name,
              'quantity', ii.quantity,
              'unit_price', ii.unit_price,
              'subtotal', ii.subtotal
            ))
            FROM invoice_items ii
            LEFT JOIN products prod ON prod.id = ii.product_id
            WHERE ii.invoice_id = i.id
           ), '[]'::json
         ) AS items
       FROM invoices i
       LEFT JOIN providers p ON p.id = i.provider_id
       ${whereClause}
       ORDER BY i.invoice_date DESC, i.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET INVOICES ERROR]", err);
    res.status(500).json({ message: "Error al obtener facturas" });
  }
};

// ============================================
// ➕ CREAR FACTURA
// ============================================
exports.createInvoice = async (req, res) => {
  const {
    invoice_type, provider_id, invoice_number, invoice_date,
    due_date, description, items = [], total_amount, payment_method, notes,
  } = req.body;

  if (!invoice_type || !["service", "purchase"].includes(invoice_type))
    return res.status(400).json({ message: "Tipo de factura inválido (service o purchase)" });
  if (!total_amount || total_amount <= 0)
    return res.status(400).json({ message: "El monto debe ser mayor a 0" });
  if (invoice_type === "purchase") {
    if (!items || items.length === 0)
      return res.status(400).json({ message: "Las compras deben incluir productos" });
    if (!provider_id)
      return res.status(400).json({ message: "Las compras requieren un proveedor" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      `INSERT INTO invoices (
        invoice_type, provider_id, invoice_number, invoice_date, due_date,
        description, total_amount, pending_amount, payment_status, payment_method, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        invoice_type, provider_id || null, invoice_number || null,
        invoice_date || new Date(), due_date || null,
        description || "Factura registrada", total_amount,
        payment_method === "credit" ? total_amount : 0,
        payment_method === "credit" ? "pending" : "paid",
        payment_method || "cash", notes || null,
        req.user?.id || null,
      ]
    );

    const invoiceId = invoiceResult.rows[0].id;

    if (invoice_type === "purchase" && items.length > 0) {
      for (const item of items) {
        const { product_id, variant_id, quantity, unit_price } = item;
        if (!product_id || !quantity || !unit_price)
          throw new Error("Items incompletos en la factura");

        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1,$2,$3,$4,$5)`,
          [invoiceId, product_id, quantity, unit_price, quantity * unit_price]
        );

        // Leer producto para saber si tiene variantes e historial de precio
        const oldProductResult = await client.query(
          `SELECT has_variants, purchase_price, sale_price FROM products WHERE id = $1`,
          [product_id]
        );
        const oldProduct = oldProductResult.rows[0];

        if (oldProduct?.has_variants && variant_id) {
          // ── Producto CON variantes: stock va a product_variants ──
          const variantExists = await client.query(
            `SELECT id FROM product_variants WHERE id = $1 AND product_id = $2`,
            [variant_id, product_id]
          );
          if (variantExists.rows.length === 0)
            throw new Error(`La variante ${variant_id} no pertenece al producto ${product_id}`);

          await client.query(
            `UPDATE product_variants
               SET stock = stock + $1, updated_at = NOW()
             WHERE id = $2`,
            [quantity, variant_id]
          );

          // Actualizar solo precio de compra base del producto (sin tocar su stock)
          await client.query(
            `UPDATE products
               SET purchase_price = $1, updated_at = NOW()
             WHERE id = $2`,
            [unit_price, product_id]
          );
        } else {
          // ── Producto SIN variantes: stock va directo a products ──
          await client.query(
            `UPDATE products
               SET purchase_price = $1, stock = stock + $2, updated_at = NOW()
             WHERE id = $3`,
            [unit_price, quantity, product_id]
          );
        }

        // Historial de precio si cambió
        if (oldProduct && fmtNum(oldProduct.purchase_price) !== fmtNum(unit_price)) {
          await client.query(
            `INSERT INTO product_price_history
               (product_id, old_purchase_price, new_purchase_price, old_sale_price, new_sale_price, reason, changed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              product_id,
              oldProduct.purchase_price,
              unit_price,
              oldProduct.sale_price,
              oldProduct.sale_price,
              "Factura de compra",
              req.user?.id || null,
            ]
          );
        }
      }
    }

    if (payment_method === "credit" && provider_id) {
      await client.query(
        `UPDATE providers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [total_amount, provider_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({
      message: invoice_type === "service"
        ? "Factura de servicio registrada exitosamente"
        : "Compra registrada exitosamente",
      invoice_id: invoiceId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE INVOICE ERROR]", err);
    res.status(500).json({ message: err.message || "Error al crear factura" });
  } finally {
    client.release();
  }
};
  
// ============================================
// 💳 REGISTRAR PAGO DE FACTURA
// ============================================
exports.payInvoice = async (req, res) => {
  const { invoice_id, amount, payment_method, payment_date, notes } = req.body;

  if (!invoice_id || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos de pago incompletos" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      `SELECT id, provider_id, pending_amount, total_amount, payment_status FROM invoices WHERE id = $1`,
      [invoice_id]
    );
    if (invoiceResult.rows.length === 0) throw new Error("Factura no encontrada");

    const invoice = invoiceResult.rows[0];
    if (invoice.payment_status === "paid") throw new Error("Esta factura ya está completamente pagada");
    if (amount > invoice.pending_amount) throw new Error("El monto excede lo pendiente de pago");

    await client.query(
      `INSERT INTO invoice_payments (invoice_id, amount, payment_method, payment_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [invoice_id, amount, payment_method || "cash", payment_date || new Date(), notes || null, req.user?.id || null]
    );

    const newPending = fmtNum(invoice.pending_amount) - fmtNum(amount);
    const newStatus = newPending <= 0 ? "paid" : newPending < fmtNum(invoice.total_amount) ? "partial" : "pending";

    await client.query(
      `UPDATE invoices SET pending_amount = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
      [newPending, newStatus, invoice_id]
    );

    if (invoice.provider_id) {
      await client.query(
        `UPDATE providers SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE id = $2`,
        [amount, invoice.provider_id]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Pago registrado exitosamente", new_pending: newPending, new_status: newStatus });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PAY INVOICE ERROR]", err);
    res.status(500).json({ message: err.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ============================================
// 💳 PAGO DIRECTO A PROVEEDOR  ← NUEVO
// ============================================
exports.payProvider = async (req, res) => {
  const { provider_id, amount, payment_method, notes } = req.body;

  if (!provider_id || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos de pago incompletos" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const provResult = await client.query(
      `SELECT id, name, balance FROM providers WHERE id = $1 AND is_active = true`,
      [provider_id]
    );
    if (provResult.rows.length === 0) throw new Error("Proveedor no encontrado");

    const provider = provResult.rows[0];
    if (fmtNum(amount) > fmtNum(provider.balance))
      throw new Error("El monto supera la deuda actual del proveedor");

    // Registrar en provider_payments
    await client.query(
      `INSERT INTO provider_payments (provider_id, amount, payment_method, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [provider_id, amount, payment_method || "transfer", notes || null, req.user?.id || null]
    );

    // Reducir balance del proveedor
    await client.query(
      `UPDATE providers SET balance = GREATEST(0, balance - $1), updated_at = NOW() WHERE id = $2`,
      [amount, provider_id]
    );

    await client.query("COMMIT");

    const newBalance = Math.max(0, fmtNum(provider.balance) - fmtNum(amount));
    res.json({
      message: `Pago de ${payment_method || "transferencia"} registrado para ${provider.name}`,
      new_balance: newBalance,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PAY PROVIDER ERROR]", err);
    res.status(500).json({ error: err.message || "Error al registrar pago al proveedor" });
  } finally {
    client.release();
  }
};

// ============================================
// 💸 REGISTRAR GASTO DIRECTO
// ============================================
exports.createExpense = async (req, res) => {
  const {
    expense_type, category, description, amount,
    payment_method, provider_id, product_id, quantity,
    utility_type, utility_value, notes, expense_date,
  } = req.body;

  if (!expense_type || !description || !amount || amount <= 0)
    return res.status(400).json({ message: "Datos del gasto incompletos" });

  try {
    const result = await db.query(
      `INSERT INTO expenses (
        expense_type, category, description, amount, payment_method,
        provider_id, product_id, quantity, utility_type, utility_value,
        notes, expense_date, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        expense_type, category || null, description, amount,
        payment_method || "cash", provider_id || null, product_id || null,
        quantity || 1, utility_type || null, utility_value || 0,
        notes || null, expense_date || new Date(), req.user?.id || null,
      ]
    );

    if (expense_type === "purchase" && product_id && quantity > 0) {
      await db.query(
        `UPDATE products SET purchase_price = $1, stock = stock + $2, updated_at = NOW() WHERE id = $3`,
        [amount / quantity, quantity, product_id]
      );
    }

    res.status(201).json({ message: "Gasto registrado exitosamente", expense_id: result.rows[0].id });
  } catch (err) {
    console.error("[CREATE EXPENSE ERROR]", err);
    res.status(500).json({ message: err.message || "Error al registrar gasto" });
  }
};

// ============================================
// 📋 LISTAR GASTOS
// ============================================
exports.getExpenses = async (req, res) => {
  const { type, start_date, end_date, limit = 200, offset = 0 } = req.query;

  let where = [];
  let params = [];
  let paramIndex = 1;

  if (type) { where.push(`e.expense_type = $${paramIndex}`); params.push(type); paramIndex++; }
  if (start_date && end_date) {
    where.push(`e.expense_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
    params.push(start_date, end_date);
    paramIndex += 2;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const result = await db.query(
      `SELECT
         e.*,
         p.name AS provider_name,
         prod.name AS product_name
       FROM expenses e
       LEFT JOIN providers p ON p.id = e.provider_id
       LEFT JOIN products prod ON prod.id = e.product_id
       ${whereClause}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET EXPENSES ERROR]", err);
    res.status(500).json({ message: "Error al obtener gastos" });
  }
};

// ============================================
// 📊 GASTOS POR CATEGORÍA
// ============================================
exports.getExpensesByCategory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         COALESCE(category, expense_type::text) AS category,
         expense_type,
         COUNT(*) AS count,
         SUM(amount) AS total
       FROM expenses
       WHERE expense_date >= NOW() - INTERVAL '3 months'
       GROUP BY COALESCE(category, expense_type::text), expense_type
       ORDER BY total DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[EXPENSES BY CATEGORY ERROR]", err);
    res.status(500).json({ message: "Error al obtener gastos por categoría" });
  }
};

// ============================================
// 🏦 DEUDAS CON PROVEEDORES
// ============================================
exports.getProviderDebts = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.category, p.phone, p.email,
         p.balance AS current_balance,
         p.credit_limit,
         p.credit_limit - p.balance AS available_credit,
         CASE WHEN p.credit_limit > 0 THEN ROUND((p.balance / p.credit_limit * 100)::numeric, 1) ELSE 0 END AS credit_used_pct,
         COUNT(DISTINCT CASE WHEN i.payment_status != 'paid' THEN i.id END) AS pending_invoices,
         COALESCE(SUM(CASE WHEN i.payment_status != 'paid' THEN i.pending_amount ELSE 0 END), 0) AS total_pending_invoices
       FROM providers p
       LEFT JOIN invoices i ON i.provider_id = p.id
       WHERE p.is_active = true AND p.balance > 0
       GROUP BY p.id
       ORDER BY p.balance DESC`
    );

    const summary = {
      total_debt: result.rows.reduce((s, r) => s + fmtNum(r.current_balance), 0),
      providers_count: result.rows.length,
    };

    res.json({ providers: result.rows, summary });
  } catch (err) {
    console.error("[PROVIDER DEBTS ERROR]", err);
    res.status(500).json({ message: "Error al obtener deudas con proveedores" });
  }
};

// ============================================
// 📈 ANÁLISIS DE PROVEEDORES
// ============================================
exports.getProviderAnalysis = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.category,
         p.reliability_score,
         COUNT(DISTINCT po.id) AS total_orders,
         COALESCE(SUM(po.total_cost), 0) AS total_spent,
         COALESCE(AVG(po.total_cost), 0) AS avg_order_value,
         p.balance AS current_debt
       FROM providers p
       LEFT JOIN purchase_orders po ON po.provider_id = p.id AND po.status != 'cancelled'
       WHERE p.is_active = true
       GROUP BY p.id
       ORDER BY total_spent DESC
       LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[PROVIDER ANALYSIS ERROR]", err);
    res.status(500).json({ message: "Error al obtener análisis de proveedores" });
  }
};

// ============================================
// 📈 FLUJO DE CAJA MENSUAL
// ============================================
exports.getCashflow = async (req, res) => {
  try {
    const result = await db.query(`
      WITH monthly_data AS (
        SELECT
          TO_CHAR(DATE_TRUNC('month', sale_date), 'Mon YY') AS month,
          DATE_TRUNC('month', sale_date) AS month_date,
          SUM(total) AS revenue, 0 AS costs
        FROM sales
        WHERE payment_status = 'paid' AND sale_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', sale_date)
        UNION ALL
        SELECT
          TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YY') AS month,
          DATE_TRUNC('month', invoice_date) AS month_date,
          0 AS revenue, SUM(total_amount - pending_amount) AS costs
        FROM invoices
        WHERE invoice_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', invoice_date)
        UNION ALL
        SELECT
          TO_CHAR(DATE_TRUNC('month', expense_date), 'Mon YY') AS month,
          DATE_TRUNC('month', expense_date::timestamp) AS month_date,
          0 AS revenue, SUM(amount) AS costs
        FROM expenses
        WHERE expense_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', expense_date::timestamp)
      )
      SELECT
        month,
        COALESCE(SUM(revenue), 0) AS revenue,
        COALESCE(SUM(costs), 0) AS costs,
        COALESCE(SUM(revenue - costs), 0) AS profit
      FROM monthly_data
      GROUP BY month, month_date
      ORDER BY month_date
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[CASHFLOW ERROR]", err);
    res.status(500).json({ message: "Error al obtener flujo de caja" });
  }
};

// ============================================
// 🏷️ RENTABILIDAD POR PRODUCTO
// ============================================
exports.getProfitByProduct = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id, p.name, p.sku, p.stock,
        COALESCE(p.purchase_price, 0) AS cost_price,
        COALESCE(p.sale_price, 0) AS sale_price,
        COALESCE(p.sale_price - p.purchase_price, 0) AS unit_profit,
        CASE
          WHEN COALESCE(p.sale_price, 0) > 0
          THEN ROUND(((p.sale_price - p.purchase_price) / p.sale_price * 100)::numeric, 2)
          ELSE 0
        END AS margin_pct,
        COALESCE(sales.units_sold, 0) AS units_sold,
        COALESCE(sales.total_revenue, 0) AS total_revenue,
        COALESCE(sales.total_profit, 0) AS realized_profit,
        p.stock * COALESCE(p.purchase_price, 0) AS inventory_value
      FROM products p
      LEFT JOIN (
        SELECT product_id,
          SUM(quantity) AS units_sold,
          SUM(subtotal) AS total_revenue,
          SUM(total_profit) AS total_profit
        FROM sale_items
        GROUP BY product_id
      ) sales ON sales.product_id = p.id
      WHERE p.is_active = true
      ORDER BY realized_profit DESC NULLS LAST
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[PROFIT BY PRODUCT ERROR]", err);
    res.status(500).json({ message: "Error al obtener rentabilidad" });
  }
};

module.exports = exports;