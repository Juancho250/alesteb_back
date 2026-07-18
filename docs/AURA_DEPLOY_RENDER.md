# AURA 2070 - Deploy en Render

Este documento describe como desplegar AURA en Render sin ejecutar despliegue desde esta auditoria.

## Servicios

### 1. Servicio web

Tipo: Web Service

Comando:

```bash
npm run start:web
```

Health check sugerido:

```text
/api/health
```

Notas:

- Puede escalar horizontalmente para trafico HTTP, pero los rate limits en memoria no seran globales entre replicas.
- No debe ejecutar workers ni crons residentes.

### 2. Worker de notificaciones y jobs generales

Tipo: Background Worker

Comando:

```bash
npm run start:worker
```

Responsabilidades:

- Suscripciones.
- Inventario.
- Notificaciones.
- Predictivo.
- Schedulers importados por el worker.

Regla operativa:

- Mantener una sola instancia hasta implementar leader election o advisory locks globales para todos los crons.

### 3. Worker IA de imagenes

Tipo: Background Worker

Comando:

```bash
npm run start:worker:ai
```

Responsabilidades:

- Procesar `ai_jobs` de imagen.
- Reclamar jobs con `FOR UPDATE SKIP LOCKED`.
- Subir resultados a Cloudinary.

Regla operativa:

- Crear este worker solo cuando `AURA_IMAGE_WORKER_ENABLED=true`.
- Si el flag esta en `false`, el proceso termina y Render podria reiniciarlo continuamente.

## Variables de entorno

### Core

```text
NODE_ENV=production
DATABASE_URL=
JWT_SECRET=
CORS_ORIGIN=
PAYMENTS_ENCRYPTION_KEY=
```

### AURA textual

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
AURA_OPENAI_TIMEOUT_MS=30000
AURA_MAX_TOOLS_PER_RUN=5
AURA_MAX_TOOL_ROUNDS=3
```

### Legacy agent

```text
ENABLE_LEGACY_AGENT_CRON=false
```

### Imagenes

```text
OPENAI_IMAGE_MODEL=
AURA_IMAGE_MAX_JOBS_PER_DAY=
AURA_IMAGE_WORKER_ENABLED=false
AURA_IMAGE_WORKER_ID=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

### Voz

```text
AURA_VOICE_ENABLED=false
AURA_VOICE_MAX_AUDIO_BYTES=
AURA_VOICE_MAX_DURATION_SECONDS=
```

### Notificaciones

```text
BREVO_API_KEY=
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=
WHATSAPP_PROVIDER=
WHATSAPP_REQUIRE_TEMPLATES=true
META_WEBHOOK_SECRET=
TWILIO_AUTH_TOKEN=
```

### Predicciones y jobs

```text
AURA_PREDICTIVE_ENABLED=false
```

### Pagos y webhooks

```text
WOMPI_PUBLIC_KEY=
WOMPI_PRIVATE_KEY=
```

Los secretos por tienda que viven cifrados en base de datos no deben duplicarse como variables globales salvo que el servicio lo requiera.

## Orden de migraciones

No ejecutar por orden alfabetico sin revisar dependencias. Orden recomendado:

1. `migrations/20260608_hybrid_default.sql`
2. `migrations/2026_06_01_expenses_po_link.sql`
3. `migrations/2026_06_02_discount_scope.sql`
4. `migrations/2026_07_12_page_views_tenant.sql`
5. `migrations/2026_07_12_aura_secure_mvp.sql`
6. `migrations/2026_07_12_aura_mvp.sql`
7. `migrations/2026_07_12_aura_campaigns.sql`
8. `migrations/2026_07_12_aura_actions_outbox.sql`
9. `migrations/2026_07_12_aura_image_jobs.sql`
10. `migrations/2026_07_12_predictive_features.sql`
11. `migrations/2026_07_12_predictive_forecasting.sql`
12. `migrations/2026_07_12_aura_customer_growth.sql`
13. `migrations/2026_07_12_aura_send_time_optimization.sql`
14. `migrations/2026_07_12_aura_voice_mvp.sql`

Proceso:

1. Restaurar backup reciente en staging.
2. Ejecutar migraciones en staging.
3. Ejecutar pruebas y smoke tests.
4. Tomar backup de produccion.
5. Ejecutar migraciones en produccion en ventana controlada.
6. Activar feature flags gradualmente.

## Health checks

Servicio web:

```bash
curl -i https://TU_DOMINIO/api/health
```

Worker general:

- Revisar logs de arranque.
- Verificar que no haya multiples instancias.
- Verificar avance de colas y jobs programados.

Worker IA:

- Verificar que el flag este habilitado antes de crear el worker.
- Crear un job de imagen en staging y confirmar transicion `queued -> processing -> completed` o `failed`.

## Smoke tests

### AURA chat

```bash
curl -X POST https://TU_DOMINIO/api/aura/chat \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Resume ventas de hoy\"}"
```

Esperado:

- `success=true`.
- `conversationId`.
- `runId`.
- Sin datos de otro tenant.

### Uso

```bash
curl https://TU_DOMINIO/api/aura/usage \
  -H "Authorization: Bearer TOKEN"
```

### Legacy agent

```bash
curl -X POST https://TU_DOMINIO/api/agent/confirm \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"si, confirmo\"}"
```

Esperado:

- No ejecuta acciones.
- Informa que el MVP seguro deshabilita acciones automaticas.

### Acciones

```bash
curl https://TU_DOMINIO/api/aura/actions \
  -H "Authorization: Bearer TOKEN"
```

### Imagenes

```bash
curl -X POST https://TU_DOMINIO/api/aura/images/generate \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"productId\":\"PRODUCT_ID\",\"objective\":\"promocionar producto\",\"format\":\"instagram_square\",\"style\":\"premium futurista\"}"
```

Esperado:

- Job creado.
- Request HTTP no espera la generacion.

## Activacion gradual

1. Deploy codigo con flags desactivados.
2. Ejecutar migraciones y smoke tests.
3. Activar AURA textual para tenants internos con `OPENAI_API_KEY`.
4. Validar cuotas y auditoria.
5. Mantener `/api/agent` contenido y `ENABLE_LEGACY_AGENT_CRON=false`.
6. Activar campanas en modo borrador.
7. Activar acciones aprobables para un grupo pequeno.
8. Activar worker IA de imagenes en staging y luego en un solo worker de produccion.
9. Activar predictivo cuando las features pasen validaciones.
10. Activar voz solo tras validar sesiones, cuota, retencion y UX de aprobacion visual.

## Rollback

Rollback primario:

- Desactivar flags.
- Revertir deploy desde Render.
- Detener workers afectados.

Ver detalle en `docs/AURA_ROLLBACK.md`.

