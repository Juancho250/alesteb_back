# Page Views Tenant Policy

Fecha: 2026-07-14

## Identidad confiable de tienda

ALESTEB solo debe aceptar eventos de analitica cuando el tenant se resuelve por uno de estos mecanismos:

- `req.apiKey.adminId` en `/public-api/v1`, protegido por API key.
- Header `X-Analytics-Key`, `X-Store-Key` o `X-API-Key` contra `api_keys`, con permiso `analytics:write`, activa, no expirada y con origin permitido.
- JWT valido, cuando el usuario autenticado pertenece al tenant.

No se acepta `owner_admin_id`, `adminId`, `tenantId` ni `userId` desde el body publico.

## Backfill

La migracion `migrations/2026_07_12_page_views_tenant.sql` no asigna datos historicos a tenants por inferencia.

- Filas legacy sin `owner_admin_id` quedan con `tenant_resolution_status = 'ambiguous_legacy'`.
- Filas ambiguas no deben alimentar campañas, churn, predicciones, atribucion ni segmentacion.
- La columna legacy `user_id` se documenta como no confiable porque venia del body publico.
- `authenticated_user_id` solo se llena con JWT validado y pertenencia al tenant.

## Captura

Eventos nuevos deben registrar:

- `owner_admin_id` confiable.
- `visitor_id` anonimo.
- `session_id`.
- `authenticated_user_id` solo si hay JWT valido del mismo tenant.
- `event_type`.
- `path` y `product_id` cuando aplique.
- UTM y referrer sanitizados sin querystring sensible.

No se almacenan IPs, emails, telefonos, cedulas ni user-agent crudo en `page_views`.

## Retencion

Politica recomendada: anonimizar eventos detallados despues de 180 dias.

La migracion crea:

```sql
SELECT public.anonymize_old_page_views(180);
```

La funcion borra enlaces de usuario, visitor/session rastreables, referrer, UTM y medidas de pantalla, preservando agregados basicos por tenant, path, evento y fecha.

## Clave publica revocable

Crear una API key del tenant con permiso exclusivo:

```json
["analytics:write"]
```

Esa key puede registrar eventos, pero no consultar productos, ventas, clientes ni reportes privados.

