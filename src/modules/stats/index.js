"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./stats.routes");
  },

  get controller() {
    return require("./stats.controller");
  },
});