-- Vértice Tesorería · instalación completa (generado con npm run sql:unir, no editar a mano).
-- Pegar entero en Supabase → SQL Editor → Run, UNA sola vez en un proyecto nuevo.
-- Después: configurar_equipo.sql.

-- ======================================== 0001_esquema.sql
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


-- ======================================== 0002_seguridad.sql
-- Seguridad: quién entra, qué ve y por dónde escribe.
-- Regla: las personas LEEN las tablas con su sesión; ESCRIBEN solo a través de las funciones
-- de 0003_funciones.sql, que validan el rol y dejan auditoría.

-- Usuario actual a partir del email del token de Google.
create or replace function usuario_actual()
returns usuarios
language sql stable security definer set search_path = public as $$
  select * from usuarios where email = lower(coalesce(auth.jwt() ->> 'email', '')) and activo
$$;

create or replace function exigir_rol(variadic roles rol[])
returns usuarios
language plpgsql stable security definer set search_path = public as $$
declare u usuarios;
begin
  u := usuario_actual();
  if u.email is null then raise exception 'Cuenta no habilitada en el sistema'; end if;
  if not (u.rol = any(roles)) then raise exception 'Tu rol (%) no puede hacer esta acción', u.rol; end if;
  return u;
end $$;

-- Solo entra quien está en la tabla usuarios. Se evalúa al crear la cuenta en Supabase Auth.
create or replace function auth_solo_habilitados()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from usuarios where email = lower(new.email) and activo) then
    raise exception 'La cuenta % no está habilitada en Vértice Tesorería', new.email;
  end if;
  return new;
end $$;

drop trigger if exists trg_auth_solo_habilitados on auth.users;
create trigger trg_auth_solo_habilitados before insert on auth.users
for each row execute function auth_solo_habilitados();

-- RLS en todas las tablas.
alter table empresas enable row level security;
alter table usuarios enable row level security;
alter table proveedores enable row level security;
alter table cuentas_contables enable row level security;
alter table cuentas_origen enable row level security;
alter table facturas enable row level security;
alter table pagos enable row level security;
alter table pagos_facturas enable row level security;
alter table reglas_cuenta enable row level security;
alter table movimientos_bancarios enable row level security;
alter table xubio_log enable row level security;
alter table auditoria enable row level security;

-- Lectura para cualquier usuario habilitado. Sin políticas de escritura: solo vía funciones.
create policy leer_empresas on empresas for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_usuarios on usuarios for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_proveedores on proveedores for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_cuentas_contables on cuentas_contables for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_cuentas_origen on cuentas_origen for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_facturas on facturas for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_pagos on pagos for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_pagos_facturas on pagos_facturas for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_reglas on reglas_cuenta for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_movimientos on movimientos_bancarios for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_xubio_log on xubio_log for select to authenticated using ((usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION'));
create policy leer_auditoria on auditoria for select to authenticated using ((usuario_actual()).email is not null);

-- La auditoría es de solo inserción. El revoke cubre a los usuarios; el trigger cubre también al
-- rol de servicio (las funciones de Netlify) y a cualquiera con acceso SQL.
revoke update, delete, truncate on auditoria from authenticated, anon;

create or replace function auditoria_inmutable()
returns trigger language plpgsql as $$
begin
  raise exception 'La auditoría no se modifica ni se borra';
end $$;

create trigger trg_auditoria_inmutable before update or delete on auditoria
for each statement execute function auditoria_inmutable();

-- Comprobantes: subir y leer solo usuarios habilitados.
create policy comprobantes_leer on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (usuario_actual()).email is not null);
create policy comprobantes_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (usuario_actual()).email is not null);


-- ======================================== 0003_funciones.sql
-- Acciones de negocio. Cada una valida el rol, hace todo en una transacción y deja auditoría.
-- Es la misma lógica que src/data/fuenteDemo.ts, en SQL.

create or replace function registrar_auditoria(p_usuario usuarios, p_accion text, p_entidad text, p_id text, p_detalle text)
returns void language sql security definer set search_path = public as $$
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario.nombre, p_usuario.rol, p_accion, p_entidad, p_id, p_detalle)
$$;
-- Solo la llaman las otras funciones. Sin este revoke cualquiera podría escribir auditoría falsa por RPC.
revoke execute on function registrar_auditoria from public, anon, authenticated;

-- ---------------------------------------------------------------- Facturas

create or replace function aprobar_factura(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');   -- Dirección ve todo pero no modifica
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado <> 'PENDIENTE_APROBACION' then raise exception 'La factura no está pendiente de aprobación'; end if;
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  select * into e from empresas where id = f.empresa_id;
  update facturas set
    estado = 'PARA_PAGAR', cuenta_contable = p_cuenta, metodo_pago = p_metodo, dias_cheque = p_dias,
    aprobado_por = u.nombre, aprobado_en = now(), actualizado_en = now(),
    estado_xubio = case when e.erp = 'XUBIO' then (case when estado_xubio = 'SUBIDA' then 'SUBIDA' else 'PENDIENTE' end)::estado_xubio else 'PENDIENTE_RALPHARMA' end
  where id = p_id;
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text, 'Cuenta ' || p_cuenta || ' · ' || p_metodo);
end $$;

create or replace function rechazar_factura(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo del rechazo'; end if;
  update facturas set estado = 'RECHAZADA', motivo_validacion = p_motivo, actualizado_en = now()
  where id = p_id and estado in ('PENDIENTE_APROBACION', 'ERROR');
  if not found then raise exception 'La factura no se puede rechazar en su estado actual'; end if;
  perform registrar_auditoria(u, 'RECHAZO', 'FACTURA', p_id::text, p_motivo);
end $$;

create or replace function corregir_factura(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  update facturas set estado = 'PENDIENTE_APROBACION', validacion_ok = true, motivo_validacion = null, actualizado_en = now()
  where id = p_id and estado = 'ERROR';
  if not found then raise exception 'La factura no está en excepciones'; end if;
  perform registrar_auditoria(u, 'CORRECCION', 'FACTURA', p_id::text, 'Datos corregidos a mano; vuelve a pendientes');
end $$;

-- ---------------------------------------------------------------- Pagos

create or replace function registrar_pago(p_datos jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; e empresas; v_id uuid; v_importe numeric; v_restante numeric; v_fid uuid;
  f facturas; v_pendiente numeric; v_aplica numeric; v_completas integer := 0;
  v_prov uuid; v_medio metodo_pago; v_n_facturas integer;
begin
  u := exigir_rol('TESORERIA', 'ADMIN', 'ADMINISTRACION');
  select * into e from empresas where id = p_datos ->> 'empresa_id';
  if e.id is null then raise exception 'Empresa inexistente'; end if;
  v_importe := round((p_datos ->> 'importe')::numeric, 2);
  if v_importe is null or v_importe <= 0 then raise exception 'El importe debe ser mayor a cero'; end if;
  v_prov := nullif(p_datos ->> 'proveedor_id', '')::uuid;
  v_medio := (p_datos ->> 'medio')::metodo_pago;
  if v_medio in ('CHEQUE', 'ECHEQ') and (coalesce(p_datos ->> 'numero_cheque', '') = '' or coalesce(p_datos ->> 'fecha_acreditacion', '') = '') then
    raise exception 'Un pago con cheque necesita número y fecha de vencimiento del cheque';
  end if;
  v_n_facturas := jsonb_array_length(coalesce(p_datos -> 'factura_ids', '[]'::jsonb));

  -- Validar todas las facturas antes de escribir nada.
  v_pendiente := 0;
  for f in select * from facturas where id in (select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb))) loop
    if f.empresa_id <> e.id then raise exception 'La factura % es de otra empresa', f.numero; end if;
    if f.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then raise exception 'La factura % no está para pagar (estado %)', f.numero, f.estado; end if;
    if v_prov is not null and f.proveedor_id <> v_prov then raise exception 'La factura % es de otro proveedor', f.numero; end if;
    v_pendiente := v_pendiente + (f.total - f.pagado);
  end loop;
  if v_n_facturas > 0 and v_importe > v_pendiente + 1 then
    raise exception 'El pago (%) supera lo pendiente de las facturas vinculadas (%). Cargá el excedente como un pago aparte.', v_importe, v_pendiente;
  end if;

  insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque,
                     fecha_acreditacion, descripcion, observaciones, cuenta_contable, sugerencia_origen, sugerencia_confianza,
                     forma_carga_xubio, estado, comprobante_path, cargado_por)
  values (e.id, v_prov, (p_datos ->> 'fecha')::date, v_importe,
          v_medio, p_datos ->> 'cuenta_origen', p_datos ->> 'banco_destino', p_datos ->> 'numero_cheque',
          (p_datos ->> 'fecha_acreditacion')::date, p_datos ->> 'descripcion', p_datos ->> 'observaciones', p_datos ->> 'cuenta_contable',
          p_datos ->> 'sugerencia_origen', (p_datos ->> 'sugerencia_confianza')::numeric,
          coalesce((p_datos ->> 'forma_carga_xubio')::forma_carga_xubio, 'SALIDA_FONDOS'),
          (case when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
          p_datos ->> 'comprobante_path', u.nombre)
  returning id into v_id;

  -- Aplicar el pago a las facturas vinculadas, en el orden recibido, hasta agotar el importe.
  v_restante := v_importe;
  for v_fid in select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb)) loop
    select * into f from facturas where id = v_fid for update;
    if f.id is null then raise exception 'Factura % inexistente', v_fid; end if;
    v_pendiente := f.total - f.pagado;
    v_aplica := least(v_pendiente, v_restante);
    if v_aplica <= 0 then continue; end if;
    v_restante := v_restante - v_aplica;
    insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fid, v_aplica);
    update facturas set pagado = pagado + v_aplica,
                        estado = case when pagado + v_aplica >= total then 'PAGADA' else 'PAGADA_PARCIAL' end::estado_factura,
                        actualizado_en = now()
    where id = v_fid;
    if f.pagado + v_aplica >= f.total then v_completas := v_completas + 1; end if;
  end loop;

  perform registrar_auditoria(u, 'PAGO_CARGADO', 'PAGO', v_id::text,
    v_medio || ' · ' || coalesce(p_datos ->> 'cuenta_origen', '') || ' · ' || v_n_facturas || ' factura(s)');
  if v_completas > 0 then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sistema', 'ADMIN', 'MAIL_PENDIENTE', 'PAGO', v_id::text, 'Mail al proveedor pendiente de envío: ' || v_completas || ' factura(s) canceladas');
  end if;
  return v_id;
end $$;

-- La llama la función de Netlify `contabilizar` (rol de servicio) después de hablar con Xubio.
create or replace function marcar_pago_contabilizado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_xubio_id text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  if coalesce(p_xubio_id, '') = '' then raise exception 'Falta el id de Xubio'; end if;
  update pagos set estado = 'CONTABILIZADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma, xubio_id = p_xubio_id,
                   contabilizado_por = p_usuario, contabilizado_en = now()
  where id = p_id and estado in ('CARGADO', 'REVISADO');
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'CONTABILIZADO', 'PAGO', p_id::text, 'Xubio ' || p_xubio_id || ' · ' || p_forma || ' · ' || p_cuenta);
end $$;
revoke execute on function marcar_pago_contabilizado from public, anon, authenticated;

create or replace function marcar_pago_revisado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_detalle text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
begin
  update pagos set estado = 'REVISADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma
  where id = p_id and estado in ('CARGADO', 'REVISADO');
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'REVISADO_EN_SECO', 'PAGO', p_id::text, p_detalle);
end $$;
revoke execute on function marcar_pago_revisado from public, anon, authenticated;

create or replace function marcar_ralpharma(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update pagos set estado = 'CONTABILIZADO', xubio_id = 'RALPHARMA', contabilizado_por = u.nombre, contabilizado_en = now()
  where id = p_id and estado = 'PENDIENTE_RALPHARMA';
  if not found then raise exception 'El pago no está pendiente de Ralpharma'; end if;
  perform registrar_auditoria(u, 'CARGADO_RALPHARMA', 'PAGO', p_id::text, 'Carga manual confirmada en Ralpharma');
end $$;

-- ---------------------------------------------------------------- Ingesta desde el Apps Script

-- Recibe una factura ya leída por la IA del Apps Script. Crea o actualiza el proveedor por CUIT y
-- la factura por su clave natural. La llama la función de Netlify `ingesta-factura` (rol de servicio).
create or replace function ingresar_factura(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_prov uuid; v_id uuid; v_cuit text;
begin
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;
  insert into proveedores (cuit, nombre, email, categoria_vertice)
  values (v_cuit, coalesce(p ->> 'proveedor', 'Sin nombre'), nullif(p ->> 'email_proveedor', ''), p ->> 'categoria_vertice')
  on conflict (cuit) do update set nombre = excluded.nombre, categoria_vertice = coalesce(excluded.categoria_vertice, proveedores.categoria_vertice)
  returning id into v_prov;

  insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
                        neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen, drive_url,
                        estado, estado_xubio, xubio_id, validacion_ok, motivo_validacion, categoria_vertice, cuenta_contable,
                        codigo_producto, metodo_pago, pagado, sheets_fila_origen)
  values (p ->> 'empresa_id', v_prov, p ->> 'tipo', nullif(p ->> 'letra', ''), (p ->> 'punto_venta')::int, (p ->> 'numero')::int,
          (p ->> 'fecha')::date, nullif(p ->> 'vencimiento', '')::date, coalesce(p ->> 'moneda', 'ARS'), coalesce((p ->> 'cotizacion')::numeric, 1),
          (p ->> 'neto')::numeric, coalesce((p ->> 'iva')::numeric, 0), coalesce((p ->> 'exento')::numeric, 0), coalesce((p ->> 'percepciones')::numeric, 0),
          coalesce(p -> 'percepciones_json', '[]'::jsonb), (p ->> 'total')::numeric, nullif(p ->> 'cae', ''), nullif(p ->> 'cae_vencimiento', '')::date,
          coalesce(p ->> 'origen', 'GMAIL'), p ->> 'drive_url',
          coalesce((p ->> 'estado')::estado_factura, 'PENDIENTE_APROBACION'), coalesce((p ->> 'estado_xubio')::estado_xubio, 'PENDIENTE'), p ->> 'xubio_id',
          coalesce((p ->> 'validacion_ok')::boolean, false), p ->> 'motivo_validacion', p ->> 'categoria_vertice', p ->> 'cuenta_contable',
          p ->> 'codigo_producto', nullif(p ->> 'metodo_pago', '')::metodo_pago,
          -- Solo al migrar el histórico: lo ya pagado según la hoja, en pesos.
          least(coalesce((p ->> 'pagado')::numeric, 0), (p ->> 'total')::numeric),
          (p ->> 'sheets_fila_origen')::int)
  -- Reingesta: la hoja manda solo mientras el sistema nuevo no decidió nada (pendiente o error).
  -- Desde que la factura se aprueba, rechaza o paga acá, la hoja no la vuelve atrás. Lo pagado
  -- nunca se toma de la hoja en una reingesta: lo registran los pagos del sistema nuevo.
  on conflict (empresa_id, proveedor_id, tipo, punto_venta, numero) do update set
    estado = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.estado else facturas.estado end,
    validacion_ok = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.validacion_ok else facturas.validacion_ok end,
    motivo_validacion = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.motivo_validacion else facturas.motivo_validacion end,
    cuenta_contable = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then coalesce(excluded.cuenta_contable, facturas.cuenta_contable) else facturas.cuenta_contable end,
    metodo_pago = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then coalesce(excluded.metodo_pago, facturas.metodo_pago) else facturas.metodo_pago end,
    pagado = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.pagado else facturas.pagado end,
    estado_xubio = excluded.estado_xubio, xubio_id = coalesce(excluded.xubio_id, facturas.xubio_id),
    drive_url = coalesce(excluded.drive_url, facturas.drive_url), sheets_fila_origen = excluded.sheets_fila_origen, actualizado_en = now()
  returning id into v_id;

  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Apps Script', 'ADMIN', 'INGRESO', 'FACTURA', v_id::text, 'Recibida desde ' || coalesce(p ->> 'origen', 'GMAIL') || '; validación ' || case when coalesce((p ->> 'validacion_ok')::boolean, false) then 'OK' else 'con error' end);
  return v_id;
end $$;
revoke execute on function ingresar_factura from public, anon, authenticated;


-- ======================================== 0004_semilla.sql
-- Datos iniciales. Las empresas son reales; los usuarios son un EJEMPLO que hay que editar
-- con los mails reales antes de que alguien intente entrar. Las cuentas contables y de origen
-- se cargan después desde Xubio (función cargar_plan_cuentas, pendiente) o a mano.

insert into empresas (id, nombre, nombre_corto, cuit, erp) values
  ('beratung',     'Beratung S.A.',          'Beratung',      '00000000000', 'XUBIO'),
  ('india',        'INDIA ADV S.A.',         'India',         '00000000001', 'XUBIO'),
  ('controlb',     'Control B',              'Control B',     '00000000002', 'XUBIO'),
  ('ysd',          'YSD Pharma S.A.',        'YSD',           '00000000003', 'XUBIO'),
  ('vertice',      'Vértice BI S.A.',        'Vértice',       '00000000004', 'XUBIO'),
  ('robles',       'Droguería Robles S.A.',  'Drog. Robles',  '00000000005', 'RALPHARMA'),
  ('hrobles',      'Héctor Daniel Robles',   'H. Robles',     '00000000006', 'RALPHARMA'),
  ('farmacontrol', 'Farma Control S.A.',     'Farma Control', '00000000007', 'RALPHARMA')
on conflict (id) do nothing;
-- TODO: reemplazar los CUIT de arriba por los reales (están como marcador para no inventar).

-- Usuarios: EDITAR con los mails reales. Si el mail no está acá, Google no deja entrar.
insert into usuarios (email, nombre, rol) values
  ('tecnologia@verticebi.com', 'Tecnología', 'ADMIN'),
  ('tesoreria@verticebi.com',  'Vivi',       'TESORERIA'),
  ('administracion@verticebi.com', 'Guido',  'ADMINISTRACION')
on conflict (email) do nothing;

-- Plan de cuentas de resultado común (tomado del export de Xubio del 06/10/2026). Cada empresa
-- puede tener cuentas propias con empresa_id; estas valen para todas.
insert into cuentas_contables (empresa_id, nombre) values
  (null, 'COSTO DE INSUMOS'),
  (null, 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO'),
  (null, 'HONORARIOS PROFESIONALES'),
  (null, 'HONORARIOS EXTERNOS CONTABLES'),
  (null, 'HONORARIOS EXTERNOS LEGALES'),
  (null, 'HONORARIOS EXTERNOS TECNICOS'),
  (null, 'ALQUILER DE OFICINA'),
  (null, 'GASTOS VARIOS OFICINA'),
  (null, 'GASTOS GENERALES'),
  (null, 'GASTOS BANCARIOS'),
  (null, 'IMPUESTO DEB/CRED BANCARIO'),
  (null, 'IMPUESTOS Y TASAS'),
  (null, 'INSUMOS INFORMÁTICOS'),
  (null, 'SOFTWARE DE GESTION'),
  (null, 'SEGUROS'),
  (null, 'MOVILIDAD Y VIATICOS'),
  (null, 'PROMOCIÓN Y PUBLICIDAD'),
  (null, 'SERVICIO DE TERCEROS'),
  (null, 'GASTOS DE FLETES'),
  (null, 'SERVICIOS DE SEGURIDAD'),
  (null, 'INTERESES PAGADOS'),
  (null, 'SUELDOS Y JORNALES')
on conflict do nothing;


-- ======================================== 0005_entrada_facturas.sql
-- Flujo 1 · Entrada de facturas en el sistema nuevo.
-- Cada archivo que llega (adjunto de Gmail, carga manual, Drive) es un DOCUMENTO. Se guarda primero
-- y se lee con la IA después, en una cola: si la IA falla o se corta, el documento no se pierde y se
-- reintenta. De un documento leído sale una FACTURA (o se marca como duplicado o error).

create type estado_documento as enum ('PENDIENTE', 'LEYENDO', 'LEIDO', 'DUPLICADO', 'ERROR', 'DESCARTADO');

create table documentos (
  id                uuid primary key default gen_random_uuid(),
  origen            text not null check (origen in ('GMAIL', 'DRIVE', 'MANUAL')),
  gmail_message_id  text,
  nombre_archivo    text not null,
  mime_type         text not null,
  storage_path      text not null,                 -- bucket privado "facturas"
  tamano            integer,
  remitente         text,
  asunto            text,
  cargado_por       text,
  estado            estado_documento not null default 'PENDIENTE',
  intentos          integer not null default 0,
  tomado_en         timestamptz,                   -- cuándo lo agarró un lector (para liberar si se cortó)
  error             text,
  lectura           jsonb,                         -- lo que devolvió la IA, tal cual, para auditar
  factura_id        uuid references facturas,
  recibido_en       timestamptz not null default now(),
  leido_en          timestamptz,
  unique (gmail_message_id, nombre_archivo)        -- el mismo adjunto del mismo mail entra una sola vez
);
create index on documentos (estado, recibido_en);

alter table facturas add column documento_id uuid references documentos;
alter table facturas add column pdf_path text;              -- PDF en el bucket privado "facturas"
alter table facturas add column comprobante_vinculado text;  -- para notas de crédito y débito
alter table facturas add column categoria_ia text;           -- categoría genérica que sugiere la IA (no es la cuenta)
alter table facturas add column advertencia text;            -- avisos que no bloquean (redondeo, Factura M, CAE)

-- Memoria por proveedor y empresa: lo que se eligió al aprobar se usa en la próxima factura.
-- Reemplaza a la pestaña Catalogo_Proveedores_Por_Empresa del Apps Script.
create table proveedores_empresa (
  proveedor_id       uuid not null references proveedores,
  empresa_id         text not null references empresas,
  cuenta_contable    text,
  metodo_pago        metodo_pago,
  codigo_producto    text,
  categoria_vertice  text,
  veces              integer not null default 0,
  actualizado_por    text,
  actualizado_en     timestamptz not null default now(),
  primary key (proveedor_id, empresa_id)
);

alter table documentos enable row level security;
alter table proveedores_empresa enable row level security;
create policy leer_documentos on documentos for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_memoria on proveedores_empresa for select to authenticated using ((usuario_actual()).email is not null);

-- PDFs de facturas: bucket privado. Solo se leen con link firmado; escribe solo el servidor.
insert into storage.buckets (id, name, public) values ('facturas', 'facturas', false)
on conflict (id) do nothing;
create policy facturas_leer on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (usuario_actual()).email is not null);

-- ---------------------------------------------------------------- Cola (solo el servidor)

-- Registra un documento. Idempotente para Gmail: si el mismo adjunto ya llegó, devuelve el existente.
create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into documentos (origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por)
  values (p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por')
  on conflict (gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- Toma hasta p_max documentos para leer. skip locked: dos lectores en paralelo nunca agarran el mismo.
-- Un documento que quedó LEYENDO más de 5 minutos (el lector se cortó) vuelve a la cola.
create or replace function tomar_documentos(p_max integer)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- Toma un documento puntual (carga manual: se lee en el momento). Null si otro lector ya lo tiene.
create or replace function tomar_documento(p_id uuid)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id = p_id and estado = 'PENDIENTE'
  returning *
$$;

-- Falla de lectura: vuelve a la cola si quedan intentos y el error es transitorio; si no, queda en ERROR.
create or replace function documento_fallo(p_id uuid, p_error text, p_reintentar boolean)
returns void language sql security definer set search_path = public as $$
  update documentos set
    estado = case when p_reintentar and intentos < 3 then 'PENDIENTE' else 'ERROR' end::estado_documento,
    error = p_error, tomado_en = null
  where id = p_id
$$;

-- Guarda lo leído. Crea el proveedor si no existe, aplica la memoria del proveedor en esa empresa,
-- y crea la factura. Si ya existía (misma clave natural), el documento queda como DUPLICADO.
create or replace function guardar_factura_leida(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d documentos; v_prov uuid; v_id uuid; v_existente uuid; m proveedores_empresa; v_cuit text; v_estado estado_factura;
begin
  select * into d from documentos where id = p_doc for update;
  if d.id is null then raise exception 'Documento inexistente'; end if;
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;

  insert into proveedores (cuit, nombre) values (v_cuit, coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'))
  on conflict (cuit) do update set nombre = proveedores.nombre    -- el nombre ya cargado manda
  returning id into v_prov;

  select * into m from proveedores_empresa where proveedor_id = v_prov and empresa_id = p ->> 'empresa_id';
  v_estado := case when coalesce((p ->> 'validacion_ok')::boolean, false) then 'PENDIENTE_APROBACION' else 'ERROR' end;

  insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
                        neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen,
                        estado, estado_xubio, validacion_ok, motivo_validacion, advertencia, categoria_ia,
                        cuenta_contable, metodo_pago, codigo_producto, categoria_vertice, comprobante_vinculado,
                        documento_id, pdf_path)
  values (p ->> 'empresa_id', v_prov, p ->> 'tipo', nullif(p ->> 'letra', ''), (p ->> 'punto_venta')::int, (p ->> 'numero')::int,
          (p ->> 'fecha')::date, nullif(p ->> 'vencimiento', '')::date, coalesce(nullif(p ->> 'moneda', ''), 'ARS'),
          coalesce((p ->> 'cotizacion')::numeric, 1), (p ->> 'neto')::numeric, coalesce((p ->> 'iva')::numeric, 0),
          coalesce((p ->> 'exento')::numeric, 0), coalesce((p ->> 'percepciones')::numeric, 0),
          coalesce(p -> 'percepciones_json', '[]'::jsonb), (p ->> 'total')::numeric, nullif(p ->> 'cae', ''),
          nullif(p ->> 'cae_vencimiento', '')::date, d.origen,
          v_estado,
          (case when (select erp from empresas where id = p ->> 'empresa_id') = 'XUBIO' then 'PENDIENTE' else 'PENDIENTE_RALPHARMA' end)::estado_xubio,
          coalesce((p ->> 'validacion_ok')::boolean, false), nullif(p ->> 'motivo_validacion', ''), nullif(p ->> 'advertencia', ''),
          nullif(p ->> 'categoria_ia', ''),
          m.cuenta_contable, m.metodo_pago, m.codigo_producto, coalesce(m.categoria_vertice, p ->> 'categoria_vertice'),
          nullif(p ->> 'comprobante_vinculado', ''), d.id, d.storage_path)
  on conflict (empresa_id, proveedor_id, tipo, punto_venta, numero) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_existente from facturas
    where empresa_id = p ->> 'empresa_id' and proveedor_id = v_prov and tipo = p ->> 'tipo'
      and punto_venta = (p ->> 'punto_venta')::int and numero = (p ->> 'numero')::int;
    update documentos set estado = 'DUPLICADO', lectura = p, factura_id = v_existente, leido_en = now(), tomado_en = null,
                          error = 'Ya estaba cargada'
    where id = p_doc;
    return v_existente;
  end if;

  update documentos set estado = 'LEIDO', lectura = p, factura_id = v_id, leido_en = now(), tomado_en = null where id = p_doc;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Lector IA', 'ADMIN', 'INGRESO', 'FACTURA', v_id::text,
          'Leída desde ' || d.origen || ' (' || d.nombre_archivo || '); validación ' ||
          case when v_estado = 'ERROR' then 'con error: ' || coalesce(p ->> 'motivo_validacion', '') else 'OK' end ||
          case when m.cuenta_contable is not null then '; cuenta recordada: ' || m.cuenta_contable else '' end);
  return v_id;
end $$;

-- La lectura terminó pero no salió una factura (no es un comprobante, empresa desconocida...).
create or replace function documento_sin_factura(p_id uuid, p_motivo text, p_lectura jsonb)
returns void language sql security definer set search_path = public as $$
  update documentos set estado = 'ERROR', error = p_motivo, lectura = p_lectura, leido_en = now(), tomado_en = null
  where id = p_id
$$;

revoke execute on function registrar_documento, tomar_documentos, tomar_documento, documento_fallo, guardar_factura_leida, documento_sin_factura
  from public, anon, authenticated;

-- ---------------------------------------------------------------- Acciones de las personas

create or replace function reintentar_documento(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMINISTRACION', 'ADMIN');
  update documentos set estado = 'PENDIENTE', intentos = 0, error = null, tomado_en = null
  where id = p_id and estado in ('ERROR', 'DUPLICADO');
  if not found then raise exception 'Solo se reintentan documentos con error o duplicados'; end if;
  perform registrar_auditoria(u, 'REINTENTO_LECTURA', 'SISTEMA', p_id::text, 'Vuelve a la cola de lectura');
end $$;

create or replace function descartar_documento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  update documentos set estado = 'DESCARTADO', error = p_motivo, tomado_en = null
  where id = p_id and estado in ('PENDIENTE', 'ERROR', 'DUPLICADO');
  if not found then raise exception 'El documento no se puede descartar en su estado actual'; end if;
  perform registrar_auditoria(u, 'DESCARTE_DOCUMENTO', 'SISTEMA', p_id::text, p_motivo);
end $$;

-- Aprobar ahora también RECUERDA cuenta y método para ese proveedor en esa empresa.
create or replace function aprobar_factura(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');   -- Dirección ve todo pero no modifica
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado <> 'PENDIENTE_APROBACION' then raise exception 'La factura no está pendiente de aprobación'; end if;
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  select * into e from empresas where id = f.empresa_id;
  update facturas set
    estado = 'PARA_PAGAR', cuenta_contable = p_cuenta, metodo_pago = p_metodo, dias_cheque = p_dias,
    aprobado_por = u.nombre, aprobado_en = now(), actualizado_en = now(),
    estado_xubio = case when e.erp = 'XUBIO' then (case when estado_xubio = 'SUBIDA' then 'SUBIDA' else 'PENDIENTE' end)::estado_xubio else 'PENDIENTE_RALPHARMA' end
  where id = p_id;
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, veces, actualizado_por)
  values (f.proveedor_id, f.empresa_id, p_cuenta, p_metodo, 1, u.nombre)
  on conflict (proveedor_id, empresa_id) do update set
    cuenta_contable = excluded.cuenta_contable, metodo_pago = excluded.metodo_pago,
    veces = proveedores_empresa.veces + 1, actualizado_por = excluded.actualizado_por, actualizado_en = now();
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text, 'Cuenta ' || p_cuenta || ' · ' || p_metodo);
end $$;


-- ======================================== 0006_xubio_y_ralpharma.sql
-- Xubio automático para facturas (subida al aprobar) y sector Ralpharma para Guido.

alter table facturas add column xubio_error text;            -- por qué no se pudo subir (para corregir y reintentar)
alter table facturas add column xubio_envio_en timestamptz;  -- envío real en curso: evita subir dos veces
alter table facturas add column xubio_subida_en timestamptz;
alter table facturas add column ralpharma_por text;           -- quién confirmó la carga en Ralpharma
alter table facturas add column ralpharma_en timestamptz;

-- ---------------------------------------------------------------- Subida de facturas a Xubio (solo servidor)

-- Reserva la factura para un envío real. False si ya se está enviando o ya está subida.
create or replace function reservar_factura_xubio(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update facturas set xubio_envio_en = now()
  where id = p_id and estado_xubio in ('PENDIENTE', 'ERROR') and xubio_envio_en is null
    and estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA');
  return found;
end $$;

-- Resultado de la subida. p_estado: SUBIDA (con id) · ERROR (con motivo, se puede reintentar).
-- p_liberar: false cuando no se sabe si Xubio la creó (queda reservada para no duplicar).
create or replace function resultado_factura_xubio(p_id uuid, p_estado estado_xubio, p_xubio_id text, p_error text, p_usuario text, p_liberar boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_estado = 'SUBIDA' and coalesce(p_xubio_id, '') = '' then raise exception 'Una factura SUBIDA necesita el id de Xubio'; end if;
  update facturas set
    estado_xubio = p_estado,
    xubio_id = coalesce(nullif(p_xubio_id, ''), xubio_id),
    xubio_error = case when p_estado = 'SUBIDA' then null else p_error end,
    xubio_subida_en = case when p_estado = 'SUBIDA' then now() else xubio_subida_en end,
    xubio_envio_en = case when p_liberar or p_estado = 'SUBIDA' then null else xubio_envio_en end,
    actualizado_en = now()
  where id = p_id;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (coalesce(p_usuario, 'Sistema'), 'ADMIN',
          case when p_estado = 'SUBIDA' then 'XUBIO_FACTURA' else 'XUBIO_FACTURA_ERROR' end, 'FACTURA', p_id::text,
          case when p_estado = 'SUBIDA' then 'Subida a Xubio, id ' || p_xubio_id else p_error end);
end $$;

-- Facturas aprobadas de empresas con Xubio que todavía no se subieron (para el subidor programado).
create or replace function facturas_para_xubio(p_max integer)
returns setof facturas language sql security definer set search_path = public as $$
  select f.* from facturas f join empresas e on e.id = f.empresa_id
  where e.erp = 'XUBIO' and f.estado_xubio = 'PENDIENTE' and f.xubio_envio_en is null
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA')
  order by f.aprobado_en nulls last
  limit p_max
$$;

revoke execute on function reservar_factura_xubio, resultado_factura_xubio, facturas_para_xubio from public, anon, authenticated;

-- Quien aprueba puede liberar una factura trabada (envío sin confirmar) después de revisar en Xubio.
create or replace function liberar_factura_xubio(p_id uuid, p_xubio_id text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update facturas set
    xubio_envio_en = null,
    estado_xubio = case when coalesce(p_xubio_id, '') <> '' then 'SUBIDA' else 'ERROR' end::estado_xubio,
    xubio_id = coalesce(nullif(p_xubio_id, ''), xubio_id),
    xubio_error = case when coalesce(p_xubio_id, '') <> '' then null else 'Liberada a mano para reintentar' end
  where id = p_id and xubio_envio_en is not null;
  if not found then raise exception 'La factura no tiene un envío a Xubio trabado'; end if;
  perform registrar_auditoria(u, 'XUBIO_LIBERADA', 'FACTURA', p_id::text,
    case when coalesce(p_xubio_id, '') <> '' then 'Ya estaba en Xubio con id ' || p_xubio_id else 'Liberada para reintentar' end);
end $$;

-- ---------------------------------------------------------------- Ralpharma (sector de Guido)

-- Confirma que una factura aprobada de una empresa sin Xubio ya se cargó en Ralpharma.
create or replace function marcar_factura_ralpharma(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update facturas set estado_xubio = 'CARGADA_RALPHARMA', ralpharma_por = u.nombre, ralpharma_en = now(), actualizado_en = now()
  where id = p_id and estado_xubio = 'PENDIENTE_RALPHARMA' and estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA');
  if not found then raise exception 'La factura no está aprobada y pendiente de Ralpharma'; end if;
  perform registrar_auditoria(u, 'FACTURA_RALPHARMA', 'FACTURA', p_id::text, 'Carga de la factura confirmada en Ralpharma');
end $$;


-- ======================================== 0007_permisos_explicitos.sql
-- Permisos explícitos. El proyecto se crea con "Automatically expose new tables" DESMARCADO
-- (recomendación de Supabase): nada queda accesible por la API salvo lo que se habilita acá.
--   anon (sin sesión): nada.
--   authenticated (personas con Google): leer tablas (el RLS filtra) y ejecutar las acciones de negocio.
--   service_role (funciones de Netlify): todo.

grant usage on schema public to authenticated, service_role;

-- Lectura para personas. Cada tabla tiene RLS: solo ven datos los usuarios habilitados.
grant select on empresas, usuarios, proveedores, cuentas_contables, cuentas_origen, facturas, pagos,
  pagos_facturas, reglas_cuenta, movimientos_bancarios, xubio_log, auditoria, documentos,
  proveedores_empresa, export_cashflow
  to authenticated;

-- Las funciones de Netlify (rol de servicio) leen y escriben todo.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- usuario_actual() la evalúa el RLS con la sesión de la persona.
grant execute on function usuario_actual() to authenticated;

-- Acciones de negocio que la app llama con la sesión de la persona (cada una valida el rol adentro).
grant execute on function
  aprobar_factura(uuid, text, metodo_pago, integer),
  rechazar_factura(uuid, text),
  corregir_factura(uuid),
  registrar_pago(jsonb),
  marcar_ralpharma(uuid),
  reintentar_documento(uuid),
  descartar_documento(uuid, text),
  marcar_factura_ralpharma(uuid),
  liberar_factura_xubio(uuid, text)
  to authenticated;

-- Todo lo demás (ingesta, cola de lectura, subida a Xubio, auditoría) queda solo para el servidor.
revoke execute on function
  registrar_auditoria(usuarios, text, text, text, text),
  marcar_pago_contabilizado(uuid, text, forma_carga_xubio, text, text, rol),
  marcar_pago_revisado(uuid, text, forma_carga_xubio, text, text, rol),
  ingresar_factura(jsonb),
  registrar_documento(jsonb),
  tomar_documentos(integer),
  tomar_documento(uuid),
  documento_fallo(uuid, text, boolean),
  guardar_factura_leida(uuid, jsonb),
  documento_sin_factura(uuid, text, jsonb),
  reservar_factura_xubio(uuid),
  resultado_factura_xubio(uuid, estado_xubio, text, text, text, boolean),
  facturas_para_xubio(integer)
  from public, anon, authenticated;

