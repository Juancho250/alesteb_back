# AURA Voice MVP

## Decision tecnica

AURA Voice V1 usa push-to-talk con APIs HTTP:

- Audio upload hacia backend ALESTEB.
- Transcripcion con OpenAI Audio Transcriptions.
- Ejecucion del nucleo textual seguro `executeAuraChat`.
- Sintesis con OpenAI Audio Speech.
- Respuesta JSON con audio base64 para reproduccion inmediata.

No se usa Realtime en esta fase. Segun la guia oficial de OpenAI, Realtime es la ruta adecuada cuando se requiere baja latencia continua o audio en vivo; para archivos o requests acotados, Speech to Text y Text to Speech son la ruta recomendada.

Fuentes oficiales revisadas:

- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/text-to-speech

## Endpoints backend

Todos viven bajo `/api/aura`, por lo que heredan:

- `auth`
- `adminScope`
- rol administrativo real
- suscripcion activa
- `subscription_plans.has_ai_agent`
- `resolveAuraTenant`

Endpoints:

- `POST /api/aura/voice/sessions`
- `GET /api/aura/voice/sessions/:id`
- `DELETE /api/aura/voice/sessions/:id`
- `POST /api/aura/voice/sessions/:id/turn`

El endpoint de turno usa `multipart/form-data`:

- `audio`: archivo requerido.
- `durationSeconds`: opcional; se valida si el cliente lo envia.
- `conversationId`: opcional; si no viene, se usa la conversacion ligada a la sesion.

## Seguridad

- `AURA_VOICE_ENABLED=false` por defecto.
- La API key de OpenAI solo se usa en backend.
- No hay wake word ni escucha permanente.
- El audio se procesa en memoria con `multer.memoryStorage`.
- No se aceptan URLs de audio externas.
- No se almacena audio crudo ni audio sintetizado.
- Las transcripciones y respuestas se guardan redactadas.
- Frases como `si`, `confirmo`, `hazlo`, `apruebo` o `procede` quedan bloqueadas como confirmacion por voz y no llaman acciones.
- La aprobacion real de acciones sigue siendo por `/api/aura/actions/:id/approve` con `actionId`, UI visual, permisos, tenant, idempotencia y hash de payload.

## Retencion

MVP:

- Audio de entrada: no almacenado; descartado al cerrar el request.
- Audio de respuesta: no almacenado; se devuelve base64 y se descarta.
- Metadata de turnos: `AURA_VOICE_RETENTION_HOURS`, default 24 horas.
- Sesiones: `AURA_VOICE_SESSION_TTL_SECONDS`, default 10 minutos.

Una tarea futura puede limpiar `aura_voice_turns` por `expires_at`.

## Configuracion

Variables:

```env
AURA_VOICE_ENABLED=false
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=marin
OPENAI_TTS_FORMAT=mp3
AURA_VOICE_MAX_AUDIO_MB=10
AURA_VOICE_MAX_DURATION_SECONDS=60
AURA_VOICE_MAX_TRANSCRIPT_CHARS=2000
AURA_VOICE_SESSION_TTL_SECONDS=600
AURA_VOICE_RETENTION_HOURS=24
AURA_VOICE_OPENAI_TIMEOUT_MS=30000
```

## Propuesta minima de frontend

- Boton push-to-talk dentro del panel AURA.
- Pedir permiso de microfono solo al pulsar.
- Grabar con `MediaRecorder` en `audio/webm`.
- Crear sesion con `POST /api/aura/voice/sessions`.
- Enviar cada turno a `POST /api/aura/voice/sessions/:id/turn`.
- Mostrar transcripcion antes de la respuesta.
- Reproducir `audio.base64` con `Audio`.
- Si `blockedActionConfirmation=true`, mostrar aviso y dirigir al usuario al flujo visual de aprobacion.
- Para acciones sensibles, mostrar actionId, tenant, alcance, destinatarios, impacto/costo, expiracion y boton explicito de aprobacion.
