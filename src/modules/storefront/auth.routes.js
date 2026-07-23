"use strict";

const identityAuth = require("../identity/auth");

const {
  auth,
  checkRateLimit,
} = identityAuth;

const storefrontAuth = identityAuth.storefrontController;
const googleAuth = identityAuth.storefrontGoogleController;

function registerAuthRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function" ||
    typeof router.post !== "function" ||
    typeof router.put !== "function"
  ) {
    throw new TypeError(
      "registerAuthRoutes requiere un router Express válido"
    );
  }

  router.post(
    "/auth/register",
    checkRateLimit("ip", 10, 60 * 60 * 1000),
    storefrontAuth.register
  );

  router.post(
    "/auth/verify",
    storefrontAuth.verifyEmail
  );

  router.post(
    "/auth/resend-code",
    checkRateLimit("email", 3, 60 * 60 * 1000),
    storefrontAuth.resendCode
  );

  router.post(
    "/auth/login",
    checkRateLimit("email", 5, 15 * 60 * 1000),
    storefrontAuth.login
  );

  router.post(
    "/auth/refresh",
    storefrontAuth.refreshToken
  );

  router.post(
    "/auth/logout",
    auth,
    storefrontAuth.logout
  );

  router.get(
    "/auth/profile",
    auth,
    storefrontAuth.getProfile
  );

  router.put(
    "/auth/profile",
    auth,
    storefrontAuth.updateProfile
  );

  router.post(
    "/auth/google",
    googleAuth.googleAuth
  );
}

module.exports = Object.freeze({
  registerAuthRoutes,
});