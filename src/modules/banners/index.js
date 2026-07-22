"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./banners.routes");
  },

  get controller() {
    return require("./banners.controller");
  },
});