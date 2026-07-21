"use strict";

const routes = require("./auth.routes");
const controller = require("./auth.controller");
const storefrontController = require("./storefront-auth.controller");
const storefrontGoogleController = require("./storefront-google.controller");
const middleware = require("./auth.middleware");

module.exports = Object.freeze({
  routes,
  controller,
  storefrontController,
  storefrontGoogleController,
  middleware,
  ...middleware,
});