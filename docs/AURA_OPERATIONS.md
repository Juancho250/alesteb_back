# AURA 2070 - Operaciones

## Principios operativos

- AURA textual puede responder y sugerir.
- AURA no ejecuta acciones sensibles sin endpoint de aprobacion autenticado.
- Workers deben estar separados del servicio web.
- No ejecutar migraciones en produccion sin backup y validacion previa en staging.
- No activar features nuevas para todos los tenants al mismo tiempo.

## Checklist diario

1. Revisar health check del servicio web.
2. Revisar logs de errores 5xx en `/api/aura`.
3. Revisar errores de OpenAI, Cloudinary, Brevo, WhatsApp y Push.
4. Revisar cola `ai_jobs` por jobs atascados en `running`.
5. Revisar `notification_queue` por `failed` y reintentos agotados.
6. Revisar acciones `pending_approval` vencidas.
7. Revisar consumo por tenant en `ai_usage_daily`.

## Checklist semanal

1. Ejecutar `npm test`.
2. Ejecutar `npm run lint`.
3. Ejecutar `npm audit --audit-level=moderate`.
4. Revisar crecimiento de `aura_runs`, conversaciones, eventos de campana y page views.
5. Revisar costos IA estimados contra facturacion real.
6. Revisar segmentos y predicciones con muestras manuales.
7. Revisar webhooks duplicados o rechazados.

## Comandos locales

Pruebas:

```bash
npm test
```

Servicio web:

```bash
npm run start:web
```

Worker general:

```bash
npm run start:worker
```

Worker IA:

```bash
npm run start:worker:ai
```

Workers separados:

```bash
npm run start:worker:notifications
npm run start:worker:predictive
```

Crons explicitos:

```bash
npm run cron:aura:features
npm run cron:aura:voice-cleanup
```

Salud operativa AURA: `GET /api/aura/operations/health` con JWT de admin.

Auditoria de dependencias:

```bash
npm audit --audit-level=moderate
```

## Monitoreo recomendado

### Web

- Latencia p95 de `/api/aura/chat`.
- Tasa de 401, 403, 429 y 503.
- Errores por tenant sin exponer PII.
- Uso de memoria por uploads de voz.

### IA

- Requests por tenant.
- Tokens de entrada y salida.
- Costo estimado.
- Timeouts.
- Tools por run.
- Runs con error.

### Imagenes

- Jobs creados por dia.
- Jobs `queued`, `processing`, `completed`, `failed`.
- Intentos promedio.
- Tiempo promedio hasta completar.
- Errores de moderacion.

### Notificaciones

- Pendientes por canal.
- Enviadas, entregadas, leidas, clics y fallidas.
- Reintentos.
- Quiet hours aplicadas.
- Opt-outs respetados.

### Predictivo

- Fecha del ultimo calculo por tenant.
- Series con datos insuficientes.
- MAE, WAPE y bias por modelo.
- Cold start.
- Jobs de recalculo pendientes.

## Runbook: OpenAI no disponible

Sintomas:

- `/api/aura/chat` devuelve 503 o errores de timeout.
- Aumentan errores en `aura_runs`.

Acciones:

1. Confirmar que `OPENAI_API_KEY` existe y no fue rotada incorrectamente.
2. Confirmar `OPENAI_MODEL`.
3. Revisar limites del proveedor.
4. Mantener endpoints respondiendo con error claro.
5. Si hay degradacion prolongada, desactivar features IA no criticas.

## Runbook: cola de imagenes atascada

Sintomas:

- Muchos jobs `queued`.
- Jobs `processing` con `locked_at` antiguo.

Acciones:

1. Confirmar que `AURA_IMAGE_WORKER_ENABLED=true`.
2. Confirmar que el worker IA esta corriendo.
3. Revisar errores Cloudinary y OpenAI.
4. No reiniciar multiples workers sin revisar duplicacion.
5. Reintentar solo jobs seguros y no completados.

## Runbook: notificaciones fallando

Sintomas:

- `notification_queue.failed` aumenta.
- Webhooks no actualizan estado.

Acciones:

1. Confirmar credenciales del proveedor.
2. Confirmar firma de webhooks.
3. Confirmar consentimiento y opt-out.
4. Confirmar quiet hours.
5. Revisar dedupe_key antes de reencolar.

## Runbook: migracion 005 del outbox

El primer intento real en Neon staging del 2026-07-15 confirmo `001` a `004` y revirtio `005` dentro de su propia transaccion. PostgreSQL rechazo `idx_notification_queue_claim` porque el predicado usaba `status::text`; la conversion de un enum a texto no es inmutable.

Los predicados de indices deben depender solo de valores inmutables. No deben contener `NOW()`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, otras funciones de reloj ni casts de enum a texto. La elegibilidad temporal cambia con el tiempo aunque no cambie la fila, por lo que debe evaluarse en la consulta del worker.

La definicion corregida es:

```sql
CREATE INDEX IF NOT EXISTS idx_notification_queue_claim
  ON public.notification_queue(available_at, scheduled_for, created_at, id)
  WHERE status = 'pending';
```

El worker aplica `available_at <= NOW()`, `scheduled_for <= NOW()` y `attempts < max_attempts`, ordena por las mismas columnas, reclama con `FOR UPDATE SKIP LOCKED` y cambia a `sending` en la misma sentencia.

Procedimiento de reanudacion en staging:

1. Mantener todos los workers y feature flags AURA apagados.
2. Ejecutar nuevamente el preflight y conservar el snapshot terminal de `notification_queue`.
3. Reiniciar el runner completo desde `001`; no borrar la rama ni revertir manualmente `001` a `004`.
4. Comparar el fingerprint y los conteos `sent/failed` del postflight con el preflight.
5. Ejecutar una segunda vez para validar idempotencia.

No promover a produccion hasta que la cadena completa, el postflight y la segunda ejecucion pasen en staging.

## Runbook: accion aprobable sospechosa

Sintomas:

- Payload inesperado.
- Tenant incorrecto.
- Permiso no corresponde.

Acciones:

1. No aprobar la accion.
2. Revisar `aura_runs` asociado.
3. Revisar `payload_hash`, `idempotency_key` y expiracion.
4. Rechazar la accion.
5. Si se repite, desactivar temporalmente la tool que propone acciones.

## Retencion sugerida

La retencion exacta debe aprobarse con negocio y legal. Base sugerida:

- Audio de voz: no persistir audio; conservar solo metadatos minimos.
- Transcripciones: conservar solo lo necesario para historial y auditoria.
- `aura_runs`: conservar por ventana operativa y cumplimiento.
- Page views: anonimizar o purgar historico segun politica.
- Eventos de campana: conservar lo necesario para atribucion y auditoria.
- Assets generados: conservar mientras la campana o producto lo requiera.

## Escalamiento

Escalar a ingenieria antes de:

- Activar nuevos providers.
- Cambiar constraints de tenant.
- Correr backfills grandes.
- Resolver `npm audit` con cambios mayores.
- Habilitar multiples workers generales.
- Habilitar aprobaciones para descuentos reales o envios masivos.
