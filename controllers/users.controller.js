const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios con roles
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, email, cedula, phone, city, total_spent, user_roles
      FROM users 
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener la lista de clientes" });
  }
};

// Crear usuario / cliente
exports.createUser = async (req, res) => {
  // Extraemos todos los campos que envía el formulario del Frontend
  const { email, password, name, phone, cedula, city, address } = req.body;

  try {
    // Si no viene password (por ejemplo, registro manual de admin), asignamos uno temporal o el email
    const passwordToHash = password || cedula || "123456"; 
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const result = await db.query(
      `
      INSERT INTO users (email, password, name, phone, cedula, city, address, user_roles)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, email, name, cedula
      `,
      [email, hashedPassword, name, phone, cedula, city, address, 'customer']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("CREATE USER ERROR:", error);

    // Manejo de duplicados (Cédula o Email ya existentes)
    if (error.code === "23505") {
      return res.status(409).json({ 
        message: "El email o la cédula ya se encuentran registrados." 
      });
    }

    res.status(500).json({ message: "Error interno al procesar el registro" });
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
