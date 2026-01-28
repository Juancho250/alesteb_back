const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller'); 
const { auth, isAdmin } = require('../middleware/auth.middleware');

router.get('/', auth, isAdmin, usersController.getUsers);
router.post('/', auth, isAdmin, usersController.createUser);
router.put('/:id', auth, isAdmin, usersController.updateUser);
router.delete('/:id', auth, isAdmin, usersController.deleteUser); // Aquí fallaba

module.exports = router;