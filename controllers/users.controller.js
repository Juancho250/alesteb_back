const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios con roles
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id,
        u.email,
        COALESCE(
          STRING_AGG(r.name, ', '),
          ''
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      GROUP BY u.id
      ORDER BY u.id
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// Crear usuario
exports.createUser = async (req, res) => {
  const { email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.query(
      `
      INSERT INTO users (email, password)
      VALUES ($1, $2)
      RETURNING id, email
      `,
      [email, hashedPassword]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("CREATE USER ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({ message: "Email ya registrado" });
    }

    res.status(500).json({ message: "Error al crear usuario" });
  }
};

// Asignar rol
exports.assignRole = async (req, res) => {
  const { userId, roleId } = req.body;

  try {
    await db.query(
      `
      INSERT INTO user_roles (user_id, role_id)
      VALUES ($1, $2)
      `,
      [userId, roleId]
    );

    res.json({ message: "Rol asignado correctamente" });
  } catch (error) {
    console.error("ASSIGN ROLE ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({ message: "El usuario ya tiene este rol" });
    }

    res.status(500).json({ message: "Error al asignar rol" });
  }
};
