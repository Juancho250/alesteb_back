"use strict";

module.exports = Object.freeze({
  get service() {
    return require("./agent.service");
  },

  get tools() {
    return require("./agent.tools");
  },

  get cron() {
    return require("./agent.cron");
  },
});