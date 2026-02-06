const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios con roles y permisos
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.*,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object('id', r.id, 'name', r.name)
          ) FILTER (WHERE r.id IS NOT NULL), 
          '[]'
        ) as roles,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name)
          ) FILTER (WHERE p.id IS NOT NULL),
          '[]'
        ) as permissions
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      LEFT JOIN user_permissions up ON u.id = up.user_id
      LEFT JOIN permissions p ON up.permission_id = p.id
      GROUP BY u.id
      ORDER BY u.id DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// Actualizar usuario
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, role_id, permissions, password } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Actualizar datos básicos
    await client.query(
      `UPDATE users 
       SET name = $1, email = $2, phone = $3, cedula = $4, city = $5, address = $6
       WHERE id = $7`,
      [name, email, phone, cedula, city, address, id]
    );

    // 2. Actualizar contraseña si se envió
    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, id]);
    }

    // 3. Actualizar Rol (eliminar existentes y crear nuevo)
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    if (role_id) {
      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
        [id, role_id]
      );
    }

    // 4. Actualizar Permisos
    await client.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);
    if (permissions && permissions.length > 0) {
      const insertPromises = permissions.map((permId) =>
        client.query(
          "INSERT INTO user_permissions (user_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [id, permId]
        )
      );
      await Promise.all(insertPromises);
    }

    await client.query('COMMIT');
    res.json({ message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("UPDATE USER ERROR:", error);
    res.status(500).json({ message: "Error al actualizar usuario" });
  } finally {
    client.release();
  }
};

// Crear usuario
exports.createUser = async (req, res) => {
  const { 
    email, password, name, phone, cedula, city, address, 
    role_id = 3, 
    permissions = [] 
  } = req.body;

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Crear usuario
    const passwordToHash = password || cedula || "123456";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email || null, hashedPassword, name, phone || null, cedula, city || null, address || null]
    );
    const userId = userRes.rows[0].id;

    // 2. Asignar rol
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [userId, role_id]
    );

    // 3. Asignar permisos individuales
    if (Array.isArray(permissions) && permissions.length > 0) {
      for (const permId of permissions) {
        await client.query(
          "INSERT INTO user_permissions (user_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [userId, permId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ message: "Usuario creado correctamente", id: userId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("CREATE USER ERROR:", error);
    res.status(500).json({ message: "Error al crear usuario", error: error.message });
  } finally {
    client.release();
  }
};

// Eliminar usuario
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Eliminar relaciones
    await client.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    // Eliminar usuario
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
    res.status(500).json({ 
      message: "No se puede eliminar: el usuario tiene registros vinculados",
      error: error.message 
    });
  } finally {
    client.release();
  }
};