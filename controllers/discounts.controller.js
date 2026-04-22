const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

// Crear un nuevo descuento
exports.create = async (req, res) => {
  const { name, type, value, starts_at, ends_at, targets } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const discountRes = await client.query(
      `INSERT INTO discounts (name, type, value, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, type, value, starts_at, ends_at]
    );

    const discount = discountRes.rows[0];

    if (targets && targets.length > 0) {
      for (const target of targets) {
        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES ($1, $2, $3)`,
          [discount.id, target.target_type, target.target_id]
        );
      }
    }

    await client.query("COMMIT");

    emitDataUpdate("discounts", "created", { ...discount, targets: targets || [] });

    res.status(201).json({ id: discount.id, message: "Descuento creado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DISCOUNT CREATE ERROR:", error);
    res.status(500).json({ message: "Error al crear el descuento" });
  } finally {
    client.release();
  }
};

// Obtener todos los descuentos
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

    emitDataUpdate("discounts", "deleted", { id: parseInt(id) });

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

    const updateRes = await client.query(
      `UPDATE discounts SET name=$1, type=$2, value=$3, starts_at=$4, ends_at=$5
       WHERE id=$6 RETURNING *`,
      [name, type, value, starts_at, ends_at, id]
    );

    await client.query("DELETE FROM discount_targets WHERE discount_id = $1", [id]);

    if (targets && targets.length > 0) {
      for (const target of targets) {
        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES ($1, $2, $3)`,
          [id, target.target_type, target.target_id]
        );
      }
    }

    await client.query("COMMIT");

    emitDataUpdate("discounts", "updated", {
      ...updateRes.rows[0],
      targets: targets || [],
    });

    res.json({ message: "Descuento actualizado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DISCOUNT UPDATE ERROR:", error);
    res.status(500).json({ message: "Error al actualizar" });
  } finally {
    client.release();
  }
};

// Toggle activo/inactivo
exports.toggleActive = async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== "boolean") {
    return res.status(400).json({ message: "is_active debe ser un booleano" });
  }

  try {
    const result = await db.query(
      `UPDATE discounts SET active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, active`,
      [is_active, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    emitDataUpdate("discounts", "updated", result.rows[0]);

    res.json({ id: result.rows[0].id, active: result.rows[0].active });
  } catch (error) {
    console.error("DISCOUNT TOGGLE ERROR:", error);
    res.status(500).json({ message: "Error al actualizar el estado" });
  }
};