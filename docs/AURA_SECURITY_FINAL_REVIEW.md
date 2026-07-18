# AURA 2070 Security Final Review

Fecha: 2026-07-15. Resultado: **PASS para staging controlado**, **pendiente de revision de produccion**. Revision local; no se consulto una base ni infraestructura externa.

## Controles verificados

### Identidad, rol y tenant

- JWT exige firma, issuer `alesteb-api`, audience `alesteb-client`, usuario existente y activo.
- Todas las rutas `/api/aura` usan `auth`, `adminScope`, rol gerente/admin, suscripcion y `has_ai_agent`.
- `resolveAuraTenant` fija `req.auraAdminId`; un no-superadmin no puede cambiarlo por header o body.
- Superadmin debe indicar un admin raiz activo mediante `X-Tenant-Admin-Id`.
- Services AURA reciben contexto interno; tool schemas no exponen `ownerAdminId`, `userId` ni roles.
- Queries y mutaciones tipadas filtran por `owner_admin_id`; migraciones agregan FKs, triggers e indices tenant-aware.

### IA y acciones

- No existe ejecucion de SQL generado por el modelo en AURA ni en el adaptador legacy seguro.
- Tools usan allowlist, argumentos estrictos, rechazo de propiedades extra, limite de rounds y limite por run.
- Prompt obliga a separar hechos, estimaciones y recomendaciones; los datos se obtienen de queries controladas.
- Chat y voz no ejecutan confirmaciones textuales. Una accion requiere `actionId`, endpoint autenticado, permiso, expiracion, hash e idempotencia.
- `enqueue_campaign_delivery` exige una campaña ya aprobada; no convierte `draft` a `approved`.

### Datos, PII y secretos

- `OPENAI_API_KEY`, Cloudinary y proveedores se usan solo en backend.
- `auraAudit.service` redacta claves, tokens, emails y telefonos; limita profundidad y longitud.
- Tools de clientes devuelven agregados y ejemplos anonimizados.
- Audio crudo y TTS no se persisten; los turnos guardan texto redactado y expiracion.
- Logs de nuevos workers son JSON y no incluyen prompts, contactos ni payloads.

### SQL, SSRF y archivos

- Queries AURA son parametrizadas; los pocos identificadores dinamicos provienen de allowlists internas.
- Imagenes aceptan assets tenant-aware de catalogo y URLs Cloudinary verificadas; no se descargan URLs arbitrarias.
- Salida de imagen valida limite, magic bytes y formatos PNG/JPEG/WebP antes de Cloudinary.
- Multer aplica MIME allowlist y tamaño. El storage local valida `folder`, `public_id`, `format` y `resource_type`.
- El nombre original del archivo de chat se normaliza y no llega crudo a Cloudinary.

### Webhooks y replay

- Meta verifica `X-Hub-Signature-256` sobre raw body; Twilio verifica su firma. En produccion, secreto ausente no permite bypass.
- Eventos de proveedor usan `provider_message_id` y `external_event_id` deduplicado.
- Metadata de callbacks se reduce a campos no sensibles antes de persistirse.
- Riesgo residual: el controlador responde 200 ante errores internos para evitar reintentos infinitos; se requiere alerta sobre errores para no perder observabilidad.

### Workers y concurrencia

- Notification, image y forecast reclaman con `FOR UPDATE SKIP LOCKED` y actualizan lock/attempt en el mismo statement.
- Claims abandonados se ponen en cuarentena `failed`; no se reencolan automaticamente porque el proveedor pudo completar antes del crash.
- Reintentos usan backoff y `max_attempts`; estados terminales no son reclamables.
- Flags permanecen apagados por defecto. Scheduler legacy y recordatorios legacy tienen flags separados.

## Hallazgos corregidos

| Severidad | Hallazgo | Correccion |
|---|---|---|
| Alta | Entrega de campaña podia autoaprobar draft | Aprobacion previa obligatoria. |
| Alta | No existia preparacion de destinatarios | Preparacion tenant-aware y revalidacion de consentimiento. |
| Alta | Cloudinary v1 y adaptador vulnerable | Cloudinary v2 y storage local con allowlist. |
| Alta | `chat:dm` no validaba tenant del destinatario | Query de ownership antes del INSERT/emision. |
| Media | Workers sin lifecycle uniforme | Flags, no-overlap, stop, metricas y recuperacion conservadora. |
| Media | Forecast no exponia frescura/muestra | Metadatos y stale explicitos. |

## Riesgos residuales

1. El rate limiter HTTP de `auth.middleware` usa memoria del proceso y no coordina multiples instancias. Chat agrega cuota persistente, pero otros endpoints necesitan Redis o contador PostgreSQL distribuido antes de alta escala.
2. Los roles se toman del JWT; desactivar al usuario se verifica en BD, pero un cambio de rol depende de expiracion/reemision del token.
3. `requireActiveSubscription` es fail-open ante error, aunque AURA queda despues protegida por `requireFeature('has_ai_agent')`, que falla cerrado.
4. No se ejecutaron pruebas de penetracion ni DAST.
5. Smoke y tenant SQL staging estan pendientes; por eso no se declara produccion lista.

## Configuracion segura

- Produccion: `AURA_STAGING_MODE=false` y todos los mock flags `false`.
- Mantener apagados hasta prueba explicita: `ENABLE_LEGACY_AGENT_CRON`, `AURA_NOTIFICATION_WORKER_ENABLED`, `AURA_IMAGE_WORKER_ENABLED`, `AURA_PREDICTIVE_JOBS_ENABLED`, `AURA_FORECAST_WORKER_ENABLED`, `AURA_VOICE_ENABLED`.
- Configurar secretos de webhook; no habilitar proveedor si falta su secreto.
- Usar URL PostgreSQL directa para migraciones y pooler solo para web cuando la estrategia de transacciones lo permita.
