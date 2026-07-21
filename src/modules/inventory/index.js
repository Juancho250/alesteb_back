"use strict";

const service = require("./inventory.service");

module.exports = Object.freeze({
  service,

  get routes() {
    return require("./inventory.routes");
  },

  get jobs() {
    return require("./inventory.jobs");
  },
});