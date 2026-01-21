const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const userController = require("../controllers/userController");

router.put("/:id", userController.updateUser); // <-- IMPORTANTE

router.get('/', usersController.getUsers);
router.post('/', usersController.createUser);
router.post('/assign-role', usersController.assignRole);

module.exports = router;
