const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth.middleware');
// FALTA ESTA LÍNEA (Ajusta la ruta a tu archivo de conexión db.js o index.js de base de datos)
const db = require('../services/db'); // O require('../config/db')

router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query("SELECT id, slug, description FROM permissions ORDER BY description ASC");
    // Asegúrate de devolver data o rows según tu driver de DB
    res.json(result.rows || result); 
  } catch (error) {
    console.error(error); // Agrega log para ver el error real en consola
    res.status(500).json({ message: "Error al obtener permisos" });
  }
});

module.exports = router;