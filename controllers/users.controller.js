const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.*, 
        ur.role_id,
        (SELECT json_agg(json_build_object('id', p.id)) 
         FROM user_permissions up 
         JOIN permissions p ON up.permission_id = p.id 
         WHERE up.user_id = u.id) as permissions
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      ORDER BY u.id DESC
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
  const { name, email, phone, cedula, city, address, role_id, permissions, password } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Actualizar datos básicos del usuario
    await client.query(
      `UPDATE users 
       SET name = $1, email = $2, phone = $3, cedula = $4, city = $5, address = $6
       WHERE id = $7`,
      [name, email, phone, cedula, city, address, id]
    );

    // 2. Actualizar contraseña solo si se envió una nueva
    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, id]);
    }

    // 3. Actualizar Rol
    await client.query(
      "UPDATE user_roles SET role_id = $1 WHERE user_id = $2",
      [role_id, id]
    );

    // 4. Actualizar Permisos (Limpiar y volver a insertar)
    // Primero eliminamos los permisos actuales
    await client.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);

    // Insertamos los nuevos permisos sin duplicar
    if (permissions && permissions.length > 0) {
      const insertPromises = permissions.map((permId) => {
        return client.query(
          `INSERT INTO user_permissions (user_id, permission_id)
           VALUES ($1, $2) 
           ON CONFLICT (user_id, permission_id) DO NOTHING`, // Evitar duplicados
          [id, permId]
        );
      });

      await Promise.all(insertPromises); // Ejecutar todas las inserciones
    }

    await client.query('COMMIT');
    res.json({ message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("UPDATE USER ERROR:", error);
    res.status(500).json({ message: "Error actualizando usuario y permisos" });
  } finally {
    client.release();
  }
};


// Crear usuario
exports.createUser = async (req, res) => {
  const { 
    email, password, name, phone, cedula, city, address, 
    role_id = 3, // ⚠️ CAMBIADO A 23 (según tu tabla de Neon)
    permissions = [] 
  } = req.body;

  console.log("DEBUG: Recibiendo permisos ->", permissions); // Ver en consola de Render

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Crear el usuario
    const passwordToHash = password || cedula || "123456";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email || null, hashedPassword, name, phone || null, cedula, city || null, address || null]
    );
    const userId = userRes.rows[0].id;

    // 2. Asignar el Rol
    // Validamos que el rol exista para dar un error claro
    const roleExists = await client.query("SELECT id FROM roles WHERE id = $1", [role_id]);
    if (roleExists.rowCount === 0) {
        throw new Error(`El rol ID ${role_id} no existe en la base de datos.`);
    }

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [userId, role_id]
    );

    // 3. Asignar permisos
    // Importante: Asegurarnos de que permId sea un número
    if (Array.isArray(permissions) && permissions.length > 0) {
      console.log(`DEBUG: Insertando ${permissions.length} permisos para usuario ${userId}`);
      
      for (const permId of permissions) {
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, permission_id) DO NOTHING`,
          [userId, permId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ message: "Usuario y permisos creados", id: userId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ ERROR EN CREATE USER:", error.message);
    res.status(500).json({ message: "Error en el servidor", error: error.message });
  } finally {
    client.release();
  }
};


exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect(); // Usar connect() para transacciones

  try {
    await client.query('BEGIN');

    // 1. Eliminar de user_permissions
    await client.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);

    // 2. Eliminar de user_roles (ESTO ES LO QUE TE FALTA)
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    // 3. Eliminar el usuario
    const result = await client.query("DELETE FROM users WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    await client.query('COMMIT');
    res.json({ message: "Usuario eliminado correctamente" });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("DELETE USER ERROR:", error);
    
    // Si el error persiste, es que hay otra tabla (ej. ventas) conectada
    res.status(500).json({ 
      message: "No se puede eliminar: el usuario tiene registros vinculados (ventas, gastos, etc.)",
      error: error.message 
    });
  } finally {
    client.release();
  }
};
