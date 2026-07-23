"use strict";

module.exports = Object.freeze({
  get auraController() {
    return require("./aura.controller");
  },

  get agentCompatController() {
    return require("./agent-compat.controller");
  },
});