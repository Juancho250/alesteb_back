"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./providers.routes");
  },

  get controller() {
    return require("./providers.controller");
  },
});