"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const storefront = require("../src/modules/storefront");

const EXPECTED_CONTRACT = Object.freeze([
  { method: "GET", path: "/ping", handlers: 1 },
  { method: "POST", path: "/analytics/pageview", handlers: 2 },
  { method: "GET", path: "/profile", handlers: 1 },
  { method: "GET", path: "/products", handlers: 2 },
  { method: "GET", path: "/products/:id", handlers: 2 },
  { method: "GET", path: "/categories", handlers: 2 },
  { method: "GET", path: "/inventory", handlers: 2 },
  { method: "GET", path: "/banners", handlers: 1 },
  { method: "GET", path: "/discounts", handlers: 1 },
  { method: "POST", path: "/discounts/validate", handlers: 1 },
  { method: "GET", path: "/sales", handlers: 2 },
  { method: "POST", path: "/sales", handlers: 3 },
  { method: "GET", path: "/inventory/availability", handlers: 2 },
  { method: "GET", path: "/customers", handlers: 2 },
  { method: "POST", path: "/auth/register", handlers: 2 },
  { method: "POST", path: "/auth/verify", handlers: 1 },
  { method: "POST", path: "/auth/resend-code", handlers: 2 },
  { method: "POST", path: "/auth/login", handlers: 2 },
  { method: "POST", path: "/auth/refresh", handlers: 1 },
  { method: "POST", path: "/auth/logout", handlers: 2 },
  { method: "GET", path: "/auth/profile", handlers: 2 },
  { method: "PUT", path: "/auth/profile", handlers: 2 },
  { method: "POST", path: "/auth/google", handlers: 1 },
  { method: "GET", path: "/sales/user/history", handlers: 2 },
  { method: "GET", path: "/sales/user/stats", handlers: 2 },
  {
    method: "GET",
    path: "/products/:productId/reviews",
    handlers: 1,
  },
  {
    method: "GET",
    path: "/reviews/my/:productId",
    handlers: 2,
  },
  { method: "POST", path: "/reviews", handlers: 2 },
  { method: "POST", path: "/upload", handlers: 3 },
  {
    method: "POST",
    path: "/inventory/reservations",
    handlers: 2,
  },
  {
    method: "DELETE",
    path: "/inventory/reservations/:id",
    handlers: 1,
  },
  {
    method: "GET",
    path: "/wompi/session/:sale_id",
    handlers: 2,
  },
  {
    method: "GET",
    path: "/wompi/verify/:reference",
    handlers: 2,
  },
]);

function readRouterContract(router) {
  assert.ok(
    router &&
      Array.isArray(router.stack),
    "Storefront debe exponer un router Express válido"
  );

  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const method = Object.keys(
        layer.route.methods
      ).find(
        (name) =>
          layer.route.methods[name]
      );

      assert.ok(
        method,
        `La ruta ${String(layer.route.path)} no tiene método HTTP`
      );

      return {
        method: method.toUpperCase(),
        path: String(layer.route.path),
        handlers: layer.route.stack.length,
      };
    });
}

test(
  "Storefront exposes only its frozen lazy routes API",
  () => {
    assert.equal(
      Object.isFrozen(storefront),
      true
    );

    assert.deepEqual(
      Object.keys(storefront),
      ["routes"]
    );

    const descriptor =
      Object.getOwnPropertyDescriptor(
        storefront,
        "routes"
      );

    assert.ok(descriptor);
    assert.equal(
      typeof descriptor.get,
      "function"
    );
    assert.equal(
      descriptor.set,
      undefined
    );
  }
);

test(
  "Storefront preserves its exact 33-endpoint HTTP contract",
  () => {
    const actualContract =
      readRouterContract(
        storefront.routes
      );

    assert.equal(
      actualContract.length,
      33
    );

    assert.deepEqual(
      actualContract,
      EXPECTED_CONTRACT
    );
  }
);
