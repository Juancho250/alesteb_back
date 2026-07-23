"use strict";

module.exports = Object.freeze({
  get controller() {
    return require("./images.controller");
  },

  get jobs() {
    return require("./image-jobs.service");
  },

  get provider() {
    return require("./image-openai.service");
  },

  get worker() {
    return require("./image-worker.service");
  },
});