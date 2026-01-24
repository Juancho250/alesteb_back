const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller'); 

// Middleware de autenticación y permisos
const { auth, requirePermission } = require('../middleware/auth.middleware');

// Rutas protegidas
router.get('/', auth, requirePermission('user.read'), usersController.getUsers);
router.post('/', auth, requirePermission('user.create'), usersController.createUser);
router.delete('/:id', auth, requirePermission('user.delete'), usersController.deleteUser);
router.put('/:id', auth, requirePermission('user.update'), usersController.updateUser);

// Asignación de roles
router.post('/assign-role', auth, requirePermission('user.update'), usersController.assignRole);

module.exports = router;
