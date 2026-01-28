const express = require('express');
const { submitContact } = require('../controllers/contact.controller');

const router = express.Router();

router.post('/', submitContact);

module.exports = router; // Cambiado de 'export default' a 'module.exports'