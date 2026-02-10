const db = require("../config/db");

// ============================================
// 🛒 CREAR NUEVA VENTA
// ============================================
exports.createSale = async (req, res) => {
  const { items, subtotal, total, customer_id, sale_type, payment_method } = req.body;
  const client = await db.connect();

  try {
    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "La venta debe contener al menos un producto" 
      });
    }

    if (!total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: "El total de la venta debe ser mayor a 0"
      });
    }

    await client.query("BEGIN");

    // 1. Generar número de venta
    const saleNumberResult = await client.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 2) AS INTEGER)), 0) + 1 as next_num FROM sales WHERE sale_number LIKE 'V%'"
    );
    const nextNumber = saleNumberResult.rows[0].next_num;
    const saleNumber = `V${String(nextNumber).padStart(6, '0')}`;

    // 2. Crear la venta
    const saleResult = await client.query(
      `INSERT INTO sales (
        sale_number,
        subtotal, 
        total, 
        customer_id, 
        sale_type, 
        payment_method,
        payment_status,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, sale_number`,
      [
        saleNumber,
        subtotal || total,
        total,
        customer_id || null,
        sale_type || "fisica",
        payment_method || "cash",
        "paid",
        req.user?.id || null
      ]
    );

    const saleId = saleResult.rows[0].id;

    // 3. Insertar items y actualizar stock
    for (const item of items) {
      const productId = item.id || item.product_id;
      
      const productCheck = await client.query(
        "SELECT id, name, sale_price, stock, purchase_price FROM products WHERE id = $1",
        [productId]
      );

      if (productCheck.rowCount === 0) {
        throw new Error(`Producto con ID ${productId} no encontrado`);
      }

      const product = productCheck.rows[0];

      if (product.stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, Solicitado: ${item.quantity}`
        );
      }

      const unitPrice = item.price || item.unit_price || product.sale_price;
      const unitCost = product.purchase_price || 0;
      const subtotal = unitPrice * item.quantity;
      const profitPerUnit = unitPrice - unitCost;
      const totalProfit = profitPerUnit * item.quantity;

      // Insertar item de venta
      await client.query(
        `INSERT INTO sale_items (
          sale_id, 
          product_id, 
          quantity, 
          unit_price,
          unit_cost,
          subtotal,
          profit_per_unit,
          total_profit
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [saleId, productId, item.quantity, unitPrice, unitCost, subtotal, profitPerUnit, totalProfit]
      );

      // Actualizar stock
      const stockResult = await client.query(
        `UPDATE products 
         SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2 AND stock >= $1
         RETURNING stock`,
        [item.quantity, productId]
      );

      if (stockResult.rowCount === 0) {
        throw new Error(`No se pudo actualizar el stock de "${product.name}"`);
      }
    }

    await client.query("COMMIT");

    // ✅ Devolver objeto directo
    res.status(201).json({
      success: true,
      message: "Venta registrada con éxito",
      data: {
        id: saleId,
        sale_number: saleNumber,
        total: total
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CREATE SALE ERROR]", error);

    res.status(500).json({
      success: false,
      message: error.message || "Error al registrar la venta"
    });
  } finally {
    client.release();
  }
};

// ============================================
// 📋 OBTENER TODAS LAS VENTAS
// ============================================
exports.getSales = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id,
        s.sale_number,
        s.subtotal,
        s.total,
        s.sale_type,
        s.payment_method,
        s.payment_status,
        s.sale_date,
        s.created_at,
        u.name as customer_name,
        u.email as customer_email,
        u.cedula as customer_cedula,
        seller.name as seller_name,
        COUNT(si.id) as items_count,
        COALESCE(SUM(si.total_profit), 0) as total_profit
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
      LEFT JOIN users seller ON s.created_by = seller.id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY s.id, u.name, u.email, u.cedula, seller.name
      ORDER BY s.created_at DESC
    `);

    // ✅ Devolver array directo
    res.json(result.rows);
    
  } catch (error) {
    console.error("[GET SALES ERROR]", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener ventas"
    });
  }
};

// ============================================
// 🔍 OBTENER DETALLE DE UNA VENTA
// ============================================
exports.getSaleById = async (req, res) => {
  const { id } = req.params;

  try {
    // Obtener items de la venta
    const itemsResult = await db.query(
      `SELECT 
        si.id,
        si.quantity,
        si.unit_price,
        si.unit_cost,
        si.subtotal,
        si.profit_per_unit,
        si.total_profit,
        p.name,
        p.sku
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY si.id`,
      [id]
    );

    // ✅ Devolver array directo
    res.json(itemsResult.rows);
    
  } catch (error) {
    console.error("[GET SALE BY ID ERROR]", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el detalle de la venta"
    });
  }
};

// ============================================
// 📊 OBTENER RESUMEN DE VENTAS
// ============================================
exports.getSalesSummary = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let dateFilter = "";
    const params = [];

    if (start_date && end_date) {
      dateFilter = "WHERE s.sale_date BETWEEN $1 AND $2";
      params.push(start_date, end_date);
    }

    const result = await db.query(
      `SELECT 
        COUNT(*) as total_sales,
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(AVG(total), 0) as average_sale,
        COUNT(DISTINCT customer_id) as unique_customers,
        COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_sales,
        COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_sales
      FROM sales s
      ${dateFilter}`,
      params
    );

    // ✅ Devolver objeto directo
    res.json(result.rows[0]);
    
  } catch (error) {
    console.error("[GET SALES SUMMARY ERROR]", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener resumen de ventas"
    });
  }
};