"use strict";

const {
  wompiController,
} = require("../payments");

const {
  auth,
} = require("../identity/auth");

function registerPaymentRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerPaymentRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/wompi/session/:sale_id",
    auth,
    wompiController.getSession
  );

  router.get(
    "/wompi/verify/:reference",
    auth,
    wompiController.verifyByReference
  );
}

module.exports = Object.freeze({
  registerPaymentRoutes,
});