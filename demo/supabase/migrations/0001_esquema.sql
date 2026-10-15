-- Vértice Tesorería · esquema base (PostgreSQL / Supabase)
-- Correr en orden: 0001 → 0002 → 0003 → 0004. Se puede pegar en el SQL Editor de Supabase
-- o aplicar con `supabase db push`.

create extension if not exists pgcrypto;

create type erp as enum ('XUBIO', 'RALPHARMA', 'NINGUNO');
create type estado_factura as enum ('PENDIENTE_APROBACION', 'PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA', 'RECHAZADA', 'ERROR');
create type estado_xubio as enum ('PENDIENTE', 'SUBIDA', 'ERROR', 'SIN_ERP', 'PENDIENTE_RALPHARMA', 'CARGADA_RALPHARMA');
create type metodo_pago as enum ('TRANSFERENCIA', 'CHEQUE', 'ECHEQ', 'DEBITO', 'TARJETA', 'CAJA');
create type forma_carga_xubio as enum ('ORDEN_PAGO', 'SALIDA_FONDOS', 'ASIENTO_MANUAL');
create type estado_pago as enum ('CARGADO', 'REVISADO', 'CONTABILIZADO', 'CONCILIADO', 'PENDIENTE_RALPHARMA');
create type rol as enum ('TESORERIA', 'ADMINISTRACION', 'APROBADOR', 'DIRECCION', 'CONTROLLER', 'ADMIN');

-- Empresas del grupo. El id es un slug estable ('beratung') para que coincida con la app y con
-- el nombre de receptor que usa el Apps Script.
create table empresas (
  id            text primary key,
  nombre        text not null,
  nombre_corto  text not null,
  cuit          char(11) not null unique,
  erp           erp not null default 'XUBIO',
  activa        boolean not null default true
);

-- Quién puede entrar y con qué rol. El login es Google; esta tabla decide el acceso.
create table usuarios (
  email     text primary key,
  nombre    text not null,
  rol       rol not null,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

create table proveedores (
  id                 uuid primary key default gen_random_uuid(),
  cuit               char(11) not null unique,
  nombre             text not null,
  email              text,
  categoria_vertice  text,
  cuenta_habitual    text,
  creado_en          timestamptz not null default now()
);

create table cuentas_contables (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text references empresas,          -- null = común a todas
  codigo      text,
  nombre      text not null,
  xubio_id    text,
  activa      boolean not null default true,
  unique nulls not distinct (empresa_id, nombre)   -- si no, las cuentas comunes (null) se duplican
);

create table cuentas_origen (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text not null references empresas,
  nombre      text not null,
  xubio_id    text,
  tipo_cuenta integer,                            -- Xubio: 2 banco · 1 caja · 4 e-cheq
  saldo       numeric(14,2) not null default 0,
  unique (empresa_id, nombre)
);

create table facturas (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           text not null references empresas,
  proveedor_id         uuid not null references proveedores,
  tipo                 text not null,
  letra                char(1),
  punto_venta          integer not null,
  numero               integer not null,
  fecha                date not null,
  vencimiento          date,
  moneda               text not null default 'ARS',
  cotizacion           numeric(12,4) not null default 1,
  neto                 numeric(14,2) not null,
  iva                  numeric(14,2) not null default 0,
  exento               numeric(14,2) not null default 0,
  percepciones         numeric(14,2) not null default 0,
  percepciones_json    jsonb not null default '[]',
  total                numeric(14,2) not null,
  cae                  text,
  cae_vencimiento      date,
  origen               text not null default 'MANUAL',
  drive_url            text,
  estado               estado_factura not null default 'PENDIENTE_APROBACION',
  estado_xubio         estado_xubio not null default 'PENDIENTE',
  xubio_id             text,
  validacion_ok        boolean not null default false,
  motivo_validacion    text,
  categoria_vertice    text,
  cuenta_contable      text,
  codigo_producto      text,
  metodo_pago          metodo_pago,
  dias_cheque          integer,
  -- Lo pagado se guarda en pesos, no en porcentaje: un % con 2 decimales pierde $1.000 en una
  -- factura de $10 M y no puede representar los restos de centavos que limpia Guido.
  pagado               numeric(14,2) not null default 0 check (pagado >= 0),
  -- trunc y no round: con un centavo pendiente tiene que mostrar 99,99 %, no 100 %.
  pagado_pct           numeric(5,2) generated always as (trunc(least(100, pagado / nullif(total, 0) * 100), 2)) stored,
  saldo_nc             numeric(14,2) not null default 0,
  aprobado_por         text,
  aprobado_en          timestamptz,
  sheets_fila_origen   integer,
  creado_en            timestamptz not null default now(),
  actualizado_en       timestamptz not null default now(),
  unique (empresa_id, proveedor_id, tipo, punto_venta, numero)
);

create table pagos (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            text not null references empresas,
  proveedor_id          uuid references proveedores,
  fecha                 date not null,
  importe               numeric(14,2) not null check (importe > 0),
  medio                 metodo_pago not null,
  cuenta_origen         text,
  banco_destino         text,
  numero_cheque         text,
  fecha_acreditacion    date,
  descripcion           text,
  observaciones         text,
  cuenta_contable       text,
  sugerencia_origen     text,
  sugerencia_confianza  numeric(4,3),
  forma_carga_xubio     forma_carga_xubio not null default 'SALIDA_FONDOS',
  estado                estado_pago not null default 'CARGADO',
  comprobante_path      text,
  xubio_id              text,
  cargado_por           text not null,
  cargado_en            timestamptz not null default now(),
  contabilizado_por     text,
  contabilizado_en      timestamptz,
  mail_proveedor_en     timestamptz,
  sheets_fila_origen    integer,
  -- Marca de envío real a Xubio en curso. Evita dos órdenes de pago por doble clic o reintento
  -- después de un timeout (las OP no se pueden borrar por API).
  envio_xubio_en        timestamptz,
  -- Regla de oro: contabilizado exige id de Xubio, o carga manual confirmada (RALPHARMA).
  constraint contabilizado_con_respaldo check (
    estado <> 'CONTABILIZADO' or (xubio_id is not null and contabilizado_por is not null)
  )
);

create table pagos_facturas (
  pago_id     uuid references pagos on delete cascade,
  factura_id  uuid references facturas,
  importe     numeric(14,2) not null,
  primary key (pago_id, factura_id)
);

create table reglas_cuenta (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       text references empresas,
  proveedor_id     uuid references proveedores,
  patron           text,
  cuenta_contable  text not null,
  forma_carga      forma_carga_xubio,
  veces_usada      integer not null default 0,
  creada_por       text,
  creada_en        timestamptz not null default now()
);

create table movimientos_bancarios (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       text not null references empresas,
  cuenta_origen_id uuid references cuentas_origen,
  fecha            date not null,
  descripcion      text,
  importe          numeric(14,2) not null,
  saldo            numeric(14,2),
  referencia       text,
  pago_id          uuid references pagos,
  importado_en     timestamptz not null default now(),
  unique (cuenta_origen_id, fecha, importe, referencia)
);

create table xubio_log (
  id           bigserial primary key,
  empresa_id   text references empresas,
  entidad      text,
  entidad_id   uuid,
  en_seco      boolean not null,
  request      jsonb,
  response     jsonb,
  http_status  integer,
  usuario      text,
  creado_en    timestamptz not null default now()
);

create table auditoria (
  id          bigserial primary key,
  fecha       timestamptz not null default now(),
  usuario     text not null,
  rol         rol,
  accion      text not null,
  entidad     text not null,
  entidad_id  text,
  detalle     text,
  antes       jsonb,
  despues     jsonb
);

create index on facturas (empresa_id, estado);
create index on facturas (vencimiento);
create index on pagos (empresa_id, estado);
create index on auditoria (fecha desc);

-- Lo que el Cash Flow de Santi lee: pagos reales y facturas aprobadas por vencer.
-- security_invoker: la vista respeta el RLS de quien consulta. Sin esto corre como su dueño y
-- cualquiera con la anon key (que va en el navegador) podría leer todos los pagos.
create view export_cashflow with (security_invoker = true) as
select p.fecha, e.nombre as empresa, p.cuenta_contable, p.descripcion as concepto,
       pr.nombre as proveedor, null::numeric as ingreso, p.importe as egreso, p.medio::text as medio,
       p.cuenta_origen, 'REAL' as estado, coalesce(p.xubio_id, '') as referencia, p.numero_cheque,
       p.fecha_acreditacion
from pagos p
join empresas e on e.id = p.empresa_id
left join proveedores pr on pr.id = p.proveedor_id
union all
select f.vencimiento, e.nombre, f.cuenta_contable, 'Vence ' || f.tipo, pr.nombre, null,
       f.total - f.pagado, f.metodo_pago::text, null, 'PROYECTADO', f.id::text, null, null
from facturas f
join empresas e on e.id = f.empresa_id
left join proveedores pr on pr.id = f.proveedor_id
where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL');

-- Bucket privado para los comprobantes.
insert into storage.buckets (id, name, public) values ('comprobantes', 'comprobantes', false)
on conflict (id) do nothing;
