/**
 * ============================================================================
 * PUENTE · Apps Script → Vértice Tesorería (sistema nuevo)
 * ============================================================================
 * Qué hace: manda las filas de la hoja "Facturas" a la base nueva. Sirve para
 * MIGRAR EL HISTÓRICO (reenviarFacturasAlSistema). Las facturas nuevas entran
 * por CarteroGmail.gs, que manda el adjunto y deja que el sistema nuevo lo lea.
 *
 * CÓMO APLICARLO (en una COPIA primero):
 *  1) Archivo nuevo en el editor de Apps Script llamado "EnviarAlSistema", pegar esto.
 *  2) Script Properties: SISTEMA_URL = https://<sitio>.netlify.app
 *                        INGESTA_TOKEN = (el mismo valor que la variable INGESTA_TOKEN en Netlify)
 *  3) Ejecutar reenviarFacturasAlSistema() desde el editor. Es idempotente.
 *
 * NO enganchar enviarFacturaAlSistema_ en guardarEnSheets (versión del 13/10):
 * recibe los datos de la IA antes de validar y las facturas con error llegarían
 * como válidas. Si ya se agregó esa línea, quitarla y usar CarteroGmail.gs.
 * ============================================================================
 */

var RECEPTOR_A_EMPRESA_ = {
  "beratung s.a.": "beratung",
  "india adv s.a.": "india",
  "control b": "controlb",
  "ysd": "ysd",
  "vertice bi s.a.": "vertice",
  "robles, hector daniel": "hrobles",
  "drogueria robles": "robles",
  "farma control s.a.": "farmacontrol"
};

function empresaIdDesdeReceptor_(receptor) {
  var k = String(receptor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return RECEPTOR_A_EMPRESA_[k] || null;
}

function estadoDesdeHoja_(f) {
  var apr = String(f.ESTADO_APROBACION || "").toUpperCase();
  var pago = String(f.ESTADO_PAGO || "").toUpperCase();
  var val = String(f.ESTADO_VALIDACION || "").toUpperCase();
  if (val.indexOf("ERROR") >= 0) return "ERROR";
  var pct = f.PORCENTAJE_PAGADO === "" || f.PORCENTAJE_PAGADO == null ? 100 : porcentaje_(f.PORCENTAJE_PAGADO);
  if (pago.indexOf("PAGAD") >= 0 && pct >= 99.99) return "PAGADA";
  if (pago.indexOf("PARCIAL") >= 0) return "PAGADA_PARCIAL";
  if (apr.indexOf("APROB") >= 0) return "PARA_PAGAR";
  return "PENDIENTE_APROBACION";
}

function estadoXubioDesdeHoja_(f) {
  var x = String(f.ESTADO_XUBIO || "").toUpperCase();
  if (x.indexOf("SUBID") >= 0 || x.indexOf("OK") >= 0) return "SUBIDA";
  if (x.indexOf("ERROR") >= 0) return "ERROR";
  if (x.indexOf("SIN_ERP") >= 0) return "PENDIENTE_RALPHARMA";
  return "PENDIENTE";
}

/** GMAIL / DRIVE / MANUAL. Si la hoja no tiene una columna ORIGEN reconocible, se asume GMAIL como antes. */
function origenDesdeHoja_(f) {
  var o = String(f.ORIGEN || "").toUpperCase();
  if (o.indexOf("DRIVE") >= 0) return "DRIVE";
  if (o.indexOf("MANUAL") >= 0) return "MANUAL";
  return "GMAIL";
}

function fechaIso_(v) {
  if (!v) return "";
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  return "";
}

/**
 * Importe a número. getValues() y la IA devuelven números (1234.56): esos pasan tal cual.
 * Solo el texto con formato argentino ("$ 1.234,56") se limpia. Antes se borraban los puntos
 * también de los números y 1234.56 se convertía en 123456.
 */
function numero_(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  var s = String(v || "").replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,56
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");  // 1.234.567
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Porcentaje pagado de la hoja (100, "100%", "50,5%" o 1 si la celda tiene formato de porcentaje). */
function porcentaje_(v) {
  if (v === "" || v === null || v === undefined) return 0;
  if (typeof v === "number") return v <= 1 ? v * 100 : v;
  var s = String(v);
  var n = numero_(s);
  return s.indexOf("%") < 0 && n <= 1 ? n * 100 : n;
}

/** Arma el JSON que espera ingresar_factura a partir de una fila como objeto (encabezado → valor). */
function facturaParaSistema_(f, filaSheet) {
  var num = parsearNumeroComprobante_(f.NUMERO || "");
  var percepciones = 0;
  try { JSON.parse(f.PERCEPCIONES_JSON || "[]").forEach(function (p) { percepciones += parseFloat(p.importe) || 0; }); } catch (e) {}
  var total = numero_(f.TOTAL);
  var estado = estadoDesdeHoja_(f);
  // Lo ya pagado en pesos, para el histórico. Si la hoja dice PAGADA sin porcentaje, es el total.
  var pagado = estado === "PAGADA" ? total : estado === "PAGADA_PARCIAL" ? Math.round(total * porcentaje_(f.PORCENTAJE_PAGADO)) / 100 : 0;
  var metodo = String(f.METODO_PAGO || "").toUpperCase();
  var metodoOk = ["TRANSFERENCIA", "CHEQUE", "ECHEQ", "DEBITO", "TARJETA", "CAJA"].filter(function (m) { return metodo.indexOf(m) >= 0; })[0] || "";
  return {
    empresa_id: empresaIdDesdeReceptor_(f.RECEPTOR),
    proveedor: f.PROVEEDOR,
    cuit_proveedor: String(f.CUIT_PROVEEDOR || "").replace(/\D/g, ""),
    tipo: f.TIPO || "Factura A",
    letra: f.LETRA || "",
    punto_venta: parseInt(num.puntoVenta, 10) || 0,
    numero: parseInt(num.numeroDocumento, 10) || 0,
    fecha: fechaIso_(f.FECHA),
    vencimiento: fechaIso_(f.VENCIMIENTODELPAGO),
    moneda: f.MONEDA || "ARS",
    cotizacion: numero_(f.COTIZACION) || 1,
    neto: numero_(f.IMPORTE),
    iva: numero_(f.IVA),
    exento: numero_(f.NETO_NO_GRAVADO_EXENTO),
    percepciones: percepciones,
    percepciones_json: (function () { try { return JSON.parse(f.PERCEPCIONES_JSON || "[]"); } catch (e) { return []; } })(),
    total: total,
    pagado: pagado,
    cae: f.CAE || "",
    cae_vencimiento: fechaIso_(f.CAE_VENCIMIENTO),
    origen: origenDesdeHoja_(f),
    drive_url: f.DRIVE_URL || "",
    estado: estado,
    estado_xubio: estadoXubioDesdeHoja_(f),
    xubio_id: f.ID_FACTURA || "",
    validacion_ok: String(f.ESTADO_VALIDACION || "").toUpperCase().indexOf("ERROR") < 0,
    motivo_validacion: f.MOTIVO_VALIDACION || "",
    categoria_vertice: f.CATEGORIA_VERTICE || "",
    cuenta_contable: f.CATEGORIA_CONTABLE || "",
    codigo_producto: f.CODIGO_PRODUCTO || "",
    metodo_pago: metodoOk,
    sheets_fila_origen: filaSheet || null
  };
}

function postAlSistema_(ruta, body) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("SISTEMA_URL");
  var token = props.getProperty("INGESTA_TOKEN");
  if (!url || !token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en Script Properties");
  var resp = UrlFetchApp.fetch(url.replace(/\/$/, "") + ruta, {
    method: "post",
    contentType: "application/json",
    headers: { "x-ingesta-token": token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Sistema respondió " + code + ": " + resp.getContentText().slice(0, 200));
  return JSON.parse(resp.getContentText());
}

/** Llamar desde guardarEnSheets() con el objeto `data` que devuelve la IA. */
function enviarFacturaAlSistema_(data, fileName, driveUrl, filaSheet) {
  var f = {};
  Object.keys(data || {}).forEach(function (k) { f[k] = data[k]; });
  f.DRIVE_URL = driveUrl || f.DRIVE_URL;
  var body = facturaParaSistema_(f, filaSheet);
  if (!body.empresa_id) throw new Error("Receptor sin empresa conocida: " + f.RECEPTOR);
  var r = postAlSistema_("/api/ingesta/factura", body);
  Logger.log("Puente: factura enviada al sistema, id " + r.id);
  return r.id;
}

/** Reenvía todas las filas de la hoja Facturas. Idempotente: la base actualiza por clave natural. */
function reenviarFacturasAlSistema() {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var ok = 0, fallas = 0;
  for (var i = 1; i < data.length; i++) {
    var f = {};
    headers.forEach(function (h, j) { f[h] = data[i][j]; });
    try {
      var body = facturaParaSistema_(f, i + 1);
      if (!body.empresa_id || !body.cuit_proveedor) { fallas++; continue; }
      postAlSistema_("/api/ingesta/factura", body);
      ok++;
    } catch (e) {
      fallas++;
      Logger.log("Fila " + (i + 1) + ": " + e.message);
    }
  }
  Logger.log("Reenvío terminado: " + ok + " ok, " + fallas + " con falla");
}
