// routes/procurement.routes.js
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/procurement.controller');
const { auth, requireManager } = require('../middleware/auth.middleware');
const { adminScope }           = require('../middleware/adminScope');

router.use(auth);
router.use(adminScope);

// ── Static routes first ───────────────────────────────────────────────────────
router.get ('/pending',              requireManager, ctrl.getPending);
router.get ('/sales-awaiting',       requireManager, ctrl.getSalesAwaiting);
router.post('/group-purchase-order', requireManager, ctrl.groupPurchaseOrder);

// ── Routes with :id ───────────────────────────────────────────────────────────
router.post('/:id/cancel', requireManager, ctrl.cancel);

module.exports = router;
