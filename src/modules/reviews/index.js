"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./reviews.routes");
  },

  get controller() {
    return require("./reviews.controller");
  },
});