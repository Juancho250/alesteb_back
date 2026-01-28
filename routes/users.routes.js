const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller'); 

// Importamos solo el middleware de autenticación
const { auth, isAdmin, requireRole } = require('../middleware/auth.middleware');

// Solo Admins pueden gestionar usuarios
router.get('/', auth, isAdmin, usersController.getUsers);
router.post('/', auth, isAdmin, usersController.createUser);
router.put('/:id', auth, isAdmin, usersController.updateUser);
router.delete('/:id', auth, isAdmin, usersController.deleteUser);

module.exports = router;