# Modelo de datos · borrador para PostgreSQL

Es el mismo modelo que la demo usa en memoria (`demo/src/types.ts`). Cada tipo de ahí es una tabla acá. Los nombres de columnas respetan, cuando existen, los encabezados de las hojas `Facturas` y `Pagos` del Apps Script para que la migración sea un mapeo directo.

## Principios

1. Importes en `NUMERIC(14,2)`. Fechas de negocio en `DATE`; marcas de auditoría en `TIMESTAMPTZ`.
2. Claves sustitutas UUID más clave natural única donde existe.
3. `empresa_id` en todas las tablas de negocio desde el día uno.
4. `auditoria` de solo inserción; nadie tiene permiso de `UPDATE` ni `DELETE` sobre ella.
5. Ids externos guardados: `xubio_id`, `drive_file_id`, `sheets_fila_origen` (para la migración).

## Esquema

```sql
create type erp as enum ('XUBIO', 'RALPHARMA', 'NINGUNO');
create type estado_factura as enum ('PENDIENTE_APROBACION','PARA_PAGAR','PAGADA_PARCIAL','PAGADA','RECHAZADA','ERROR');
create type estado_xubio as enum ('PENDIENTE','SUBIDA','ERROR','SIN_ERP','PENDIENTE_RALPHARMA','CARGADA_RALPHARMA');
create type metodo_pago as enum ('TRANSFERENCIA','CHEQUE','ECHEQ','DEBITO','TARJETA','CAJA');
create type forma_carga_xubio as enum ('ORDEN_PAGO','SALIDA_FONDOS','ASIENTO_MANUAL');
create type estado_pago as enum ('CARGADO','REVISADO','CONTABILIZADO','CONCILIADO','PENDIENTE_RALPHARMA');
create type rol as enum ('TESORERIA','ADMINISTRACION','APROBADOR','DIRECCION','ADMIN');

create table empresas (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  nombre_corto  text not null,
  cuit          char(11) not null unique,
  erp           erp not null default 'XUBIO',
  activa        boolean not null default true
);

create table usuarios (
  id        uuid primary key,              -- = auth.users.id en Supabase
  email     text not null unique,
  nombre    text not null,
  rol       rol not null,
  activo    boolean not null default true
);

create table proveedores (
  id                 uuid primary key default gen_random_uuid(),
  cuit               char(11) not null unique,
  nombre             text not null,
  email              text,
  categoria_vertice  text,                 -- PROVEEDOR, PRESTADOR_MEDICO, ...
  creado_en          timestamptz not null default now()
);

-- Cuenta contable y producto de Xubio por proveedor y empresa (memoria del sistema actual).
create table proveedores_empresa (
  proveedor_id       uuid references proveedores,
  empresa_id         uuid references empresas,
  xubio_proveedor_id text,
  cuenta_contable    text,
  codigo_producto    text,
  primary key (proveedor_id, empresa_id)
);

create table cuentas_contables (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas,
  codigo      text,
  nombre      text not null,
  tipo        text,                        -- Rama / Cuenta
  activa      boolean not null default true,
  unique (empresa_id, nombre)
);

create table cuentas_origen (               -- bancos y cajas, leídas de Xubio
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas,
  nombre      text not null,
  xubio_id    text,
  unique (empresa_id, nombre)
);

create table facturas (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references empresas,
  proveedor_id         uuid not null references proveedores,
  tipo                 text not null,      -- Factura A/B/C/M, Nota de Crédito...
  letra                char(1),
  punto_venta          integer not null,
  numero               integer not null,
  fecha                date not null,
  vencimiento          date,
  moneda               text not null default 'ARS',
  cotizacion           numeric(12,4) default 1,
  neto                 numeric(14,2) not null,
  iva                  numeric(14,2) not null default 0,
  exento               numeric(14,2) not null default 0,
  percepciones_json    jsonb not null default '[]',
  total                numeric(14,2) not null,
  cae                  char(14),
  cae_vencimiento      date,
  origen               text not null,      -- GMAIL / DRIVE / MANUAL
  drive_file_id        text,
  estado               estado_factura not null default 'PENDIENTE_APROBACION',
  estado_xubio         estado_xubio not null default 'PENDIENTE',
  xubio_id             text,
  validacion_ok        boolean not null default false,
  motivo_validacion    text,
  categoria_vertice    text,
  cuenta_contable_id   uuid references cuentas_contables,
  metodo_pago          metodo_pago,
  dias_cheque          integer,
  pagado_pct           numeric(5,2) not null default 0,
  saldo_nc             numeric(14,2) not null default 0,
  aprobado_por         uuid references usuarios,
  aprobado_en          timestamptz,
  sheets_fila_origen   integer,
  creado_en            timestamptz not null default now(),
  unique (empresa_id, proveedor_id, tipo, punto_venta, numero)   -- anti-duplicado
);

create table pagos (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            uuid not null references empresas,
  proveedor_id          uuid references proveedores,
  fecha                 date not null,
  importe               numeric(14,2) not null check (importe > 0),
  medio                 metodo_pago not null,
  cuenta_origen_id      uuid references cuentas_origen,
  banco_destino         text,
  numero_cheque         text,
  fecha_acreditacion    date,
  descripcion           text,
  observaciones         text,               -- el comentario de Vivi para Guido
  cuenta_contable_id    uuid references cuentas_contables,
  sugerencia_origen     text,               -- REGLA / IA / MANUAL
  sugerencia_confianza  numeric(4,3),
  forma_carga_xubio     forma_carga_xubio,
  estado                estado_pago not null default 'CARGADO',
  comprobante_path      text,               -- Supabase Storage
  xubio_id              text,
  cargado_por           uuid not null references usuarios,
  cargado_en            timestamptz not null default now(),
  contabilizado_por     uuid references usuarios,
  contabilizado_en      timestamptz,
  mail_proveedor_en     timestamptz,
  sheets_fila_origen    integer
);

create table pagos_facturas (                -- N a N: parciales, múltiples, NC
  pago_id     uuid references pagos on delete cascade,
  factura_id  uuid references facturas,
  importe     numeric(14,2) not null,
  primary key (pago_id, factura_id)
);

create table reglas_cuenta (                 -- lo que hoy es Reglas_Cuenta_Pagos
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas,
  proveedor_id    uuid references proveedores,
  patron          text,                      -- texto que matchea la descripción
  cuenta_contable_id uuid not null references cuentas_contables,
  forma_carga     forma_carga_xubio,
  veces_usada     integer not null default 0,
  creada_por      uuid references usuarios,
  creada_en       timestamptz not null default now()
);

create table movimientos_bancarios (         -- fase 4
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas,
  cuenta_origen_id uuid not null references cuentas_origen,
  fecha           date not null,
  descripcion     text,
  importe         numeric(14,2) not null,     -- negativo = egreso
  saldo           numeric(14,2),
  referencia      text,
  pago_id         uuid references pagos,      -- conciliado contra
  importado_en    timestamptz not null default now(),
  unique (cuenta_origen_id, fecha, importe, referencia)
);

create table xubio_log (                      -- cada request a Xubio, en seco o real
  id          bigserial primary key,
  empresa_id  uuid references empresas,
  entidad     text, entidad_id uuid,
  en_seco     boolean not null,
  request     jsonb, response jsonb, http_status integer,
  creado_en   timestamptz not null default now()
);

create table auditoria (
  id          bigserial primary key,
  fecha       timestamptz not null default now(),
  usuario_id  uuid references usuarios,
  usuario     text not null,                 -- copia del email del token, inmutable
  rol         rol,
  accion      text not null,
  entidad     text not null,
  entidad_id  uuid,
  detalle     text,
  antes       jsonb,
  despues     jsonb
);
revoke update, delete on auditoria from authenticated;
```

## Máquina de estados del pago

```
CARGADO ──(Guido revisa)──> REVISADO ──(POST Xubio OK)──> CONTABILIZADO ──(match extracto)──> CONCILIADO
   │
   └──(empresa sin Xubio)──> PENDIENTE_RALPHARMA ──(alguien confirma)──> CONTABILIZADO
```

Regla: `CONTABILIZADO` exige `xubio_id` no nulo o `erp = RALPHARMA` con `contabilizado_por`. Se valida con un `CHECK` o un trigger.

## Vista para el Cash Flow de Santi

```sql
create view export_cashflow as
select p.fecha, e.nombre as empresa, c.nombre as cuenta_contable, p.descripcion as concepto,
       pr.nombre as proveedor, null::numeric as ingreso, p.importe as egreso, p.medio,
       co.nombre as cuenta_origen, 'REAL' as estado, p.xubio_id as referencia
from pagos p join empresas e on e.id = p.empresa_id
left join cuentas_contables c on c.id = p.cuenta_contable_id
left join proveedores pr on pr.id = p.proveedor_id
left join cuentas_origen co on co.id = p.cuenta_origen_id
union all
select f.vencimiento, e.nombre, c.nombre, 'Vence ' || f.tipo, pr.nombre, null,
       f.total * (1 - f.pagado_pct/100), f.metodo_pago, null, 'PROYECTADO', f.id::text
from facturas f join empresas e on e.id = f.empresa_id
left join cuentas_contables c on c.id = f.cuenta_contable_id
left join proveedores pr on pr.id = f.proveedor_id
where f.estado in ('PARA_PAGAR','PAGADA_PARCIAL');
```

Una función programada vuelca esta vista a la hoja `Export_CashFlow` de Google Sheets una vez por hora. El Cash Flow la lee con `IMPORTRANGE`, igual que hoy lee los 7 extractos.
