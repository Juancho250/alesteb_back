"use strict";

module.exports = Object.freeze({
  get controller() {
    return require("./predictions.controller");
  },

  get forecasting() {
    return require("./forecasting.service");
  },

  get features() {
    return require("./features.service");
  },

  get jobs() {
    return require("./jobs.service");
  },
});