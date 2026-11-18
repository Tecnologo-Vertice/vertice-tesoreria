# Lo que se trajo del Apps Script · 18/11/2026

Fuente: proyecto "facturas automatizadas · DESARROLLO" y docs/12. Se reescribió para la base y las pantallas del sistema nuevo, con la misma lógica.

| Apps Script | Sistema nuevo | Dónde |
|---|---|---|
| `aplicarNotaCreditoAFactura` | `aplicar_nota_credito(nc, factura, importe)` · Pagos → NC → "Aplicar a una factura" | 0011, `Pagos.tsx` |
| `aprobarFacturaYaPagada` (PagoAlAprobar.gs) | `aprobar_factura_ya_pagada(id, cuenta, método, pago)` · Aprobación → "Aprobar · ya pagada" | 0011, `Aprobacion.tsx` |
| `anularPago` | `anular_pago(id, motivo)` · Contabilización → "Anular este pago" | 0011, `Contabilizacion.tsx` |

## Reglas (las mismas del Apps Script)

**Nota de crédito**
- Mismo proveedor (CUIT) y misma empresa. La NC tiene que estar aprobada.
- Se aplica hasta el saldo de la NC y hasta lo pendiente de la factura.
- Al agotarse, la NC queda PAGADA. Cada aplicación queda en `notas_credito_aplicadas` y en la auditoría.
- Una NC nueva arranca con todo su total como saldo (`SALDO_NC = TOTAL`). La NC ya no aparece en el flujo como egreso proyectado.

**Ya pagada**
- Ya cargado a mano en Xubio → factura PAGADA y pago CONTABILIZADO (`CARGADO_A_MANO`); no se envía nada.
- Con banco o caja → factura PAGADA y pago en Contabilización.
- Sin banco → queda en Para pagar marcada "Ya pagada: falta el comprobante" y no se crea pago. La marca se limpia al pagarla.
- Cheque: exige número y vencimiento.

**Anular**
- Solo pagos que no están en Xubio ni en Ralpharma, y que no vienen de la hoja.
- Exige motivo. Devuelve a cada factura lo que el pago le había aplicado.
- Nuevo estado `ANULADO`; el flujo no lo cuenta.

Las tres acciones controlan rol y empresa (0010) antes de cualquier otro mensaje.

## Pruebas

| Grupo | Resultado |
|---|---|
| `npm run test:sql` | 166 OK, de los cuales 30 son de esta tanda |
| Prueba de punta a punta en la demo | Aprobar ya pagada → aparece la marca en Pagos; anular un pago → queda en la auditoría |

## Tanda 2 · Mails a proveedores (MailsProveedores.gs v6)

| Apps Script | Sistema nuevo |
|---|---|
| `prepararMailsComprobantes` | `src/lib/mails.ts` (`armarMails`) · Pagos → Pagadas → marcar → "Preparar mails" |
| `guardarEmailProveedor` | `guardar_email_proveedor` (0012) · botón "Guardar" junto al destinatario |
| `marcarMailPreparado` | `marcar_mail_preparado` (0012) · al tocar "Abrir en Gmail" |

**No envía nada.** Arma un mail por proveedor y lo abre en el Gmail del remitente:
- Remitente: Robles y Héctor Robles salen de la casilla de Tesorería de Robles; el resto, de tesoreria@.
- Texto: primero las facturas, con las NC aplicadas debajo. Después los pagos una sola vez: un cheque que pagó varias facturas va con su total, y se aclara "también cancela…".
- Comprobantes como link: el de Drive, o un enlace firmado por 30 días a Storage.

## Tanda 3 · Cheques al Cash Flow y Flujo de caja

La escritura en las planillas la sigue haciendo Apps Script, con el mismo código de producción. Los datos ahora salen del sistema.

| Apps Script | Sistema nuevo |
|---|---|
| `CashFlowCheques.gs` | `gas/ChequesCashFlow.gs` + `/api/cheques/pendientes` y `/api/cheques/resultado` (`cheques_para_cashflow`, `marcar_cheques_cashflow`) |
| `FlujoCaja.gs` | `gas/FlujoCaja.gs` + `/api/flujo/datos` (`flujo_datos`: pagos y facturas con los encabezados de la hoja) |

**Cheques**
- Inserta en orden de depósito, copia las fórmulas vecinas y no duplica (empresa + banco + número).
- Un cheque de varios pagos del mismo lote entra en una sola fila con el total. Relee lo escrito.
- Solo toma pagos del sistema nuevo: los de la hoja los sigue pasando producción, así que los dos conviven.

**Flujo:** aplica las mismas reglas A a G, el Mapa Flujo y los anticipos ESPERA_FC.
- ESPERA_FC en el sistema nuevo = pago a un proveedor con orden de pago y sin factura vinculada.

**Seguridad:** los dos solo escriben en una planilla cuyo nombre diga copy o copia, salvo que `CASHFLOW_PERMITIR_REAL` o `FLUJO_PERMITIR_REAL` estén en `true`.

## Tanda 4 · Xubio y Drive

| Apps Script | Sistema nuevo |
|---|---|
| `cargarPlanCuentasDesdeXubio` + `descubrirCuentasOrigenXubio` | `lib/xubio-catalogos.ts` · botón "Actualizar cuentas desde Xubio" (Contabilización) y cada lunes (`xubio-catalogos-semanal`) |
| `procesarFacturasDesdeDrive` | `gas/CarteroDrive.gs` + `/api/ingesta/conocidos` · mismas carpetas, entra por la misma cola que Gmail |

- **Catálogos de Xubio:** solo lee Xubio. Guarda con `espejar_catalogos`, que agrega o actualiza y nunca borra: si una empresa falla, queda lo que había.
- **Cartero de Drive:** antes de bajar un archivo pregunta si ya entró, así no repite.

**Resumen diario de vencimientos por mail:** no está en la copia de DESARROLLO del Apps Script, así que no se trajo. [FALTA: confirmar si existe en producción y cuál es su formato.]

## Para encenderlo

| Dónde | Qué |
|---|---|
| Netlify | `CASHFLOW_CHEQUES_DESDE` = aaaa-mm-dd (desde qué carga de pago se pasan los cheques) |
| Apps Script, Script Properties | `SISTEMA_URL`, `INGESTA_TOKEN` (los mismos del cartero de Gmail) |
| Apps Script, cheques | `CASHFLOW_CHEQUES_SHEET_ID` (primero una copia) · `revisarChequesCashFlow()` → `pasarChequesAlCashFlow()` → `crearTriggerCheques()` |
| Apps Script, flujo | `FLUJO_SHEET_ID` (la copia del Flujo) · `fxActualizarFlujo()` → `fxCompararConManual()` → `fxInstalarActivadorDiario()` |
| Apps Script, Drive | `CARPETA_BERATUNG_DRIVE_ID` · `probarCarteroDrive()` → `enviarArchivosDeDrive()` → `crearTriggerCarteroDrive()`. Mientras producción siga leyendo Drive, dejarlo apagado: leerían los mismos archivos |

## Pruebas

| Grupo | Resultado |
|---|---|
| `npm test` (todo) | 361 OK |
| `test:sql` | 186 OK |
| `test:mails` (mails y catálogos de Xubio) | 16 OK |
| `test:gas` (cheques y flujo corridos en Node con una planilla simulada) | 21 OK |
| Prueba de punta a punta en la demo | Preparar mails → abrir en Gmail → queda "Mail preparado" |
