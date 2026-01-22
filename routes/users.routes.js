const express = require('express');
const router = express.Router();

// Usa solo un import. Asegúrate de que el nombre del archivo sea exacto (con o sin el .controller)
const usersController = require('../controllers/users.controller'); 

// Cambia 'userController' por 'usersController' (con la 's')
router.put("/:id", usersController.updateUser); 

router.get('/', usersController.getUsers);
router.post('/', usersController.createUser);
router.post('/assign-role', usersController.assignRole);
// Ahora es muy expresivo y seguro
router.get('/', auth, requirePermission('user.read'), usersController.getUsers);
router.post('/', auth, requirePermission('user.create'), usersController.createUser);
// Solo alguien con permiso de editar puede entrar aquí:
router.put('/:id', auth, requirePermission('user.update'), usersController.updateUser);

module.exports = router;