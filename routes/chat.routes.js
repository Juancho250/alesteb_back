const express = require('express');
const router = express.Router();
const { getChatUsers, getConversation, clearHistory } = require('../controllers/chat.controller');
const { auth } = require('../middleware/auth.middleware');

router.get('/users',                  auth, getChatUsers);
router.get('/conversation/:userId',   auth, getConversation);
router.delete('/history',             auth, clearHistory);

module.exports = router;