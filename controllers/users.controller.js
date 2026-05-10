// controllers/users.controller.js
// Los admins gestionan usuarios con rol 'user' (no otros admins)
const db     = require("../config/db");
const bcrypt = require("bcryptjs");
const { emitDataUpdate } = require("../config/socket");

// ============================================
// 📋 OBTENER USUARIOS (solo rol 'user', no admins)
// ============================================
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        u.id, u.email, u.name, u.phone, u.cedula, u.city, u.address,
        u.is_active, u.is_verified, u.created_at, u.last_login,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'user' OR r.id IS NULL
      GROUP BY u.id
      HAVING NOT EXISTS (
        SELECT 1 FROM user_roles ur2
        JOIN roles r2 ON r2.id = ur2.role_id
        WHERE ur2.user_id = u.id AND r2.name IN ('admin', 'superadmin')
      )
      ORDER BY u.id DESC
    `);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[GET USERS ERROR]", error);
    res.status(500).json({ success: false, message: "Error al obtener usuarios" });
  }
};

// ============================================
// ➕ CREAR USUARIO (con rol 'user' obligatorio)
// ============================================
exports.createUser = async (req, res) => {
  const { email, password, name, phone, cedula, city, address } = req.body;
  const client = await db.connect();

  try {
    if (!name || !cedula) {
      return res.status(400).json({ success: false, message: "Nombre y cédula son requeridos" });
    }

    await client.query("BEGIN");

    // Obtener role_id del rol 'user' (ID=3 por convención, pero consultamos para seguridad)
    const roleRes = await client.query("SELECT id FROM roles WHERE name = 'user' LIMIT 1");
    if (roleRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: "Rol 'user' no configurado en la BD" });
    }
    const userRoleId = roleRes.rows[0].id;

    const passwordToHash = password?.trim() || cedula || "Alesteb2024!";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)
       RETURNING id, name, email, cedula`,
      [email?.toLowerCase().trim() || null, hashedPassword, name.trim(), phone || null,
       cedula.trim(), city || null, address || null]
    );

    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [newUser.id, userRoleId]
    );

    await client.query("COMMIT");

    emitDataUpdate("users", "created", { id: newUser.id, name: newUser.name });

    res.status(201).json({
      success: true,
      message: "Usuario creado correctamente",
      data: { id: newUser.id, name: newUser.name, email: newUser.email },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    let message = "Error al crear usuario";
    if (error.code === "23505") {
      if (error.constraint === "users_email_key")   message = "El email ya está registrado";
      if (error.constraint === "users_cedula_key")  message = "La cédula ya está registrada";
    }
    console.error("[CREATE USER ERROR]", error);
    res.status(500).json({ success: false, message });
  } finally {
    client.release();
  }
};

// ============================================
// ✏️ ACTUALIZAR USUARIO
// ============================================
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, password, is_active } = req.body;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Asegurarse de que no se edita un admin/superadmin
    const roleCheck = await client.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id]
    );
    const roles = roleCheck.rows.map((r) => r.name);
    if (roles.includes("admin") || roles.includes("superadmin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No puedes editar admins o superadmins desde este panel",
        code: "FORBIDDEN_ROLE",
      });
    }

    await client.query(
      `UPDATE users SET name=$1, email=$2, phone=$3, cedula=$4, city=$5, address=$6,
       is_active=COALESCE($7, is_active), updated_at=NOW() WHERE id=$8`,
      [name, email?.toLowerCase().trim() || null, phone || null, cedula, city || null, address || null, is_active, id]
    );

    if (password?.trim()) {
      const hashed = await bcrypt.hash(password, 10);
      await client.query("UPDATE users SET password=$1 WHERE id=$2", [hashed, id]);
    }

    await client.query("COMMIT");

    emitDataUpdate("users", "updated", { id: parseInt(id) });

    res.json({ success: true, message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE USER ERROR]", error);
    res.status(500).json({ success: false, message: "Error al actualizar usuario", error: error.message });
  } finally {
    client.release();
  }
};

// ============================================
// 🗑️ ELIMINAR USUARIO
// ============================================
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Proteger contra borrado de admins
    const roleCheck = await client.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id]
    );
    const roles = roleCheck.rows.map((r) => r.name);
    if (roles.includes("admin") || roles.includes("superadmin")) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "No puedes eliminar admins desde este panel",
        code: "FORBIDDEN_ROLE",
      });
    }

    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    const result = await client.query("DELETE FROM users WHERE id=$1 RETURNING id", [id]);

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    await client.query("COMMIT");

    emitDataUpdate("users", "deleted", { id: parseInt(id) });

    res.json({ success: true, message: "Usuario eliminado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE USER ERROR]", error);
    const message = error.code === "23503"
      ? "No se puede eliminar: el usuario tiene ventas asociadas. Desactívalo en su lugar."
      : "No se puede eliminar: el usuario tiene registros vinculados";
    res.status(500).json({ success: false, message, error: error.message });
  } finally {
    client.release();
  }
};