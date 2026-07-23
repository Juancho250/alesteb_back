"use strict";

const {
  requireApiPermission,
} = require("../identity/auth");

const analyticsController =
  require("../analytics").controller;

function getPing(req, res) {
  res.json({
    success: true,
    message: "API Key válida y activa",
    api_key: req.apiKey.name,
    permissions: req.apiKey.permissions,
    timestamp: new Date().toISOString(),
  });
}

function registerSystemRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function" ||
    typeof router.post !== "function"
  ) {
    throw new TypeError(
      "registerSystemRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/ping",
    getPing
  );

  router.post(
    "/analytics/pageview",
    requireApiPermission("analytics:write"),
    analyticsController.trackPageview
  );
}

module.exports = Object.freeze({
  registerSystemRoutes,
  getPing,
});
