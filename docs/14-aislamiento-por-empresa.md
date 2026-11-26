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
| Puentes del Apps Script | Tienen un solo secreto, sin dueño. Mientras haya una sola organización trabajan para esa. Con dos o más responden 409 y no copian ni entregan nada, hasta que cada organización tenga su secreto. |

### Archivos (migración 0019)

| Qué | Cómo queda |
|---|---|
| Ruta de lo nuevo | `<organización>/<empresa>/…`. La organización es su identificador. En las facturas, que se suben antes de saber de qué empresa son, la segunda carpeta es la empresa elegida o `sin-empresa`. |
| Comprobantes de pago | Se suben y se leen por carpeta: hay que ser de esa organización y ver esa empresa. `registrar_pago` rechaza un comprobante que no esté en la carpeta de la empresa del pago. Si en el formulario se cambia la empresa después de subirlo, la pantalla lo guarda de nuevo en la carpeta correcta al confirmar. |
| PDF de facturas | Los sube solo el servidor. Se leen si la carpeta es de mi organización y, además, veo el documento o la factura que apunta al archivo. |
| Archivos de antes | Sus rutas no tienen carpeta de organización (`año/mes/…`). Se siguen leyendo como antes: a través del pago, la factura o el documento que apunta a ellos. Un comprobante viejo que ya está en un pago de otra empresa no se puede volver a usar. |
| Archivo suelto | Un archivo viejo al que no apunta ningún registro ya no lo lee nadie desde la pantalla (antes lo leía quien veía todas las empresas). |

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
