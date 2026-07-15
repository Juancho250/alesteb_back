'use strict';

const express = require('express');
const {
  renderPayPage,
  renderResultPage,
} = require('../controllers/creditPay.controller');

const router = express.Router();

// Rutas publicas: el token JWT del link autoriza solo esta cuota.
router.get('/result', renderResultPage);
router.get('/:token', renderPayPage);

module.exports = router;
