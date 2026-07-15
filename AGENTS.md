# AGENTS.md - ALESTEB

## Proyecto

ALESTEB es un ERP premium para negocios físicos y tiendas online. Maneja ventas, inventario, clientes, pedidos, descuentos, reportes, usuarios, roles y tienda virtual.

## Objetivo principal

Construir AURA 2070: un asistente inteligente dentro de ALESTEB que pueda analizar ventas, inventario, pedidos y clientes, dar recomendaciones y preparar acciones con confirmación.

## Estilo visual

* Premium, futurista y minimalista.
* Inspiración: Apple, Stripe, Linear, Notion y tecnología 2070.
* Usar los colores corporativos actuales del login de ALESTEB.
* Mantener morado corporativo, azul eléctrico, blanco y acentos luminosos.
* No cambiar branding, logos ni estructura visual principal sin autorización.

## Reglas técnicas

* No romper rutas existentes.
* No eliminar funciones actuales.
* No cambiar nombres de endpoints sin justificar.
* No tocar archivos no relacionados con la tarea.
* Mantener compatibilidad con el frontend actual.
* Todo cambio debe ser pequeño, seguro y revisable.
* Si falta contexto, pedir el archivo necesario antes de inventar.

## Seguridad

* Nunca exponer API keys en frontend.
* La API key de OpenAI debe estar solo en backend.
* Validar autenticación antes de acceder a AURA.
* Validar permisos antes de crear descuentos, cambiar precios, enviar mensajes, modificar inventario o crear órdenes.
* La IA no puede ejecutar acciones sensibles sin confirmación.
* No permitir eliminación de productos, usuarios, ventas o pedidos desde AURA.

## AURA 2070

AURA debe poder:

* Resumir ventas del día.
* Detectar productos con bajo stock.
* Detectar productos dormidos.
* Detectar pedidos pendientes.
* Sugerir campañas.
* Generar mensajes para WhatsApp.
* Recomendar pedidos a proveedor.
* Recomendar descuentos.
* Mostrar oportunidades de venta.
* Mostrar escenarios tipo "Modo 2070".

## Primera versión

La primera versión de AURA 2070 será por texto, no por voz.

Debe incluir:

* Botón flotante "AURA 2070".
* Panel/chat futurista.
* Endpoint backend seguro.
* Conexión a OpenAI desde backend.
* Datos resumidos del negocio.
* Recomendaciones.
* Acciones sugeridas, no ejecutadas automáticamente.

## Comandos comunes

Frontend:
npm install
npm run dev
npm run build

Backend Node/Express:
npm install
npm run dev

Backend Django:
pip install -r requirements.txt
python manage.py runserver
python manage.py test

## Formato de respuesta esperado

Cuando modifiques código:

1. Explica qué archivos tocaste.
2. Devuelve el código completo de cada archivo modificado.
3. Explica cómo probarlo.
4. Indica riesgos o cosas pendientes.
