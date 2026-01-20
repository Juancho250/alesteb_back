const db = require("../config/db");
const bcrypt = require("bcrypt");

// Obtener usuarios
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, email, cedula, phone, city, total_spent
      FROM users
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET USERS ERROR:", error);
    res.status(500).json({ message: "Error al obtener usuarios" });
  }
};

// Crear usuario
exports.createUser = async (req, res) => {
  const { email, password, name, phone, cedula, city, address } = req.body;

  try {
    const passwordToHash = password || cedula || "123456";
    const hashedPassword = await bcrypt.hash(passwordToHash, 10);

    const userRes = await db.query(
      `
      INSERT INTO users (email, password, name, phone, cedula, city, address)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, email, name
      `,
      [email, hashedPassword, name, phone, cedula, city, address]
    );

    const userId = userRes.rows[0].id;

    // Asignar rol customer por defecto
    const roleRes = await db.query(
      "SELECT id FROM roles WHERE name = 'customer'"
    );

    await db.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)",
      [userId, roleRes.rows[0].id]
    );

    res.status(201).json(userRes.rows[0]);

  } catch (error) {
    console.error("CREATE USER ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        message: "Email o cédula ya registrados"
      });
    }

    res.status(500).json({ message: "Error interno" });
  }
};
