// src/services/push.service.js  (backend Node.js)
// npm install web-push
const webpush = require("web-push");
const db = require("../config/db");

// ── Inicializar VAPID ────────────────────────────────────────
// Genera las claves una sola vez: npx web-push generate-vapid-keys
// Guárdalas en .env:  VAPID_EMAIL / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Enviar a UNA suscripción ──────────────────────────────────
async function sendPushToOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    // 410 Gone / 404 = suscripción expirada → limpiar BD
    if (err.statusCode === 410 || err.statusCode === 404) {
      return { ok: false, expired: true, endpoint: subscription.endpoint };
    }
    console.error("[Push] Error enviando:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Broadcast a TODOS los usuarios activos ──────────────────
async function broadcast(payload) {
  const { rows } = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE is_active = true"
  );

  const results = await Promise.allSettled(
    rows.map((row) =>
      sendPushToOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
    )
  );

  // Desactivar suscripciones expiradas
  const expired = results
    .filter((r) => r.status === "fulfilled" && r.value?.expired)
    .map((r) => r.value.endpoint);

  if (expired.length) {
    await db.query(
      "UPDATE push_subscriptions SET is_active = false WHERE endpoint = ANY($1::text[])",
      [expired]
    );
  }

  return { sent: rows.length, expired: expired.length };
}

// ── Broadcast a UN usuario específico ───────────────────────
async function notifyUser(userId, payload) {
  const { rows } = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 AND is_active = true",
    [userId]
  );

  await Promise.allSettled(
    rows.map((row) =>
      sendPushToOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
    )
  );
}

// ── Payloads reutilizables ───────────────────────────────────
const Payloads = {
  newChat: (senderName) => ({
    title: "💬 Nuevo mensaje",
    body: `${senderName} te envió un mensaje`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/chat",
    tag: "chat-message",
    severity: "info",
  }),

  outOfStock: (productName) => ({
    title: "📦 Sin stock",
    body: `${productName} se quedó sin unidades`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/products",
    tag: `stock-out`,
    severity: "critical",
  }),

  lowStock: (productName, stock, minStock) => ({
    title: "⚠️ Stock bajo",
    body: `${productName} — ${stock} uds (mín. ${minStock})`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/products",
    tag: "stock-low",
    severity: "warning",
  }),

  overdueInvoice: (providerName, amount) => ({
    title: "💸 Factura vencida",
    body: `${providerName} — $${Number(amount).toLocaleString("es-CO")} pendiente`,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/tools/finance",
    tag: "invoice-overdue",
    severity: "critical",
  }),

  expiringDiscount: (name, label) => ({
    title: `🏷️ Descuento vence en ${label}`,
    body: name,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    url: "/tools/discounts",
    tag: "discount-expiring",
    severity: "warning",
  }),
};

module.exports = { sendPushToOne, broadcast, notifyUser, Payloads };