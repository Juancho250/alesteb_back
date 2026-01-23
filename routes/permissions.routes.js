// permissions.routes.js
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth.middleware');  // Asegúrate de que estás protegiendo la ruta con el middleware de autenticación

// Ruta para obtener los permisos
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query("SELECT id, slug, description FROM permissions ORDER BY description ASC");
    res.json(result.rows);  // Esto debe devolver la lista de permisos
  } catch (error) {
    res.status(500).json({ message: "Error al obtener permisos" });
  }
});

module.exports = router;
