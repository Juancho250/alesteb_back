const db = require("../config/db");

// ============================================
// 🛒 CREAR NUEVA VENTA
// ============================================

exports.createSale = async (req, res) => {
  const { items, subtotal, total, customer_id, sale_type, payment_method } = req.body;
  const client = await db.connect();

  try {
    // Validar que haya items
    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "La venta debe contener al menos un producto" 
      });
    }

    // Validar total
    if (!total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: "El total de la venta debe ser mayor a 0"
      });
    }

    await client.query("BEGIN");

    // 1. Crear la venta
    const saleResult = await client.query(
      `INSERT INTO sales (
        subtotal, 
        total, 
        customer_id, 
        sale_type, 
        payment_method,
        payment_status,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, sale_number`,
      [
        subtotal || total,
        total,
        customer_id || null,
        sale_type || "fisica",
        payment_method || "cash",
        "paid",
        req.user?.id || null // ID del usuario que crea la venta
      ]
    );

    const saleId = saleResult.rows[0].id;
    const saleNumber = saleResult.rows[0].sale_number;

    // 2. Insertar items y actualizar stock
    for (const item of items) {
      // Validar que el producto exista y tenga stock suficiente
      const productCheck = await client.query(
        "SELECT id, name, sale_price, stock FROM products WHERE id = $1",
        [item.id || item.product_id]
      );

      if (productCheck.rowCount === 0) {
        throw new Error(`Producto con ID ${item.id || item.product_id} no encontrado`);
      }

      const product = productCheck.rows[0];

      if (product.stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, Solicitado: ${item.quantity}`
        );
      }

      // Insertar item de venta
      await client.query(
        `INSERT INTO sale_items (
          sale_id, 
          product_id, 
          quantity, 
          unit_price,
          subtotal
        )
        VALUES ($1, $2, $3, $4, $5)`,
        [
          saleId,
          item.id || item.product_id,
          item.quantity,
          item.price || item.unit_price || product.sale_price,
          (item.price || item.unit_price || product.sale_price) * item.quantity
        ]
      );

      // Actualizar stock del producto
      const stockResult = await client.query(
        `UPDATE products 
         SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2 AND stock >= $1
         RETURNING stock`,
        [item.quantity, item.id || item.product_id]
      );

      if (stockResult.rowCount === 0) {
        throw new Error(
          `No se pudo actualizar el stock de "${product.name}". Posible condición de carrera.`
        );
      }
    }

    // 3. Verificar que el cliente existe (si se proporcionó)
    if (customer_id) {
      const userCheck = await client.query(
        "SELECT id, name FROM users WHERE id = $1",
        [customer_id]
      );

      if (userCheck.rowCount === 0) {
        throw new Error("El cliente especificado no existe");
      }
    }

    await client.query("COMMIT");

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
        seller.name as seller_name,
        (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS items_count
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
      LEFT JOIN users seller ON s.created_by = seller.id
      ORDER BY s.created_at DESC
    `);

    res.json({
      success: true,
      data: result.rows
    });
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
    // 1. Obtener información de la venta
    const saleResult = await db.query(
      `SELECT 
        s.*,
        u.name as customer_name,
        u.email as customer_email,
        u.phone as customer_phone,
        seller.name as seller_name
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
      LEFT JOIN users seller ON s.created_by = seller.id
      WHERE s.id = $1`,
      [id]
    );

    if (saleResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Venta no encontrada"
      });
    }

    // 2. Obtener items de la venta
    const itemsResult = await db.query(
      `SELECT 
        si.*,
        p.name as product_name,
        p.sku as product_sku
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1`,
      [id]
    );

    const sale = saleResult.rows[0];
    sale.items = itemsResult.rows;

    res.json({
      success: true,
      data: sale
    });
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

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error("[GET SALES SUMMARY ERROR]", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener resumen de ventas"
    });
  }
};