const express = require('express');
const router = express.Router();
const { getHistory, clearHistory } = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.get('/history', authenticate, getHistory);
router.delete('/history', authenticate, clearHistory);

module.exports = router;