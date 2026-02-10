const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller'); 

// Middleware de autenticación y roles (SIN requirePermission)
const { auth, requireAdmin } = require('../middleware/auth.middleware');

// ============================================
// 👥 RUTAS DE GESTIÓN DE USUARIOS
// ============================================

/**
 * @route   GET /api/users
 * @desc    Obtener todos los usuarios con sus roles
 * @access  Private (Solo Admin)
 */
router.get('/', auth, requireAdmin, usersController.getUsers);

/**
 * @route   POST /api/users
 * @desc    Crear nuevo usuario
 * @access  Private (Solo Admin)
 * @body    { email, password, name, cedula, phone, role_id }
 */
router.post('/', auth, requireAdmin, usersController.createUser);

/**
 * @route   PUT /api/users/:id
 * @desc    Actualizar usuario
 * @access  Private (Solo Admin)
 * @body    { name, email, phone, cedula, city, address, role_id, password? }
 */
router.put('/:id', auth, requireAdmin, usersController.updateUser);

/**
 * @route   DELETE /api/users/:id
 * @desc    Eliminar usuario
 * @access  Private (Solo Admin)
 */
router.delete('/:id', auth, requireAdmin, usersController.deleteUser);

module.exports = router;