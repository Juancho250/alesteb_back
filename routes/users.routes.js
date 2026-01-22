const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller'); 

// 1. IMPORTA LOS MIDDLEWARES (Ajusta la ruta según tu estructura)
const { auth, requirePermission } = require('../middlewares/auth.middleware');

// 2. DEFINE LAS RUTAS (Protegidas)
// GET - Listar usuarios
router.get('/', auth, requirePermission('user.read'), usersController.getUsers);

// POST - Crear usuario
router.post('/', auth, requirePermission('user.create'), usersController.createUser);

// PUT - Actualizar usuario
router.put('/:id', auth, requirePermission('user.update'), usersController.updateUser);

// POST - Asignar roles
router.post('/assign-role', auth, requirePermission('user.update'), usersController.assignRole);

module.exports = router;