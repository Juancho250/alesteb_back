"use strict";

module.exports = Object.freeze({
  get productsRoutes() {
    return require("./products.routes");
  },

  get categoriesRoutes() {
    return require("./categories.routes");
  },

  get variantsRoutes() {
    return require("./variants-bundles.routes");
  },

  get productsController() {
    return require("./products.controller");
  },

  get categoriesController() {
    return require("./categories.controller");
  },

  get variantsController() {
    return require("./variants.controller");
  },

  get bundlesController() {
    return require("./bundles.controller");
  },
});