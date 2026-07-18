# AURA 2070 - Rollback

## Principios

- Primero desactivar feature flags.
- Luego revertir deploy si es necesario.
- No hacer `DROP` en produccion como primera respuesta.
- Tomar backup antes de cualquier rollback de base de datos.
- Mantener evidencia: logs, run ids, action ids, campaign ids y job ids.

## Rollback rapido por flags

### AURA textual

Opciones:

- Quitar `OPENAI_API_KEY` para que el endpoint devuelva error claro de proveedor no configurado.
- Desactivar `has_ai_agent` por plan o tenant.
- Bloquear temporalmente rutas desde gateway si existe.

### Legacy agent

```text
ENABLE_LEGACY_AGENT_CRON=false
```

La ruta `/api/agent` debe permanecer como adaptador seguro.

### Imagenes

```text
AURA_IMAGE_WORKER_ENABLED=false
```

Ademas:

- Detener worker IA en Render.
- No borrar assets originales.
- Revisar jobs `processing` antes de reintentar.

### Voz

```text
AURA_VOICE_ENABLED=false
```

Efecto:

- Las sesiones de voz dejan de aceptar turnos.
- AURA textual no se afecta.

### Predictivo

```text
AURA_PREDICTIVE_ENABLED=false
```

Ademas:

- Detener recalculos manuales.
- Mantener resultados historicos para auditoria.

### Notificaciones y campanas

Opciones:

- Pausar campanas.
- Rechazar o cancelar `aura_actions` pendientes.
- Detener worker general si hay riesgo de envio.
- Mantener webhooks activos para recibir estados de mensajes ya enviados.

## Rollback de codigo en Render

1. Abrir el servicio afectado.
2. Seleccionar deploy anterior estable.
3. Re-deploy.
4. Verificar health check.
5. Ejecutar smoke tests.
6. Confirmar que workers no quedaron duplicados.

## Rollback de migraciones

El rollback de schema debe ser excepcional y planificado.

Orden inverso sugerido si una migracion debe revertirse y no tiene datos utiles:

1. `2026_07_12_aura_voice_mvp.sql`
2. `2026_07_12_aura_send_time_optimization.sql`
3. `2026_07_12_aura_customer_growth.sql`
4. `2026_07_12_predictive_forecasting.sql`
5. `2026_07_12_predictive_features.sql`
6. `2026_07_12_aura_image_jobs.sql`
7. `2026_07_12_aura_actions_outbox.sql`
8. `2026_07_12_aura_campaigns.sql`
9. `2026_07_12_aura_mvp.sql`
10. `2026_07_12_aura_secure_mvp.sql`
11. `2026_07_12_page_views_tenant.sql`

Antes de revertir:

- Confirmar dependencias FK.
- Confirmar si hay datos productivos.
- Exportar tablas afectadas.
- Preferir deshabilitar funcionalidad antes de eliminar tablas o columnas.

## Rollback por incidente

### Incidente: fuga o cruce de tenant

1. Desactivar AURA para todos los tenants afectados.
2. Detener workers si el cruce involucra campanas o notificaciones.
3. Preservar logs y `aura_runs`.
4. Identificar endpoint, user id, owner_admin_id y request id.
5. Corregir scoping y agregar prueba de regresion.
6. Rehabilitar solo despues de validacion Tenant A/B.

### Incidente: envio indebido

1. Detener worker general.
2. Pausar campanas activas.
3. Bloquear nuevas aprobaciones.
4. Revisar `notification_queue`, `campaign_recipients` y `campaign_events`.
5. Contactar proveedor si se requiere detener mensajes pendientes.
6. Mantener webhooks para estados finales.

### Incidente: costos IA anormales

1. Desactivar AURA textual o reducir cuota.
2. Detener worker IA.
3. Revisar `ai_usage_daily`.
4. Revisar loops de tools y jobs duplicados.
5. Rehabilitar con limites mas bajos.

### Incidente: dependencia vulnerable explotable

1. Evaluar si el vector esta expuesto.
2. Desactivar upload, imagenes o sockets si aplica.
3. Crear rama de parche.
4. Actualizar dependencia en staging.
5. Ejecutar pruebas y smoke tests.
6. Desplegar parche.

## Smoke tests despues de rollback

```bash
curl -i https://TU_DOMINIO/api/health
```

```bash
curl -X POST https://TU_DOMINIO/api/aura/chat \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"estado del negocio\"}"
```

```bash
curl -X POST https://TU_DOMINIO/api/agent/confirm \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"confirmo\"}"
```

Esperado para `/api/agent/confirm`:

- No ejecuta acciones.
- Respuesta compatible.

## Criterios para cerrar rollback

- Health checks OK.
- Sin workers duplicados.
- Sin acciones pendientes peligrosas.
- Sin jobs atascados por el rollback.
- Smoke tests Tenant A/B OK.
- Auditoria preservada.
- Riesgo comunicado a negocio.

