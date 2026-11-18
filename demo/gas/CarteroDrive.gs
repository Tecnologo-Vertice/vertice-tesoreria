/**
 * ============================================================================
 * CARTERO DE DRIVE · facturas de las carpetas de Beratung → sistema nuevo
 * ----------------------------------------------------------------------------
 * Hace lo mismo que procesarFacturasDesdeDrive de "facturas automatizadas", pero no lee
 * con IA: manda cada archivo al sistema (POST /api/ingesta/adjunto, origen DRIVE) y el
 * sistema lo lee, valida y deja en Aprobación, igual que los adjuntos de Gmail.
 *  - Carpetas (dentro de BERATUNG): FACTURAS PROFESIONALES INTERNACION DOMICILIARIA y
 *    FACTURAS PRESTADORES MEDICOS (todo, recursivo) y GASTOS MENSUALES 2026 (recursivo,
 *    salvo FACTURA(S) COLABORADORES).
 *  - No repite: antes de bajar un archivo le pregunta al sistema si ya lo tiene (por id).
 *  - Corta a los 4,5 minutos y sigue en la próxima corrida.
 *
 * Script Properties:
 *   SISTEMA_URL               = https://<sitio>.netlify.app
 *   INGESTA_TOKEN             = el mismo de Netlify
 *   CARPETA_BERATUNG_DRIVE_ID = id de la carpeta BERATUNG (la misma que usa producción)
 *
 * Uso: probarCarteroDrive() (no manda nada) → enviarArchivosDeDrive() → crearTriggerCarteroDrive().
 * Mientras producción siga leyendo Drive (procesarFacturasDesdeDrive), dejar este apagado
 * o usar otra carpeta: los dos leerían los mismos archivos.
 * ============================================================================
 */

var DRIVE_CARPETAS_TODO_ = ["FACTURAS PROFESIONALES INTERNACION DOMICILIARIA", "FACTURAS PRESTADORES MEDICOS "];
var DRIVE_CARPETA_GASTOS_ = "GASTOS MENSUALES 2026";
var DRIVE_EXCLUIDAS_ = ["FACTURA COLABORADORES", "FACTURAS COLABORADORES"];
var DRIVE_MIME_ = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
var DRIVE_TIEMPO_MAXIMO_MS_ = 4.5 * 60 * 1000;

function configCarteroDrive_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    url: String(p.getProperty("SISTEMA_URL") || "").replace(/\/$/, ""),
    token: p.getProperty("INGESTA_TOKEN") || "",
    carpeta: String(p.getProperty("CARPETA_BERATUNG_DRIVE_ID") || "").trim()
  };
  if (!cfg.url || !cfg.token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en Script Properties.");
  if (!cfg.carpeta) throw new Error("Falta CARPETA_BERATUNG_DRIVE_ID en Script Properties.");
  return cfg;
}

function llamarSistemaDrive_(cfg, ruta, cuerpo) {
  var resp = UrlFetchApp.fetch(cfg.url + ruta, {
    method: "post", contentType: "application/json", payload: JSON.stringify(cuerpo),
    headers: { "x-ingesta-token": cfg.token }, muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Sistema " + ruta + " respondió " + code + ": " + resp.getContentText().slice(0, 200));
  return JSON.parse(resp.getContentText());
}

/** Junta los archivos candidatos (sin bajarlos): [{ archivo, carpeta }]. */
function archivosCandidatosDrive_(raiz) {
  var lista = [];
  var recorrer = function (carpeta, origen, excluidas) {
    var archivos = carpeta.getFiles();
    while (archivos.hasNext()) {
      var a = archivos.next();
      if (DRIVE_MIME_.indexOf(a.getMimeType()) !== -1) lista.push({ archivo: a, carpeta: origen });
    }
    var subs = carpeta.getFolders();
    while (subs.hasNext()) {
      var s = subs.next();
      if (excluidas.indexOf(s.getName().trim().toUpperCase()) !== -1) continue;
      recorrer(s, origen, excluidas);
    }
  };
  var sub = function (nombre) { var it = raiz.getFoldersByName(nombre); return it.hasNext() ? it.next() : null; };
  DRIVE_CARPETAS_TODO_.forEach(function (n) { var c = sub(n); if (c) recorrer(c, n.trim(), []); else Logger.log("No se encontró la carpeta: " + n); });
  var gastos = sub(DRIVE_CARPETA_GASTOS_);
  if (gastos) recorrer(gastos, DRIVE_CARPETA_GASTOS_, DRIVE_EXCLUIDAS_); else Logger.log("No se encontró la carpeta: " + DRIVE_CARPETA_GASTOS_);
  return lista;
}

/** Archivos que el sistema todavía no tiene. */
function archivosNuevosDrive_(cfg, lista) {
  var nuevos = [];
  for (var i = 0; i < lista.length; i += 400) {
    var tramo = lista.slice(i, i + 400);
    var conocidos = llamarSistemaDrive_(cfg, "/api/ingesta/conocidos", { ids: tramo.map(function (x) { return x.archivo.getId(); }) }).conocidos || [];
    tramo.forEach(function (x) { if (conocidos.indexOf(x.archivo.getId()) === -1) nuevos.push(x); });
  }
  return nuevos;
}

function enviarArchivosDeDrive() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return "Ya hay otra ejecución del cartero de Drive.";
  try {
    var inicio = Date.now();
    var cfg = configCarteroDrive_();
    var nuevos = archivosNuevosDrive_(cfg, archivosCandidatosDrive_(DriveApp.getFolderById(cfg.carpeta)));
    var enviados = 0, fallidos = 0, cortado = false;
    for (var i = 0; i < nuevos.length; i++) {
      if (Date.now() - inicio > DRIVE_TIEMPO_MAXIMO_MS_) { cortado = true; break; }
      var a = nuevos[i].archivo;
      try {
        llamarSistemaDrive_(cfg, "/api/ingesta/adjunto", {
          origen: "DRIVE", gmailMessageId: a.getId(), nombre: a.getName(), mimeType: a.getMimeType(),
          data: Utilities.base64Encode(a.getBlob().getBytes()), remitente: "Drive", asunto: nuevos[i].carpeta
        });
        enviados++;
      } catch (e) {
        fallidos++;
        Logger.log("No se pudo mandar " + a.getName() + ": " + e.message);
      }
      Utilities.sleep(1000);
    }
    var msg = "Drive → sistema: " + enviados + " enviados · " + fallidos + " con error · " + (nuevos.length - enviados - fallidos) + " para la próxima" + (cortado ? " (tiempo agotado)" : "");
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** No manda nada: muestra cuántos archivos hay y cuántos son nuevos para el sistema. */
function probarCarteroDrive() {
  var cfg = configCarteroDrive_();
  var lista = archivosCandidatosDrive_(DriveApp.getFolderById(cfg.carpeta));
  var nuevos = archivosNuevosDrive_(cfg, lista);
  var msg = "Archivos en las carpetas: " + lista.length + " · nuevos para el sistema: " + nuevos.length;
  nuevos.slice(0, 20).forEach(function (x) { msg += "\n  " + x.carpeta + " / " + x.archivo.getName(); });
  Logger.log(msg);
  return msg;
}

/** Cada 4 horas, como producción. Correrlo una vez, con OK. */
function crearTriggerCarteroDrive() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "enviarArchivosDeDrive") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("enviarArchivosDeDrive").timeBased().everyHours(4).create();
  return "Activador del cartero de Drive instalado (cada 4 horas).";
}
