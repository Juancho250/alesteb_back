// src/modules/analytics/analytics.controller.js
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../../platform/database");

const ANALYTICS_WRITE_PERMISSION = "analytics:write";
const RETENTION_DAYS = 180;
const EVENT_TYPES = new Set([
  "page_view",
  "product_view",
  "search",
  "add_to_cart",
  "checkout",
  "order_success",
  "custom",
]);

function detectDevice(ua = "", screenW = 0) {
  if (/mobile|android|iphone|ipod/i.test(ua) || Number(screenW) < 768) return "Movil";
  if (/ipad|tablet/i.test(ua) || (Number(screenW) >= 768 && Number(screenW) < 1024)) return "Tablet";
  return "Escritorio";
}

function periodToInterval(period = "today") {
  if (period === "week") return "7 days";
  if (period === "month") return "30 days";
  return "1 day";
}

function boundedString(value, max = 255) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function safePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePermissions(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasPermission(permissions, permission) {
  return permissions.includes("all") || permissions.includes(permission);
}

function originAllowed(allowedOrigins = [], req) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  const origin = req.headers.origin || req.headers.referer || "";
  return allowedOrigins.some((allowed) => origin.startsWith(allowed));
}

function getAnalyticsKey(req) {
  return (
    req.headers["x-analytics-key"]
    || req.headers["x-store-key"]
    || req.headers["x-api-key"]
    || null
  );
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  return type === "Bearer" && token ? token : null;
}

function normalizePath(value) {
  const raw = boundedString(value, 500);
  if (!raw) return null;
  try {
    const parsed = new URL(raw, "https://storefront.local");
    return `${parsed.pathname || "/"}${parsed.search || ""}`.slice(0, 500);
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

function stripQuery(value) {
  const raw = boundedString(value, 500);
  if (!raw) return null;
  try {
    const parsed = new URL(raw, "https://storefront.local");
    return parsed.origin === "https://storefront.local"
      ? parsed.pathname.slice(0, 500)
      : `${parsed.origin}${parsed.pathname}`.slice(0, 500);
  } catch {
    return raw.split("?")[0].slice(0, 500);
  }
}

function utmFrom(body, path, key) {
  const direct = boundedString(body[key] || body[key.replace("utm_", "utm")], 120);
  if (direct) return direct;
  try {
    const parsed = new URL(path || "/", "https://storefront.local");
    return boundedString(parsed.searchParams.get(key), 120);
  } catch {
    return null;
  }
}

async function resolveTenantFromAnalyticsKey(req) {
  const rawKey = getAnalyticsKey(req);
  if (!rawKey) return null;

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const { rows } = await db.query(
    `SELECT
       ak.id, ak.admin_id, ak.permissions, ak.allowed_origins,
       ak.is_active, ak.expires_at,
       u.is_active AS admin_active
     FROM api_keys ak
     JOIN users u ON u.id = ak.admin_id
     WHERE ak.key_hash = $1
     LIMIT 1`,
    [keyHash]
  );

  const key = rows[0];
  if (!key) {
    const err = new Error("Clave de analitica invalida");
    err.status = 401;
    err.code = "INVALID_ANALYTICS_KEY";
    throw err;
  }
  if (!key.is_active || !key.admin_active) {
    const err = new Error("Clave de analitica inactiva");
    err.status = 403;
    err.code = "ANALYTICS_KEY_INACTIVE";
    throw err;
  }
  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    const err = new Error("Clave de analitica expirada");
    err.status = 403;
    err.code = "ANALYTICS_KEY_EXPIRED";
    throw err;
  }
  if (!originAllowed(key.allowed_origins, req)) {
    const err = new Error("Origen no autorizado para esta clave de analitica");
    err.status = 403;
    err.code = "ANALYTICS_ORIGIN_NOT_ALLOWED";
    throw err;
  }

  const permissions = parsePermissions(key.permissions);
  if (!hasPermission(permissions, ANALYTICS_WRITE_PERMISSION)) {
    const err = new Error("La clave no tiene permiso analytics:write");
    err.status = 403;
    err.code = "ANALYTICS_PERMISSION_REQUIRED";
    throw err;
  }

  return {
    ownerAdminId: Number(key.admin_id),
    analyticsKeyId: key.id,
    source: "analytics_key",
  };
}

async function resolveTenantFromBearer(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "alesteb-api",
      audience: "alesteb-client",
    });
    const { rows } = await db.query(
      `SELECT id, owner_admin_id
       FROM users
       WHERE id = $1 AND is_active = true
       LIMIT 1`,
      [decoded.id]
    );
    const user = rows[0];
    if (!user) return null;
    return {
      ownerAdminId: Number(user.owner_admin_id ?? user.id),
      authenticatedUserId: Number(user.id),
      source: "jwt",
    };
  } catch {
    return null;
  }
}

async function resolveTrustedAnalyticsTenant(req) {
  if (req.apiKey?.adminId) {
    return {
      ownerAdminId: Number(req.apiKey.adminId),
      analyticsKeyId: req.apiKey.id || null,
      source: "public_api_key",
    };
  }

  const fromKey = await resolveTenantFromAnalyticsKey(req);
  if (fromKey) return fromKey;

  const fromJwt = await resolveTenantFromBearer(req);
  if (fromJwt) return fromJwt;

  const err = new Error("Clave de tienda requerida para registrar analitica");
  err.status = 401;
  err.code = "ANALYTICS_TENANT_REQUIRED";
  throw err;
}

async function resolveAuthenticatedUser(req, ownerAdminId, fallbackUserId = null) {
  const token = getBearerToken(req);
  if (!token) return fallbackUserId;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "alesteb-api",
      audience: "alesteb-client",
    });
    const { rows } = await db.query(
      `SELECT id
       FROM users
       WHERE id = $1
         AND is_active = true
         AND (owner_admin_id = $2 OR id = $2)
       LIMIT 1`,
      [decoded.id, ownerAdminId]
    );
    return rows[0]?.id ? Number(rows[0].id) : fallbackUserId;
  } catch {
    return fallbackUserId;
  }
}

async function resolvePrivateAnalyticsTenant(req) {
  if (!req.isSuperAdmin) return req.adminId;
  const tenantId = safePositiveInteger(req.headers["x-tenant-admin-id"] || req.query.tenantAdminId);
  if (!tenantId) {
    const err = new Error("X-Tenant-Admin-Id es requerido para analitica de superadmin");
    err.status = 400;
    err.code = "ANALYTICS_TENANT_REQUIRED";
    throw err;
  }

  const { rows } = await db.query(
    `SELECT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
       AND u.is_active = true
       AND u.owner_admin_id IS NULL
       AND r.name = 'admin'
     LIMIT 1`,
    [tenantId]
  );
  if (!rows.length) {
    const err = new Error("Tenant no encontrado para analitica");
    err.status = 404;
    err.code = "ANALYTICS_TENANT_NOT_FOUND";
    throw err;
  }
  return tenantId;
}

function normalizeEventBody(body) {
  const path = normalizePath(body.path || body.page || "/");
  const eventType = EVENT_TYPES.has(body.event_type || body.eventType)
    ? (body.event_type || body.eventType)
    : "page_view";
  const sessionId = boundedString(body.session_id || body.sessionId, 120);
  const visitorId = boundedString(body.visitor_id || body.visitorId || sessionId, 120);

  return {
    eventType,
    sessionId,
    visitorId,
    path,
    productId: safePositiveInteger(body.product_id || body.productId),
    pageLabel: boundedString(body.page_label || body.pageLabel || path, 255),
    referrer: stripQuery(body.referrer),
    referrerLabel: boundedString(body.referrer_label || body.referrerLabel, 255),
    timeOnPrev: safePositiveInteger(body.time_on_prev || body.timeOnPrevPage),
    device: detectDevice(body.userAgent || body.user_agent || "", body.screenW || body.screen_w),
    screenW: safePositiveInteger(body.screenW || body.screen_w),
    screenH: safePositiveInteger(body.screenH || body.screen_h),
    utmSource: utmFrom(body, path, "utm_source"),
    utmMedium: utmFrom(body, path, "utm_medium"),
    utmCampaign: utmFrom(body, path, "utm_campaign"),
  };
}

function sendAnalyticsError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    message: err.status ? err.message : "Error de analitica",
    code: err.code || "ANALYTICS_ERROR",
  });
}

exports.trackPageview = async (req, res) => {
  try {
    const tenant = await resolveTrustedAnalyticsTenant(req);
    const event = normalizeEventBody(req.body || {});

    if (!event.sessionId || !event.path) {
      return res.status(400).json({
        success: false,
        message: "sessionId y page/path son requeridos",
        code: "INVALID_ANALYTICS_EVENT",
      });
    }

    const authenticatedUserId = await resolveAuthenticatedUser(
      req,
      tenant.ownerAdminId,
      tenant.authenticatedUserId || null
    );

    const { rows } = await db.query(
      `INSERT INTO page_views
         (owner_admin_id, analytics_key_id, visitor_id, session_id,
          authenticated_user_id, event_type, page, path, product_id,
          page_label, referrer, referrer_label, utm_source, utm_medium,
          utm_campaign, time_on_prev, device, screen_w, screen_h,
          occurred_at, created_at, tenant_resolution_status)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW(),'trusted')
       RETURNING id`,
      [
        tenant.ownerAdminId,
        tenant.analyticsKeyId || null,
        event.visitorId,
        event.sessionId,
        authenticatedUserId,
        event.eventType,
        event.path,
        event.path,
        event.productId,
        event.pageLabel,
        event.referrer,
        event.referrerLabel,
        event.utmSource,
        event.utmMedium,
        event.utmCampaign,
        event.timeOnPrev,
        event.device,
        event.screenW,
        event.screenH,
      ]
    );

    return res.json({ success: true, data: { id: rows[0]?.id || null } });
  } catch (err) {
    console.error("[analytics.trackPageview]", err.message);
    return sendAnalyticsError(res, err);
  }
};

exports.getSummary = async (req, res) => {
  try {
    const ownerAdminId = await resolvePrivateAnalyticsTenant(req);
    const interval = periodToInterval(req.query.period);

    const { rows: topPages } = await db.query(
      `SELECT
         COALESCE(path, page) AS page,
         COALESCE(MAX(page_label), COALESCE(path, page)) AS label,
         COUNT(*)::int AS views,
         COUNT(DISTINCT session_id)::int AS sessions,
         COALESCE(ROUND(AVG(time_on_prev))::int, 0) AS avg_time,
         COALESCE(ROUND(
           100.0 * COUNT(*) FILTER (WHERE time_on_prev < 10 OR time_on_prev IS NULL)
           / NULLIF(COUNT(*), 0)
         )::int, 0) AS bounce_rate
       FROM page_views
       WHERE owner_admin_id = $1
         AND occurred_at >= NOW() - ($2)::INTERVAL
       GROUP BY COALESCE(path, page)
       ORDER BY views DESC
       LIMIT 10`,
      [ownerAdminId, interval]
    );

    const { rows: flow } = await db.query(
      `SELECT
         pv1.page_label AS "from",
         pv2.page_label AS "to",
         COUNT(*)::int AS count
       FROM page_views pv1
       JOIN page_views pv2
         ON pv1.owner_admin_id = pv2.owner_admin_id
        AND pv1.session_id = pv2.session_id
        AND pv2.occurred_at > pv1.occurred_at
        AND pv2.occurred_at <= pv1.occurred_at + INTERVAL '10 minutes'
       WHERE pv1.owner_admin_id = $1
         AND pv1.occurred_at >= NOW() - ($2)::INTERVAL
         AND pv1.page_label IS NOT NULL
         AND pv2.page_label IS NOT NULL
         AND pv1.page_label <> pv2.page_label
       GROUP BY pv1.page_label, pv2.page_label
       ORDER BY count DESC
       LIMIT 12`,
      [ownerAdminId, interval]
    );

    const funnelPages = ["/", "/productos", "/productos/detalle", "/carrito", "/checkout", "/order-success"];
    const funnelLabels = ["Inicio", "Productos", "Detalle", "Carrito", "Checkout", "Pedido exitoso"];

    const { rows: funnelRaw } = await db.query(
      `SELECT COALESCE(path, page) AS page, COUNT(DISTINCT session_id)::int AS sessions
       FROM page_views
       WHERE owner_admin_id = $1
         AND occurred_at >= NOW() - ($2)::INTERVAL
         AND COALESCE(path, page) = ANY($3)
       GROUP BY COALESCE(path, page)`,
      [ownerAdminId, interval, funnelPages]
    );

    const funnelMap = Object.fromEntries(funnelRaw.map((row) => [row.page, row.sessions]));
    const funnel = funnelPages.map((page, index) => ({
      name: funnelLabels[index],
      value: funnelMap[page] ?? 0,
    }));

    const { rows: hourly } = await db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('hour', occurred_at), 'HH24:00') AS hora,
         COUNT(*)::int AS "Visitas"
       FROM page_views
       WHERE owner_admin_id = $1
         AND occurred_at >= NOW() - INTERVAL '1 day'
       GROUP BY DATE_TRUNC('hour', occurred_at)
       ORDER BY DATE_TRUNC('hour', occurred_at)`,
      [ownerAdminId]
    );

    const { rows: sessionsRaw } = await db.query(
      `SELECT
         session_id AS id,
         STRING_AGG(page_label, ' -> ' ORDER BY occurred_at) AS path,
         COUNT(*)::int AS pages,
         COALESCE(EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at)))::int, 0) AS duration,
         MAX(device) AS device,
         TO_CHAR(MIN(occurred_at), 'HH24:MI') AS time,
         BOOL_OR(COALESCE(path, page) IN ('/order-success', '/pedido-exitoso')) AS converted
       FROM page_views
       WHERE owner_admin_id = $1
         AND occurred_at >= NOW() - ($2)::INTERVAL
       GROUP BY session_id
       ORDER BY MIN(occurred_at) DESC
       LIMIT 20`,
      [ownerAdminId, interval]
    );

    return res.json({
      success: true,
      topPages,
      flow,
      funnel,
      hourly,
      sessions: sessionsRaw,
    });
  } catch (err) {
    console.error("[analytics.getSummary]", err.message);
    return sendAnalyticsError(res, err);
  }
};

exports.getDetail = async (req, res) => {
  try {
    const ownerAdminId = await resolvePrivateAnalyticsTenant(req);
    const interval = periodToInterval(req.query.period);
    const pageFilter = boundedString(req.query.page, 500);
    const search = boundedString(req.query.search, 120);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows: pageRows } = await db.query(
      `SELECT
         COALESCE(pv.path, pv.page) AS page,
         COALESCE(MAX(pv.page_label), COALESCE(pv.path, pv.page)) AS label,
         COUNT(*)::int AS total_views,
         COUNT(DISTINCT pv.session_id)::int AS unique_sessions,
         COUNT(DISTINCT pv.authenticated_user_id)::int AS logged_in_users,
         COUNT(DISTINCT CASE WHEN pv.authenticated_user_id IS NULL THEN pv.session_id END)::int AS anonymous_sessions,
         COALESCE(ROUND(AVG(pv.time_on_prev))::int, 0) AS avg_time_sec,
         COALESCE(ROUND(100.0 *
           COUNT(*) FILTER (WHERE pv.time_on_prev < 10 OR pv.time_on_prev IS NULL)
           / NULLIF(COUNT(*), 0)
         )::int, 0) AS bounce_rate,
         MIN(pv.occurred_at) AS first_visit,
         MAX(pv.occurred_at) AS last_visit,
         COUNT(*) FILTER (WHERE pv.device = 'Movil')::int AS mobile_count,
         COUNT(*) FILTER (WHERE pv.device = 'Escritorio')::int AS desktop_count,
         COUNT(*) FILTER (WHERE pv.device = 'Tablet')::int AS tablet_count
       FROM page_views pv
       WHERE pv.owner_admin_id = $1
         AND pv.occurred_at >= NOW() - ($2)::INTERVAL
         AND ($3::text IS NULL OR COALESCE(pv.path, pv.page) = $3)
         AND ($4::text IS NULL
              OR pv.page_label ILIKE '%' || $4 || '%'
              OR pv.session_id ILIKE '%' || $4 || '%'
              OR pv.visitor_id ILIKE '%' || $4 || '%')
       GROUP BY COALESCE(pv.path, pv.page)
       ORDER BY total_views DESC
       LIMIT $5 OFFSET $6`,
      [ownerAdminId, interval, pageFilter, search, limit, offset]
    );

    const targetPages = pageFilter ? [pageFilter] : pageRows.slice(0, 15).map((row) => row.page);
    let sessionRows = [];
    if (targetPages.length > 0) {
      const { rows } = await db.query(
        `SELECT
           pv.path,
           pv.page,
           pv.session_id,
           pv.visitor_id,
           pv.device,
           COALESCE(pv.page_label, COALESCE(pv.path, pv.page)) AS page_label,
           pv.referrer_label,
           pv.time_on_prev AS time_on_page_sec,
           pv.occurred_at AS visited_at,
           pv.screen_w,
           pv.screen_h,
           u.id AS user_id,
           u.name AS user_name,
           EXISTS(
             SELECT 1
             FROM page_views conv
             WHERE conv.owner_admin_id = pv.owner_admin_id
               AND conv.session_id = pv.session_id
               AND COALESCE(conv.path, conv.page) IN ('/order-success', '/pedido-exitoso')
           ) AS converted,
           COUNT(*) OVER (PARTITION BY pv.owner_admin_id, pv.session_id)::int AS session_page_count,
           EXTRACT(EPOCH FROM (
             MAX(pv.occurred_at) OVER (PARTITION BY pv.owner_admin_id, pv.session_id) -
             MIN(pv.occurred_at) OVER (PARTITION BY pv.owner_admin_id, pv.session_id)
           ))::int AS session_duration_sec
         FROM page_views pv
         LEFT JOIN users u
           ON u.id = pv.authenticated_user_id
          AND (u.owner_admin_id = pv.owner_admin_id OR u.id = pv.owner_admin_id)
         WHERE pv.owner_admin_id = $1
           AND pv.occurred_at >= NOW() - ($2)::INTERVAL
           AND COALESCE(pv.path, pv.page) = ANY($3)
           AND ($4::text IS NULL
                OR pv.session_id ILIKE '%' || $4 || '%'
                OR pv.visitor_id ILIKE '%' || $4 || '%'
                OR u.name ILIKE '%' || $4 || '%')
         ORDER BY pv.occurred_at DESC
         LIMIT $5 OFFSET $6`,
        [ownerAdminId, interval, targetPages, search, limit, offset]
      );
      sessionRows = rows;
    }

    const sessionsByPage = {};
    for (const row of sessionRows) {
      const pageKey = row.path || row.page;
      if (!sessionsByPage[pageKey]) sessionsByPage[pageKey] = [];
      sessionsByPage[pageKey].push({
        sessionId: row.session_id,
        visitorId: row.visitor_id,
        device: row.device,
        referrer: row.referrer_label ?? null,
        timeOnPage: row.time_on_page_sec,
        visitedAt: row.visited_at,
        screenW: row.screen_w,
        screenH: row.screen_h,
        converted: row.converted,
        sessionPageCount: row.session_page_count,
        sessionDuration: row.session_duration_sec,
        user: row.user_id ? {
          id: row.user_id,
          name: row.user_name,
        } : null,
      });
    }

    const pages = pageRows.map((page) => ({
      page: page.page,
      label: page.label,
      totalViews: page.total_views,
      uniqueSessions: page.unique_sessions,
      loggedInUsers: page.logged_in_users,
      anonymousSessions: page.anonymous_sessions,
      avgTimeSec: page.avg_time_sec,
      bounceRate: page.bounce_rate,
      firstVisit: page.first_visit,
      lastVisit: page.last_visit,
      devices: {
        mobile: page.mobile_count,
        desktop: page.desktop_count,
        tablet: page.tablet_count,
      },
      sessions: sessionsByPage[page.page] ?? [],
    }));

    return res.json({
      success: true,
      pages,
      pagination: { limit, offset, returned: pages.length },
    });
  } catch (err) {
    console.error("[analytics.getDetail]", err.message);
    return sendAnalyticsError(res, err);
  }
};

exports._private = {
  ANALYTICS_WRITE_PERMISSION,
  RETENTION_DAYS,
  detectDevice,
  periodToInterval,
  resolveTrustedAnalyticsTenant,
  resolveAuthenticatedUser,
  normalizeEventBody,
};
