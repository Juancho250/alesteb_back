"use strict";

module.exports = Object.freeze({
  get controller() {
    return require("./operations.controller");
  },

  get service() {
    return require("./operations.service");
  },
});