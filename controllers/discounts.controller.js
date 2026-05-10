// controllers/discounts.controller.js
const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

const isSA = (req) => req.user?.roles?.includes("superadmin");

// Helper: verifica que el descuento le pertenezca al admin que lo pide
const assertDiscountOwnership = async (discountId, adminId, superAdmin) => {
  if (superAdmin) return true;
  const res = await db.query(
    "SELECT id FROM discounts WHERE id = $1 AND owner_admin_id = $2",
    [discountId, adminId]
  );
  return res.rowCount > 0;
};

// ============================================
// ➕ CREAR DESCUENTO
// ============================================
exports.create = async (req, res) => {
  const { name, type, value, starts_at, ends_at, targets } = req.body;
  const ownerAdminId = isSA(req) ? null : req.user.id;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const discountRes = await client.query(
      `INSERT INTO discounts (name, type, value, starts_at, ends_at, created_by, owner_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, type, value, starts_at, ends_at, req.user.id, ownerAdminId]
    );

    const discount = discountRes.rows[0];

    if (targets?.length > 0) {
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

// ============================================
// 📋 OBTENER TODOS LOS DESCUENTOS
// ============================================
exports.getAll = async (req, res) => {
  try {
    const tenantClause = isSA(req) ? "" : "WHERE d.owner_admin_id = $1";
    const params       = isSA(req) ? [] : [req.user.id];

    const result = await db.query(`
      SELECT d.*,
        (SELECT json_agg(dt) FROM discount_targets dt WHERE dt.discount_id = d.id) as targets
      FROM discounts d
      ${tenantClause}
      ORDER BY d.created_at DESC
    `, params);

    res.json(result.rows);
  } catch (error) {
    console.error("DISCOUNT GET ALL ERROR:", error);
    res.status(500).json({ message: "Error al obtener descuentos" });
  }
};

// ============================================
// ✏️ ACTUALIZAR DESCUENTO
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, type, value, starts_at, ends_at, targets } = req.body;

  const client = await db.connect();
  try {
    const owned = await assertDiscountOwnership(id, req.user.id, isSA(req));
    if (!owned) {
      const exists = await db.query("SELECT id FROM discounts WHERE id = $1", [id]);
      return exists.rowCount
        ? res.status(403).json({ message: "No tienes permisos sobre este descuento" })
        : res.status(404).json({ message: "Descuento no encontrado" });
    }

    await client.query("BEGIN");

    const updateRes = await client.query(
      `UPDATE discounts
       SET name=$1, type=$2, value=$3, starts_at=$4, ends_at=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [name, type, value, starts_at, ends_at, id]
    );

    await client.query("DELETE FROM discount_targets WHERE discount_id = $1", [id]);

    if (targets?.length > 0) {
      for (const target of targets) {
        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES ($1, $2, $3)`,
          [id, target.target_type, target.target_id]
        );
      }
    }

    await client.query("COMMIT");
    emitDataUpdate("discounts", "updated", { ...updateRes.rows[0], targets: targets || [] });

    res.json({ message: "Descuento actualizado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DISCOUNT UPDATE ERROR:", error);
    res.status(500).json({ message: "Error al actualizar" });
  } finally {
    client.release();
  }
};

// ============================================
// 🗑️ ELIMINAR DESCUENTO
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;
  try {
    const owned = await assertDiscountOwnership(id, req.user.id, isSA(req));
    if (!owned) {
      const exists = await db.query("SELECT id FROM discounts WHERE id = $1", [id]);
      return exists.rowCount
        ? res.status(403).json({ message: "No tienes permisos sobre este descuento" })
        : res.status(404).json({ message: "Descuento no encontrado" });
    }

    await db.query("DELETE FROM discounts WHERE id = $1", [id]);
    emitDataUpdate("discounts", "deleted", { id: parseInt(id) });

    res.json({ message: "Descuento eliminado" });
  } catch (error) {
    console.error("DISCOUNT REMOVE ERROR:", error);
    res.status(500).json({ message: "Error al eliminar" });
  }
};

// ============================================
// 🔄 TOGGLE ACTIVO / INACTIVO
// ============================================
exports.toggleActive = async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== "boolean") {
    return res.status(400).json({ message: "is_active debe ser un booleano" });
  }

  try {
    const owned = await assertDiscountOwnership(id, req.user.id, isSA(req));
    if (!owned) {
      return res.status(403).json({ message: "No tienes permisos sobre este descuento" });
    }

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