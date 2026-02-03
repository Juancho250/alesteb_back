const db = require("../config/db");
const bcrypt = require("bcrypt");

const BCRYPT_ROUNDS = 12; // balance seguridad / rendimiento

// ===============================
// 1. OBTENER USUARIOS (ADMIN)
// ===============================

exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.phone,
         u.cedula,
         u.city,
         u.address,
         ur.role_id,
         r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles      r  ON ur.role_id = r.id
      ORDER BY u.id DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// ===============================
// 2. CREAR USUARIO (ADMIN)
// ===============================
// Cambios respecto a versión anterior:
//   - Contraseña por defecto es un string aleatorio seguro, NUNCA el cedula.
//   - Se retorna un flag `requiresPasswordChange` para que el frontend lo indique.
//   - Validación de rol antes de hash.

exports.createUser = async (req, res) => {
  const { email, password, name, phone, cedula, city, address, role_id = 3 } = req.body;

  // ─── Validaciones básicas ────────────────────────────────────────
  if (!email || !name) {
    return res.status(400).json({ message: "Email y nombre son obligatorios" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verificar que el rol existe
    const roleCheck = await client.query("SELECT id FROM roles WHERE id = $1", [role_id]);
    if (roleCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "El rol especificado no existe" });
    }

    // Verificar email único ANTES del insert (respuesta clara al admin)
    const emailCheck = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    if (emailCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "El email ya está registrado" });
    }

    // ─── Contraseña segura ─────────────────────────────────────────
    // Si el admin no envió contraseña, generar una temporal aleatoria.
    // El usuario deberá cambiarla en su primer login.
    let requiresPasswordChange = false;
    let rawPassword = password;

    if (!password || password.trim() === "") {
      rawPassword = generateTempPassword();
      requiresPasswordChange = true;
    }

    const hashedPassword = await bcrypt.hash(rawPassword, BCRYPT_ROUNDS);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address, is_verified, requires_password_change)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
       RETURNING id, email, name, phone, cedula, city, address`,
      [
        email.toLowerCase().trim(),
        hashedPassword,
        name,
        phone || null,
        cedula || null,
        city || null,
        address || null,
        requiresPasswordChange,
      ]
    );
    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [newUser.id, role_id]
    );

    await client.query("COMMIT");

    // Solo retornar la contraseña temporal UNA VEZ (nunca la guardar en plain-text)
    res.status(201).json({
      message: "Usuario creado con éxito",
      user: { ...newUser, role_id },
      ...(requiresPasswordChange && {
        temporaryPassword: rawPassword,
        note: "Mostrar esta contraseña temporal al usuario. Se invalidará al cambiarla.",
      }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CREATE USER ERROR:", error);

    // Captura fallback para unique violation (por si la validación previa falla por race condition)
    if (error.code === "23505") {
      return res.status(409).json({ message: "El email ya está registrado" });
    }

    res.status(500).json({ message: "Error al crear usuario" });
  } finally {
    client.release();
  }
};

// ===============================
// 3. ACTUALIZAR USUARIO (ADMIN)
// ===============================

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, role_id, password } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verificar que el usuario existe
    const userCheck = await client.query("SELECT id FROM users WHERE id = $1", [id]);
    if (userCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    // Si se cambia el email, verificar unicidad excluyendo al mismo usuario
    if (email) {
      const emailCheck = await client.query(
        "SELECT id FROM users WHERE email = $1 AND id != $2",
        [email.toLowerCase().trim(), id]
      );
      if (emailCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "El email ya está en uso por otro usuario" });
      }
    }

    await client.query(
      `UPDATE users
         SET name    = COALESCE($1, name),
             email   = COALESCE($2, email),
             phone   = COALESCE($3, phone),
             cedula  = COALESCE($4, cedula),
             city    = COALESCE($5, city),
             address = COALESCE($6, address)
        WHERE id = $7`,
      [name || null, email ? email.toLowerCase().trim() : null, phone || null, cedula || null, city || null, address || null, id]
    );

    // Cambiar contraseña solo si se envió y no está vacía
    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, id]);
    }

    // Actualizar rol solo si se envió
    if (role_id !== undefined && role_id !== null) {
      const roleCheck = await client.query("SELECT id FROM roles WHERE id = $1", [role_id]);
      if (roleCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "El rol especificado no existe" });
      }
      await client.query(
        "UPDATE user_roles SET role_id = $1 WHERE user_id = $2",
        [role_id, id]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("UPDATE USER ERROR:", error);
    res.status(500).json({ message: "Error actualizando usuario" });
  } finally {
    client.release();
  }
};

// ===============================
// 4. ELIMINAR USUARIO (ADMIN)
// ===============================
// Problema original: si el usuario tiene ventas, el DELETE falla por FK.
// Solución: verificar dependencias primero y retornar error descriptivo.
// Si en futuro quieren soft-delete, cambiar a SET deleted_at = NOW().

exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Verificar que existe
    const userCheck = await client.query("SELECT id FROM users WHERE id = $1", [id]);
    if (userCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    // ─── Verificar dependencias antes de intentar borrar ─────────
    const salesCount = await client.query(
      "SELECT COUNT(*) AS cnt FROM sales WHERE customer_id = $1",
      [id]
    );

    if (parseInt(salesCount.rows[0].cnt, 10) > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "No se puede eliminar el usuario porque tiene ventas asociadas. Considere usar soft-delete.",
        salesCount: parseInt(salesCount.rows[0].cnt, 10),
      });
    }

    // Eliminar rol → usuario (orden por FK)
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    await client.query("DELETE FROM users WHERE id = $1", [id]);

    await client.query("COMMIT");
    res.json({ message: "Usuario eliminado con éxito" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DELETE USER ERROR:", error);
    res.status(500).json({ message: "No se pudo eliminar el usuario" });
  } finally {
    client.release();
  }
};

// ===============================
// HELPER: generar contraseña temporal
// ===============================
// Genera un string aleatorio de 12 caracteres alfanuméricos.
// Nunca usa datos del usuario (cedula, email, etc.).

function generateTempPassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  let result = "";
  // Se usa crypto para entropía real si está disponible
  const crypto = require("crypto");
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}