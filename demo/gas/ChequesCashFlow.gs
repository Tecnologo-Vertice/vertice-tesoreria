/**
 * ============================================================================
 * CHEQUES → CASH FLOW (pestaña "CHEQUES EMITIDOS") · puente del sistema nuevo
 * ----------------------------------------------------------------------------
 * Misma lógica que CashFlowCheques.gs de "facturas automatizadas", pero los pagos
 * salen del sistema nuevo (POST /api/cheques/pendientes) en lugar de la pestaña Pagos.
 *  - Inserta cada cheque en su lugar según la fecha de DEPÓSITO y copia las fórmulas
 *    de la fila vecina (COBRO, Categoría, SEMANA, ID CHEQUES, controles).
 *  - No duplica: misma empresa + banco + número → "YA ESTABA EN EL CASH FLOW".
 *  - Un mismo cheque cargado para varias facturas (mismo lote, ±1 h) entra en UNA fila con el total.
 *  - Relee la fila escrita; si no quedó bien, la marca es "ERROR: …" y no "AGREGADO".
 *  - Devuelve el resultado de cada pago al sistema (POST /api/cheques/resultado).
 *
 * Solo pasa pagos del sistema nuevo. Los pagos que vienen de la hoja los sigue pasando
 * el Apps Script de producción, así que los dos pueden convivir sin duplicar.
 *
 * Script Properties:
 *   SISTEMA_URL               = https://<sitio>.netlify.app
 *   INGESTA_TOKEN             = el mismo de Netlify
 *   CASHFLOW_CHEQUES_SHEET_ID = id del Cash Flow (o de una copia para probar)
 *   CASHFLOW_CHEQUES_TAB      = CHEQUES EMITIDOS (opcional)
 *   CASHFLOW_PERMITIR_REAL    = true solo con OK: sin esto escribe únicamente en una hoja
 *                               cuyo nombre diga "copy" / "copia".
 * En Netlify: CASHFLOW_CHEQUES_DESDE = aaaa-mm-dd (lo anterior ya está cargado a mano).
 *
 * Uso: revisarChequesCashFlow() (no escribe) → pasarChequesAlCashFlow() → crearTriggerCheques().
 * ============================================================================
 */

var CF_COLUMNAS_TABLA = 19; // A..S: datos + fórmulas de control de la tabla
var CF_PREFIJO_PRODUCCION = "1WBZxy"; // ID del cash flow real

// Nombre de cada empresa tal como figura en el cash flow (por id del sistema)
var CF_EMPRESAS = {
  hrobles: "HECTOR ROBLES",
  robles: "DROG.ROBLES S.A.",
  beratung: "BERATUNG",
  india: "INDIA ADV",
  controlb: "CONTROL B",
  ysd: "YSD PHARMA",
  farmacontrol: "FARMA CONTROL ",
  vertice: "VERTICE BI"
};

function cfNorm_(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

function cfBanco_(banco) {
  var b = cfNorm_(banco);
  var tabla = [["galicia", "GALICIA"], ["icbc", "ICBC"], ["brubank", "BRUBANK"], ["hipotecario", "HIPOTECARIO"],
    ["chubut", "CHUBUT"], ["bbva", "BBVA"], ["frances", "BBVA"], ["macro", "MACRO"], ["santander", "SANTANDER"],
    ["credicoop", "CREDICOOP"], ["mercadopago", "MP"], ["interbanking", "INTERBANKING"]];
  for (var i = 0; i < tabla.length; i++) if (b.indexOf(tabla[i][0]) !== -1) return tabla[i][1];
  if (b === "mp") return "MP";
  return String(banco || "").trim().toUpperCase();
}

function cfClave_(empresa, banco, numero) {
  return [cfNorm_(empresa), cfNorm_(banco), cfNorm_(numero).replace(/^0+/, "")].join("|");
}

/** Fecha desde Date, dd/mm/aa, dd/mm/aaaa o aaaa-mm-dd (al mediodía). null si no se entiende. */
function cfFecha_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return new Date(v.getFullYear(), v.getMonth(), v.getDate(), 12);
  var s = String(v || "").trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    var anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(anio, +m[2] - 1, +m[1], 12);
  }
  return null;
}

function cfConfigPuente_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    url: String(p.getProperty("SISTEMA_URL") || "").replace(/\/$/, ""),
    token: p.getProperty("INGESTA_TOKEN") || "",
    id: String(p.getProperty("CASHFLOW_CHEQUES_SHEET_ID") || "").trim(),
    tab: p.getProperty("CASHFLOW_CHEQUES_TAB") || "CHEQUES EMITIDOS",
    real: String(p.getProperty("CASHFLOW_PERMITIR_REAL") || "").toLowerCase() === "true"
  };
  if (!cfg.url || !cfg.token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en Script Properties.");
  if (!cfg.id) throw new Error("Falta CASHFLOW_CHEQUES_SHEET_ID en Script Properties.");
  if (!cfg.real && cfg.id.indexOf(CF_PREFIJO_PRODUCCION) === 0) {
    throw new Error("Para escribir en el cash flow real hay que poner CASHFLOW_PERMITIR_REAL = true.");
  }
  cfg.ss = SpreadsheetApp.openById(cfg.id);
  if (!cfg.real && !/cop(y|ia)/i.test(cfg.ss.getName())) {
    throw new Error("Mientras CASHFLOW_PERMITIR_REAL no sea true solo se escribe en una copia del cash flow (el nombre tiene que decir copy/copia).");
  }
  cfg.sh = cfg.ss.getSheetByName(cfg.tab);
  if (!cfg.sh) throw new Error("No encontré la pestaña '" + cfg.tab + "' en el cash flow.");
  return cfg;
}

function cfLlamar_(cfg, ruta, cuerpo) {
  var resp = UrlFetchApp.fetch(cfg.url + ruta, {
    method: "post", contentType: "application/json", payload: JSON.stringify(cuerpo || {}),
    headers: { "x-ingesta-token": cfg.token }, muteHttpExceptions: true
  });
  var j = {};
  try { j = JSON.parse(resp.getContentText()); } catch (e) {}
  if (resp.getResponseCode() !== 200) throw new Error("Sistema " + ruta + " → " + resp.getResponseCode() + ": " + (j.error || resp.getContentText().slice(0, 200)));
  return j;
}

// Columnas de la tabla por nombre de encabezado (sin tildes ni mayúsculas)
function cfColumnas_(sh) {
  var h = sh.getRange(1, 1, 1, CF_COLUMNAS_TABLA).getValues()[0].map(function (x) { return cfNorm_(x); });
  var c = function (n) { return h.indexOf(n); };
  var col = { emision: c("emision"), deposito: c("deposito"), empresa: c("empresa"), banco: c("banco"), numero: c("numero"),
    tipo: c("tipo"), acreedor: c("acreedores"), importe: c("importe"), estado: c("estado"), obs: c("observaciones") };
  var faltan = Object.keys(col).filter(function (k) { return col[k] === -1; });
  if (faltan.length) throw new Error("La tabla de cheques del cash flow no tiene las columnas: " + faltan.join(", "));
  return col;
}

// ---------------------------------------------------------------- Acreedores (igual que producción)

var CF_PALABRAS_GENERICAS = ["sa", "srl", "sas", "sau", "sh", "saic", "sacif", "sacifia", "sacifi", "cia", "compania", "de", "del", "la", "las", "los", "el", "y",
  "seguros", "laboratorio", "laboratorios", "lab", "drogueria", "droguerias", "group", "argentina", "arg", "hnos", "inc", "ltda"];

function nucleoAcreedor_(t) {
  var partes = String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  var unidas = [];
  partes.forEach(function (w) {
    var ult = unidas.length ? unidas[unidas.length - 1] : null;
    if (w.length === 1 && ult && ult.suelta) ult.txt += w;
    else unidas.push({ txt: w, suelta: w.length === 1 });
  });
  return unidas.map(function (u) { return u.txt; }).filter(function (w) { return w.length > 1 && CF_PALABRAS_GENERICAS.indexOf(w) === -1; });
}

function distanciaHasta1_(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  var i = 0, j = 0, dif = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++dif > 1) return 2;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return dif + (a.length - i) + (b.length - j);
}

function mejorPorNucleo_(beneficiario, candidatos) {
  var b = nucleoAcreedor_(beneficiario);
  if (!b.length) return null;
  var bJunto = b.join("");
  var iguales = candidatos.filter(function (x) {
    return x.nuc && x.nuc.length && ((x.nuc.join("") === bJunto && bJunto.length >= 3) || (bJunto.length >= 8 && distanciaHasta1_(x.nuc.join(""), bJunto) <= 1));
  });
  if (iguales.length) return iguales[0];
  var mejor = null, mejorExtra = 99, empate = false;
  candidatos.forEach(function (x) {
    if (!x.nuc || !x.nuc.length) return;
    var corto = b.length <= x.nuc.length ? b : x.nuc;
    var largo = corto === b ? x.nuc : b;
    if (corto.join("").length < 5) return;
    if (!corto.every(function (w) { return largo.indexOf(w) !== -1; })) return;
    var extra = largo.length - corto.length;
    if (extra < mejorExtra) { mejor = x; mejorExtra = extra; empate = false; }
    else if (extra === mejorExtra && mejor && mejor.nuc.join("") !== x.nuc.join("")) empate = true;
  });
  return empate ? null : mejor;
}

// 1) nombre de la pestaña Categoría 2) igual "de fondo" 3) uno contiene al otro 4) uno que ya usó Tesorería
function cfAcreedores_(ss, filasCF, col) {
  var categorias = [];
  try {
    var shCat = ss.getSheetByName("Categoría");
    if (shCat) categorias = shCat.getRange("C3:C" + Math.max(3, shCat.getLastRow())).getValues().map(function (r) { return String(r[0] || "").trim(); }).filter(Boolean);
  } catch (e) {}
  var usados = {};
  filasCF.forEach(function (f) { var a = String(f[col.acreedor] || "").trim(); if (a) usados[cfNorm_(a)] = a; });
  var catNorm = categorias.map(function (cat) { return { cat: cat, n: cfNorm_(cat), nuc: nucleoAcreedor_(cat) }; });
  var usadosNorm = Object.keys(usados).map(function (k) { return { cat: usados[k], n: k, nuc: nucleoAcreedor_(usados[k]) }; });
  return function (beneficiario) {
    var n = cfNorm_(beneficiario);
    if (!n) return { nombre: "", seguro: false };
    var exacta = catNorm.filter(function (x) { return x.n === n; })[0];
    if (exacta) return { nombre: exacta.cat, seguro: true };
    var m1 = mejorPorNucleo_(beneficiario, catNorm);
    if (m1) return { nombre: m1.cat, seguro: true };
    var mejor = null;
    if (n.length >= 6) catNorm.forEach(function (x) {
      if (x.n.length >= 6 && (n.indexOf(x.n) !== -1 || x.n.indexOf(n) !== -1) && (!mejor || x.n.length > mejor.n.length)) mejor = x;
    });
    if (mejor) return { nombre: mejor.cat, seguro: true };
    if (usados[n]) return { nombre: usados[n], seguro: false };
    var m2 = mejorPorNucleo_(beneficiario, usadosNorm);
    if (m2) return { nombre: m2.cat, seguro: false };
    return { nombre: String(beneficiario).trim().toUpperCase(), seguro: false };
  };
}

// ---------------------------------------------------------------- Escritura

function cfTipo_(ch) {
  var tipo = String(ch.tipo_cheque || "").toUpperCase();
  if (tipo === "PAGARE") return "PAGARE";
  if (tipo === "FISICO" || ch.medio === "CHEQUE" || /f[ií]sico/i.test(ch.texto || "")) return "CH/FISICO";
  return "ECHEQ";
}

function cfAhora_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm");
}

/** Pasa al cash flow los cheques que el sistema tiene pendientes y le devuelve el resultado. */
function pasarChequesAlCashFlow() {
  var cache = CacheService.getScriptCache();
  if (cache.get("CF_CHEQUES_OCUPADO")) return "Otra ejecución está pasando cheques.";
  cache.put("CF_CHEQUES_OCUPADO", "1", 300);
  try {
    var cfg = cfConfigPuente_();
    var sh = cfg.sh;
    var col = cfColumnas_(sh);
    var pendientes = cfLlamar_(cfg, "/api/cheques/pendientes").cheques || [];
    var resultados = [];
    var procesados = {};
    var escritos = 0, yaEstaban = 0;
    pendientes.forEach(function (ch, i) {
      if (procesados[ch.pago_id]) return;
      var empresa = CF_EMPRESAS[ch.empresa_id] || String(ch.empresa_id || "").toUpperCase();
      var esPagare = String(ch.tipo_cheque || "").toUpperCase() === "PAGARE";
      var banco = esPagare ? "INTERBANKING" : cfBanco_(ch.banco);
      var nro = String(ch.numero || "").trim();
      var clave = cfClave_(empresa, banco, nro);
      // La tabla se relee en cada cheque porque cada inserción corre las filas
      var ultimaHoja = sh.getLastRow();
      var datosCF = ultimaHoja > 1 ? sh.getRange(2, 1, ultimaHoja - 1, CF_COLUMNAS_TABLA).getValues() : [];
      var ultima = 1;
      datosCF.forEach(function (f, k) { if (String(f[col.empresa] || "").trim()) ultima = k + 2; });
      var existentes = {};
      datosCF.forEach(function (f) { existentes[cfClave_(f[col.empresa], f[col.banco], f[col.numero])] = true; });
      // Mismo cheque para varias facturas (mismo lote, ±1 h): una sola fila con el total
      var emisionMs = new Date(ch.emision).getTime();
      var hermanos = [ch];
      var total = Number(ch.importe) || 0;
      pendientes.slice(i + 1).forEach(function (q) {
        if (procesados[q.pago_id]) return;
        var bq = String(q.tipo_cheque || "").toUpperCase() === "PAGARE" ? "INTERBANKING" : cfBanco_(q.banco);
        if (cfClave_(CF_EMPRESAS[q.empresa_id] || q.empresa_id, bq, q.numero) !== clave) return;
        if (Math.abs(new Date(q.emision).getTime() - emisionMs) > 3600000) return;
        hermanos.push(q);
        total += Number(q.importe) || 0;
      });
      hermanos.forEach(function (h) { procesados[h.pago_id] = true; });
      var marcar = function (estado) { hermanos.forEach(function (h) { resultados.push({ pago_id: h.pago_id, estado: estado }); }); };
      if (existentes[clave]) { marcar("YA ESTABA EN EL CASH FLOW"); yaEstaban++; return; }

      // Lugar según la fecha de depósito: antes de la primera fila con depósito posterior
      var deposito = cfFecha_(ch.deposito);
      var fila = ultima + 1;
      if (deposito) {
        for (var k = 0; k < ultima - 1; k++) {
          var dk = cfFecha_(datosCF[k][col.deposito]);
          if (dk && String(datosCF[k][col.empresa] || "").trim() && dk.getTime() > deposito.getTime()) { fila = k + 2; break; }
        }
      }
      if (fila <= ultima) sh.insertRowBefore(fila);
      else if (fila > sh.getMaxRows()) sh.insertRowAfter(ultima);
      var filaModelo = fila > 2 ? fila - 1 : fila + 1;
      var formulas = sh.getRange(filaModelo, 1, 1, CF_COLUMNAS_TABLA).getFormulasR1C1()[0];
      var valoresCols = [col.emision, col.deposito, col.empresa, col.banco, col.numero, col.tipo, col.acreedor, col.importe, col.estado, col.obs];
      formulas.forEach(function (fx, k) { if (fx && valoresCols.indexOf(k) === -1) sh.getRange(fila, k + 1).setFormulaR1C1(fx); });

      var acr = cfAcreedores_(cfg.ss, datosCF, col)(ch.proveedor);
      var emision = new Date(emisionMs);
      var datosFila = {};
      datosFila[col.emision] = new Date(emision.getFullYear(), emision.getMonth(), emision.getDate(), 12);
      if (deposito) datosFila[col.deposito] = deposito;
      datosFila[col.empresa] = empresa;
      datosFila[col.banco] = banco;
      datosFila[col.numero] = /^\d+$/.test(nro) ? Number(nro) : nro;
      datosFila[col.tipo] = cfTipo_(ch);
      datosFila[col.acreedor] = acr.nombre;
      datosFila[col.importe] = Math.round(total * 100) / 100;
      datosFila[col.estado] = "Pendiente";
      datosFila[col.obs] = "Cargado por el sistema · " + ch.pago_id + (hermanos.length > 1 ? " · un cheque para " + hermanos.length + " pagos" : "") +
        (acr.seguro ? "" : " · revisar ACREEDORES (no está en Categoría)");
      // Se escribe en bloques de columnas consecutivas (las escrituras sueltas en una fila recién insertada se perdían)
      var ks = Object.keys(datosFila).map(Number).sort(function (a, b) { return a - b; });
      var ini = 0;
      while (ini < ks.length) {
        var fin = ini;
        while (fin + 1 < ks.length && ks[fin + 1] === ks[fin] + 1) fin++;
        sh.getRange(fila, ks[ini] + 1, 1, fin - ini + 1).setValues([ks.slice(ini, fin + 1).map(function (x) { return datosFila[x]; })]);
        ini = fin + 1;
      }
      SpreadsheetApp.flush();
      var chk = sh.getRange(fila, 1, 1, CF_COLUMNAS_TABLA).getValues()[0];
      if (cfClave_(chk[col.empresa], chk[col.banco], chk[col.numero]) !== clave) {
        marcar("ERROR: no quedó bien escrito en la fila " + fila + " del cash flow, revisar");
        return;
      }
      escritos++;
      marcar("AGREGADO " + cfAhora_() + (hermanos.length > 1 ? " (total de " + hermanos.length + " pagos)" : ""));
    });
    if (resultados.length) cfLlamar_(cfg, "/api/cheques/resultado", { resultados: resultados });
    var msg = "Cash flow: " + escritos + " cheque(s) agregado(s), " + yaEstaban + " ya estaban, de " + pendientes.length + " pendientes.";
    Logger.log(msg);
    return msg;
  } finally {
    cache.remove("CF_CHEQUES_OCUPADO");
  }
}

/** No escribe nada: controla la configuración y cuántos cheques esperan. */
function revisarChequesCashFlow() {
  var cfg = cfConfigPuente_();
  var col = cfColumnas_(cfg.sh);
  var pendientes = cfLlamar_(cfg, "/api/cheques/pendientes");
  var salida = "Cash flow: " + cfg.ss.getName() + " · pestaña " + cfg.sh.getName() +
    "\nColumnas encontradas: " + Object.keys(col).join(", ") +
    "\nSe pasan los pagos cargados desde: " + pendientes.desde +
    "\nCheques esperando pasar: " + (pendientes.cheques || []).length +
    (cfg.real ? "\nCASHFLOW_PERMITIR_REAL = true: escribe en el cash flow configurado aunque sea el real." : "\nModo copia: no puede escribir en el cash flow real.");
  Logger.log(salida);
  return salida;
}

/** Activador cada 15 minutos (como reprocesarLecturasPagos en producción). Correrlo una vez, con OK. */
function crearTriggerCheques() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "pasarChequesAlCashFlow") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("pasarChequesAlCashFlow").timeBased().everyMinutes(15).create();
  return "Activador de cheques al cash flow instalado (cada 15 minutos).";
}
