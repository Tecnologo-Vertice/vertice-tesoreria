# Puesta en producción · paso a paso

Estado al 13/10/2026: el código de producción está escrito y compila, pero **no se probó contra servicios reales** porque todavía no existen las cuentas. Este documento es la lista de pasos para crearlas y encenderlo. Cada paso dice quién lo hace y cómo se verifica.

La misma app corre en dos modos:

| Modo | Cuándo | Cómo se activa |
|---|---|---|
| **Demo** | Presentaciones, capacitación, pruebas de pantalla | Sin variables de entorno. Es lo que corre hoy. |
| **Conectado** | Piloto y producción | Con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` definidas. Aparece el login con Google. |

## Qué hay en el repo para producción

| Carpeta | Qué es |
|---|---|
| `demo/supabase/migrations/` | Cuatro archivos SQL: esquema, seguridad, funciones de negocio, datos iniciales. Se corren una vez, en orden. |
| `demo/netlify/functions/` | Tres funciones de servidor: `ia-leer-comprobante` (Gemini), `contabilizar` (Xubio, con modo en seco), `ingesta-factura` (recibe facturas del Apps Script). |
| `demo/src/data/fuenteSupabase.ts` | La app hablando con la base real. Mismo contrato que la demo. |
| `demo/gas/EnviarAlSistema.gs` | Archivo para pegar en el Apps Script: manda cada factura leída a la base nueva. |
| `demo/.env.example` | Lista de variables que hay que configurar, con explicación. |

## Paso 1 · Supabase (base de datos, login, archivos)

**Quién:** Tecnología. **Tiempo:** 30 minutos.

1. Crear cuenta en supabase.com con el mail de la empresa. Crear dos proyectos: `vertice-dev` y `vertice-prod`. Región: la más cercana (São Paulo) o Europa si dirección prefiere datos fuera de Estados Unidos.
2. En cada proyecto, **SQL Editor** → pegar y ejecutar, en orden, `0001_esquema.sql`, `0002_seguridad.sql`, `0003_funciones.sql`, `0004_semilla.sql`.
3. Antes de correr `0004_semilla.sql`: editar los mails de la tabla `usuarios` con los reales de Vivi, Guido y quien apruebe. **Si un mail no está ahí, Google no deja entrar.** Editar también los CUIT de las empresas (están como marcador).
4. **Authentication → Providers → Google:** habilitar. Pide un Client ID y Secret de Google Cloud (paso 2). Copiar la "Callback URL" que muestra Supabase.
5. **Authentication → URL Configuration:** Site URL = la URL de Netlify (paso 3). Agregar `http://localhost:5173` a Redirect URLs para desarrollo.
6. **Settings → API:** copiar `Project URL`, `anon key` y `service_role key`. La `service_role` nunca va al navegador ni al repo.

**Verificación:** en Table Editor se ven las tablas; en `empresas` hay 8 filas; en `usuarios` están los mails reales.

## Paso 2 · Google Cloud (login y Gemini)

**Quién:** Tecnología, en el proyecto de Google Cloud de la empresa (no en cuentas personales). **Tiempo:** 20 minutos.

1. **APIs y servicios → Pantalla de consentimiento OAuth:** tipo "Interno" (solo cuentas del dominio). Sin verificación de Google.
2. **Credenciales → Crear ID de cliente OAuth → Aplicación web.** Orígenes autorizados: la URL de Netlify y `http://localhost:5173`. URI de redirección: la Callback URL de Supabase del paso 1.4. Copiar Client ID y Secret a Supabase.
3. **Gemini:** en AI Studio o en la consola, crear una clave de API ligada a este proyecto, con facturación activa (nivel pago). Poner un presupuesto con alerta en USD 10.

**Verificación:** desde `npm run dev` con las variables de Supabase cargadas, "Entrar con Google" abre el selector de cuenta y entra con un mail que está en `usuarios`. Con uno que no está, muestra "no está habilitada".

## Paso 3 · Netlify (publicación y funciones)

**Quién:** Tecnología, cuenta de la empresa. **Tiempo:** 20 minutos.

1. Subir `proyecto_futuro/demo` a un repositorio privado de GitHub de la empresa (sin `.env`).
2. En Netlify: **Add new site → Import from Git.** Base directory `demo` si el repo es toda la carpeta, o vacío si el repo es solo `demo`. Build command y publish ya están en `netlify.toml`.
3. **Site configuration → Environment variables:** cargar todas las de `.env.example`. `XUBIO_ENVIO_REAL=false`. `INGESTA_TOKEN`: un texto largo al azar (por ejemplo 40 caracteres).
4. Deploy. Opcional: dominio `tesoreria.verticebi.com` en **Domain management**.

**Verificación:** la URL abre el login. Entrando con un usuario habilitado se ven las bandejas vacías (todavía no hay facturas). En **Functions** aparecen las tres funciones.

## Paso 4 · Cargar el plan de cuentas y las cuentas de origen

**Quién:** Tecnología con Guido. **Tiempo:** 1 hora.

Hoy se cargan a mano en las tablas `cuentas_contables` y `cuentas_origen` (Table Editor de Supabase), tomando los nombres **exactos** de Xubio, porque la función `contabilizar` busca por nombre. Fuente: el export `Xubio_Cuentas_y_Productos_Todas_las_Empresas.xlsx` y la pestaña `Xubio_Cuentas_Origen` de la copia de desarrollo.

Pendiente de automatizar: una función `cargar-plan-cuentas` que lea `cuenta?activo=1` de Xubio por empresa, como hace `cargarPlanCuentasDesdeXubio` en la copia.

## Paso 5 · Conectar el Apps Script (ingesta de facturas)

**Quién:** Tecnología con Santi, primero en la copia. **Tiempo:** 1 hora.

1. En el editor de Apps Script: archivo nuevo `EnviarAlSistema`, pegar `gas/EnviarAlSistema.gs`.
2. Script Properties: `SISTEMA_URL` = URL de Netlify, `INGESTA_TOKEN` = el mismo valor que en Netlify.
3. En `guardarEnSheets`, después del `appendRow`, agregar la línea que indica el encabezado del archivo.
4. Ejecutar `reenviarFacturasAlSistema()` una vez para traer el histórico de la hoja. Es idempotente: se puede correr de nuevo sin duplicar.

**Verificación:** las facturas de la hoja aparecen en la bandeja de Aprobación y en Pagos con el mismo estado que en el dashboard viejo. La auditoría muestra "Apps Script · INGRESO".

## Paso 6 · Xubio en seco

**Quién:** Tecnología con Guido. **Tiempo:** 1 hora.

1. En Xubio, por empresa, crear una **App Cliente** nueva llamada "Vértice-Tesorería-<empresa>" (Configuración → API). Copiar Client ID y Secret.
2. Armar el JSON de `XUBIO_CREDS_JSON` con la clave igual al id de la empresa (`beratung`, `india`, `controlb`, `ysd`, `vertice`) y cargarlo en Netlify. Mantener `XUBIO_ENVIO_REAL=false`.
3. Vivi carga un pago de prueba chico en la app. Guido toca "Contabilizar en Xubio".
4. Resultado esperado: toast "Prueba en seco OK", el pago queda **Revisado**, y en la tabla `xubio_log` aparece el comprobante exacto que se habría enviado. Si una cuenta o el proveedor no existen en Xubio, la función lo dice y no deja seguir.

## Paso 7 · Primer pago real

**Quién:** Guido y Tecnología, juntos. **Cuándo:** después de dos semanas de piloto sin diferencias.

1. Elegir un pago chico de Beratung a un proveedor que ya exista en Xubio.
2. Cambiar `XUBIO_ENVIO_REAL=true` en Netlify (redeploy automático).
3. Guido contabiliza. El pago pasa a **Contabilizado** con el id que devolvió Xubio. Verificar en Xubio.
4. Si algo salió mal con una orden de pago: no se puede borrar por API; se anula en Xubio a mano. Los asientos manuales sí se pueden borrar.
5. Volver a `false` hasta decidir habilitar empresa por empresa.

## Lo que todavía no está en el código de producción

| Qué | Estado | Dónde queda |
|---|---|---|
| Mail automático al proveedor con factura y comprobante | La base marca `MAIL_PENDIENTE` en auditoría; falta la función que lo envíe (Gmail API o Resend) | Fase 2, semanas 5-6 |
| Subida de facturas aprobadas a Xubio desde la app | Hoy lo sigue haciendo el Apps Script; la app recibe el estado por ingesta | Fase 4 |
| Carga automática del plan de cuentas desde Xubio | Manual (paso 4) | Fase 2 |
| Volcado de `export_cashflow` a Google Sheets | La vista existe; falta la función programada que escriba la hoja | Fase 2, cuando Santi confirme la opción B |
| Pruebas automáticas | Hay pruebas de la base (`npm run test:sql`: corre las migraciones en un Postgres local y prueba pagos, reingesta y seguridad). No hay pruebas de pantallas ni de las funciones de Netlify | Antes del piloto |
| Extractos, conciliación, económicos | Tablas creadas, sin pantallas ni lógica | Fase 5 |

Los errores que encontró la auditoría del 13/10/2026 y que impedían usar datos reales ya están corregidos; el detalle está en [09-prueba-con-el-equipo.md](09-prueba-con-el-equipo.md).

## Lo que necesito de vos para encender esto

1. Acceso o creación de la cuenta de Supabase y del proyecto de Google Cloud de la empresa.
2. Los mails reales de Vivi, Guido y de quien aprueba facturas, con su rol.
3. Los CUIT de las ocho empresas.
4. Las credenciales de API de Xubio por empresa (o que Santi las cree).
5. La decisión de Santi sobre el Cash Flow (opción B: su hoja lee la nuestra).
