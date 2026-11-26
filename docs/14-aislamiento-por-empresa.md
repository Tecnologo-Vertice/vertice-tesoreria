# Aislamiento por empresa · 18/11/2026

Cada persona ve y opera solo las empresas que tiene asignadas. Hasta la migración 0009, cualquier usuario habilitado leía las 8 empresas: el permiso era solo por rol.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| `usuarios.todas_empresas` | `true` → ve las 8 (como antes). Los usuarios que ya existían quedan en `true`: aplicar la migración no cambia nada para el equipo. |
| `usuarios_empresas` | Si `todas_empresas = false`, la persona ve solo las empresas listadas acá. Un usuario nuevo arranca sin empresas y no ve nada. |
| Lectura (RLS) | Empresas, facturas, pagos, cuentas, movimientos, memoria de proveedores, log de Xubio, auditoría, documentos y los PDF/comprobantes del storage filtran por empresa. La vista `export_cashflow` ya era `security_invoker`, así que hereda el filtro. |
| Escritura | Las acciones de negocio son SECURITY DEFINER (saltan el RLS). Un trigger en `facturas`, `pagos`, `proveedores_empresa` y `documentos` controla la empresa en toda acción que no venga del servidor. Desde la migración 0013 el control falla cerrado: `es_servidor()` reconoce solo el rol `service_role` (funciones de Netlify) y la conexión directa de `postgres` o `supabase_admin` (editor SQL, migraciones); cualquier otro rol se controla como una persona. |
| Funciones de Netlify | Usan la clave de servicio, así que controlan la empresa a mano. `contabilizar` y `xubio-factura`: `exigirEmpresa()` → `usuario_ve_empresa()`. Desde 0013: `subir-factura` acepta `empresaId` (controlado) y guarda en el documento las empresas para las que se puede cargar (`documentos.empresas_permitidas`); la base no guarda la factura si es de otra. `xubio-catalogos` entra solo al Xubio de las empresas que ve quien lo pide. `leer-ahora`, pedido por quien no ve todas, lee solo lo subido para sus empresas. `ia-leer-comprobante` pide un rol que cargue pagos. |

## Qué queda visible para todos los habilitados de una organización

- **Proveedores** (padrón de CUIT y nombre), **cuentas contables y reglas comunes** (`empresa_id` null), **productos de Xubio** y **estado del espejo**. Tesorería necesita el padrón para cargar pagos sin factura. Desde la 0018, solo los de su organización (ver abajo).
- **Documentos todavía sin leer:** los de Gmail y Drive no tienen empresa, así que solo los ve quien tiene `todas_empresas`. Desde la 0018, los que subió una persona los ve también quien ve todas las empresas para las que se subieron.

## Organizaciones (migraciones 0017 y 0018) · 26/11/2026

Por encima de las empresas está la organización: el cliente. Vértice es la primera y, por ahora, la única. Para el equipo no cambia nada.

| Pieza | Qué hace |
|---|---|
| `organizaciones` | Una fila por cliente: `slug`, `nombre`, `estado` (`ACTIVA`, `SUSPENDIDA`, `BAJA`) y `es_proveedor` (verdadero solo para Vértice). Si no está `ACTIVA`, su gente no entra. |
| `organizacion_id` | Obligatorio en `empresas`, `usuarios`, `proveedores`, `documentos`, `auditoria`, `cuentas_contables`, `reglas_cuenta`, `productos_xubio` y `espejo_estado`. Facturas, pagos, cuentas de origen, movimientos y memoria de proveedores la heredan de su empresa. No se puede cambiar. |
| Claves por organización | El mismo CUIT puede ser proveedor de dos organizaciones (son dos fichas). Lo mismo el adjunto de un mail, el nombre de una cuenta común, un producto y el estado de la copia. |
| "Ve todas las empresas" | Pasa a ser "todas las de su organización". `usuario_ve_empresa()` exige que la empresa sea de la organización de la persona, así que cambian solas todas las reglas y controles que ya miraban la empresa. |
| Registro nuevo sin organización | Se deduce: de la empresa, de la persona que hace la acción o, si hay una sola organización, esa. Si hay más de una y no se puede deducir, se rechaza. |
| Cruces | Una persona solo puede tener asignadas empresas de su organización. El proveedor de una factura o un pago es de la organización de la empresa. Un adjunto de una organización no puede terminar en una factura de otra. |
| Funciones de Netlify | `usuarioDesde` devuelve la organización y rechaza a quien es de una organización que no está activa. `leer-ahora` lee solo la cola de la organización de quien lo pide. |
| Puentes del Apps Script | Desde la 0022 la organización sale del secreto (ver "Secretos por organización" más abajo). `INGESTA_TOKEN` sigue valiendo para la organización que da el servicio. |

### Archivos (migración 0019)

| Qué | Cómo queda |
|---|---|
| Ruta de lo nuevo | `<organización>/<empresa>/…`. La organización es su identificador. En las facturas, que se suben antes de saber de qué empresa son, la segunda carpeta es la empresa elegida o `sin-empresa`. |
| Comprobantes de pago | Se suben y se leen por carpeta: hay que ser de esa organización y ver esa empresa. `registrar_pago` rechaza un comprobante que no esté en la carpeta de la empresa del pago. Si en el formulario se cambia la empresa después de subirlo, la pantalla lo guarda de nuevo en la carpeta correcta al confirmar. |
| PDF de facturas | Los sube solo el servidor. Se leen si la carpeta es de mi organización y, además, veo el documento o la factura que apunta al archivo. |
| Archivos de antes | Sus rutas no tienen carpeta de organización (`año/mes/…`). Son de la organización que ya existía entonces (la que da el servicio): nadie de otra organización los lee, los sube ni los usa en un pago. Dentro de ella se siguen leyendo como antes: a través del pago, la factura o el documento que apunta a ellos. Un comprobante viejo que ya está en un pago de otra empresa no se puede volver a usar. |
| Pantallas con el código anterior | Siguen subiendo el comprobante con la ruta vieja y la base lo acepta mientras `acepta_rutas_viejas()` devuelva verdadero. Cuando el código nuevo esté publicado y el equipo haya recargado, se cierra con una línea (está en `TANDA_B.md`): desde ahí ningún pago ni subida nuevos usan rutas viejas. |
| Archivo suelto | Un archivo viejo al que no apunta ningún registro ya no lo lee nadie desde la pantalla (antes lo leía quien veía todas las empresas). |

### Nombres de empresas como datos (migración 0020)

La lectura de facturas (`lib/factura.ts`) y la copia de la hoja (`lib/espejo.ts`) ya no tienen escritos los nombres de las empresas. Para reconocer de qué empresa es una factura o una fila de la hoja, comparan contra las empresas de la organización del documento, y ninguna más:

| Columna de `empresas` | Para qué |
|---|---|
| `alias` | Formas en que aparece el nombre como receptora. Un alias con varias partes unidas con `+` (`drogueria+robles`) pide que estén todas. Se compara sin mayúsculas, tildes, espacios ni signos. |
| `alias_emisor` | Lo mismo para el emisor: una factura emitida por alguien que coincide se asigna a esa empresa (regla del Apps Script para Robles). |
| `alias_orden` | Si un texto coincide con dos empresas, gana la de orden menor. |
| `erp` | Qué empresas no usan Xubio (antes, una lista en `lib/espejo.ts`). |

Una empresa sin alias se reconoce solo por su CUIT. Para agregar una forma nueva de escribir una empresa:

```sql
update empresas set alias = alias || '{"beratung consultora"}' where id = 'beratung';
```

La IA recibe en el pedido solo los nombres y CUIT de las empresas de la organización del documento.

**Pendiente: todavía hay nombres de Vértice escritos en la pantalla.** Hay que pasarlos a datos antes de dar el sistema a otra organización:

| Dónde | Qué tiene escrito |
|---|---|
| `demo/src/lib/mails.ts` | Los nombres de las 8 empresas y las casillas de Tesorería. Para otra organización, el mail a un proveedor saldría con el remitente de Vértice |
| `demo/src/screens/Ralpharma.tsx` | El texto de la bandeja nombra a Droguería Robles, Héctor Robles y Farma Control |

### Credenciales de Xubio en la base (migración 0021)

| Qué | Cómo queda |
|---|---|
| `conexiones_erp` | Una fila por empresa y ERP con la credencial de Xubio cifrada (`secreto_cifrado`), los últimos 4 caracteres del identificador (`pista`), cuándo se probó y quién la cargó. Solo acepta texto cifrado. |
| Quién la lee | Solo el servidor. Ninguna sesión de persona, ni siquiera un administrador: sin permisos para `anon` ni `authenticated` y con RLS sin reglas. Ninguna función de la base la toca. |
| Cifrado | Lo hace la función de Netlify (`lib/cifrado.ts`): AES-256-GCM con la clave de la variable `CREDENCIALES_CLAVE` (32 bytes en base64). Cada dato queda atado a su empresa: copiado a otra no se descifra. |
| Cuál se usa | `credencialesDe(db, empresa)`: la de la tabla si hay fila; si no, la de `XUBIO_CREDS_JSON`, como siempre. Si hay fila y no se puede descifrar, da error (no cae en silencio a la variable). |
| Alta | `POST /api/xubio/credenciales` (`{ empresaId, clientId, secret }`), solo rol ADMIN y para una empresa que ve. Pide un token a Xubio para probarla; si Xubio la rechaza, no guarda nada. Sin `CREDENCIALES_CLAVE`, se rechaza con un mensaje claro y todo sigue con la variable. No hay pantalla todavía (grupo K) |
| Cambio de clave | Poner la nueva en `CREDENCIALES_CLAVE` y la de antes en `CREDENCIALES_CLAVE_ANTERIOR`. Lo cifrado con la anterior se sigue leyendo y se vuelve a cifrar con la nueva la primera vez que se usa. |
| Para volver a la variable | `delete from conexiones_erp where empresa_id = '…';` |
| Auditoría | Cargar, reemplazar o borrar una credencial (también a mano por SQL) deja un renglón en `auditoria` con quién, la empresa y la pista. Nunca el dato cifrado. Volver a cifrarla en un cambio de clave no se anota |

### Secretos por organización (migración 0022)

Los puentes del Apps Script (`/api/espejo`, `/api/ingesta/adjunto`, `/api/ingesta/factura`, `/api/ingesta/conocidos`, `/api/cheques/*`, `/api/flujo/datos`) mandan un secreto en `x-ingesta-token`. De ese secreto sale para qué organización trabajan.

| Qué | Cómo queda |
|---|---|
| `INGESTA_TOKEN` (la variable de siempre) | Vale para la organización que da el servicio (`es_proveedor`, Vértice), en todas las tareas. El Apps Script de Vértice no cambia. Si ninguna organización figura así y hay una sola, esa; con dos o más, 409 como antes |
| `tokens_integracion` | Secretos de las demás organizaciones: uno por organización y por tarea (`INGESTA`, `COPIA_HOJA`, `CHEQUES`, `FLUJO`). Se guarda solo el SHA-256 del secreto. Nadie con sesión la lee |
| Crear uno | En el editor SQL: `select crear_token_integracion((select id from organizaciones where slug = 'otra'), 'COPIA_HOJA', 'Apps Script de Otra');`. Devuelve el secreto una sola vez; se pega en las propiedades del Apps Script de esa organización como `INGESTA_TOKEN` |
| Revocar | `update tokens_integracion set activo = false where id = '…';` Sin redesplegar |
| Auditoría | Crear, revocar, reactivar o borrar un secreto deja un renglón en la auditoría de su organización (quién, tarea y nombre; nunca el secreto ni su resumen). A una organización que no está activa no se le crean secretos |
| Un secreto de otra tarea | 403. Un secreto revocado o que no existe, 401. Organización suspendida, 403 |
| En la base | La copia de la hoja, cheques, flujo y subida a Xubio tienen versión con organización: cada una solo carga, entrega y marca lo de esa organización. Lo que no trae empresa (mails, productos, pagos de la hoja sin empresa) queda a nombre de la organización del secreto. Las versiones de antes (sin organización) siguen andando con una sola organización y se detienen con dos |
| Tareas programadas | El subidor a Xubio, los catálogos semanales y el lector de facturas recorren las organizaciones activas una por una (el lector, por turnos: un documento de cada una) |

La prueba fija está en `npm run test:sql`, sección "Dos organizaciones que no se ven ni se tocan": una segunda organización de mentira con sus empresas, usuarios, proveedores, facturas, pagos, documentos y auditoría. Compara, tabla por tabla, lo que ve cada una con lo que es suyo, y prueba cada acción de negocio contra los datos de la otra. `npm run test:organizaciones` hace lo mismo con las funciones de Netlify.

## Configurar

En `configurar_equipo.sql`, sección 1b. Ejemplo para limitar a una persona:

```sql
update usuarios set todas_empresas = false where email = 'tesoreria@verticebi.com';
insert into usuarios_empresas (email, empresa_id) values
  ('tesoreria@verticebi.com', 'beratung'), ('tesoreria@verticebi.com', 'india')
on conflict do nothing;
```

## Pruebas

En `npm run test:sql` hay 30 casos nuevos (sección "Aislamiento por empresa"):

- Un usuario de India no ve facturas, pagos, auditoría, PDF ni flujo de otras empresas.
- No puede aprobar, rechazar, editar ni pagar en Beratung, y sí puede hacerlo en India.
- Un usuario nuevo no ve nada.
- Un usuario con `todas_empresas` sigue viendo las 8.
- Un usuario dado de baja no ve ninguna.

Se verificó que las pruebas fallan si se saca el filtro de facturas o el trigger.

Desde 0013 se suman la sección "Control que falla cerrado y documentos por empresa" de `test:sql` (un rol desconocido es rechazado; el rol `service_role` sigue pudiendo ingresar y copiar la hoja) y `npm run test:separacion`, que corre las funciones de Netlify enteras contra un simulador: un usuario de India no carga una factura en Beratung ni dispara el Xubio de otra empresa.
