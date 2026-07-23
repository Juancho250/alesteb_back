"use strict";

module.exports = Object.freeze({
  get controller() {
    return require("./actions.controller");
  },

  get service() {
    return require("./actions.service");
  },
});