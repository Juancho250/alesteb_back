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

    // 3. Obtener roles
    const rolesRes = await db.query(
      `
      SELECT r.name
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = $1
      `,
      [user.id]
    );

    const roles = rolesRes.rows.map(r => r.name);

    // 4. Firmar token
    const token = jwt.sign(
      { id: user.id, roles },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        roles
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Error interno" });
  }
};

// ... validación de password ...

// 3. Obtener Roles Y Permisos
const permissionsRes = await db.query(`
  SELECT DISTINCT p.slug
  FROM permissions p
  JOIN role_permissions rp ON rp.permission_id = p.id
  JOIN user_roles ur ON ur.role_id = rp.role_id
  WHERE ur.user_id = $1
`, [user.id]);

const permissions = permissionsRes.rows.map(p => p.slug); 
// Resultado ejemplo: ['user.read', 'product.edit', 'product.delete']

// 4. Firmar token (Incluye permisos en el token o guárdalos en Redis/Cache)
const token = jwt.sign(
  { id: user.id, roles, permissions }, // Payload aumentado
  process.env.JWT_SECRET,
  { expiresIn: "8h" }
);