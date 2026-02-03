const db = require("../config/db");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const providerCreateSchema = z.object({
  name: z.string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(200, "El nombre no puede exceder 200 caracteres")
    .trim(),
  category: z.string()
    .min(2, "La categoría debe tener al menos 2 caracteres")
    .max(100, "La categoría no puede exceder 100 caracteres")
    .trim(),
  phone: z.string()
    .regex(/^\+?[\d\s\-()]+$/, "Número de teléfono inválido")
    .min(7, "Teléfono demasiado corto")
    .max(20, "Teléfono demasiado largo")
    .optional()
    .or(z.literal("")),
  email: z.string()
    .email("Email inválido")
    .max(255, "Email demasiado largo")
    .trim()
    .toLowerCase()
    .optional()
    .or(z.literal("")),
  address: z.string()
    .max(500, "Dirección demasiado larga")
    .trim()
    .optional()
    .or(z.literal(""))
});

const providerUpdateSchema = providerCreateSchema.partial();

const paymentSchema = z.object({
  provider_id: z.number().int().positive(),
  amount: z.number().positive().max(999999999),
  payment_method: z.enum(['cash', 'transfer', 'check', 'credit']),
  notes: z.string().max(500).trim().optional()
});

// ===============================
// OBTENER TODOS LOS PROVEEDORES
// ===============================

exports.getProviders = async (req, res) => {
  try {
    const { category, has_debt, limit = 500 } = req.query;

    let query = `
      SELECT 
        p.*,
        COUNT(DISTINCT po.id) as total_orders,
        COALESCE(SUM(po.total_amount), 0) as total_purchased,
        (SELECT COUNT(*) FROM provider_payments WHERE provider_id = p.id) as payments_count
      FROM providers p
      LEFT JOIN purchase_orders po ON p.id = po.provider_id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (category) {
      query += ` AND p.category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }

    if (has_debt === 'true') {
      query += ` AND p.balance > 0`;
    }

    query += ` GROUP BY p.id ORDER BY p.name ASC LIMIT $${paramCount}`;
    params.push(Math.min(parseInt(limit) || 500, 1000));

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("GET PROVIDERS ERROR:", {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    res.status(500).json({ message: "Error al obtener proveedores" });
  }
};

// ===============================
// OBTENER PROVEEDOR POR ID
// ===============================

exports.getProviderById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(`
      SELECT 
        p.*,
        COUNT(DISTINCT po.id) as total_orders,
        COALESCE(SUM(po.total_amount), 0) as total_purchased,
        (SELECT COUNT(*) FROM provider_payments WHERE provider_id = p.id) as payments_count,
        (SELECT COALESCE(SUM(amount), 0) FROM provider_payments WHERE provider_id = p.id) as total_paid
      FROM providers p
      LEFT JOIN purchase_orders po ON p.id = po.provider_id
      WHERE p.id = $1
      GROUP BY p.id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET PROVIDER ERROR:", {
      message: error.message,
      providerId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener proveedor" });
  }
};

// ===============================
// CREAR PROVEEDOR
// ===============================

exports.createProvider = async (req, res) => {
  try {
    // Validar datos
    const validatedData = providerCreateSchema.parse(req.body);

    // Verificar que no exista un proveedor con el mismo nombre
    const existingProvider = await db.query(
      "SELECT id FROM providers WHERE LOWER(name) = LOWER($1)",
      [validatedData.name]
    );

    if (existingProvider.rows.length > 0) {
      return res.status(400).json({ 
        message: "Ya existe un proveedor con ese nombre" 
      });
    }

    const result = await db.query(
      `INSERT INTO providers (name, category, phone, email, address, balance, created_at) 
       VALUES ($1, $2, $3, $4, $5, 0, NOW()) 
       RETURNING *`,
      [
        validatedData.name,
        validatedData.category,
        validatedData.phone || null,
        validatedData.email || null,
        validatedData.address || null
      ]
    );

    res.status(201).json({
      message: "Proveedor creado con éxito",
      provider: result.rows[0]
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("CREATE PROVIDER ERROR:", {
      message: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al crear proveedor" });
  }
};

// ===============================
// ACTUALIZAR PROVEEDOR
// ===============================

exports.updateProvider = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // Validar datos
    const validatedData = providerUpdateSchema.parse(req.body);

    // Verificar que existe
    const existingProvider = await db.query(
      "SELECT id FROM providers WHERE id = $1",
      [id]
    );

    if (existingProvider.rows.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    // Verificar nombre único si se actualiza
    if (validatedData.name) {
      const nameCheck = await db.query(
        "SELECT id FROM providers WHERE LOWER(name) = LOWER($1) AND id != $2",
        [validatedData.name, id]
      );

      if (nameCheck.rows.length > 0) {
        return res.status(400).json({ 
          message: "Ya existe un proveedor con ese nombre" 
        });
      }
    }

    // Construir query de actualización
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (validatedData.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(validatedData.name);
    }

    if (validatedData.category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(validatedData.category);
    }

    if (validatedData.phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(validatedData.phone || null);
    }

    if (validatedData.email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      values.push(validatedData.email || null);
    }

    if (validatedData.address !== undefined) {
      updates.push(`address = $${paramCount++}`);
      values.push(validatedData.address || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No hay campos para actualizar" });
    }

    values.push(id);

    await db.query(
      `UPDATE providers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
      values
    );

    res.json({ message: "Proveedor actualizado con éxito" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("UPDATE PROVIDER ERROR:", {
      message: error.message,
      providerId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al actualizar proveedor" });
  }
};

// ===============================
// ELIMINAR PROVEEDOR
// ===============================

exports.deleteProvider = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // Verificar que no tenga órdenes de compra
    const ordersCheck = await db.query(
      "SELECT COUNT(*) as count FROM purchase_orders WHERE provider_id = $1",
      [id]
    );

    if (parseInt(ordersCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        message: "No se puede eliminar: el proveedor tiene órdenes de compra asociadas" 
      });
    }

    // Verificar que no tenga deuda pendiente
    const providerCheck = await db.query(
      "SELECT balance FROM providers WHERE id = $1",
      [id]
    );

    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    if (parseFloat(providerCheck.rows[0].balance) > 0) {
      return res.status(400).json({ 
        message: "No se puede eliminar: el proveedor tiene deuda pendiente" 
      });
    }

    const result = await db.query(
      "DELETE FROM providers WHERE id = $1 RETURNING id",
      [id]
    );

    res.json({ 
      message: "Proveedor eliminado con éxito",
      id: result.rows[0].id
    });
  } catch (error) {
    console.error("DELETE PROVIDER ERROR:", {
      message: error.message,
      providerId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al eliminar proveedor" });
  }
};

// ===============================
// HISTORIAL DE COMPRAS
// ===============================

exports.getProviderHistory = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(`
      SELECT 
        po.id,
        CONCAT('OC-', LPAD(po.id::text, 5, '0')) as order_code,
        po.total_amount,
        po.payment_status,
        po.payment_method,
        po.created_at,
        (SELECT COUNT(*) FROM purchase_order_items WHERE order_id = po.id) as items_count
      FROM purchase_orders po
      WHERE po.provider_id = $1
      ORDER BY po.created_at DESC
      LIMIT 100
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PROVIDER HISTORY ERROR:", {
      message: error.message,
      providerId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener historial" });
  }
};

// ===============================
// HISTORIAL DE PRECIOS POR PRODUCTO
// ===============================

exports.getProductPriceHistory = async (req, res) => {
  try {
    const providerId = parseInt(req.params.provider_id);
    const productId = parseInt(req.params.product_id);

    if (isNaN(providerId) || providerId <= 0) {
      return res.status(400).json({ message: "ID de proveedor inválido" });
    }

    if (isNaN(productId) || productId <= 0) {
      return res.status(400).json({ message: "ID de producto inválido" });
    }

    const result = await db.query(`
      SELECT 
        po.id,
        CONCAT('OC-', LPAD(po.id::text, 5, '0')) as order_code,
        po.created_at,
        poi.unit_cost,
        poi.quantity,
        poi.suggested_price,
        poi.markup_type,
        poi.markup_value,
        (poi.suggested_price - poi.unit_cost) as unit_profit,
        CASE
          WHEN poi.unit_cost > 0 THEN
            ROUND(((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100)::numeric, 2)
          ELSE 0
        END as profit_margin
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.order_id = po.id
      WHERE po.provider_id = $1 AND poi.product_id = $2
      ORDER BY po.created_at DESC
      LIMIT 20
    `, [providerId, productId]);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PRICE HISTORY ERROR:", {
      message: error.message,
      providerId: req.params.provider_id,
      productId: req.params.product_id
    });
    res.status(500).json({ message: "Error al obtener historial de precios" });
  }
};

// ===============================
// ESTADÍSTICAS DEL PROVEEDOR
// ===============================

exports.getProviderStats = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const stats = await db.query(`
      SELECT 
        COUNT(DISTINCT po.id) as total_pedidos,
        COALESCE(SUM(po.total_amount), 0) as volumen_total_compra,
        COALESCE(AVG(po.total_amount), 0) as ticket_promedio,
        COALESCE(MAX(po.created_at), NULL) as ultima_compra,
        COALESCE(MIN(po.created_at), NULL) as primera_compra,
        (SELECT balance FROM providers WHERE id = $1) as deuda_actual,
        (SELECT COALESCE(SUM(amount), 0) FROM provider_payments WHERE provider_id = $1) as total_pagado
      FROM purchase_orders po
      WHERE po.provider_id = $1
    `, [id]);

    if (stats.rows.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    res.json(stats.rows[0]);
  } catch (error) {
    console.error("GET PROVIDER STATS ERROR:", {
      message: error.message,
      providerId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener estadísticas" });
  }
};

// ===============================
// RENTABILIDAD POR PROVEEDOR
// ===============================

exports.getProfitByProvider = async (req, res) => {
  try {
    const providerId = parseInt(req.params.provider_id);

    if (isNaN(providerId) || providerId <= 0) {
      return res.status(400).json({ message: "ID de proveedor inválido" });
    }

    const result = await db.query(`
      SELECT 
        p.id as product_id,
        p.name AS product_name,
        prov.name AS provider_name,
        poi.unit_cost as purchase_price,
        poi.suggested_price as sale_price,
        poi.markup_type,
        poi.markup_value,
        (poi.suggested_price - poi.unit_cost) AS unit_profit,
        CASE
          WHEN poi.unit_cost > 0 THEN
            ROUND(((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100)::numeric, 2)
          ELSE 0
        END as profit_margin_percent,
        po.created_at as last_purchase_date
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.order_id = po.id
      JOIN products p ON poi.product_id = p.id
      JOIN providers prov ON po.provider_id = prov.id
      WHERE po.provider_id = $1
      ORDER BY po.created_at DESC
      LIMIT 100
    `, [providerId]);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PROFIT BY PROVIDER ERROR:", {
      message: error.message,
      providerId: req.params.provider_id
    });
    res.status(500).json({ message: "Error al obtener rentabilidad" });
  }
};

// ===============================
// COMPARAR PROVEEDORES
// ===============================

exports.compareProvidersProfit = async (req, res) => {
  try {
    const productId = parseInt(req.params.product_id);

    if (isNaN(productId) || productId <= 0) {
      return res.status(400).json({ message: "ID de producto inválido" });
    }

    const result = await db.query(`
      SELECT 
        prov.id as provider_id,
        prov.name AS provider_name,
        prov.category as provider_category,
        AVG(poi.unit_cost) as avg_purchase_price,
        MIN(poi.unit_cost) as min_purchase_price,
        MAX(poi.unit_cost) as max_purchase_price,
        AVG(poi.suggested_price) as avg_sale_price,
        AVG(poi.suggested_price - poi.unit_cost) as avg_profit,
        AVG(
          CASE
            WHEN poi.unit_cost > 0 THEN
              ((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100)
            ELSE 0
          END
        ) as avg_profit_margin,
        COUNT(*) as purchases_count,
        MAX(po.created_at) as last_purchase_date
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.order_id = po.id
      JOIN providers prov ON po.provider_id = prov.id
      WHERE poi.product_id = $1
      GROUP BY prov.id, prov.name, prov.category
      ORDER BY avg_profit DESC
    `, [productId]);

    res.json(result.rows);
  } catch (error) {
    console.error("COMPARE PROVIDERS ERROR:", {
      message: error.message,
      productId: req.params.product_id
    });
    res.status(500).json({ message: "Error al comparar proveedores" });
  }
};

// ===============================
// REGISTRAR PAGO
// ===============================

exports.registerPayment = async (req, res) => {
  const client = await db.connect();
  
  try {
    // Validar datos
    const validatedData = paymentSchema.parse(req.body);

    await client.query("BEGIN");

    // Verificar que el proveedor existe y tiene suficiente deuda
    const providerCheck = await client.query(
      "SELECT id, balance, name FROM providers WHERE id = $1",
      [validatedData.provider_id]
    );

    if (providerCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    const currentBalance = parseFloat(providerCheck.rows[0].balance);

    if (currentBalance < validatedData.amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        message: `El pago (${validatedData.amount}) excede la deuda actual (${currentBalance})` 
      });
    }

    if (currentBalance === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        message: "El proveedor no tiene deuda pendiente" 
      });
    }

    // Registrar el pago
    await client.query(
      `INSERT INTO provider_payments (provider_id, amount, payment_method, notes, created_at) 
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        validatedData.provider_id, 
        validatedData.amount, 
        validatedData.payment_method,
        validatedData.notes || null
      ]
    );

    // Actualizar balance del proveedor
    await client.query(
      "UPDATE providers SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
      [validatedData.amount, validatedData.provider_id]
    );

    await client.query("COMMIT");
    
    res.json({ 
      message: "Pago registrado y deuda actualizada",
      provider: providerCheck.rows[0].name,
      amount_paid: validatedData.amount,
      previous_balance: currentBalance,
      new_balance: currentBalance - validatedData.amount
    });
  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("REGISTER PAYMENT ERROR:", {
      message: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ===============================
// OBTENER HISTORIAL DE PAGOS
// ===============================

exports.getPaymentHistory = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(`
      SELECT 
        pp.*,
        p.name as provider_name
      FROM provider_payments pp
      JOIN providers p ON pp.provider_id = p.id
      WHERE pp.provider_id = $1
      ORDER BY pp.created_at DESC
      LIMIT 100
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PAYMENT HISTORY ERROR:", {
      message: error.message,
      providerId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener historial de pagos" });
  }
};

module.exports = exports;