# Prueba con el equipo · 14/10/2026

Preparación para probar con Vivi y Guido las dos versiones: la **copia del Apps Script** (lo que ya usan, mejorado) y la **app nueva** (demo o conectada). Escrito el 13/10/2026.

## Qué se prueba con cada una

| Versión | Para qué | Quién la toca | Tiempo |
|---|---|---|---|
| **A · Copia del Apps Script** | Probar el trabajo real: Vivi carga un pago con comprobante, Guido lo ve. Es lo que van a usar las próximas semanas. | El equipo, cada uno desde su compu | La mayor parte |
| **B · App nueva** | Mostrar hacia dónde vamos: bandejas por rol, auditoría, flujo. Juntar opiniones sobre las pantallas. | Vos la mostrás; si está conectada, también la tocan ellos | 10 a 20 min |

Regla: **nada de lo que se haga mañana escribe en Xubio real ni manda mails a proveedores.**

---

## A · Copia del Apps Script

El código vive en Google, no en esta carpeta. Esta lista es lo que hay que **verificar a mano esta noche** en el editor de Apps Script de la copia.

### Verificación previa (15 minutos)

- [ ] **Es la copia.** El ID de la hoja que usa el script (constante o Script Property) no es el de la hoja de producción.
- [ ] **Activadores de la copia** (Editor → Activadores). Si la copia tiene el activador de Gmail cada 10 minutos o el de subida a Xubio cada 15, **puede procesar los mismos mails que producción y subir facturas duplicadas a Xubio**. Para mañana: desactivarlos y disparar a mano solo lo que se quiera mostrar.
- [ ] **Pagos a Xubio en SIMULADO.** La función de envío de pagos sigue en modo prueba (no hace POST real).
- [ ] **Mails al proveedor** van a la casilla de pruebas, no al proveedor.
- [ ] **Acceso.** La hoja de la copia está compartida con Vivi y Guido, y la web app de la copia está implementada con acceso para ellos. Abrir el link desde una cuenta de cada uno (o pedirles que lo abran hoy).
- [ ] **Clave de Gemini** de la copia con cuota disponible (probar una lectura de comprobante hoy).
- [ ] Una o dos **facturas reales aprobadas** en la copia para que Vivi tenga qué pagar.

### Recorrido

1. **Vivi** abre la carga ágil, elige una factura y sube un comprobante real de un pago de esta semana. La IA completa banco, importe y fecha. Vivi corrige si hace falta y confirma.
2. **Guido** ve el pago en su lado: cuenta sugerida, forma de carga, comentario de Vivi. Revisa el armado de Xubio (simulado).
3. Un **pago sin factura** (comisión o impuesto) para ver la sugerencia de cuenta.
4. Un **cheque o e-cheq**, si hay, para ver la pestaña Cheques.

### Qué preguntar mientras lo usan

Son las preguntas abiertas de [08-flujo-de-trabajo-y-preguntas.md](08-flujo-de-trabajo-y-preguntas.md):

- **Vivi:** ¿qué comprobante subís, PDF o captura? Con cheque, ¿dónde anotás número y vencimiento? El mail al proveedor, ¿lo mandás vos? ¿Qué es lo que más tiempo te lleva?
- **Guido:** ¿te sirve que los pagos sin factura se registren como asiento manual? ¿Una OP reciente con dos o más facturas tildadas, para leerla?

Anotar: minutos por pago, qué corrigieron a mano de lo que leyó la IA, qué les molestó.

---

## B · App nueva

### B1 · Demo (lista, sin cuentas)

```bash
cd demo
npm run dev -- --host
```

- En tu notebook: http://localhost:5173. Para otros en la misma red: la dirección `Network:` que muestra Vite.
- La red `AccesoU 2` de la oficina pasa por un firewall Fortinet que **bloquea el "Forward a Port" de VS Code**. Si el celular o las compus del equipo no llegan a la dirección `Network:`, usar el hotspot del celular o publicar `demo/dist` en https://app.netlify.com/drop.
- **Los datos de la demo son de cada navegador:** lo que carga Vivi en su compu no lo ve Guido en la suya. Para el circuito completo, mostrarlo desde una sola pantalla cambiando "Entrar como".
- Guion: [03-guion-demo.md](03-guion-demo.md). Tocar "Reiniciar demo" antes de empezar.

### B2 · Conectada (datos reales, Xubio en seco)

Necesita cuentas que hoy no existen. Si esta noche no se llega con los pasos 1 a 5, mañana se muestra la demo (B1) y no pasa nada.

| # | Qué | Tiempo | Detalle |
|---|---|---|---|
| 1 | Proyecto Supabase `vertice-dev` | 30 min | [07 · Paso 1](07-puesta-en-produccion.md). **Antes de correr `0004_semilla.sql`:** poner los mails reales de Vivi, Guido y quien aprueba (si un mail no está, Google no deja entrar). |
| 2 | Login con Google | 20 min | [07 · Paso 2](07-puesta-en-produccion.md). Pantalla de consentimiento "Interno". Gemini puede esperar: sin clave, la lectura del comprobante da error y Vivi completa a mano. |
| 3 | Publicar en Netlify | 20 min | No hay repositorio git, así que por terminal: `npm i -g netlify-cli`, `cd demo`, `netlify login`, `netlify init`, cargar las variables de `.env.example` en el panel de Netlify, `netlify deploy --build --prod`. `XUBIO_ENVIO_REAL=false` y **sin** `XUBIO_CREDS_JSON`. |
| 4 | Cuentas de origen y plan de cuentas | 30 min | En el Table Editor de Supabase, tabla `cuentas_origen`: al menos las cuentas bancarias de Beratung e India con el **nombre exacto de Xubio**. Sin esto la pantalla de Pagos no deja elegir cuenta de origen. |
| 5 | Facturas reales | 20 min | En la **copia** del Apps Script: pegar `gas/EnviarAlSistema.gs` (versión del 13/10, que ya no multiplica importes por 100), cargar `SISTEMA_URL` e `INGESTA_TOKEN` y correr `reenviarFacturasAlSistema()`. |

**Verificación:** entrar con el mail de Vivi; en Pagos se ven las facturas aprobadas con los mismos importes que en la hoja. Cargar un pago de prueba y contabilizarlo como Guido: tiene que decir "Prueba en seco OK" y quedar como Revisado.

**Qué se puede probar mañana en conectado:** login de cada uno con su Google, Vivi carga pagos reales y Guido los ve en su bandeja desde otra compu (los datos son compartidos), aprobación con motivo de rechazo, auditoría con nombres reales. **Qué no:** envío real a Xubio, mails a proveedores, saldos bancarios.

---

## Lo que se corrigió el 13/10 para poder usar datos reales

Salió de la auditoría del mismo día. Todo probado contra Postgres con el script de `demo/supabase/pruebas/`.

- El puente del Apps Script ya no multiplica por 100 los importes con decimales.
- Reenviar facturas desde la hoja ya no deshace lo que se aprobó o pagó en la app nueva.
- Lo pagado de cada factura se guarda en pesos, no en porcentaje (se pueden registrar restos de centavos).
- La vista para el Cash Flow y la auditoría ya no se pueden leer ni escribir sin usuario habilitado.
- La app trae todas las filas (antes cortaba en 1.000 sin avisar).
- "Contabilizar en Xubio" no puede mandar dos veces el mismo pago, no inventa ids y exige el nombre exacto de la cuenta.
- Pagos: cheque con número y vencimiento obligatorios, cuenta de origen con el nombre exacto de Xubio, no deja pagar más de lo vinculado, archivos de hasta 4 MB.
- Pantallas: cada rol ve solo los botones que puede usar; el rechazo pide motivo; el comprobante y el PDF de Drive se abren con un clic; las fechas ya no saltan al día siguiente después de las 21 h.

## Plan B

| Falla | Respuesta |
|---|---|
| La copia del Apps Script no abre para alguien | Que use la tuya en pantalla compartida; anotar el problema de permisos |
| La IA de la copia no responde (cuota) | Completar a mano; anotar cuánto tardó |
| La app conectada no está lista | Demo (B1) desde tu notebook |
| El equipo no llega a tu notebook por la red | Hotspot del celular o Netlify Drop |
