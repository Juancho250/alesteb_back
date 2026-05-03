// ─── AGREGAR ESTA FUNCIÓN al archivo: controllers/analytics.controller.js ────
// Pégala justo después de exports.getSummary
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// GET /api/analytics/detail?period=today|week|month&page=/ruta&search=texto
// Devuelve: visitas desglosadas por página → sesión → usuario
// ════════════════════════════════════════════════════════════════════════════
exports.getDetail = async (req, res) => {
  try {
    await ensureTable();

    const interval  = periodToInterval(req.query.period);
    const pageFilter = req.query.page   ?? null;   // e.g. "/productos"
    const search     = req.query.search ?? null;   // busca en page_label o session_id

    // ── 1. Resumen por página ─────────────────────────────────────────────
    const { rows: pageRows } = await db.query(`
      SELECT
        pv.page,
        COALESCE(MAX(pv.page_label), pv.page)          AS label,
        COUNT(*)::int                                   AS total_views,
        COUNT(DISTINCT pv.session_id)::int              AS unique_sessions,
        COUNT(DISTINCT pv.user_id)::int                 AS logged_in_users,
        COUNT(DISTINCT CASE WHEN pv.user_id IS NULL THEN pv.session_id END)::int AS anonymous_sessions,
        COALESCE(ROUND(AVG(pv.time_on_prev))::int, 0)  AS avg_time_sec,
        COALESCE(ROUND(100.0 *
          COUNT(*) FILTER (WHERE pv.time_on_prev < 10 OR pv.time_on_prev IS NULL)
          / NULLIF(COUNT(*), 0)
        )::int, 0)                                      AS bounce_rate,
        MIN(pv.created_at)                              AS first_visit,
        MAX(pv.created_at)                              AS last_visit,
        COUNT(*) FILTER (WHERE pv.device = 'Móvil')::int      AS mobile_count,
        COUNT(*) FILTER (WHERE pv.device = 'Escritorio')::int AS desktop_count,
        COUNT(*) FILTER (WHERE pv.device = 'Tablet')::int     AS tablet_count
      FROM page_views pv
      WHERE pv.created_at >= NOW() - ($1)::INTERVAL
        AND ($2::text IS NULL OR pv.page = $2)
        AND ($3::text IS NULL
             OR pv.page_label ILIKE '%' || $3 || '%'
             OR pv.session_id ILIKE '%' || $3 || '%')
      GROUP BY pv.page
      ORDER BY total_views DESC
    `, [interval, pageFilter, search]);

    // ── 2. Sesiones de cada página (con usuario si existe) ────────────────
    // Para evitar N+1, hacemos una sola query con array de páginas
    const targetPages = pageFilter
      ? [pageFilter]
      : pageRows.slice(0, 15).map(r => r.page);   // máximo 15 páginas

    let sessionRows = [];
    if (targetPages.length > 0) {
      const { rows } = await db.query(`
        SELECT
          pv.page,
          pv.session_id,
          pv.device,
          COALESCE(pv.page_label, pv.page)                      AS page_label,
          pv.referrer_label,
          pv.time_on_prev                                        AS time_on_page_sec,
          pv.created_at                                          AS visited_at,
          pv.screen_w,
          pv.screen_h,
          -- Usuario autenticado (puede ser NULL)
          u.id                                                   AS user_id,
          u.name                                                 AS user_name,
          u.email                                                AS user_email,
          u.phone                                                AS user_phone,
          u.city                                                 AS user_city,
          -- ¿Esta sesión terminó en compra?
          EXISTS(
            SELECT 1 FROM page_views conv
            WHERE conv.session_id = pv.session_id
              AND conv.page IN ('/order-success', '/pedido-exitoso')
          )                                                      AS converted,
          -- Total de páginas en esa sesión
          COUNT(*) OVER (PARTITION BY pv.session_id)::int       AS session_page_count,
          -- Duración estimada de sesión
          EXTRACT(EPOCH FROM (
            MAX(pv.created_at) OVER (PARTITION BY pv.session_id) -
            MIN(pv.created_at) OVER (PARTITION BY pv.session_id)
          ))::int                                                AS session_duration_sec
        FROM page_views pv
        LEFT JOIN users u ON u.id = pv.user_id
        WHERE pv.created_at >= NOW() - ($1)::INTERVAL
          AND pv.page = ANY($2)
          AND ($3::text IS NULL
               OR pv.session_id ILIKE '%' || $3 || '%'
               OR u.name       ILIKE '%' || $3 || '%'
               OR u.email      ILIKE '%' || $3 || '%')
        ORDER BY pv.created_at DESC
        LIMIT 500
      `, [interval, targetPages, search]);

      sessionRows = rows;
    }

    // ── 3. Agrupar sesiones bajo cada página ──────────────────────────────
    const sessionsByPage = {};
    for (const row of sessionRows) {
      if (!sessionsByPage[row.page]) sessionsByPage[row.page] = [];
      sessionsByPage[row.page].push({
        sessionId:         row.session_id,
        device:            row.device,
        referrer:          row.referrer_label ?? null,
        timeOnPage:        row.time_on_page_sec,
        visitedAt:         row.visited_at,
        screenW:           row.screen_w,
        screenH:           row.screen_h,
        converted:         row.converted,
        sessionPageCount:  row.session_page_count,
        sessionDuration:   row.session_duration_sec,
        // Datos de usuario (null si anónimo)
        user: row.user_id ? {
          id:    row.user_id,
          name:  row.user_name,
          email: row.user_email,
          phone: row.user_phone,
          city:  row.user_city,
        } : null,
      });
    }

    // ── 4. Merge ──────────────────────────────────────────────────────────
    const pages = pageRows.map(p => ({
      page:              p.page,
      label:             p.label,
      totalViews:        p.total_views,
      uniqueSessions:    p.unique_sessions,
      loggedInUsers:     p.logged_in_users,
      anonymousSessions: p.anonymous_sessions,
      avgTimeSec:        p.avg_time_sec,
      bounceRate:        p.bounce_rate,
      firstVisit:        p.first_visit,
      lastVisit:         p.last_visit,
      devices: {
        mobile:   p.mobile_count,
        desktop:  p.desktop_count,
        tablet:   p.tablet_count,
      },
      sessions: sessionsByPage[p.page] ?? [],
    }));

    res.json({ success: true, pages });

  } catch (err) {
    console.error("[analytics.getDetail]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};