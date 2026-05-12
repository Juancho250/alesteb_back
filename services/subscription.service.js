// services/subscription.service.js
const { pool } = require('../config/db');

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Genera número de factura único: SUB-YYYYMM-XXXXX
 */
function generateInvoiceNumber() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rand = Math.floor(10000 + Math.random() * 90000);
  return `SUB-${ym}-${rand}`;
}

/**
 * Calcula fecha de fin de período según ciclo
 */
function addPeriod(date, cycle) {
  const d = new Date(date);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────
// OBTENER SUSCRIPCIÓN ACTIVA DEL ADMIN
// ─────────────────────────────────────────────────────────────────
async function getSubscriptionByAdmin(adminId) {
  const { rows } = await pool.query(
    `SELECT s.*, 
            sp.name AS plan_name, sp.slug AS plan_slug,
            sp.max_products, sp.max_users, sp.max_admins,
            sp.max_monthly_sales, sp.max_api_keys,
            sp.max_categories, sp.max_banners, sp.max_providers,
            sp.storage_mb, sp.price_monthly, sp.price_yearly,
            sp.has_analytics, sp.has_ai_agent, sp.has_api_access,
            sp.has_multi_admin, sp.has_custom_branding,
            sp.has_wompi_payments, sp.has_export,
            sp.has_priority_support, sp.has_push_notifications,
            sp.has_financial_reports, sp.has_purchase_orders,
            sp.has_discount_system, sp.color,
            su.products_count, su.users_count, su.categories_count,
            su.providers_count, su.banners_count, su.api_keys_count,
            su.monthly_sales_count, su.storage_used_mb
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     LEFT JOIN subscription_usage su ON su.admin_id = s.admin_id
     WHERE s.admin_id = $1`,
    [adminId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────
// CREAR SUSCRIPCIÓN CON TRIAL
// ─────────────────────────────────────────────────────────────────
async function createTrialSubscription(adminId, planSlug = 'basic', createdBy = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener plan
    const planRes = await client.query(
      'SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true',
      [planSlug]
    );
    if (!planRes.rows.length) throw new Error(`Plan '${planSlug}' no encontrado`);
    const plan = planRes.rows[0];

    const today = new Date().toISOString().split('T')[0];
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + (plan.trial_days || 30));
    const trialEndStr = trialEnd.toISOString().split('T')[0];

    // Crear suscripción
    const subRes = await client.query(
      `INSERT INTO subscriptions
         (admin_id, plan_id, status, billing_cycle,
          trial_start, trial_end,
          current_period_start, current_period_end,
          next_billing_date, amount_due, created_by)
       VALUES ($1, $2, 'trial', 'monthly', $3, $4, $3, $4, $4, $5, $6)
       ON CONFLICT (admin_id) DO UPDATE
         SET plan_id = EXCLUDED.plan_id,
             status = EXCLUDED.status,
             trial_start = EXCLUDED.trial_start,
             trial_end = EXCLUDED.trial_end,
             current_period_start = EXCLUDED.current_period_start,
             current_period_end = EXCLUDED.current_period_end,
             next_billing_date = EXCLUDED.next_billing_date,
             amount_due = EXCLUDED.amount_due,
             updated_at = now()
       RETURNING *`,
      [adminId, plan.id, today, trialEndStr, plan.price_monthly, createdBy || adminId]
    );

    // Inicializar usage
    await client.query(
      `INSERT INTO subscription_usage (admin_id)
       VALUES ($1)
       ON CONFLICT (admin_id) DO NOTHING`,
      [adminId]
    );

    // Log de cambio
    await client.query(
      `INSERT INTO subscription_plan_changes
         (subscription_id, admin_id, to_plan_id, to_status, reason, changed_by)
       VALUES ($1, $2, $3, 'trial', 'Inicio de suscripción trial', $4)`,
      [subRes.rows[0].id, adminId, plan.id, createdBy || adminId]
    );

    await client.query('COMMIT');
    return subRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// ACTIVAR SUSCRIPCIÓN (después de pago exitoso)
// ─────────────────────────────────────────────────────────────────
async function activateSubscription(adminId, {
  planSlug,
  billingCycle = 'monthly',
  paymentMethod,
  paymentReference,
  wompiTransactionId,
  couponCode = null,
  changedBy = null
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      'SELECT * FROM subscription_plans WHERE slug = $1',
      [planSlug]
    );
    if (!planRes.rows.length) throw new Error('Plan no encontrado');
    const plan = planRes.rows[0];

    const basePrice = billingCycle === 'yearly'
      ? (plan.price_yearly || plan.price_monthly * 12)
      : plan.price_monthly;

    // Validar cupón si aplica
    let coupon = null;
    let discountAmount = 0;
    let freeMonths = 0;

    if (couponCode) {
      const cRes = await client.query(
        `SELECT * FROM subscription_coupons
         WHERE code = $1 AND is_active = true
           AND (valid_until IS NULL OR valid_until > now())
           AND (max_uses IS NULL OR times_used < max_uses)`,
        [couponCode.toUpperCase()]
      );
      if (cRes.rows.length) {
        coupon = cRes.rows[0];

        // Validar que aplica al plan
        if (coupon.applicable_plans && !coupon.applicable_plans.includes(plan.id)) {
          throw new Error('Este cupón no aplica al plan seleccionado');
        }

        if (coupon.coupon_type === 'percentage') {
          discountAmount = (basePrice * coupon.discount_value) / 100;
        } else if (coupon.coupon_type === 'fixed') {
          discountAmount = Math.min(coupon.discount_value, basePrice);
        } else if (coupon.coupon_type === 'free_months') {
          freeMonths = coupon.free_months;
          discountAmount = plan.price_monthly * freeMonths;
        } else if (coupon.coupon_type === 'full_free') {
          discountAmount = basePrice;
        }
      }
    }

    const today = new Date().toISOString().split('T')[0];
    let periodEnd = addPeriod(today, billingCycle);

    // Si tiene meses gratis, extender período
    if (freeMonths > 0) {
      const extended = new Date(periodEnd);
      extended.setMonth(extended.getMonth() + freeMonths);
      periodEnd = extended.toISOString().split('T')[0];
    }

    const finalAmount = Math.max(0, basePrice - discountAmount);

    // Actualizar suscripción
    const subRes = await client.query(
      `UPDATE subscriptions SET
         plan_id = $1,
         status = 'active',
         billing_cycle = $2,
         current_period_start = $3,
         current_period_end = $4,
         next_billing_date = $4,
         amount_due = $5,
         trial_start = NULL,
         trial_end = NULL,
         cancelled_at = NULL,
         cancel_at_period_end = false,
         coupon_id = $6,
         discount_applied = $7,
         updated_at = now()
       WHERE admin_id = $8
       RETURNING *`,
      [plan.id, billingCycle, today, periodEnd,
       plan.price_monthly, coupon?.id || null, discountAmount, adminId]
    );

    if (!subRes.rows.length) throw new Error('Suscripción no encontrada para este admin');
    const sub = subRes.rows[0];

    // Crear factura pagada
    const invoiceNumber = generateInvoiceNumber();
    const invoiceRes = await client.query(
      `INSERT INTO subscription_invoices
         (subscription_id, admin_id, plan_id, invoice_number, billing_cycle,
          subtotal, discount_amount, total, status,
          payment_method, payment_reference, wompi_transaction_id,
          period_start, period_end, due_date, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', $9, $10, $11, $12, $13, $14, now())
       RETURNING *`,
      [sub.id, adminId, plan.id, invoiceNumber, billingCycle,
       basePrice, discountAmount, finalAmount,
       paymentMethod, paymentReference, wompiTransactionId,
       today, periodEnd, today]
    );

    // Registrar uso de cupón
    if (coupon) {
      await client.query(
        `INSERT INTO subscription_coupon_usage
           (coupon_id, admin_id, subscription_id, invoice_id, discount_applied)
         VALUES ($1, $2, $3, $4, $5)`,
        [coupon.id, adminId, sub.id, invoiceRes.rows[0].id, discountAmount]
      );
      await client.query(
        'UPDATE subscription_coupons SET times_used = times_used + 1 WHERE id = $1',
        [coupon.id]
      );
    }

    // Log
    await client.query(
      `INSERT INTO subscription_plan_changes
         (subscription_id, admin_id, to_plan_id, to_status, reason, changed_by)
       VALUES ($1, $2, $3, 'active', 'Pago procesado', $4)`,
      [sub.id, adminId, plan.id, changedBy || adminId]
    );

    await client.query('COMMIT');
    return { subscription: sub, invoice: invoiceRes.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// CANCELAR SUSCRIPCIÓN
// ─────────────────────────────────────────────────────────────────
async function cancelSubscription(adminId, reason = '', cancelNow = false, changedBy = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const status = cancelNow ? 'cancelled' : 'active';
    const res = await client.query(
      `UPDATE subscriptions SET
         status = $1,
         cancel_at_period_end = $2,
         cancelled_at = CASE WHEN $3 THEN now() ELSE NULL END,
         cancellation_reason = $4,
         updated_at = now()
       WHERE admin_id = $5
       RETURNING *`,
      [status, !cancelNow, cancelNow, reason, adminId]
    );

    if (!res.rows.length) throw new Error('Suscripción no encontrada');

    await client.query(
      `INSERT INTO subscription_plan_changes
         (subscription_id, admin_id, to_plan_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [res.rows[0].id, adminId, res.rows[0].plan_id,
       'active', status,
       reason || 'Cancelación solicitada', changedBy || adminId]
    );

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// CAMBIAR PLAN (upgrade / downgrade)
// ─────────────────────────────────────────────────────────────────
async function changePlan(adminId, newPlanSlug, changedBy = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      'SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true',
      [newPlanSlug]
    );
    if (!planRes.rows.length) throw new Error('Plan no encontrado');
    const plan = planRes.rows[0];

    const subRes = await client.query(
      'SELECT * FROM subscriptions WHERE admin_id = $1', [adminId]
    );
    if (!subRes.rows.length) throw new Error('Suscripción no encontrada');
    const sub = subRes.rows[0];

    await client.query(
      `UPDATE subscriptions SET
         plan_id = $1,
         amount_due = $2,
         updated_at = now()
       WHERE admin_id = $3`,
      [plan.id, plan.price_monthly, adminId]
    );

    await client.query(
      `INSERT INTO subscription_plan_changes
         (subscription_id, admin_id, from_plan_id, to_plan_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $5, 'Cambio de plan', $6)`,
      [sub.id, adminId, sub.plan_id, plan.id, sub.status, changedBy || adminId]
    );

    await client.query('COMMIT');
    return await getSubscriptionByAdmin(adminId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// VERIFICAR LÍMITES (devuelve objeto con can_* flags)
// ─────────────────────────────────────────────────────────────────
async function checkLimits(adminId) {
  const sub = await getSubscriptionByAdmin(adminId);
  if (!sub) return { allowed: false, reason: 'Sin suscripción' };

  const isActive = ['trial', 'active', 'past_due'].includes(sub.status);
  if (!isActive) return { allowed: false, reason: `Suscripción ${sub.status}` };

  const within = (used, max) => max === -1 || used < max;

  return {
    allowed: true,
    status: sub.status,
    plan: sub.plan_slug,
    trial_ends: sub.trial_end,
    limits: {
      products:      { used: sub.products_count || 0,      max: sub.max_products,      ok: within(sub.products_count, sub.max_products) },
      users:         { used: sub.users_count || 0,         max: sub.max_users,          ok: within(sub.users_count, sub.max_users) },
      categories:    { used: sub.categories_count || 0,    max: sub.max_categories,     ok: within(sub.categories_count, sub.max_categories) },
      providers:     { used: sub.providers_count || 0,     max: sub.max_providers,      ok: within(sub.providers_count, sub.max_providers) },
      banners:       { used: sub.banners_count || 0,       max: sub.max_banners,         ok: within(sub.banners_count, sub.max_banners) },
      api_keys:      { used: sub.api_keys_count || 0,      max: sub.max_api_keys,        ok: within(sub.api_keys_count, sub.max_api_keys) },
      monthly_sales: { used: sub.monthly_sales_count || 0, max: sub.max_monthly_sales,   ok: within(sub.monthly_sales_count, sub.max_monthly_sales) },
    },
    features: {
      analytics:          sub.has_analytics,
      ai_agent:           sub.has_ai_agent,
      api_access:         sub.has_api_access,
      multi_admin:        sub.has_multi_admin,
      custom_branding:    sub.has_custom_branding,
      wompi_payments:     sub.has_wompi_payments,
      export:             sub.has_export,
      priority_support:   sub.has_priority_support,
      push_notifications: sub.has_push_notifications,
      financial_reports:  sub.has_financial_reports,
      purchase_orders:    sub.has_purchase_orders,
    }
  };
}

// ─────────────────────────────────────────────────────────────────
// ACTUALIZAR CONTADORES DE USO
// ─────────────────────────────────────────────────────────────────
async function syncUsage(adminId) {
  await pool.query(
    `INSERT INTO subscription_usage (admin_id,
       products_count, users_count, categories_count,
       providers_count, banners_count, api_keys_count,
       monthly_sales_count, updated_at)
     SELECT
       $1,
       (SELECT COUNT(*) FROM products WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM users WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM categories WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM providers WHERE owner_admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM banners WHERE created_by IN (SELECT id FROM users WHERE owner_admin_id = $1 OR id = $1)),
       (SELECT COUNT(*) FROM api_keys WHERE admin_id = $1 AND is_active = true),
       (SELECT COUNT(*) FROM sales
        WHERE owner_admin_id = $1
          AND DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', CURRENT_DATE)),
       now()
     ON CONFLICT (admin_id) DO UPDATE SET
       products_count      = EXCLUDED.products_count,
       users_count         = EXCLUDED.users_count,
       categories_count    = EXCLUDED.categories_count,
       providers_count     = EXCLUDED.providers_count,
       banners_count       = EXCLUDED.banners_count,
       api_keys_count      = EXCLUDED.api_keys_count,
       monthly_sales_count = EXCLUDED.monthly_sales_count,
       updated_at          = now()`,
    [adminId]
  );
}

// ─────────────────────────────────────────────────────────────────
// CRON: verificar suscripciones vencidas (llamar diariamente)
// ─────────────────────────────────────────────────────────────────
async function processExpiredSubscriptions() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Trial expirado → suspended
    const trials = await client.query(
      `UPDATE subscriptions SET status = 'suspended', updated_at = now()
       WHERE status = 'trial' AND trial_end < CURRENT_DATE
       RETURNING admin_id, id, plan_id`
    );

    // Active con período vencido → past_due
    const pastDue = await client.query(
      `UPDATE subscriptions SET
         status = 'past_due',
         grace_expires_at = now() + (grace_period_days || ' days')::interval,
         updated_at = now()
       WHERE status = 'active'
         AND current_period_end < CURRENT_DATE
         AND cancel_at_period_end = false
       RETURNING admin_id, id, plan_id`
    );

    // Grace period expirado → suspended
    const suspended = await client.query(
      `UPDATE subscriptions SET status = 'suspended', updated_at = now()
       WHERE status = 'past_due' AND grace_expires_at < now()
       RETURNING admin_id, id, plan_id`
    );

    // Canceladas al fin del período
    const cancelled = await client.query(
      `UPDATE subscriptions SET
         status = 'cancelled',
         cancelled_at = now(),
         updated_at = now()
       WHERE status = 'active'
         AND cancel_at_period_end = true
         AND current_period_end < CURRENT_DATE
       RETURNING admin_id, id, plan_id`
    );

    await client.query('COMMIT');

    return {
      trials_expired:  trials.rowCount,
      moved_to_pastdue: pastDue.rowCount,
      suspended:       suspended.rowCount,
      cancelled:       cancelled.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getSubscriptionByAdmin,
  createTrialSubscription,
  activateSubscription,
  cancelSubscription,
  changePlan,
  checkLimits,
  syncUsage,
  processExpiredSubscriptions,
  generateInvoiceNumber,
};