const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, email, cedula, phone, city, address, total_spent
      FROM users
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// 2. AGREGAR ESTA NUEVA FUNCIÓN
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address } = req.body;

  try {
    const result = await db.query(
      `
      UPDATE users 
      SET name = $1, email = $2, phone = $3, cedula = $4, city = $5, address = $6
      WHERE id = $7
      RETURNING *
      `,
      [name, email, phone, cedula, city, address, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("UPDATE USER ERROR:", error);
    if (error.code === "23505") { // Código de duplicado en Postgres
      return res.status(409).json({ message: "Email o cédula ya en uso por otro usuario" });
    }
    res.status(500).json({ message: "Error actualizando usuario" });
  }
};

// Crear usuario
exports.createUser = async (req, res) => {
  const { email, password, name, phone, cedula, city, address, role_id, permissions } = req.body;
  const client = await db.connect(); // Usamos client para transacciones

  try {
    await client.query('BEGIN'); // Inicia la transacción

    const passwordToHash = password || cedula || "123456";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    // 1. Crear el usuario
    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email, hashedPassword, name, phone, cedula, city, address]
    );
    const userId = userRes.rows[0].id;

    // 2. Asignar el Rol seleccionado (Admin o Cliente)
    // role_id vendrá del modal del Frontend
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [userId, role_id]
    );

    // 3. SI es Admin y enviamos permisos, los guardamos en una tabla de permisos por usuario
    // NOTA: Es mejor tener una tabla 'user_specific_permissions' o asignar los permisos al ROL.
    // Si quieres que ese admin TENGA esos permisos específicos:
    if (permissions && permissions.length > 0) {
      for (const permId of permissions) {
        await client.query(
          "INSERT INTO user_permissions (user_id, permission_id) VALUES ($1, $2)",
          [userId, permId]
        );
      }
    }

    await client.query('COMMIT'); // Guarda todos los cambios
    res.status(201).json({ id: userId, email, name });

  } catch (error) {
    await client.query('ROLLBACK'); // Cancela todo si hay error
    console.error("CREATE USER ERROR:", error);
    res.status(500).json({ message: "Error al crear usuario con permisos" });
  } finally {
    client.release();
  }
};

exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query("DELETE FROM users WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }
    res.json({ message: "Usuario eliminado correctamente" });
  } catch (error) {
    console.error("DELETE USER ERROR:", error);
    res.status(500).json({ message: "Error al eliminar usuario" });
  }
};
exports.assignRole = async (req, res) => {
  // Tu lógica aquí
  res.json({ message: "Función assignRole pendiente de implementación" });
};