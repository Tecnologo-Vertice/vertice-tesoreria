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
| El comprobante del banco es uno por **cuenta** y día: 0999X-AAAAMMDD, con X = dígito de la cuenta entre las del mismo banco y empresa (`cuentas_origen.digito_comprobante`, 0031). Nace pagado y no se proyecta; si ya subió a Xubio o se está enviando, no se regenera | `generar_comprobante_gastos`, triggers `cuenta_con_digito` y `factura_de_extracto_pagada` |
| "Sin movimientos" repite el saldo anterior; en Mercado Pago y remuneradas pide confirmación; nunca inventa un saldo | `marcar_sin_movimientos` |
| El rendimiento del FCI sale solo de la tenencia (saldo − anterior − suscripciones + rescates) y entra real al Flujo. La suscripción o el rescate se descuenta por la contraparte del movimiento: con un solo fondo en la cuenta se completa sola (0030); con varios la elige Tesorería (`asignar_contraparte`, 0031). Un "rendimiento" de más del 1 % por día queda REVISAR | `conciliacion_bancaria.rendimiento` → `flujo_lineas` |
| Un movimiento contabilizado no cambia de importe, fecha ni cuenta | trigger `movimiento_consistente` |
| Lo anulado en el sistema queda pendiente de anular en Xubio, sin paso manual | `anulacion_xubio` en pagos, asientos y cheques |
| Marcar un cheque debitado exige su número: si no coincide, no marca. La fecha del débito va entre la emisión y hoy, y no reabre un movimiento ya contabilizado (0031) | `marcar_cheque_debitado` |
| Un pago no se cubre con cheques por más que su importe; el acreedor y el proveedor de un cheque son de la organización de su empresa (0031) | `emitir_cheque`, trigger `cheque_consistente` |
| El asiento del día se puede rehacer mientras no subió (llegó otro movimiento, cambió una cuenta, dio error); uno que se está enviando no se rehace ni se anula (0031) | `generar_asiento_bancario`, `anular_asiento`, `resultado_asiento_xubio` |
| "Hoy" es la fecha de Buenos Aires, no la del servidor (0031) | `hoy_ar()` |
| Anticipo % + Cta. Cte.: anticipo pendiente el próximo día hábil, resto al vencimiento | `flujo_lineas` (tramos ANTICIPO y SALDO) |
| Lo proyectado se mueve, edita y elimina con motivo; lo real no | `ajustar_linea_flujo`, `restaurar_linea_flujo` |
| Mover una factura cambia su fecha de pago, no el vencimiento | `ajustar_linea_flujo` |
| Lo no pagado a término pasa al día hábil de hoy | `flujo_lineas` |
| Control del Flujo: cambio en bancos = lo real del período (tolerancia $1) | `flujo_control` (`flujo_control_entre`) |
| La pantalla pide el Flujo y su control por rango de fechas, en una llamada | `flujo_rango(unidad, desde, hasta)`, `flujo_control_rango(desde, hasta)` (0031) |
| Cada persona ve y opera solo sus empresas; nadie escribe directo en las tablas | RLS + triggers `aislar_por_empresa` + permisos |

## Pruebas

| Grupo | Resultado |
|---|---|
| `npm run test:sql` (las de siempre, con las migraciones nuevas aplicadas) | 601 OK |
| `npm run test:tesoreria` (nuevas: importación, reglas, conciliación, FCI, comprobante, asiento, cheques, anticipo, ajustes, control, seguridad) | 82 OK |
| `npm run test:tesoreria` · `probar_espera_fc.mjs` (0028: pagos sin factura en el Flujo, clave vieja de movimientos) | 29 OK |
| `npm run test:tesoreria` · `probar_0031.mjs` (0031: correcciones de la revisión técnica, con los escenarios del revisor) | 90 OK |
| `npm run test:migracion` (script de migración con planillas ficticias: control, idempotencia, casos, organización) | 55 OK |

Varios casos son los del 26/11 en VBI+ (rendimiento FCI Hipotecario 4,38; Mercado Pago "Sin movimientos"; PFP cancelado; número de cheque), con importes de prueba.

## Lo que falta para apagar las planillas

1. **Cargar los datos reales**: `demo/scripts/migrar-desde-planillas/migrar.mjs` (26/11). Lee las planillas en el momento (IDs y credencial por variables de entorno; nada real en el repo), corre en seco por defecto contra una base PGlite y deja un reporte con conteos y sumas por tabla y empresa. Para escribir: `--escribir --confirmo` con `SUPABASE_DB_URL`. Falta: CUIT de cada banco (no está en ninguna planilla) y las decisiones marcadas [FALTA] en el reporte.
2. **Funciones de Netlify:** lectores de extracto por banco (Hipotecario, ICBC, Chubut, Brubank, MP, Macro, Galicia, Credicoop, Santander, tenencias FCI) → `importar_extracto`; envío a Xubio de comprobantes, asientos y anulaciones; mail del control diario (8 h, días hábiles); lectura de saldos de Xubio.
3. **Pantallas:** Bancos (subir extracto, revisar, sin movimientos, conciliación), Cheques y Flujo como grilla editable.
4. ~~Descontar del Flujo los anticipos pagados sin factura (ESPERA_FC)~~: hecho en 0028 (vista `anticipos_sin_factura` + `flujo_lineas`). 0028 además borra la clave vieja de movimientos que 0024 no llegó a borrar (nombre truncado).
5. **Período en paralelo:** dos semanas con VBI+ y la base a la vez, comparando el control del Flujo día por día antes de apagar las planillas.

**0029 (T-205, 26/11):** tenencias de FCI con origen TENENCIA desde el lector, anulaciones de Xubio marcadas a mano (órdenes de pago y cheques, con nota y auditoría), vista `xubio_bancos_pendientes` (pantalla Bancos › Pendiente en Xubio) y control diario con anulaciones de pagos y cheques. El checklist para encender todo está en [17](17-puesta-en-marcha-tesoreria.md).

## 0031 (T-208, 26/11): correcciones de la revisión técnica

La revisión T-207 encontró 21 puntos (3 críticos). `0031_correcciones_revision.sql` corrige los de la base sin tocar las migraciones anteriores; el resto está en las funciones de Netlify, la pantalla y el script de migración.

**Rendimiento (hallazgo 3).** Con un año de datos (75.000 movimientos) la pantalla y el mail del control se cortaban por tiempo. Qué cambió:

| Antes | Ahora |
|---|---|
| `conciliacion_bancaria`: una subconsulta por cada cuenta y día | `conciliacion_calculo()`: funciones de ventana, una pasada. Mismos resultados fila por fila |
| `flujo_lineas`: llamaba a `flujo_destino()` por cada línea y el filtro por fecha se aplicaba al final | `flujo_lineas_entre(desde, hasta, unidad, solo_real)`: el rango se aplica antes; el destino se resuelve por conjuntos, una vez por combinación distinta de datos. La vista `flujo_lineas` sigue existiendo (es la función sin rango) |
| `flujo_control`: recalculaba todo el Flujo por cada día | `flujo_control_entre(desde, hasta)`: suma lo real una vez por unidad y día y lo acumula |
| La pantalla pedía `flujo_lineas` de a 1000 filas (cada página recalculaba la vista) | `flujo_rango()` y `flujo_control_rango()`: una llamada cada una, devuelven todo junto (JSON). Si la base todavía no tiene 0031, la pantalla lee la vista como antes |
| `importar_extracto` vinculaba pagos, cheques y cobros después de cada movimiento | Una vez por archivo |

Medido en PGlite con el año sintético (10 cuentas × 250 días × 30 movimientos, 60 reglas del Flujo), leyendo como una persona: Flujo de −45 a +200 días **0,9 s** (antes ~66 s por página, 14 páginas); control contra bancos de 45 días **0,5 s** (antes ~66 s por día); conciliación de 45 días **0,13 s** (antes 3,9 s); `control_bancos` completo **0,34 s**; importar un extracto de 300 movimientos **0,2 s** (antes 11,7 s). Para repetirlo: `node supabase/pruebas/rendimiento_0031.mjs supabase/migrations` (desde `demo/`; no corre en `npm test` porque tarda; sale con error si alguna consulta de pantalla pasa de 2 s).

Las columnas `flujo_filas.cuenta_norm`/`apertura_norm` y `flujo_reglas.si_cuenta_norm`/`si_texto_norm` las calcula la base sola (texto normalizado para comparar): no se cargan a mano.

**Lo demás:**

| # | Qué pasaba | Cómo queda |
|---|---|---|
| 1 | Con más de un fondo en la cuenta, la suscripción se contaba como rendimiento | `asignar_contraparte()` (pantalla Bancos: "¿De qué fondo es?"); estado REVISAR y avisos `RENDIMIENTO_A_REVISAR` y `FCI_SIN_CONTRAPARTE` en el control diario |
| 2 | Dos cuentas del mismo banco pisaban el mismo comprobante 09990 | Un comprobante por cuenta (0999X). Los 09990 que ya existen no cambian de número. Los movimientos que habían quedado en el comprobante de otra cuenta (sin subir) se soltaron: aparecen como `SIN_COMPROBANTE` y se regeneran |
| 4 | Pago y su débito contados dos veces | Ya lo había resuelto 0030 (vínculo movimiento ↔ pago) |
| 5, 6 | El asiento no se podía regenerar; anulado en pleno envío quedaba vivo en Xubio | Se rehace mientras no subió; en envío no se toca; si se anuló y Xubio lo aceptó queda `anulacion_xubio = PENDIENTE` |
| 7, 8, 15 | Cheques: mismo pago en dos cheques, acreedor de otra organización, débito con fecha imposible | Rechazados |
| 9 | El extracto entraba en cualquier cuenta del mismo banco | La función busca el número de cuenta o el CBU en el nombre del archivo (y en el encabezado de los CSV): si es de otra cuenta, no importa; si no se puede saber y hay otra cuenta posible, avisa. Una cuenta sin banco cargado no acepta archivos. **Conviene cargar `numero` y `cbu` en cada cuenta** |
| 10, 19 | El primer extracto después de migrar duplicaba; dos movimientos iguales podían chocar | `importar_extracto` saltea lo que ya entró por la migración (`ya_migrados`) y ordena por la clave de la huella |
| 11 | El mail del control mandaba todas las empresas a todos | Un mail por cada conjunto de empresas visibles |
| 12 | Los comprobantes bancarios trababan el subidor de facturas | `facturas_para_xubio` no los devuelve |
| 13 | Se regeneraba un comprobante en pleno envío | Rechazado |
| 14 | Reclasificar como gasto bancario no iba al comprobante | Va como NETO (o el componente que se indique); el comprobante o el asiento del que sale se rehace |
| 16 | `flujo_reglas` aceptaba unidad o fila de otra empresa | Trigger `flujo_regla_consistente` |
| 17 | De 21 a 24 h "hoy" ya era mañana | `hoy_ar()` en el Flujo, su control, el control diario y los cheques |
| 18 | `unidad_por_defecto`, `fila_especial` y `flujo_destino` devolvían ids de cualquier empresa | Leen con las reglas de quien llama; cerradas a anónimos |
| 20 | Un ajuste de importe volvía a sumar lo pagado sin factura | El ajuste tiene como tope lo que queda por pagar |
| 21 | El script de migración elegía "la primera" organización | `--organizacion <slug>`, obligatorio si hay más de una |

Pruebas: `supabase/pruebas/probar_0031.mjs` (90 casos, dentro de `npm run test:tesoreria`), más casos nuevos en `netlify/pruebas/extractos.prueba.mts` (cuenta del archivo), `netlify/pruebas/bancos-xubio.prueba.mts` (mail por destinatario) y `scripts/migrar-desde-planillas/probar.mjs` (organización). El simulacro del paralelo de noviembre da lo mismo que antes de 0031 (44 de 72 días): la corrección no cambia resultados, cambia cómo se calculan.

## 0032 (T-209, 26/11): conciliación en lote y pagos sin débito con motivo

| Regla | Dónde |
|---|---|
| Un débito del banco puede pagar varios pagos (1 débito ↔ N pagos, tabla `movimientos_pagos`) y un pago puede salir en varios débitos del mismo día (N débitos ↔ 1 pago). Suma exacta al centavo, de 2 a 12 pagos, misma empresa y cuenta, ventana de 0030. Primero los pagos del mismo día que el débito; después toda la ventana | `conciliar_lotes`, llamada por `conciliar_movimientos` |
| Si hay más de una combinación distinta o más de 14 candidatos, no se vincula: queda para una persona | tabla `conciliacion_revisar` |
| Un pago con un débito propio por su importe exacto (aunque mal fechado) no entra en un lote; un débito con pago propio no se usa para armar otro pago (evita lotes por coincidencia) | `conciliar_lotes` |
| Desempate fijo entre importes iguales: fecha, luego id (antes dependía del orden físico de la tabla) | `conciliar_movimientos`, `subconjunto_unico` |
| `pagos_sin_debito.motivo`: POSIBLE_DUPLICADO, CUENTA_O_FECHA (hay un débito igual sin vincular en otra cuenta o fuera de la ventana, hasta 45 días; `debito_parecido_id`) o SIN_EXPLICACION | vista `pagos_sin_debito` |
| El Flujo toma los lotes: el débito no entra y cada pago cuenta el día del débito, en la unidad de esa cuenta | `flujo_lineas_entre` |

Script de migración (T-209): la línea "Saldo anterior / inicial / final" de un informe no se carga como movimiento (se veía como rendimiento negativo del FCI); los rescates y suscripciones de FCI que VBI+ dejó SIN_CLASIFICAR se detectan por el cambio del saldo del fondo y entran como FCI con el fondo de contraparte; la conciliación se hace una vez al final de la carga. Pruebas: `supabase/pruebas/probar_0032.mjs` (en `npm run test:tesoreria`) y `scripts/paralelo/probar.mjs`. Simulacro: `node scripts/paralelo/paralelo.mjs --instantaneas DIR --pagos DIR` (antes = hasta 0031, después = con 0032).
