/**
 * ============================================================================
 * CARTERO · Gmail → Vértice Tesorería (sistema nuevo)
 * ============================================================================
 * Qué hace: busca los mails con la etiqueta de proveedores y manda cada adjunto
 * (PDF o imagen) al sistema nuevo. NO lee la factura, NO escribe en la hoja y
 * NO marca los mails como leídos: la lectura con IA, la validación y la bandeja
 * de aprobación están en el sistema nuevo. Por eso puede convivir con
 * procesarFacturasDesdeGmail mientras se comparan los dos.
 *
 * Cuando todos los adjuntos de un hilo llegaron bien, el hilo recibe la etiqueta
 * CARTERO_ETIQUETA_ENVIADO y no se vuelve a mandar. Si algo falla, se reintenta
 * en la próxima pasada; el sistema nuevo ignora lo que ya recibió.
 *
 * CÓMO APLICARLO (en la COPIA):
 *  1) Archivo nuevo "CarteroGmail", pegar esto.
 *  2) Script Properties:
 *       SISTEMA_URL       = https://<sitio>.netlify.app
 *       INGESTA_TOKEN     = el mismo valor que la variable INGESTA_TOKEN en Netlify
 *       CARTERO_ETIQUETA  = PROVEEDORES_PRUEBA   (en producción: PROVEEDORES)
 *  3) Ejecutar probarCartero(): muestra qué mandaría, sin mandar nada.
 *  4) Ejecutar enviarAdjuntosAlSistema() una vez y mirar la bandeja de Aprobación.
 *  5) Ejecutar crearTriggerCartero() para que corra solo cada 5 minutos.
 * ============================================================================
 */

var CARTERO_MIME_ = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
var CARTERO_MAX_BYTES_ = 4 * 1024 * 1024;      // el sistema nuevo acepta hasta 4 MB por archivo
var CARTERO_TIEMPO_MAX_MS_ = 4.5 * 60 * 1000;  // Apps Script corta a los 6 minutos

function configCartero_() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: (p.getProperty("SISTEMA_URL") || "").replace(/\/$/, ""),
    token: p.getProperty("INGESTA_TOKEN") || "",
    etiqueta: p.getProperty("CARTERO_ETIQUETA") || "PROVEEDORES_PRUEBA",
    enviado: p.getProperty("CARTERO_ETIQUETA_ENVIADO") || "Enviado_Sistema_Nuevo",
    error: p.getProperty("CARTERO_ETIQUETA_ERROR") || "Error_Sistema_Nuevo"
  };
}

function etiquetaCartero_(nombre) {
  return GmailApp.getUserLabelByName(nombre) || GmailApp.createLabel(nombre);
}

/** Adjuntos reales del mensaje (sin imágenes incrustadas en el cuerpo, como logos de firmas). */
function adjuntosCartero_(mensaje) {
  var vistos = {};
  return mensaje.getAttachments({ includeInlineImages: false })
    .filter(function (a) { return CARTERO_MIME_.indexOf(a.getContentType()) >= 0; })
    .map(function (a) {
      // Dos adjuntos con el mismo nombre en un mismo mail: se distinguen para que no se pisen.
      var nombre = a.getName() || "adjunto";
      vistos[nombre] = (vistos[nombre] || 0) + 1;
      if (vistos[nombre] > 1) nombre = vistos[nombre] + "_" + nombre;
      return { adjunto: a, nombre: nombre };
    });
}

function enviarAdjunto_(cfg, mensaje, adjunto, nombre) {
  var resp = UrlFetchApp.fetch(cfg.url + "/api/ingesta/adjunto", {
    method: "post",
    contentType: "application/json",
    headers: { "x-ingesta-token": cfg.token },
    payload: JSON.stringify({
      origen: "GMAIL",
      gmailMessageId: mensaje.getId(),
      nombre: nombre,
      mimeType: adjunto.getContentType(),
      data: Utilities.base64Encode(adjunto.getBytes()),
      remitente: mensaje.getFrom(),
      asunto: mensaje.getSubject()
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Sistema respondió " + code + ": " + resp.getContentText().slice(0, 200));
  return JSON.parse(resp.getContentText());
}

/** Manda al sistema nuevo los adjuntos de los mails etiquetados que todavía no se mandaron. */
function enviarAdjuntosAlSistema() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Cartero: ya hay otra ejecución en curso."); return; }
  try {
    var cfg = configCartero_();
    if (!cfg.url || !cfg.token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en Script Properties.");
    var inicio = Date.now();
    var hilos = GmailApp.search('label:"' + cfg.etiqueta + '" has:attachment -label:"' + cfg.enviado + '"', 0, 20);
    var enviados = 0, repetidos = 0, fallas = 0, salteados = 0;

    for (var i = 0; i < hilos.length; i++) {
      if (Date.now() - inicio > CARTERO_TIEMPO_MAX_MS_) { Logger.log("Cartero: se terminó el tiempo; sigue en la próxima pasada."); break; }
      var hiloOk = true, hiloConError = false;
      var mensajes = hilos[i].getMessages();
      for (var j = 0; j < mensajes.length; j++) {
        var adjuntos = adjuntosCartero_(mensajes[j]);
        for (var k = 0; k < adjuntos.length; k++) {
          var a = adjuntos[k];
          if (a.adjunto.getSize() > CARTERO_MAX_BYTES_) {
            // Reintentar no sirve: se marca para carga manual.
            Logger.log("Cartero: " + a.nombre + " pesa más de 4 MB, se saltea.");
            salteados++; hiloConError = true;
            continue;
          }
          try {
            var r = enviarAdjunto_(cfg, mensajes[j], a.adjunto, a.nombre);
            if (r.nuevo) enviados++; else repetidos++;
          } catch (e) {
            fallas++; hiloOk = false;
            Logger.log("Cartero: falló " + a.nombre + ": " + e.message);
          }
        }
      }
      if (hiloOk) hilos[i].addLabel(etiquetaCartero_(cfg.enviado));
      if (hiloConError) hilos[i].addLabel(etiquetaCartero_(cfg.error));
    }
    Logger.log("Cartero: " + enviados + " enviados · " + repetidos + " ya estaban · " + fallas + " fallaron (se reintentan) · " + salteados + " salteados por tamaño.");
  } finally {
    lock.releaseLock();
  }
}

/** Muestra qué mandaría, sin mandar nada ni etiquetar. */
function probarCartero() {
  var cfg = configCartero_();
  Logger.log("Etiqueta: " + cfg.etiqueta + " · ya enviados: " + cfg.enviado + " · URL: " + (cfg.url || "(falta SISTEMA_URL)") + " · token: " + (cfg.token ? "cargado" : "(falta INGESTA_TOKEN)"));
  var hilos = GmailApp.search('label:"' + cfg.etiqueta + '" has:attachment -label:"' + cfg.enviado + '"', 0, 20);
  Logger.log("Hilos pendientes: " + hilos.length);
  hilos.forEach(function (h) {
    h.getMessages().forEach(function (m) {
      adjuntosCartero_(m).forEach(function (a) {
        Logger.log("  " + m.getDate().toISOString().slice(0, 10) + " · " + m.getFrom() + " · " + a.nombre + " (" + Math.round(a.adjunto.getSize() / 1024) + " KB)");
      });
    });
  });
}

/** Activador cada 5 minutos (borra el anterior si existía). */
function crearTriggerCartero() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "enviarAdjuntosAlSistema") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("enviarAdjuntosAlSistema").timeBased().everyMinutes(5).create();
  Logger.log("Cartero: activador creado, corre cada 5 minutos.");
}
