# AURA Predictive 2070 - Diccionario de datos

Fecha de revision: 2026-07-14

Este documento define las metricas base para AURA Predictive 2070. No describe un modelo avanzado ni recomendaciones automaticas; solo la capa de features auditables.

## Principios

- Todas las features son tenant-aware mediante `owner_admin_id`.
- Las ventas usadas como demanda real son ventas pagadas y no canceladas.
- No se mezclan ventas, inventario, proveedores, campanas ni gastos entre tenants.
- Los calculos son versionados con `feature_version = predictive_features_v1`.
- Un recalculo no crea filas duplicadas: actualiza la misma llave y aumenta `recalculation_count`.
- Cada ejecucion queda auditada en `prediction_runs`.
- Las features de utilidad son estimadas hasta confirmar devoluciones, reembolsos y costos finales completos.

## Fuentes verificadas

### Ventas

Fuente principal: `sales`.

Campos usados/verificados por codigo:
- `id`
- `owner_admin_id`
- `customer_id`
- `sale_date`
- `subtotal`
- `tax_amount`
- `discount_amount`
- `total`
- `payment_status`
- `status`
- `delivery_status`
- `discount_id`
- `created_by`

Filtro de demanda vendida:
- `payment_status = 'paid'`
- `payment_status`, `status` y `delivery_status` no pueden estar en `cancelled`, `canceled`, `anulado`, `annulled`, `void`.

Limitacion:
- Ventas parciales o pendientes no cuentan como demanda pagada para features financieras.
- Si una venta parcial representa demanda comercial valida, debe agregarse una metrica separada en una version futura.

### Items de venta

Fuente principal: `sale_items`.

Campos usados/verificados:
- `sale_id`
- `product_id`
- `variant_id`
- `quantity`
- `unit_price`
- `unit_cost`
- `subtotal`
- `profit_per_unit`
- `total_profit`
- `fulfillment_mode_snapshot`
- `supplier_cost_at_sale`
- `actual_supplier_cost`

Limitacion:
- `total_profit` se toma como margen estimado ya calculado al momento de la venta.
- Si `actual_supplier_cost` cambia despues por procurement, no se reescribe el margen historico en esta fase.

### Descuentos

Fuentes:
- `sales.discount_amount`
- `sales.discount_id`
- `discounts`
- `discount_targets`

Tratamiento:
- El descuento de la venta se asigna proporcionalmente al item: `sale.discount_amount * item.subtotal / sale.subtotal`.
- `net_revenue` excluye impuestos y descuenta esa asignacion proporcional.
- `discount_targets` se documenta como contexto, pero no se usa todavia para modificar demanda historica.

Limitacion:
- Si hay descuentos por cupon, bundle o target con reglas mas finas, la asignacion proporcional es una aproximacion auditable.

### Impuestos

Fuente:
- `sales.tax_amount`.

Tratamiento:
- `tax_allocated` se asigna proporcionalmente al item.
- `net_revenue` no incluye impuestos.
- `gross_revenue` se basa en `sale_items.subtotal`, antes de descuento e impuestos.

Limitacion:
- Si el negocio desea predecir caja con impuestos incluidos, debe agregarse una feature separada.

### Devoluciones

Fuente verificada:
- `stock_ledger` con `movement_type = 'return'`.

Tratamiento:
- `returns_units` se calcula con `GREATEST(0, qty_delta)`.
- `returns_value_estimated` queda en `0` y `data_quality.returnsValueEstimated = true`.

Limitacion:
- No se encontro una tabla verificada de devoluciones monetarias o notas credito.
- Las devoluciones de stock no reducen automaticamente ingresos ni margen en esta fase.

### Reembolsos

Fuente:
- No hay tabla de reembolsos confirmada por codigo para esta fase.

Tratamiento:
- `data_quality.refundsModeled = false`.
- Las features financieras no descuentan reembolsos no modelados.

Campo faltante recomendado:
- `refunds` o `sale_refunds` con `owner_admin_id`, `sale_id`, `amount`, `reason`, `status`, `refunded_at`.

### Anulaciones y cancelaciones

Fuentes:
- `sales.payment_status`
- `sales.status`
- `sales.delivery_status`
- `stock_ledger.movement_type = 'sale_cancelled'`

Tratamiento:
- Las ventas canceladas no cuentan como unidades vendidas ni ingresos.
- `cancelled_units` cuenta items de ventas canceladas del dia.
- El reintegro de stock se refleja como movimiento de ledger, no como devolucion financiera.

Limitacion:
- `cancelOrder` marca `payment_status = 'cancelled'`; no necesariamente marca `delivery_status`.

### Stock fisico

Fuentes:
- `products.stock`
- `product_variants.stock`
- `stock_ledger.qty_before`
- `stock_ledger.qty_after`

Tratamiento:
- `stock_final` usa el ultimo `qty_after` del dia si existe ledger.
- Si no hay ledger del dia, se usa el stock actual y se marca `historicalStockEstimated = true`.

Limitacion:
- Para backfills historicos sin ledger diario completo, el stock historico puede ser estimado.

### Stock reservado

Fuentes:
- `products.stock_reserved`
- `product_variants.stock_reserved`
- `stock_reservations`

Tratamiento:
- `stock_reserved_final` usa el valor actual de producto/variante.
- `stock_available_final = max(0, stock_final - stock_reserved - stock_safety)`.

Limitacion:
- No hay snapshot historico diario de reservas; backfills antiguos usan valor actual como aproximacion.

### Stock disponible

Definicion:
- `disponible = stock_fisico - stock_reserved - stock_safety`.

Fuente:
- Formula verificada en `services/inventory.service.js` y `v_stock_disponible`.

Tratamiento:
- `stock_available_final` se calcula con la formula anterior.
- `stockouts` suma eventos con `qty_after <= 0` y estado final sin disponibilidad.

### Stock ledger

Fuente:
- `stock_ledger`.

Campos usados/verificados:
- `owner_admin_id`
- `product_id`
- `variant_id`
- `movement_type`
- `qty_delta`
- `qty_before`
- `qty_after`
- `reference_type`
- `reference_id`
- `created_at`

Movimientos relevantes:
- `sale_confirmed`
- `reservation_confirmed`
- `purchase_received`
- `return`
- `sale_cancelled`
- `manual_adjustment`
- `reservation_created`

Limitacion:
- `reservation_created` no cambia stock fisico; se registra como evento operativo.

### Variantes

Fuente:
- `product_variants`.

Campos usados/verificados:
- `id`
- `product_id`
- `sku`
- `sale_price`
- `stock`
- `stock_reserved`
- `stock_safety`
- `is_active`

Tratamiento:
- `daily_variant_features` calcula features por `variant_id`.
- `daily_product_features` consolida por `product_id`.

Limitacion:
- Costo de variante no esta verificado; se usa costo del producto padre.

### Ordenes de compra

Fuentes:
- `purchase_orders`
- `purchase_order_items`
- `procurement_orders`

Campos usados/verificados:
- `purchase_orders.owner_admin_id`
- `purchase_orders.status`
- `purchase_orders.provider_id`
- `purchase_orders.total_cost`
- `purchase_orders.expected_delivery_date`
- `purchase_order_items.product_id`
- `purchase_order_items.variant_id`
- `purchase_order_items.quantity`
- `purchase_order_items.received_quantity`
- `purchase_order_items.unit_cost`

Tratamiento:
- `pending_purchase_units = sum(max(0, quantity - received_quantity))` para ordenes no `received` ni `cancelled`.

Limitacion:
- MOQ no esta verificado en el esquema actual.

### Proveedores

Fuente:
- `providers`.

Campos usados/verificados:
- `id`
- `owner_admin_id`
- `name`
- `lead_time_days`
- `is_active`
- `balance`
- `payment_terms_days`

Tratamiento:
- `lead_time_days` usa `products.supplier_lead_time_days`; si falta, usa `providers.lead_time_days` cuando hay proveedor por defecto.

Limitacion:
- Lead time observado real requiere comparar `purchase_orders.order_date` contra `received_date`; en esta fase se usa lead time configurado.

### Costos

Fuentes:
- `sale_items.unit_cost`
- `sale_items.total_profit`
- `products.purchase_price`
- `purchase_order_items.unit_cost`
- `sale_items.actual_supplier_cost`

Tratamiento:
- Margen estimado diario: `sum(sale_items.total_profit)` sobre ventas pagadas/no canceladas.
- Costo de compra pendiente: disponible en ordenes, pero no se mezcla con margen hasta tener recepcion o costo final.

Limitacion:
- `actual_supplier_cost` todavia no corrige la feature de margen de ventas historicas.

### Gastos

Fuente:
- `expenses`.

Tratamiento en esta fase:
- No se asignan gastos operativos a producto.
- `daily_store_features` no calcula utilidad neta; solo margen bruto estimado desde `sale_items.total_profit`.

Limitacion:
- Para utilidad neta predictiva se requiere una politica de asignacion de gastos por canal, categoria o periodo.

### Utilidad

Definicion en esta fase:
- `estimated_margin = sum(sale_items.total_profit)`.

No incluye:
- Gastos operativos.
- Reembolsos no modelados.
- Devoluciones monetarias.
- Cambios posteriores de costo si no actualizan `sale_items.total_profit`.

## Features iniciales

### `daily_product_features`

Granularidad:
- 1 fila por `owner_admin_id`, `feature_date`, `product_id`, `feature_version`.

Metricas:
- `units_sold`: unidades vendidas pagadas/no canceladas.
- `gross_revenue`: suma de `sale_items.subtotal`.
- `net_revenue`: `gross_revenue - discounts_allocated`.
- `discounts_allocated`: descuento proporcional por item.
- `tax_allocated`: impuesto proporcional por item.
- `returns_units`: unidades retornadas por `stock_ledger`.
- `returns_value_estimated`: 0 en V1; valor monetario no confirmado.
- `cancelled_units`: unidades en ventas canceladas.
- `estimated_margin`: `sum(sale_items.total_profit)`.
- `stock_initial`: primer `qty_before` del dia si existe ledger.
- `stock_final`: ultimo `qty_after` del dia; fallback a stock actual.
- `stock_reserved_final`: reserva actual del producto.
- `stock_available_final`: stock disponible final calculado.
- `stockouts`: eventos de stock final <= 0 mas estado final sin disponible.
- `days_without_sale`: dias desde la ultima venta pagada/no cancelada.
- `rolling_units_7/14/30/90`: ventanas moviles.
- `rolling_revenue_7/14/30/90`: ingreso neto movil.
- `avg_units_30`: promedio diario sobre 30 dias.
- `median_units_30`: mediana sobre dias con ventas en V1.
- `stddev_units_30`: desviacion sobre dias con ventas en V1.
- `trend_units_30`: promedio 7 dias menos promedio 23 dias previos.
- `day_of_week`: domingo 0 a sabado 6.
- `month`: 1 a 12.
- `campaign_events_count`: eventos de campana vinculados a assets de producto si existen.
- `price`: `products.sale_price`.
- `price_changed`: false en V1 si no hay historial confiable.
- `lead_time_days`: lead time configurado.
- `pending_purchase_units`: unidades pendientes en ordenes de compra.
- `is_data_sufficient`: `rolling_units_90 >= 3` y completitud >= 0.65.
- `completeness_score`: 0 a 1.
- `duplicate_sale_items_count`: grupos duplicados sale/product/variant.
- `anomaly_count`: cantidades, subtotales o stock imposibles.
- `data_quality`: detalles JSONB.

### `daily_variant_features`

Granularidad:
- 1 fila por `owner_admin_id`, `feature_date`, `variant_id`, `feature_version`.

Diferencias:
- Usa `product_variants.stock`, `stock_reserved`, `stock_safety`.
- Usa `COALESCE(product_variants.sale_price, products.sale_price)`.
- El costo se hereda del producto hasta confirmar costo por variante.

### `daily_store_features`

Granularidad:
- 1 fila por `owner_admin_id`, `feature_date`, `feature_version`.

Fuente:
- Agregado de `daily_product_features`.

Metricas:
- Ventas, ingresos, descuentos, impuestos, devoluciones, cancelaciones y margen estimado agregados.
- `active_products_count`.
- `products_with_sales_count`.
- `products_stockout_count`.
- `pending_purchase_units`.
- `campaign_events_count`.
- Calidad agregada.

## Controles de calidad

Completitud baja si:
- Falta costo (`purchase_price`).
- Falta lead time.
- Stock historico es estimado.
- Hay anomalias.

Duplicados:
- `duplicate_sale_items_count` detecta mas de un item por `sale_id`, `product_id`, `variant_id`.

Anomalias:
- `quantity < 0`.
- `subtotal < 0`.
- `unit_price < 0`.
- `stock_final < 0`.
- `stock_reserved > stock_final`.
- `purchase_order_items.received_quantity > quantity`.

Datos insuficientes:
- Producto/variante: menos de 3 unidades vendidas en 90 dias o completitud menor a 0.65.
- Tienda: menos de 10 unidades vendidas en 90 dias agregadas o completitud menor a 0.65.

## Campos faltantes recomendados

- Tabla de reembolsos o notas credito.
- Devoluciones monetarias por item.
- Costo por variante.
- MOQ por proveedor/producto.
- Historial confiable de precios con tenant y timestamp.
- Snapshots diarios de stock reservado.
- Lead time observado por orden: `order_date`, `received_date`, recepcion parcial por item.
- Politica de asignacion de gastos operativos a producto/categoria/canal.

## Consulta de validacion

Archivo:
- `scripts/validate_predictive_features.sql`

Ejemplo:

```bash
psql "$NEON_DB_URL" -X \
  -v owner_admin_id=101 \
  -v date_from="'2026-07-01'" \
  -v date_to="'2026-07-14'" \
  -v feature_version="'predictive_features_v1'" \
  -f scripts/validate_predictive_features.sql
```

La consulta compara `daily_product_features` contra `sales` y `sale_items`, y revisa consistencia de stock actual para `CURRENT_DATE`.
