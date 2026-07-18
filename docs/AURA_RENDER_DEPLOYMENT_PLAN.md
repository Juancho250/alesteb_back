# AURA 2070 Render Deployment Plan

Documento de diseno. **No se realizo ningun deploy.** Usar primero una rama Neon staging y proveedores mock.

## Servicios

### 1. API Web Service

- Build: `npm ci`
- Start: `npm run start:web`
- Health: `GET /api/health`
- Health AURA autenticado: `GET /api/aura/operations/health`
- Escalado: web horizontal permitido; cuota AURA persiste en PostgreSQL. El rate limit HTTP en memoria no es distribuido.

### 2. Worker tier de notificaciones e imagenes

Crear dos Background Workers separados para aislar fallos y consumo:

- Notificaciones: `npm run start:worker:notifications`
- Imagenes: `npm run start:worker:ai`

No combinar ambos procesos con `&` en un mismo servicio. Ambos usan claim atomico y pueden escalar con cautela; un claim externo abandonado queda en cuarentena para evitar doble envio/generacion.

### 3. Predictive Worker

- Start: `npm run start:worker:predictive`
- Para procesar recalculos: `AURA_FORECAST_WORKER_ENABLED=true`.
- Mantener `AURA_PREDICTIVE_JOBS_ENABLED=false` si las features se ejecutan como cron independiente.

### 4. Cron jobs

- Features diarias: `npm run cron:aura:features` con `AURA_PREDICTIVE_JOBS_ENABLED=true` solo en ese cron.
- Limpieza voz: `npm run cron:aura:voice-cleanup` con `AURA_VOICE_CLEANUP_ENABLED=true`.
- No ejecutar `notificationScheduler.js` como side effect. `LEGACY_NOTIFICATION_SCHEDULER_ENABLED=false`.

## Variables

Comunes:

- `NODE_ENV=production`
- `DATABASE_URL` o variable canonica ya usada por `config/db.js`
- `JWT_SECRET`, `ALLOWED_ORIGINS`, `CLIENT_URL`
- `OPENAI_API_KEY`, `OPENAI_MODEL`
- `AURA_DAILY_REQUEST_LIMIT`, `AURA_OPENAI_TIMEOUT_MS`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

Staging mock:

- `AURA_STAGING_MODE=true`
- `AURA_MOCK_PROVIDER_ENABLED=true`
- `AURA_IMAGE_MOCK_PROVIDER_ENABLED=true`
- `AURA_VOICE_MOCK_PROVIDER_ENABLED=true`
- `AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED=true`

Produccion debe usar `AURA_STAGING_MODE=false` y todos los mock flags `false`.

Flags inicialmente apagados en todos los servicios:

- `ENABLE_LEGACY_AGENT_CRON=false`
- `AURA_NOTIFICATION_WORKER_ENABLED=false`
- `AURA_IMAGE_WORKER_ENABLED=false`
- `AURA_PREDICTIVE_JOBS_ENABLED=false`
- `AURA_FORECAST_WORKER_ENABLED=false`
- `AURA_VOICE_ENABLED=false`
- `AURA_VOICE_CLEANUP_ENABLED=false`
- `LEGACY_CREDIT_REMINDER_WORKER_ENABLED=false`
- `LEGACY_NOTIFICATION_SCHEDULER_ENABLED=false`

Proveedores de envio, solo al final: Brevo, WhatsApp, VAPID y secretos de firma. No configurarlos en la primera prueba mock.

## Migraciones

No ejecutar migraciones en el start command. Ejecutar como tarea manual contra URL directa, nunca pooler:

1. Snapshot/backup de staging.
2. `scripts/aura_preflight.sql`.
3. Migraciones `migrations/aura/001` a `010` en orden.
4. `scripts/aura_postflight.sql`.
5. Segunda corrida de idempotencia.
6. `scripts/aura_notification_history_audit.sql`.
7. `scripts/run_aura_tenant_test_neon.ps1`.

Las 001-010 ya constan PASS en la rama staging validada por el usuario; no se repitieron en esta tarea.

## Activacion gradual

1. Desplegar web con todos los workers y voz apagados.
2. Ejecutar `scripts/run_aura_staging_smoke.ps1` con chat mock.
3. Probar imagen mock con un solo job y worker image replica=1.
4. Probar forecast con dataset de staging y worker predictive replica=1.
5. Probar notification worker con provider mock y campaña aprobada de audiencia limitada.
6. Validar queue depth, stale claims, eventos y dedupe.
7. Habilitar proveedores sandbox, nunca destinatarios reales.
8. Solo despues considerar activacion limitada de produccion por tenant allowlist.

## Health y alertas

- Web: `/api/health` cada 30 segundos.
- AURA: consultar `/api/aura/operations/health` con cuenta operativa; alertar `status=degraded`.
- Logs: alertar eventos `*_failed`, `staleClaims > 0`, queue pending creciente y fallos OpenAI.
- No registrar token, prompt completo, email, telefono, audio ni payload de proveedor.
- Background workers: Render no expone HTTP; usar heartbeat de logs y metricas DB agregadas.

## Shutdown y escalado

- Entradas web y worker escuchan SIGTERM/SIGINT, detienen timers y cierran pool.
- Timeout de shutdown web: 10 segundos. Jobs externos largos deben quedar bloqueados/cuarentenados.
- Iniciar workers con una replica. Aumentar solo despues de prueba concurrente y monitoreo.
- Notification/image pueden usar multiples replicas por `SKIP LOCKED`, pero la entrega externa no es transaccional; no reintentar automaticamente claims ambiguos.

## Rollback

1. Apagar el flag del modulo afectado y reiniciar solo ese worker.
2. Escalar workers a cero; el web permanece consultivo.
3. Revertir release de codigo desde Render.
4. No bajar tablas AURA automaticamente. Preservar auditoria y jobs.
5. Para DDL usar `scripts/aura_rollback_plan.md` y una revision DBA; nunca ejecutar rollback destructivo por startup.

## Smoke posterior

```powershell
$env:AURA_STAGING_API_URL='https://<staging-host>'
$env:AURA_STAGING_TOKEN='<token-staging>'
.\scripts\run_aura_staging_smoke.ps1
```

Revisar el log sin compartir token ni cuerpos. El despliegue no avanza si falla autenticacion, tenant, JSON, mock o aparecen campos sensibles.
