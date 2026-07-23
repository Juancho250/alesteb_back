"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./chat.routes");
  },

  get controller() {
    return require("./chat.controller");
  },

  get socket() {
    return require("./chat.socket");
  },
});