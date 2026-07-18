# AURA 2070 - Revision final de seguridad backend

Fecha: 2026-07-15

## Alcance

Revision final del backend de AURA 2070 en ALESTEB sin agregar funcionalidad nueva. Se revisaron rutas, middlewares, servicios, workers, migraciones, IA, campanas, predictivo, compatibilidad legacy y comandos operativos.

## Resultado ejecutivo

AURA esta disenado como un nucleo consultivo y aprobable, con separacion fuerte por tenant en las rutas nuevas, cuotas persistentes, auditoria, herramientas read-only y acciones sensibles bajo aprobacion explicita. La ruta legacy `/api/agent` quedo contenida como adaptador seguro hacia AURA.

No obstante, no debe activarse de forma amplia en produccion hasta cerrar estos puntos:

- `npm audit` reporta 19 vulnerabilidades: 8 moderadas y 11 altas.
- `npm run lint` ahora existe como verificacion de sintaxis JS.
- No se pudo validar migraciones contra una base de pruebas en este entorno porque `psql` no esta instalado y no hay variables de una DB de test disponibles.
- Los rate limits HTTP son en memoria y no son distribuidos entre replicas.
- `worker.js` ejecuta crons y jobs residentes; debe correr como una sola instancia mientras no haya leader election o locks globales para todos los crons.
- `worker.ai.js` termina el proceso si `AURA_IMAGE_WORKER_ENABLED=false`; en Render no conviene crear ese worker hasta habilitarlo.

## Verificaciones ejecutadas

| Comando | Resultado |
| --- | --- |
| `npm test` | OK: 105 tests pasaron |
| `npm run lint` | OK: verificacion de sintaxis JS exitosa |
| `node --check app.js` | OK |
| `node --check server.js` | OK |
| `node --check` sobre `controllers`, `routes`, `services`, `middleware`, `config`, `utils`, `worker.js`, `worker.ai.js` | OK |
| `npm audit --audit-level=moderate` | Fallo: 19 vulnerabilidades |
| `psql --version` | Fallo: `psql` no disponible |

## Hallazgos de seguridad

### JWT y autenticacion

- `middleware/auth.middleware.js` valida JWT con `issuer=alesteb-api` y `audience=alesteb-client`.
- El usuario se reconsulta en PostgreSQL y debe estar activo.
- Las API keys publicas se validan mediante hash, tienda activa, expiracion y origen permitido.
- AURA no confia en `owner_admin_id` del body.

Riesgo pendiente:

- Revisar rotacion de `JWT_SECRET` y estrategia de invalidacion de sesiones comprometidas.

### Roles, adminScope y superadmin

- `adminScope` marca `req.isSuperAdmin` y resuelve `req.adminId = req.user.owner_admin_id ?? req.user.id`.
- `resolveAuraTenant` fuerza a superadmin a enviar `X-Tenant-Admin-Id` y valida que apunte a un admin raiz activo.
- Usuarios no superadmin quedan atados a `req.adminId`.
- Rutas AURA aplican rol administrativo mediante `requireManager`.

Riesgo pendiente:

- Confirmar en datos reales que todos los usuarios administrables tienen `owner_admin_id` correcto y que no hay usuarios historicos huerfanos.

### Aislamiento Tenant A/B

- Las consultas nuevas de AURA usan `owner_admin_id` parametrizado.
- Tools reciben un `ctx` interno construido desde el request autenticado.
- El modelo no puede suministrar tenant, `owner_admin_id` ni SQL.
- Conversaciones, acciones, campanas, imagenes, predicciones, segmentos y cuotas son tenant-aware.

Riesgo pendiente:

- Validar las migraciones en una base real de staging para confirmar FK, triggers y constraints con datos historicos.

### SQL parametrizado

- Los servicios revisados usan parametros `pg`.
- Las tools de AURA no ejecutan SQL generado por el modelo.
- El agente legacy no debe ejecutar SQL libre en flujo productivo.

Riesgo pendiente:

- Mantener pruebas contra regresiones en `/api/agent` y cualquier nuevo tool.

### SSRF y URLs externas

- Generacion/edicion de imagenes no acepta URLs arbitrarias.
- Solo permite assets de catalogo, uploads autorizados o URLs Cloudinary verificadas.
- Se valida Cloudinary por cloud name y path esperado.

Riesgo pendiente:

- Revalidar allowlist si cambia la configuracion de Cloudinary o se agrega CDN propio.

### Webhooks

- Wompi usa raw body y validacion de evento por tienda.
- Notificaciones verifican firmas Meta/Twilio. En produccion, falta de secreto provoca rechazo.
- Eventos externos se deduplican por identificador de proveedor cuando aplica.

Riesgo pendiente:

- Ejecutar pruebas end-to-end con payloads reales de Wompi, Meta y Twilio en staging.

### Secretos y logs

- `OPENAI_API_KEY` solo se usa en backend.
- `config/env.js` no imprime claves; solo advierte si falta configuracion de IA.
- Auditoria de AURA redacciona emails, telefonos, tokens y claves sensibles.

Riesgo pendiente:

- Centralizar politica de logs en Render para evitar imprimir bodies completos desde middlewares ajenos a AURA.

### Rate limits y cuotas

- AURA tiene rate limits HTTP por proceso y cuotas persistentes en PostgreSQL.
- `ai_usage_daily` incrementa de forma atomica por tenant.
- El limite de jobs de imagen usa locking transaccional.

Riesgo pendiente:

- El rate limit HTTP en memoria no protege globalmente con multiples replicas. Usar Redis o tabla transaccional si se escala web horizontalmente.

### Acciones aprobables

- La IA solo propone `aura_actions`.
- Aprobacion requiere endpoint autenticado, tenant, rol, permiso, expiracion, estado valido, hash de payload e idempotency key.
- Chat y voz no aceptan "si", "confirmo" o texto libre como autorizacion.

Riesgo pendiente:

- Auditar periodicamente acciones `pending_approval` expiradas y permisos asociados.

## Datos y migraciones

### Migraciones revisadas

- `2026_07_12_aura_secure_mvp.sql`
- `2026_07_12_aura_mvp.sql`
- `2026_07_12_aura_campaigns.sql`
- `2026_07_12_aura_actions_outbox.sql`
- `2026_07_12_aura_image_jobs.sql`
- `2026_07_12_page_views_tenant.sql`
- `2026_07_12_predictive_features.sql`
- `2026_07_12_predictive_forecasting.sql`
- `2026_07_12_aura_customer_growth.sql`
- `2026_07_12_aura_send_time_optimization.sql`
- `2026_07_12_aura_voice_mvp.sql`

### Puntos positivos

- Tablas nuevas tienen `owner_admin_id`.
- Se agregan FKs, indices tenant-aware y constraints de deduplicacion.
- Campanas separan contenidos, destinatarios, eventos y atribucion.
- Acciones usan `payload_hash` e `idempotency_key`.
- Page views no asigna historico ambiguo a tenants arbitrarios.
- Predictivo versiona features, runs, resultados y modelos.

### Riesgos pendientes

- Validacion real de migraciones no ejecutada por falta de DB de test local.
- Confirmar nullability con datos historicos antes de aplicar constraints fuertes.
- Confirmar que triggers de campanas y atribucion no fallen con ventas antiguas sin campos esperados.
- Revisar retencion de conversaciones, runs, eventos, page views y assets con politica de negocio.

## IA y tools

### Prompt y alucinaciones

- El prompt indica que AURA habla en espanol, usa solo contexto entregado, no inventa datos y diferencia hechos, estimaciones y recomendaciones.
- Se exige salida JSON estructurada en el servicio OpenAI.
- Si falta informacion, debe declararlo.

### Tool calling

- No hay SQL generado por el modelo.
- Las tools tienen schemas estrictos y rechazan propiedades adicionales.
- `ctx` confiable se construye internamente.
- Hay limites de rondas y cantidad de tools por run.
- Las tools son read-only salvo `propose_aura_action`, que crea una propuesta aprobable, no una ejecucion.

### Auditoria, tokens y costo

- `aura_runs` registra modelo, status, input redactado, output estructurado, tools, tokens, costo estimado, latencia y errores redactados.
- `ai_usage_daily` registra consumo diario por tenant.

### Timeout, errores y reintentos

- OpenAI usa timeout y AbortController.
- Errores externos se normalizan y se redaccionan.
- Imagenes usan jobs asincronos con reintentos y backoff.

Riesgos pendientes:

- `npm audit` afecta dependencias usadas por HTTP, uploads y sockets.
- Confirmar costos reales por modelo en produccion, ya que el costo estimado depende de configuracion local.

## Workers

### Separacion web/worker

- `start:web` ejecuta `server.js`.
- `start:worker` ejecuta `worker.js`.
- `start:worker:ai` ejecuta `worker.ai.js`.
- El servidor web no debe cargar crons de AURA.

### Duplicacion

- Queue de imagenes reclama con `FOR UPDATE SKIP LOCKED`.
- Outbox de notificaciones reclama con `FOR UPDATE SKIP LOCKED`.
- Crons generales de `worker.js` no tienen leader election global verificada.

Riesgos pendientes:

- Correr solo una instancia de `worker.js` hasta implementar locks globales.
- No crear `worker.ai.js` en Render con `AURA_IMAGE_WORKER_ENABLED=false`, porque puede salir y reiniciarse en ciclo.

## Campanas

### Consentimiento y opt-out

- `customer_consents` es tenant-aware.
- El opt-out prevalece al estimar audiencia y al momento del envio.
- `campaign_recipients` guarda snapshot de consentimiento.
- El worker vuelve a validar consentimiento justo antes de enviar.

### Quiet hours

- El worker respeta quiet hours.
- Recomendacion de canal/hora no programa automaticamente.

### Eventos y atribucion

- Eventos de campana deduplican webhooks por identificador externo.
- Atribucion apunta a ventas pagadas y no canceladas.

Riesgo pendiente:

- Validar con eventos reales por proveedor y zonas horarias reales de destinatarios.

## Predictivo

### Leakage y backtesting

- Forecasting usa features historicas y baselines estadisticos, no LLM.
- Guarda version de modelo, version de features, rangos de train/test, metricas, forecast e incertidumbre.
- No debe pronosticar series insuficientes como confiables.

### Separacion de tenants

- Features, runs y resultados son tenant-aware.

Riesgos pendientes:

- Validar comparaciones contra ventas/stock reales en staging.
- Documentar ventas perdidas por stockout como limitacion hasta modelarlas formalmente.

## Compatibilidad

- `/api/agent/chat` y `/api/agent/confirm` se conservan.
- El agente legacy queda como adaptador seguro y la confirmacion textual no ejecuta acciones.
- Variables IA no son obligatorias en arranque.
- `OPENAI_API_KEY` ausente devuelve error claro en runtime.
- El comando productivo actual `npm start` se mantiene.

## Dependencias vulnerables reportadas

`npm audit` reporto vulnerabilidades en dependencias o transitive dependencies, incluyendo:

- `axios`
- `cloudinary`
- `multer-storage-cloudinary`
- `multer`
- `path-to-regexp`
- `ws`
- `flatted`
- `lodash`
- `minimatch`
- `picomatch`
- `ajv`
- `brace-expansion`
- `follow-redirects`
- `js-yaml`
- `morgan`
- `qs`

No se actualizaron dependencias automaticamente. Se recomienda resolver primero en rama separada y staging, porque algunas correcciones sugieren cambios mayores.

## Decision de salida

Estado recomendado: no activar AURA Growth/Voice/Images/Predictive en produccion amplia hasta:

1. Ejecutar migraciones en base de staging restaurada desde backup reciente.
2. Corregir o aceptar formalmente `npm audit`.
3. Validar `npm run lint` en esta rama y documentar cualquier falso positivo de sintaxis.
4. Confirmar una sola instancia de `worker.js` en Render.
5. Ejecutar smoke tests multi-tenant con datos representativos.
