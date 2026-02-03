const db = require("../config/db");

// ===============================
// CREAR VENTA CON PROTECCIONES
// ===============================
// Flujo:
//   1. Validar body.
//   2. BEGIN transacción.
//   3. Por cada item: FOR UPDATE → calcular precio con descuento → validar stock → insertar sale_item → descontar stock si física.
//   4. Comparar total calculado vs enviado (anti-manipulación).
//   5. Escribir total final en sales.
//   6. Actualizar total_spent del usuario si aplica.
//   7. COMMIT o ROLLBACK.

exports.createSale = async (req, res) => {
  const { items, total, sale_type, customer_id } = req.body;
  const client = await db.connect();

  try {
    // ─── Validaciones de entrada ──────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "La venta debe tener al menos un producto" });
    }
    if (!customer_id) {
      return res.status(400).json({ message: "Debes seleccionar un cliente" });
    }
    if (typeof total !== "number" || total < 0) {
      return res.status(400).json({ message: "El total enviado es inválido" });
    }

    // ─── Ownership: solo el propio usuario o un admin puede crear la venta ─
    if (req.user.role !== "admin" && req.user.role !== "super_admin") {
      if (req.user.id !== customer_id) {
        return res.status(403).json({ message: "No puedes crear ventas para otros usuarios" });
      }
    }

    // ─── Verificar que el cliente existe ──────────────────────────
    const customerCheck = await db.query("SELECT id FROM users WHERE id = $1", [customer_id]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    await client.query("BEGIN");

    const saleType = sale_type || "fisica";
    const pStatus = saleType === "online" ? "pending" : "paid";

    // Crear registro de venta con total provisional (0); se actualiza al final.
    const saleResult = await client.query(
      `INSERT INTO sales (total, customer_id, sale_type, payment_status, created_at)
       VALUES (0, $1, $2, $3, NOW())
       RETURNING id, created_at`,
      [customer_id, saleType, pStatus]
    );

    const saleId = saleResult.rows[0].id;
    const saleDate = saleResult.rows[0].created_at;
    let serverTotal = 0; // acumulador calculado por el servidor

    // ─── Iterar productos ─────────────────────────────────────────
    for (const item of items) {
      if (!item.id || !item.quantity || item.quantity < 1) {
        throw new Error("Cada item debe tener id y quantity > 0");
      }

      // 🔒 FOR UPDATE: bloquea la fila hasta COMMIT/ROLLBACK.
      // También calcula el precio con descuento vigente (el menor).
      const productInfo = await client.query(
        `SELECT
           p.id,
           p.price,
           p.stock,
           p.category_id,

           -- precio con descuento más favorable (menor valor final)
           (SELECT
              CASE
                WHEN d.type = 'percentage' THEN ROUND((p.price - (p.price * (d.value / 100)))::numeric, 2)
                WHEN d.type = 'fixed'      THEN ROUND((p.price - d.value)::numeric, 2)
                ELSE p.price
              END
            FROM discount_targets dt
            JOIN discounts d ON d.id = dt.discount_id
           WHERE (  (dt.target_type = 'product'  AND dt.target_id = p.id::text)
                 OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text) )
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND d.active = true
           ORDER BY CASE
                      WHEN d.type = 'percentage' THEN p.price - (p.price * (d.value / 100))
                      ELSE p.price - d.value
                    END ASC
           LIMIT 1
          ) AS discounted_price,

           -- id del descuento aplicado (mismo criterio)
           (SELECT d.id
            FROM discount_targets dt
            JOIN discounts d ON d.id = dt.discount_id
           WHERE (  (dt.target_type = 'product'  AND dt.target_id = p.id::text)
                 OR (dt.target_type = 'category' AND dt.target_id = p.category_id::text) )
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
        FOR UPDATE`,
        [item.id]
      );

      if (productInfo.rows.length === 0) {
        throw new Error(`Producto no encontrado: ${item.id}`);
      }

      const product = productInfo.rows[0];

      // Validar stock solo para ventas físicas (online se descuenta al confirmar pago)
      if (saleType === "fisica" && product.stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para producto ID ${item.id}. Disponible: ${product.stock}, solicitado: ${item.quantity}`
        );
      }

      const finalPrice = product.discounted_price !== null ? product.discounted_price : product.price;
      const subtotal = parseFloat((finalPrice * item.quantity).toFixed(2));
      serverTotal = parseFloat((serverTotal + subtotal).toFixed(2));

      // Insertar línea de venta
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount_id, original_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, item.id, item.quantity, finalPrice, product.applied_discount_id || null, product.price]
      );

      // Descontar stock inmediatamente solo si es venta física
      if (saleType === "fisica") {
        await client.query(
          `UPDATE products SET stock = stock - $1 WHERE id = $2`,
          [item.quantity, item.id]
        );
      }
    }

    // ─── Anti-manipulación: comparar total del cliente vs servidor ─
    // El total que envió el cliente es un "presupuesto máximo"; si el servidor
    // calcula menos (por descuentos aplicados en tiempo real) está bien.
    // Si el servidor calcula MÁS, el cliente intentó pagar menos → error.
    const TOLERANCE = 0.02; // 2 céntimos por redondeos acumulados
    if (serverTotal - total > TOLERANCE) {
      throw new Error("El total enviado es menor al calculado por el servidor");
    }
    // Si el cliente envió más de lo calculado, usar el valor del servidor
    // (nunca cobrar más de lo que valen los productos)

    // ─── Escribir total final (siempre el valor del servidor) ──────
    await client.query(
      `UPDATE sales SET total = $1 WHERE id = $2`,
      [serverTotal, saleId]
    );

    // ─── Actualizar total_spent solo si pago es inmediato ─────────
    if (saleType === "fisica") {
      await client.query(
        `UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2`,
        [serverTotal, customer_id]
      );
    }

    await client.query("COMMIT");

    // ─── Respuesta ────────────────────────────────────────────────
    const savings = parseFloat((total - serverTotal).toFixed(2));

    res.status(201).json({
      message:
        saleType === "online"
          ? "Pedido registrado. Confirma por WhatsApp para procesar el pago"
          : "Venta registrada con éxito",
      saleId,
      orderCode: `AL-${saleId}-${new Date(saleDate).getFullYear()}`,
      paymentStatus: pStatus,
      finalTotal: serverTotal,
      savings: savings > 0 ? savings : 0,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE SALE ERROR:", error);

    // Errores de negocio → 400; resto → 500
    const isBusinessError =
      error.message.includes("Stock insuficiente") ||
      error.message.includes("no encontrado") ||
      error.message.includes("debe tener") ||
      error.message.includes("total enviado");

    res.status(isBusinessError ? 400 : 500).json({
      message: error.message || "Error al procesar venta",
    });
  } finally {
    client.release();
  }
};

// ===============================
// OBTENER VENTAS DEL USUARIO
// ===============================
// Ruta: GET /api/sales/user/history?userId=X
// La verificación de ownership se hace en el middleware de la ruta.
// El controlador solo ejecuta la query.

exports.getUserSales = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  // Doble verificación en controlador (defensa en profundidad)
  if (req.user.role !== "admin" && req.user.role !== "super_admin") {
    if (parseInt(userId, 10) !== req.user.id) {
      return res.status(403).json({ message: "No autorizado" });
    }
  }

  try {
    const result = await db.query(
      `SELECT
         id,
         total,
         sale_type,
         payment_status,
         created_at,
         CONCAT('AL-', id, '-', EXTRACT(YEAR FROM created_at)) AS order_code
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

// ===============================
// ESTADÍSTICAS DEL USUARIO
// ===============================

exports.getUserStats = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ message: "userId requerido" });
  }

  if (req.user.role !== "admin" && req.user.role !== "super_admin") {
    if (parseInt(userId, 10) !== req.user.id) {
      return res.status(403).json({ message: "No autorizado" });
    }
  }

  try {
    const summary = await db.query(
      `SELECT
         COUNT(*)                                                          AS total_orders,
         COALESCE(SUM(CASE WHEN payment_status = 'paid'    THEN total ELSE 0 END), 0) AS total_invested,
         COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN total ELSE 0 END), 0) AS pending_amount,
         (SELECT p.name
            FROM sale_items si
            JOIN sales      s ON s.id = si.sale_id
            JOIN products   p ON p.id = si.product_id
           WHERE s.customer_id = $1
           GROUP BY si.product_id, p.name
           ORDER BY SUM(si.quantity) DESC
           LIMIT 1
         ) AS favorite_product
       FROM sales
      WHERE customer_id = $1`,
      [userId]
    );

    const chart = await db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
         COALESCE(SUM(total), 0)                          AS amount
       FROM sales
      WHERE customer_id      = $1
        AND created_at       > NOW() - INTERVAL '6 months'
        AND payment_status   = 'paid'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC`,
      [userId]
    );

    res.json({ summary: summary.rows[0], chart: chart.rows });
  } catch (error) {
    console.error("GET USER STATS ERROR:", error);
    res.status(500).json({ message: "Error al generar estadísticas" });
  }
};

// ===============================
// OBTENER DETALLES DE UNA VENTA
// ===============================
// La verificación de ownership se hace en el middleware (checkOwnership('sale')).

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
         d.name  AS discount_name,
         d.type  AS discount_type,
         d.value AS discount_value,
         (SELECT url FROM product_images WHERE product_id = p.id ORDER BY id ASC LIMIT 1) AS main_image
       FROM sale_items si
       JOIN products   p ON p.id = si.product_id
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
    res.status(500).json({ message: "Error al obtener detalle de venta" });
  }
};

// ===============================
// OBTENER TODAS LAS VENTAS (ADMIN)
// ===============================
// Solo accesible por admin (se controla en la ruta).

exports.getSales = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         s.id,
         s.total,
         s.sale_type,
         s.payment_status,
         s.created_at,
         u.name              AS customer_name,
         u.email             AS customer_email,
         u.phone             AS customer_phone,
         (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id)                            AS items_count,
         (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id AND discount_id IS NOT NULL) AS discounted_items,
         CONCAT('AL-', s.id, '-', EXTRACT(YEAR FROM s.created_at))                        AS order_code
       FROM sales s
       LEFT JOIN users u ON s.customer_id = u.id
      ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("GET SALES ERROR:", error);
    res.status(500).json({ message: "Error al obtener ventas" });
  }
};

// ===============================
// ACTUALIZAR ESTADO DE PAGO (ADMIN)
// ===============================
// Solo accesible por admin (se controla en la ruta).
// Flujo online → paid:
//   1. Bloquear fila de la venta (FOR UPDATE).
//   2. Verificar que no se revertió un pago confirmado.
//   3. Si transition es pending → paid: descontar stock y sumar total_spent.
//   4. COMMIT o ROLLBACK.

exports.updatePaymentStatus = async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;

  if (!payment_status || !["pending", "paid", "cancelled"].includes(payment_status)) {
    return res.status(400).json({ message: "Estado de pago inválido" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 🔒 FOR UPDATE en la venta
    const saleInfo = await client.query(
      `SELECT customer_id, total, sale_type, payment_status AS current_status
       FROM sales
      WHERE id = $1
        FOR UPDATE`,
      [id]
    );

    if (saleInfo.rows.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" });
    }

    const { customer_id, total, sale_type, current_status } = saleInfo.rows[0];

    // Regla: nunca revertir paid → pending (prevenir fraude)
    if (current_status === "paid" && payment_status === "pending") {
      return res.status(400).json({ message: "No se puede revertir un pago confirmado" });
    }

    // Si ya está en el estado pedido, retornar sin hacer nada (idempotente)
    if (current_status === payment_status) {
      await client.query("COMMIT");
      return res.json({ message: "Estado actualizado correctamente" });
    }

    await client.query(
      `UPDATE sales SET payment_status = $1 WHERE id = $2`,
      [payment_status, id]
    );

    // ─── Transición pending → paid en ventas online ──────────────
    if (payment_status === "paid" && sale_type === "online" && current_status === "pending") {
      const items = await client.query(
        `SELECT product_id, quantity FROM sale_items WHERE sale_id = $1`,
        [id]
      );

      for (const item of items.rows) {
        // Descontar stock con validación atómica
        const stockResult = await client.query(
          `UPDATE products
             SET stock = stock - $1
            WHERE id = $2 AND stock >= $1`,
          [item.quantity, item.product_id]
        );

        if (stockResult.rowCount === 0) {
          throw new Error(
            `Stock insuficiente para producto ID ${item.product_id} al confirmar pedido`
          );
        }
      }

      // Sumar al historial de gasto del usuario
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

    const isBusinessError = error.message.includes("Stock insuficiente");
    res.status(isBusinessError ? 400 : 500).json({ message: error.message });
  } finally {
    client.release();
  }
};