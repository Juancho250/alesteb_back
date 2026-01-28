const express = require('express');
const router = express.Router();
const rolesController = require('../controllers/roles.controller');
const { auth, isAdmin } = require('../middleware/auth.middleware');

// Solo el Admin debería poder ver o crear roles
router.get('/', auth, isAdmin, rolesController.getRoles);
router.post('/', auth, isAdmin, rolesController.createRole);

module.exports = router;