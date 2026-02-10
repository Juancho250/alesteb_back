const db = require("../config/db");
const bcrypt = require("bcrypt");

// ============================================
// 📋 OBTENER USUARIOS CON ROLES (SIN PERMISOS)
// ============================================

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
        ) as roles
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      GROUP BY u.id
      ORDER BY u.id DESC
    `);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener usuarios" 
    });
  }
};

// ============================================
// ✏️ ACTUALIZAR USUARIO
// ============================================

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, cedula, city, address, role_id, password } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Actualizar datos básicos
    await client.query(
      `UPDATE users 
       SET name = $1, email = $2, phone = $3, cedula = $4, city = $5, address = $6, updated_at = NOW()
       WHERE id = $7`,
      [name, email, phone, cedula, city, address, id]
    );

    // 2. Actualizar contraseña si se envió
    if (password && password.trim() !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      await client.query(
        "UPDATE users SET password = $1 WHERE id = $2", 
        [hashedPassword, id]
      );
    }

    // 3. Actualizar Rol (eliminar existentes y crear nuevo)
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    
    if (role_id) {
      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING",
        [id, role_id]
      );
    }

    await client.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Usuario actualizado correctamente" 
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("UPDATE USER ERROR:", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error al actualizar usuario",
      error: error.message 
    });
  } finally {
    client.release();
  }
};

// ============================================
// ➕ CREAR USUARIO
// ============================================

exports.createUser = async (req, res) => {
  const { 
    email, 
    password, 
    name, 
    phone, 
    cedula, 
    city, 
    address, 
    role_id = 3 // Por defecto: cliente
  } = req.body;

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Crear usuario
    const passwordToHash = password || cedula || "123456";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const userRes = await client.query(
      `INSERT INTO users (email, password, name, phone, cedula, city, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING id`,
      [
        email || null, 
        hashedPassword, 
        name, 
        phone || null, 
        cedula, 
        city || null, 
        address || null
      ]
    );
    
    const userId = userRes.rows[0].id;

    // 2. Asignar rol
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING",
      [userId, role_id]
    );

    await client.query('COMMIT');
    
    res.status(201).json({ 
      success: true,
      message: "Usuario creado correctamente", 
      data: { id: userId }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("CREATE USER ERROR:", error);
    
    // Manejo de errores específicos
    let errorMessage = "Error al crear usuario";
    
    if (error.code === '23505') { // Unique violation
      if (error.constraint === 'users_email_key') {
        errorMessage = "El email ya está registrado";
      } else if (error.constraint === 'users_cedula_key') {
        errorMessage = "La cédula ya está registrada";
      }
    }
    
    res.status(500).json({ 
      success: false,
      message: errorMessage,
      error: error.message 
    });
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
    await client.query('BEGIN');

    // Eliminar relaciones primero
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    // Eliminar usuario
    const result = await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING id", 
      [id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        message: "Usuario no encontrado" 
      });
    }

    await client.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Usuario eliminado correctamente" 
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("DELETE USER ERROR:", error);
    
    let errorMessage = "No se puede eliminar: el usuario tiene registros vinculados";
    
    // Error de foreign key constraint
    if (error.code === '23503') {
      errorMessage = "No se puede eliminar: el usuario tiene ventas o compras asociadas";
    }
    
    res.status(500).json({ 
      success: false,
      message: errorMessage,
      error: error.message 
    });
  } finally {
    client.release();
  }
};