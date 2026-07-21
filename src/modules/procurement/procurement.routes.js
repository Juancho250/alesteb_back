"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("./procurement.controller");

const {
  auth,
  requireManager,
} = require("../identity/auth");

const {
  adminScope,
} = require("../../../middleware/adminScope");

const {
  requireFeature,
} = require("../../../middleware/subscription.middleware");

router.use(auth);
router.use(adminScope);
router.use(requireFeature("has_purchase_orders"));

router.get("/pending", requireManager, ctrl.getPending);
router.get("/purchase-orders", requireManager, ctrl.getPurchaseOrders);
router.get("/sales-awaiting", requireManager, ctrl.getSalesAwaiting);
router.post("/group-purchase-order", requireManager, ctrl.groupPurchaseOrder);

router.post(
  "/purchase-orders/:id/receive",
  requireManager,
  ctrl.receivePurchaseOrder
);

router.post("/:id/cancel", requireManager, ctrl.cancel);

module.exports = router;