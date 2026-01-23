const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1. Buscar usuario
    const userRes = await db.query(
      "SELECT id, email, password FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rowCount === 0) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const user = userRes.rows[0];

    // 2. Validar password
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    // 3. Obtener Roles Y Permisos (Todo dentro del mismo bloque try/catch)
    // Usamos una consulta combinada o dos separadas para claridad
    const rolesRes = await db.query(
      `SELECT r.name FROM roles r 
       JOIN user_roles ur ON ur.role_id = r.id 
       WHERE ur.user_id = $1`,
      [user.id]
    );

    // Cambia la consulta de permissionsRes por esta que une permisos de ROL + permisos de USUARIO:
    const permissionsRes = await db.query(
      `SELECT DISTINCT p.slug
      FROM permissions p
      LEFT JOIN role_permissions rp ON rp.permission_id = p.id
      LEFT JOIN user_roles ur ON ur.role_id = rp.role_id
      LEFT JOIN user_permissions up ON up.permission_id = p.id
      WHERE ur.user_id = $1 OR up.user_id = $1`,
      [user.id]
    );

    const roles = rolesRes.rows.map(r => r.name);
    const permissions = permissionsRes.rows.map(p => p.slug);

    // 4. Firmar token incluyendo el Payload aumentado
    const token = jwt.sign(
      { 
        id: user.id, 
        roles, 
        permissions 
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    // 5. Respuesta al cliente
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        roles,
        permissions // Enviamos los permisos para que el Frontend los cargue en el AuthContext
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Error interno en el servidor" });
  }
};