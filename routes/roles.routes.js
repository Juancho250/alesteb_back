const express = require('express');
const router = express.Router();
const rolesController = require('../controllers/roles.controller');

router.get('/', rolesController.getRoles);
router.post('/', rolesController.createRole);

module.exports = router;
