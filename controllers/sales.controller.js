const db = require("../config/db");

// 1. INSERTAR VENTAS (Mejorado para aplicar descuentos automáticamente)
exports.createSale = async (req, res) => {
  const { items, total, sale_type, customer_id } = req.body;

  const client = await db.connect();

  try {
    // Validaciones básicas
    if (!items || items.length === 0) {
      return res.status(400).json({ message: "La venta no tiene productos" });
    }

    if (!customer_id) {
      return res.status(400).json({ message: "Debes seleccionar un cliente" });
    }

    await client.query("BEGIN");

    // ✅ Estado de pago según tipo de venta
    const pStatus = (sale_type === "online") ? "pending" : "paid";

    const saleResult = await client.query(
      `INSERT INTO sales (total, customer_id, sale_type, payment_status)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at`,
      [total, customer_id, sale_type || "fisica", pStatus]
    );

    const saleId = saleResult.rows[0].id;
    const saleDate = saleResult.rows[0].created_at;

    // 🆕 Calcular y aplicar descuentos
    let totalWithDiscounts = 0;

    for (const item of items) {
      // Obtener información del producto y descuentos activos
      const productInfo = await client.query(`
        SELECT 
          p.id,
          p.price,
          p.stock,
          p.category_id,
          
          -- Buscar descuento activo más ventajoso
          (SELECT 
            CASE 
              WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
              WHEN d.type = 'fixed' THEN p.price - d.value
              ELSE p.price
            END
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
               OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND d.active = true
           ORDER BY CASE 
             WHEN d.type = 'percentage' THEN p.price - (p.price * (d.value / 100))
             ELSE p.price - d.value
           END ASC
           LIMIT 1
          ) AS discounted_price,
          
          -- Información del descuento aplicado
          (SELECT d.id
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE ((dt.target_type = 'product' AND dt.target_id = p.id::text)
               OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text))
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND d.active = true
           ORDER BY CASE 
             WHEN d.type = 'percentage' THEN p.price - (p.price * (d.value / 100))
             ELSE p.price - d.value
           END ASC
           LIMIT 1
          ) AS applied_discount_id
          
        FROM products p
        WHERE p.id = $1
      `, [item.id]);

      if (productInfo.rows.length === 0) {
        throw new Error(`Producto no encontrado: ${item.id}`);
      }

      const product = productInfo.rows[0];
      
      // Usar precio con descuento si existe, sino precio normal
      const finalPrice = product.discounted_price || product.price;
      const subtotal = finalPrice * item.quantity;
      totalWithDiscounts += subtotal;

      // Insertar item con precio final (ya con descuento aplicado)
      await client.query(
        `INSERT INTO sale_items (
          sale_id, 
          product_id, 
          quantity, 
          unit_price,
          discount_id,
          original_price
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          saleId, 
          item.id, 
          item.quantity, 
          finalPrice,
          product.applied_discount_id,
          product.price
        ]
      );

      // Reducir stock si es venta física
      if (sale_type === "fisica") {
        const stockResult = await client.query(
          `UPDATE products 
          SET stock = stock - $1 
          WHERE id = $2 AND stock >= $1`,
          [item.quantity, item.id]
        );

        if (stockResult.rowCount === 0) {
          throw new Error(`Stock insuficiente para el producto: ${item.name || item.id}`);
        }
      }
    }

    // 🆕 Actualizar el total de la venta con descuentos aplicados
    await client.query(
      `UPDATE sales SET total = $1 WHERE id = $2`,
      [totalWithDiscounts, saleId]
    );

    // Actualizar total_spent si es venta física
    if (sale_type === "fisica") {
      await client.query(
        `UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2`,
        [totalWithDiscounts, customer_id]
      );
    }

    await client.query("COMMIT");
    
    const discountApplied = totalWithDiscounts < total;
    
    res.status(201).json({ 
      message: sale_type === "online" 
        ? "Pedido registrado. Confirma por WhatsApp para procesar el pago" 
        : "Venta registrada con éxito", 
      saleId,
      orderCode: `AL-${saleId}-${new Date(saleDate).getFullYear()}`,
      paymentStatus: pStatus,
      originalTotal: total,
      finalTotal: totalWithDiscounts,
      discountApplied,
      savings: discountApplied ? (total - totalWithDiscounts) : 0
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE SALE ERROR:", error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
};

// 2. Obtener historial del usuario
exports.getUserSales = async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  try {
    const result = await db.query(
      `SELECT 
        id, 
        total, 
        sale_type, 
        payment_status, 
        created_at,
        CONCAT('AL-', id, '-', EXTRACT(YEAR FROM created_at)) as order_code
      FROM sales 
      WHERE customer_id = $1 
      ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("GET USER SALES ERROR:", error);
    res.status(500).json({ message: "Error al obtener pedidos" });
  }
};

// 3. Estadísticas del usuario
exports.getUserStats = async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  try {
    const summary = await db.query(
      `SELECT 
        COUNT(*) as total_orders, 
        SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END) as total_invested,
        SUM(CASE WHEN payment_status = 'pending' THEN total ELSE 0 END) as pending_amount,
        (SELECT name FROM products WHERE id = (
          SELECT product_id FROM sale_items si 
          JOIN sales s ON s.id = si.sale_id 
          WHERE s.customer_id = $1 GROUP BY product_id ORDER BY SUM(quantity) DESC LIMIT 1
        )) as favorite_product
      FROM sales WHERE customer_id = $1`,
      [userId]
    );

    const chart = await db.query(
      `SELECT 
        TO_CHAR(created_at, 'Mon') as month, 
        SUM(total) as amount 
      FROM sales 
      WHERE customer_id = $1 
        AND created_at > NOW() - INTERVAL '6 months'
        AND payment_status = 'paid'
      GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC`,
      [userId]
    );

    res.json({ summary: summary.rows[0], chart: chart.rows });
  } catch (error) {
    console.error("GET USER STATS ERROR:", error);
    res.status(500).json({ message: "Error al generar estadísticas" });
  }
};

// 4. Obtener detalles de venta por ID (con info de descuentos)
exports.getSaleById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT 
        p.name, 
        si.quantity, 
        si.unit_price,
        si.original_price,
        si.discount_id,
        d.name as discount_name,
        d.type as discount_type,
        d.value as discount_value,
        (
          SELECT url 
          FROM product_images 
          WHERE product_id = p.id 
          ORDER BY id ASC 
          LIMIT 1
        ) as main_image
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      LEFT JOIN discounts d ON si.discount_id = d.id
      WHERE si.sale_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" });
    }

    res.json(result.rows);
  } catch (error) {
    console.error("GET SALE BY ID ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

// 5. Obtener todas las ventas (Admin)
exports.getSales = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id,
        s.total,
        s.sale_type,
        s.payment_status,
        s.created_at,
        u.name as customer_name,
        u.email as customer_email,
        u.phone as customer_phone,
        (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS items_count,
        (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id AND discount_id IS NOT NULL) AS discounted_items,
        CONCAT('AL-', s.id, '-', EXTRACT(YEAR FROM s.created_at)) as order_code
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
      ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("GET SALES ERROR:", error);
    res.status(500).json({ message: "Error al obtener ventas" });
  }
};

// 6. Actualizar estado de pago
exports.updatePaymentStatus = async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const saleInfo = await client.query(
      `SELECT customer_id, total, sale_type FROM sales WHERE id = $1`,
      [id]
    );

    if (saleInfo.rows.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" });
    }

    const { customer_id, total, sale_type } = saleInfo.rows[0];

    await client.query(
      `UPDATE sales SET payment_status = $1 WHERE id = $2`,
      [payment_status, id]
    );

    if (payment_status === "paid" && sale_type === "online") {
      const items = await client.query(
        `SELECT product_id, quantity FROM sale_items WHERE sale_id = $1`,
        [id]
      );

      for (const item of items.rows) {
        const stockResult = await client.query(
          `UPDATE products 
          SET stock = stock - $1 
          WHERE id = $2 AND stock >= $1`,
          [item.quantity, item.product_id]
        );

        if (stockResult.rowCount === 0) {
          throw new Error(`Stock insuficiente para procesar el pedido`);
        }
      }

      await client.query(
        `UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2`,
        [total, customer_id]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Estado actualizado correctamente" });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("UPDATE PAYMENT STATUS ERROR:", error);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
};

module.exports = exports;