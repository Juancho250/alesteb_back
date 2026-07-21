"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./finance.routes");
  },

  get pinRoutes() {
    return require("./finance-pin.routes");
  },

  get controller() {
    return require("./finance.controller");
  },

  get pinController() {
    return require("./finance-pin.controller");
  },
});