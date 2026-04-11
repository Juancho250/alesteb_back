const express = require('express');
const router = express.Router();
const { getHistory, clearHistory } = require('../controllers/chat.controller');
const { auth } = require('../middleware/auth.middleware'); // ← auth, no authenticate

router.get('/history', auth, getHistory);
router.delete('/history', auth, clearHistory);

module.exports = router;