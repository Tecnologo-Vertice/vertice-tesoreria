# 12 · Cómo funciona el sistema en producción (Apps Script) y qué le falta al nuevo

Fecha: 29/10/2026. Fuente: `vertice_produccion/` (9 archivos, última edición 29/10 10:11) y los 5 archivos que esa carpeta no tiene pero el dashboard llama, tomados de `apps_script_copia_lite/`. No se ejecutó nada: es lectura.

Objetivo: que el sistema nuevo (`demo/`) pueda hacer lo mismo, con la misma lógica y las mismas conexiones, sin duplicar nada mientras el proyecto de Santi siga prendido.

---

## 0. Hoy conviven dos proyectos de Apps Script sobre las mismas hojas

| | "facturas automatizadas" (Santi) | "sistema Vértice" (Brian, `vertice_produccion/`) |
|---|---|---|
| Qué hace | Lee Gmail y Drive, sube a Xubio las facturas aprobadas | Dashboard que usa el equipo, pagos, contabilización, cheques, mails, conciliación |
| Activadores | `procesarFacturasDesdeGmail` (10 min), `subirFacturasPendientesAXubio` (15 min), `procesarFacturasDesdeDrive` (4 h), `procesarPagosDesdeDrive` (20 h) | Solo `reprocesarLecturasPagos` (15 min). `Produccion.gs` borra los otros cuatro: mientras el viejo siga, este **no** lee mails, ni Drive, ni sube facturas |
| Hoja | `Facturas automatizadas` real (`SHEET_ID` 1inX5…) | La misma |
| Cash flow | — | `CASH FLOW GRUPO INDIA` real (1WBZxy…), `CASHFLOW_PERMITIR_REAL = true`, solo cheques cargados desde el 27/10/2026 |
| Xubio | Facturas de compra | Órdenes de pago y asientos, siempre real (no hay modo simulado) |

Cuando Santi apague su subida a Xubio: `activarSubidaXubioPropia()` en el proyecto nuevo.

El sistema nuevo (`demo/`) tiene que entrar en el mismo esquema: aprovecha que la hoja se carga sola, y gestiona lo demás.

---

## 1. Dónde viven los datos

### Hoja `Facturas automatizadas`

| Pestaña | Qué guarda |
|---|---|
| `Facturas` | Una fila por comprobante (48 columnas, `HEADERS` en Code.gs:285). Vive acá hasta que se contabiliza |
| `Facturas_Aprobadas` | Historial: la fila se mueve acá al contabilizar (`moverFilaAHistorial_`), con `ESTADO_PAGO = CONTABILIZADA` |
| `Pagos` | Una fila por pago (16 columnas base + 19 de `COLUMNAS_EXTRA_PAGOS` + `CHEQUE_CASHFLOW` + `RALPHARMA_CARGADO`) |
| `Catalogo_Proveedores` | A nombre · B CUIT · C código · D mail · E cuenta contable · F saltarXubio · G observación · H categoría Vértice |
| `Catalogo_Proveedores_Por_Empresa` | RECEPTOR · CUIT · nombre exacto en Xubio · CUENTA_CONTABLE |
| `Catalogo_Productos` | categoría contable → código de producto de compra en Xubio |
| `Catalogo_Percepciones_IIBB` | provincia → código de percepción |
| `Catalogo_Cuentas_Contables` | Plan de cuentas real de Xubio por empresa (`cargarPlanCuentasDesdeXubio`) |
| `Catalogo_Emails_Proveedores` | CUIT · proveedor · mail |
| `Xubio_Cuentas_Origen` | Bancos, cajas y e-cheqs que cada empresa usa en Xubio, con `tipoCuenta` (`descubrirCuentasOrigenXubio`) |
| `Cuentas_Origen_Pagos` | Banco (texto del comprobante) → cuenta de Xubio, aprendido de pagos reales |
| `Memoria_Cuentas_Pagos` | Empresa + destino → cuenta contable, cuenta de origen y forma de carga que usó Guido |
| `Xubio_Pagos_Log` | Cada envío de pago a Xubio con el payload |
| `Adjuntos_Gmail_Procesados`, `Archivos_Drive_Procesados` | Control de "ya lo leí" (messageId + nombre; fileId) |
| `Cheques` | Cheques con fecha de acreditación (lo usa `datosChequeParaOP_` como respaldo) |
| `Extractos_Movimientos`, `Extractos_Reglas`, `Conciliacion_Diaria` | Fase 3 (sección 9) |

### Cash flow `CASH FLOW GRUPO INDIA`

- `CHEQUES EMITIDOS`: 19 columnas (A..S). El sistema escribe EMISIÓN, DEPÓSITO, EMPRESA, BANCO, NÚMERO, TIPO, ACREEDORES, IMPORTE, ESTADO, OBSERVACIONES y copia las fórmulas de la fila vecina.
- `POSICIÓN DIARIA`: columna B banco, C empresa, D saldo inicial. Es "el flujo" al que se compara el saldo del extracto.
- `Categoría`: lista de acreedores (C3:C) para que el BUSCARV del cash flow no dé #N/A.

### Script Properties (claves)

`GEMINI_API_KEY` … `_5`, `XUBIO_CREDENTIALS_MULTI` = `{ "BERATUNG S.A.": {CLIENT_ID, SECRET_ID}, "CONTROL B S.A.", "INDIA ADV S.A.", "YSD PHARMA S.A.", opcional "VERTICE BI S.A." }`, `CASHFLOW_CHEQUES_DESDE`. Robles, Héctor Robles y Farma Control no tienen Xubio (`EMPRESAS_SIN_XUBIO`).

---

## 2. Estados

### Factura (fila de `Facturas`)

| Columna | Valores | Quién la mueve |
|---|---|---|
| `ESTADO_VALIDACION` | `OK` · `ERROR` (+ `MOTIVO_VALIDACION`) | IA + `validarFactura_` |
| `ESTADO_APROBACION` | `PENDIENTE_APROBACION` → `APROBADA` | Guido en el dashboard |
| `ESTADO_PAGO` | vacío → `PARA_PAGAR` → `PAGADA` → `CONTABILIZADA` / `NO_CONTABILIZADA` | Aprobación, Vivi, Xubio |
| `ESTADO_XUBIO` | vacío → `APROBADO` → `SUBIDO` / `YA EXISTE EN XUBIO (no se volvió a subir)` / `SIN_ERP_XUBIO` / `ERROR: …` / `OMITIDA: …` | Aprobación, subidor |
| `PORCENTAJE_PAGADO`, `SALDO_NC`, `NC_APLICADAS_JSON`, `XUBIO_ID_FACTURA`, `URLS_COMPROBANTE_PAGO_JSON`, `FECHA_PAGO`, `MAIL_ENVIADO_FECHA` | | |

```
mail / Drive / manual ─IA─► PENDIENTE_APROBACION ─Guido─► APROBADA + PARA_PAGAR + (APROBADO → Xubio cada 15 min → SUBIDO)
                                   │                            │
                                   └─ ERROR (Excepciones)        └─Vivi paga─► PAGADA (100 %) ─► CONTABILIZADA → Facturas_Aprobadas
                                                                               (parcial: sigue PARA_PAGAR con %)
```

### Pago (fila de `Pagos`)

| Columna | Valores |
|---|---|
| `TIPO_PAGO` | `FACTURA` · `SIN_FACTURA` (y factura "S/N" se trata como sin factura) |
| `ESTADO_CONTABLE` | `PENDIENTE` → `CONTABILIZADA` |
| `ESTADO_EXTRACCION_IA` | vacío → `OK` / `MANUAL_OK` / `ERROR_1..3` / `REVISION_MANUAL` |
| `FORMA_CARGA` | `ORDEN_PAGO` (con factura) · `SALIDA_FONDOS` · `ASIENTO_MANUAL` |
| `ESTADO_XUBIO_PAGO` | `SUBIDO` · `YA_EN_XUBIO` · `CARGADO_A_MANO` · `CARGAR_A_MANO` (e-cheq) · `SIN_ERP_XUBIO` (Ralpharma) · `ERROR` |
| `CHEQUE_CASHFLOW` | `AGREGADO …` · `YA ESTABA EN EL CASH FLOW` · `ERROR …` |
| `RALPHARMA_CARGADO` | fecha · quién · nota |

---

## 3. Flujo 1 · Entrada de facturas

**Gmail** (`procesarFacturasDesdeGmail`, hoy solo en el proyecto de Santi): `label:PROVEEDORES has:attachment -label:Facturas_Procesadas`, 50 hilos, lock, corte a los 5 min. Por adjunto: reconoce PDF/imagen por extensión aunque venga como `octet-stream`; salta si ya está en `Adjuntos_Gmail_Procesados`; 4 s entre adjuntos. El mail se marca leído y el hilo `Facturas_Procesadas` solo si no hubo errores; duplicadas → `Facturas_Duplicadas`; archivo ilegible (400 con dos keys) → `Facturas_Error` y queda para carga manual. Si todas las keys están sin cuota, corta y no marca nada.

**IA** (`extraerDatosConGemini`): prompt "manual de carga" con reglas AFIP (letra, CUIT del emisor vs receptor, NC/ND en positivo, percepciones IIBB por provincia, fechas DD/MM) y `responseSchema` con `CATEGORIA_CONTABLE` como enum de 22 cuentas. Modelos `gemini-3.5-flash-lite` (principal) y `gemini-3.6-flash`; hasta 5 keys; 429 enfría la key 1 min y pasa a la siguiente sin esperar; 503 enfría el modelo; `MAX_RETRIES = 10`.

**Orquestador** (`procesarFacturaCompleta_`), en este orden:
1. Normaliza el número y descarta duplicados por CUIT/proveedor + punto de venta + número (`facturaYaExisteEnSheet_`).
2. `Catalogo_Proveedores`: fuerza nombre, CUIT, cuenta contable, `saltarXubio`, categoría Vértice. Si no hay cuenta, `Catalogo_Proveedores_Por_Empresa` por receptor + CUIT.
3. Producto de Xubio desde `Catalogo_Productos`.
4. Blindaje: proveedor "Droguería Robles" / "Héctor Robles" fuerza el receptor.
5. `validarFactura_`: TIPO obligatorio; CAE de 14 dígitos; B/C con todo en exento se pasa a importe; CAE vencido **antes** de la emisión es error (después, no); neto + IVA + exento + percepciones = total (±1 peso es "OK con aviso").
6. PDF a Drive **obligatorio** (unidad compartida, carpeta por receptor y proveedor); si falla, no se guarda nada y el mail se reintenta.
7. `guardarEnSheets`: fila con `PENDIENTE_APROBACION`, `CATEGORIA_CONTABLE` por defecto "Gastos Generales", `SALDO_NC = TOTAL` si es NC.
8. Mails de alerta: factura M, o validación con error.

**Drive** (`procesarFacturasDesdeDrive`): carpeta BERATUNG → `FACTURAS PROFESIONALES INTERNACION DOMICILIARIA`, `FACTURAS PRESTADORES MEDICOS`, `GASTOS MENSUALES 2026` (salvo `FACTURA(S) COLABORADORES`); control por fileId; 7 s entre archivos.

**Manual** (`subirFacturaManual`): guarda el archivo en `Facturas_Manuales_Pendientes_IA`, deja la tarea en Script Properties y un trigger a 10 s la procesa con el receptor que eligió la persona.

---

## 4. Aprobación y subida de la factura a Xubio

- `aprobarFacturaFlujo(fila, metodo, tipo, numeroEsperado)`: `numeroEsperado` evita actuar sobre otra fila si la hoja se reordenó. Completa la cuenta contable desde los catálogos si está vacía; `APROBADA`; `ESTADO_PAGO = PARA_PAGAR` (con **tarjeta de crédito pasa directo a `PAGADA`**); `ESTADO_XUBIO = APROBADO`, o `SIN_ERP_XUBIO` si el proveedor salta Xubio. Tipo de pago: `CUENTA_CORRIENTE` o `ANTICIPADO`.
- `aprobarFacturaYaPagada` (PagoAlAprobar.gs): segundo camino. Aprueba, deja la factura `PAGADA` y crea el pago en `Pagos` (o ya `CONTABILIZADA` si Guido marca que estaba cargado a mano en Xubio).
- Excepciones: `guardarCorreccionYAprobar`, `actualizarFacturaEnSheet` (edita campos), `eliminarFactura`.
- **Subida** (`subirFacturasPendientesAXubio`, cada 15 min, recorre de abajo hacia arriba las `APROBADO`) → `subirUnaFilaAXubio_`:
  1. Token por empresa: `XUBIO_CREDENTIALS_MULTI`, comparado por receptor canónico; si no hay una única coincidencia, **no sube**.
  2. Proveedor: catálogo por empresa → nombre exacto → mismas palabras en otro orden → coincidencia parcial. Si no existe: `ERROR: el proveedor … no está en Xubio` (antes se marcaba `SIN_ERP_XUBIO` en silencio).
  3. `construirFacturaCompra_` → `comprobanteCompraBean` (circuito −2, tipo 1/2/3, producto por código, percepciones desde `PERCEPCIONES_JSON`, fechas con fallback a hoy).
  4. Duplicado en Xubio: mismo número + mismo proveedor (id o mismas palabras), 120 días hacia atrás. Si Xubio no responde: `VERIFICACION_PENDIENTE`, no sube, reintenta en 15 min.
  5. POST → `SUBIDO` + `XUBIO_ID_FACTURA`. Error → texto legible (p. ej. "la cuenta X no existe como producto de compra en el Xubio de …").
- Reintento a mano desde Para Pagar: `reintentarSubidaXubioEnParaPagar` (guarda cambios, valida, sube sin chequear duplicado).
- Al pagar al 100 %, `actualizarEstadoContableSegunXubio_`: `SUBIDO`/`YA EXISTE`/`SIN_ERP_XUBIO` → `CONTABILIZADA`; error → `NO_CONTABILIZADA` con motivo.

---

## 5. Flujo 2a · Pagos (Vivi)

| Camino | Función | Qué hace |
|---|---|---|
| Pagar una factura | `adjuntarComprobantePago` → `confirmarPago(fila, monto, obs)` | Comprobantes a Drive `Comprobantes_Pago` (link público). Exige monto > 0 y al menos un comprobante. `marcarComoPagadaMultiple_`: suma % (`PORCENTAJE_PAGADO`), `PAGADA` al 100 % con `FECHA_PAGO`, **una fila en `Pagos` por comprobante** con `FORMA_CARGA = ORDEN_PAGO` y la cuenta contable de la factura, quién la cargó y observaciones. Tarea de IA en segundo plano (`procesarTareasIAPagoPendientes_`) |
| Varias facturas con un comprobante | `pagarMultiplesFacturas` | Actualiza cada factura con su monto; **un solo pago** `PAGO-MULTIPLE-…` con las facturas separadas por coma |
| Nota de crédito | `aplicarNotaCreditoAFactura` | Mismo proveedor (CUIT) y misma empresa, NC aprobada, descuenta `SALDO_NC`, registra en `NC_APLICADAS_JSON`, puede dejar la factura `PAGADA` |
| Pago sin factura | `subirPagoManual` → `procesarTareasIAPagoManualPendientes_` | Lo que escribió Vivi **pisa** lo que lee la IA. Guarda `EMPRESA`, `FORMA_CARGA`, `CUENTA_CONTABLE`, `CUENTA_ORIGEN` y `AVISO_IMPORTE` si la IA leyó otro importe. `aplicarSugerenciaCuentas_` propone cuenta contable y forma desde `Memoria_Cuentas_Pagos`, y cuenta de origen según el banco |
| Precompletar el formulario | `leerComprobantePagoParaFormulario` | IA sincrónica, no guarda nada |
| Carpeta de Drive de pagos | `procesarPagosDesdeDrive` | Últimos 3 días, recursivo, ruta de carpetas como pista para la IA. Hoy solo en el proyecto de Santi |

**IA de comprobantes** (`extraerDatosPagoConGemini_`): beneficiario, pagador, bancos origen/destino (inferido por los 3 primeros dígitos del CBU), N° de cuenta, N° de cheque, `FECHA_PAGO` (emisión), `FECHA_VTO_CHEQUE` (cobro), `TIPO_CHEQUE` ECHEQ/FISICO, importe. Para fotos de cheques no adivina: deja vacío. `completarPagoSoloVacios_` nunca pisa lo que cargó una persona. Lecturas fallidas: `reprocesarLecturasPagos` cada 15 min, 3 intentos, después `REVISION_MANUAL`; 400 de Gemini corta de una.

---

## 6. Flujo 2b · Contabilización (Guido)

`marcarPagoContabilizado(fila, detalle)`, con lock:
1. Rechaza si ya está contabilizado, sin importe, sin destino, o cheque sin `FECHA_VTO_CHEQUE` (solo pagos cargados desde el 27/10).
2. Con factura → `ORDEN_PAGO` por defecto. Sin factura → exige cuenta contable y forma de carga (salvo empresas sin Xubio).
3. `registrarPagoEnXubio_`:
   - Empresa: `EMPRESA` → receptor de la factura → `REALIZADO_POR`. Sin Xubio → `SIN_ERP_XUBIO` (va a la bandeja Ralpharma).
   - Cuenta de origen: `CUENTA_ORIGEN` → `Cuentas_Origen_Pagos` (aprendida) → `Xubio_Cuentas_Origen` por banco, N° de cuenta y si es cheque. Si hay varias posibles, **frena** y pide confirmar.
   - `ORDEN_PAGO` → `pagoBean` con proveedor (id de Xubio), instrumento con `tipoCuenta` 1 caja / 2 banco / 5 (e-cheq se manda como 5), cheque (`chequePropio`, `vencimientoCheque`, `banco` del catálogo de Xubio). E-cheq contra la cuenta tipo 4: Xubio no lo acepta por API → `CARGAR_A_MANO`. Duplicado (mismo proveedor, importe, ±5 días) → `YA_EN_XUBIO`.
   - Imputación de la OP a la factura: solo si `XUBIO_CAMPO_IMPUTACION_OP` está definido (hoy `null`): **la OP no tilda la factura**, Guido la aplica a mano.
   - `SALIDA_FONDOS` y `ASIENTO_MANUAL` → `asientoContableManualBean` (debe: cuenta del gasto / haber: cuenta de origen, `externalId = ID_PAGO`).
   - Todo queda en `Xubio_Pagos_Log`.
4. `CONTABILIZADA`, quién y cuándo. Cheque → cash flow (sección 7). Sin factura → aprende cuentas en `Memoria_Cuentas_Pagos`.

Otras acciones: `marcarPagoYaCargadoEnXubio` (`CARGADO_A_MANO`, no envía nada); `marcarComoContabilizada` para la factura (sube si falta y la mueve al historial); Ralpharma: `obtenerPagosRalpharma` (contabilizados `SIN_ERP_XUBIO` sin `RALPHARMA_CARGADO`), `marcarCargadoEnRalpharma`.

---

## 7. Cheques → cash flow (`CashFlowCheques.gs`)

`registrarChequesEnCashFlow_` corre al contabilizar, al guardar un pago con cheque y en `reprocesarLecturasPagos`: toma los pagos con N° de cheque, importe, sin `CHEQUE_CASHFLOW`, contabilizados **o** con fecha de cobro, con `ID_PAGO` del 27/10/2026 en adelante. En `CHEQUES EMITIDOS`: no duplica (empresa + banco + número), inserta en el lugar según fecha de depósito, copia las fórmulas de la fila vecina, nombres de empresa y banco como los escribe tesorería (`CF_EMPRESAS`, `cfBanco_`), acreedor desde la pestaña `Categoría`, `ESTADO = Pendiente`, observación "Cargado por el sistema · ID". Relee la fila para verificar; cache de 60 s contra ejecuciones simultáneas.

---

## 8. Mails a proveedores (`MailsProveedores.gs`)

**No envía.** `prepararMailsComprobantes(items)` arma un mail por proveedor (destinatario de `Catalogo_Emails_Proveedores`, remitente `tesoreria@verticebi.com` o la casilla de Robles, detalle de facturas y pagos, comprobantes como links de Drive) y la pantalla lo abre en Gmail. `marcarMailPreparado` escribe `MAIL_ENVIADO_FECHA = "Preparado en Gmail …"`. Las funciones viejas que sí enviaban (`enviarComprobantePorMail`) siguen en Code.gs.

---

## 9. Conciliación bancaria (fase 3): ya está empezada

`ConciliacionBancaria.gs` (20/10, en `apps_script_copia_lite/`; el `Index.html` de producción ya tiene la sección "Conciliación · Extractos y flujo") hace exactamente el diagrama que dictó Feli:

| Diagrama | Implementado |
|---|---|
| Extractos | `importarExtracto`: .xlsx (lee el zip a mano), .csv, .xls viejo (pide guardarlo como xlsx), HTML del home banking. Detecta columnas por encabezado (fecha, débito/crédito o importe, saldo, descripción, referencia), ordena cronológicamente usando el saldo, no duplica (id = hash de empresa+banco+fecha+texto+importes) |
| Cheque pagado → cash flow | Regla `CHEQUE_PAGADO` → busca en `CHEQUES EMITIDOS` por empresa + banco + número + importe y lo pasa a `ESTADO = Pagado` con "Debitado dd/mm/aa (extracto)". Ambiguo → `REVISAR …` |
| Rendimientos FCI, gastos bancarios, impuestos → cuenta contable | `Extractos_Reglas` (8 reglas iniciales editables: Ley 25.413, SIRCREB, percepción IVA, IVA, comisiones, rendimiento FCI, suscripción/rescate, cheques) con cuenta sugerida. Guido corrige y puede "recordar" (crea regla) |
| Conciliación diaria | `Conciliacion_Diaria`: saldo inicial + créditos − débitos vs saldo del extracto, estado OK / DIFERENCIA / SIN SALDO |
| Saldo final flujo vs saldo final extracto | Último día comparado contra `POSICIÓN DIARIA` (`SALDO_FLUJO`, `DIF_FLUJO`); botón "Pasar último saldo al flujo" escribe la columna D |
| Cuenta contable → Xubio / Ralpharma | **No está** ("segunda etapa" según el encabezado del archivo) |

---

## 10. Lo que conviene arreglar en producción (encontrado al leer)

1. **Secretos escritos en `Code.gs`**: `guardarSegundaApiKey` (línea 336, una key de Gemini), `guardarCredencialesMultiempresa` (líneas 344-350, CLIENT_ID y SECRET_ID de Xubio de las 4 empresas) y `guardarKeysFaltantes` (línea 4512 en adelante, keys de Gemini). Las credenciales ya se cargaron en Script Properties, así que esas funciones tienen que quedar con los valores vacíos (como `agregarCredencialesVertice`) y los secretos **rotados** en Xubio y AI Studio. Además, `vertice_produccion/` no está en `.gitignore`: no commitearla hasta limpiar eso.
2. **La carpeta local está incompleta**: `Index.html` llama a `importarExtracto`, `obtenerConciliacion`, `obtenerPagosRalpharma`, `marcarCargadoEnRalpharma`, `contarPendientesRalpharma`, `aprobarFacturaYaPagada`, `obtenerCatalogoCuentas`, y el código usa `asegurarColumnas_`, `escribirPestana_`, `HOJA_CUENTAS`, `imputacionOP_`. Están en `ConciliacionBancaria.gs`, `Ralpharma.gs`, `PagoAlAprobar.gs`, `Helpers.gs` y `XubioImputacion.gs` de `apps_script_copia_lite/`. Verificar que el proyecto de producción los tenga; si no, fallan Conciliación, Ralpharma, "Aprobar · ya pagada" y `cargarPlanCuentasDesdeXubio`.
3. `apps_script_copia_lite/` y `vertice_produccion/` divergieron (Code.gs 63 líneas de diferencia, ParchePagos 142, Index 245): la copia de desarrollo ya no es espejo de producción.
4. `aprobarFacturaFlujo` tiene código muerto después del `return` (Code.gs 2383-2395).
5. `XUBIO_CAMPO_IMPUTACION_OP` sigue en `null`: la OP se crea pero no cancela la factura en Xubio.
6. El dashboard no tiene usuarios ni roles: cualquiera con acceso a la implementación ve y hace todo; `usuarioActual_()` solo registra el mail.

---

## 11. Sistema nuevo (`demo/`): qué ya hace igual y qué falta

Regla de la etapa: **ingesta y subida de facturas apagadas** en el sistema nuevo (el viejo las sigue haciendo). El nuevo toma lo que la hoja carga y gestiona el resto.

| Pieza | En producción (Apps Script) | En `demo/` | Falta |
|---|---|---|---|
| Fuente de facturas | Hoja `Facturas` | Base Supabase; `gas/EnviarAlSistema.gs` → `ingresar_factura` (idempotente, respeta lo decidido en el nuevo) | Correr el espejo **programado** (cada 10 min) y completar el mapeo: `PORCENTAJE_PAGADO`→`pagado`, `XUBIO_ID_FACTURA`, `SALDO_NC`, `URLS_COMPROBANTE_PAGO_JSON`, `Facturas_Aprobadas` como contabilizadas. Dejar `CarteroGmail` y `leer-documentos` sin activar |
| Catálogos | 9 pestañas (sección 1) | `cuentas_contables` (22 de ejemplo), `cuentas_origen` **vacía**, `proveedores.cuenta_habitual`, `reglas_cuenta` | Importar desde la hoja: proveedores con cuenta y `saltarXubio`, `Catalogo_Cuentas_Contables` por empresa, `Xubio_Cuentas_Origen` con `tipo_cuenta`, `Catalogo_Productos`, mails |
| Aprobación | Cuenta + método + tipo, "ya pagada", corrección, eliminar, tarjeta → pagada | `aprobar_factura` (cuenta, método, días de cheque), rechazar, `corregir_factura` (solo vuelve a pendiente) | Editar datos en Excepciones, "Aprobar · ya pagada", tarjeta de crédito directo a pagada, tipo cuenta corriente / anticipado |
| Factura → Xubio | Automático cada 15 min | `xubio-subir-pendientes` cada 10 min, en seco | Mantener `XUBIO_FACTURAS_ENVIO_REAL=false` mientras el viejo suba; tomar `xubio_id` del espejo |
| Pagos | Con factura, parcial, múltiple, NC, sin factura, IA, memoria, aviso de importe, reintento de lectura | `registrar_pago` (una o varias facturas, parcial, sin factura), `ia-leer-comprobante`, `reglas_cuenta` | NC (`saldo_nc` existe, no se usa), `TIPO_CHEQUE`, aviso IA vs tesorería, cola de reintento para comprobantes de pago, memoria de cuenta de origen por banco |
| Contabilización | OP / salida de fondos / asiento, cuenta de origen deducida, duplicado ±5 días, e-cheq a mano, "ya cargado en Xubio", log | `contabilizar` (OP / asiento, cuentas verificadas, pago dentro de la factura opcional), `xubio_log` | Duplicado en Xubio antes de enviar, e-cheq → cargar a mano, botón "ya está en Xubio", deducción de cuenta de origen por banco, aprendizaje |
| Ralpharma | Bandeja de pagos | Pantalla con facturas y pagos | — |
| Cheques → `CHEQUES EMITIDOS` | Sí, con fórmulas y orden | Solo CSV `Export_CashFlow` | Portar `CashFlowCheques.gs` (escritura en Sheets desde Netlify con cuenta de servicio), o dejar que el Apps Script lo siga haciendo leyendo los pagos de la base |
| Mails a proveedores | Preparar en Gmail | Marca `MAIL_PENDIENTE` | Portar `prepararMailsComprobantes` (link a Gmail compose con cuerpo armado) |
| Conciliación | Sección 9 | Nada (`movimientos_bancarios` vacía) | Portar `ConciliacionBancaria.gs`: tablas `extracto_movimientos`, `extracto_reglas`, `conciliacion_diaria`; lectura de xlsx/csv en Netlify (más simple que en GAS); lectura y escritura de `POSICIÓN DIARIA` y `CHEQUES EMITIDOS` |
| Entrada por Drive | Sí | `origen: DRIVE` aceptado | Cartero de Drive (apagado en esta etapa igual) |
| Login, roles, auditoría | No hay | Google + `usuarios`, RLS, `auditoria` | — (acá el nuevo ya es mejor) |

---

## 12. Orden propuesto para mostrar velocidad sin riesgo de duplicados

1. **Espejo de la hoja → base**, programado, con los catálogos importados. Con eso el nuevo muestra las mismas facturas que el dashboard actual, con login, roles, auditoría y pantallas más rápidas. Ingesta y subida apagadas. Riesgo cero: solo lee.
2. **Pagos y contabilización en el nuevo para una empresa piloto** (Vértice BI, que tiene Xubio y pocos movimientos). Regla: los pagos de esa empresa se cargan en **un solo** sistema, porque la OP en Xubio no se puede borrar por API. Antes: duplicado ±5 días y "ya cargado en Xubio" portados.
3. **Escribir de vuelta en la hoja** `ESTADO_PAGO`, `PORCENTAJE_PAGADO`, `FECHA_PAGO` y la fila de `Pagos`, para que el cash flow y el proyecto de Santi sigan viendo todo. Si no se hace, durante el piloto la hoja y la base divergen para esa empresa.
4. **Cheques → cash flow y conciliación** portados, con las mismas protecciones (`CASHFLOW_PERMITIR_REAL`, solo cheques desde una fecha).
5. Recién después: cartero de Gmail y Drive propios, y apagar el proyecto de Santi.

---

## 13. Decisiones del 29/10/2026 para la demo del sistema nuevo

| Tema | Decisión |
|---|---|
| Lectura | El sistema nuevo **lee la hoja REAL** `Facturas automatizadas` (1inX5…) cada 10 min: Facturas, Facturas_Aprobadas, Pagos y catálogos. Solo lectura: nunca escribe en ella |
| Escritura | Todo lo que hace el sistema nuevo se escribe en las hojas **DEV**: `DEV Facturas automatizadas` (1sObr4…) y `DEV CASH FLOW GRUPO INDIA` (1pGRGw…, con `POSICIÓN DIARIA`, `CHEQUES EMITIDOS`, `Categoría`) |
| Xubio | **En seco**: lee y verifica (proveedor, cuentas, duplicados) y muestra qué enviaría. No crea nada. `XUBIO_FACTURAS_ENVIO_REAL`, `XUBIO_ENVIO_REAL` y `XUBIO_PAGO_EN_FACTURA` en `false` |
| Ingesta | Cartero de Gmail, Drive y `leer-documentos` apagados: las facturas las sigue cargando el proyecto de Santi en la hoja real |
| Usuarios | Solo Brian, para mostrar. El equipo sigue en el dashboard de producción |

Estado de las DEV al 29/10: la de facturas tiene datos hasta el 22/10 (último `ID_PAGO` 1792698005398) y no recibe nada nuevo; es destino de escritura, no fuente.

Pendiente de Brian: verificar en el editor de producción que estén `ConciliacionBancaria`, `Ralpharma`, `PagoAlAprobar`, `Helpers` y `XubioImputacion` (sección 10.2), y sacar los secretos de `Code.gs` (sección 10.1).

### Plan de construcción

1. **Espejo REAL → base.** Apps Script puente en el proyecto de desarrollo (corre como tecnologia@, que ya tiene acceso a la hoja real): lee por nombre de columna y manda lotes a `/api/espejo` con `INGESTA_TOKEN`. La base guarda la fila de origen (`sheets_fila_origen`, pestaña) y lo que decidió el sistema nuevo no se pisa (misma regla que `ingresar_factura`). Incluye catálogos: proveedores (cuenta, `saltarXubio`, categoría), plan de cuentas por empresa, `Xubio_Cuentas_Origen` → `cuentas_origen` con `tipo_cuenta`, productos, mails.
2. **Paridad de pantallas con datos reales**: aprobar (incluido "ya pagada" y tarjeta → pagada), editar en Excepciones, pagos con NC, pago múltiple, pago sin factura con memoria; contabilización en seco con las verificaciones de producción (duplicado ±5 días, e-cheq a mano, cuenta de origen por banco, "ya está en Xubio").
3. **Base → hojas DEV.** El mismo puente toma una cola de escrituras de la base (`salida_hojas`) y las aplica en las DEV: estados de factura, filas de `Pagos`, cheques en `CHEQUES EMITIDOS`, saldo en `POSICIÓN DIARIA`.
4. **Conciliación** portada de `ConciliacionBancaria.gs`, con extractos leídos en Netlify y escritura en el cash flow DEV por la cola del paso 3.
5. Comparación de tiempos lado a lado (dashboard de producción vs. sistema nuevo) para la demo.

---

## 14. Paso 1 hecho: copia de la hoja real a la base (29/10/2026)

**Qué se construyó**

| Pieza | Archivo | Qué hace |
|---|---|---|
| Puente | `demo/gas/PuenteHojas.gs` + `PuenteHojas.appsscript.json` | Proyecto de Apps Script nuevo y aparte. Cada 10 min lee Facturas, Facturas_Aprobadas y Pagos de la hoja real, y una vez por hora los catálogos. Manda las filas tal cual a `/api/espejo`. Permiso de Google: solo lectura de hojas |
| Traducción | `demo/netlify/functions/lib/espejo.ts` | Fila de la hoja → factura o pago de la base, con las reglas de producción (empresas escritas de 20 formas, estados, % pagado en pesos, Xubio, Ralpharma, notas de crédito, cheques) |
| Recepción | `demo/netlify/functions/espejo.mts` | `/api/espejo` con el mismo `INGESTA_TOKEN`; anota cada corrida en `espejo_estado` |
| Base | `demo/supabase/migrations/0008_espejo_hoja.sql` | `espejar_facturas`, `espejar_pagos`, `espejar_catalogos`; columna `gestion` (HOJA / SISTEMA); filas sin cambios no se reescriben (huella) |
| App | `Layout.tsx` | En la barra lateral: "Copia de la hoja real: hace N min" y cuántas filas no se pudieron copiar (con el motivo al pasar el mouse) |

**Reglas**
- La hoja manda sobre cada factura o pago mientras nadie lo toque en el sistema nuevo. Apenas se aprueba, paga o contabiliza acá, pasa a `gestion = SISTEMA` y la copia ya no lo pisa (solo actualiza dónde está la fila y el link del PDF).
- Lo pagado de cada factura sale de `PORCENTAJE_PAGADO` de la hoja. Los pagos copiados se vinculan a sus facturas para mostrarlos, sin volver a sumarlos.
- Filas que se omiten, con motivo: receptor que no es del grupo, CUIT incompleto, número ilegible, pago anulado, pago sin empresa ni factura.
- Un pago copiado puede tener importe 0 (la IA todavía no leyó el comprobante); uno cargado en el sistema nuevo, nunca.

**Pruebas:** `npm test` = 28 IA + 20 Xubio + 67 traducción + 94 base (26 nuevas del espejo, que usan la misma traducción).

### Para encenderlo 👨🏽‍💻

1. **Supabase** → SQL Editor → pegar `demo/supabase/migrations/0008_espejo_hoja.sql` → Run. (Si la base es nueva, `instalar_todo.sql` ya la incluye.)
2. **Netlify**: que esté desplegada la última versión. Variables: `INGESTA_TOKEN` cargado; `XUBIO_FACTURAS_ENVIO_REAL`, `XUBIO_ENVIO_REAL` y `XUBIO_PAGO_EN_FACTURA` en `false`. El cartero de Gmail no se usa en esta etapa.
3. **Apps Script**, con tecnologia@: script.google.com → **Nuevo proyecto** → nombre "Puente sistema nuevo".
   - Pegar `demo/gas/PuenteHojas.gs` en `Código.gs`.
   - Configuración del proyecto → tildar "Mostrar el archivo de manifiesto appsscript.json" → reemplazar su contenido por `demo/gas/PuenteHojas.appsscript.json`.
   - Propiedades del script: `SISTEMA_URL` = la URL de Netlify, `INGESTA_TOKEN` = el mismo de Netlify.
   - Ejecutar `probarPuente` (pide permisos: ver hojas, conectarse a un servicio externo, activadores). Muestra cuántas filas mandaría, sin mandar nada.
   - Ejecutar `espejarHojaReal` (la primera vez tarda más: copia todo). El registro muestra nuevas, actualizadas, sin cambios y omitidas por pestaña.
   - Ejecutar `crearActivadorPuente` (cada 10 min).
4. Entrar a la app: la barra lateral tiene que decir "Copia de la hoja real: hace N min".

Para frenarlo: `borrarActivadorPuente()`. No toca ni el proyecto de producción ni el de Santi.

**Siguiente (paso 2):** pantallas con los datos reales copiados. Pagos: abrir el comprobante de Drive (`comprobante_url`), mostrar lectura de la IA, aviso de importe y tipo de cheque. Aprobación: elegir la cuenta del plan de la empresa y el producto de Xubio. Contabilización en seco con las verificaciones de producción.

---

## 15. Paso 2 hecho: pantallas con los datos reales (29/10/2026)

| Pantalla | Qué cambió | Igual que producción |
|---|---|---|
| Todas | Plan de cuentas **por empresa** (el real copiado de Xubio, 300-400 cuentas cada una) con buscador; solo acepta cuentas de la lista (regla de oro) | Desplegable de cuentas por empresa |
| Aprobación | La "cuenta" de la factura sale de los productos de compra de Xubio (`Catalogo_Productos`), que es lo que guarda producción en `CATEGORIA_CONTABLE` y lo que Xubio necesita | `obtenerProducto_` |
| Contabilización | Cuenta de origen elegible en la tarjeta, deducida del banco del comprobante: con cheque, la de e-cheqs de ese banco; con dos cuentas del mismo banco decide el N° de cuenta; si no, la más usada y marcada para revisar | `cuentaOrigenDesdeXubio_` |
| Contabilización | Comprobante en Drive, aviso si la IA no leyó el comprobante, aviso de importe distinto, badge "De la hoja", botón bloqueado con el motivo (sin importe, sin cuenta de origen, cuenta fuera del plan) | Tarjeta de Guido |
| `/api/contabilizar` | Guarda la cuenta de origen elegida; frena importe 0; e-cheq contra la cuenta tipo 4 → "cargar a mano" (en seco solo avisa); **¿ya está en Xubio?** mismo proveedor e importe ±5 días → no se vuelve a cargar; deja el detalle visible en la tarjeta | `buscarPagoXubioExistente_`, `CARGAR_A_MANO` |
| Xubio | Las cuentas se encuentran también como "CÓDIGO NOMBRE" (formato de producción); antes solo por nombre y con datos reales no encontraba ninguna | `buscarCuentaXubio_` |
| Pagos | Cuentas de origen ordenadas por uso; cuenta contable con buscador | — |

**Pruebas:** `npm test` = 28 IA + 23 Xubio + 80 espejo y cuentas + 94 base = 225.

**Siguiente (paso 3):** escribir en las hojas DEV lo que hace el sistema nuevo (estados de facturas, `Pagos`, `CHEQUES EMITIDOS`, `POSICIÓN DIARIA`).

### Primera copia real (30/10/2026)

Catálogos: 1.339 cuentas, 22 cuentas de origen, 570 proveedores por empresa, 24 mails, 109 productos. Facturas: 493 + 40 del historial. Pagos: 519.

Omitidas a propósito (se ven en la app al pasar el mouse por "filas sin copiar"):

| Qué | Cuántas | Por qué |
|---|---|---|
| Pagos anulados | 25 | No existen para el sistema |
| Receptor vacío | 14 | Archivos que la IA no pudo leer: sin receptor, CUIT, tipo ni número. En producción quedan como "Comprobante sin TIPO válido" |
| CUIT vacío | 10 | Sin CUIT ni número (por ejemplo, consorcio "S/N"); producción tampoco los puede subir a Xubio |
| Receptor de afuera del grupo | 7 | "Consumidor Final", "Dax", personas: producción los muestra como "Otros" |
| Pagos sin empresa | 10 | Lecturas viejas de agosto sin importe ("S/D") o pagos de facturas a nombre de personas |

Las 4 facturas "sin tipo" que tienen CUIT y número (aprobadas y pagadas en producción) entran como tipo "Sin tipo" con la validación en error.

Al copiar se encontró y corrigió: `SpreadsheetApp` exige el permiso completo de hojas (el puente lee por la API de Sheets con solo lectura) y `Facturas_Aprobadas` muestra las fechas como mm/dd/aaaa (el puente las pide como número de serie).
