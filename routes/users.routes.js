const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const { auth, isAdmin } = require('../middleware/auth.middleware');

// ✅ Proteger todas las rutas de usuarios
router.get('/', auth, usersController.getUsers);
router.post('/', auth, isAdmin, usersController.createUser);
router.put('/:id', auth, isAdmin, usersController.updateUser);
router.delete('/:id', auth, isAdmin, usersController.deleteUser);

module.exports = router;