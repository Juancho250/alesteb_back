# AURA 2070 Backend Completion Audit

Fecha de corte: 2026-07-15. Alcance: repositorio local `alesteb_back`. No se accedio a produccion, Neon ni Render durante esta auditoria. Las migraciones AURA 001-010, postflight, idempotencia y auditoria historica de `notification_queue` constan como PASS por validacion previa confirmada por el usuario.

## Estado ejecutivo

Estado actual: **FUNCTIONAL_STAGING**.

El backend tiene nucleo textual, tools read-only, auditoria, cuotas, Growth, imagenes, predictivo y voz implementados. La clasificacion no sube a `FULL_STAGING_VALIDATED` porque los smoke tests HTTP y `scripts/aura_staging_tenant_test.sql` quedaron preparados, pero no se ejecutaron contra un ambiente desplegado en esta tarea.

## Arquitectura verificada

- Runtime: Node.js, Express 5, PostgreSQL mediante `pg`.
- Entrada web: `server.js` -> `app.js`; Socket.IO se inicia en `server.js`.
- Entrada worker general: `worker.js`; imagenes: `worker.ai.js`.
- Seguridad AURA: `auth` -> `adminScope` -> `requireManager` -> suscripcion activa -> `has_ai_agent` -> `resolveAuraTenant`.
- Tenant canonico AURA: `req.auraAdminId`. El modelo nunca recibe ni elige `owner_admin_id`.
- Superadmin: requiere `X-Tenant-Admin-Id` validado para AURA.
- Persistencia: migraciones consolidadas `migrations/aura/001` a `010`.
- IA: Responses API con tools en allowlist, argumentos estrictos y SQL escrito por la aplicacion.

## Inventario por modulo

| Modulo | Estado | Pruebas | Riesgo / proximo paso |
|---|---|---|---|
| 1. AURA Chat | Implementado | Unitarias e integracion local | Ejecutar smoke con mock en staging. |
| 2. Historial | Implementado | Tenant A/B, lectura y borrado | Confirmar retencion con datos reales. |
| 3. Cuotas y consumo | Implementado | Reserva atomica, 429, auditoria | Limites comerciales por plan aun usan fallback configurable. |
| 4. Tools read-only | Implementado | Esquemas, tenant, limites, tool loop | No hay SQL libre ni tools de mutacion. |
| 5. Campanas | Implementado para staging | Draft, preview, atribucion, aprobacion | Envio real permanece apagado. |
| 6. Consentimientos | Implementado | Granted, opt-out, aislamiento | Revalidacion ocurre al preparar y al enviar. |
| 7. Destinatarios | Implementado | Preparacion y exclusiones | Limite por tenant en `AURA_CAMPAIGN_MAX_RECIPIENTS`. |
| 8. Eventos y atribuciones | Implementado | Venta pagada/no cancelada, webhook | Probar callbacks reales del proveedor en sandbox. |
| 9. Imagenes | Implementado para mock | Dedupe, cuota, SSRF, concurrencia, mock | Worker apagado; falta prueba sandbox OpenAI/Cloudinary real. |
| 10. Acciones | Implementado | Permisos, hash, expiracion, doble clic | Chat y voz solo proponen; aprobacion HTTP explicita. |
| 11. Notification outbox | Implementado, desactivado | Claim atomico, terminales legacy, consentimiento | Probar worker con provider mock en staging. |
| 12. Predictive features | Implementado | Dataset manual, tenant, idempotencia | Job diario apagado. |
| 13. Forecasting | Implementado | Baselines, backtesting, cold start | Respuesta incluye muestra, rango, version y stale. |
| 14. Segmentacion | Implementado on-demand | Nuevo, recurrente, dormido, tenant | No existe worker dedicado; snapshots se calculan bajo demanda. |
| 15. Send-time | Implementado on-demand | Suficiente/insuficiente, quiet hours | No existe worker dedicado; snapshot bajo demanda. |
| 16. Voz | Implementado, flag off | MIME, duracion, tenant, mock, confirmacion | Cleanup disponible; programarlo como cron antes de habilitar. |
| 17. Workers | Parcialmente validado | Claims y concurrencia de imagen/outbox | Faltan pruebas residentes prolongadas y health externo. |
| 18. Auditoria | Implementado | Redaccion, tokens, costo, idempotencia | Revisar retencion operativa por politica comercial. |
| 19. Seguridad | Implementado con riesgos controlados | Tenant, roles, SSRF, webhooks, upload | Rate limit HTTP es memoria local; cuota chat es PostgreSQL. |
| 20. Observabilidad | Implementado basico | Endpoint agregado tenant-aware | Integrar alertas de Render sobre logs y profundidad. |

## Cambios de cierre

- Proveedores mock explicitos para chat, imagen y voz. Solo funcionan en `test`, `development` o con `AURA_STAGING_MODE=true`, ademas del flag del proveedor.
- Preview read-only `GET /api/aura/campaigns/:id/preview`.
- Preparacion tenant-aware de `campaign_recipients` con snapshot de consentimiento sin PII.
- `enqueue_campaign_delivery` exige campaña previamente `approved` o `scheduled`; ya no autoaprueba drafts.
- Eventos `queued`, `sent`, `failed`, `delivered`, `read` y `clicked` se registran con dedupe.
- Notification worker apagado por defecto, claim atomico, timeout, no overlap, cuarentena de claims abandonados y shutdown.
- Image worker con recuperacion conservadora, validacion binaria, costo estimado y limpieza Cloudinary en fallo final.
- Forecast jobs respetan `max_attempts`, backoff exponencial y frescura explicita.
- Endpoint admin `GET /api/aura/operations/health` con metricas agregadas por tenant.
- Cloudinary actualizado a v2; storage Multer vulnerable reemplazado por implementacion local validada.
- Socket `chat:dm` ahora valida destinatario del mismo tenant y longitud.

## Artefactos de validacion

- `scripts/run_aura_staging_smoke.ps1`: requiere URL/token staging, no imprime token ni cuerpos con PII.
- `scripts/aura_staging_tenant_test.sql`: transaccion read-only con `ROLLBACK`, verifica relaciones e indices tenant-aware.
- `scripts/run_aura_tenant_test_neon.ps1`: usa solo `NEON_AURA_BRANCH_URL`, rechaza pooler y destinos production-like.

## Resultados locales finales

- `node --check`: PASS, 157 archivos JavaScript.
- `npm run lint`: PASS.
- `npm test`: PASS, 131 pruebas; 0 fallos.
- `npm audit --json`: 0 critical, 0 high, 1 moderate transitivo.
- PowerShell parser: PASS para ambos runners nuevos.
- Smoke HTTP staging: NOT RUN.
- Tenant SQL en Neon staging: NOT RUN.
- Workers residentes: NOT RUN; flags confirmados en `false`.

## Pendientes bloqueantes para subir de estado

1. Ejecutar smoke HTTP con `AURA_STAGING_MODE=true` y `AURA_MOCK_PROVIDER_ENABLED=true` en el servicio staging.
2. Ejecutar el test SQL tenant en la rama Neon staging directa.
3. Ejecutar workers contra provider mock durante una ventana controlada y revisar colas estancadas.
4. Probar Cloudinary v2 y webhooks WhatsApp en sandboxes del proveedor.
5. Definir rate limiting distribuido para endpoints no cubiertos por cuota PostgreSQL.

## Criterio de clasificacion

`READY_FOR_PRODUCTION_REVIEW` no se usa todavia: aunque el audit de dependencias ya no contiene HIGH ni CRITICAL, faltan smoke, tenant test remoto y pruebas residentes de workers en staging.
