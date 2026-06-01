// controllers/discounts.controller.js
const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

// Helper: verifica ownership usando req.isSuperAdmin / req.adminId
// (adminScope ya corrió, así que siempre están definidos)
const assertDiscountOwnership = async (discountId, adminId, isSuperAdmin) => {
  if (isSuperAdmin) return true;
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
  const { name, type, value, starts_at, ends_at, targets, code, description, scope = 'all' } = req.body;
  const { isSuperAdmin, adminId } = req;

  // ✅ FIX: superadmin también necesita owner_admin_id para que la API pública funcione
  // Si isSuperAdmin, usamos adminId igualmente (el admin del tenant que está activo)
  const ownerAdminId = adminId; // ← ya no null para nadie

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const discountRes = await client.query(
      `INSERT INTO discounts 
        (name, type, value, starts_at, ends_at, code, description, created_by, owner_admin_id, scope)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [name, type, value, starts_at, ends_at,
      code ? code.toUpperCase().trim() : null,
      description || null,
      req.user.id, ownerAdminId, scope]
    );

    const discount = discountRes.rows[0];

    if (targets?.length > 0) {
      for (const target of targets) {
        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id)
           VALUES ($1, $2, $3)`,
          [discount.id, target.target_type, target.target_id]
        );
      }
    }

    await client.query("COMMIT");
    emitDataUpdate("discounts", "created", { ...discount, targets: targets || [] }, req.adminId);
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
// 📋 OBTENER TODOS
// ============================================
exports.getAll = async (req, res) => {
  const { isSuperAdmin, adminId } = req;

  const tenantClause = isSuperAdmin ? "" : "WHERE d.owner_admin_id = $1";
  const params       = isSuperAdmin ? [] : [adminId];

  try {
    const result = await db.query(`
      SELECT 
        d.*,
        -- ✅ incluir estos campos que usa la API pública:
        d.code,
        d.description,
        d.min_purchase_amount,
        d.max_discount_amount,
        d.usage_limit,
        d.times_used,
        (SELECT json_agg(dt)
         FROM discount_targets dt
         WHERE dt.discount_id = d.id) AS targets
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
// ✏️ ACTUALIZAR
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, type, value, starts_at, ends_at, targets, scope } = req.body;
  const { isSuperAdmin, adminId } = req;

  const client = await db.connect();
  try {
    const owned = await assertDiscountOwnership(id, adminId, isSuperAdmin);
    if (!owned) {
      const exists = await db.query("SELECT id FROM discounts WHERE id = $1", [id]);
      return exists.rowCount
        ? res.status(403).json({ message: "No tienes permisos sobre este descuento" })
        : res.status(404).json({ message: "Descuento no encontrado" });
    }

    await client.query("BEGIN");

    const updateRes = await client.query(
      `UPDATE discounts
      SET name=$1, type=$2, value=$3, starts_at=$4, ends_at=$5,
          scope=COALESCE($6, scope), updated_at=NOW()
      WHERE id=$7 RETURNING *`,
      [name, type, value, starts_at, ends_at, scope || null, id]
    );

    await client.query("DELETE FROM discount_targets WHERE discount_id = $1", [id]);

    if (targets?.length > 0) {
      for (const target of targets) {
        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id)
           VALUES ($1, $2, $3)`,
          [id, target.target_type, target.target_id]
        );
      }
    }

    await client.query("COMMIT");
    emitDataUpdate("discounts", "updated", { ...updateRes.rows[0], targets: targets || [] }, req.adminId);
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
// 🗑️ ELIMINAR
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;
  const { isSuperAdmin, adminId } = req;

  try {
    const owned = await assertDiscountOwnership(id, adminId, isSuperAdmin);
    if (!owned) {
      const exists = await db.query("SELECT id FROM discounts WHERE id = $1", [id]);
      return exists.rowCount
        ? res.status(403).json({ message: "No tienes permisos sobre este descuento" })
        : res.status(404).json({ message: "Descuento no encontrado" });
    }

    await db.query("DELETE FROM discounts WHERE id = $1", [id]);
    emitDataUpdate("discounts", "deleted", { id: parseInt(id) }, req.adminId);
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
  const { isSuperAdmin, adminId } = req;

  if (typeof is_active !== "boolean") {
    return res.status(400).json({ message: "is_active debe ser un booleano" });
  }

  try {
    const owned = await assertDiscountOwnership(id, adminId, isSuperAdmin);
    if (!owned) {
      const exists = await db.query("SELECT id FROM discounts WHERE id = $1", [id]);
      return exists.rowCount
        ? res.status(403).json({ message: "No tienes permisos sobre este descuento" })
        : res.status(404).json({ message: "Descuento no encontrado" });
    }

    const result = await db.query(
      `UPDATE discounts SET active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, active`,
      [is_active, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    emitDataUpdate("discounts", "updated", result.rows[0], req.adminId);
    res.json({ id: result.rows[0].id, active: result.rows[0].active });
  } catch (error) {
    console.error("DISCOUNT TOGGLE ERROR:", error);
    res.status(500).json({ message: "Error al actualizar el estado" });
  }
};