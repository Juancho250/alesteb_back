# AURA 2070 - Inventario backend ALESTEB

Fecha de revision: 2026-07-14

Este documento resume lo verificado en codigo para continuar AURA 2070 sin asumir DDL no confirmado. No contiene datos personales ni valores reales de negocio.

## Resumen ejecutivo

- Backend principal: Node.js con Express 5.
- Base de datos: PostgreSQL mediante `pg`.
- Entrada web: `server.js` carga `app.js`.
- Proceso residente: `worker.js` ejecuta crons/workers y no levanta el servidor HTTP.
- Registro de rutas: directo en `app.js` con `safeRequire`.
- AURA actual existe bajo `/api/aura` y ya esta separada de `/api/agent`.
- `/api/agent` hoy funciona como adaptador compatible hacia AURA, pero aun existen servicios legacy de Agent/Groq con herramientas SQL en `services/agent.service.js` y `services/agent.tools.js`.
- Multi-tenant se basa en `owner_admin_id`; para subusuarios el tenant real es `req.user.owner_admin_id || req.user.id`.
- AURA usa un tenant mas estricto mediante `req.auraAdminId`, resuelto por `middleware/aura.middleware.js`.

## Conexion PostgreSQL

Archivo verificado: `config/db.js`.

- Usa `Pool` de `pg`.
- Usa `process.env.NEON_DB_URL` como `connectionString`.
- Configura SSL con `rejectUnauthorized: isProduction`.
- Limita el pool con `DB_POOL_MAX || 10`.
- Ejecuta `SELECT 1` al iniciar para validar conexion.
- Si falla la conexion inicial, llama `process.exit(1)`.
- `server.js` hace cierre ordenado con `db.close()` en `SIGINT` y `SIGTERM`.

## Queries y transacciones

Patrones verificados:

- Queries simples: `db.query(sql, params)`.
- Transacciones: `const client = await db.connect()`, luego `BEGIN`, `COMMIT`, `ROLLBACK`, `client.release()`.
- Inventario, ventas, proveedores, finanzas, persistencia de AURA y notificaciones usan consultas parametrizadas.
- `services/auraPersistence.service.js` usa transaccion para cerrar ejecuciones de AURA y actualizar consumo diario de forma idempotente.
- `services/auraContext.service.js` usa consultas read-only parametrizadas y limites de 10 filas para listas operativas.

## Autenticacion

Archivo verificado: `middleware/auth.middleware.js`.

Flujo JWT:

- Requiere header `Authorization: Bearer <token>`.
- Verifica JWT con `JWT_SECRET`, `issuer: alesteb-api` y `audience: alesteb-client`.
- Consulta `users` para validar existencia, actividad y `owner_admin_id`.
- Setea `req.user` con `id`, `email`, `name`, `roles`, `owner_admin_id`.
- Los roles vienen del token y se normalizan a arreglo.

Flujo API key:

- `apiKeyAuth` lee `X-API-Key`.
- Hashea la llave con SHA-256.
- Consulta `api_keys`, `users`, limites de origen, expiracion y actividad.
- Setea `req.apiKey` y `req.tenant`.
- Registra uso en `api_keys` y `api_key_logs` de forma asincrona.

## Permisos y roles

Roles reales observados por codigo:

- `superadmin`: bypass en `requireRole`; acceso a rutas de administracion global.
- `admin`: administrador raiz del negocio.
- `gerente`: rol operativo con permisos de gestion en rutas protegidas por manager.
- `user`: cliente/usuario final usado en pedidos, historial y conteos de clientes.

Middlewares relevantes:

- `requireRole(roles)`: valida rol, con bypass de superadmin.
- `requireAdmin`: requiere `admin`.
- `requireManager`: requiere `admin` o `gerente`.
- `requireSuperAdmin`: requiere `superadmin`.
- `requireFinancePin`: valida sesion PIN para rutas financieras.

## Multi-tenant y owner_admin_id

Archivo verificado: `middleware/adminScope.js`.

- `req.isSuperAdmin = req.user.roles.includes("superadmin")`.
- `req.adminId = req.user.owner_admin_id || req.user.id`.
- Para superadmin se permite bypass en helpers de scope.
- Helpers existentes:
  - `scopeByCreator`
  - `scopeByOwner`
  - `scopeByAdminId`
  - `scopeByUserId`
  - `assertOwnership`
  - `buildUpdate`
- Tablas conocidas por ownership en codigo: `products`, `categories`, `providers`, `sales`, `expenses`, `discounts`, `purchase_orders`, `invoices`, `users`, `api_keys`, `banners`, `attribute_types`, `agent_conversations`, `push_subscriptions`, `subscriptions`, `subscription_invoices`.

Regla especifica de AURA:

- `middleware/aura.middleware.js` crea `req.auraAdminId`.
- Usuario no superadmin: `req.auraAdminId = req.adminId`.
- Superadmin: exige header `X-Tenant-Admin-Id`.
- Valida que el tenant exista como admin raiz activo: `users.owner_admin_id IS NULL` y rol `admin`.

## Suscripciones

Archivos verificados:

- `middleware/subscription.middleware.js`
- `routes/subscription.routes.js`

Flujo:

- `getSubscriptionData(adminId)` consulta `subscriptions`, `subscription_plans` y `subscription_usage`.
- Cache en memoria por 5 minutos.
- Estados activos para feature gate: `trial`, `active`, `past_due`.
- `requireFeature(feature)` permite superadmin, resuelve admin raiz y exige plan activo con feature.
- `requireLimit(resource)` valida limites de productos, usuarios, API keys, categorias, banners, proveedores y ventas mensuales.
- `requireActiveSubscription` falla abierto ante errores internos para no tumbar funcionalidades criticas.

Feature gate de AURA:

- `/api/aura` y `/api/agent` usan `requireFeature("has_ai_agent")`.

## Endpoints relevantes

Montajes verificados en `app.js`:

- `/api/auth`
- `/api/superadmin`
- `/api/users`
- `/api/roles`
- `/api/api-keys`
- `/api/admin-profile`
- `/api/subscriptions`
- `/api/stats`
- `/api/providers`
- `/api/finance`
- `/api/products`
- `/api/categories`
- `/api/sales`
- `/api/discounts`
- `/api/banners`
- `/api/notifications`
- `/api` para variantes y reviews
- `/api/chat`
- `/api/agent`
- `/api/aura`
- `/api/wompi`
- `/api/payment-accounts`
- `/api/analytics`
- `/api/contact`
- `/api/inventory`
- `/api/procurement`
- `/api/finance-pin`
- `/public-api/v1`

AURA:

- `GET /api/aura/conversations`
- `GET /api/aura/conversations/:id`
- `DELETE /api/aura/conversations/:id`
- `GET /api/aura/usage`
- `POST /api/aura/chat`

Agent:

- `POST /api/agent/chat`
- `POST /api/agent/confirm`
- `GET /api/agent/conversations`
- `GET /api/agent/conversations/:id`
- `DELETE /api/agent/conversations/:id`

Analytics:

- `POST /api/analytics/pageview` publico.
- `GET /api/analytics/summary` con auth/adminScope.
- `GET /api/analytics/detail` con auth/adminScope.

Ventas:

- `GET /api/sales`
- `GET /api/sales/user/history`
- `GET /api/sales/user/stats`
- `POST /api/sales`
- `POST /api/sales/checkout`
- `GET /api/sales/:id`
- pagos, cancelacion, entrega, cronograma de cuotas y comprobantes.

Inventario:

- `GET /api/inventory/products`
- `GET /api/inventory/availability`
- `GET /api/inventory/ledger`
- `GET /api/inventory/valuation`
- rutas de recepcion, ajustes, daños, devoluciones, stock inicial y reservas.

Procurement:

- `GET /api/procurement/pending`
- `GET /api/procurement/purchase-orders`
- `GET /api/procurement/sales-awaiting`
- `POST /api/procurement/group-purchase-order`
- `POST /api/procurement/purchase-orders/:id/receive`
- `POST /api/procurement/:id/cancel`

## Estructura IA actual

AURA:

- `routes/aura.routes.js`: auth, adminScope, manager, subscription feature, tenant AURA, rate limit.
- `controllers/aura.controller.js`: valida mensaje, historial, conversationId y serializa respuesta estructurada.
- `services/auraChat.service.js`: orquesta cuota diaria, contexto, llamada OpenAI, persistencia y runs.
- `services/auraContext.service.js`: calcula resumen read-only del negocio.
- `services/auraOpenAI.service.js`: llama OpenAI Responses API y normaliza JSON.
- `services/auraPersistence.service.js`: guarda conversaciones, runs y consumo diario.

Agent:

- `controllers/agent.controller.js` delega a `executeAuraChat`.
- `POST /api/agent/confirm` devuelve `409 AURA_ACTION_EXECUTION_DISABLED`.
- Legacy todavia presente:
  - `services/agent.service.js`
  - `services/agent.tools.js`
  - `services/agent.cron.js`
- Riesgo: los servicios legacy incluyen herramientas SQL y mutaciones condicionadas por confirmacion si alguien los vuelve a importar.

## Contexto read-only de AURA

Archivo verificado: `services/auraContext.service.js`.

Agregados actuales:

- Ventas de hoy.
- Ventas del mes.
- Ticket promedio.
- Pedidos pendientes.
- Productos con bajo stock.
- Productos dormidos sin ventas recientes.
- Productos mas vendidos.
- Ordenes a proveedor pendientes, si existen tablas y columnas esperadas.
- Conteo de clientes recientes, si existe estructura de usuarios/roles.

Reglas actuales:

- Limita listas a 10 filas.
- Usa queries parametrizadas.
- Usa introspeccion de `information_schema` para columnas/tablas opcionales.
- Aplica `owner_admin_id = $1` para tenant normal.
- En AURA se pasa `isSuperAdmin: false` despues de resolver tenant explicito, evitando consultas cross-tenant.

## Integraciones

- OpenAI: `services/auraOpenAI.service.js`, endpoint `https://api.openai.com/v1/responses`, modelo por defecto `gpt-5-mini`.
- Groq legacy: `services/agent.service.js`, no usado por el controller actual de `/api/agent`.
- Wompi: rutas y controladores de pagos.
- WhatsApp/Twilio/Meta: notificaciones y webhooks en `notifications`.
- Web Push: `push_subscriptions` y `services/push.service.js`.
- Storefront API: `/public-api/v1` con API keys.
- Uploads: Cloudinary/multer segun middlewares de carga.

## Workers, crons y procesos residentes

`server.js`:

- Levanta HTTP.
- No inicia crons.

`worker.js`:

- Inicializa DB.
- Ejecuta `startSubscriptionCron`.
- Ejecuta `startInventoryJobs`.
- Ejecuta `startNotificationWorker`.
- Requiere `notificationScheduler`, que programa tareas al cargar.

Crons verificados:

- `services/subscription.cron.js`: vencimiento diario, notificaciones diarias, sincronizacion horaria de uso.
- `services/inventory.jobs.js`: libera reservas expiradas cada minuto; alerta de bajo stock existe pero esta desactivada.
- `services/notification.worker.js`: procesa `notification_queue` cada 5 minutos y recordatorios de credito a las 8 AM.
- `services/notificationScheduler.js`: facturas vencidas, descuentos por vencer, ordenes de compra pendientes, limpieza semanal de push subscriptions inactivas.
- `services/agent.cron.js`: existe, pero no esta cargado por `server.js`, `app.js` ni `worker.js` segun la revision actual.

## Tablas y vistas encontradas

Tablas referenciadas por codigo o migraciones:

- `admin_profiles`
- `agent_conversations`
- `ai_usage_daily`
- `api_key_logs`
- `api_keys`
- `attribute_types`
- `attribute_values`
- `aura_runs`
- `banners`
- `categories`
- `contact_messages`
- `discount_coupons`
- `discount_targets`
- `discounts`
- `expenses`
- `invoices`
- `notification_queue`
- `notification_settings`
- `notification_templates`
- `page_views`
- `payment_accounts`
- `product_images`
- `product_provider_prices`
- `product_variants`
- `products`
- `providers`
- `purchase_order_items`
- `purchase_orders`
- `push_subscriptions`
- `reviews`
- `roles`
- `sale_items`
- `sales`
- `stock_ledger`
- `stock_reservations`
- `subscription_coupons`
- `subscription_invoices`
- `subscription_plans`
- `subscription_usage`
- `subscriptions`
- `user_roles`
- `users`
- `variant_attribute_values`
- `variant_images`

Vistas referenciadas:

- `v_stock_disponible`
- `v_inventory_valuation`
- `v_cashflow_detailed`
- `v_expenses_summary`
- `v_invoices_summary`
- `v_products_full`
- `v_profit_analysis`
- `v_provider_balance`
- `v_sales_full`

Nombre solicitado por negocio:

- `proveedores` no aparece como tabla en codigo; el codigo usa `providers`. Debe confirmarse en DB real si existe algun alias/vista `proveedores`.

## Columnas verificadas mediante codigo

AURA y persistencia:

- `agent_conversations`: `id`, `owner_admin_id`, `user_id`, `messages`, `preview`, `updated_at`.
- `aura_runs`: `id`, `request_id`, `owner_admin_id`, `user_id`, `conversation_id`, `provider`, `model`, `status`, `input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost_usd`, `latency_ms`, `error_code`, `error_message`, `created_at`, `finished_at`.
- `ai_usage_daily`: `owner_admin_id`, `usage_date`, `requests_count`, `input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost_usd`, `updated_at`.

Ventas y pedidos:

- `sales`: `id`, `owner_admin_id`, `user_id`, `customer_id`, `sale_number`, `sale_date`, `total`, `payment_status`, `delivery_status`, `status`, `discount_id`, `created_at`.
- `sale_items`: `id`, `sale_id`, `product_id`, `variant_id`, `quantity`, `unit_price`, `subtotal`, `total_profit`.
- `payment_schedules` y pagos se usan en controladores de credito, pero el esquema exacto requiere confirmacion.

Productos e inventario:

- `products`: `id`, `owner_admin_id`, `category_id`, `default_supplier_id`, `name`, `sku`, `description`, `sale_price`, `purchase_price`, `stock`, `stock_reserved`, `stock_safety`, `min_stock`, `has_variants`, `fulfillment_mode`, `supplier_lead_time_days`, `is_active`, `created_at`.
- `product_variants`: `id`, `product_id`, `sku`, `sale_price`, `stock`, `stock_reserved`, `stock_safety`, `is_active`.
- `product_images`: `id`, `product_id`, `url`, `is_main`, `display_order`.
- `variant_images`: `id`, `variant_id`, `url`, `is_main`, `display_order`.
- `stock_ledger`: `id`, `owner_admin_id`, `product_id`, `variant_id`, `quantity`, `movement_type`, `reason`, `created_at`.
- `stock_reservations`: `id`, `owner_admin_id`, `session_id`, `user_id`, `product_id`, `variant_id`, `quantity`, `status`, `expires_at`, `created_at`.

Usuarios, roles y tenants:

- `users`: `id`, `email`, `password`, `name`, `phone`, `cedula`, `city`, `address`, `is_active`, `is_verified`, `owner_admin_id`, `created_at`, `last_login`.
- `roles`: `id`, `name`.
- `user_roles`: `user_id`, `role_id`.

Suscripciones:

- `subscriptions`: `id`, `admin_id`, `plan_id`, `status`, `starts_at`, `ends_at`, `trial_ends_at`, `current_period_start`, `current_period_end`, `cancel_at_period_end`.
- `subscription_plans`: features como `has_ai_agent`, `has_inventory`, `has_purchase_orders` y limites consultados por middleware.
- `subscription_usage`: contadores usados por limites.
- `subscription_invoices`, `subscription_coupons`: usadas por controllers de suscripcion.

Analytics:

- `page_views`: `id`, `owner_admin_id`, `analytics_key_id`, `visitor_id`, `session_id`, `authenticated_user_id`, `event_type`, `page`, `path`, `product_id`, `page_label`, `referrer`, `referrer_label`, `utm_source`, `utm_medium`, `utm_campaign`, `time_on_prev`, `device`, `screen_w`, `screen_h`, `occurred_at`, `created_at`, `tenant_resolution_status`. La columna legacy `user_id` existe solo como dato no confiable de compatibilidad historica.

Notificaciones:

- `notification_queue`: `id`, `owner_admin_id`, `template_key`, `channel`, `recipient_user_id`, `recipient_phone`, `recipient_email`, `variables`, `status`, `scheduled_at`, `sent_at`, `error`, `attempts`, `created_at`.
- `notification_templates`: `key`, `name`, `channel`, `subject`, `body`, `is_active`.
- `notification_settings`: configuracion WhatsApp/push por tenant.
- `push_subscriptions`: `id`, `user_id`, `owner_admin_id`, `endpoint`, `keys`, `is_active`, `last_used_at`, `created_at`.

Descuentos y campanas:

- `discounts`: `id`, `owner_admin_id`, `type`, `value`, `active`, `starts_at`, `ends_at`, `scope`.
- `discount_targets`: `discount_id`, `target_type`, `target_id`.
- `discount_coupons`: `scope`.

Compras, proveedores y finanzas:

- `providers`: `id`, `owner_admin_id`, `name`, `email`, `phone`, `is_active`.
- `purchase_orders`: `id`, `owner_admin_id`, `provider_id`, `order_number`, `status`, `total_cost`, `expected_delivery_date`, `created_at`.
- `purchase_order_items`: columnas exactas por confirmar.
- `expenses`: `id`, `owner_admin_id`, `purchase_order_id`, `category`, `amount`, `created_at`.
- `invoices`: columnas exactas por confirmar.

## Columnas no verificadas o dependientes de DB real

Debe confirmarse con `scripts/inspect_aura_schema.sql`:

- Tipos reales, nullability, defaults, PK, FK, checks e indices de todas las tablas listadas.
- Existencia real de `aura_runs` y `ai_usage_daily` en cada ambiente.
- Si `agent_conversations.owner_admin_id` ya fue migrada y validada.
- Existencia real de `sales.delivery_status`.
- Existencia real de `purchase_orders.order_number`, `total_cost`, `expected_delivery_date` y FK a `providers`.
- Estructura exacta de `purchase_order_items`, `payment_schedules`, pagos de venta e invoices.
- Definiciones exactas de vistas financieras y de inventario.
- Triggers de inventario/reservas/finanzas si existen.
- Funciones SQL relacionadas con stock, ventas, suscripciones, notificaciones o analitica.
- Si existe tabla/vista `proveedores` ademas de `providers`.

## Riesgos y deuda tecnica relevante

- `config/env.js` actualmente marca `OPENAI_API_KEY` como obligatoria. Si el objetivo es que falte la key sin tumbar el servidor, este archivo contradice esa regla.
- `services/auraContext.service.js` falla toda la respuesta si una consulta de contexto falla; podria degradar por seccion para mas resiliencia.
- Los servicios legacy de Agent/Groq siguen en el repo pero estan marcados como deprecated y fallan cerrado para SQL libre.
- `services/agent.cron.js` existe como deprecated y queda desactivado por defecto con `ENABLE_LEGACY_AGENT_CRON=false`.
- `controllers/analytics.controller.js` ya no crea `page_views` ni indices en runtime; el esquema se mueve a `migrations/2026_07_12_page_views_tenant.sql`.
- `GET /api/analytics/detail` filtra por tenant y ya no selecciona email ni telefono; aun asi, AURA no debe enviar sesiones/usuarios crudos a OpenAI.
- `routes/notifications.routes.js` incluye endpoints de prueba fuera de produccion que pueden hacer broadcast.
- Varias migraciones contienen DDL/DML que no debe ejecutarse durante este inventario.
- El script existente `scripts/inspect-aura-schema.sql` usa guion; este inventario crea `scripts/inspect_aura_schema.sql` con guion bajo para la revision solicitada.

## Confirmacion necesaria en base real

Ejecutar `scripts/inspect_aura_schema.sql` en la base real para confirmar:

- Objetos existentes versus esperados.
- Columnas y tipos reales de ventas, inventario, clientes, suscripciones, analitica, descuentos, notificaciones y AURA.
- PK, FK, constraints e indices aplicados.
- Vistas financieras y definiciones.
- Triggers y funciones relacionadas.
- Conteos aproximados por tabla para dimensionar consultas AURA.
- Presencia de tablas o vistas alternativas como `proveedores`.
