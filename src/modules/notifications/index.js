"use strict";

module.exports = Object.freeze({
  get routes() {
    return require("./notifications.routes");
  },

  get controller() {
    return require("./notifications.controller");
  },

  get pushSubscriptionController() {
    return require("./push-subscription.controller");
  },

  get service() {
    return require("./notification.service");
  },

  get outbox() {
    return require("./notification-outbox.service");
  },

  get push() {
    return require("./push.service");
  },

  get worker() {
    return require("./notification.worker");
  },
});