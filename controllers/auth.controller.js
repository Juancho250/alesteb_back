const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1. Buscar usuario
    const userRes = await db.query(
      "SELECT id, email, password, name FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rowCount === 0) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const user = userRes.rows[0];

    // 2. Validar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    // 3. Obtener roles del usuario
    const rolesRes = await db.query(
      `SELECT r.name 
       FROM roles r 
       JOIN user_roles ur ON ur.role_id = r.id 
       WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = rolesRes.rows.map(r => r.name);

    // 4. Obtener permisos (de roles + permisos individuales)
    const permissionsRes = await db.query(
      `SELECT DISTINCT p.slug
       FROM permissions p
       LEFT JOIN role_permissions rp ON rp.permission_id = p.id
       LEFT JOIN user_roles ur ON ur.role_id = rp.role_id
       LEFT JOIN user_permissions up ON up.permission_id = p.id
       WHERE ur.user_id = $1 OR up.user_id = $1`,
      [user.id]
    );
    const permissions = permissionsRes.rows.map(p => p.slug);

    // 5. Actualizar último login
    await db.query("UPDATE users SET last_login = NOW() WHERE id = $1", [user.id]);

    // 6. Generar token JWT
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        name: user.name, // ✅ Incluir el nombre en el token también
        roles, 
        permissions 
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    // 7. Devolver respuesta (ASEGURAR que name esté presente)
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || "Usuario", // ✅ Fallback si name es null
        roles,
        permissions
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
};

// Registro de nuevos usuarios
exports.register = async (req, res) => {
  const { email, password, name, cedula, phone } = req.body;

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Verificar si el email ya existe
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "El email ya está registrado" });
    }

    // Hash de contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // Crear usuario
    const userRes = await client.query(
      `INSERT INTO users (email, password, name, cedula, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, hashedPassword, name, cedula, phone]
    );
    const userId = userRes.rows[0].id;

    // Asignar rol de customer por defecto
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [userId]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: "Usuario registrado correctamente", id: userId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ message: "Error al registrar usuario" });
  } finally {
    client.release();
  }
};