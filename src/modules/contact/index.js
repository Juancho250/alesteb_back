"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./contact.routes");
  },

  get controller() {
    return require("./contact.controller");
  },
});