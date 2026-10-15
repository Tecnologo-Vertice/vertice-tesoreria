/**
 * ============================================================================
 * PRUEBA · ¿Xubio acepta una factura de compra con el pago adentro?
 * ============================================================================
 * Solo para el Xubio de VÉRTICE BI S.A. y con importe de $1. Hacerla con Guido.
 *
 * Con PRUEBA_ENVIAR = false (default) NO escribe nada: solo muestra en el
 * registro lo que mandaría. Recién con true escribe en Xubio.
 *
 * ORDEN:
 *  0) pruebaListarDatos        → solo lectura. Muestra proveedores, cuentas y productos
 *                                de Vértice para completar las constantes de abajo.
 *  1) pruebaPaso2_alContado     → factura de $1 cargada YA PAGADA (condición "Al Contado").
 *  2) pruebaPaso3_pagarDespues  → factura de $1 en cuenta corriente y después se le
 *                                agrega el pago (el caso real: Vivi paga después).
 *  3) pruebaBorrar             → borra una factura de prueba por su id.
 *
 * Después de cada paso, Guido mira en Xubio (ver lista en docs/08) y se borra.
 * Usa getXubioToken_ y XUBIO_API_URI de Code.gs.
 * ============================================================================
 */

const PRUEBA_ENVIAR = false;                    // ← true solo con Guido al lado
const PRUEBA_EMPRESA = "VERTICE BI S.A.";
const PRUEBA_PROVEEDOR = "";                    // nombre exacto de un proveedor de Vértice en Xubio (ver paso 0)
const PRUEBA_CUENTA_PAGO = "";                  // nombre exacto de la cuenta bancaria o caja de Vértice (ver paso 0)
const PRUEBA_PRODUCTO_CODIGO = "";              // código de un producto de compra de Vértice (ver paso 0)
const PRUEBA_PRODUCTO_NOMBRE = "";
const PRUEBA_ID_A_BORRAR = 0;                   // transaccionid que devolvió el paso 1 o 2

function pruebaCliente_() {
  if (PRUEBA_EMPRESA !== "VERTICE BI S.A.") throw new Error("Esta prueba solo corre en Vértice BI.");
  const token = getXubioToken_(PRUEBA_EMPRESA);
  const headers = { Authorization: token.token_type + " " + token.access_token, Accept: "application/json" };
  const llamar = (metodo, path, body) => {
    const opt = { method: metodo, headers: headers, muteHttpExceptions: true };
    if (body) { opt.contentType = "application/json"; opt.payload = JSON.stringify(body); }
    const r = UrlFetchApp.fetch(XUBIO_API_URI + path, opt);
    let json = null; try { json = JSON.parse(r.getContentText()); } catch (e) {}
    return { code: r.getResponseCode(), json: json, texto: r.getContentText() };
  };
  return { llamar: llamar };
}

function pruebaListarDatos() {
  const x = pruebaCliente_();
  const prov = x.llamar("get", "ProveedorBean");
  Logger.log("PROVEEDORES (primeros 20): " + JSON.stringify((prov.json || []).slice(0, 20).map(p => p.nombre)));
  const ctas = x.llamar("get", "cuenta?activo=1");
  const bancos = (ctas.json || []).filter(c => /banco|caja|cheque|galicia|santander|macro|bbva|naci|mercado/i.test(c.nombre || ""));
  Logger.log("CUENTAS DE PAGO: " + JSON.stringify(bancos.map(c => ({ id: c.ID || c.id, nombre: c.nombre }))));
  const prods = x.llamar("get", "ProductoCompraBean");
  Logger.log("PRODUCTOS DE COMPRA (primeros 20): " + JSON.stringify((prods.json || []).slice(0, 20).map(p => ({ codigo: p.codigo, nombre: p.nombre }))));
}

function pruebaRefs_(x) {
  if (!PRUEBA_PROVEEDOR || !PRUEBA_CUENTA_PAGO || !PRUEBA_PRODUCTO_CODIGO) throw new Error("Completá PRUEBA_PROVEEDOR, PRUEBA_CUENTA_PAGO y PRUEBA_PRODUCTO_CODIGO (corré pruebaListarDatos).");
  const p = (x.llamar("get", "ProveedorBean").json || []).find(v => String(v.nombre).trim() === PRUEBA_PROVEEDOR);
  if (!p) throw new Error("No encontré el proveedor " + PRUEBA_PROVEEDOR);
  const c = (x.llamar("get", "cuenta?activo=1").json || []).find(v => String(v.nombre).trim() === PRUEBA_CUENTA_PAGO);
  if (!c) throw new Error("No encontré la cuenta " + PRUEBA_CUENTA_PAGO);
  const ref = (o) => ({ ID: o.ID || o.id, id: o.ID || o.id, nombre: o.nombre, codigo: o.codigo || "" });
  return { proveedor: ref(p), cuenta: ref(c), tipoCuenta: /caja/i.test(c.nombre) ? 1 : /cheque/i.test(c.nombre) ? 4 : 2 };
}

/** Factura C de $1 (sin IVA, para no mezclar impuestos en la prueba). Mismo formato que construirFacturaCompra_. */
function pruebaFactura_(refs, condicion) {
  const hoy = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd");
  const numero = "C-00099-" + String(Date.now()).slice(-8);
  return {
    circuitoContable: { ID: -2, nombre: "default", codigo: "DEFAULT", id: -2 },
    comprobante: 0, transaccionid: 0, externalId: "PRUEBA-VERTICE", tipo: 1, nombre: "",
    fecha: hoy, fechaVto: hoy, fechaFiscal: hoy, fechaComprobante: hoy,
    puntoVenta: "00099", numeroDocumento: numero,
    condicionDePago: condicion,
    cuentaBancaria: { ID: 0, nombre: "", codigo: "", id: 0 },
    deposito: { ID: 0, nombre: "", codigo: "", id: 0 },
    cotizacion: 1, importeMonPrincipal: 1, importetotal: 1, importeImpuestos: 0, importeGravado: 1,
    provincia: { provincia_id: 0, codigo: "", nombre: "", pais: "" },
    proveedor: refs.proveedor,
    descripcion: "PRUEBA DE SISTEMA VÉRTICE · BORRAR",
    cbuinformada: true,
    transaccionProductoItems: [{
      transaccionCVItemId: 0, precioconivaincluido: 0, transaccionId: 0,
      producto: { ID: 0, id: 0, nombre: PRUEBA_PRODUCTO_NOMBRE, codigo: PRUEBA_PRODUCTO_CODIGO },
      descripcion: "Prueba", cantidad: 1, precio: 1, iva: 0, importe: 1, total: 1, montoExento: 0, porcentajeDescuento: 0
    }],
    transaccionPercepcionItems: [],
    transaccionOrdenPagoItems: []
  };
}

/** El pago dentro de la factura. Los nombres salen de la especificación oficial (TransaccionOrdenPagoItems). */
function pruebaItemPago_(refs) {
  return {
    transaccionid: 0, itemId: 0,
    cuentaTipo: String(refs.tipoCuenta),   // la especificación lo declara texto; valor a confirmar con la prueba
    cuentaId: refs.cuenta.ID,
    moneda: { ID: -2, nombre: "Pesos Argentinos", codigo: "PESOS_ARGENTINOS", id: -2 },
    cotizacionMonTransaccion: 1, importeMonPrincipal: 1, importeMonTransaccion: 1,
    descripcion: "Pago de prueba Vértice"
  };
}

function pruebaEnviar_(x, metodo, path, body, etiqueta) {
  Logger.log("---- " + etiqueta + " · " + metodo.toUpperCase() + " " + path + " ----");
  Logger.log(JSON.stringify(body, null, 1));
  if (!PRUEBA_ENVIAR) { Logger.log("(PRUEBA_ENVIAR = false: no se envió nada)"); return null; }
  const r = x.llamar(metodo, path, body);
  Logger.log("Respuesta " + r.code + ": " + r.texto.slice(0, 1500));
  return r;
}

function pruebaPaso2_alContado() {
  const x = pruebaCliente_();
  const refs = pruebaRefs_(x);
  const f = pruebaFactura_(refs, 2);
  f.transaccionOrdenPagoItems = [pruebaItemPago_(refs)];
  const r = pruebaEnviar_(x, "post", "comprobanteCompraBean", f, "PASO 2 · factura al contado con el pago adentro");
  if (r && r.json) Logger.log(">>> transaccionid para Guido y para borrar: " + (r.json.transaccionid || r.json.transaccionId));
}

function pruebaPaso3_pagarDespues() {
  const x = pruebaCliente_();
  const refs = pruebaRefs_(x);
  const f = pruebaFactura_(refs, 1);
  const r1 = pruebaEnviar_(x, "post", "comprobanteCompraBean", f, "PASO 3a · factura en cuenta corriente");
  if (!PRUEBA_ENVIAR) {
    const g = JSON.parse(JSON.stringify(f));
    g.condicionDePago = 2; g.transaccionOrdenPagoItems = [pruebaItemPago_(refs)];
    pruebaEnviar_(x, "put", "comprobanteCompraBean/<id>", g, "PASO 3b · misma factura con el pago agregado");
    return;
  }
  const id = r1 && r1.json && (r1.json.transaccionid || r1.json.transaccionId);
  if (!id) { Logger.log("No se creó la factura; se corta."); return; }
  Logger.log(">>> transaccionid: " + id + " · Guido puede mirarla ahora en cuenta corriente.");
  const actual = x.llamar("get", "comprobanteCompraBean/" + id).json || f;
  actual.condicionDePago = 2;
  actual.transaccionOrdenPagoItems = [pruebaItemPago_(refs)];
  pruebaEnviar_(x, "put", "comprobanteCompraBean/" + id, actual, "PASO 3b · misma factura con el pago agregado");
  Logger.log(">>> Ahora Guido la mira de nuevo. Para borrarla: PRUEBA_ID_A_BORRAR = " + id);
}

function pruebaBorrar() {
  if (!PRUEBA_ID_A_BORRAR) throw new Error("Completá PRUEBA_ID_A_BORRAR.");
  const x = pruebaCliente_();
  const f = x.llamar("get", "comprobanteCompraBean/" + PRUEBA_ID_A_BORRAR).json || {};
  if (String(f.externalId || "") !== "PRUEBA-VERTICE" && String(f.descripcion || "").indexOf("PRUEBA DE SISTEMA") < 0) {
    throw new Error("Esa factura no es de prueba. No se borra.");
  }
  if (!PRUEBA_ENVIAR) { Logger.log("(PRUEBA_ENVIAR = false) Se borraría la factura " + PRUEBA_ID_A_BORRAR + " · " + f.numeroDocumento); return; }
  const r = x.llamar("delete", "comprobanteCompraBean/" + PRUEBA_ID_A_BORRAR);
  Logger.log("Borrado " + r.code + ": " + r.texto.slice(0, 300));
}
