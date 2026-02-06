const db = require("../config/db");

// Crear un nuevo descuento
exports.create = async (req, res) => {
  const { name, type, value, starts_at, ends_at, targets } = req.body; 
  // targets debe ser un array: [{ target_type: 'product', target_id: '1' }]

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const discountRes = await client.query(
      `INSERT INTO discounts (name, type, value, starts_at, ends_at) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, type, value, starts_at, ends_at]
    );

    const discountId = discountRes.rows[0].id;

    if (targets && targets.length > 0) {
      const targetQuery = `INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES ($1, $2, $3)`;
      for (const target of targets) {
        await client.query(targetQuery, [discountId, target.target_type, target.target_id]);
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ id: discountId, message: "Descuento creado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DISCOUNT CREATE ERROR:", error);
    res.status(500).json({ message: "Error al crear el descuento" });
  } finally {
    client.release();
  }
};

// Obtener todos los descuentos activos
exports.getAll = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT d.*, 
      (SELECT json_agg(dt) FROM discount_targets dt WHERE dt.discount_id = d.id) as targets
      FROM discounts d 
      ORDER BY d.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener descuentos" });
  }
};

// Eliminar descuento
exports.remove = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM discounts WHERE id = $1", [id]);
    res.json({ message: "Descuento eliminado" });
  } catch (error) {
    res.status(500).json({ message: "Error al eliminar" });
  }
};

// Actualizar descuento
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, type, value, starts_at, ends_at, targets } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Actualizar datos básicos
    await client.query(
      `UPDATE discounts SET name = $1, type = $2, value = $3, starts_at = $4, ends_at = $5 
       WHERE id = $6`,
      [name, type, value, starts_at, ends_at, id]
    );

    // 2. Limpiar targets antiguos y poner los nuevos
    await client.query("DELETE FROM discount_targets WHERE discount_id = $1", [id]);

    if (targets && targets.length > 0) {
      const targetQuery = `INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES ($1, $2, $3)`;
      for (const target of targets) {
        await client.query(targetQuery, [id, target.target_type, target.target_id]);
      }
    }

    await client.query("COMMIT");
    res.json({ message: "Descuento actualizado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DISCOUNT UPDATE ERROR:", error);
    res.status(500).json({ message: "Error al actualizar" });
  } finally {
    client.release();
  }
};