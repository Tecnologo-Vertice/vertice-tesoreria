/**
 * ============================================================================
 * PUENTE DE HOJAS · hoja real → sistema nuevo (Vértice Tesorería)
 * ============================================================================
 * Copia cada 10 minutos lo que el Apps Script de producción carga en la hoja real
 * "Facturas automatizadas": Facturas, Facturas_Aprobadas, Pagos y, una vez por
 * hora, los catálogos. El sistema nuevo traduce las filas (lib/espejo.ts).
 *
 * SEGURIDAD: este script SOLO LEE la hoja real (openById + getValues). No escribe,
 * no borra, no mueve filas, no lee Gmail ni Drive y no habla con Xubio.
 * Además, el manifiesto (PuenteHojas.appsscript.json → appsscript.json del proyecto)
 * pide a Google solo el permiso "spreadsheets.readonly": aunque el código tuviera
 * un error, Google no lo dejaría escribir en ninguna hoja.
 *
 * DÓNDE VA: en un proyecto de Apps Script NUEVO y aparte (script.google.com →
 * Nuevo proyecto → "Puente sistema nuevo"), con la cuenta tecnologia@. NUNCA en el
 * proyecto de producción ni en el de Santi.
 *
 * CONFIGURAR (Configuración del proyecto → Propiedades del script):
 *   SISTEMA_URL    = https://<sitio>.netlify.app
 *   INGESTA_TOKEN  = el mismo valor que la variable INGESTA_TOKEN en Netlify
 *   HOJA_REAL_ID   = (opcional) por defecto la hoja real de facturas
 *
 * USO: probarPuente() (no manda nada, muestra qué mandaría) → espejarHojaReal()
 * → crearActivadorPuente() (cada 10 minutos). Para frenarlo: borrarActivadorPuente().
 * ============================================================================
 */

var HOJA_REAL_POR_DEFECTO = "1inX5mK2FLQpb48JLy5oxa6X58_1AuF7vHKdzdLPM9Io"; // Facturas automatizadas (REAL)
var LOTE_PUENTE = 200;
var CATALOGOS_CADA_MIN = 60;
var PESTANAS_CATALOGO = {
  cuentas: "Catalogo_Cuentas_Contables",
  origen: "Xubio_Cuentas_Origen",
  porEmpresa: "Catalogo_Proveedores_Por_Empresa",
  emails: "Catalogo_Emails_Proveedores",
  productos: "Catalogo_Productos"
};

function propsPuente_() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: String(p.getProperty("SISTEMA_URL") || "").replace(/\/$/, ""),
    token: p.getProperty("INGESTA_TOKEN") || "",
    hoja: p.getProperty("HOJA_REAL_ID") || HOJA_REAL_POR_DEFECTO,
    props: p
  };
}

/** Celda → valor que viaja en JSON. Fechas como texto (aaaa-mm-dd o aaaa-mm-dd HH:mm, hora de la hoja). */
function valorPuente_(v, zona) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    var conHora = v.getHours() !== 0 || v.getMinutes() !== 0;
    return Utilities.formatDate(v, zona, conHora ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd");
  }
  return v;
}

/** Filas de una pestaña como objetos { encabezado: valor, _fila }. Salta filas vacías y columnas sin encabezado. */
function filasComoObjetos_(ss, nombre) {
  var sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 2) return [];
  var datos = sh.getDataRange().getValues(); // SOLO LECTURA
  var zona = ss.getSpreadsheetTimeZone();
  var h = datos[0].map(function (x) { return String(x).trim(); });
  var salida = [];
  for (var i = 1; i < datos.length; i++) {
    var fila = datos[i];
    if (!fila.some(function (c) { return c !== "" && c !== null; })) continue;
    var o = { _fila: i + 1 };
    for (var j = 0; j < h.length; j++) {
      if (!h[j] || o.hasOwnProperty(h[j])) continue; // encabezado vacío o repetido: se toma el primero
      o[h[j]] = valorPuente_(fila[j], zona);
    }
    salida.push(o);
  }
  return salida;
}

function postPuente_(cfg, cuerpo, primerLote) {
  var headers = { "x-ingesta-token": cfg.token };
  if (primerLote) headers["x-espejo-lote"] = "1";
  var resp = UrlFetchApp.fetch(cfg.url + "/api/espejo", {
    method: "post", contentType: "application/json", headers: headers,
    payload: JSON.stringify(cuerpo), muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("El sistema respondió " + code + ": " + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

function enviarPestanaEnLotes_(cfg, tipo, hoja, filas) {
  var tot = { nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: 0 };
  for (var i = 0; i < filas.length; i += LOTE_PUENTE) {
    var r = postPuente_(cfg, { tipo: tipo, hoja: hoja, filas: filas.slice(i, i + LOTE_PUENTE) }, i === 0);
    tot.nuevas += r.nuevas; tot.actualizadas += r.actualizadas; tot.sin_cambios += r.sin_cambios; tot.omitidas += (r.omitidas || []).length;
  }
  return hoja + ": " + filas.length + " filas · " + tot.nuevas + " nuevas · " + tot.actualizadas + " actualizadas · " +
    tot.sin_cambios + " sin cambios · " + tot.omitidas + " omitidas";
}

/** Lo que corre el activador. Facturas antes que Pagos: los pagos se vinculan con facturas ya copiadas. */
function espejarHojaReal() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return "Ya hay una copia en curso.";
  try {
    var cfg = propsPuente_();
    if (!cfg.url || !cfg.token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en las propiedades del script.");
    var ss = SpreadsheetApp.openById(cfg.hoja);
    var log = [];

    var ultimaCat = Number(cfg.props.getProperty("PUENTE_ULTIMOS_CATALOGOS") || 0);
    if (Date.now() - ultimaCat > CATALOGOS_CADA_MIN * 60000) {
      var cat = {};
      Object.keys(PESTANAS_CATALOGO).forEach(function (k) { cat[k] = filasComoObjetos_(ss, PESTANAS_CATALOGO[k]); });
      var rc = postPuente_(cfg, { tipo: "catalogos", catalogos: cat }, true);
      cfg.props.setProperty("PUENTE_ULTIMOS_CATALOGOS", String(Date.now()));
      log.push("Catálogos: " + JSON.stringify({ cuentas: rc.cuentas, origen: rc.origen, porEmpresa: rc.porEmpresa, emails: rc.emails, productos: rc.productos }));
    }

    log.push(enviarPestanaEnLotes_(cfg, "facturas", "Facturas", filasComoObjetos_(ss, "Facturas")));
    log.push(enviarPestanaEnLotes_(cfg, "facturas", "Facturas_Aprobadas", filasComoObjetos_(ss, "Facturas_Aprobadas")));
    log.push(enviarPestanaEnLotes_(cfg, "pagos", "Pagos", filasComoObjetos_(ss, "Pagos")));
    Logger.log(log.join("\n"));
    return log.join("\n");
  } finally {
    lock.releaseLock();
  }
}

/** Fuerza la copia de catálogos en la próxima corrida (por ejemplo, después de cargarPlanCuentasDesdeXubio). */
function espejarCatalogosAhora() {
  propsPuente_().props.deleteProperty("PUENTE_ULTIMOS_CATALOGOS");
  return espejarHojaReal();
}

/** No manda nada: muestra cuántas filas copiaría y cómo viaja una fila de cada pestaña. */
function probarPuente() {
  var cfg = propsPuente_();
  var ss = SpreadsheetApp.openById(cfg.hoja);
  var log = ["Hoja: " + ss.getName() + " (" + cfg.hoja + ")",
    "SISTEMA_URL: " + (cfg.url || "FALTA"), "INGESTA_TOKEN: " + (cfg.token ? "cargado" : "FALTA")];
  ["Facturas", "Facturas_Aprobadas", "Pagos"].concat(Object.keys(PESTANAS_CATALOGO).map(function (k) { return PESTANAS_CATALOGO[k]; }))
    .forEach(function (n) {
      var f = filasComoObjetos_(ss, n);
      log.push(n + ": " + f.length + " filas" + (f.length ? " · ejemplo: " + JSON.stringify(f[f.length - 1]).slice(0, 400) : ""));
    });
  Logger.log(log.join("\n"));
  return log.join("\n");
}

function crearActivadorPuente() {
  borrarActivadorPuente();
  ScriptApp.newTrigger("espejarHojaReal").timeBased().everyMinutes(10).create();
  Logger.log("✅ Activador creado: espejarHojaReal cada 10 minutos.");
}

function borrarActivadorPuente() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "espejarHojaReal") ScriptApp.deleteTrigger(t);
  });
}
