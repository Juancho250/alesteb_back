// middleware/subscription.middleware.js
const subscriptionService = require('../services/subscription.service');

// ─────────────────────────────────────────────────────────────────
// HELPER INTERNO
// ─────────────────────────────────────────────────────────────────

function getAdminId(req) {
  return req.user?.owner_admin_id || req.user?.id || null;
}

// ─────────────────────────────────────────────────────────────────
// attachSubscription
// Adjunta info de suscripción a req.subscription.
// Debe ir ANTES de cualquier otro middleware de suscripción.
// ─────────────────────────────────────────────────────────────────
async function attachSubscription(req, res, next) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return next();

    req.subscription = await subscriptionService.checkLimits(adminId);
    next();
  } catch (err) {
    console.error('[SubscriptionMiddleware] attachSubscription error:', err.message);
    // No bloqueamos el request; los middlewares de guardia sí lo harán si hace falta
    next();
  }
}

// ─────────────────────────────────────────────────────────────────
// requireActiveSubscription
// Bloquea si la suscripción no está activa.
// Requiere haber pasado por attachSubscription antes.
// ─────────────────────────────────────────────────────────────────
function requireActiveSubscription(req, res, next) {
  const sub = req.subscription;

  if (!sub || !sub.allowed) {
    return res.status(402).json({
      error: 'subscription_required',
      message: sub?.reason || 'Tu suscripción no está activa. Por favor renueva tu plan.',
      status: sub?.status ?? 'expired',
      upgrade_required: true,
    });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// requireFeature
// Bloquea si el plan actual no incluye la feature solicitada.
//
// Uso: router.get('/dashboard', requireActiveSubscription, requireFeature('analytics'), handler)
//
// Features disponibles (definidas en checkLimits):
//   analytics | ai_agent | api_access | multi_admin | custom_branding |
//   wompi_payments | export | priority_support | push_notifications |
//   financial_reports | purchase_orders
// ─────────────────────────────────────────────────────────────────
function requireFeature(feature) {
  return (req, res, next) => {
    const sub = req.subscription;

    if (!sub?.allowed) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'Suscripción no activa.',
        status: sub?.status ?? 'expired',
      });
    }

    if (!sub.features?.[feature]) {
      return res.status(403).json({
        error: 'feature_not_included',
        feature,
        message: `La función "${feature}" no está disponible en tu plan actual.`,
        current_plan: sub.plan,
        upgrade_required: true,
      });
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────
// requireLimit
// Sincroniza contadores reales, luego verifica que no se haya
// superado el límite del recurso indicado.
//
// BUG CORREGIDO: después de syncUsage se recarga req.subscription
// para que los contadores reflejen el estado real en DB.
//
// Uso: router.post('/', requireActiveSubscription, requireLimit('products'), createProduct, syncUsageAfter)
//
// Recursos disponibles (definidos en checkLimits):
//   products | users | categories | providers | banners | api_keys | monthly_sales
// ─────────────────────────────────────────────────────────────────
function requireLimit(resource) {
  return async (req, res, next) => {
    const adminId = getAdminId(req);
    if (!adminId) return next();

    // 1. Sincronizar contadores reales en DB
    try {
      await subscriptionService.syncUsage(adminId);
    } catch (syncErr) {
      console.error('[requireLimit] syncUsage falló, continuando con datos anteriores:', syncErr.message);
    }

    // 2. Recargar límites frescos (CRÍTICO: req.subscription puede estar desactualizado)
    let sub;
    try {
      sub = await subscriptionService.checkLimits(adminId);
      req.subscription = sub; // actualizar para middlewares siguientes
    } catch (err) {
      console.error('[requireLimit] checkLimits falló:', err.message);
      // Si no podemos verificar, preferimos dejar pasar y loguear
      return next();
    }

    // 3. Verificar suscripción activa
    if (!sub?.allowed) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'Suscripción no activa.',
        status: sub?.status ?? 'expired',
      });
    }

    // 4. Verificar límite del recurso
    const limit = sub.limits?.[resource];

    if (!limit) {
      // El recurso no tiene límite definido en este plan → permitir
      return next();
    }

    if (!limit.ok) {
      const maxLabel = limit.max === -1 ? '∞' : limit.max;
      return res.status(403).json({
        error: 'limit_reached',
        resource,
        message: `Has alcanzado el límite de "${resource}" en tu plan (${limit.used}/${maxLabel}).`,
        used: limit.used,
        max: limit.max,
        current_plan: sub.plan,
        upgrade_required: true,
      });
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────
// syncUsageAfter
// Ejecuta syncUsage de forma asíncrona SIN bloquear la respuesta.
// Colocar al final de la cadena de middlewares, después del handler.
//
// Uso: router.post('/', ..., createProduct, syncUsageAfter)
// ─────────────────────────────────────────────────────────────────
function syncUsageAfter(req, res, next) {
  const adminId = getAdminId(req);
  if (adminId) {
    subscriptionService
      .syncUsage(adminId)
      .catch(err => console.error('[syncUsageAfter] Error:', err.message));
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// refreshSubscription
// Fuerza la recarga de req.subscription en mitad de una cadena.
// Útil si un handler previo creó/eliminó recursos y quieres que
// el siguiente middleware vea los límites actualizados.
// ─────────────────────────────────────────────────────────────────
async function refreshSubscription(req, res, next) {
  try {
    const adminId = getAdminId(req);
    if (adminId) {
      req.subscription = await subscriptionService.checkLimits(adminId);
    }
    next();
  } catch (err) {
    console.error('[refreshSubscription] Error:', err.message);
    next();
  }
}

// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────
module.exports = {
  attachSubscription,
  requireActiveSubscription,
  requireFeature,
  requireLimit,
  syncUsageAfter,
  refreshSubscription,
};