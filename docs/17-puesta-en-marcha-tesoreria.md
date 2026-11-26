# Puesta en marcha de Tesorería sin planillas · 26/11/2026

Checklist para encender bancos, cheques y Flujo sobre la base (migraciones 0023 a 0029) y apagar las planillas después de dos semanas en paralelo. Sigue a [16](16-base-de-datos-sin-planillas.md).

**Marcas:** `[FIRMA SANTIAGO]` = lo decide o lo hace Santiago (claves, cuentas, prender envíos reales, cortar planillas). `[HECHO]` = ya está en el código y probado. Lo demás lo puede hacer quien opere la puesta en marcha, con Santiago al lado.

Regla de todo el documento: **todo arranca en seco**. Ningún interruptor de envío real se prende sin la firma de Santiago y sin haber visto antes la corrida en seco.

---

## 0 · Antes de empezar

- [ ] Desde `demo/` pasan las pruebas (sin red, datos ficticios):
  ```
  npm run typecheck
  npm run build
  npm run test:sql
  npm run test:tesoreria        # incluye 0029 si se agrega el script de abajo
  npm run test:extractos
  npm run test:bancos
  npm run test:migracion
  node supabase/pruebas/probar_0029.mjs supabase/migrations
  ```
- [ ] `[FIRMA SANTIAGO]` Copia de seguridad de la base de Supabase (Database → Backups) antes de aplicar migraciones.
- [ ] `[FIRMA SANTIAGO]` Fecha de inicio del período en paralelo (paso 7). Recomendado: un lunes hábil, para tener 10 días hábiles completos.

## 1 · Migraciones 0023 a 0029

En el proyecto de Supabase que ya tiene 0001 a 0022 (no usar `instalar_todo.sql`, que es para un proyecto nuevo):

- [ ] SQL Editor → pegar y correr **una por una, en orden**: `0023_cuentas_y_unidades.sql`, `0024_bancos.sql`, `0025_cheques_y_cobros.sql`, `0026_flujo.sql`, `0027_operacion.sql`, `0028_espera_fc_flujo.sql`, `0029_cabos_tesoreria.sql`. Si una falla, parar: no seguir con la próxima.
- [ ] Verificar:
  ```sql
  select count(*) from unidades;                                   -- una por empresa (Beratung: dos)
  select prosrc like '%origen_saldos%' from pg_proc where proname = 'importar_extracto';   -- true (0029)
  select * from xubio_bancos_pendientes limit 1;                   -- existe (0029)
  select has_function_privilege('authenticated', 'importar_extracto(jsonb)', 'execute');  -- false
  ```
- [ ] En un proyecto nuevo: `npm run sql:unir` y pegar `demo/supabase/instalar_todo.sql` (ya incluye 0029), después `configurar_equipo.sql`.

Qué agrega 0029 (T-205):

| Qué | Para qué |
|---|---|
| `importar_extracto` acepta `origen_saldos` (`EXTRACTO` por defecto, `TENENCIA`) y devuelve `a_revisar` | El informe de un FCI guarda la tenencia como TENENCIA; las llamadas de antes siguen igual |
| `marcar_anulacion_xubio_manual(tipo, id, nota)` (Administración / Admin) | Órdenes de pago y cheques que Xubio no deja anular por API: se anulan a mano en Xubio y se marcan, con nota y auditoría |
| Vista `xubio_bancos_pendientes` | Pantalla Bancos › Pendiente en Xubio |
| `control_bancos` avisa también pagos y cheques pendientes de anular en Xubio | Mail del control diario |

## 2 · Variables de entorno (Netlify → Site configuration → Environment variables)

Leídas de cada `.mts` y de `netlify/functions/lib/`. Las claves van solo a Netlify: nunca al repo, al navegador ni a un chat.

### Para todas las funciones

| Variable | Quién la usa | Valor |
|---|---|---|
| `SUPABASE_URL` | todas | `[FIRMA SANTIAGO]` Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | todas | `[FIRMA SANTIAGO]` clave service_role (solo servidor) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | la app (al compilar) | URL y clave anon. Sin ellas la app arranca en modo demo |

### Por función

| Función | Ruta / horario | Rol | Variables |
|---|---|---|---|
| `importar-extracto` | POST `/api/bancos/extracto` | Tesorería, Administración, Admin | solo las comunes. Guarda el archivo en el bucket `comprobantes` |
| `xubio-bancos` (corrida manual) | POST `/api/xubio/bancos` | Administración, Admin | `XUBIO_BANCOS_ENVIO_REAL`, `XUBIO_BORRAR_ASIENTO_CONFIRMADO`, `XUBIO_CREDS_JSON` o credenciales en la base, `XUBIO_TIMEOUT_MS` |
| `xubio-bancos-pendientes` | cada 15 min, 8 a 19:45 BA, L a V hábiles | — | igual que la anterior. **Sin `XUBIO_BANCOS_ENVIO_REAL=true` no corre** |
| `control-diario` | 8:00 BA, L a V hábiles | — | `CONTROL_DIARIO_ENVIO_REAL`. Además hace falta un proveedor de mail (no hay ninguno: ver paso 2.1) |
| `contabilizar` | POST `/api/contabilizar` | Administración, Admin | `XUBIO_ENVIO_REAL`, `XUBIO_PAGO_EN_FACTURA`, credenciales de Xubio, `XUBIO_TIMEOUT_MS` |
| `xubio-factura` | POST `/api/xubio/factura` | Aprobador, Administración, Admin | `XUBIO_FACTURAS_ENVIO_REAL`, credenciales de Xubio |
| `xubio-subir-pendientes` | cada 10 min | — | `XUBIO_FACTURAS_ENVIO_REAL` (sin `true` no corre) |
| `xubio-catalogos` / `xubio-catalogos-semanal` | POST `/api/xubio/catalogos` / lunes 6:17 UTC | Administración, Admin | credenciales de Xubio |
| `xubio-credenciales` | POST `/api/xubio/credenciales` | Admin | `CREDENCIALES_CLAVE` (y `CREDENCIALES_CLAVE_ANTERIOR` solo durante un cambio de clave) |
| `subir-factura`, `leer-ahora`, `leer-documentos` (cada 2 min), `ia-leer-comprobante` | varias | varios | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_MODEL_RESPALDO`, `GEMINI_TIMEOUT_MS` |
| `ingesta-adjunto`, `ingesta-factura`, `ingesta-conocidos`, `espejo`, `flujo-datos`, `cheques-cashflow` | token de integración | — | `INGESTA_TOKEN` (general) o tokens de `tokens_integracion`; `cheques-cashflow`: `CASHFLOW_CHEQUES_DESDE` |

### Interruptores (todos apagados por defecto = en seco)

| Interruptor | Qué prende | Cuándo | Firma |
|---|---|---|---|
| `XUBIO_BANCOS_ENVIO_REAL=true` | Sube comprobantes "Extracto Bancario" y asientos del banco; procesa anulaciones; prende el programado de 15 min | Paso 6, después de ver una corrida en seco limpia | `[FIRMA SANTIAGO]` |
| `XUBIO_BORRAR_ASIENTO_CONFIRMADO=true` | Borrar asientos en Xubio por API (`DELETE asientoContableManualBean/{id}`) | Recién después de probarlo con un asiento de $1 en Xubio real | `[FIRMA SANTIAGO]` |
| `CONTROL_DIARIO_ENVIO_REAL=true` | Mail del control diario | Cuando haya proveedor de mail | `[FIRMA SANTIAGO]` |
| `XUBIO_FACTURAS_ENVIO_REAL=true` | Facturas de proveedores a Xubio | Ya documentado en [11](11-puesta-en-marcha-hoy.md) | `[FIRMA SANTIAGO]` |
| `XUBIO_ENVIO_REAL=true`, `XUBIO_PAGO_EN_FACTURA=true` | Pagos a Xubio / pago dentro de la factura | Ya documentado en [11](11-puesta-en-marcha-hoy.md) y [08](08-flujo-de-trabajo-y-preguntas.md) | `[FIRMA SANTIAGO]` |

Credenciales de Xubio: por empresa en la base (cifradas con `CREDENCIALES_CLAVE`, se cargan desde la app) o, mientras tanto, `XUBIO_CREDS_JSON`. `[FIRMA SANTIAGO]` generar la clave y cargar las credenciales.

### 2.1 · Mail del control diario

- [ ] `[FIRMA SANTIAGO]` Elegir proveedor (Gmail API con la cuenta de Tesorería o Resend). Hasta entonces `enviadorConfigurado()` devuelve ninguno y el control solo queda registrado en `control_envios` (en seco). Destinatarios: usuarios activos con rol Controller, Tesorería o Admin de la organización.

## 3 · Datos de las cuentas

- [ ] `[FIRMA SANTIAGO]` **CUIT de cada banco** en `cuentas_origen.cuit_banco` (no está en ninguna planilla). Sin él no se genera el comprobante "Extracto Bancario".
- [ ] Cuenta contable de Xubio de cada banco (`cuentas_origen.cuenta_contable_id`). Sin ella no se genera el asiento del día.
- [ ] Cuentas FCI y remuneradas con su **cuenta madre** (`cuenta_madre_id`): Brubank reparte el Excel en la CC y la remunerada por esa relación; una tenencia de FCI solo entra a una cuenta FCI o remunerada.
- [ ] `rinde_diario` en Mercado Pago y remuneradas ("Sin movimientos" pide confirmación).

## 4 · Carga de datos desde las planillas (script de migración)

Lo mantiene otro empleado en `demo/scripts/migrar-desde-planillas/`. Comandos desde `demo/`:

- [ ] `[FIRMA SANTIAGO]` Variables (fuera del repo): `PLANILLA_VBI`, `PLANILLA_MOTOR`, `PLANILLA_FLUJO_ORIGINAL`, `PLANILLA_CASHFLOW` y `GOOGLE_ACCESS_TOKEN` o `GOOGLE_APPLICATION_CREDENTIALS` (solo lectura de Sheets).
- [ ] **En seco** (no toca ninguna base real; carga en PGlite con las migraciones del repo, la repite para probar que no duplica y deja un reporte):
  ```
  node scripts/migrar-desde-planillas/migrar.mjs --reporte /fuera/del/repo/reporte.md
  ```
  Opcional `--guardar-instantaneas DIR` (fuera del repo: tienen datos reales) y después `--instantaneas DIR` para repetir sin leer Google.
- [ ] Revisar el reporte: conteos y sumas por tabla y empresa contra las planillas, y cada `[FALTA]`. `[FIRMA SANTIAGO]` resolver los `[FALTA]`.
- [ ] `[FIRMA SANTIAGO]` **Real** (escribe en la base):
  ```
  SUPABASE_DB_URL=... node scripts/migrar-desde-planillas/migrar.mjs --escribir --confirmo
  ```
- [ ] Después de la carga real: `select * from control_bancos` y `select * from flujo_control order by fecha desc limit 20` no muestran sorpresas.

## 5 · Bucket y archivos

- [ ] Los extractos se guardan en el bucket privado **`comprobantes`** (existe desde 0001), en `<organización>/<empresa>/extractos/aaaa/mm/…`; la regla de lectura por carpeta es la de 0019. No hay que crear nada.
- [ ] `[FIRMA SANTIAGO]` Decidir si los extractos pasan a un bucket propio (pendiente anotado en `importar-extracto.mts`). No bloquea la puesta en marcha.
- [ ] Probar en la app: Bancos → **Subir extracto** con un archivo real de cada banco con lector (Hipotecario CSV y FCI PDF, Brubank XLSX, Credicoop XLS, Galicia XLSX, Macro XLS y tenencia FCI). Brubank: un solo archivo, dos cuentas. FCI: queda "tenencia del fondo" y el rendimiento en la conciliación.
- [ ] Sin lector todavía (falta un archivo de ejemplo de cada uno): ICBC (CC y FCI Alpha), Santander, Chubut, Mercado Pago (Excel/CSV), Galicia FCI, BBVA FCI, Hipotecario FCI en CSV. Para esos, mientras tanto: saldo a mano o "Sin movimientos".

## 6 · Tareas programadas y envíos a Xubio

Las tareas se registran solas al publicar en Netlify (`config.schedule` de cada función). Ver en Netlify → Functions que figuren:

| Tarea | Horario (UTC) | En Buenos Aires |
|---|---|---|
| `xubio-bancos-pendientes` | `*/15 11-22 * * 1-5` | cada 15 min, 8:00 a 19:45, L a V (feriados no) |
| `control-diario` | `0 11 * * 1-5` | 8:00, L a V (feriados no) |
| `xubio-subir-pendientes` | `*/10 * * * *` | cada 10 min |
| `leer-documentos` | `*/2 * * * *` | cada 2 min |
| `xubio-catalogos-semanal` | `17 6 * * 1` | lunes 3:17 |

Orden para prender los envíos bancarios:

1. [ ] Con `XUBIO_BANCOS_ENVIO_REAL` apagado, en la app: Bancos → **Pendiente en Xubio** → **Probar en seco**. Revisar cada línea (cuentas que no existen en el plan de Xubio, asientos que no balancean, comprobantes sin aprobar). En seco no cambia ningún estado; deja `xubio_log` y `procesos_log`.
2. [ ] `[FIRMA SANTIAGO]` Prender `XUBIO_BANCOS_ENVIO_REAL=true` y redeploy. Primera corrida real a mano (**Enviar a Xubio ahora**) con Guido mirando Xubio.
3. [ ] Anulaciones: las órdenes de pago y la emisión de cheques **no se anulan por API**. Quedan en ERROR con "Anularlo a mano en Xubio". Administración las anula en Xubio y aprieta **Ya lo anulé en Xubio** (en Pendiente en Xubio o en Cheques), con la nota (n.º de anulación y fecha). Queda en la auditoría.
4. [ ] `[FIRMA SANTIAGO]` Borrado de asientos: probar `DELETE asientoContableManualBean/{id}` con un asiento de $1 en Xubio real; si funciona, `XUBIO_BORRAR_ASIENTO_CONFIRMADO=true`. Mientras tanto, las anulaciones de asientos quedan PENDIENTE y se marcan a mano igual que las órdenes de pago.

## 7 · Período en paralelo (2 semanas) y criterio de corte

Durante 10 días hábiles se trabaja **en las dos**: VBI+ / Flujo original como hasta hoy, y la base (app) con los mismos extractos del día.

Todos los días (Tesorería, antes de las 11):

- [ ] Subir en la app los mismos extractos que se pegan en VBI+; marcar "Sin movimientos" donde corresponda; reclasificar lo "A revisar".
- [ ] Comparar por unidad y día: estado del Control del Flujo de la base (`flujo_control`: OK / F, diferencia) contra la fila "Conciliación Bancaria" del Flujo original (Ok / F / Sin extracto) y `Conciliacion_Diaria` de VBI+ (estado y diferencia por banco). Si el comparador de `demo/scripts/paralelo/` (otro empleado) está terminado, usarlo; si no, a mano.
- [ ] Anotar cada diferencia con su causa (extracto faltante, regla nueva, error de la planilla, error de la base) y si se corrigió.
- [ ] Revisar Bancos → Pendiente en Xubio: nada en ERROR sin explicación de un día para el otro.

**Criterio de corte** (las planillas se apagan solo si se cumple todo):

1. 10 días hábiles seguidos en los que, para cada unidad del Flujo, el saldo de bancos de la base y el de la planilla coinciden con tolerancia de $1, o la diferencia está explicada y es un error de la planilla.
2. Los últimos 5 días hábiles sin ningún F en `flujo_control` por causa de la base.
3. Todo extracto con lector entra por la app sin intervención técnica; los bancos sin lector tienen su procedimiento a mano acordado.
4. Comprobantes y asientos bancarios subidos a Xubio en real al menos 5 días hábiles, sin ERROR abierto de más de un día; anulaciones a mano al día.
5. Control diario (mail o, sin proveedor, la vista `control_bancos`) revisado todos los días del período.
6. `[FIRMA SANTIAGO]` Visto bueno final de Santiago, con el registro de diferencias del período.

Si un criterio falla, el período se extiende hasta tener 10 días hábiles seguidos que cumplan. **Corte** `[FIRMA SANTIAGO]`: las planillas pasan a solo lectura (no se borran) y la base queda como única fuente.

## Pendientes de firma (resumen)

| # | Qué | Paso |
|---|---|---|
| 1 | Copia de seguridad y fecha de inicio del paralelo | 0 |
| 2 | Claves y variables (Supabase, `CREDENCIALES_CLAVE`, credenciales de Xubio, Gemini, `INGESTA_TOKEN`) | 2 |
| 3 | Proveedor de mail del control diario | 2.1 |
| 4 | CUIT de cada banco | 3 |
| 5 | IDs de planillas y credencial de lectura; resolver los `[FALTA]`; carga real | 4 |
| 6 | Bucket propio para extractos (opcional) | 5 |
| 7 | Prender `XUBIO_BANCOS_ENVIO_REAL` y la primera corrida real | 6 |
| 8 | Prueba de $1 del borrado de asientos y `XUBIO_BORRAR_ASIENTO_CONFIRMADO` | 6 |
| 9 | `CONTROL_DIARIO_ENVIO_REAL` | 2 |
| 10 | Visto bueno final y corte de planillas | 7 |
