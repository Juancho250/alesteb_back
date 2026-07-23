"use strict";

const db = require("../../platform/database");

const inventoryService =
  require("../inventory").service;

const {
  checkRateLimit,
} = require("../identity/auth");

const reservationRateLimit = checkRateLimit(
  (req) => `rl:rsv:${req.apiKey?.id ?? req.ip}`,
  10,
  60_000
);

async function createInventoryReservation(req, res) {
  try {
    const {
      items,
      sessionId,
      ttlMinutes,
    } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({
        success: false,
        message: "items es requerido",
        code: "MISSING_ITEMS",
      });
    }

    const result =
      await inventoryService.createReservation({
        items,
        sessionId: sessionId ?? null,
        userId: req.user?.id ?? null,
        ownerAdminId: req.apiKey.adminId,
        ttlMinutes,
      });

    return res.json({
      success: true,
      data: result,
    });
  }
  catch (error) {
    if (error?.code === "INSUFFICIENT_STOCK") {
      return res.status(409).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    return res.status(400).json({
      success: false,
      message:
        error.message ??
        "Error al crear reserva",
    });
  }
}

async function releaseInventoryReservation(req, res) {
  try {
    const {
      rows: [reservation],
    } = await db.query(
      `SELECT owner_admin_id
       FROM stock_reservations
       WHERE id = $1`,
      [req.params.id]
    );

    if (!reservation) {
      return res.status(404).json({
        success: false,
        message: "Reserva no encontrada",
      });
    }

    if (
      reservation.owner_admin_id !==
      req.apiKey.adminId
    ) {
      return res.status(403).json({
        success: false,
        message: "No autorizado",
      });
    }

    const result =
      await inventoryService.releaseReservation(
        Number(req.params.id),
        {
          ownerAdminId: req.apiKey.adminId,
          userId: req.user?.id ?? 0,
        },
        "cancelled"
      );

    return res.json({
      success: true,
      data: result,
    });
  }
  catch (error) {
    return res.status(400).json({
      success: false,
      message:
        error.message ??
        "Error al liberar reserva",
    });
  }
}

function registerReservationRoutes(router) {
  if (
    !router ||
    typeof router.post !== "function" ||
    typeof router.delete !== "function"
  ) {
    throw new TypeError(
      "registerReservationRoutes requiere un router Express válido"
    );
  }

  router.post(
    "/inventory/reservations",
    reservationRateLimit,
    createInventoryReservation
  );

  router.delete(
    "/inventory/reservations/:id",
    releaseInventoryReservation
  );
}

module.exports = Object.freeze({
  registerReservationRoutes,
  createInventoryReservation,
  releaseInventoryReservation,
});