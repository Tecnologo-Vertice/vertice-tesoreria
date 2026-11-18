# Aislamiento por empresa · 18/11/2026

Cada persona ve y opera solo las empresas que tiene asignadas. Hasta la migración 0009, cualquier usuario habilitado leía las 8 empresas: el permiso era solo por rol.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| `usuarios.todas_empresas` | `true` → ve las 8 (como antes). Los usuarios que ya existían quedan en `true`: aplicar la migración no cambia nada para el equipo. |
| `usuarios_empresas` | Si `todas_empresas = false`, la persona ve solo las empresas listadas acá. Un usuario nuevo arranca sin empresas y no ve nada. |
| Lectura (RLS) | Empresas, facturas, pagos, cuentas, movimientos, memoria de proveedores, log de Xubio, auditoría, documentos y los PDF/comprobantes del storage filtran por empresa. La vista `export_cashflow` ya era `security_invoker`, así que hereda el filtro. |
| Escritura | Las acciones de negocio son SECURITY DEFINER (saltan el RLS). Un trigger en `facturas`, `pagos`, `proveedores_empresa` y `documentos` controla la empresa cuando la acción viene de una persona (rol `authenticated`). El servidor (ingesta, espejo, subida a Xubio) no pasa por ese control. |
| Funciones de Netlify | `contabilizar` y `xubio-factura` usan la clave de servicio: controlan la empresa con `exigirEmpresa()` → `usuario_ve_empresa()`. `leer-ahora` solo devuelve el detalle de la cola a quien ve todas. |

## Qué queda visible para todos los habilitados

- **Proveedores** (padrón de CUIT y nombre), **cuentas contables y reglas comunes** (`empresa_id` null), **productos de Xubio** y **estado del espejo**. Tesorería necesita el padrón para cargar pagos sin factura.
- **Documentos todavía sin leer:** no tienen empresa, así que solo los ve quien tiene `todas_empresas`.

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
