"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./sales.routes");
  },

  get creditPayRoutes() {
    return require("./credit-pay.routes");
  },

  get controller() {
    return require("./sales.controller");
  },

  get creditScheduleController() {
    return require("./credit-schedule.controller");
  },

  get creditPayController() {
    return require("./credit-pay.controller");
  },

  get creditPayTokenService() {
    return require("./credit-pay-token.service");
  },
});