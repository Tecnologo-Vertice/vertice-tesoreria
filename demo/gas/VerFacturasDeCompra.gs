/**
 * ============================================================================
 * SOLO LECTURA · Cómo guarda Xubio las facturas pagadas
 * ============================================================================
 * No escribe nada. Responde dos preguntas:
 *  1) Las facturas de El Jumillano que Guido canceló con la OP X-0001-00000483,
 *     ¿muestran algo del pago (transaccionOrdenPagoItems u otro campo)?
 *  2) ¿Hay alguna factura cargada "Al Contado" (condicionDePago = 2)? Si la hay,
 *     muestra cómo guarda Xubio el pago dentro de la factura.
 *
 * CÓMO USARLO (en la COPIA):
 *  1) Archivo nuevo "VerFacturasDeCompra", pegar esto, guardar.
 *  2) Ejecutar verFacturasDeCompra.
 *  3) Copiar todo el "Registro de ejecución" y pasárselo a Claude.
 * ============================================================================
 */

const VFC_EMPRESA = "INDIA ADV S.A.";
const VFC_DESDE = "2026-07-20";
const VFC_HASTA = "2026-10-13";
const VFC_PROVEEDOR = "JUMILLANO";
const VFC_NUMEROS = ["02121138", "02099926"]; // dos de las facturas que canceló la OP 483

function verFacturasDeCompra() {
  const token = getXubioToken_(VFC_EMPRESA);
  const headers = { Authorization: token.token_type + " " + token.access_token, Accept: "application/json" };
  const get = (path) => {
    const r = UrlFetchApp.fetch(XUBIO_API_URI + path, { headers: headers, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { Logger.log("GET " + path + " → " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200)); return null; }
    return JSON.parse(r.getContentText());
  };

  let lista = get("comprobanteCompraBean?fechaDesde=" + VFC_DESDE + "&fechaHasta=" + VFC_HASTA) || [];
  if (!Array.isArray(lista)) lista = [lista];
  Logger.log("Facturas de compra en el período: " + lista.length);

  // Resumen: cuántas hay por condición de pago y cuántas traen ítems de pago adentro.
  const resumen = {};
  lista.forEach(f => {
    const k = "condicionDePago=" + f.condicionDePago + " · con pago adentro=" + ((f.transaccionOrdenPagoItems || []).length > 0);
    resumen[k] = (resumen[k] || 0) + 1;
  });
  Logger.log("Resumen: " + JSON.stringify(resumen));

  const detalle = (f) => {
    const id = f.transaccionid || f.transaccionId || f.ID || f.id;
    return (id && get("comprobanteCompraBean/" + id)) || f;
  };
  // Solo lo que importa para esta pregunta; sin ítems de producto ni percepciones.
  const recorte = (f) => ({
    transaccionid: f.transaccionid, numeroDocumento: f.numeroDocumento, fecha: f.fecha, fechaVto: f.fechaVto,
    proveedor: (f.proveedor || {}).nombre, importetotal: f.importetotal, condicionDePago: f.condicionDePago,
    cuentaBancaria: f.cuentaBancaria, transaccionOrdenPagoItems: f.transaccionOrdenPagoItems,
    otrosCamposConPagoOSaldo: Object.keys(f).filter(k => /pago|saldo|cancel|imput|aplic|pendien/i.test(k)).reduce((o, k) => { o[k] = f[k]; return o; }, {})
  });

  // 1) Las facturas de El Jumillano canceladas por la OP 483.
  const jumillano = lista.filter(f => String((f.proveedor || {}).nombre || "").toUpperCase().indexOf(VFC_PROVEEDOR) >= 0);
  Logger.log("Facturas de " + VFC_PROVEEDOR + ": " + jumillano.length);
  jumillano.filter(f => VFC_NUMEROS.some(n => String(f.numeroDocumento || "").indexOf(n) >= 0)).forEach(f => {
    Logger.log("========== FACTURA PAGADA POR LA OP 483 ==========");
    Logger.log(JSON.stringify(recorte(detalle(f)), null, 1));
  });

  // 2) Un ejemplo de factura "Al Contado", si existe.
  const contado = lista.filter(f => Number(f.condicionDePago) === 2);
  Logger.log("Facturas Al Contado en el período: " + contado.length);
  contado.slice(0, 2).forEach(f => {
    Logger.log("========== FACTURA AL CONTADO ==========");
    Logger.log(JSON.stringify(recorte(detalle(f)), null, 1));
  });
}
