"use strict";

module.exports = Object.freeze({
  get campaignController() {
    return require("./campaigns.controller");
  },

  get customerController() {
    return require("./customers.controller");
  },

  get campaigns() {
    return require("./campaigns.service");
  },

  get customerGrowth() {
    return require("./customer-growth.service");
  },

  get sendTime() {
    return require("./send-time.service");
  },
});