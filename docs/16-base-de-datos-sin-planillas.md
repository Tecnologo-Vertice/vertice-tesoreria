# Base de datos de Tesorería sin planillas · 26/11/2026

Desde las migraciones 0023 a 0027, la base es la única fuente de datos de Tesorería. Ninguna planilla guarda datos: el Flujo, la conciliación y el control diario son consultas sobre la base.

## Planilla de hoy → tabla o vista

| Hoy (planilla / pestaña) | En la base | Migración |
|---|---|---|
| Pestañas del Flujo por empresa (original y v2) | `unidades` (una por pestaña) + `flujo_filas` (estructura) + vista `flujo_lineas` | 0023, 0026 |
| Llave Flujo v2, Mapa Flujo, Reglas Estudio | `flujo_reglas` (excepciones) + regla general: la fila de la cuenta contable | 0026 |
| Gastos Fijos, Proyecciones, PFP | `proyecciones` (única, semanal, quincenal, mensual; cuotas, hasta, ajuste %) | 0026 |
| Flujo_Cambios_Manuales | `flujo_ajustes` (mover, editar, eliminar, con historial) + auditoría | 0026 |
| Conciliación bancaria (fila "Conciliación Bancaria" del Flujo) | vistas `conciliacion_bancaria` y `flujo_control` | 0024, 0026 |
| Cuentas_Extracto, Cuentas Bancarias, Xubio_Cuentas_Origen | `cuentas_origen` ampliada (banco, clase, unidad, CUIT del banco, cuenta madre, rinde diario, patrones) | 0023 |
| Extractos_Movimientos, Bancos Movimientos | `extractos` (archivo) + `movimientos_bancarios` ampliada | 0024 |
| Extractos_Reglas | `reglas_extracto` (con destino en Xubio y componente del comprobante) | 0024 |
| Conciliacion_Diaria | `saldos_bancarios` (cierre por día) + vista `conciliacion_bancaria` | 0024 |
| Saldos Xubio Historial | `lecturas_xubio` | 0024 |
| Factura de gastos bancarios 0999X-AAAAMMDD | `facturas` con `cuenta_origen_extracto_id` (nace pagada) | 0024 |
| Asiento diario de impuestos y FCI | `asientos` + `asiento_lineas` (debe = haber obligatorio) | 0024 |
| Cash Flow de cheques, pestaña Categoría, Datos Cheques | `cheques` + `cheques_pagos` + `acreedores`; `feriados` | 0025, 0023 |
| Cobros_Xubio | `cobros` | 0025 |
| Control_Diario_Bancos | vista `control_bancos` + `control_envios` | 0027 |
| Robot_Echeqs_Log, Robot_Debitos_Log, Xubio_Pagos_Log | `procesos_log` | 0027 |
| LockService ("Hay otro proceso en curso") | transacciones + `bloqueos` para trabajos largos | 0027 |
| Catalogo_Percepciones_IIBB, Historial_Correcciones_IA | `percepciones_iibb`, `correcciones_ia` | 0027 |
| Facturas, Pagos, catálogos de proveedores, productos y cuentas | ya estaban (0001 a 0022) | — |

## Reglas que quedan en la base (no en la pantalla)

| Regla | Dónde |
|---|---|
| El mismo archivo de extracto no entra dos veces; un archivo superpuesto solo agrega lo nuevo; dos impuestos iguales del mismo día entran los dos | `importar_extracto` (huella por movimiento) |
| IIBB y percepciones dentro del comprobante "Extracto Bancario"; Ley 25413, rendimientos y FCI al asiento | `reglas_extracto.destino_xubio` |
| El comprobante del banco es único por número + CUIT del banco; nace pagado y no se proyecta; si ya subió a Xubio no se regenera | `generar_comprobante_gastos`, trigger `factura_de_extracto_pagada` |
| "Sin movimientos" repite el saldo anterior; en Mercado Pago y remuneradas pide confirmación; nunca inventa un saldo | `marcar_sin_movimientos` |
| El rendimiento del FCI sale solo de la tenencia (saldo − anterior − suscripciones + rescates) y entra real al Flujo | `conciliacion_bancaria.rendimiento` → `flujo_lineas` |
| Un movimiento contabilizado no cambia de importe, fecha ni cuenta | trigger `movimiento_consistente` |
| Lo anulado en el sistema queda pendiente de anular en Xubio, sin paso manual | `anulacion_xubio` en pagos, asientos y cheques |
| Marcar un cheque debitado exige su número: si no coincide, no marca | `marcar_cheque_debitado` |
| Anticipo % + Cta. Cte.: anticipo pendiente el próximo día hábil, resto al vencimiento | `flujo_lineas` (tramos ANTICIPO y SALDO) |
| Lo proyectado se mueve, edita y elimina con motivo; lo real no | `ajustar_linea_flujo`, `restaurar_linea_flujo` |
| Mover una factura cambia su fecha de pago, no el vencimiento | `ajustar_linea_flujo` |
| Lo no pagado a término pasa al día hábil de hoy | `flujo_lineas` |
| Control del Flujo: cambio en bancos = lo real del período (tolerancia $1) | `flujo_control` |
| Cada persona ve y opera solo sus empresas; nadie escribe directo en las tablas | RLS + triggers `aislar_por_empresa` + permisos |

## Pruebas

| Grupo | Resultado |
|---|---|
| `npm run test:sql` (las de siempre, con las migraciones nuevas aplicadas) | 601 OK |
| `npm run test:tesoreria` (nuevas: importación, reglas, conciliación, FCI, comprobante, asiento, cheques, anticipo, ajustes, control, seguridad) | 82 OK |
| `npm run test:tesoreria` · `probar_espera_fc.mjs` (0028: pagos sin factura en el Flujo, clave vieja de movimientos) | 29 OK |
| `npm run test:migracion` (script de migración con planillas ficticias: control, idempotencia, casos) | 50 OK |

Varios casos son los del 26/11 en VBI+ (rendimiento FCI Hipotecario 4,38; Mercado Pago "Sin movimientos"; PFP cancelado; número de cheque), con importes de prueba.

## Lo que falta para apagar las planillas

1. **Cargar los datos reales**: `demo/scripts/migrar-desde-planillas/migrar.mjs` (26/11). Lee las planillas en el momento (IDs y credencial por variables de entorno; nada real en el repo), corre en seco por defecto contra una base PGlite y deja un reporte con conteos y sumas por tabla y empresa. Para escribir: `--escribir --confirmo` con `SUPABASE_DB_URL`. Falta: CUIT de cada banco (no está en ninguna planilla) y las decisiones marcadas [FALTA] en el reporte.
2. **Funciones de Netlify:** lectores de extracto por banco (Hipotecario, ICBC, Chubut, Brubank, MP, Macro, Galicia, Credicoop, Santander, tenencias FCI) → `importar_extracto`; envío a Xubio de comprobantes, asientos y anulaciones; mail del control diario (8 h, días hábiles); lectura de saldos de Xubio.
3. **Pantallas:** Bancos (subir extracto, revisar, sin movimientos, conciliación), Cheques y Flujo como grilla editable.
4. ~~Descontar del Flujo los anticipos pagados sin factura (ESPERA_FC)~~: hecho en 0028 (vista `anticipos_sin_factura` + `flujo_lineas`). 0028 además borra la clave vieja de movimientos que 0024 no llegó a borrar (nombre truncado).
5. **Período en paralelo:** dos semanas con VBI+ y la base a la vez, comparando el control del Flujo día por día antes de apagar las planillas.
