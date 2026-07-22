"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./discounts.routes");
  },

  get controller() {
    return require("./discounts.controller");
  },
});