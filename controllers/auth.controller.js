const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1. Buscar el usuario en la base de datos
    const userRes = await db.query(
      "SELECT id, email, password FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rowCount === 0) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const user = userRes.rows[0];

    // 2. Validar la contraseña del usuario
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    // 3. Obtener Roles del Usuario
    const rolesRes = await db.query(
      `SELECT r.name FROM roles r 
       JOIN user_roles ur ON ur.role_id = r.id 
       WHERE ur.user_id = $1`,
      [user.id]
    );

    const roles = rolesRes.rows.map(r => r.name);

    // 4. Obtener Permisos del Usuario y de los Roles asociados
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

    // 5. Firmar el token con la clave secreta y asignar roles y permisos al payload
    const token = jwt.sign(
      { 
        id: user.id, 
        roles, 
        permissions 
      },
      process.env.JWT_SECRET, // Asegúrate de tener JWT_SECRET en el archivo .env
      { expiresIn: "8h" } // Expiración del token
    );

    // 6. Devolver el token y los datos del usuario
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        roles,  // Incluye roles del usuario
        permissions  // Incluye permisos del usuario
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Error interno en el servidor" });
  }
};
