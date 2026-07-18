# AURA 2070 - API backend

## Base

Todas las rutas nuevas viven bajo:

```text
/api/aura
```

Requisitos comunes:

- JWT valido.
- Usuario activo.
- Tenant resuelto por `adminScope` y `resolveAuraTenant`.
- Rol administrativo real.
- Suscripcion activa.
- Plan con `subscription_plans.has_ai_agent = true` cuando exista.
- Cuota disponible cuando aplica.

El frontend nunca debe enviar ni recibir `OPENAI_API_KEY`.

## Errores comunes

| Codigo | Significado |
| --- | --- |
| 400 | Body invalido, limite excedido o parametro no permitido |
| 401 | No autenticado |
| 403 | Rol, tenant, plan o feature no autorizado |
| 404 | Recurso inexistente o ajeno al tenant |
| 409 | Estado invalido, idempotencia o conflicto |
| 429 | Cuota o rate limit excedido |
| 503 | Proveedor IA no configurado o no disponible |

Las respuestas deben mantener JSON estable y no exponer secretos ni datos sensibles crudos.

## Chat

### POST `/api/aura/chat`

Request:

```json
{
  "conversationId": "opcional",
  "message": "texto"
}
```

Response:

```json
{
  "success": true,
  "conversationId": "uuid",
  "runId": "uuid",
  "answer": "respuesta de AURA",
  "insights": [],
  "suggestions": [],
  "usage": {
    "requestsRemaining": 0
  }
}
```

Notas:

- El historial se carga desde servidor.
- Las tools son read-only, excepto propuestas aprobables.
- La IA no ejecuta acciones sensibles.
- Las acciones sugeridas deben pasar por `/api/aura/actions/:id/approve`.

## Conversaciones

### GET `/api/aura/conversations`

Lista conversaciones del tenant autenticado, paginadas.

### GET `/api/aura/conversations/:id`

Obtiene una conversacion del tenant autenticado.

### DELETE `/api/aura/conversations/:id`

Elimina o marca la conversacion segun el patron vigente del backend. No permite borrar conversaciones de otro tenant.

### GET `/api/aura/usage`

Devuelve uso y cuota IA del tenant autenticado.

### GET `/api/aura/operations/health`

Requiere rol admin. Devuelve flags y metricas agregadas tenant-aware de runs, colas, jobs, predicciones y voz; no expone prompts, contactos ni payloads.

## Acciones aprobables

### GET `/api/aura/actions`

Lista acciones del tenant autenticado.

### GET `/api/aura/actions/:id`

Obtiene una accion por id opaco.

### POST `/api/aura/actions/:id/approve`

Aprueba una accion pendiente.

Validaciones aplicadas:

- Tenant.
- Rol.
- Permiso requerido.
- Expiracion.
- Estado actual.
- `payload_hash`.
- `idempotency_key`.

### POST `/api/aura/actions/:id/reject`

Rechaza una accion pendiente.

Regla critica:

- Ninguna frase del chat o de voz, como "si" o "confirmo", aprueba acciones.

## Campanas

### POST `/api/aura/campaigns/draft`

Crea un borrador de campana. No envia mensajes.

### GET `/api/aura/campaigns`

Lista campanas del tenant.

### GET `/api/aura/campaigns/:id`

Detalle tenant-aware de campana.

### PUT `/api/aura/campaigns/:id`

Actualiza borrador o campos permitidos segun estado.

### DELETE `/api/aura/campaigns/:id`

Elimina o cancela segun estado y reglas del dominio.

### POST `/api/aura/campaigns/:id/estimate-audience`

Estima audiencia respetando consentimiento y opt-out. No deja contactos listos para envio si no tienen consentimiento vigente.

### GET `/api/aura/campaigns/:id/preview`

Preview read-only de aprobacion, audiencia, destinatarios preparados y cola. Siempre devuelve `dryRun=true`; no prepara, encola ni envia.

### GET `/api/aura/campaigns/send-time-recommendation`

Devuelve canal, dia y franja sugerida con evidencia, muestra, confianza cualitativa y limitaciones. No agenda automaticamente.

## Imagenes de campana

### POST `/api/aura/images/generate`

Crea un job asincrono de generacion de imagen.

Request ejemplo:

```json
{
  "campaignId": "uuid",
  "productId": "uuid",
  "variantId": "uuid",
  "objective": "promocionar producto",
  "format": "instagram_square",
  "style": "premium futurista",
  "instructions": "conservar exactamente el producto"
}
```

### POST `/api/aura/images/edit`

Crea un job asincrono de edicion usando imagenes verificadas del catalogo o Cloudinary autorizado.

### GET `/api/aura/images/jobs/:id`

Consulta estado del job.

### GET `/api/aura/campaigns/:campaignId/assets`

Lista assets de una campana del tenant.

### DELETE `/api/aura/campaign-assets/:id`

Elimina de forma segura un asset generado, solo si pertenece al tenant y corresponde.

Formatos iniciales:

- `instagram_square`
- `instagram_story`
- `whatsapp_square`
- `facebook_feed`
- `ecommerce_banner`

## Predicciones

### GET `/api/aura/predictions/demand`

Consulta forecast de demanda por tenant, producto y variante cuando exista.

Cada resultado incluye confianza, muestra, rango de fechas, version, `generatedAt`, `stale` y limitaciones.

### GET `/api/aura/predictions/restock`

Consulta sugerencias explicables de reabastecimiento.

Formula base:

```text
demanda esperada durante lead time
+ safety stock
- stock disponible
- compras pendientes confirmadas
```

No se inventa lead time ni MOQ.

### POST `/api/aura/predictions/recalculate`

Crea un job de recalculo. Requiere permiso administrativo. No recalcula directamente desde una tool textual.

## Clientes y Growth

### GET `/api/aura/customers/segments`

Devuelve segmentos RFM agregados por defecto.

### GET `/api/aura/customers/churn-summary`

Devuelve resumen heuristico de riesgo de abandono.

### GET `/api/aura/customers/repurchase-opportunities`

Devuelve oportunidades de recompra agregadas. El detalle individual requiere permiso mas alto.

## Voz

AURA Voice esta detras de:

```text
AURA_VOICE_ENABLED=false
```

Rutas esperadas:

- Crear sesion de voz.
- Subir turno de audio push-to-talk.
- Recibir transcripcion y audio de respuesta.

Reglas:

- No escucha permanente.
- No wake word.
- No almacenamiento indefinido de audio.
- Reutiliza tenant, roles, cuota, auditoria, tools y acciones aprobables.
- Voz no puede confirmar acciones por texto libre.

## Legacy Agent

### POST `/api/agent/chat`

Ruta conservada por compatibilidad. Debe delegar al nucleo consultivo seguro de AURA.

### POST `/api/agent/confirm`

Ruta conservada por compatibilidad. No ejecuta acciones. Debe informar que las acciones automaticas estan deshabilitadas en el MVP seguro.

## Tools disponibles para AURA

Tools read-only:

- `get_sales_summary`
- `get_top_products`
- `get_low_stock`
- `get_sleeping_products`
- `get_pending_orders`
- `get_purchase_recommendation_inputs`
- `get_customer_rfm_summary`
- `get_business_health_summary`
- `get_customer_growth_opportunities`
- `suggest_campaign_send_time`

Tools de borrador o propuesta:

- `draft_campaign_copy`
- `suggest_campaign_segment`
- `suggest_campaign_objective`
- `propose_aura_action`

Reglas:

- El modelo no puede enviar `owner_admin_id`.
- El modelo no puede enviar SQL.
- El modelo no puede mutar datos directamente.
- Las acciones se guardan como propuestas aprobables.
