# Lo que se trajo del Apps Script · tanda 1 · 18/11/2026

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

## Próximas tandas

- **2:** mails a proveedores.
- **3:** cheques a CHEQUES EMITIDOS y flujo de caja. Falta decidir si se escribe en el Cash Flow o si el Cash Flow lee del sistema.
- **4:** plan de cuentas y bancos desde Xubio · carpetas de Drive · resumen de vencimientos.
