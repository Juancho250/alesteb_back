const express = require('express');
const router = express.Router();
const db = require("../config/db");
const { auth } = require('../middleware/auth.middleware');

router.get('/', auth, async (req, res) => {
    try {
        const result = await db.query("SELECT id, slug, description FROM permissions ORDER BY description ASC");
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener permisos" });
    }
});

module.exports = router;