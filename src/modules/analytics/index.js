"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./analytics.routes");
  },

  get controller() {
    return require("./analytics.controller");
  },
});