# AURA Dependency Security Review

Fecha: 2026-07-15. Comando: `npm audit --json`. No se ejecuto `npm audit fix` ni `--force`.

## Resultado

| Momento | Critical | High | Moderate | Low | Total |
|---|---:|---:|---:|---:|---:|
| Auditoria inicial | 0 | 11 | 8 | 0 | 19 |
| Tras updates semver compatibles | 0 | 9 | 6 | 0 | 15 |
| Resultado final | 0 | 0 | 1 | 0 | 1 |

## Correcciones aplicadas

- `axios` 1.15.2 -> 1.18.1: directo/runtime, update compatible. Corrige ReDoS, limites, redirects y gadgets de proxy reportados.
- `multer` 2.0.2 -> 2.2.0: directo/runtime, update compatible. Corrige DoS y cleanup de uploads.
- `morgan` 1.10.1 -> 1.11.0: directo/runtime, update compatible. Corrige log forging reportado.
- Transitivas compatibles: `form-data`, `lodash`, `path-to-regexp`, `qs`, `flatted`, `minimatch`, `brace-expansion`, `js-yaml` y `picomatch`.
- `cloudinary` 1.41.3 -> 2.10.0: directo/runtime, semver major probado localmente.
- Se retiro `multer-storage-cloudinary` 4.0.0. Se reemplazo por `middleware/cloudinaryStorage.js`, con parametros validados y contrato Multer cubierto por pruebas.
- Override `ws=8.21.0`: transitive/runtime de Socket.IO. No hay imports directos y se mantiene la API 8.x.

## Hallazgo restante

### `ajv` < 6.14.0 - MODERATE

- Tipo: transitivo; instalado en el arbol de produccion por `@getbrevo/brevo -> rewire -> eslint -> ajv`.
- Advisory: ReDoS cuando se usa la opcion `$data`.
- Explotabilidad en ALESTEB: baja. La aplicacion no importa AJV, no compila schemas controlados por usuarios y no habilita `$data`; la ruta llega por tooling incluido por el paquete Brevo.
- Fix disponible: npm lo marca disponible, pero el rango depende de paquetes transitivos de Brevo.
- Breaking change: no se justifica forzar override de AJV sin probar el paquete Brevo.
- Mitigacion: no usar AJV transitivo desde runtime; mantener limites de request; revisar nueva version de `@getbrevo/brevo` y volver a auditar.

## Clasificacion

- HIGH explotable sin mitigacion: **ninguno segun el reporte final**.
- CRITICAL: ninguno.
- Riesgo residual: un MODERATE transitivo de baja alcanzabilidad para el flujo actual.
- Dependencias listas para staging: **PASS**.
- Produccion: la dependencia ya no bloquea por si sola, pero la decision final depende de smoke, tenant y workers staging.

## Comandos de verificacion

```powershell
npm ls cloudinary multer axios ws socket.io --depth=3
npm audit --json
```

No ejecutar `npm audit fix --force`; cualquier cambio mayor debe probar uploads, Socket.IO, email y toda la suite.
