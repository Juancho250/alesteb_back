// permissions.controller.js
const db = require("../config/db");

exports.getPermissions = async (req, res) => {
  try {
    const result = await db.query("SELECT id, slug, description FROM permissions ORDER BY description ASC");
    res.json(result.rows);  // Asegúrate de que esta consulta esté devolviendo los permisos correctamente
  } catch (error) {
    console.error("Error al obtener permisos:", error);
    res.status(500).json({ message: "Error al obtener permisos" });
  }
};
