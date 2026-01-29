const db = require("../config/db");
const bcrypt = require("bcrypt");

// 1. Obtener usuarios
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.name, u.email, u.phone, u.cedula, u.city, u.address, ur.role_id, r.name as role_name
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      ORDER BY u.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// 2. Crear usuario
// 2. Crear usuario
exports.createUser = async (req, res) => {
  const { email, password, name, phone, cedula, city, address, role_id = 3 } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    // ✅ Validar que el role_id existe
    const roleCheck = await client.query("SELECT id FROM roles WHERE id = $1", [role_id]);
    if (roleCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "El rol especificado no existe" });
    }

    const hashedPassword = await bcrypt.hash(password || cedula || "123456", 10);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id, email, name, phone, cedula, city, address`,
      [email, hashedPassword, name, phone, cedula, city, address]
    );
    const newUser = userRes.rows[0];

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [newUser.id, role_id]
    );

    await client.query('COMMIT');
    
    // ✅ Retornar el usuario completo con su role_id
    res.status(201).json({ 
      message: "Usuario creado con éxito", 
      user: { ...newUser, role_id }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("CREATE USER ERROR:", error);
    
    if (error.code === '23505') {
      return res.status(409).json({ message: "El email ya está registrado" });
    }
    
    res.status(500).json({ message: "Error al crear usuario", error: error.message });
  } finally {
    client.release();
  }
};

// 3. Actualizar usuario
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, role_id, password } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE users SET name = $1, email = $2, phone = $3, cedula = $4, city = $5, address = $6 WHERE id = $7`,
      [name, email, phone, cedula, city, address, id]
    );

    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, id]);
    }

    await client.query(
      "UPDATE user_roles SET role_id = $1 WHERE user_id = $2",
      [role_id, id]
    );

    await client.query('COMMIT');
    res.json({ message: "Usuario actualizado correctamente" });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: "Error actualizando usuario" });
  } finally {
    client.release();
  }
};

// 4. ELIMINAR USUARIO (La que faltaba)
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Eliminar primero la relación de roles para evitar error de llave foránea
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    const result = await client.query("DELETE FROM users WHERE id = $1", [id]);
    
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    await client.query('COMMIT');
    res.json({ message: "Usuario eliminado con éxito" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("DELETE ERROR:", error);
    res.status(500).json({ message: "No se pudo eliminar el usuario" });
  } finally {
    client.release();
  }
};