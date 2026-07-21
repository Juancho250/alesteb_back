"use strict";

const routes = require("./procurement.routes");
const controller = require("./procurement.controller");
const service = require("./procurement.service");

module.exports = Object.freeze({
  routes,
  controller,
  service,
});