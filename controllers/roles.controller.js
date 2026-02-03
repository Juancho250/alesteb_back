const db = require("../config/db");

// ===============================
// OBTENER ROLES
// ===============================

exports.getRoles = async (req, res) => {
  try {
    const result = await db.query("SELECT id, name FROM roles ORDER BY id");
    res.json(result.rows);
  } catch (error) {
    console.error("GET ROLES ERROR:", error);
    res.status(500).json({ message: "Error al obtener roles" });
  }
};

// ===============================
// CREAR ROL (ADMIN)
// ===============================

exports.createRole = async (req, res) => {
  const { name } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({ message: "El nombre del rol es obligatorio" });
  }

  try {
    const result = await db.query(
      `INSERT INTO roles (name) VALUES ($1) RETURNING id, name`,
      [name.trim().toLowerCase()]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("CREATE ROLE ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({ message: "El rol ya existe" });
    }

    res.status(500).json({ message: "Error al crear rol" });
  }
};