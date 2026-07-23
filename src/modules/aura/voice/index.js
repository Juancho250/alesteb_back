"use strict";

module.exports = Object.freeze({
  get service() {
    return require("./voice.service");
  },

  get controller() {
    return require("./voice.controller");
  },

  get uploadMiddleware() {
    return require("./voice-upload.middleware");
  },
});