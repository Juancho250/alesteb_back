"use strict";

const reviewsController = require("../reviews").controller;
const { auth } = require("../identity/auth");

function registerReviewsRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function" ||
    typeof router.post !== "function"
  ) {
    throw new TypeError(
      "registerReviewsRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/products/:productId/reviews",
    reviewsController.getProductReviews
  );

  router.get(
    "/reviews/my/:productId",
    auth,
    reviewsController.getUserReviewForProduct
  );

  router.post(
    "/reviews",
    auth,
    reviewsController.createReview
  );
}

module.exports = Object.freeze({
  registerReviewsRoutes,
});