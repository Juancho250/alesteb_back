"use strict";

module.exports = Object.freeze({
  get service() {
    return require("./payment.service");
  },

  get wompiController() {
    return require("./wompi.controller");
  },

  get wompiRoutes() {
    return require("./wompi.routes");
  },

  get paymentAccountsController() {
    return require("./payment-accounts.controller");
  },

  get paymentAccountsRoutes() {
    return require("./payment-accounts.routes");
  },
});