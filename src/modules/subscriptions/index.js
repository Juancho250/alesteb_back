"use strict";

const routes = require("./subscription.routes");
const controller = require("./subscription.controller");
const service = require("./subscription.service");
const middleware = require("./subscription.middleware");

module.exports = Object.freeze({
  routes,
  controller,
  service,
  middleware,
});