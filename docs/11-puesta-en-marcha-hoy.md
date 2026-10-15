# Puesta en marcha · 15/10/2026

💻 = ya está hecho en el código. 👨🏽‍💻 = lo configurás vos (cuentas, claves, mails: nadie más puede).

## Qué hace el sistema hoy

| Parte | Estado | Detalle |
|---|---|---|
| 💻 Entrada de facturas por mail | Listo | El Apps Script solo hace de cartero (`demo/gas/CarteroGmail.gs`): manda cada adjunto de los mails con la etiqueta al sistema. La IA lee, valida y deja la factura en Aprobación. Ver [10](10-flujo-1-entrada-de-facturas.md). |
| 💻 Carga manual de facturas | Listo | Botón **Subir factura** en Aprobación. |
| 💻 IA integrada | Listo | Gemini lee facturas (manual de carga de producción) y comprobantes de pago, con modelo de respaldo si el principal está saturado. Una sola clave de la empresa. |
| 💻 Aprobación con memoria | Listo | Al aprobar, la cuenta y el método quedan recordados para el próximo comprobante de ese proveedor. |
| 💻 Facturas → Xubio | Listo, en seco hasta que lo actives | Al aprobar se sube sola: busca el proveedor por CUIT, el producto por la cuenta, controla duplicados y guarda el id de Xubio. Si falla, el motivo queda en la factura y se reintenta desde Pagos o cada 10 minutos. |
| 💻 Pagos → Xubio | Listo, en seco hasta que lo actives | Orden de pago, salida de fondos (como asiento) o asiento manual. Bloqueo contra doble envío. |
| 💻 Pago imputado a su factura | Programado, falta 1 prueba | Ver "Xubio al 100 %" abajo. |
| 💻 Sector Ralpharma | Listo | Pantalla **Ralpharma** con contador en el menú: facturas aprobadas y pagos de Droguería Robles, Héctor Robles y Farma Control para cargar a mano. Guido confirma cada uno con su nombre. |
| 💻 Repositorio git | Listo en la notebook | Sin claves ni datos reales (`apps_script_copia/` y `Claude outputs/` excluidas). Falta subirlo (paso 1). |
| 💻 Pruebas | 112 pasan | `npm test`: lectura de facturas (28), armado para Xubio (20), base de datos (64). |

## Xubio al 100 %: lo que permite la API

La especificación oficial de Xubio (`https://xubio.com/API/1.1/swagger.json`) confirma que **la orden de pago no tiene ningún campo para tildar facturas**. Hay dos formas de cerrar ese hueco:

1. **Pago dentro de la factura** (`XUBIO_PAGO_EN_FACTURA=true`): el sistema agrega el pago a la factura en Xubio y queda imputada, sin que Guido toque nada. Está programado, pero **nunca se probó contra Xubio real**: antes hay que hacer la prueba de $1 en Vértice BI con Guido mirando (`demo/gas/PruebaPagoEnFactura.gs`, docs/08).
2. **Mientras tanto** (`false`, por defecto): se crea la OP a cuenta y el sistema le dice a Guido exactamente qué factura tildar y por cuánto. Es un minuto por OP.

## 👨🏽‍💻 Pasos para encenderlo (unos 70 minutos)

### 1 · GitHub privado (5 min)
1. En GitHub (cuenta u organización de la empresa) → **New repository** → nombre `vertice-tesoreria` → **Private** → sin README → Create.
2. Pasame la URL, o corré en PowerShell desde `proyecto_futuro`:
   ```powershell
   git remote add origin https://github.com/<organizacion>/vertice-tesoreria.git
   git push -u origin main
   ```
   La primera vez se abre el navegador para iniciar sesión en GitHub.

### 2 · Supabase (15 min)
1. supabase.com → New project `vertice-dev`, región São Paulo. Guardá la contraseña de la base.
2. **SQL Editor** → pegar entero `demo/supabase/instalar_todo.sql` → Run.
3. Abrir `demo/supabase/configurar_equipo.sql`, completar los mails de Vivi y Guido, los 8 CUIT y las cuentas de origen con el nombre exacto de Xubio → Run. Si da "duplicate key" en `cuit`, quedó algún CUIT sin completar.
4. **Project Settings → API**: copiar `Project URL`, `anon key` y `service_role key`. La `service_role` va solo a Netlify, nunca al navegador ni a un chat.

### 3 · Login con Google (15 min)
1. Google Cloud, **en el proyecto de la empresa** → APIs y servicios → **Pantalla de consentimiento OAuth** → tipo **Interno**.
2. **Credenciales → Crear ID de cliente OAuth → Aplicación web.** URI de redirección: la "Callback URL" que muestra Supabase en Authentication → Providers → Google.
3. Supabase → Authentication → Providers → **Google**: habilitar y pegar Client ID y Secret.
4. Supabase → Authentication → URL Configuration: **Site URL** = la URL de Netlify (paso 5). Agregar también `http://localhost:5173` en Redirect URLs.

### 4 · Claves (10 min)
- **Gemini:** AI Studio → Create API key **en el proyecto de Google Cloud de la empresa**, con facturación activa. Poné un presupuesto con alerta (por ejemplo USD 10).
- **Rotar las claves expuestas:** las 3 claves de Gemini escritas en `Code.gs` de la copia, y los secretos de Xubio de Beratung, Control B, India e YSD. En Xubio: Configuración → API → regenerar, con Santi o Guido.
- **Token del cartero:** generalo en PowerShell y guardalo para los pasos 5 y 6:
  ```powershell
  -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
  ```

### 5 · Netlify (15 min)
1. app.netlify.com → **Add new site → Import an existing project → GitHub** → `vertice-tesoreria`.
2. **Base directory:** `demo`. El resto lo toma de `netlify.toml`.
3. **Environment variables:**

| Variable | Valor |
|---|---|
| `VITE_SUPABASE_URL` | Project URL de Supabase |
| `VITE_SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_URL` | Project URL de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `GEMINI_API_KEY` | la clave nueva |
| `INGESTA_TOKEN` | el token del paso 4 |
| `XUBIO_CREDS_JSON` | `{"beratung":{"clientId":"…","secret":"…"},"india":{…},"controlb":{…},"ysd":{…},"vertice":{…}}` con las credenciales nuevas |
| `XUBIO_FACTURAS_ENVIO_REAL` | `false` hoy (producción sigue subiendo las facturas) |
| `XUBIO_ENVIO_REAL` | `false` |
| `XUBIO_PAGO_EN_FACTURA` | `false` |

4. **Deploy.** Copiar la URL (`https://….netlify.app`) a Supabase (paso 3.4).

### 6 · Mails entrantes con la copia (10 min)
En el editor de la copia del Apps Script:
1. Archivo nuevo `CarteroGmail` → pegar `demo/gas/CarteroGmail.gs`.
2. Script Properties: `SISTEMA_URL` = URL de Netlify, `INGESTA_TOKEN` = el mismo del paso 4, `CARTERO_ETIQUETA` = `PROVEEDORES_PRUEBA`.
3. Ejecutar `probarCartero()` (muestra qué mandaría) → `enviarAdjuntosAlSistema()` → `crearTriggerCartero()`.
4. Si en `guardarEnSheets` se había agregado la línea `enviarFacturaAlSistema_`, quitarla.

### 7 · Prueba de punta a punta (10 min)
1. Entrar a la URL de Netlify con tecnologia@: tiene que pedir Google y entrar como Tecnología.
2. Mandar a tecnologia@ un mail con una factura en PDF y etiquetarlo `PROVEEDORES_PRUEBA`.
3. Esperar 5 minutos (o correr `enviarAdjuntosAlSistema()`) → Aprobación → **Entrada** → **Leer ahora** → la factura aparece en **Pendientes**.
4. Aprobarla: tiene que decir "Xubio en modo prueba: Xubio la aceptaría…" (con credenciales) o "sin credenciales".
5. Vivi carga el pago en **Pagos**; Guido lo contabiliza en **Contabilización** ("Prueba en seco OK").

## Si hoy no llegamos con las cuentas

La demo con datos ficticios se publica en 2 minutos y tiene todas las pantallas, incluidas Entrada, Subir factura (simulado), Xubio (simulado) y Ralpharma:
1. 💻 `demo/dist` ya está compilado con todo lo de hoy.
2. 👨🏽‍💻 Arrastrar la carpeta `demo/dist` en https://app.netlify.com/drop (con la cuenta de la empresa) y compartir el link.

Recordá que en la demo cada persona ve sus propios datos (se guardan en su navegador).

## Para pasar a producción (después del piloto)

1. 👨🏽‍💻 Cartero en el Apps Script **de producción**, con `CARTERO_ETIQUETA = PROVEEDORES`, en la cuenta dueña de esa casilla. Convive con el procesamiento actual.
2. 👨🏽‍💻 Cuando el equipo trabaje solo en el sistema nuevo: apagar en producción los activadores `procesarFacturasDesdeGmail` y `subirFacturasPendientesAXubio`, y en Netlify poner `XUBIO_FACTURAS_ENVIO_REAL=true`. Antes de eso, dejarlo en `false` evita que la misma factura se suba dos veces (igual, los dos sistemas controlan duplicados en Xubio).
3. 👨🏽‍💻 Prueba de $1 con Guido → `XUBIO_PAGO_EN_FACTURA=true` → `XUBIO_ENVIO_REAL=true`, empresa por empresa.
4. 👨🏽‍💻 Supabase plan Pro (copias de seguridad diarias) antes de cargar datos reales en serio.

## Lo que falta (sin cabos sueltos)

| Qué | Por qué no está hoy | Próximo paso |
|---|---|---|
| Probar contra Gemini, Supabase y Xubio reales | No había cuentas | Pasos 2 a 7 de esta guía |
| Pago imputado a la factura en Xubio | La API no tiene ese campo en la OP; el camino alternativo nunca se probó | Prueba de $1 con Guido |
| Mail al proveedor con factura y comprobante | No entró en el día | La base ya marca `MAIL_PENDIENTE` por cada factura cancelada |
| Resumen diario de vencimientos por mail | No entró en el día | Sigue saliendo desde el Apps Script |
| Sugerencia de cuenta con IA para pagos sin factura | Hoy usa reglas y la memoria del proveedor | Pasar `sugerirConIA_` de `SugerenciaCuenta.gs` |
| Corregir a mano una factura en Excepciones | No entró en el día | Editar importes, CUIT y empresa desde la tarjeta |
| Entrada desde carpetas de Drive | El sistema ya la acepta (`origen: DRIVE`) | Falta el cartero de Drive |
| Migrar el histórico de la hoja | Necesita la base real | `reenviarFacturasAlSistema()` (`gas/EnviarAlSistema.gs`) |
| Conciliación bancaria y extractos | Fase 5 | Guido hoy concilia con Claude |
