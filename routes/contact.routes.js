const express = require('express');
const router = express.Router();
const { submitContact } = require('../controllers/contact.controller');
const { strictApiLimiter, sanitizeParams } = require('../middleware/auth.middleware');

// Rate limiter específico para contacto (prevenir spam)
const contactLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3, // 3 mensajes
  message: { message: "Demasiados mensajes enviados. Intenta en 15 minutos" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/', 
  sanitizeParams,
  contactLimiter,
  submitContact
);

module.exports = router;