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

-- Los mails de usuarios van en minúscula: el login compara en minúscula y un "Md@..." no entraría nunca.
alter table usuarios add constraint usuarios_email_minuscula check (email = lower(email));


-- ======================================== 0008_espejo_hoja.sql
-- Espejo de la hoja real "Facturas automatizadas" (solo lectura) → base.
-- Mientras el Apps Script de producción siga siendo el sistema del equipo, el sistema nuevo copia
-- facturas, pagos y catálogos de la hoja cada 10 minutos (gas/PuenteHojas.gs → /api/espejo).
-- Regla: la hoja manda sobre cada factura o pago (gestion = 'HOJA') hasta que alguien lo aprueba,
-- paga o contabiliza en el sistema nuevo (gestion = 'SISTEMA'); desde ahí la copia no lo pisa.

-- ---------------------------------------------------------------- Columnas nuevas

alter table facturas add column gestion text not null default 'SISTEMA' check (gestion in ('HOJA', 'SISTEMA'));
alter table facturas add column hoja text;                                  -- Facturas · Facturas_Aprobadas
alter table facturas add column hoja_hash text;                             -- huella de la fila: si no cambió, no se reescribe
alter table facturas add column espejado_en timestamptz;
alter table facturas add column tipo_pago text;                             -- CUENTA_CORRIENTE · ANTICIPADO
alter table facturas add column fecha_pago date;
alter table facturas add column mail_enviado text;
alter table facturas add column comprobantes_pago jsonb not null default '[]';
alter table facturas add column nc_aplicadas jsonb not null default '[]';

alter table pagos add column hoja_id text unique;                           -- ID_PAGO de la hoja
alter table pagos add column gestion text not null default 'SISTEMA' check (gestion in ('HOJA', 'SISTEMA'));
alter table pagos add column hoja_hash text;
alter table pagos add column espejado_en timestamptz;
alter table pagos add column tipo_pago text;                                -- FACTURA · SIN_FACTURA
alter table pagos add column factura_asociada text;                         -- como la escribió la hoja
alter table pagos add column proveedor_destino text;
alter table pagos add column realizado_por text;
alter table pagos add column banco_origen text;
alter table pagos add column numero_cuenta text;
alter table pagos add column tipo_cheque text;                              -- ECHEQ · FISICO
alter table pagos add column estado_extraccion text;                        -- lectura del comprobante por la IA
alter table pagos add column estado_xubio_pago text;
alter table pagos add column xubio_detalle text;
alter table pagos add column detalle_contabilizacion text;
alter table pagos add column sugerencia_motivo text;
alter table pagos add column aviso_importe text;
alter table pagos add column cheque_cashflow text;
alter table pagos add column ralpharma_cargado text;
alter table pagos add column comprobante_url text;                          -- link de Drive del comprobante
-- Un pago copiado de la hoja puede tener importe 0 mientras la IA no leyó el comprobante.
alter table pagos drop constraint pagos_importe_check;
alter table pagos add constraint pagos_importe_check check (importe > 0 or (hoja_id is not null and importe = 0));

alter table cuentas_origen add column codigo text;
alter table cuentas_origen add column usos integer not null default 0;
alter table cuentas_origen add column ultimo_uso date;

alter table proveedores_empresa add column nombre_xubio text;               -- nombre exacto en el Xubio de esa empresa
alter table proveedores_empresa add column saltar_xubio boolean not null default false;

-- Productos de compra de Xubio (Catalogo_Productos): categoría de la factura → código del producto.
create table productos_xubio (
  nombre  text primary key,
  codigo  text not null
);

-- Última copia de cada pestaña, para mostrar en la app "copiado hace 3 min".
create table espejo_estado (
  hoja          text primary key,
  ultima_en     timestamptz not null default now(),
  filas         integer not null default 0,
  nuevas        integer not null default 0,
  actualizadas  integer not null default 0,
  sin_cambios   integer not null default 0,
  omitidas      integer not null default 0,
  detalle       jsonb not null default '[]'
);

-- ---------------------------------------------------------------- Quién gestiona cada fila

-- Cualquier cambio de estado o de datos contables hecho en el sistema nuevo pasa la fila a 'SISTEMA'.
-- La copia de la hoja corre con vertice.espejo = 'si' y no la marca.
create or replace function facturas_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then return new; end if;
  if new.estado is distinct from old.estado or new.pagado is distinct from old.pagado
     or new.cuenta_contable is distinct from old.cuenta_contable or new.metodo_pago is distinct from old.metodo_pago then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;
create trigger trg_facturas_gestion before update on facturas for each row execute function facturas_gestion_sistema();

create or replace function pagos_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then return new; end if;
  if new.estado is distinct from old.estado or new.importe is distinct from old.importe
     or new.cuenta_contable is distinct from old.cuenta_contable or new.cuenta_origen is distinct from old.cuenta_origen
     or new.forma_carga_xubio is distinct from old.forma_carga_xubio then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;
create trigger trg_pagos_gestion before update on pagos for each row execute function pagos_gestion_sistema();

-- Texto comparable (sin tildes, minúsculas, sin símbolos), para cruzar nombres de proveedores.
create or replace function texto_comparable(t text)
returns text language sql immutable as $$
  select regexp_replace(lower(translate(coalesce(t, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]', '', 'g')
$$;

-- ---------------------------------------------------------------- Copia de facturas

-- p_filas: facturas ya traducidas por netlify/functions/lib/espejo.ts (claves = columnas de facturas,
-- más cuit_proveedor y proveedor). Devuelve los contadores y las filas omitidas con su motivo.
create or replace function espejar_facturas(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; v_prov uuid; v_id uuid; v_gestion text; v_hash text;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      insert into proveedores (cuit, nombre, categoria_vertice)
      values (p ->> 'cuit_proveedor', coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'), nullif(p ->> 'categoria_vertice', ''))
      on conflict (cuit) do update set categoria_vertice = coalesce(proveedores.categoria_vertice, excluded.categoria_vertice)
      returning id into v_prov;
      p := p || jsonb_build_object('proveedor_id', v_prov);

      select id, gestion, hoja_hash into v_id, v_gestion, v_hash from facturas
      where empresa_id = p ->> 'empresa_id' and proveedor_id = v_prov and tipo = p ->> 'tipo'
        and punto_venta = (p ->> 'punto_venta')::int and numero = (p ->> 'numero')::int;

      if v_id is null then
        insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
          neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen, drive_url, estado, estado_xubio,
          xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice, cuenta_contable, codigo_producto, metodo_pago,
          pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado, comprobantes_pago, nc_aplicadas,
          hoja, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.tipo, r.letra, r.punto_venta, r.numero, r.fecha, r.vencimiento, r.moneda, r.cotizacion,
          r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total, r.cae, r.cae_vencimiento, r.origen, r.drive_url, r.estado, r.estado_xubio,
          r.xubio_id, r.xubio_error, r.validacion_ok, r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago,
          r.pagado, r.saldo_nc, r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas,
          r.hoja, r.sheets_fila_origen, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::facturas, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'FACTURA', v_id::text, 'Factura copiada de la hoja real (' || (p ->> 'hoja') || ', fila ' || coalesce(p ->> 'sheets_fila_origen', '?') || ')');
        n_nuevas := n_nuevas + 1;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        -- Sin cambios: solo se anota si la fila se movió (por ejemplo, pasó a Facturas_Aprobadas).
        update facturas set hoja = p ->> 'hoja', sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and (hoja is distinct from p ->> 'hoja' or sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int);
        n_igual := n_igual + 1;
      elsif v_gestion = 'HOJA' then
        update facturas set (letra, fecha, vencimiento, moneda, cotizacion, neto, iva, exento, percepciones, percepciones_json, total,
          cae, cae_vencimiento, drive_url, estado, estado_xubio, xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice,
          cuenta_contable, codigo_producto, metodo_pago, pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado,
          comprobantes_pago, nc_aplicadas, hoja, sheets_fila_origen, hoja_hash, espejado_en, actualizado_en) =
        (select r.letra, r.fecha, r.vencimiento, r.moneda, r.cotizacion, r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total,
          r.cae, r.cae_vencimiento, r.drive_url, r.estado, r.estado_xubio, coalesce(r.xubio_id, facturas.xubio_id), r.xubio_error, r.validacion_ok,
          r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago, r.pagado, r.saldo_nc,
          r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas, r.hoja,
          r.sheets_fila_origen, r.hoja_hash, now(), now()
         from jsonb_populate_record(null::facturas, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        -- La gestiona el sistema nuevo: de la hoja solo se toma dónde está la fila y el PDF.
        update facturas set drive_url = coalesce(drive_url, p ->> 'drive_url'), hoja = p ->> 'hoja',
          sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now()
        where id = v_id;
        n_igual := n_igual + 1;
      end if;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- ---------------------------------------------------------------- Copia de pagos

-- p_filas: pagos traducidos por lib/espejo.ts (claves = columnas de pagos, más facturas: [{punto_venta, numero}]).
-- La empresa que falta se toma de la primera factura vinculada; el proveedor, de la factura o por nombre.
create or replace function espejar_pagos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; ref jsonb; v_id uuid; v_gestion text; v_hash text; v_emp text; v_prov uuid;
  v_fids uuid[]; v_totales numeric[]; v_fid uuid; v_femp text; v_fprov uuid; v_ftotal numeric; v_suma numeric; v_imp numeric; i int;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      v_emp := nullif(p ->> 'empresa_id', '');
      v_prov := null; v_fids := '{}'; v_totales := '{}';
      for ref in select value from jsonb_array_elements(coalesce(p -> 'facturas', '[]'::jsonb)) loop
        v_fid := null;
        select f.id, f.empresa_id, f.proveedor_id, f.total into v_fid, v_femp, v_fprov, v_ftotal
        from facturas f join proveedores pr on pr.id = f.proveedor_id
        where f.punto_venta = (ref ->> 'punto_venta')::int and f.numero = (ref ->> 'numero')::int
          and (v_emp is null or f.empresa_id = v_emp)
        order by (texto_comparable(pr.nombre) = texto_comparable(p ->> 'proveedor_destino')) desc, f.fecha desc
        limit 1;
        if v_fid is not null and not (v_fid = any(v_fids)) then
          v_fids := v_fids || v_fid; v_totales := v_totales || v_ftotal;
          v_emp := coalesce(v_emp, v_femp); v_prov := coalesce(v_prov, v_fprov);
        end if;
      end loop;
      if v_emp is null then raise exception 'No se sabe de qué empresa es el pago (EMPRESA y REALIZADO_POR vacíos, sin factura vinculada)'; end if;
      if v_prov is null and coalesce(p ->> 'proveedor_destino', '') <> '' then
        select id into v_prov from proveedores where texto_comparable(nombre) = texto_comparable(p ->> 'proveedor_destino') limit 1;
      end if;
      p := p || jsonb_build_object('empresa_id', v_emp, 'proveedor_id', v_prov,
                                   'cargado_en', coalesce(p ->> 'cargado_en', now()::text), 'cargado_por', coalesce(p ->> 'cargado_por', 'Apps Script'));

      select id, gestion, hoja_hash into v_id, v_gestion, v_hash from pagos where hoja_id = p ->> 'hoja_id';

      if v_id is null then
        insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por, cargado_en,
          contabilizado_por, contabilizado_en, hoja_id, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por, r.cargado_en,
          r.contabilizado_por, r.contabilizado_en, r.hoja_id, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::pagos, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'PAGO', v_id::text, 'Pago ' || (p ->> 'hoja_id') || ' copiado de la hoja real');
        n_nuevas := n_nuevas + 1;
        v_gestion := 'HOJA'; v_hash := null;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int;
        n_igual := n_igual + 1;
        continue;
      elsif v_gestion = 'HOJA' then
        update pagos set (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por,
          contabilizado_por, contabilizado_en, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, espejado_en) =
        (select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por,
          r.contabilizado_por, r.contabilizado_en, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, now()
         from jsonb_populate_record(null::pagos, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now() where id = v_id;
        n_igual := n_igual + 1;
        continue;
      end if;

      -- Facturas que cancela, para mostrar el vínculo. Lo pagado de cada factura lo sigue diciendo la hoja
      -- (PORCENTAJE_PAGADO): estos importes no la modifican. Con varias facturas se reparte según el total.
      delete from pagos_facturas where pago_id = v_id;
      select coalesce(sum(t), 0) into v_suma from unnest(v_totales) t;
      for i in 1 .. coalesce(array_length(v_fids, 1), 0) loop
        v_imp := case when array_length(v_fids, 1) = 1 then least((p ->> 'importe')::numeric, v_totales[i])
                      when v_suma > 0 then round((p ->> 'importe')::numeric * v_totales[i] / v_suma, 2) else 0 end;
        insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fids[i], v_imp) on conflict do nothing;
      end loop;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'id', p -> 'hoja_id', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- ---------------------------------------------------------------- Copia de catálogos

-- p: { cuentas, origen, porEmpresa, emails, productos } ya traducidos por lib/espejo.ts.
create or replace function espejar_catalogos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_prov uuid; n jsonb := '{}';
begin
  perform set_config('vertice.espejo', 'si', true);

  insert into cuentas_contables (empresa_id, nombre, codigo, xubio_id, activa)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'codigo', x ->> 'xubio_id', true
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set codigo = excluded.codigo, xubio_id = excluded.xubio_id, activa = true;
  n := n || jsonb_build_object('cuentas', jsonb_array_length(coalesce(p -> 'cuentas', '[]'::jsonb)));

  insert into cuentas_origen (empresa_id, nombre, xubio_id, tipo_cuenta, codigo, usos, ultimo_uso)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'xubio_id', (x ->> 'tipo_cuenta')::int, x ->> 'codigo',
         coalesce((x ->> 'usos')::int, 0), (x ->> 'ultimo_uso')::date
  from jsonb_array_elements(coalesce(p -> 'origen', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set xubio_id = excluded.xubio_id, tipo_cuenta = excluded.tipo_cuenta,
    codigo = excluded.codigo, usos = excluded.usos, ultimo_uso = excluded.ultimo_uso;
  n := n || jsonb_build_object('origen', jsonb_array_length(coalesce(p -> 'origen', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'porEmpresa', '[]'::jsonb)) loop
    insert into proveedores (cuit, nombre) values (r ->> 'cuit', coalesce(nullif(r ->> 'nombre_xubio', ''), 'Sin nombre'))
    on conflict (cuit) do update set nombre = proveedores.nombre
    returning id into v_prov;
    insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, nombre_xubio, saltar_xubio, actualizado_por)
    values (v_prov, r ->> 'empresa_id', nullif(r ->> 'cuenta_contable', ''), nullif(r ->> 'nombre_xubio', ''),
            coalesce((r ->> 'saltar_xubio')::boolean, false), 'Copia de la hoja')
    on conflict (proveedor_id, empresa_id) do update set
      cuenta_contable = coalesce(excluded.cuenta_contable, proveedores_empresa.cuenta_contable),
      nombre_xubio = excluded.nombre_xubio, saltar_xubio = excluded.saltar_xubio;
  end loop;
  n := n || jsonb_build_object('porEmpresa', jsonb_array_length(coalesce(p -> 'porEmpresa', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'emails', '[]'::jsonb)) loop
    insert into proveedores (cuit, nombre, email) values (r ->> 'cuit', r ->> 'proveedor', r ->> 'email')
    on conflict (cuit) do update set email = excluded.email;
  end loop;
  n := n || jsonb_build_object('emails', jsonb_array_length(coalesce(p -> 'emails', '[]'::jsonb)));

  insert into productos_xubio (nombre, codigo)
  select x ->> 'nombre', x ->> 'codigo' from jsonb_array_elements(coalesce(p -> 'productos', '[]'::jsonb)) x
  on conflict (nombre) do update set codigo = excluded.codigo;
  n := n || jsonb_build_object('productos', jsonb_array_length(coalesce(p -> 'productos', '[]'::jsonb)));

  return n;
end $$;

-- ---------------------------------------------------------------- Permisos

alter table productos_xubio enable row level security;
alter table espejo_estado enable row level security;
create policy leer_productos_xubio on productos_xubio for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_espejo_estado on espejo_estado for select to authenticated using ((usuario_actual()).email is not null);
grant select on productos_xubio, espejo_estado to authenticated;
grant all on productos_xubio, espejo_estado to service_role;

-- La copia solo la hace el servidor (/api/espejo, con el token del puente).
revoke execute on function espejar_facturas(jsonb), espejar_pagos(jsonb), espejar_catalogos(jsonb) from public, anon, authenticated;
grant execute on function espejar_facturas(jsonb), espejar_pagos(jsonb), espejar_catalogos(jsonb) to service_role;


-- ======================================== 0009_editar_factura.sql
-- Edición a mano de lo que leyó la IA (como el formulario de la tarjeta en el dashboard de producción).
-- Se puede editar mientras la factura no tiene pagos ni está en Xubio. Al guardar se vuelve a validar
-- igual que validarFactura_ de producción: si queda bien sale de Excepciones; si no, el motivo queda a la vista.
-- La edición pasa la factura a gestion = 'SISTEMA': la copia de la hoja ya no la pisa.

create or replace function editar_factura(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; f facturas; n facturas; v_cuit text; v_prov uuid; v_tipo text; v_cae text;
  v_neto numeric; v_iva numeric; v_exento numeric; v_perc numeric; v_total numeric; v_dif numeric;
  v_motivo text; v_estado estado_factura; v_cambios text;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado not in ('PENDIENTE_APROBACION', 'ERROR', 'PARA_PAGAR') or f.pagado > 0 then
    raise exception 'Solo se editan facturas sin pagos (pendientes, en excepciones o para pagar)';
  end if;
  if f.estado_xubio = 'SUBIDA' then
    raise exception 'La factura ya está en Xubio: corregila en Xubio y volvé a traerla';
  end if;

  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'El CUIT del proveedor tiene que tener 11 dígitos'; end if;
  if not exists (select 1 from empresas where id = p ->> 'empresa_id') then raise exception 'Elegí la empresa que recibe la factura'; end if;
  if coalesce((p ->> 'numero')::int, 0) <= 0 then raise exception 'Falta el número del comprobante'; end if;
  if (p ->> 'fecha') is null then raise exception 'Falta la fecha de emisión'; end if;

  insert into proveedores (cuit, nombre) values (v_cuit, coalesce(nullif(trim(p ->> 'proveedor'), ''), 'Sin nombre'))
  on conflict (cuit) do update set nombre = coalesce(nullif(trim(excluded.nombre), ''), proveedores.nombre)
  returning id into v_prov;

  -- Validación de producción (validarFactura_): tipo, CAE de 14 dígitos y que cierre el total (±1 peso).
  v_tipo := nullif(trim(p ->> 'tipo'), '');
  v_cae := regexp_replace(coalesce(p ->> 'cae', ''), '\D', '', 'g');
  v_neto := coalesce((p ->> 'neto')::numeric, 0);
  v_iva := coalesce((p ->> 'iva')::numeric, 0);
  v_exento := coalesce((p ->> 'exento')::numeric, 0);
  select coalesce(sum((x ->> 'importe')::numeric), 0) into v_perc from jsonb_array_elements(coalesce(p -> 'percepciones_json', '[]'::jsonb)) x;
  v_total := coalesce((p ->> 'total')::numeric, 0);
  v_dif := round(v_total - (v_neto + v_iva + v_exento + v_perc), 2);
  v_motivo := case
    when v_tipo is null or v_tipo = 'Sin tipo' then 'Comprobante sin tipo válido'
    when v_total <= 0 then 'El total tiene que ser mayor a cero'
    when length(v_cae) <> 14 then 'El CAE tiene que tener 14 dígitos (tiene ' || length(v_cae) || ')'
    when abs(v_dif) >= 1 then 'Descuadre de $' || abs(v_dif) || ' entre el total y neto + IVA + exento + percepciones'
  end;
  v_estado := case
    when f.estado = 'PARA_PAGAR' then 'PARA_PAGAR'
    when v_motivo is null then 'PENDIENTE_APROBACION'
    else 'ERROR'
  end;

  begin
    update facturas set
      empresa_id = p ->> 'empresa_id', proveedor_id = v_prov, tipo = coalesce(v_tipo, 'Sin tipo'),
      letra = nullif(upper(left(trim(coalesce(p ->> 'letra', '')), 1)), ''),
      punto_venta = coalesce((p ->> 'punto_venta')::int, 0), numero = (p ->> 'numero')::int,
      fecha = (p ->> 'fecha')::date, vencimiento = coalesce(nullif(p ->> 'vencimiento', '')::date, (p ->> 'fecha')::date),
      moneda = coalesce(nullif(p ->> 'moneda', ''), 'ARS'), cotizacion = coalesce(nullif(p ->> 'cotizacion', '')::numeric, 1),
      neto = v_neto, iva = v_iva, exento = v_exento, percepciones = v_perc,
      percepciones_json = coalesce(p -> 'percepciones_json', '[]'::jsonb), total = v_total,
      cae = nullif(v_cae, ''), cae_vencimiento = nullif(p ->> 'cae_vencimiento', '')::date,
      categoria_vertice = coalesce(nullif(p ->> 'categoria_vertice', ''), categoria_vertice),
      cuenta_contable = coalesce(nullif(p ->> 'cuenta_contable', ''), cuenta_contable),
      codigo_producto = coalesce(nullif(p ->> 'codigo_producto', ''), codigo_producto),
      validacion_ok = v_motivo is null, motivo_validacion = v_motivo, estado = v_estado,
      gestion = 'SISTEMA', actualizado_en = now()
    where id = p_id
    returning * into n;
  exception when unique_violation then
    raise exception 'Ya hay otra factura de ese proveedor con el mismo tipo y número en esa empresa';
  end;

  -- Qué cambió, para la auditoría.
  select string_agg(o.key, ', ' order by o.key) into v_cambios
  from jsonb_each(to_jsonb(f)) o join jsonb_each(to_jsonb(n)) x using (key)
  where o.value is distinct from x.value and o.key not in ('actualizado_en', 'gestion', 'validacion_ok', 'motivo_validacion', 'estado', 'percepciones');
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle, antes, despues)
  values (u.nombre, u.rol, 'EDICION', 'FACTURA', p_id::text,
          'Datos corregidos a mano: ' || coalesce(v_cambios, 'sin cambios') || case when v_motivo is null then '' else ' · queda en excepciones: ' || v_motivo end,
          to_jsonb(f), to_jsonb(n));
  return jsonb_build_object('estado', v_estado, 'motivo', v_motivo, 'cambios', v_cambios);
end $$;

revoke execute on function editar_factura(uuid, jsonb) from public, anon;
grant execute on function editar_factura(uuid, jsonb) to authenticated, service_role;


-- ======================================== 0010_aislamiento_por_empresa.sql
-- Aislamiento por empresa: cada persona ve y opera solo las empresas que tiene asignadas.
--
-- Hasta 0009 cualquier usuario habilitado leía las 8 empresas; el permiso era solo por rol.
-- Desde acá:
--   usuarios.todas_empresas = true  → ve todas (como hasta ahora). Los usuarios que ya existían
--                                     quedan así, para que nada cambie al aplicar esta migración.
--   usuarios.todas_empresas = false → ve solo las empresas de usuarios_empresas.
-- Un usuario nuevo arranca en false y sin empresas: no ve nada hasta que se le asignen.
--
-- Lectura: lo filtra el RLS. Escritura: las acciones de negocio son SECURITY DEFINER (saltan el
-- RLS), así que un trigger controla la empresa cuando la acción la dispara una persona (rol
-- authenticated). El servidor (service_role: ingesta, espejo, Xubio) no pasa por ese control;
-- las funciones de Netlify que actúan en nombre de una persona lo controlan con usuario_ve_empresa().

-- ---------------------------------------------------------------- Asignación

alter table usuarios add column todas_empresas boolean not null default false;
update usuarios set todas_empresas = true;

create table usuarios_empresas (
  email       text not null references usuarios (email) on update cascade on delete cascade,
  empresa_id  text not null references empresas,
  primary key (email, empresa_id)
);
alter table usuarios_empresas enable row level security;

-- ¿El usuario p_email puede ver la empresa p_empresa? La usa el servidor (Netlify) y la de abajo.
create or replace function usuario_ve_empresa(p_email text, p_empresa text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select u.activo and (u.todas_empresas or exists (
      select 1 from usuarios_empresas ue where ue.email = u.email and ue.empresa_id = p_empresa))
    from usuarios u where u.email = lower(p_email)
  ), false)
$$;

-- ¿La persona de la sesión puede ver la empresa? La usan las políticas y los triggers.
create or replace function puede_ver_empresa(p_empresa text)
returns boolean
language sql stable security definer set search_path = public as $$
  select usuario_ve_empresa(coalesce(auth.jwt() ->> 'email', ''), p_empresa)
$$;

create or replace function ve_todas_las_empresas()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select todas_empresas and activo from usuarios
                   where email = lower(coalesce(auth.jwt() ->> 'email', ''))), false)
$$;

-- ---------------------------------------------------------------- Lectura (RLS)

drop policy leer_empresas on empresas;
create policy leer_empresas on empresas for select to authenticated using (puede_ver_empresa(id));

-- Cada uno ve su propio usuario; quien ve todas las empresas ve a todo el equipo.
drop policy leer_usuarios on usuarios;
create policy leer_usuarios on usuarios for select to authenticated
  using ((usuario_actual()).email is not null and (email = (usuario_actual()).email or ve_todas_las_empresas()));

create policy leer_usuarios_empresas on usuarios_empresas for select to authenticated
  using ((usuario_actual()).email is not null and (email = (usuario_actual()).email or ve_todas_las_empresas()));

-- Cuentas y reglas con empresa_id null son comunes a todas: las ve cualquier habilitado.
drop policy leer_cuentas_contables on cuentas_contables;
create policy leer_cuentas_contables on cuentas_contables for select to authenticated
  using ((usuario_actual()).email is not null and (empresa_id is null or puede_ver_empresa(empresa_id)));

drop policy leer_reglas on reglas_cuenta;
create policy leer_reglas on reglas_cuenta for select to authenticated
  using ((usuario_actual()).email is not null and (empresa_id is null or puede_ver_empresa(empresa_id)));

drop policy leer_cuentas_origen on cuentas_origen;
create policy leer_cuentas_origen on cuentas_origen for select to authenticated using (puede_ver_empresa(empresa_id));

drop policy leer_facturas on facturas;
create policy leer_facturas on facturas for select to authenticated using (puede_ver_empresa(empresa_id));

drop policy leer_pagos on pagos;
create policy leer_pagos on pagos for select to authenticated using (puede_ver_empresa(empresa_id));

-- Los subselects de abajo pasan por el RLS de facturas y pagos: solo encuentran lo visible.
drop policy leer_pagos_facturas on pagos_facturas;
create policy leer_pagos_facturas on pagos_facturas for select to authenticated
  using (exists (select 1 from pagos p where p.id = pago_id));

drop policy leer_movimientos on movimientos_bancarios;
create policy leer_movimientos on movimientos_bancarios for select to authenticated using (puede_ver_empresa(empresa_id));

drop policy leer_memoria on proveedores_empresa;
create policy leer_memoria on proveedores_empresa for select to authenticated using (puede_ver_empresa(empresa_id));

drop policy leer_xubio_log on xubio_log;
create policy leer_xubio_log on xubio_log for select to authenticated
  using ((usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION')
         and (case when empresa_id is null then ve_todas_las_empresas() else puede_ver_empresa(empresa_id) end));

-- Documentos: todavía no tienen empresa hasta que la IA los lee. Sin factura, solo quien ve todas.
drop policy leer_documentos on documentos;
create policy leer_documentos on documentos for select to authenticated
  using ((usuario_actual()).email is not null
         and (ve_todas_las_empresas() or exists (select 1 from facturas f where f.id = factura_id)));

-- Auditoría: lo de facturas y pagos visibles; el resto (sistema, documentos sin empresa), quien ve todas.
drop policy leer_auditoria on auditoria;
create policy leer_auditoria on auditoria for select to authenticated
  using ((usuario_actual()).email is not null and (
    ve_todas_las_empresas()
    or (entidad = 'FACTURA' and exists (select 1 from facturas f where f.id::text = entidad_id))
    or (entidad = 'PAGO' and exists (select 1 from pagos p where p.id::text = entidad_id))));

-- Archivos: el PDF de una factura y el comprobante de un pago, solo si se ve la factura o el pago.
drop policy facturas_leer on storage.objects;
create policy facturas_leer on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (usuario_actual()).email is not null
         and (ve_todas_las_empresas() or exists (select 1 from facturas f where f.pdf_path = name)));

drop policy comprobantes_leer on storage.objects;
create policy comprobantes_leer on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (usuario_actual()).email is not null
         and (ve_todas_las_empresas() or exists (select 1 from pagos p where p.comprobante_path = name)));

-- Proveedores y catálogos (productos_xubio, espejo_estado) quedan visibles para todo habilitado:
-- son el padrón común de CUIT y nombres, y Tesorería lo necesita para cargar pagos sin factura.

-- ---------------------------------------------------------------- Escritura (triggers)

-- Solo controla cuando la acción viene de una persona con sesión (rol authenticated). Dentro de una
-- función SECURITY DEFINER current_user cambia, pero el setting 'role' sigue siendo el de la sesión.
create or replace function aislar_por_empresa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('role', true) is distinct from 'authenticated' then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') and not puede_ver_empresa(old.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', old.empresa_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not puede_ver_empresa(new.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', new.empresa_id;
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_aislar_facturas before insert or update or delete on facturas
  for each row execute function aislar_por_empresa();
create trigger trg_aislar_pagos before insert or update or delete on pagos
  for each row execute function aislar_por_empresa();
create trigger trg_aislar_proveedores_empresa before insert or update or delete on proveedores_empresa
  for each row execute function aislar_por_empresa();

-- Documentos (reintentar, descartar): sin factura, solo quien ve todas; con factura, su empresa.
create or replace function aislar_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text;
begin
  if current_setting('role', true) is distinct from 'authenticated' then return coalesce(new, old); end if;
  if ve_todas_las_empresas() then return coalesce(new, old); end if;
  select empresa_id into v_empresa from facturas where id = coalesce(old.factura_id, new.factura_id);
  if v_empresa is null or not puede_ver_empresa(v_empresa) then
    raise exception 'No tenés acceso a este documento';
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_aislar_documentos before update or delete on documentos
  for each row execute function aislar_documento();

-- ---------------------------------------------------------------- Permisos

grant select on usuarios_empresas to authenticated;
grant all on usuarios_empresas to service_role;
grant execute on function puede_ver_empresa(text), ve_todas_las_empresas() to authenticated;
revoke execute on function usuario_ve_empresa(text, text) from public, anon, authenticated;
grant execute on function usuario_ve_empresa(text, text) to service_role;
revoke execute on function aislar_por_empresa(), aislar_documento() from public, anon, authenticated;


-- ======================================== 0011_nc_ya_pagada_anular.sql
-- Tres acciones que el Apps Script "facturas automatizadas" ya tiene y el sistema nuevo no tenía:
--   1. Aplicar una nota de crédito a una factura   (aplicarNotaCreditoAFactura)
--   2. Aprobar una factura que ya se pagó           (PagoAlAprobar.gs · aprobarFacturaYaPagada)
--   3. Anular un pago cargado por error             (anularPago)
-- Las tres validan rol y, por los triggers de 0010, la empresa de quien las usa.

-- Control de empresa ANTES de cualquier otro mensaje: quien no ve la empresa no se entera de nada
-- del registro (ni su estado ni su saldo). El servidor (rol de servicio) no pasa por este control.
create or replace function exigir_empresa(p_empresa text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if current_setting('role', true) = 'authenticated' and not puede_ver_empresa(p_empresa) then
    raise exception 'No tenés acceso a la empresa %', p_empresa;
  end if;
end $$;
revoke execute on function exigir_empresa(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 1. Notas de crédito

-- Saldo disponible de cada NC. Igual que el Apps Script (SALDO_NC = TOTAL al cargarla): una NC que
-- entra por el sistema nuevo arranca con todo su total disponible. La copia de la hoja trae su saldo.
create or replace function nc_saldo_inicial()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then return new; end if;
  if new.tipo ilike 'nota de cr%' and coalesce(new.saldo_nc, 0) = 0 then new.saldo_nc := new.total; end if;
  return new;
end $$;
create trigger trg_nc_saldo_inicial before insert on facturas for each row execute function nc_saldo_inicial();

update facturas set saldo_nc = total
where tipo ilike 'nota de cr%' and saldo_nc = 0 and gestion = 'SISTEMA' and estado in ('PENDIENTE_APROBACION', 'PARA_PAGAR');

create table notas_credito_aplicadas (
  id           uuid primary key default gen_random_uuid(),
  nc_id        uuid not null references facturas,
  factura_id   uuid not null references facturas,
  importe      numeric(14,2) not null check (importe > 0),
  aplicada_por text not null,
  aplicada_en  timestamptz not null default now()
);
create index on notas_credito_aplicadas (factura_id);
create index on notas_credito_aplicadas (nc_id);
alter table notas_credito_aplicadas enable row level security;
-- Se ve si se ve la factura (el subselect pasa por el RLS de facturas, que filtra por empresa).
create policy leer_nc_aplicadas on notas_credito_aplicadas for select to authenticated
  using (exists (select 1 from facturas f where f.id = factura_id));

-- Reglas del Apps Script: mismo proveedor (CUIT) y misma empresa; la NC tiene que estar aprobada.
-- Se aplica hasta lo que quede de saldo en la NC y de pendiente en la factura.
create or replace function aplicar_nota_credito(p_nc uuid, p_factura uuid, p_importe numeric)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; nc facturas; f facturas; v_importe numeric;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into nc from facturas where id = p_nc for update;
  select * into f from facturas where id = p_factura for update;
  if nc.id is null or f.id is null then raise exception 'Nota de crédito o factura inexistente'; end if;
  perform exigir_empresa(f.empresa_id);
  perform exigir_empresa(nc.empresa_id);
  if nc.tipo not ilike 'nota de cr%' then raise exception 'El comprobante % no es una nota de crédito', nc.numero; end if;
  if f.tipo ilike 'nota de cr%' then raise exception 'Una nota de crédito se aplica a una factura, no a otra nota de crédito'; end if;
  if nc.empresa_id <> f.empresa_id then raise exception 'La nota de crédito es de otra empresa'; end if;
  if nc.proveedor_id <> f.proveedor_id then raise exception 'La nota de crédito es de otro proveedor'; end if;
  if nc.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then raise exception 'La nota de crédito tiene que estar aprobada (estado %)', nc.estado; end if;
  if f.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then raise exception 'La factura % no está para pagar (estado %)', f.numero, f.estado; end if;
  v_importe := round(p_importe, 2);
  if v_importe is null or v_importe <= 0 then raise exception 'El importe a aplicar debe ser mayor a cero'; end if;
  if v_importe > nc.saldo_nc then raise exception 'La nota de crédito tiene saldo % y se quiere aplicar %', nc.saldo_nc, v_importe; end if;
  if v_importe > f.total - f.pagado then raise exception 'La factura tiene pendiente % y se quiere aplicar %', f.total - f.pagado, v_importe; end if;

  insert into notas_credito_aplicadas (nc_id, factura_id, importe, aplicada_por) values (nc.id, f.id, v_importe, u.nombre);
  update facturas set pagado = pagado + v_importe,
    estado = case when pagado + v_importe >= total then 'PAGADA' else 'PAGADA_PARCIAL' end::estado_factura,
    actualizado_en = now()
  where id = f.id;
  update facturas set saldo_nc = saldo_nc - v_importe,
    estado = case when saldo_nc - v_importe <= 0 then 'PAGADA' else estado end,
    actualizado_en = now()
  where id = nc.id;
  perform registrar_auditoria(u, 'NC_APLICADA', 'FACTURA', f.id::text,
    'NC ' || nc.punto_venta || '-' || nc.numero || ' aplicada por $ ' || v_importe);
  perform registrar_auditoria(u, 'NC_APLICADA', 'FACTURA', nc.id::text,
    'Aplicada a la factura ' || f.punto_venta || '-' || f.numero || ' por $ ' || v_importe);
end $$;

-- ---------------------------------------------------------------- 2. Aprobar una factura ya pagada

-- Cuando Administración aprueba una factura que ya se pagó y no sabe el banco, queda en Para pagar
-- marcada así: Tesorería solo adjunta el comprobante (como YA_PAGADA_SEGUN_ADMIN en el Apps Script).
alter table facturas add column ya_pagada_segun_admin text;

-- p_pago: { ya_en_xubio, cuenta_origen, fecha, numero_cheque, fecha_acreditacion, observaciones }
--  · ya_en_xubio = true      → la factura queda PAGADA y el pago ya CONTABILIZADO (no se envía nada a Xubio).
--  · con cuenta de origen o CAJA → la factura queda PAGADA y el pago va a Contabilización.
--  · sin banco                → la factura queda Para pagar, marcada ya pagada; no se crea pago.
create or replace function aprobar_factura_ya_pagada(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_pago jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas; v_pago uuid; v_origen text; v_ya boolean; v_fecha date; v_saldo numeric;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  perform exigir_empresa((select empresa_id from facturas where id = p_id));
  v_ya := coalesce((p_pago ->> 'ya_en_xubio')::boolean, false);
  v_origen := nullif(trim(coalesce(p_pago ->> 'cuenta_origen', '')), '');
  v_fecha := coalesce(nullif(p_pago ->> 'fecha', '')::date, current_date);
  if p_metodo in ('CHEQUE', 'ECHEQ') and (v_ya or v_origen is not null)
     and (coalesce(p_pago ->> 'numero_cheque', '') = '' or coalesce(p_pago ->> 'fecha_acreditacion', '') = '') then
    raise exception 'Un pago con cheque necesita número y fecha de vencimiento del cheque';
  end if;

  -- Misma aprobación de siempre: cuenta, método, memoria del proveedor y cola de Xubio.
  perform aprobar_factura(p_id, p_cuenta, p_metodo, null);
  select * into f from facturas where id = p_id for update;
  select * into e from empresas where id = f.empresa_id;
  v_saldo := f.total - f.pagado;

  if not v_ya and v_origen is null and p_metodo <> 'CAJA' then
    update facturas set ya_pagada_segun_admin = 'Ya pagada según ' || u.nombre || ' (' || p_metodo || '), falta el comprobante',
      actualizado_en = now() where id = p_id;
    perform registrar_auditoria(u, 'APROBADA_YA_PAGADA', 'FACTURA', p_id::text, 'Sin banco: queda en Para pagar para que Tesorería adjunte el comprobante');
    return 'PARA_PAGAR';
  end if;

  insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, numero_cheque, fecha_acreditacion,
    descripcion, observaciones, cuenta_contable, forma_carga_xubio, estado, cargado_por,
    xubio_id, contabilizado_por, contabilizado_en)
  values (f.empresa_id, f.proveedor_id, v_fecha, v_saldo, p_metodo,
    coalesce(v_origen, case when p_metodo = 'CAJA' then 'Caja' end),
    nullif(p_pago ->> 'numero_cheque', ''), nullif(p_pago ->> 'fecha_acreditacion', '')::date,
    'Factura ' || f.punto_venta || '-' || f.numero || ' pagada antes de aprobar', nullif(p_pago ->> 'observaciones', ''),
    p_cuenta, 'ORDEN_PAGO',
    (case when v_ya then 'CONTABILIZADO' when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
    u.nombre,
    case when v_ya then 'CARGADO_A_MANO' end, case when v_ya then u.nombre end, case when v_ya then now() end)
  returning id into v_pago;
  insert into pagos_facturas (pago_id, factura_id, importe) values (v_pago, f.id, v_saldo);
  update facturas set pagado = total, estado = 'PAGADA', actualizado_en = now() where id = p_id;
  perform registrar_auditoria(u, 'APROBADA_YA_PAGADA', 'PAGO', v_pago::text,
    case when v_ya then 'Ya cargado a mano en Xubio: queda contabilizado sin enviar nada'
         else 'Pago creado al aprobar: va a Contabilización' end);
  return case when v_ya then 'CONTABILIZADO' else 'PARA_CONTABILIZAR' end;
end $$;

-- Al registrar el pago de una factura marcada ya pagada, la marca se limpia.
create or replace function limpiar_ya_pagada()
returns trigger language plpgsql as $$
begin
  if new.estado = 'PAGADA' and new.ya_pagada_segun_admin is not null then new.ya_pagada_segun_admin := null; end if;
  return new;
end $$;
create trigger trg_limpiar_ya_pagada before update on facturas for each row execute function limpiar_ya_pagada();

-- ---------------------------------------------------------------- 3. Anular un pago

-- Nuevo estado. Se agrega al final del enum; las vistas lo comparan como texto (un valor nuevo de
-- enum no se puede usar en la misma transacción que lo crea, y el instalador corre todo junto).
alter type estado_pago add value if not exists 'ANULADO';
alter table pagos add column anulado_por text;
alter table pagos add column anulado_en timestamptz;
alter table pagos add column motivo_anulacion text;

-- Solo pagos que todavía no están en Xubio ni en Ralpharma (una OP en Xubio se anula en Xubio).
-- Devuelve a cada factura lo que este pago le había aplicado.
create or replace function anular_pago(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; r record;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo de la anulación'; end if;
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.gestion = 'HOJA' then raise exception 'Este pago viene de la hoja del Apps Script: se anula ahí'; end if;
  if p.estado::text not in ('CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA') then
    raise exception 'Un pago % no se anula acá: si ya está en Xubio, anulalo primero en Xubio', p.estado;
  end if;
  if p.envio_xubio_en is not null then raise exception 'El pago se está enviando a Xubio: esperá el resultado'; end if;

  for r in select factura_id, importe from pagos_facturas where pago_id = p_id loop
    update facturas set pagado = greatest(0, pagado - r.importe),
      estado = case when pagado - r.importe <= 0 then 'PARA_PAGAR' else 'PAGADA_PARCIAL' end::estado_factura,
      actualizado_en = now()
    where id = r.factura_id;
  end loop;
  delete from pagos_facturas where pago_id = p_id;
  update pagos set estado = 'ANULADO', anulado_por = u.nombre, anulado_en = now(), motivo_anulacion = trim(p_motivo)
  where id = p_id;
  perform registrar_auditoria(u, 'PAGO_ANULADO', 'PAGO', p_id::text, trim(p_motivo));
end $$;

-- El flujo de fondos no cuenta pagos anulados.
create or replace view export_cashflow with (security_invoker = true) as
select p.fecha, e.nombre as empresa, p.cuenta_contable, p.descripcion as concepto,
       pr.nombre as proveedor, null::numeric as ingreso, p.importe as egreso, p.medio::text as medio,
       p.cuenta_origen, 'REAL' as estado, coalesce(p.xubio_id, '') as referencia, p.numero_cheque,
       p.fecha_acreditacion
from pagos p
join empresas e on e.id = p.empresa_id
left join proveedores pr on pr.id = p.proveedor_id
where p.estado::text <> 'ANULADO'
union all
select f.vencimiento, e.nombre, f.cuenta_contable, 'Vence ' || f.tipo, pr.nombre, null,
       f.total - f.pagado, f.metodo_pago::text, null, 'PROYECTADO', f.id::text, null, null
from facturas f
join empresas e on e.id = f.empresa_id
left join proveedores pr on pr.id = f.proveedor_id
where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.tipo not ilike 'nota de cr%';

-- ---------------------------------------------------------------- Permisos

grant select on notas_credito_aplicadas to authenticated;
grant all on notas_credito_aplicadas to service_role;
grant execute on function
  aplicar_nota_credito(uuid, uuid, numeric),
  aprobar_factura_ya_pagada(uuid, text, metodo_pago, jsonb),
  anular_pago(uuid, text)
  to authenticated, service_role;


-- ======================================== 0012_mails_cheques_flujo.sql
-- Tandas 2 y 3 de lo que se trae del Apps Script "facturas automatizadas":
--   · Mails a proveedores (MailsProveedores.gs): el sistema arma el mail y Tesorería lo abre en su Gmail.
--   · Cheques al Cash Flow (CashFlowCheques.gs) y Flujo de caja (FlujoCaja.gs): el Apps Script sigue
--     escribiendo en las planillas (gas/ChequesCashFlow.gs y gas/FlujoCaja.gs), pero lee los datos de acá.

-- ---------------------------------------------------------------- Mails a proveedores

-- Guarda (o cambia) el mail de un proveedor. La pantalla lo llama cuando Tesorería escribe uno a mano.
create or replace function guardar_email_proveedor(p_proveedor uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  v := lower(trim(coalesce(p_email, '')));
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Mail inválido: %', p_email; end if;
  update proveedores set email = v where id = p_proveedor;
  if not found then raise exception 'Proveedor inexistente'; end if;
  perform registrar_auditoria(u, 'MAIL_PROVEEDOR_GUARDADO', 'SISTEMA', p_proveedor::text, v);
end $$;

-- Al tocar "Abrir en Gmail": queda registrado que el mail se preparó (no que se envió), en las facturas
-- y en sus pagos. Mismo texto que el Apps Script: "Preparado en Gmail dd/mm/aaaa hh:mm".
create or replace function marcar_mail_preparado(p_facturas uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; v_texto text; n integer := 0;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  v_texto := 'Preparado en Gmail ' || to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI');
  for f in select * from facturas where id = any(p_facturas) for update loop
    perform exigir_empresa(f.empresa_id);
    update facturas set mail_enviado = v_texto where id = f.id;
    update pagos set mail_proveedor_en = now()
    where id in (select pago_id from pagos_facturas where factura_id = f.id) and estado::text <> 'ANULADO';
    n := n + 1;
  end loop;
  if n > 0 then
    perform registrar_auditoria(u, 'MAIL_PREPARADO', 'SISTEMA', null, n || ' factura(s) · ' || v_texto);
  end if;
  return n;
end $$;

-- ---------------------------------------------------------------- Cheques → CHEQUES EMITIDOS

-- Pagos con cheque que el Apps Script tiene que pasar al Cash Flow. Mismas condiciones que
-- registrarChequesEnCashFlow_: número, importe, no anulado, contabilizado o con fecha de cobro, cargado
-- desde la fecha de activación y todavía sin marca. Solo los pagos del sistema nuevo: los que vienen de
-- la hoja (gestion HOJA) ya los pasa el Apps Script de producción.
create or replace function cheques_para_cashflow(p_desde timestamptz)
returns table (pago_id uuid, empresa_id text, numero text, banco text, tipo_cheque text, medio text, proveedor text,
               importe numeric, emision timestamptz, deposito date, texto text)
language sql stable security definer set search_path = public as $$
  select p.id, p.empresa_id, trim(p.numero_cheque), coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
         coalesce(p.tipo_cheque, ''), p.medio::text, coalesce(pr.nombre, p.proveedor_destino, ''),
         p.importe, p.cargado_en, coalesce(p.fecha_acreditacion, p.fecha),
         coalesce(p.descripcion, '') || ' ' || coalesce(p.observaciones, '')
  from pagos p left join proveedores pr on pr.id = p.proveedor_id
  where coalesce(trim(p.numero_cheque), '') <> '' and p.importe > 0 and p.cheque_cashflow is null
    and p.estado::text <> 'ANULADO' and p.gestion = 'SISTEMA'
    and (p.estado = 'CONTABILIZADO' or p.fecha_acreditacion is not null)
    and p.cargado_en >= p_desde
  order by p.cargado_en, p.id
$$;

-- Resultado que devuelve el Apps Script: AGREGADO …, YA ESTABA EN EL CASH FLOW o ERROR: …
create or replace function marcar_cheques_cashflow(p jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    if coalesce(r ->> 'estado', '') = '' then continue; end if;
    update pagos set cheque_cashflow = left(r ->> 'estado', 300)
    where id = (r ->> 'pago_id')::uuid and cheque_cashflow is null;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- Flujo de caja

-- Pagos y facturas con los mismos encabezados que las pestañas Pagos y Facturas de la hoja, para que
-- gas/FlujoCaja.gs aplique sin cambios las reglas acordadas con el Controller.
create or replace function flujo_datos()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pagos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ID_PAGO', coalesce(p.hoja_id, p.id::text),
        'FECHA_PAGO', p.fecha,
        'IMPORTE', p.importe,
        'EMPRESA', e.nombre,
        'REALIZADO_POR', coalesce(p.realizado_por, p.cargado_por, ''),
        'BANCO_ORIGEN', coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
        'CUENTA_ORIGEN', coalesce(p.cuenta_origen, ''),
        'BANCO_DESTINO', coalesce(p.banco_destino, ''),
        'PROVEEDOR_DESTINO', coalesce(pr.nombre, p.proveedor_destino, ''),
        'CUIT_DESTINO', coalesce(pr.cuit, ''),
        'CUENTA_CONTABLE', coalesce(p.cuenta_contable, ''),
        'DESCRIPCION_PAGO', coalesce(p.descripcion, ''),
        'OBSERVACIONES_TESORERIA', coalesce(p.observaciones, ''),
        'NUMERO_CHEQUE', coalesce(p.numero_cheque, ''),
        'TIPO_CHEQUE', coalesce(p.tipo_cheque, case p.medio when 'ECHEQ' then 'ECHEQ' when 'CHEQUE' then 'FISICO' else '' end),
        'FECHA_VTO_CHEQUE', p.fecha_acreditacion,
        'FACTURA_ASOCIADA', coalesce(p.factura_asociada, (
          select string_agg(f.numero::text, ', ') from pagos_facturas pf join facturas f on f.id = pf.factura_id where pf.pago_id = p.id), ''),
        -- ESPERA_FC = pago a un proveedor sin factura todavía (anticipo): descuenta de su proyección.
        'ESTADO_CONTABLE', case
          when p.estado::text = 'ANULADO' then 'ANULADO'
          when p.estado::text in ('CONTABILIZADO', 'CONCILIADO') then 'CONTABILIZADA'
          when p.proveedor_id is not null and p.forma_carga_xubio = 'ORDEN_PAGO'
               and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
               and coalesce(p.factura_asociada, '') = '' then 'ESPERA_FC'
          else 'PENDIENTE' end
      ) order by p.fecha, p.id)
      from pagos p join empresas e on e.id = p.empresa_id left join proveedores pr on pr.id = p.proveedor_id
    ), '[]'::jsonb),
    'facturas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'NUMERO', f.numero,
        'TIPO', f.tipo,
        'RECEPTOR', e.nombre,
        'PROVEEDOR', pr.nombre,
        'CUIT_PROVEEDOR', pr.cuit,
        'FECHA', f.fecha,
        'VENCIMIENTODELPAGO', f.vencimiento,
        'TOTAL', f.total,
        'PORCENTAJE_PAGADO', f.pagado_pct,
        'ESTADO_APROBACION', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA') then 'APROBADA' else f.estado::text end,
        'ESTADO_PAGO', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') then 'PARA_PAGAR' else f.estado::text end,
        'YA_PAGADA_SEGUN_ADMIN', coalesce(f.ya_pagada_segun_admin, ''),
        'METODO_PAGO', case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null
                            then 'CHEQUE ' || f.dias_cheque || ' DIAS' else coalesce(f.metodo_pago::text, '') end,
        'CATEGORIA_CONTABLE', coalesce(f.cuenta_contable, f.categoria_ia, ''),
        'OBSERVACIONES', coalesce(f.advertencia, ''),
        'PRODUCTOSERVICIOPERCEPCION', coalesce(f.codigo_producto, '')
      ) order by f.vencimiento nulls last, f.id)
      from facturas f join empresas e on e.id = f.empresa_id join proveedores pr on pr.id = f.proveedor_id
      where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL')
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- Permisos

grant execute on function guardar_email_proveedor(uuid, text), marcar_mail_preparado(uuid[]) to authenticated, service_role;
revoke execute on function cheques_para_cashflow(timestamptz), marcar_cheques_cashflow(jsonb), flujo_datos() from public, anon, authenticated;
grant execute on function cheques_para_cashflow(timestamptz), marcar_cheques_cashflow(jsonb), flujo_datos() to service_role;


-- ======================================== 0013_separacion_servidor.sql
-- Tanda A1 · Separación entre empresas en el servidor y control que falla cerrado.
--
--   1. El control de escritura por empresa (0010 y 0011) solo actuaba si el rol de la conexión se
--      llamaba exactamente 'authenticated': con cualquier otro valor dejaba pasar todo sin avisar.
--      Desde acá es al revés: se saltea solo para el servidor conocido y controla a todos los demás.
--   2. Un documento subido por una persona guarda para qué empresas se puede cargar. La factura que
--      salga de leerlo tiene que ser de una de esas; si no, no se guarda.
--   3. Funciones para que el servidor limite lo que hace en nombre de una persona a sus empresas.

-- ---------------------------------------------------------------- 1. Control que falla cerrado

-- ¿La conexión es del servidor? Verdadero solo en dos casos:
--   · rol 'service_role': las funciones de Netlify (ingesta, copia de la hoja, Xubio), que entran por la
--     API con la clave de servicio;
--   · postgres o supabase_admin, entrando directo (sin "set role") o con ese rol puesto a mano: el editor
--     SQL de Supabase y las migraciones. Quien puede tomar esos roles ya administra la base.
-- Todo lo demás (authenticated, anon, un rol nuevo, un nombre que cambie) se trata como una persona y
-- pasa por el control de empresa. El setting 'role' y session_user no cambian dentro de una función
-- SECURITY DEFINER, así que dicen quién abrió la conexión y no quién es el dueño de la función.
create or replace function es_servidor()
returns boolean language sql stable set search_path = public as $$
  select case coalesce(current_setting('role', true), '')
    when 'service_role' then true
    when 'postgres' then true
    when 'supabase_admin' then true
    when 'none' then session_user in ('postgres', 'supabase_admin')
    else false
  end
$$;

create or replace function aislar_por_empresa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if es_servidor() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') and not puede_ver_empresa(old.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', old.empresa_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not puede_ver_empresa(new.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', new.empresa_id;
  end if;
  return coalesce(new, old);
end $$;

create or replace function aislar_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text;
begin
  if es_servidor() then return coalesce(new, old); end if;
  if ve_todas_las_empresas() then return coalesce(new, old); end if;
  select empresa_id into v_empresa from facturas where id = coalesce(old.factura_id, new.factura_id);
  if v_empresa is null or not puede_ver_empresa(v_empresa) then
    raise exception 'No tenés acceso a este documento';
  end if;
  return coalesce(new, old);
end $$;

create or replace function exigir_empresa(p_empresa text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not es_servidor() and not puede_ver_empresa(p_empresa) then
    raise exception 'No tenés acceso a la empresa %', p_empresa;
  end if;
end $$;

-- ---------------------------------------------------------------- 2. Para qué empresas es un documento

-- null  = lo trajo el servidor (Gmail, Drive): puede ser de cualquier empresa.
-- lista = lo subió una persona: las empresas que eligió o, si no eligió, las que ve.
alter table documentos add column empresas_permitidas text[];

create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into documentos (origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por,
                          empresas_permitidas)
  values (p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por',
          case when jsonb_typeof(p -> 'empresas_permitidas') = 'array'
               then array(select jsonb_array_elements_text(p -> 'empresas_permitidas')) end)
  on conflict (gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- La factura que sale de un documento tiene que ser de una empresa permitida para ese documento.
-- Va como trigger para cubrir cualquier camino que cree la factura (hoy, guardar_factura_leida), y corre
-- antes de mirar si ya existía: quien no puede cargarla tampoco se entera de que estaba cargada.
create or replace function factura_respeta_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_permitidas text[];
begin
  if new.documento_id is null then return new; end if;
  select empresas_permitidas into v_permitidas from documentos where id = new.documento_id;
  if v_permitidas is not null and not (new.empresa_id = any(v_permitidas)) then
    raise exception 'La factura es de la empresa % y quien subió el archivo no tiene acceso a esa empresa', new.empresa_id;
  end if;
  return new;
end $$;
create trigger trg_factura_respeta_documento before insert on facturas
  for each row execute function factura_respeta_documento();

-- ---------------------------------------------------------------- 3. Límites para el servidor

-- Empresas activas que ve una persona. El servidor la usa para limitar lo que hace en su nombre.
create or replace function empresas_visibles_de(p_email text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.id order by e.id), '{}')
  from empresas e where e.activa and usuario_ve_empresa(p_email, e.id)
$$;

-- Igual que tomar_documentos, pero solo los documentos subidos para empresas de la lista. Es lo que
-- lee "leer ahora" cuando lo pide alguien que no ve todas las empresas: nunca los de Gmail o Drive
-- (sin lista) ni los subidos para una empresa que esa persona no ve.
create or replace function tomar_documentos_de_empresas(p_max integer, p_empresas text[])
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
      and empresas_permitidas is not null and empresas_permitidas <@ coalesce(p_empresas, '{}')
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- ---------------------------------------------------------------- Permisos

revoke execute on function es_servidor(), factura_respeta_documento(), empresas_visibles_de(text),
  tomar_documentos_de_empresas(integer, text[]) from public, anon, authenticated;
grant execute on function es_servidor(), empresas_visibles_de(text), tomar_documentos_de_empresas(integer, text[]) to service_role;


-- ======================================== 0014_convivencia_hoja.sql
-- Tanda A2 · Convivencia con la hoja: quién gestiona cada fila (corrige reglas de 0008).
--
-- Regla de 0008: la hoja manda sobre una factura o un pago (gestion = 'HOJA') hasta que alguien lo
-- aprueba, paga o contabiliza en el sistema nuevo (gestion = 'SISTEMA'); desde ahí la copia no lo pisa.
-- Tres casos en que la regla no se cumplía:
--   1. Bajar el saldo de una nota de crédito no contaba como decisión del sistema: la copia podía
--      devolverle el saldo entero.
--   2. La copia borraba la marca "Preparado en Gmail" que deja el sistema nuevo en una factura de la hoja.
--   3. Una prueba en seco de contabilización pasaba el pago a 'SISTEMA' aunque no se hubiera
--      contabilizado nada: desde ahí la copia dejaba de actualizarlo y quedaba distinto de la hoja.

-- ---------------------------------------------------------------- 1 y 2. Facturas

create or replace function facturas_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then
    -- La copia trae la marca de mail de la hoja, pero no borra la que ya hay: preparar un mail no cambia
    -- quién gestiona la factura (la hoja la sigue actualizando), así que la marca se cuida acá.
    if new.mail_enviado is null and old.mail_enviado is not null then new.mail_enviado := old.mail_enviado; end if;
    return new;
  end if;
  if new.estado is distinct from old.estado or new.pagado is distinct from old.pagado
     or new.cuenta_contable is distinct from old.cuenta_contable or new.metodo_pago is distinct from old.metodo_pago
     or new.saldo_nc is distinct from old.saldo_nc then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 3. Pagos: la prueba en seco no cambia de dueño

-- Deja el pago REVISADO con la cuenta y la forma probadas, pero sin cambiar quién lo gestiona: si venía
-- de la hoja, la hoja lo sigue actualizando (por ejemplo, cuando se contabilice de verdad en producción).
-- La contabilización real (marcar_pago_contabilizado) sí lo pasa a 'SISTEMA', por el cambio de estado.
create or replace function marcar_pago_revisado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_detalle text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
declare v_gestion text;
begin
  select gestion into v_gestion from pagos where id = p_id and estado in ('CARGADO', 'REVISADO') for update;
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  update pagos set estado = 'REVISADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma where id = p_id;
  update pagos set gestion = v_gestion where id = p_id and gestion is distinct from v_gestion;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'REVISADO_EN_SECO', 'PAGO', p_id::text, p_detalle);
end $$;


-- ======================================== 0015_liberar_pago_xubio.sql
-- Tanda A3 · Salida para un pago que quedó a medio enviar a Xubio.
--
-- contabilizar reserva el pago (envio_xubio_en) antes de enviarlo a Xubio, para no crear dos órdenes
-- de pago. Si el envío se corta sin respuesta (Xubio no contesta, o Netlify corta la función), no se
-- sabe si Xubio lo creó: la reserva queda puesta, que es lo correcto, pero no había forma de sacarla.
-- Existía para facturas (liberar_factura_xubio, 0006) y no para pagos: solo se arreglaba con SQL a mano.

-- Administración, después de mirar en Xubio, resuelve el pago trabado de una de dos formas:
--   · p_xubio_id con valor → el comprobante SÍ está en Xubio: el pago queda CONTABILIZADO con ese número,
--     sin enviar nada. Necesita la cuenta contable (la del pago o la que llegue en p_cuenta).
--   · p_xubio_id vacío     → NO está en Xubio: se saca la reserva y el pago se puede volver a enviar o anular.
-- Devuelve 'CONTABILIZADO' o 'LIBERADO'.
create or replace function liberar_pago_xubio(p_id uuid, p_xubio_id text, p_cuenta text, p_forma forma_carga_xubio)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; v_id text; v_cuenta text;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.envio_xubio_en is null or p.estado::text not in ('CARGADO', 'REVISADO') then
    raise exception 'El pago no tiene un envío a Xubio trabado';
  end if;

  v_id := trim(coalesce(p_xubio_id, ''));
  if v_id <> '' then
    v_cuenta := coalesce(nullif(trim(coalesce(p_cuenta, '')), ''), p.cuenta_contable);
    if coalesce(v_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
    update pagos set estado = 'CONTABILIZADO', xubio_id = v_id, cuenta_contable = v_cuenta,
      forma_carga_xubio = coalesce(p_forma, forma_carga_xubio), contabilizado_por = u.nombre, contabilizado_en = now(),
      detalle_contabilizacion = 'Envío sin confirmar, resuelto a mano: ya estaba en Xubio como ' || v_id
    where id = p_id;
    perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
      'Envío sin confirmar: ya estaba en Xubio como ' || v_id || ' · ' || v_cuenta || '. Queda contabilizado sin enviar nada');
    return 'CONTABILIZADO';
  end if;

  update pagos set envio_xubio_en = null,
    detalle_contabilizacion = 'Envío a Xubio sin confirmar, liberado por ' || u.nombre || ': no estaba en Xubio'
  where id = p_id;
  perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
    'Envío sin confirmar: no estaba en Xubio. Liberado para volver a enviar o anular');
  return 'LIBERADO';
end $$;

revoke execute on function liberar_pago_xubio(uuid, text, text, forma_carga_xubio) from public, anon;
grant execute on function liberar_pago_xubio(uuid, text, text, forma_carga_xubio) to authenticated, service_role;


-- ======================================== 0016_liberar_pago_con_plazo.sql
-- Corrección de la tanda A3 (revisión del agente 06, problemas 1 y 4) · reemplaza la función de 0015.
--
--   1. liberar_pago_xubio trataba igual un envío cortado y uno que todavía está saliendo: cualquier pago
--      reservado y sin contabilizar se podía liberar al instante. Liberar un envío en curso y volver a
--      contabilizar creaba dos órdenes de pago en Xubio. Desde acá, ninguna de las dos salidas ("ya está
--      en Xubio" y "no está, liberar") se acepta hasta que la reserva tenga más que el plazo de abajo.
--   2. El número de Xubio que se carga a mano no se validaba: aceptaba RALPHARMA (la pantalla lo mostraba
--      como "Cargado en Ralpharma"), CARGADO_A_MANO o cualquier texto.

-- ---------------------------------------------------------------- El plazo, en un solo lugar

-- Cuánto tiene que pasar desde la reserva para dar un envío por cortado. La base y la pantalla lo leen de acá.
-- Por qué 5 minutos: con los topes por defecto (8 s por llamada a Xubio), contabilizar puede tardar unos
-- 37 s en el peor caso medido (lecturas lentas y envío colgado), y Xubio puede terminar de crear el
-- comprobante después de que la función cortó. 5 minutos es 8 veces ese peor caso y es el mismo criterio
-- que ya usa la cola de documentos para dar por caído a un lector (0005). Si se suben los topes
-- (XUBIO_TIMEOUT_MS) por encima de unos 30 s por llamada, hay que subir también este plazo.
create or replace function plazo_envio_xubio()
returns interval language sql immutable as $$ select interval '5 minutes' $$;

-- El mismo plazo en segundos, para la pantalla (que no ofrece las salidas hasta que pase).
create or replace function plazo_envio_xubio_segundos()
returns integer language sql immutable as $$ select extract(epoch from plazo_envio_xubio())::integer $$;

-- ---------------------------------------------------------------- Liberar, con plazo y número validado

create or replace function liberar_pago_xubio(p_id uuid, p_xubio_id text, p_cuenta text, p_forma forma_carga_xubio)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; v_id text; v_cuenta text; v_falta interval;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.envio_xubio_en is null or p.estado::text not in ('CARGADO', 'REVISADO') then
    raise exception 'El pago no tiene un envío a Xubio trabado';
  end if;
  -- Vale para las dos salidas: mientras el envío pueda estar en curso, tampoco sirve mirar Xubio.
  v_falta := p.envio_xubio_en + plazo_envio_xubio() - now();
  if v_falta > interval '0' then
    raise exception 'El envío a Xubio de este pago todavía puede estar en curso (salió hace % s). Esperá % min % s y volvé a mirar: si para entonces no quedó contabilizado, buscalo en Xubio y resolvelo acá.',
      greatest(0, floor(extract(epoch from now() - p.envio_xubio_en)))::int,
      ceil(extract(epoch from v_falta))::int / 60, ceil(extract(epoch from v_falta))::int % 60;
  end if;

  v_id := trim(coalesce(p_xubio_id, ''));
  if v_id <> '' then
    -- Solo números de comprobante: letras, dígitos, guiones, puntos y barras, con al menos un dígito.
    -- Deja afuera las marcas internas (RALPHARMA, CARGADO_A_MANO, EN-SECO) y los textos libres.
    if upper(v_id) in ('RALPHARMA', 'CARGADO_A_MANO', 'EN-SECO') or length(v_id) > 40
       or v_id !~ '^[A-Za-z0-9][A-Za-z0-9./-]*$' or v_id !~ '[0-9]' then
      raise exception 'El número de Xubio "%" no es válido. Cargá el número del comprobante como figura en Xubio (por ejemplo OP-1234 o X-0001-00000483).', v_id;
    end if;
    -- Solo dígitos: se guarda como los envíos automáticos (OP-1234).
    if v_id ~ '^[0-9]+$' then v_id := 'OP-' || v_id; end if;
    v_cuenta := coalesce(nullif(trim(coalesce(p_cuenta, '')), ''), p.cuenta_contable);
    if coalesce(v_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
    update pagos set estado = 'CONTABILIZADO', xubio_id = v_id, cuenta_contable = v_cuenta,
      forma_carga_xubio = coalesce(p_forma, forma_carga_xubio), contabilizado_por = u.nombre, contabilizado_en = now(),
      detalle_contabilizacion = 'Envío sin confirmar, resuelto a mano: ya estaba en Xubio como ' || v_id
    where id = p_id;
    perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
      'Envío sin confirmar: ya estaba en Xubio como ' || v_id || ' · ' || v_cuenta || '. Queda contabilizado sin enviar nada');
    return 'CONTABILIZADO';
  end if;

  update pagos set envio_xubio_en = null,
    detalle_contabilizacion = 'Envío a Xubio sin confirmar, liberado por ' || u.nombre || ': no estaba en Xubio'
  where id = p_id;
  perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
    'Envío sin confirmar: no estaba en Xubio. Liberado para volver a enviar o anular');
  return 'LIBERADO';
end $$;

-- ---------------------------------------------------------------- Permisos

revoke execute on function plazo_envio_xubio(), plazo_envio_xubio_segundos() from public, anon;
grant execute on function plazo_envio_xubio(), plazo_envio_xubio_segundos() to authenticated, service_role;


-- ======================================== 0017_organizaciones.sql
-- Tanda B1 · Organizaciones: el nivel por encima de las empresas (tablas y claves).
--
-- Hasta acá la base era de un solo grupo: 8 empresas, y "ver todas las empresas" quería decir todas las
-- de la base. Para poder dar el sistema a otras empresas hace falta saber de qué cliente es cada cosa.
-- Esta migración agrega la organización (el cliente) y le pone dueño a todo. Vértice es la primera y,
-- por ahora, la única: todo lo que ya existe queda a su nombre y nada cambia para el equipo.
--
--   · La organización se guarda en la empresa. Facturas, pagos, cuentas de origen, movimientos y la
--     memoria de proveedores ya tienen empresa obligatoria y la heredan de ahí: no llevan columna propia.
--   · Llevan columna propia las tablas que no tienen empresa (o la tienen opcional): usuarios,
--     proveedores, documentos, auditoría, cuentas y reglas contables, productos de Xubio y estado de la copia.
--   · Las claves únicas pasan a ser por organización (el mismo CUIT puede ser proveedor de dos clientes).
--
-- Quién ve qué no cambia en esta migración: las reglas de acceso se reescriben en la 0018.
--
-- Con una sola organización, nada de lo que escribe hoy (pantalla, funciones de Netlify, copia de la hoja,
-- puentes del Apps Script) necesita saber que existe: lo que no trae organización se asigna solo
-- (ver poner_organizacion). Con dos o más, lo que no se pueda deducir se rechaza con un mensaje claro
-- en vez de adivinar: eso se termina de resolver con los secretos por organización (grupo C).

-- ---------------------------------------------------------------- La tabla

create table organizaciones (
  id            uuid primary key default gen_random_uuid(),
  -- Nombre corto y estable, para verlo en consultas y reportes. Empieza con letra.
  slug          text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  nombre        text not null,
  estado        text not null default 'ACTIVA' check (estado in ('ACTIVA', 'SUSPENDIDA', 'BAJA')),
  -- Verdadero solo para Vértice: la organización que da el servicio a las demás.
  es_proveedor  boolean not null default false,
  creado_en     timestamptz not null default now()
);
create unique index organizaciones_un_solo_proveedor on organizaciones (es_proveedor) where es_proveedor;
alter table organizaciones enable row level security;   -- sin regla de lectura hasta la 0018: nadie la lee
grant all on organizaciones to service_role;

insert into organizaciones (slug, nombre, es_proveedor) values ('vertice', 'Vértice', true);

-- ---------------------------------------------------------------- Funciones de apoyo

-- La única organización, si hay exactamente una. Con dos o más (o ninguna) devuelve null.
create or replace function organizacion_unica()
returns uuid language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then (array_agg(id))[1] end from organizaciones
$$;

-- Para lo que hace el servidor sin saber de quién es el dato (un mail de proveedor de la hoja, un pago
-- de la hoja sin empresa, un adjunto de Gmail). Mientras haya una sola organización, es esa. Con más de
-- una falla: es preferible que la copia se detenga a que cargue datos de un cliente en otro.
create or replace function organizacion_del_servidor()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  v := organizacion_unica();
  if v is null then
    raise exception 'Hay más de una organización y este proceso todavía no sabe para cuál trabaja (falta el secreto por organización)';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------- Columnas, con todo lo existente a nombre de Vértice

alter table empresas add column organizacion_id uuid references organizaciones;
update empresas set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table empresas alter column organizacion_id set not null;
create index on empresas (organizacion_id);

alter table usuarios add column organizacion_id uuid references organizaciones;   -- una persona, una organización
update usuarios set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table usuarios alter column organizacion_id set not null;
create index on usuarios (organizacion_id);

alter table proveedores add column organizacion_id uuid references organizaciones;
update proveedores set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table proveedores alter column organizacion_id set not null;
alter table proveedores drop constraint proveedores_cuit_key;
alter table proveedores add constraint proveedores_organizacion_cuit_key unique (organizacion_id, cuit);

alter table documentos add column organizacion_id uuid references organizaciones;
update documentos set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table documentos alter column organizacion_id set not null;
alter table documentos drop constraint documentos_gmail_message_id_nombre_archivo_key;
alter table documentos add constraint documentos_organizacion_mensaje_archivo_key unique (organizacion_id, gmail_message_id, nombre_archivo);
create index on documentos (organizacion_id, estado, recibido_en);

-- Auditoría: organización y, cuando el renglón habla de una factura o un pago, su empresa. La auditoría
-- no se modifica (0002): el trigger se apaga solo para completar las dos columnas nuevas.
alter table auditoria add column organizacion_id uuid references organizaciones;
alter table auditoria add column empresa_id text references empresas;
alter table auditoria disable trigger trg_auditoria_inmutable;
-- En una sola pasada, cruzando con facturas y pagos (una búsqueda por renglón tarda como facturas × auditoría).
update auditoria a set
  organizacion_id = (select id from organizaciones where slug = 'vertice'),
  empresa_id = x.empresa_id
from (
  select a2.id, coalesce(f.empresa_id, p.empresa_id) as empresa_id
  from auditoria a2
  left join facturas f on a2.entidad = 'FACTURA' and f.id::text = a2.entidad_id
  left join pagos p on a2.entidad = 'PAGO' and p.id::text = a2.entidad_id
) x
where x.id = a.id;
alter table auditoria enable trigger trg_auditoria_inmutable;
alter table auditoria alter column organizacion_id set not null;
create index on auditoria (organizacion_id, empresa_id);

-- Cuentas y reglas contables: las "comunes" (sin empresa) pasan a ser comunes de la organización.
alter table cuentas_contables add column organizacion_id uuid references organizaciones;
update cuentas_contables set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table cuentas_contables alter column organizacion_id set not null;
alter table cuentas_contables drop constraint cuentas_contables_empresa_id_nombre_key;
alter table cuentas_contables add constraint cuentas_contables_organizacion_empresa_nombre_key unique nulls not distinct (organizacion_id, empresa_id, nombre);

alter table reglas_cuenta add column organizacion_id uuid references organizaciones;
update reglas_cuenta set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table reglas_cuenta alter column organizacion_id set not null;

-- Productos de Xubio y estado de la copia de la hoja: uno por organización.
alter table productos_xubio add column organizacion_id uuid references organizaciones;
update productos_xubio set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table productos_xubio alter column organizacion_id set not null;
alter table productos_xubio drop constraint productos_xubio_pkey;
alter table productos_xubio add primary key (organizacion_id, nombre);

alter table espejo_estado add column organizacion_id uuid references organizaciones;
update espejo_estado set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table espejo_estado alter column organizacion_id set not null;
alter table espejo_estado drop constraint espejo_estado_pkey;
alter table espejo_estado add primary key (organizacion_id, hoja);

-- Va después de las columnas: una función en SQL se valida al crearla.
create or replace function organizacion_de_empresa(p_empresa text)
returns uuid language sql stable security definer set search_path = public as $$
  select organizacion_id from empresas where id = p_empresa
$$;

-- ---------------------------------------------------------------- De quién es cada registro nuevo

-- Completa organizacion_id en un registro nuevo que no la trae, en este orden:
--   1. la de su empresa, si la tabla tiene empresa y vino cargada (en la auditoría, la empresa de la
--      factura o el pago del renglón; en un documento, la de las empresas para las que se subió);
--   2. la de la persona que está haciendo la acción, si hay una sesión;
--   3. la única organización que existe.
-- Si no se puede deducir (hay más de una y no vino indicada), rechaza el registro: nunca adivina.
-- Si vino cargada y no coincide con la de la empresa, también lo rechaza. Y no deja cambiarla después.
create or replace function poner_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text; v_org uuid; v_lista text[];
begin
  if tg_op = 'UPDATE' then
    if new.organizacion_id is distinct from old.organizacion_id then
      raise exception 'La organización de un registro no se cambia (tabla %)', tg_table_name;
    end if;
    return new;
  end if;

  -- (Los campos propios de una tabla se miran en un "if" aparte: la función sirve para varias tablas.)
  if tg_table_name = 'auditoria' then
    if new.empresa_id is null and coalesce(new.entidad_id, '') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      if new.entidad = 'FACTURA' then select f.empresa_id into new.empresa_id from facturas f where f.id = new.entidad_id::uuid;
      elsif new.entidad = 'PAGO' then select p.empresa_id into new.empresa_id from pagos p where p.id = new.entidad_id::uuid;
      end if;
    end if;
  end if;

  v_empresa := to_jsonb(new) ->> 'empresa_id';
  if v_empresa is not null then
    select organizacion_id into v_org from empresas where id = v_empresa;
    if v_org is not null then
      if new.organizacion_id is null then new.organizacion_id := v_org;
      elsif new.organizacion_id <> v_org then
        raise exception 'La empresa % es de otra organización (tabla %)', v_empresa, tg_table_name;
      end if;
    end if;
  end if;

  if tg_table_name = 'documentos' then
    v_lista := new.empresas_permitidas;
    if new.organizacion_id is null and coalesce(array_length(v_lista, 1), 0) > 0 then
      select organizacion_id into new.organizacion_id from empresas where id = v_lista[1];
    end if;
  end if;

  if new.organizacion_id is null then new.organizacion_id := (usuario_actual()).organizacion_id; end if;
  if new.organizacion_id is null then new.organizacion_id := organizacion_unica(); end if;
  if new.organizacion_id is null then
    raise exception 'No se sabe de qué organización es el registro nuevo (tabla %): hay más de una organización y no vino indicada', tg_table_name;
  end if;

  if tg_table_name = 'documentos' and exists (
       select 1 from unnest(coalesce(v_lista, '{}')) x left join empresas e on e.id = x
       where e.id is null or e.organizacion_id <> new.organizacion_id) then
    raise exception 'El documento es para una empresa que no existe o que es de otra organización';
  end if;
  return new;
end $$;

create trigger trg_organizacion_empresas before insert or update on empresas for each row execute function poner_organizacion();
create trigger trg_organizacion_usuarios before insert or update on usuarios for each row execute function poner_organizacion();
create trigger trg_organizacion_proveedores before insert or update on proveedores for each row execute function poner_organizacion();
create trigger trg_organizacion_documentos before insert or update on documentos for each row execute function poner_organizacion();
create trigger trg_organizacion_cuentas_contables before insert or update on cuentas_contables for each row execute function poner_organizacion();
create trigger trg_organizacion_reglas_cuenta before insert or update on reglas_cuenta for each row execute function poner_organizacion();
create trigger trg_organizacion_productos_xubio before insert or update on productos_xubio for each row execute function poner_organizacion();
create trigger trg_organizacion_espejo_estado before insert or update on espejo_estado for each row execute function poner_organizacion();
-- La auditoría no se modifica: solo al insertar.
create trigger trg_organizacion_auditoria before insert on auditoria for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Nada cruza de una organización a otra

-- Una persona solo puede tener asignadas empresas de su organización.
create or replace function usuario_empresa_misma_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select organizacion_id from usuarios where email = new.email)
     is distinct from (select organizacion_id from empresas where id = new.empresa_id) then
    raise exception 'La empresa % es de otra organización que el usuario %', new.empresa_id, new.email;
  end if;
  return new;
end $$;
create trigger trg_usuarios_empresas_organizacion before insert or update on usuarios_empresas
  for each row execute function usuario_empresa_misma_organizacion();

-- El proveedor de una factura, de un pago, de la memoria o de una regla es de la misma organización
-- que la empresa. Las funciones ya lo buscan por organización; esto cubre cualquier otro camino
-- (por ejemplo, un pago cargado con el identificador de un proveedor ajeno).
create or replace function proveedor_misma_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila jsonb; v_org uuid; v_org_prov uuid;
begin
  if new.proveedor_id is null then return new; end if;
  v_fila := to_jsonb(new);
  v_org := coalesce((select organizacion_id from empresas where id = v_fila ->> 'empresa_id'), (v_fila ->> 'organizacion_id')::uuid);
  select organizacion_id into v_org_prov from proveedores where id = new.proveedor_id;
  if v_org_prov is not null and v_org is not null and v_org_prov <> v_org then
    raise exception 'El proveedor es de otra organización';
  end if;
  return new;
end $$;
create trigger trg_proveedor_organizacion_facturas before insert or update of proveedor_id, empresa_id on facturas
  for each row execute function proveedor_misma_organizacion();
create trigger trg_proveedor_organizacion_pagos before insert or update of proveedor_id, empresa_id on pagos
  for each row execute function proveedor_misma_organizacion();
create trigger trg_proveedor_organizacion_memoria before insert or update of proveedor_id, empresa_id on proveedores_empresa
  for each row execute function proveedor_misma_organizacion();
-- En reglas_cuenta corre después de trg_organizacion_reglas_cuenta (orden alfabético), que ya completó la organización.
create trigger trg_proveedor_organizacion_reglas before insert or update of proveedor_id, empresa_id on reglas_cuenta
  for each row execute function proveedor_misma_organizacion();

-- ---------------------------------------------------------------- Funciones que dan de alta proveedores, cuentas o documentos
--
-- Son las mismas de 0003, 0005, 0008, 0009 y 0013, con un solo cambio: el proveedor, la cuenta, el
-- producto y el documento se buscan y se crean dentro de la organización de la empresa (antes, en toda
-- la base). En la copia de pagos, además, la factura vinculada y el proveedor por nombre se buscan solo
-- en esa organización.

-- registrar_documento (0013). La organización: la que venga en p (la de quien lo sube), si no la de las
-- empresas para las que se subió, si no la del servidor.
create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_org uuid; v_lista text[];
begin
  v_lista := case when jsonb_typeof(p -> 'empresas_permitidas') = 'array'
                  then array(select jsonb_array_elements_text(p -> 'empresas_permitidas')) end;
  v_org := nullif(p ->> 'organizacion_id', '')::uuid;
  if v_org is null and coalesce(array_length(v_lista, 1), 0) > 0 then
    select e.organizacion_id into v_org from empresas e where e.id = v_lista[1];
  end if;
  if v_org is null then v_org := organizacion_del_servidor(); end if;

  insert into documentos (organizacion_id, origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por,
                          empresas_permitidas)
  values (v_org, p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por', v_lista)
  on conflict (organizacion_id, gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.organizacion_id = v_org and d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- ingresar_factura (0003)
create or replace function ingresar_factura(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_prov uuid; v_id uuid; v_cuit text; v_org uuid;
begin
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;
  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
  insert into proveedores (organizacion_id, cuit, nombre, email, categoria_vertice)
  values (v_org, v_cuit, coalesce(p ->> 'proveedor', 'Sin nombre'), nullif(p ->> 'email_proveedor', ''), p ->> 'categoria_vertice')
  on conflict (organizacion_id, cuit) do update set nombre = excluded.nombre, categoria_vertice = coalesce(excluded.categoria_vertice, proveedores.categoria_vertice)
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

-- guardar_factura_leida (0005)
create or replace function guardar_factura_leida(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d documentos; v_prov uuid; v_id uuid; v_existente uuid; m proveedores_empresa; v_cuit text; v_estado estado_factura; v_org uuid;
begin
  select * into d from documentos where id = p_doc for update;
  if d.id is null then raise exception 'Documento inexistente'; end if;
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;

  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
  insert into proveedores (organizacion_id, cuit, nombre) values (v_org, v_cuit, coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'))
  on conflict (organizacion_id, cuit) do update set nombre = proveedores.nombre    -- el nombre ya cargado manda
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

-- espejar_facturas (0008)
create or replace function espejar_facturas(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; v_prov uuid; v_id uuid; v_gestion text; v_hash text; v_org uuid;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
      if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
      insert into proveedores (organizacion_id, cuit, nombre, categoria_vertice)
      values (v_org, p ->> 'cuit_proveedor', coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'), nullif(p ->> 'categoria_vertice', ''))
      on conflict (organizacion_id, cuit) do update set categoria_vertice = coalesce(proveedores.categoria_vertice, excluded.categoria_vertice)
      returning id into v_prov;
      p := p || jsonb_build_object('proveedor_id', v_prov);

      select id, gestion, hoja_hash into v_id, v_gestion, v_hash from facturas
      where empresa_id = p ->> 'empresa_id' and proveedor_id = v_prov and tipo = p ->> 'tipo'
        and punto_venta = (p ->> 'punto_venta')::int and numero = (p ->> 'numero')::int;

      if v_id is null then
        insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
          neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen, drive_url, estado, estado_xubio,
          xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice, cuenta_contable, codigo_producto, metodo_pago,
          pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado, comprobantes_pago, nc_aplicadas,
          hoja, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.tipo, r.letra, r.punto_venta, r.numero, r.fecha, r.vencimiento, r.moneda, r.cotizacion,
          r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total, r.cae, r.cae_vencimiento, r.origen, r.drive_url, r.estado, r.estado_xubio,
          r.xubio_id, r.xubio_error, r.validacion_ok, r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago,
          r.pagado, r.saldo_nc, r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas,
          r.hoja, r.sheets_fila_origen, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::facturas, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'FACTURA', v_id::text, 'Factura copiada de la hoja real (' || (p ->> 'hoja') || ', fila ' || coalesce(p ->> 'sheets_fila_origen', '?') || ')');
        n_nuevas := n_nuevas + 1;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        -- Sin cambios: solo se anota si la fila se movió (por ejemplo, pasó a Facturas_Aprobadas).
        update facturas set hoja = p ->> 'hoja', sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and (hoja is distinct from p ->> 'hoja' or sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int);
        n_igual := n_igual + 1;
      elsif v_gestion = 'HOJA' then
        update facturas set (letra, fecha, vencimiento, moneda, cotizacion, neto, iva, exento, percepciones, percepciones_json, total,
          cae, cae_vencimiento, drive_url, estado, estado_xubio, xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice,
          cuenta_contable, codigo_producto, metodo_pago, pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado,
          comprobantes_pago, nc_aplicadas, hoja, sheets_fila_origen, hoja_hash, espejado_en, actualizado_en) =
        (select r.letra, r.fecha, r.vencimiento, r.moneda, r.cotizacion, r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total,
          r.cae, r.cae_vencimiento, r.drive_url, r.estado, r.estado_xubio, coalesce(r.xubio_id, facturas.xubio_id), r.xubio_error, r.validacion_ok,
          r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago, r.pagado, r.saldo_nc,
          r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas, r.hoja,
          r.sheets_fila_origen, r.hoja_hash, now(), now()
         from jsonb_populate_record(null::facturas, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        -- La gestiona el sistema nuevo: de la hoja solo se toma dónde está la fila y el PDF.
        update facturas set drive_url = coalesce(drive_url, p ->> 'drive_url'), hoja = p ->> 'hoja',
          sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now()
        where id = v_id;
        n_igual := n_igual + 1;
      end if;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- espejar_pagos (0008)
create or replace function espejar_pagos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; ref jsonb; v_id uuid; v_gestion text; v_hash text; v_emp text; v_prov uuid; v_org uuid; v_emp_previa text;
  v_fids uuid[]; v_totales numeric[]; v_fid uuid; v_femp text; v_fprov uuid; v_ftotal numeric; v_suma numeric; v_imp numeric; i int;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      v_emp := nullif(p ->> 'empresa_id', '');
      -- De qué organización es la fila: la de su empresa; si la fila no trae empresa, la del servidor
      -- (mientras haya una sola organización es esa; con más de una, hay que saber de quién es la hoja).
      if v_emp is not null then
        select organizacion_id into v_org from empresas where id = v_emp;
        if v_org is null then raise exception 'Empresa inexistente: %', v_emp; end if;
      else
        v_org := organizacion_del_servidor();
      end if;
      v_prov := null; v_fids := '{}'; v_totales := '{}';
      for ref in select value from jsonb_array_elements(coalesce(p -> 'facturas', '[]'::jsonb)) loop
        v_fid := null;
        select f.id, f.empresa_id, f.proveedor_id, f.total into v_fid, v_femp, v_fprov, v_ftotal
        from facturas f join proveedores pr on pr.id = f.proveedor_id join empresas em on em.id = f.empresa_id
        where f.punto_venta = (ref ->> 'punto_venta')::int and f.numero = (ref ->> 'numero')::int
          and (v_emp is null or f.empresa_id = v_emp) and em.organizacion_id = v_org
        order by (texto_comparable(pr.nombre) = texto_comparable(p ->> 'proveedor_destino')) desc, f.fecha desc
        limit 1;
        if v_fid is not null and not (v_fid = any(v_fids)) then
          v_fids := v_fids || v_fid; v_totales := v_totales || v_ftotal;
          v_emp := coalesce(v_emp, v_femp); v_prov := coalesce(v_prov, v_fprov);
        end if;
      end loop;
      if v_emp is null then raise exception 'No se sabe de qué empresa es el pago (EMPRESA y REALIZADO_POR vacíos, sin factura vinculada)'; end if;
      if v_prov is null and coalesce(p ->> 'proveedor_destino', '') <> '' then
        select id into v_prov from proveedores where organizacion_id = v_org and texto_comparable(nombre) = texto_comparable(p ->> 'proveedor_destino') limit 1;
      end if;
      p := p || jsonb_build_object('empresa_id', v_emp, 'proveedor_id', v_prov,
                                   'cargado_en', coalesce(p ->> 'cargado_en', now()::text), 'cargado_por', coalesce(p ->> 'cargado_por', 'Apps Script'));

      select id, gestion, hoja_hash, empresa_id into v_id, v_gestion, v_hash, v_emp_previa from pagos where hoja_id = p ->> 'hoja_id';
      -- El ID_PAGO de la hoja es único en toda la base: si ya lo usa un pago de otra organización, no se toca.
      if v_id is not null and organizacion_de_empresa(v_emp_previa) is distinct from v_org then
        raise exception 'El pago % ya existe en otra organización', p ->> 'hoja_id';
      end if;

      if v_id is null then
        insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por, cargado_en,
          contabilizado_por, contabilizado_en, hoja_id, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por, r.cargado_en,
          r.contabilizado_por, r.contabilizado_en, r.hoja_id, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::pagos, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'PAGO', v_id::text, 'Pago ' || (p ->> 'hoja_id') || ' copiado de la hoja real');
        n_nuevas := n_nuevas + 1;
        v_gestion := 'HOJA'; v_hash := null;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int;
        n_igual := n_igual + 1;
        continue;
      elsif v_gestion = 'HOJA' then
        update pagos set (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por,
          contabilizado_por, contabilizado_en, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, espejado_en) =
        (select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por,
          r.contabilizado_por, r.contabilizado_en, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, now()
         from jsonb_populate_record(null::pagos, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now() where id = v_id;
        n_igual := n_igual + 1;
        continue;
      end if;

      -- Facturas que cancela, para mostrar el vínculo. Lo pagado de cada factura lo sigue diciendo la hoja
      -- (PORCENTAJE_PAGADO): estos importes no la modifican. Con varias facturas se reparte según el total.
      delete from pagos_facturas where pago_id = v_id;
      select coalesce(sum(t), 0) into v_suma from unnest(v_totales) t;
      for i in 1 .. coalesce(array_length(v_fids, 1), 0) loop
        v_imp := case when array_length(v_fids, 1) = 1 then least((p ->> 'importe')::numeric, v_totales[i])
                      when v_suma > 0 then round((p ->> 'importe')::numeric * v_totales[i] / v_suma, 2) else 0 end;
        insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fids[i], v_imp) on conflict do nothing;
      end loop;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'id', p -> 'hoja_id', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- espejar_catalogos (0008)
create or replace function espejar_catalogos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_prov uuid; v_org uuid; n jsonb := '{}';
begin
  perform set_config('vertice.espejo', 'si', true);

  -- Cada cuenta es de la organización de su empresa. Sin empresa (común), de la del servidor.
  insert into cuentas_contables (organizacion_id, empresa_id, nombre, codigo, xubio_id, activa)
  select coalesce(e.organizacion_id, organizacion_del_servidor()), x ->> 'empresa_id', x ->> 'nombre', x ->> 'codigo', x ->> 'xubio_id', true
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb)) x left join empresas e on e.id = x ->> 'empresa_id'
  on conflict (organizacion_id, empresa_id, nombre) do update set codigo = excluded.codigo, xubio_id = excluded.xubio_id, activa = true;
  n := n || jsonb_build_object('cuentas', jsonb_array_length(coalesce(p -> 'cuentas', '[]'::jsonb)));

  insert into cuentas_origen (empresa_id, nombre, xubio_id, tipo_cuenta, codigo, usos, ultimo_uso)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'xubio_id', (x ->> 'tipo_cuenta')::int, x ->> 'codigo',
         coalesce((x ->> 'usos')::int, 0), (x ->> 'ultimo_uso')::date
  from jsonb_array_elements(coalesce(p -> 'origen', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set xubio_id = excluded.xubio_id, tipo_cuenta = excluded.tipo_cuenta,
    codigo = excluded.codigo, usos = excluded.usos, ultimo_uso = excluded.ultimo_uso;
  n := n || jsonb_build_object('origen', jsonb_array_length(coalesce(p -> 'origen', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'porEmpresa', '[]'::jsonb)) loop
    select organizacion_id into v_org from empresas where id = r ->> 'empresa_id';
    if v_org is null then raise exception 'Empresa inexistente: %', coalesce(r ->> 'empresa_id', '(vacía)'); end if;
    insert into proveedores (organizacion_id, cuit, nombre) values (v_org, r ->> 'cuit', coalesce(nullif(r ->> 'nombre_xubio', ''), 'Sin nombre'))
    on conflict (organizacion_id, cuit) do update set nombre = proveedores.nombre
    returning id into v_prov;
    insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, nombre_xubio, saltar_xubio, actualizado_por)
    values (v_prov, r ->> 'empresa_id', nullif(r ->> 'cuenta_contable', ''), nullif(r ->> 'nombre_xubio', ''),
            coalesce((r ->> 'saltar_xubio')::boolean, false), 'Copia de la hoja')
    on conflict (proveedor_id, empresa_id) do update set
      cuenta_contable = coalesce(excluded.cuenta_contable, proveedores_empresa.cuenta_contable),
      nombre_xubio = excluded.nombre_xubio, saltar_xubio = excluded.saltar_xubio;
  end loop;
  n := n || jsonb_build_object('porEmpresa', jsonb_array_length(coalesce(p -> 'porEmpresa', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'emails', '[]'::jsonb)) loop
    -- Los mails no traen empresa: son de la organización del servidor (ver organizacion_del_servidor).
    insert into proveedores (organizacion_id, cuit, nombre, email) values (organizacion_del_servidor(), r ->> 'cuit', r ->> 'proveedor', r ->> 'email')
    on conflict (organizacion_id, cuit) do update set email = excluded.email;
  end loop;
  n := n || jsonb_build_object('emails', jsonb_array_length(coalesce(p -> 'emails', '[]'::jsonb)));

  insert into productos_xubio (organizacion_id, nombre, codigo)
  select organizacion_del_servidor(), x ->> 'nombre', x ->> 'codigo' from jsonb_array_elements(coalesce(p -> 'productos', '[]'::jsonb)) x
  on conflict (organizacion_id, nombre) do update set codigo = excluded.codigo;
  n := n || jsonb_build_object('productos', jsonb_array_length(coalesce(p -> 'productos', '[]'::jsonb)));

  return n;
end $$;

-- editar_factura (0009)
create or replace function editar_factura(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; f facturas; n facturas; v_cuit text; v_prov uuid; v_tipo text; v_cae text;
  v_neto numeric; v_iva numeric; v_exento numeric; v_perc numeric; v_total numeric; v_dif numeric;
  v_motivo text; v_estado estado_factura; v_cambios text; v_org uuid;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado not in ('PENDIENTE_APROBACION', 'ERROR', 'PARA_PAGAR') or f.pagado > 0 then
    raise exception 'Solo se editan facturas sin pagos (pendientes, en excepciones o para pagar)';
  end if;
  if f.estado_xubio = 'SUBIDA' then
    raise exception 'La factura ya está en Xubio: corregila en Xubio y volvé a traerla';
  end if;

  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'El CUIT del proveedor tiene que tener 11 dígitos'; end if;
  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Elegí la empresa que recibe la factura'; end if;
  if coalesce((p ->> 'numero')::int, 0) <= 0 then raise exception 'Falta el número del comprobante'; end if;
  if (p ->> 'fecha') is null then raise exception 'Falta la fecha de emisión'; end if;

  insert into proveedores (organizacion_id, cuit, nombre) values (v_org, v_cuit, coalesce(nullif(trim(p ->> 'proveedor'), ''), 'Sin nombre'))
  on conflict (organizacion_id, cuit) do update set nombre = coalesce(nullif(trim(excluded.nombre), ''), proveedores.nombre)
  returning id into v_prov;

  -- Validación de producción (validarFactura_): tipo, CAE de 14 dígitos y que cierre el total (±1 peso).
  v_tipo := nullif(trim(p ->> 'tipo'), '');
  v_cae := regexp_replace(coalesce(p ->> 'cae', ''), '\D', '', 'g');
  v_neto := coalesce((p ->> 'neto')::numeric, 0);
  v_iva := coalesce((p ->> 'iva')::numeric, 0);
  v_exento := coalesce((p ->> 'exento')::numeric, 0);
  select coalesce(sum((x ->> 'importe')::numeric), 0) into v_perc from jsonb_array_elements(coalesce(p -> 'percepciones_json', '[]'::jsonb)) x;
  v_total := coalesce((p ->> 'total')::numeric, 0);
  v_dif := round(v_total - (v_neto + v_iva + v_exento + v_perc), 2);
  v_motivo := case
    when v_tipo is null or v_tipo = 'Sin tipo' then 'Comprobante sin tipo válido'
    when v_total <= 0 then 'El total tiene que ser mayor a cero'
    when length(v_cae) <> 14 then 'El CAE tiene que tener 14 dígitos (tiene ' || length(v_cae) || ')'
    when abs(v_dif) >= 1 then 'Descuadre de $' || abs(v_dif) || ' entre el total y neto + IVA + exento + percepciones'
  end;
  v_estado := case
    when f.estado = 'PARA_PAGAR' then 'PARA_PAGAR'
    when v_motivo is null then 'PENDIENTE_APROBACION'
    else 'ERROR'
  end;

  begin
    update facturas set
      empresa_id = p ->> 'empresa_id', proveedor_id = v_prov, tipo = coalesce(v_tipo, 'Sin tipo'),
      letra = nullif(upper(left(trim(coalesce(p ->> 'letra', '')), 1)), ''),
      punto_venta = coalesce((p ->> 'punto_venta')::int, 0), numero = (p ->> 'numero')::int,
      fecha = (p ->> 'fecha')::date, vencimiento = coalesce(nullif(p ->> 'vencimiento', '')::date, (p ->> 'fecha')::date),
      moneda = coalesce(nullif(p ->> 'moneda', ''), 'ARS'), cotizacion = coalesce(nullif(p ->> 'cotizacion', '')::numeric, 1),
      neto = v_neto, iva = v_iva, exento = v_exento, percepciones = v_perc,
      percepciones_json = coalesce(p -> 'percepciones_json', '[]'::jsonb), total = v_total,
      cae = nullif(v_cae, ''), cae_vencimiento = nullif(p ->> 'cae_vencimiento', '')::date,
      categoria_vertice = coalesce(nullif(p ->> 'categoria_vertice', ''), categoria_vertice),
      cuenta_contable = coalesce(nullif(p ->> 'cuenta_contable', ''), cuenta_contable),
      codigo_producto = coalesce(nullif(p ->> 'codigo_producto', ''), codigo_producto),
      validacion_ok = v_motivo is null, motivo_validacion = v_motivo, estado = v_estado,
      gestion = 'SISTEMA', actualizado_en = now()
    where id = p_id
    returning * into n;
  exception when unique_violation then
    raise exception 'Ya hay otra factura de ese proveedor con el mismo tipo y número en esa empresa';
  end;

  -- Qué cambió, para la auditoría.
  select string_agg(o.key, ', ' order by o.key) into v_cambios
  from jsonb_each(to_jsonb(f)) o join jsonb_each(to_jsonb(n)) x using (key)
  where o.value is distinct from x.value and o.key not in ('actualizado_en', 'gestion', 'validacion_ok', 'motivo_validacion', 'estado', 'percepciones');
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle, antes, despues)
  values (u.nombre, u.rol, 'EDICION', 'FACTURA', p_id::text,
          'Datos corregidos a mano: ' || coalesce(v_cambios, 'sin cambios') || case when v_motivo is null then '' else ' · queda en excepciones: ' || v_motivo end,
          to_jsonb(f), to_jsonb(n));
  return jsonb_build_object('estado', v_estado, 'motivo', v_motivo, 'cambios', v_cambios);
end $$;

-- ---------------------------------------------------------------- Permisos

-- Las funciones de arriba conservan los permisos que ya tenían (se reemplazaron, no se crearon).
revoke execute on function organizacion_unica(), organizacion_de_empresa(text), organizacion_del_servidor(),
  poner_organizacion(), usuario_empresa_misma_organizacion(), proveedor_misma_organizacion()
  from public, anon, authenticated;
grant execute on function organizacion_unica(), organizacion_de_empresa(text), organizacion_del_servidor() to service_role;


-- ======================================== 0018_reglas_por_organizacion.sql
-- Tanda B2 · Organizaciones: reglas de acceso.
--
-- Hasta acá "ver todas las empresas" quería decir todas las de la base, y había tablas que veía cualquier
-- persona habilitada (proveedores, productos, estado de la copia, documentos sin leer, auditoría del
-- sistema). Con una segunda organización cargada, eso mostraba datos de un cliente a otro.
--
-- Desde acá:
--   · Una persona ve una empresa solo si es de su organización (y además tiene todas las de su
--     organización, o esa asignada). "Todas las empresas" pasa a ser "todas las de mi organización".
--     Con eso cambian solas las reglas y los controles de escritura que ya miraban la empresa.
--   · Las tablas con organización propia se ven solo dentro de esa organización.
--   · Una organización que no está ACTIVA no deja entrar a su gente.
--   · Las reglas por empresa se evalúan una vez por consulta (empresas_visibles) y no fila por fila.
-- Para Vértice, mientras sea la única organización, el resultado es el mismo de antes, con dos cambios
-- chicos que hoy no tocan a nadie (todo el equipo ve todas las empresas):
--   · quien no ve todas ahora ve (y puede reintentar o descartar) los archivos que se subieron para sus
--     empresas, aunque no hayan terminado en factura. Antes no los veía nadie más que quien ve todas;
--   · el registro de Xubio sin empresa ya no lo ve ninguna persona (no hay código que lo escriba así).

-- ---------------------------------------------------------------- Quién es la persona

-- Igual que en 0002, más: la organización de la persona tiene que estar activa.
create or replace function usuario_actual()
returns usuarios
language sql stable security definer set search_path = public as $$
  select u.* from usuarios u join organizaciones o on o.id = u.organizacion_id
  where u.email = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo and o.estado = 'ACTIVA'
$$;

create or replace function auth_solo_habilitados()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from usuarios u join organizaciones o on o.id = u.organizacion_id
                 where u.email = lower(new.email) and u.activo and o.estado = 'ACTIVA') then
    raise exception 'La cuenta % no está habilitada en el sistema', new.email;
  end if;
  return new;
end $$;

-- La organización de la persona de la sesión. Null si no está habilitada.
create or replace function organizacion_actual()
returns uuid language sql stable security definer set search_path = public as $$
  select (usuario_actual()).organizacion_id
$$;

-- ---------------------------------------------------------------- Qué empresas ve

-- El corazón del cambio. Antes: "está activo y tiene todas las empresas, o tiene asignada esta".
-- Ahora: "está activo, su organización está activa, LA EMPRESA ES DE SU ORGANIZACIÓN, y tiene todas las
-- de su organización o tiene asignada esta". La usan el servidor (Netlify) y puede_ver_empresa.
create or replace function usuario_ve_empresa(p_email text, p_empresa text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select u.activo and o.estado = 'ACTIVA' and e.organizacion_id = u.organizacion_id
           and (u.todas_empresas or exists (
             select 1 from usuarios_empresas ue where ue.email = u.email and ue.empresa_id = e.id))
    from usuarios u
    join organizaciones o on o.id = u.organizacion_id
    join empresas e on e.id = p_empresa
    where u.email = lower(p_email)
  ), false)
$$;

-- "Ve todas las empresas" = todas las de su organización. Sola no alcanza para mostrar nada: las reglas
-- de abajo la combinan siempre con la organización del registro.
create or replace function ve_todas_las_empresas()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((usuario_actual()).todas_empresas, false)
$$;

-- Las empresas que ve la persona de la sesión, todas juntas. Las reglas la usan como
-- "empresa_id in (select empresas_visibles())", que se calcula una vez por consulta.
create or replace function empresas_visibles()
returns setof text
language sql stable security definer set search_path = public as $$
  select e.id
  from usuarios u
  join organizaciones o on o.id = u.organizacion_id and o.estado = 'ACTIVA'
  join empresas e on e.organizacion_id = u.organizacion_id
  where u.email = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
    and (u.todas_empresas or exists (select 1 from usuarios_empresas ue where ue.email = u.email and ue.empresa_id = e.id))
$$;

-- ---------------------------------------------------------------- Lectura (RLS)

create policy leer_organizaciones on organizaciones for select to authenticated using (id = organizacion_actual());

drop policy leer_empresas on empresas;
create policy leer_empresas on empresas for select to authenticated using (id in (select empresas_visibles()));

-- Cada uno ve su propio usuario; quien ve todas las empresas de su organización ve al equipo de su organización.
drop policy leer_usuarios on usuarios;
create policy leer_usuarios on usuarios for select to authenticated
  using ((usuario_actual()).email is not null
         and (email = (usuario_actual()).email or (ve_todas_las_empresas() and organizacion_id = organizacion_actual())));

drop policy leer_usuarios_empresas on usuarios_empresas;
create policy leer_usuarios_empresas on usuarios_empresas for select to authenticated
  using ((usuario_actual()).email is not null
         and (email = (usuario_actual()).email or (ve_todas_las_empresas() and empresa_id in (select empresas_visibles()))));

-- Cuentas y reglas sin empresa: comunes de la organización (antes, de toda la base).
drop policy leer_cuentas_contables on cuentas_contables;
create policy leer_cuentas_contables on cuentas_contables for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));

drop policy leer_reglas on reglas_cuenta;
create policy leer_reglas on reglas_cuenta for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));

drop policy leer_cuentas_origen on cuentas_origen;
create policy leer_cuentas_origen on cuentas_origen for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_facturas on facturas;
create policy leer_facturas on facturas for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_pagos on pagos;
create policy leer_pagos on pagos for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_movimientos on movimientos_bancarios;
create policy leer_movimientos on movimientos_bancarios for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_memoria on proveedores_empresa;
create policy leer_memoria on proveedores_empresa for select to authenticated using (empresa_id in (select empresas_visibles()));

-- pagos_facturas y notas_credito_aplicadas no cambian: miran facturas y pagos, que ya quedaron filtrados.

-- Registro de Xubio: siempre por empresa.
drop policy leer_xubio_log on xubio_log;
create policy leer_xubio_log on xubio_log for select to authenticated
  using ((usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION') and empresa_id in (select empresas_visibles()));

-- Documentos: los de mi organización, y dentro de ella:
--   · todos, si veo todas las empresas de mi organización;
--   · los que terminaron en una factura que veo;
--   · los que se subieron para empresas que veo todas (lista de 0013). Los de Gmail o Drive no tienen
--     lista: pueden ser de cualquier empresa y los ve solo quien ve todas.
drop policy leer_documentos on documentos;
create policy leer_documentos on documentos for select to authenticated
  using (organizacion_id = organizacion_actual()
         and (ve_todas_las_empresas()
              or exists (select 1 from facturas f where f.id = factura_id)
              or (cardinality(empresas_permitidas) > 0 and empresas_permitidas <@ array(select empresas_visibles()))));

-- Auditoría: por la organización y la empresa que guarda el renglón (0017), sin comparar textos.
-- Lo que no tiene empresa (sistema, documentos sin factura), quien ve todas las de su organización.
drop policy leer_auditoria on auditoria;
create policy leer_auditoria on auditoria for select to authenticated
  using (organizacion_id = organizacion_actual()
         and (ve_todas_las_empresas() or empresa_id in (select empresas_visibles())));

-- Proveedores, productos de Xubio y estado de la copia: los de mi organización (antes, cualquier habilitado).
drop policy leer_proveedores on proveedores;
create policy leer_proveedores on proveedores for select to authenticated using (organizacion_id = organizacion_actual());

drop policy leer_productos_xubio on productos_xubio;
create policy leer_productos_xubio on productos_xubio for select to authenticated using (organizacion_id = organizacion_actual());

drop policy leer_espejo_estado on espejo_estado;
create policy leer_espejo_estado on espejo_estado for select to authenticated using (organizacion_id = organizacion_actual());

-- Los archivos (storage) se reescriben en la 0019.

-- ---------------------------------------------------------------- Escritura

-- aislar_por_empresa y exigir_empresa (0013) no cambian: preguntan puede_ver_empresa, que ya mira la organización.

-- Documentos (reintentar, descartar): la misma regla que para leerlos.
create or replace function aislar_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare d documentos; v_empresa text;
begin
  if es_servidor() then return coalesce(new, old); end if;
  d := coalesce(old, new);
  if d.organizacion_id is distinct from organizacion_actual() then
    raise exception 'No tenés acceso a este documento';
  end if;
  if ve_todas_las_empresas() then return coalesce(new, old); end if;
  select empresa_id into v_empresa from facturas where id = coalesce(old.factura_id, new.factura_id);
  if v_empresa is not null and puede_ver_empresa(v_empresa) then return coalesce(new, old); end if;
  if cardinality(d.empresas_permitidas) > 0 and d.empresas_permitidas <@ array(select empresas_visibles()) then
    return coalesce(new, old);
  end if;
  raise exception 'No tenés acceso a este documento';
end $$;

-- La factura que sale de un documento: de una empresa permitida para ese documento (0013) y, siempre,
-- de la organización del documento. Un adjunto de una organización nunca termina en una empresa de otra.
create or replace function factura_respeta_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_permitidas text[]; v_org uuid;
begin
  if new.documento_id is null then return new; end if;
  select empresas_permitidas, organizacion_id into v_permitidas, v_org from documentos where id = new.documento_id;
  if v_org is distinct from organizacion_de_empresa(new.empresa_id) then
    raise exception 'La factura es de la empresa %, que es de otra organización que el archivo', new.empresa_id;
  end if;
  if v_permitidas is not null and not (new.empresa_id = any(v_permitidas)) then
    raise exception 'La factura es de la empresa % y quien subió el archivo no tiene acceso a esa empresa', new.empresa_id;
  end if;
  return new;
end $$;

-- Guardar el mail de un proveedor (0012): solo de un proveedor de mi organización. Antes alcanzaba con
-- conocer su identificador.
create or replace function guardar_email_proveedor(p_proveedor uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  v := lower(trim(coalesce(p_email, '')));
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Mail inválido: %', p_email; end if;
  update proveedores set email = v where id = p_proveedor and organizacion_id = u.organizacion_id;
  if not found then raise exception 'Proveedor inexistente'; end if;
  perform registrar_auditoria(u, 'MAIL_PROVEEDOR_GUARDADO', 'SISTEMA', p_proveedor::text, v);
end $$;

-- ---------------------------------------------------------------- Cola de lectura, por organización

-- Igual que tomar_documentos (0005), pero solo los documentos de una organización. Es lo que usa "leer
-- ahora" cuando lo pide quien ve todas las empresas de la suya, para que no lea ni reciba el detalle de
-- documentos de otro cliente. La de un solo dato sigue igual y toma de toda la cola: la usa el lector
-- programado, que después lee cada documento con las empresas de su organización.
-- Lleva el mismo nombre con un dato más: sin organización (null) no toma nada.
create or replace function tomar_documentos(p_max integer, p_organizacion uuid)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
      and organizacion_id = p_organizacion
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- ---------------------------------------------------------------- Permisos

grant select on organizaciones to authenticated;
grant execute on function organizacion_actual(), empresas_visibles() to authenticated, service_role;
revoke execute on function organizacion_actual(), empresas_visibles() from public, anon;
revoke execute on function tomar_documentos(integer, uuid) from public, anon, authenticated;
grant execute on function tomar_documentos(integer, uuid) to service_role;


-- ======================================== 0019_archivos_por_organizacion.sql
-- Tanda B3 · Archivos por organización y por empresa.
--
-- Hasta acá los archivos se guardaban como "año/mes/nombre" (facturas) y "año/nombre" (comprobantes de
-- pago), sin nada en la ruta que dijera de quién eran. La regla de lectura miraba si alguna factura o
-- algún pago visible apuntaba al archivo, y registrar_pago guardaba la ruta que le llegara: cargando un
-- pago propio con la ruta del comprobante de otra empresa, se podía leer ese comprobante.
--
-- Desde acá:
--   · Los archivos nuevos se guardan en <organización>/<empresa>/… (la organización es su identificador).
--     En las facturas, que se suben antes de saber de qué empresa son, la segunda carpeta es la empresa
--     que eligió quien la subió o "sin-empresa".
--   · Comprobantes de pago nuevos: se leen y se suben por carpeta. Hay que ser de esa organización y ver
--     esa empresa.
--   · Facturas nuevas: hay que ser de la organización de la carpeta y, además, ver el documento o la
--     factura que apunta al archivo (la empresa recién se sabe cuando la IA lo lee).
--   · registrar_pago rechaza una ruta que no sea de la carpeta de la empresa del pago.
--   · Los archivos que ya estaban (rutas sin carpeta de organización) se siguen leyendo como antes: si se
--     ve el pago, la factura o el documento que apunta a ellos. Un comprobante viejo que ya está en un
--     pago de otra empresa no se puede volver a usar.
--   · Las rutas viejas tienen dueño: son de la organización que ya existía cuando no había carpetas (la
--     que da el servicio, es_proveedor). Nadie de otra organización las lee, las sube ni las usa en un
--     pago, aunque conozca la ruta exacta. Y hay un interruptor (acepta_rutas_viejas) para dejar de
--     aceptarlas en pagos y subidas nuevas cuando ya no queden pantallas abiertas con el código anterior.
-- Un cambio para quien ve todas las empresas: antes leía cualquier archivo del depósito, aunque nada
-- apuntara a él. Ahora lee todos los de los pagos, facturas y documentos de su organización (que son
-- todos los que muestra la pantalla); un archivo suelto, sin registro, solo lo ve el servidor.

-- ---------------------------------------------------------------- De quién es una ruta

-- La organización de una ruta nueva (su primera carpeta). Null si es una ruta de antes de las organizaciones.
create or replace function organizacion_de_ruta(p_ruta text)
returns uuid language sql immutable as $$
  select case when split_part(coalesce(p_ruta, ''), '/', 1) ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              then split_part(p_ruta, '/', 1)::uuid end
$$;

-- ¿Se siguen aceptando rutas viejas (sin carpeta de organización) en pagos y subidas NUEVOS? Hace falta
-- mientras haya pantallas abiertas con el código anterior, que suben el comprobante como "año/archivo":
-- entre aplicar esta migración y publicar el código nuevo, y un tiempo después. Para cerrarlo, cuando el
-- código nuevo esté publicado y el equipo haya recargado la pantalla, alcanza con correr:
--   create or replace function acepta_rutas_viejas() returns boolean language sql stable as $f$ select false $f$;
-- Los archivos viejos que ya están en un pago se siguen leyendo igual: esto solo corta los usos nuevos.
create or replace function acepta_rutas_viejas()
returns boolean language sql stable as $$ select true $$;

-- ¿La persona de la sesión es de la organización dueña de los archivos viejos? Todo lo que se guardó sin
-- carpeta de organización es de la organización que ya existía entonces: la que da el servicio.
create or replace function rutas_viejas_son_mias()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select o.es_proveedor from organizaciones o where o.id = organizacion_actual()), false)
$$;

-- Controla la ruta del comprobante de un pago de la empresa p_empresa. Devuelve la ruta limpia (o null).
--   · ruta nueva: tiene que empezar con <organización de la empresa>/<empresa>/;
--   · ruta vieja (la manda una pantalla que quedó abierta desde antes de esta migración): se acepta solo
--     si acepta_rutas_viejas() sigue en verdadero, la empresa es de la organización dueña de los archivos
--     viejos y la ruta no está ya en un pago de otra empresa.
-- Una carpeta ".." o "." no se acepta. Dos puntos seguidos dentro del nombre del archivo sí
-- ("Transferencia 12.11..pdf" es un nombre válido y la pantalla lo deja así).
create or replace function exigir_ruta_de_empresa(p_ruta text, p_empresa text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text := nullif(trim(coalesce(p_ruta, '')), ''); v_carpeta text;
begin
  if v is null then return null; end if;
  if left(v, 1) = '/' or v like '%//%' or string_to_array(v, '/') && array['..', '.'] then
    raise exception 'La ruta del comprobante no es válida';
  end if;
  if organizacion_de_ruta(v) is not null then
    select organizacion_id::text || '/' || id || '/' into v_carpeta from empresas where id = p_empresa;
    if v_carpeta is null or left(v, length(v_carpeta)) <> v_carpeta then
      raise exception 'El comprobante está guardado en la carpeta de otra empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
    end if;
    return v;
  end if;
  -- Ruta vieja.
  if not acepta_rutas_viejas() then
    raise exception 'El comprobante se subió con una versión anterior de la pantalla. Recargá la página y volvé a subirlo.';
  end if;
  -- El mismo mensaje para los dos rechazos: no dice si la ruta existe ni de quién es.
  if not coalesce((select o.es_proveedor from empresas e join organizaciones o on o.id = e.organizacion_id where e.id = p_empresa), false) then
    raise exception 'El comprobante no es de esta empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
  end if;
  if exists (select 1 from pagos where comprobante_path = v and empresa_id <> p_empresa) then
    raise exception 'El comprobante no es de esta empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------- Lectura y subida de archivos

drop policy comprobantes_leer on storage.objects;
create policy comprobantes_leer on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (usuario_actual()).email is not null
         and case when organizacion_de_ruta(name) is not null
                  then organizacion_de_ruta(name) = organizacion_actual() and puede_ver_empresa(split_part(name, '/', 2))
                  else rutas_viejas_son_mias() and exists (select 1 from pagos p where p.comprobante_path = name) end);

-- Subir: a la carpeta de una empresa que veo. Las rutas viejas se aceptan solo de la organización dueña
-- de los archivos viejos y mientras acepta_rutas_viejas() esté en verdadero (por las pantallas que
-- quedaron abiertas). No dan acceso a nada: se leen solo a través de un pago visible.
drop policy comprobantes_subir on storage.objects;
create policy comprobantes_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (usuario_actual()).email is not null
              and case when organizacion_de_ruta(name) is not null
                       then organizacion_de_ruta(name) = organizacion_actual() and puede_ver_empresa(split_part(name, '/', 2))
                       else acepta_rutas_viejas() and rutas_viejas_son_mias() end);

-- Facturas (las sube solo el servidor): de mi organización si la ruta lo dice, y siempre a través de una
-- factura o un documento que veo. Los subselects pasan por las reglas de facturas y documentos (0018).
drop policy facturas_leer on storage.objects;
create policy facturas_leer on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (usuario_actual()).email is not null
         and case when organizacion_de_ruta(name) is not null then organizacion_de_ruta(name) = organizacion_actual()
                  else rutas_viejas_son_mias() end
         and (exists (select 1 from facturas f where f.pdf_path = name)
              or exists (select 1 from documentos d where d.storage_path = name)));

-- ---------------------------------------------------------------- registrar_pago rechaza rutas ajenas
-- Es la función de 0003 con un solo agregado: el control de la ruta del comprobante.

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

  -- El comprobante tiene que estar en la carpeta de esta empresa (0019). Va después de crear el pago para
  -- que quien no ve la empresa reciba el rechazo de siempre y no se entere de nada de la ruta.
  perform exigir_ruta_de_empresa(p_datos ->> 'comprobante_path', e.id);

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

-- ---------------------------------------------------------------- Permisos

revoke execute on function exigir_ruta_de_empresa(text, text) from public, anon, authenticated;
grant execute on function exigir_ruta_de_empresa(text, text) to service_role;
-- organizacion_de_ruta la usan las reglas de los archivos con la sesión de la persona: solo mira el texto de la ruta.
-- Las otras dos también las usan las reglas: una dice verdadero o falso para todos, la otra solo habla de la propia organización.
revoke execute on function organizacion_de_ruta(text), acepta_rutas_viejas(), rutas_viejas_son_mias() from public, anon;
grant execute on function organizacion_de_ruta(text), acepta_rutas_viejas(), rutas_viejas_son_mias() to authenticated, service_role;


-- ======================================== 0020_alias_empresas.sql
-- Tanda B4 · Los nombres de las empresas salen del código y pasan a ser datos.
--
-- Para saber de qué empresa es una factura cuando no trae CUIT del receptor (o al copiar la hoja, que
-- solo trae el nombre), el código buscaba textos escritos a mano: "beratung", "india", "drogueria" y
-- "robles"... Eso solo sirve para las empresas de Vértice, y con otra organización cargada podía asignar
-- la factura de un cliente a una empresa de otro. Desde acá esos textos son columnas de la empresa, y el
-- código compara contra las empresas de la organización del documento y ninguna más.
--
--   alias         Formas en que aparece el nombre de la empresa como RECEPTORA. Un alias puede tener
--                 varias partes unidas con "+": tienen que aparecer todas ("drogueria+robles").
--                 Se compara sin mayúsculas, tildes, espacios ni signos ("Control B" = "controlb").
--   alias_emisor  Lo mismo, pero para el EMISOR: una factura emitida por alguien que coincide se asigna
--                 a esta empresa aunque el receptor diga otra cosa (regla del Apps Script para Robles).
--   alias_orden   Si un texto coincide con más de una empresa, gana la de orden menor.
--
-- Una empresa sin alias se reconoce solo por su CUIT.

alter table empresas add column alias text[] not null default '{}';
alter table empresas add column alias_emisor text[] not null default '{}';
alter table empresas add column alias_orden integer not null default 100;

-- Las 8 empresas de Vértice, con los mismos textos y en el mismo orden en que los buscaba el código
-- (lib/factura.ts y lib/espejo.ts). "robles+daniel" viene de la copia de la hoja: la IA a veces corta
-- "ROBLES, DANIEL HECT".
update empresas e set alias = v.alias, alias_emisor = v.alias_emisor, alias_orden = v.orden
from (values
  ('beratung',     array['beratung'],                        array[]::text[],            10),
  ('india',        array['india'],                           array[]::text[],            20),
  ('controlb',     array['control b'],                       array[]::text[],            30),
  ('ysd',          array['ysd'],                             array[]::text[],            40),
  ('robles',       array['drogueria+robles'],                array['droguer+robles'],    50),
  ('hrobles',      array['robles+hector', 'robles+daniel'],  array['hector+robles'],     60),
  ('farmacontrol', array['farma control'],                   array[]::text[],            70),
  ('vertice',      array['vertice'],                         array[]::text[],            80)
) as v(id, alias, alias_emisor, orden)
where e.id = v.id and e.organizacion_id = (select id from organizaciones where slug = 'vertice');


-- ======================================== 0021_conexiones_erp.sql
-- Tanda C1 · Credenciales de Xubio en la base, cifradas, una fila por empresa.
--
-- Hasta acá las credenciales de Xubio de todas las empresas vivían en una variable de Netlify
-- (XUBIO_CREDS_JSON). Cambiar una obligaba a redesplegar y un cliente nuevo no podía cargar la suya.
-- Desde esta migración pueden vivir acá, cifradas por el servidor antes de guardarlas:
--
--   · El cifrado lo hace la función de Netlify (lib/cifrado.ts, AES-256-GCM) con una clave que vive solo
--     en una variable del servidor (CREDENCIALES_CLAVE). La base nunca ve la credencial en claro ni la clave.
--   · El servidor usa la fila de la empresa si existe; si no, la variable de siempre. Las empresas de hoy
--     siguen andando el día del cambio y se pasan a la base de a una.
--   · Ninguna persona la lee, ni siquiera un administrador: sin permisos para anon ni authenticated y con
--     RLS sin reglas. Solo el servidor (service_role) la lee y la escribe.
--   · El alta la hace el servidor (POST /api/xubio/credenciales): prueba la credencial pidiendo un token a
--     Xubio y recién entonces la cifra y la guarda. La credencial nunca vuelve al navegador ni se escribe
--     en la auditoría ni en xubio_log.

create table conexiones_erp (
  empresa_id      text not null references empresas on delete cascade,
  erp             text not null check (erp in ('XUBIO')),
  -- v1:<huella de la clave>:<iv>:<etiqueta>:<datos>. Solo se acepta ese formato: nunca un texto en claro.
  secreto_cifrado text not null check (secreto_cifrado ~ '^v1:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'),
  -- Los últimos 4 caracteres del identificador, para saber cuál está cargada sin descifrar nada.
  pista           text not null default '' check (length(pista) <= 4),
  verificado_en   timestamptz,
  cargado_por     text not null,
  cargado_en      timestamptz not null default now(),
  primary key (empresa_id, erp)
);

alter table conexiones_erp enable row level security;   -- sin reglas: ninguna sesión de persona lee una fila
revoke all on conexiones_erp from public, anon, authenticated;
grant select, insert, update, delete on conexiones_erp to service_role;

-- Cada alta, reemplazo o baja deja un renglón en la auditoría: quién, cuándo, la empresa y la pista.
-- Nunca el dato cifrado ni la credencial. También si se hace a mano desde el editor SQL.
create or replace function auditar_conexion_erp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila conexiones_erp; v_accion text; v_usuario text;
begin
  if tg_op = 'DELETE' then v_fila := old; else v_fila := new; end if;
  -- Una actualización que no cambia la credencial (por ejemplo, volver a cifrarla con la clave nueva) no se anota.
  if tg_op = 'UPDATE' and new.pista is not distinct from old.pista and new.cargado_en is not distinct from old.cargado_en
     and new.cargado_por is not distinct from old.cargado_por then
    return new;
  end if;
  v_accion := case tg_op when 'INSERT' then 'CREDENCIAL_ERP_CARGADA' when 'UPDATE' then 'CREDENCIAL_ERP_REEMPLAZADA' else 'CREDENCIAL_ERP_BORRADA' end;
  v_usuario := case when tg_op = 'DELETE' then coalesce(nullif(auth.jwt() ->> 'email', ''), session_user::text) else v_fila.cargado_por end;
  insert into auditoria (usuario, accion, entidad, entidad_id, empresa_id, detalle)
  values (v_usuario, v_accion, 'EMPRESA', v_fila.empresa_id, v_fila.empresa_id,
          'Credencial de ' || v_fila.erp || ' (pista ' || coalesce(nullif(v_fila.pista, ''), 'sin pista') || ')');
  return null;
end $$;
create trigger trg_auditar_conexion_erp after insert or update or delete on conexiones_erp for each row execute function auditar_conexion_erp();
revoke execute on function auditar_conexion_erp() from public, anon, authenticated;


-- ======================================== 0022_tokens_integracion.sql
-- Tanda C2 · Secretos por organización para los puentes del Apps Script y las tareas programadas.
--
-- Hasta acá los puentes (copia de la hoja, cartero, ingesta, cheques, flujo) entraban con un solo secreto
-- (INGESTA_TOKEN) que no dice de qué organización es. Con dos organizaciones se detenían (409). Desde acá:
--
--   · Cada organización puede tener secretos propios, uno por tipo de tarea, en tokens_integracion. La base
--     guarda solo el resumen (SHA-256) del secreto, nunca el secreto. Se crean con crear_token_integracion
--     (devuelve el secreto una sola vez) y se revocan con activo = false, sin redesplegar.
--   · INGESTA_TOKEN no se retira: mientras exista la variable, vale para la organización que da el servicio
--     (Vértice, es_proveedor) en todas las tareas. El Apps Script de Vértice no cambia.
--   · El servidor sabe para qué organización trabaja y se lo dice a la base: las funciones de la copia de la
--     hoja, cheques, flujo y subida a Xubio tienen una versión con la organización. Lo que no trae empresa
--     (mails de proveedores, productos, pagos de la hoja sin empresa) queda a nombre de esa organización, y
--     una fila que dice una empresa de otra organización se omite o se rechaza.
--   · Las versiones sin organización siguen existiendo (el código publicado antes de esta tanda las usa) y
--     se comportan como antes mientras haya una sola organización. Con dos, se detienen: no adivinan.

-- ---------------------------------------------------------------- Secretos por organización y tarea

create table tokens_integracion (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  -- Qué puede hacer: INGESTA (cartero de Gmail y Drive, facturas leídas por el Apps Script), COPIA_HOJA
  -- (/api/espejo), CHEQUES (/api/cheques/*), FLUJO (/api/flujo/datos).
  tarea            text not null check (tarea in ('INGESTA', 'COPIA_HOJA', 'CHEQUES', 'FLUJO')),
  nombre           text not null,
  -- SHA-256 del secreto, en hexadecimal. El secreto no se guarda.
  huella           text not null unique check (huella ~ '^[0-9a-f]{64}$'),
  activo           boolean not null default true,
  ultimo_uso       timestamptz,
  creado_por       text not null,
  creado_en        timestamptz not null default now()
);
create index on tokens_integracion (organizacion_id, tarea);
alter table tokens_integracion enable row level security;   -- sin reglas: ninguna sesión de persona lee una fila
revoke all on tokens_integracion from public, anon, authenticated;
grant select, insert, update, delete on tokens_integracion to service_role;

-- Crea un secreto para una organización y una tarea. Devuelve el secreto UNA sola vez: en la base queda
-- solo su resumen. Formato: vti_ + 64 caracteres hexadecimales: el SHA-256 de tres UUID al azar (366 bits
-- al azar de entrada, 256 de salida). Solo para una organización activa.
-- Solo el servidor o el editor SQL de Supabase. Ejemplo:
--   select crear_token_integracion((select id from organizaciones where slug = 'otra'), 'COPIA_HOJA', 'Apps Script de Otra');
create or replace function crear_token_integracion(p_organizacion uuid, p_tarea text, p_nombre text, p_creado_por text default 'SQL')
returns text language plpgsql security definer set search_path = public as $$
declare v_secreto text;
begin
  if not exists (select 1 from organizaciones where id = p_organizacion) then
    raise exception 'La organización % no existe', p_organizacion;
  end if;
  if not exists (select 1 from organizaciones where id = p_organizacion and estado = 'ACTIVA') then
    raise exception 'La organización % no está activa: no se le crean tokens', p_organizacion;
  end if;
  v_secreto := 'vti_' || encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  insert into tokens_integracion (organizacion_id, tarea, nombre, huella, creado_por)
  values (p_organizacion, p_tarea, coalesce(nullif(trim(p_nombre), ''), p_tarea), encode(sha256(convert_to(v_secreto, 'UTF8')), 'hex'), coalesce(p_creado_por, 'SQL'));
  return v_secreto;
end $$;

-- Crear, revocar, reactivar o borrar un token deja un renglón en la auditoría de su organización: quién,
-- cuándo, la tarea y el nombre. Nunca el secreto ni su resumen. Anotar el último uso no se registra.
create or replace function auditar_token_integracion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila tokens_integracion; v_accion text; v_usuario text;
begin
  if tg_op = 'DELETE' then v_fila := old; else v_fila := new; end if;
  if tg_op = 'UPDATE' and new.activo is not distinct from old.activo then return new; end if;
  v_accion := case
    when tg_op = 'INSERT' then 'TOKEN_INTEGRACION_CREADO'
    when tg_op = 'DELETE' then 'TOKEN_INTEGRACION_BORRADO'
    when new.activo then 'TOKEN_INTEGRACION_REACTIVADO'
    else 'TOKEN_INTEGRACION_REVOCADO' end;
  v_usuario := case when tg_op = 'INSERT' then v_fila.creado_por else coalesce(nullif(auth.jwt() ->> 'email', ''), session_user::text) end;
  insert into auditoria (organizacion_id, usuario, accion, entidad, entidad_id, detalle)
  values (v_fila.organizacion_id, v_usuario, v_accion, 'TOKEN_INTEGRACION', v_fila.id::text,
          'Token ' || v_fila.tarea || ' "' || v_fila.nombre || '"');
  return null;
end $$;
create trigger trg_auditar_token_integracion after insert or update or delete on tokens_integracion for each row execute function auditar_token_integracion();

-- ---------------------------------------------------------------- Para qué organización trabaja el servidor

-- La organización que el servidor dijo para este pedido (fijar_organizacion_del_proceso), o null.
-- Vale solo dentro de la transacción del pedido: cada llamada a la API es una transacción aparte.
create or replace function organizacion_del_proceso()
returns uuid language sql stable security definer set search_path = public as $$
  select nullif(current_setting('vertice.organizacion', true), '')::uuid
$$;

-- El servidor dice para qué organización trabaja. Tiene que existir y estar activa.
create or replace function fijar_organizacion_del_proceso(p_organizacion uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_organizacion is null then raise exception 'Falta la organización'; end if;
  if not exists (select 1 from organizaciones where id = p_organizacion and estado = 'ACTIVA') then
    raise exception 'La organización % no existe o no está activa', p_organizacion;
  end if;
  perform set_config('vertice.organizacion', p_organizacion::text, true);
end $$;

-- (0017) Ahora primero mira la organización que dijo el servidor; si no dijo ninguna, la única que haya.
create or replace function organizacion_del_servidor()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  v := coalesce(organizacion_del_proceso(), organizacion_unica());
  if v is null then
    raise exception 'Hay más de una organización y este proceso todavía no sabe para cuál trabaja (falta el secreto por organización)';
  end if;
  return v;
end $$;

-- poner_organizacion (0017): el último recurso pasa a ser la organización que dijo el servidor y, si no
-- dijo ninguna, la única. Es la misma función con ese único cambio. Con sesión de persona sigue mandando
-- la organización de la persona (va antes).
create or replace function poner_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text; v_org uuid; v_lista text[];
begin
  if tg_op = 'UPDATE' then
    if new.organizacion_id is distinct from old.organizacion_id then
      raise exception 'La organización de un registro no se cambia (tabla %)', tg_table_name;
    end if;
    return new;
  end if;

  -- (Los campos propios de una tabla se miran en un "if" aparte: la función sirve para varias tablas.)
  if tg_table_name = 'auditoria' then
    if new.empresa_id is null and coalesce(new.entidad_id, '') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      if new.entidad = 'FACTURA' then select f.empresa_id into new.empresa_id from facturas f where f.id = new.entidad_id::uuid;
      elsif new.entidad = 'PAGO' then select p.empresa_id into new.empresa_id from pagos p where p.id = new.entidad_id::uuid;
      end if;
    end if;
  end if;

  v_empresa := to_jsonb(new) ->> 'empresa_id';
  if v_empresa is not null then
    select organizacion_id into v_org from empresas where id = v_empresa;
    if v_org is not null then
      if new.organizacion_id is null then new.organizacion_id := v_org;
      elsif new.organizacion_id <> v_org then
        raise exception 'La empresa % es de otra organización (tabla %)', v_empresa, tg_table_name;
      end if;
    end if;
  end if;

  if tg_table_name = 'documentos' then
    v_lista := new.empresas_permitidas;
    if new.organizacion_id is null and coalesce(array_length(v_lista, 1), 0) > 0 then
      select organizacion_id into new.organizacion_id from empresas where id = v_lista[1];
    end if;
  end if;

  if new.organizacion_id is null then new.organizacion_id := (usuario_actual()).organizacion_id; end if;
  if new.organizacion_id is null then new.organizacion_id := coalesce(organizacion_del_proceso(), organizacion_unica()); end if;
  if new.organizacion_id is null then
    raise exception 'No se sabe de qué organización es el registro nuevo (tabla %): hay más de una organización y no vino indicada', tg_table_name;
  end if;

  if tg_table_name = 'documentos' and exists (
       select 1 from unnest(coalesce(v_lista, '{}')) x left join empresas e on e.id = x
       where e.id is null or e.organizacion_id <> new.organizacion_id) then
    raise exception 'El documento es para una empresa que no existe o que es de otra organización';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- Copia de la hoja, por organización

-- Las filas que dicen una empresa de otra organización se omiten con el motivo; el resto va a la función
-- de siempre, que deja a nombre de la organización lo que no trae empresa.
create or replace function filas_de_otra_organizacion(p_filas jsonb, p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('fila', x -> 'sheets_fila_origen', 'motivo',
           'La empresa ' || (x ->> 'empresa_id') || ' no existe o es de otra organización')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is not null
    and organizacion_de_empresa(x ->> 'empresa_id') is distinct from p_organizacion
$$;

create or replace function filas_de_la_organizacion(p_filas jsonb, p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is null
     or organizacion_de_empresa(x ->> 'empresa_id') = p_organizacion
$$;

create or replace function espejar_facturas(p_filas jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  r := espejar_facturas(filas_de_la_organizacion(p_filas, p_organizacion));
  return jsonb_set(r, '{omitidas}', filas_de_otra_organizacion(p_filas, p_organizacion) || (r -> 'omitidas'));
end $$;

create or replace function espejar_pagos(p_filas jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  r := espejar_pagos(filas_de_la_organizacion(p_filas, p_organizacion));
  return jsonb_set(r, '{omitidas}', filas_de_otra_organizacion(p_filas, p_organizacion) || (r -> 'omitidas'));
end $$;

-- Los catálogos van en un solo bloque: si alguna parte dice una empresa de otra organización, no se copia nada.
create or replace function espejar_catalogos(p jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ajena text;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  select x ->> 'empresa_id' into v_ajena
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb) || coalesce(p -> 'origen', '[]'::jsonb) || coalesce(p -> 'porEmpresa', '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is not null and organizacion_de_empresa(x ->> 'empresa_id') is distinct from p_organizacion
  limit 1;
  if v_ajena is not null then
    raise exception 'Los catálogos traen la empresa %, que no existe o es de otra organización: no se copió nada', v_ajena;
  end if;
  return espejar_catalogos(p);
end $$;

-- ---------------------------------------------------------------- Cheques, flujo y subida a Xubio, por organización

-- cheques_para_cashflow (0012), solo los pagos de las empresas de la organización.
create or replace function cheques_para_cashflow(p_desde timestamptz, p_organizacion uuid)
returns table (pago_id uuid, empresa_id text, numero text, banco text, tipo_cheque text, medio text, proveedor text,
               importe numeric, emision timestamptz, deposito date, texto text)
language sql stable security definer set search_path = public as $$
  select p.id, p.empresa_id, trim(p.numero_cheque), coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
         coalesce(p.tipo_cheque, ''), p.medio::text, coalesce(pr.nombre, p.proveedor_destino, ''),
         p.importe, p.cargado_en, coalesce(p.fecha_acreditacion, p.fecha),
         coalesce(p.descripcion, '') || ' ' || coalesce(p.observaciones, '')
  from pagos p join empresas e on e.id = p.empresa_id left join proveedores pr on pr.id = p.proveedor_id
  where e.organizacion_id = p_organizacion
    and coalesce(trim(p.numero_cheque), '') <> '' and p.importe > 0 and p.cheque_cashflow is null
    and p.estado::text <> 'ANULADO' and p.gestion = 'SISTEMA'
    and (p.estado = 'CONTABILIZADO' or p.fecha_acreditacion is not null)
    and p.cargado_en >= p_desde
  order by p.cargado_en, p.id
$$;

-- marcar_cheques_cashflow (0012): solo marca pagos de las empresas de la organización.
create or replace function marcar_cheques_cashflow(p jsonb, p_organizacion uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    if coalesce(r ->> 'estado', '') = '' then continue; end if;
    update pagos set cheque_cashflow = left(r ->> 'estado', 300)
    where id = (r ->> 'pago_id')::uuid and cheque_cashflow is null
      and empresa_id in (select e.id from empresas e where e.organizacion_id = p_organizacion);
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- flujo_datos (0012), solo pagos y facturas de las empresas de la organización.
create or replace function flujo_datos(p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pagos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ID_PAGO', coalesce(p.hoja_id, p.id::text),
        'FECHA_PAGO', p.fecha,
        'IMPORTE', p.importe,
        'EMPRESA', e.nombre,
        'REALIZADO_POR', coalesce(p.realizado_por, p.cargado_por, ''),
        'BANCO_ORIGEN', coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
        'CUENTA_ORIGEN', coalesce(p.cuenta_origen, ''),
        'BANCO_DESTINO', coalesce(p.banco_destino, ''),
        'PROVEEDOR_DESTINO', coalesce(pr.nombre, p.proveedor_destino, ''),
        'CUIT_DESTINO', coalesce(pr.cuit, ''),
        'CUENTA_CONTABLE', coalesce(p.cuenta_contable, ''),
        'DESCRIPCION_PAGO', coalesce(p.descripcion, ''),
        'OBSERVACIONES_TESORERIA', coalesce(p.observaciones, ''),
        'NUMERO_CHEQUE', coalesce(p.numero_cheque, ''),
        'TIPO_CHEQUE', coalesce(p.tipo_cheque, case p.medio when 'ECHEQ' then 'ECHEQ' when 'CHEQUE' then 'FISICO' else '' end),
        'FECHA_VTO_CHEQUE', p.fecha_acreditacion,
        'FACTURA_ASOCIADA', coalesce(p.factura_asociada, (
          select string_agg(f.numero::text, ', ') from pagos_facturas pf join facturas f on f.id = pf.factura_id where pf.pago_id = p.id), ''),
        -- ESPERA_FC = pago a un proveedor sin factura todavía (anticipo): descuenta de su proyección.
        'ESTADO_CONTABLE', case
          when p.estado::text = 'ANULADO' then 'ANULADO'
          when p.estado::text in ('CONTABILIZADO', 'CONCILIADO') then 'CONTABILIZADA'
          when p.proveedor_id is not null and p.forma_carga_xubio = 'ORDEN_PAGO'
               and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
               and coalesce(p.factura_asociada, '') = '' then 'ESPERA_FC'
          else 'PENDIENTE' end
      ) order by p.fecha, p.id)
      from pagos p join empresas e on e.id = p.empresa_id left join proveedores pr on pr.id = p.proveedor_id
      where e.organizacion_id = p_organizacion
    ), '[]'::jsonb),
    'facturas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'NUMERO', f.numero,
        'TIPO', f.tipo,
        'RECEPTOR', e.nombre,
        'PROVEEDOR', pr.nombre,
        'CUIT_PROVEEDOR', pr.cuit,
        'FECHA', f.fecha,
        'VENCIMIENTODELPAGO', f.vencimiento,
        'TOTAL', f.total,
        'PORCENTAJE_PAGADO', f.pagado_pct,
        'ESTADO_APROBACION', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA') then 'APROBADA' else f.estado::text end,
        'ESTADO_PAGO', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') then 'PARA_PAGAR' else f.estado::text end,
        'YA_PAGADA_SEGUN_ADMIN', coalesce(f.ya_pagada_segun_admin, ''),
        'METODO_PAGO', case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null
                            then 'CHEQUE ' || f.dias_cheque || ' DIAS' else coalesce(f.metodo_pago::text, '') end,
        'CATEGORIA_CONTABLE', coalesce(f.cuenta_contable, f.categoria_ia, ''),
        'OBSERVACIONES', coalesce(f.advertencia, ''),
        'PRODUCTOSERVICIOPERCEPCION', coalesce(f.codigo_producto, '')
      ) order by f.vencimiento nulls last, f.id)
      from facturas f join empresas e on e.id = f.empresa_id join proveedores pr on pr.id = f.proveedor_id
      where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and e.organizacion_id = p_organizacion
    ), '[]'::jsonb)
  )
$$;

-- facturas_para_xubio (0006), solo las de las empresas de la organización (el subidor recorre organización por organización).
create or replace function facturas_para_xubio(p_max integer, p_organizacion uuid)
returns setof facturas language sql security definer set search_path = public as $$
  select f.* from facturas f join empresas e on e.id = f.empresa_id
  where e.organizacion_id = p_organizacion and e.erp = 'XUBIO' and f.estado_xubio = 'PENDIENTE' and f.xubio_envio_en is null
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA')
  order by f.aprobado_en nulls last
  limit p_max
$$;

-- Las versiones de antes (las usa el código publicado hasta esta tanda): con una sola organización dan lo
-- mismo que siempre; con dos o más se detienen (organizacion_del_servidor), en vez de devolver todo.
create or replace function cheques_para_cashflow(p_desde timestamptz)
returns table (pago_id uuid, empresa_id text, numero text, banco text, tipo_cheque text, medio text, proveedor text,
               importe numeric, emision timestamptz, deposito date, texto text)
language sql stable security definer set search_path = public as $$
  select * from cheques_para_cashflow(p_desde, organizacion_del_servidor())
$$;

create or replace function marcar_cheques_cashflow(p jsonb)
returns integer language sql security definer set search_path = public as $$
  select marcar_cheques_cashflow(p, organizacion_del_servidor())
$$;

create or replace function flujo_datos()
returns jsonb language sql stable security definer set search_path = public as $$
  select flujo_datos(organizacion_del_servidor())
$$;

create or replace function facturas_para_xubio(p_max integer)
returns setof facturas language sql security definer set search_path = public as $$
  select * from facturas_para_xubio(p_max, organizacion_del_servidor())
$$;

-- ---------------------------------------------------------------- Permisos: todo esto es solo del servidor

revoke execute on function auditar_token_integracion() from public, anon, authenticated;
revoke execute on function crear_token_integracion(uuid, text, text, text), organizacion_del_proceso(), fijar_organizacion_del_proceso(uuid),
  filas_de_otra_organizacion(jsonb, uuid), filas_de_la_organizacion(jsonb, uuid),
  espejar_facturas(jsonb, uuid), espejar_pagos(jsonb, uuid), espejar_catalogos(jsonb, uuid),
  cheques_para_cashflow(timestamptz, uuid), marcar_cheques_cashflow(jsonb, uuid), flujo_datos(uuid), facturas_para_xubio(integer, uuid)
  from public, anon, authenticated;
grant execute on function crear_token_integracion(uuid, text, text, text), organizacion_del_proceso(), fijar_organizacion_del_proceso(uuid),
  filas_de_otra_organizacion(jsonb, uuid), filas_de_la_organizacion(jsonb, uuid),
  espejar_facturas(jsonb, uuid), espejar_pagos(jsonb, uuid), espejar_catalogos(jsonb, uuid),
  cheques_para_cashflow(timestamptz, uuid), marcar_cheques_cashflow(jsonb, uuid), flujo_datos(uuid), facturas_para_xubio(integer, uuid)
  to service_role;


-- ======================================== 0023_cuentas_y_unidades.sql
-- Tanda D1 · Sin planillas: unidades del Flujo, cuentas bancarias completas y días hábiles.
--
-- Desde acá la base es la única fuente de datos de Tesorería. Lo que hoy vive en planillas
-- (Cuentas_Extracto, Cuentas Bancarias, Mapa Flujo, FERIADOS de Datos Cheques) pasa a tablas.
--
--   · Unidad = una pestaña del Flujo (Beratung S/Dax, Dax Salud, India, Vértice). Una empresa puede tener
--     varias: Beratung tiene dos. Cada empresa tiene exactamente una unidad "por defecto".
--   · Cuenta bancaria = cuentas_origen ampliada: banco, clase (CC, CA, FCI…), unidad del Flujo, CUIT del
--     banco (para el comprobante de gastos) y si rinde todos los días (Mercado Pago, remunerada).
--   · Feriados: para "lo no pagado pasa al siguiente día hábil".

-- ---------------------------------------------------------------- Unidades del Flujo

create table unidades (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    text not null references empresas,
  codigo        text not null check (codigo ~ '^[a-z][a-z0-9-]{1,39}$'),
  nombre        text not null,
  por_defecto   boolean not null default false,
  orden         integer not null default 100,
  activa        boolean not null default true,
  unique (empresa_id, codigo),
  unique (empresa_id, nombre)
);
create unique index unidades_una_por_defecto on unidades (empresa_id) where por_defecto;

-- Una unidad por empresa, con el nombre corto. Beratung suma Dax Salud (el Flujo las separa).
insert into unidades (empresa_id, codigo, nombre, por_defecto, orden)
select e.id, e.id, case when e.id = 'beratung' then 'Beratung S/Dax' else e.nombre_corto end, true, 10
from empresas e
on conflict do nothing;
insert into unidades (empresa_id, codigo, nombre, por_defecto, orden)
select 'beratung', 'dax-salud', 'Dax Salud', false, 20 where exists (select 1 from empresas where id = 'beratung')
on conflict do nothing;

-- La unidad por defecto de una empresa.
create or replace function unidad_por_defecto(p_empresa text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from unidades where empresa_id = p_empresa and por_defecto
$$;

-- Toda empresa nueva nace con su unidad por defecto.
create or replace function empresa_con_unidad()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into unidades (empresa_id, codigo, nombre, por_defecto, orden)
  values (new.id, regexp_replace(lower(new.id), '[^a-z0-9-]', '-', 'g'), new.nombre_corto, true, 10)
  on conflict do nothing;
  return null;
end $$;
create trigger trg_empresa_con_unidad after insert on empresas for each row execute function empresa_con_unidad();
revoke execute on function empresa_con_unidad() from public, anon, authenticated;

-- ---------------------------------------------------------------- Cuentas bancarias

alter table cuentas_origen add column unidad_id uuid references unidades;
alter table cuentas_origen add column banco text;                       -- HIPOTECARIO, ICBC, BRUBANK, MP…
alter table cuentas_origen add column clase text not null default 'CC'
  check (clase in ('CC', 'CA', 'FCI', 'REMUNERADA', 'BILLETERA', 'CAJA', 'ECHEQ', 'TARJETA'));
alter table cuentas_origen add column numero text;
alter table cuentas_origen add column cbu text check (cbu is null or cbu ~ '^[0-9]{22}$');
alter table cuentas_origen add column moneda text not null default 'ARS';
alter table cuentas_origen add column cuit_banco char(11);              -- emisor del comprobante "Extracto Bancario"
alter table cuentas_origen add column cuenta_contable_id uuid references cuentas_contables;
-- La cuenta de la que sale y a la que vuelve la plata de un FCI o de una remunerada.
alter table cuentas_origen add column cuenta_madre_id uuid references cuentas_origen;
-- Rinde todos los días (Mercado Pago, cuenta remunerada): "Sin movimientos" no es seguro y pide confirmación.
alter table cuentas_origen add column rinde_diario boolean not null default false;
-- Si el control diario la exige todos los días hábiles.
alter table cuentas_origen add column requiere_extracto boolean not null default true;
-- Textos con los que aparece en extractos, comprobantes y en la hoja vieja (mayúsculas, sin tildes).
alter table cuentas_origen add column patrones text[] not null default '{}';
alter table cuentas_origen add column orden integer not null default 100;
alter table cuentas_origen add column activa boolean not null default true;

-- La unidad: la de la empresa salvo que se diga otra (las de Beratung en Hipotecario y MP son de Dax Salud).
update cuentas_origen set unidad_id = unidad_por_defecto(empresa_id) where unidad_id is null;

create or replace function cuenta_origen_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.unidad_id is null then new.unidad_id := unidad_por_defecto(new.empresa_id); end if;
  if not exists (select 1 from unidades u where u.id = new.unidad_id and u.empresa_id = new.empresa_id) then
    raise exception 'La unidad del Flujo es de otra empresa';
  end if;
  if new.cuenta_madre_id is not null and not exists (
       select 1 from cuentas_origen c where c.id = new.cuenta_madre_id and c.empresa_id = new.empresa_id) then
    raise exception 'La cuenta madre es de otra empresa';
  end if;
  new.patrones := array(select distinct upper(trim(x)) from unnest(new.patrones) x where trim(x) <> '');
  return new;
end $$;
create trigger trg_cuenta_origen_consistente before insert or update on cuentas_origen
  for each row execute function cuenta_origen_consistente();
create trigger trg_aislar_cuentas_origen before insert or update or delete on cuentas_origen
  for each row execute function aislar_por_empresa();

-- Los pagos apuntan a la cuenta por id (el texto queda como lo escribió la hoja).
alter table pagos add column cuenta_origen_id uuid references cuentas_origen;
create index on pagos (cuenta_origen_id);

-- ---------------------------------------------------------------- Días hábiles

create table feriados (
  fecha   date primary key,
  nombre  text not null
);

create or replace function es_dia_habil(p_fecha date)
returns boolean language sql stable set search_path = public as $$
  select extract(isodow from p_fecha) < 6 and not exists (select 1 from feriados where fecha = p_fecha)
$$;

-- El primer día hábil desde p_fecha inclusive.
create or replace function dia_habil_desde(p_fecha date)
returns date language plpgsql stable set search_path = public as $$
declare d date := p_fecha;
begin
  while not es_dia_habil(d) loop d := d + 1; end loop;
  return d;
end $$;

-- El día hábil anterior a p_fecha (exclusive): el día que el control diario exige.
create or replace function dia_habil_anterior(p_fecha date)
returns date language plpgsql stable set search_path = public as $$
declare d date := p_fecha - 1;
begin
  while not es_dia_habil(d) loop d := d - 1; end loop;
  return d;
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table unidades enable row level security;
alter table feriados enable row level security;
create policy leer_unidades on unidades for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_feriados on feriados for select to authenticated using ((usuario_actual()).email is not null);
create trigger trg_aislar_unidades before insert or update or delete on unidades
  for each row execute function aislar_por_empresa();

revoke all on unidades, feriados from public, anon, authenticated;
grant select on unidades, feriados to authenticated;
grant all on unidades, feriados to service_role;
revoke execute on function cuenta_origen_consistente() from public, anon, authenticated;
grant execute on function unidad_por_defecto(text), es_dia_habil(date), dia_habil_desde(date), dia_habil_anterior(date)
  to authenticated, service_role;


-- ======================================== 0024_bancos.sql
-- Tanda D2 · Bancos: extractos, reglas, saldos diarios, conciliación, comprobante de gastos y asientos.
--
-- Reemplaza las pestañas Extractos_Movimientos, Extractos_Reglas, Conciliacion_Diaria, Saldos Xubio Historial
-- y Bancos Movimientos. El circuito queda así:
--
--   1. Tesorería sube el archivo del banco. Netlify lo lee (cada banco tiene su formato) y llama a
--      importar_extracto(): guarda el archivo una sola vez (huella), los movimientos sin duplicar y el saldo
--      de cierre de cada día. Cada movimiento se clasifica con las reglas.
--   2. Lo que el banco cobra con factura (comisiones, IVA, percepciones, IIBB) se junta en un comprobante
--      "Extracto Bancario" por banco y día: generar_comprobante_gastos(). Se aprueba como una factura y ya
--      nace pagado (el banco lo debitó), así que no se proyecta como deuda.
--   3. Lo demás que va a Xubio sin comprobante (Ley 25413, rendimientos, FCI) va en un asiento por banco y
--      día: generar_asiento_bancario().
--   4. Un día sin movimientos se marca con marcar_sin_movimientos(): repite el saldo anterior. Una cuenta que
--      rinde todos los días (Mercado Pago, remunerada) pide confirmación explícita.
--   5. La conciliación es una vista: saldo anterior + movimientos = saldo calculado, contra el saldo del banco
--      y contra la última lectura de Xubio. En un FCI la diferencia es el rendimiento del día.

-- ---------------------------------------------------------------- Reglas de clasificación

create table reglas_extracto (
  id                  uuid primary key default gen_random_uuid(),
  organizacion_id     uuid not null references organizaciones,
  empresa_id          text references empresas,           -- null = todas las empresas de la organización
  cuenta_origen_id    uuid references cuentas_origen,     -- null = todos los bancos
  orden               integer not null,
  patrones            text[] not null check (cardinality(patrones) > 0),
  sentido             text not null default 'AMBOS' check (sentido in ('DEBITO', 'CREDITO', 'AMBOS')),
  categoria           text not null check (categoria in ('PAGO', 'COBRO', 'IMPUESTO', 'GASTO_BANCARIO', 'FCI',
                        'FCI_RENDIMIENTO', 'TRANSFERENCIA_PROPIA', 'CHEQUE_PAGADO', 'INTERESES', 'PRESTAMO', 'INFORMATIVO')),
  cuenta_contable     text,                               -- nombre de la cuenta de Xubio (como en facturas)
  -- Dónde termina en Xubio: dentro del comprobante "Extracto Bancario", en el asiento del día, o en nada
  -- (lo registra otro circuito: pagos, cobros, cheques).
  destino_xubio       text not null default 'NINGUNO' check (destino_xubio in ('COMPROBANTE', 'ASIENTO', 'NINGUNO')),
  -- Qué parte del comprobante es: neto gravado, IVA, percepción.
  componente          text check (componente in ('NETO', 'IVA', 'PERCEPCION_IVA', 'PERCEPCION_IIBB')),
  nota                text,
  activa              boolean not null default true,
  creada_por          text,
  creada_en           timestamptz not null default now(),
  check (destino_xubio <> 'COMPROBANTE' or componente is not null)
);
create index on reglas_extracto (organizacion_id, orden);
create trigger trg_organizacion_reglas_extracto before insert or update on reglas_extracto
  for each row execute function poner_organizacion();

-- Las reglas de Extractos_Reglas al 26/11/2026, con el destino que se decidió (19/11 y 20/11):
-- IIBB y percepciones van dentro del comprobante; Ley 25413 y rendimientos, al asiento.
insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota)
select o.id, r.orden, r.patrones, r.sentido, r.categoria, r.cuenta, r.destino, r.componente, r.nota
from organizaciones o cross join (values
  (5,  array['DBCR S DB TASA GRAL'], 'AMBOS', 'IMPUESTO', 'IMPUESTO DEB/CRED BANCARIO', 'ASIENTO', null, 'Aprendida 25/11/2026'),
  (10, array['LEY 25413','25.413','IMP. DEB','IMP DEB','IMP.DEB','IMP. CRED','IMP CRED','IMP.CRED','IMPUESTO DEB','IMPUESTO CRED','DEB/CRED','DB/CR','IDCB','LEY25413','IMP.LEY','IMP S/DEB','IMP S/CRED'],
       'AMBOS', 'IMPUESTO', 'IMPUESTO DEB/CRED BANCARIO', 'ASIENTO', null, 'Impuesto al cheque'),
  (15, array['IIBB TUCUMAN','IB TUCUMAN','PCIA TUCUMAN','FINAN-TUCUMAN','FINAN TUCUMAN','RENTAS TUCUMAN'],
       'AMBOS', 'IMPUESTO', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', 'COMPROBANTE', 'PERCEPCION_IIBB', 'Recaudación IIBB Tucumán (19/11: sin cuenta propia)'),
  (20, array['SIRCREB','IIBB','INGRESOS BRUTOS','ING. BRUTOS','ING BRUTOS','RET. IB','RETENCION IB'],
       'AMBOS', 'IMPUESTO', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', 'COMPROBANTE', 'PERCEPCION_IIBB', 'Retención IIBB bancaria'),
  (30, array['PERCEPCION IVA','PERC. IVA','PERC IVA','RG 2408','RG2408','PERCEP. IVA'],
       'AMBOS', 'IMPUESTO', 'PERCEPCIÓN IVA DE PROVEEDORES', 'COMPROBANTE', 'PERCEPCION_IVA', 'Percepción IVA'),
  (40, array['IVA','I.V.A','I V A'], 'DEBITO', 'IMPUESTO', 'IVA COMPRAS', 'COMPROBANTE', 'IVA', 'IVA sobre comisiones'),
  (50, array['COMISION','COM.','MANTENIMIENTO','MANT.','GASTO','CARGO','SEGURO','CHEQUERA','PAQUETE','SERVICIO DE CUENTA','ABONO'],
       'DEBITO', 'GASTO_BANCARIO', 'GASTOS BANCARIOS', 'COMPROBANTE', 'NETO', 'Gastos y comisiones'),
  (60, array['RENDIMIENTO','RENTA FCI','INTERES FCI','UTILIDAD FCI'], 'AMBOS', 'FCI_RENDIMIENTO', 'Rendimientos FCI', 'ASIENTO', null, 'Rendimiento del fondo'),
  (70, array['FCI','FONDO COMUN','FIMA','SUSCRIPCION','RESCATE','SUPER AHORRO','PIONEER','CUOTAPARTE'],
       'AMBOS', 'FCI', 'Fondos Comun de Inversion Bancos', 'ASIENTO', null, 'Suscripción / rescate de FCI'),
  (80, array['ECHEQ','E-CHEQ','CHEQUE','CH/','CH CAMARA','CH.CAMARA','CLEARING','CLEAR.','CAMARA','CANJE','CHQ'],
       'DEBITO', 'CHEQUE_PAGADO', null, 'NINGUNO', null, 'Cheque propio debitado')
) as r(orden, patrones, sentido, categoria, cuenta, destino, componente, nota)
where o.es_proveedor;

-- Texto comparable: mayúsculas, sin tildes, espacios simples.
create or replace function texto_banco(p text)
returns text language sql immutable as $$
  select regexp_replace(upper(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '\s+', ' ', 'g')
$$;

-- La primera regla que aplica, por orden. Lo más específico (empresa, banco) gana a igual orden.
create or replace function regla_para_movimiento(p_cuenta uuid, p_descripcion text, p_importe numeric)
returns reglas_extracto language sql stable security definer set search_path = public as $$
  select r.* from reglas_extracto r
  join cuentas_origen c on c.id = p_cuenta
  join empresas e on e.id = c.empresa_id
  where r.activa and r.organizacion_id = e.organizacion_id
    and (r.empresa_id is null or r.empresa_id = c.empresa_id)
    and (r.cuenta_origen_id is null or r.cuenta_origen_id = c.id)
    and (r.sentido = 'AMBOS' or (r.sentido = 'DEBITO' and p_importe < 0) or (r.sentido = 'CREDITO' and p_importe > 0))
    and exists (select 1 from unnest(r.patrones) x where position(texto_banco(x) in texto_banco(p_descripcion)) > 0)
  order by r.orden, (r.cuenta_origen_id is null), (r.empresa_id is null)
  limit 1
$$;

-- ---------------------------------------------------------------- Archivos de extracto

create table extractos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid not null references cuentas_origen,
  archivo_nombre    text not null,
  archivo_path      text,                               -- en el bucket privado
  archivo_hash      text not null,                      -- el mismo archivo no entra dos veces
  formato           text,                               -- HIPOTECARIO_CSV, BRUBANK_XLSX, FCI_TENENCIA…
  desde             date,
  hasta             date,
  movimientos       integer not null default 0,
  nuevos            integer not null default 0,
  importado_por     text not null,
  importado_en      timestamptz not null default now(),
  unique (cuenta_origen_id, archivo_hash)
);

-- ---------------------------------------------------------------- Movimientos

-- La clave de antes (cuenta, fecha, importe, referencia) dejaba afuera dos impuestos iguales del mismo
-- día. Ahora cada movimiento tiene su huella, que incluye su posición entre los iguales del día.
alter table movimientos_bancarios drop constraint if exists movimientos_bancarios_cuenta_origen_id_fecha_importe_referencia_key;
alter table movimientos_bancarios alter column cuenta_origen_id set not null;
alter table movimientos_bancarios add column huella text;
alter table movimientos_bancarios add column extracto_id uuid references extractos;
alter table movimientos_bancarios add column orden integer not null default 0;
alter table movimientos_bancarios add column numero_cheque text;
alter table movimientos_bancarios add column categoria text not null default 'SIN_CLASIFICAR'
  check (categoria in ('SIN_CLASIFICAR', 'PAGO', 'COBRO', 'IMPUESTO', 'GASTO_BANCARIO', 'FCI', 'FCI_RENDIMIENTO',
                       'TRANSFERENCIA_PROPIA', 'CHEQUE_PAGADO', 'INTERESES', 'PRESTAMO', 'INFORMATIVO'));
alter table movimientos_bancarios add column cuenta_contable text;
alter table movimientos_bancarios add column regla_id uuid references reglas_extracto on delete set null;
alter table movimientos_bancarios add column destino_xubio text not null default 'NINGUNO'
  check (destino_xubio in ('COMPROBANTE', 'ASIENTO', 'NINGUNO'));
alter table movimientos_bancarios add column componente text check (componente in ('NETO', 'IVA', 'PERCEPCION_IVA', 'PERCEPCION_IIBB'));
-- La otra cuenta propia de un FCI, una remunerada o una transferencia entre cuentas: la conciliación de
-- esa cuenta lo cuenta con el signo cambiado.
alter table movimientos_bancarios add column contraparte_cuenta_id uuid references cuentas_origen;
alter table movimientos_bancarios add column estado text not null default 'A_REVISAR'
  check (estado in ('A_REVISAR', 'PENDIENTE', 'CONTABILIZADO', 'CARGADO_A_MANO', 'INFORMATIVO', 'IGNORADO'));
alter table movimientos_bancarios add column factura_id uuid references facturas;   -- comprobante "Extracto Bancario"
alter table movimientos_bancarios add column revisado_por text;
alter table movimientos_bancarios add column revisado_en timestamptz;
update movimientos_bancarios set huella = 'LEGADO-' || id::text where huella is null;
alter table movimientos_bancarios alter column huella set not null;
alter table movimientos_bancarios add constraint movimientos_bancarios_cuenta_huella_key unique (cuenta_origen_id, huella);
create index on movimientos_bancarios (cuenta_origen_id, fecha);
create index on movimientos_bancarios (empresa_id, estado);

create or replace function movimiento_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
declare c cuentas_origen;
begin
  select * into c from cuentas_origen where id = new.cuenta_origen_id;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  if new.empresa_id is distinct from c.empresa_id then raise exception 'El movimiento es de otra empresa que la cuenta'; end if;
  if new.contraparte_cuenta_id is not null then
    if new.contraparte_cuenta_id = new.cuenta_origen_id then raise exception 'La contraparte no puede ser la misma cuenta'; end if;
    if not exists (select 1 from cuentas_origen x where x.id = new.contraparte_cuenta_id and x.empresa_id = new.empresa_id) then
      raise exception 'La contraparte es de otra empresa (eso es intercompany, no entre cuentas propias)';
    end if;
  end if;
  -- Un movimiento ya contabilizado no cambia de importe, fecha ni cuenta.
  if tg_op = 'UPDATE' and old.estado in ('CONTABILIZADO', 'CARGADO_A_MANO')
     and (new.importe, new.fecha, new.cuenta_origen_id) is distinct from (old.importe, old.fecha, old.cuenta_origen_id) then
    raise exception 'El movimiento ya está contabilizado: no se cambia importe, fecha ni cuenta';
  end if;
  return new;
end $$;
create trigger trg_movimiento_consistente before insert or update on movimientos_bancarios
  for each row execute function movimiento_consistente();
create trigger trg_aislar_movimientos before insert or update or delete on movimientos_bancarios
  for each row execute function aislar_por_empresa();

-- ---------------------------------------------------------------- Saldos de cierre por día

create table saldos_bancarios (
  cuenta_origen_id  uuid not null references cuentas_origen,
  fecha             date not null,
  empresa_id        text not null references empresas,
  saldo             numeric(16,2) not null,
  -- EXTRACTO: lo dice el archivo · TENENCIA: informe del FCI · SIN_MOVIMIENTOS: se repitió el anterior
  -- · MANUAL: lo cargó una persona.
  origen            text not null check (origen in ('EXTRACTO', 'TENENCIA', 'SIN_MOVIMIENTOS', 'MANUAL')),
  extracto_id       uuid references extractos,
  cargado_por       text not null,
  cargado_en        timestamptz not null default now(),
  primary key (cuenta_origen_id, fecha)
);
create trigger trg_aislar_saldos before insert or update or delete on saldos_bancarios
  for each row execute function aislar_por_empresa();

-- Lecturas del saldo en Xubio (reporte Finanzas › Fondos). Se guardan todas: la conciliación usa la última del día.
create table lecturas_xubio (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid references cuentas_origen,      -- null si todavía no se sabe de qué cuenta es
  cuenta_xubio      text not null,
  fecha             date not null,
  saldo             numeric(16,2) not null,
  leido_de          text not null default 'Xubio · Finanzas › Fondos',
  leido_en          timestamptz not null default now(),
  leido_por         text not null
);
create index on lecturas_xubio (cuenta_origen_id, fecha, leido_en desc);
create trigger trg_aislar_lecturas_xubio before insert or update or delete on lecturas_xubio
  for each row execute function aislar_por_empresa();

-- ---------------------------------------------------------------- Asientos (lo que va a Xubio sin comprobante)

create table asientos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid references cuentas_origen,
  fecha             date not null,
  tipo              text not null check (tipo in ('BANCARIO_DIARIO', 'TRANSFERENCIA_PROPIA', 'AJUSTE')),
  descripcion       text not null,
  estado_xubio      estado_xubio not null default 'PENDIENTE',
  xubio_id          text,
  xubio_error       text,
  envio_xubio_en    timestamptz,
  -- Lo que se anula en el sistema se anula también en Xubio (decisión del 25/11), sin paso manual.
  anulado_por       text,
  anulado_en        timestamptz,
  motivo_anulacion  text,
  anulacion_xubio   text check (anulacion_xubio in ('PENDIENTE', 'HECHA', 'ERROR')),
  creado_por        text not null,
  creado_en         timestamptz not null default now(),
  check ((anulado_en is null) = (anulacion_xubio is null))
);
create unique index asientos_uno_por_banco_y_dia on asientos (cuenta_origen_id, fecha)
  where tipo = 'BANCARIO_DIARIO' and anulado_en is null;

create table asiento_lineas (
  id              bigserial primary key,
  asiento_id      uuid not null references asientos on delete cascade,
  cuenta_contable text not null,
  debe            numeric(16,2) not null default 0 check (debe >= 0),
  haber           numeric(16,2) not null default 0 check (haber >= 0),
  detalle         text,
  check ((debe = 0) <> (haber = 0))
);

-- Debe = haber al terminar la transacción.
create or replace function asiento_balanceado()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.asiento_id, old.asiento_id); v_dif numeric;
begin
  select coalesce(sum(debe - haber), 0) into v_dif from asiento_lineas where asiento_id = v_id;
  if v_dif <> 0 then raise exception 'El asiento no balancea (debe - haber = %)', v_dif; end if;
  return null;
end $$;
create constraint trigger trg_asiento_balanceado after insert or update or delete on asiento_lineas
  deferrable initially deferred for each row execute function asiento_balanceado();

alter table movimientos_bancarios add column asiento_id uuid references asientos;
create trigger trg_aislar_asientos before insert or update or delete on asientos
  for each row execute function aislar_por_empresa();

-- Transferencias entre cuentas propias de la misma empresa (las dos patas).
create table transferencias_propias (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  fecha             date not null,
  importe           numeric(16,2) not null check (importe > 0),
  desde_cuenta_id   uuid not null references cuentas_origen,
  hacia_cuenta_id   uuid not null references cuentas_origen,
  mov_salida_id     uuid unique references movimientos_bancarios,
  mov_entrada_id    uuid unique references movimientos_bancarios,
  asiento_id        uuid references asientos,
  anulado_en        timestamptz,
  creado_por        text not null,
  creado_en         timestamptz not null default now(),
  check (desde_cuenta_id <> hacia_cuenta_id)
);
create trigger trg_aislar_transferencias before insert or update or delete on transferencias_propias
  for each row execute function aislar_por_empresa();

-- Pagos: la anulación también se replica en Xubio.
alter table pagos add column anulacion_xubio text check (anulacion_xubio in ('PENDIENTE', 'HECHA', 'ERROR'));
update pagos set anulacion_xubio = 'PENDIENTE' where estado = 'ANULADO' and xubio_id is not null;

-- ---------------------------------------------------------------- Comprobante "Extracto Bancario"

-- La factura que sale del extracto: el banco es el proveedor, nace pagada (ya la debitó).
alter table facturas add column cuenta_origen_extracto_id uuid references cuentas_origen;
create or replace function factura_de_extracto_pagada()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cuenta_origen_extracto_id is not null then
    new.pagado := new.total;
    if new.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') then new.estado := 'PAGADA'; end if;
  end if;
  return new;
end $$;
create trigger trg_factura_de_extracto_pagada before insert or update on facturas
  for each row execute function factura_de_extracto_pagada();

-- ---------------------------------------------------------------- Conciliación (vista)

-- Por cuenta y día con saldo o con movimientos. Saldo calculado = último saldo anterior + movimientos
-- desde ese día (exclusive) hasta este (inclusive). Tolerancia: $1.
create view conciliacion_bancaria with (security_invoker = true) as
with mov as (
  select cuenta_origen_id as cuenta_id, fecha, importe from movimientos_bancarios where estado <> 'IGNORADO'
  union all
  select contraparte_cuenta_id, fecha, -importe from movimientos_bancarios
  where contraparte_cuenta_id is not null and estado <> 'IGNORADO'
), dias as (
  select cuenta_origen_id as cuenta_id, fecha from saldos_bancarios
  union
  select cuenta_id, fecha from mov
), calc as (
  select d.cuenta_id, d.fecha, s.saldo as saldo_extracto, s.origen,
         ant.fecha as fecha_anterior, ant.saldo as saldo_anterior,
         coalesce(m.creditos, 0) as creditos, coalesce(m.debitos, 0) as debitos, coalesce(m.n, 0) as movimientos
  from dias d
  left join saldos_bancarios s on s.cuenta_origen_id = d.cuenta_id and s.fecha = d.fecha
  left join lateral (
    select a.fecha, a.saldo from saldos_bancarios a
    where a.cuenta_origen_id = d.cuenta_id and a.fecha < d.fecha order by a.fecha desc limit 1
  ) ant on true
  left join lateral (
    select sum(importe) filter (where importe > 0) as creditos, -sum(importe) filter (where importe < 0) as debitos, count(*) as n
    from mov x where x.cuenta_id = d.cuenta_id and x.fecha <= d.fecha and (ant.fecha is null or x.fecha > ant.fecha)
  ) m on true
)
select c.empresa_id, c.unidad_id, k.cuenta_id as cuenta_origen_id, c.nombre as cuenta, c.clase, k.fecha,
       k.fecha_anterior, k.saldo_anterior, k.creditos, k.debitos, k.movimientos,
       k.saldo_anterior + k.creditos - k.debitos as saldo_calculado,
       k.saldo_extracto, k.origen,
       round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2) as diferencia,
       -- En un FCI o una remunerada lo que no explican los movimientos es el rendimiento del día.
       case when c.clase in ('FCI', 'REMUNERADA') and k.saldo_anterior is not null and k.saldo_extracto is not null
            then round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2) end as rendimiento,
       x.saldo as saldo_xubio,
       round(k.saldo_extracto - x.saldo, 2) as diferencia_xubio,
       case
         when k.saldo_extracto is null then 'SIN_EXTRACTO'
         when k.origen = 'SIN_MOVIMIENTOS' then 'SIN_MOVIMIENTOS'
         when k.saldo_anterior is null then 'PRIMER_SALDO'
         when c.clase in ('FCI', 'REMUNERADA') then 'OK'
         when abs(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos)) <= 1 then 'OK'
         else 'DIFERENCIA'
       end as estado
from calc k
join cuentas_origen c on c.id = k.cuenta_id
left join lateral (
  select l.saldo from lecturas_xubio l where l.cuenta_origen_id = k.cuenta_id and l.fecha = k.fecha
  order by l.leido_en desc limit 1
) x on true;

-- ---------------------------------------------------------------- Funciones

-- Importa un extracto ya leído por Netlify. Solo el servidor.
-- p: { cuenta_origen_id, archivo: {nombre, path, hash, formato}, usuario,
--      movimientos: [{fecha, descripcion, referencia, importe, saldo, numero_cheque}],
--      saldos: [{fecha, saldo}]  ← cierre de cada día si el banco lo informa (si no, se toma el del último movimiento) }
create or replace function importar_extracto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; v_ext uuid; v_nuevos int := 0; v_total int := 0; m jsonb; r reglas_extracto;
  v_huella text; v_orden int; v_clave text; v_prev text := null; v_id uuid; v_usuario text := coalesce(p->>'usuario', 'servidor');
  v_desde date; v_hasta date;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if coalesce(p->'archivo'->>'hash', '') = '' then raise exception 'Falta la huella del archivo'; end if;

  select id into v_ext from extractos where cuenta_origen_id = c.id and archivo_hash = p->'archivo'->>'hash';
  if v_ext is not null then
    return jsonb_build_object('extracto_id', v_ext, 'repetido', true, 'nuevos', 0);
  end if;
  select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(p->'movimientos') x;
  insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_path, archivo_hash, formato, desde, hasta, importado_por)
  values (c.empresa_id, c.id, p->'archivo'->>'nombre', p->'archivo'->>'path', p->'archivo'->>'hash', p->'archivo'->>'formato',
          v_desde, v_hasta, v_usuario)
  returning id into v_ext;

  -- La huella: fecha|importe|descripción|referencia|n.º de orden entre los iguales. Así un archivo que se
  -- superpone con el anterior no duplica, y dos impuestos iguales del mismo día entran los dos.
  for m in select x from jsonb_array_elements(p->'movimientos') x
           order by x->>'fecha', x->>'importe', x->>'descripcion', coalesce(x->>'referencia', '') loop
    v_total := v_total + 1;
    v_clave := concat_ws('|', m->>'fecha', round((m->>'importe')::numeric, 2), texto_banco(m->>'descripcion'), coalesce(m->>'referencia', ''));
    v_orden := case when v_clave = v_prev then v_orden + 1 else 0 end;
    v_prev := v_clave;
    v_huella := md5(v_clave || '|' || v_orden);
    r := regla_para_movimiento(c.id, m->>'descripcion', (m->>'importe')::numeric);
    insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, referencia, numero_cheque,
                                       huella, extracto_id, orden, categoria, cuenta_contable, regla_id, destino_xubio, componente, estado)
    values (c.empresa_id, c.id, (m->>'fecha')::date, m->>'descripcion', round((m->>'importe')::numeric, 2),
            (m->>'saldo')::numeric, m->>'referencia', nullif(m->>'numero_cheque', ''), v_huella, v_ext, v_orden,
            coalesce(r.categoria, 'SIN_CLASIFICAR'), r.cuenta_contable, r.id, coalesce(r.destino_xubio, 'NINGUNO'), r.componente,
            case when r.id is null then 'A_REVISAR' when r.categoria = 'INFORMATIVO' then 'INFORMATIVO' else 'PENDIENTE' end)
    on conflict (cuenta_origen_id, huella) do nothing
    returning id into v_id;
    if v_id is not null then v_nuevos := v_nuevos + 1; v_id := null; end if;
  end loop;

  -- Saldos de cierre: los que informa el archivo; si no, el saldo del último movimiento de cada día.
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, extracto_id, cargado_por)
  select c.id, d.fecha, c.empresa_id, d.saldo, 'EXTRACTO', v_ext, v_usuario
  from (
    select (x->>'fecha')::date as fecha, (x->>'saldo')::numeric as saldo from jsonb_array_elements(coalesce(p->'saldos', '[]')) x
    union all
    (select distinct on ((t.x->>'fecha')::date) (t.x->>'fecha')::date, (t.x->>'saldo')::numeric
     from jsonb_array_elements(p->'movimientos') with ordinality as t(x, n)
     where t.x->>'saldo' is not null and jsonb_array_length(coalesce(p->'saldos', '[]')) = 0
     order by (t.x->>'fecha')::date, t.n desc)
  ) d
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = 'EXTRACTO', extracto_id = excluded.extracto_id,
        cargado_por = excluded.cargado_por, cargado_en = now()
    where saldos_bancarios.origen <> 'MANUAL';

  update extractos set movimientos = v_total, nuevos = v_nuevos where id = v_ext;
  insert into auditoria (usuario, accion, entidad, entidad_id, detalle, empresa_id)
  values (v_usuario, 'IMPORTAR_EXTRACTO', 'EXTRACTO', v_ext::text, c.nombre || ': ' || v_nuevos || ' nuevos de ' || v_total, c.empresa_id);
  return jsonb_build_object('extracto_id', v_ext, 'repetido', false, 'movimientos', v_total, 'nuevos', v_nuevos);
end $$;

-- Tesorería corrige la clasificación de un movimiento. Con p_aprender, la próxima vez entra solo.
create or replace function reclasificar_movimiento(p_id uuid, p_categoria text, p_cuenta text, p_aprender_patron text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; mv movimientos_bancarios; r reglas_extracto;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into mv from movimientos_bancarios where id = p_id for update;
  if mv.id is null then raise exception 'Movimiento inexistente'; end if;
  perform exigir_empresa(mv.empresa_id);
  if mv.estado in ('CONTABILIZADO', 'CARGADO_A_MANO') then raise exception 'El movimiento ya está contabilizado'; end if;
  if p_aprender_patron is not null and trim(p_aprender_patron) <> '' then
    if position(texto_banco(p_aprender_patron) in texto_banco(mv.descripcion)) = 0 then
      raise exception 'El texto a aprender no está en la descripción del movimiento';
    end if;
    insert into reglas_extracto (empresa_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, nota, creada_por)
    values (mv.empresa_id, 5, array[texto_banco(p_aprender_patron)], case when mv.importe < 0 then 'DEBITO' else 'CREDITO' end,
            p_categoria, p_cuenta,
            case when p_categoria in ('IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES') then 'ASIENTO' else 'NINGUNO' end,
            'Aprendida de ' || u.email || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'), u.email)
    returning * into r;
  end if;
  update movimientos_bancarios set categoria = p_categoria, cuenta_contable = p_cuenta, regla_id = r.id,
    destino_xubio = coalesce(r.destino_xubio, case when p_categoria in ('IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES') then 'ASIENTO' else 'NINGUNO' end),
    estado = 'PENDIENTE', revisado_por = u.email, revisado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'RECLASIFICAR', 'MOVIMIENTO', p_id::text, p_categoria || ' · ' || coalesce(p_cuenta, ''));
end $$;

-- Un día sin movimientos repite el saldo anterior. En una cuenta que rinde todos los días hay que confirmarlo.
create or replace function marcar_sin_movimientos(p_cuenta uuid, p_fecha date, p_confirmo_sin_rendimiento boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare u usuarios; c cuentas_origen; v_saldo numeric; v_desde date;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if c.rinde_diario and not p_confirmo_sin_rendimiento then
    raise exception '% rinde todos los días: subí el extracto o confirmá que no hubo rendimiento', c.nombre;
  end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and estado <> 'IGNORADO') then
    raise exception 'Ese día tiene movimientos: no se puede marcar sin movimientos';
  end if;
  if exists (select 1 from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and origen <> 'SIN_MOVIMIENTOS') then
    raise exception 'Ese día ya tiene saldo del banco';
  end if;
  select saldo, fecha into v_saldo, v_desde from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha < p_fecha
  order by fecha desc limit 1;
  if v_saldo is null then raise exception 'No hay un saldo anterior: cargá el saldo de % a mano', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha > v_desde and fecha < p_fecha and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos entre % y % sin saldo de cierre: subí ese extracto primero', v_desde, p_fecha;
  end if;
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
  values (p_cuenta, p_fecha, c.empresa_id, v_saldo, 'SIN_MOVIMIENTOS', u.email)
  on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, cargado_por = excluded.cargado_por, cargado_en = now();
  perform registrar_auditoria(u, 'SIN_MOVIMIENTOS', 'CUENTA', p_cuenta::text, c.nombre || ' ' || p_fecha || ' · saldo ' || v_saldo || ' (de ' || v_desde || ')');
  return v_saldo;
end $$;

-- Saldo cargado a mano o tenencia de un FCI (informe del fondo).
create or replace function registrar_saldo(p_cuenta uuid, p_fecha date, p_saldo numeric, p_origen text default 'TENENCIA')
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; c cuentas_origen;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if p_origen not in ('TENENCIA', 'MANUAL') then raise exception 'Origen inválido'; end if;
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
  values (p_cuenta, p_fecha, c.empresa_id, round(p_saldo, 2), p_origen, u.email)
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = excluded.origen, cargado_por = excluded.cargado_por, cargado_en = now();
  perform registrar_auditoria(u, 'SALDO_' || p_origen, 'CUENTA', p_cuenta::text, c.nombre || ' ' || p_fecha || ' · ' || p_saldo);
end $$;

-- Junta en un comprobante "Extracto Bancario" lo facturable del banco en el día. Número 09990-AAAAMMDD,
-- proveedor = el banco (por CUIT). Si ya existe y no subió a Xubio, lo actualiza; si ya subió, no lo toca.
create or replace function generar_comprobante_gastos(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; u usuarios; v_prov uuid; f facturas; v_neto numeric; v_iva numeric; v_perc numeric; v_perc_json jsonb;
  v_numero integer := to_char(p_fecha, 'YYYYMMDD')::integer; v_org uuid;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if not es_servidor() then u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if c.cuit_banco is null then raise exception 'Falta el CUIT del banco en la cuenta %', c.nombre; end if;

  select coalesce(sum(-importe) filter (where componente = 'NETO'), 0),
         coalesce(sum(-importe) filter (where componente = 'IVA'), 0),
         coalesce(sum(-importe) filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', componente, 'cuenta', cuenta_contable, 'importe', -importe, 'movimiento', id))
                  filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), '[]')
  into v_neto, v_iva, v_perc, v_perc_json
  from movimientos_bancarios
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';
  if v_neto + v_iva + v_perc = 0 then return null; end if;

  select organizacion_id into v_org from empresas where id = c.empresa_id;
  insert into proveedores (cuit, nombre, organizacion_id) values (c.cuit_banco, coalesce(c.banco, c.nombre), v_org)
  on conflict (organizacion_id, cuit) do nothing;
  select id into v_prov from proveedores where cuit = c.cuit_banco and organizacion_id = v_org;

  select * into f from facturas where empresa_id = c.empresa_id and proveedor_id = v_prov and tipo = 'Extracto Bancario'
    and punto_venta = 9990 and numero = v_numero for update;
  if f.id is not null and f.estado_xubio = 'SUBIDA' then
    raise exception 'El comprobante % ya está en Xubio: no se regenera', '09990-' || v_numero;
  end if;
  if f.id is null then
    insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, vencimiento, neto, iva, percepciones,
                          percepciones_json, total, origen, estado, validacion_ok, cuenta_contable, metodo_pago, cuenta_origen_extracto_id)
    values (c.empresa_id, v_prov, 'Extracto Bancario', 9990, v_numero, p_fecha, p_fecha, v_neto, v_iva, v_perc, v_perc_json,
            v_neto + v_iva + v_perc, 'EXTRACTO', 'PENDIENTE_APROBACION', true, 'GASTOS BANCARIOS', 'DEBITO', c.id)
    returning * into f;
  else
    update facturas set neto = v_neto, iva = v_iva, percepciones = v_perc, percepciones_json = v_perc_json,
      total = v_neto + v_iva + v_perc, estado_xubio = 'PENDIENTE', xubio_error = null, actualizado_en = now()
    where id = f.id returning * into f;
  end if;
  update movimientos_bancarios set factura_id = f.id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';
  return f.id;
end $$;

-- Asiento del día por banco con lo que va a Xubio sin comprobante. Banco contra cada cuenta.
create or replace function generar_asiento_bancario(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; v_id uuid; v_cuenta_banco text; v_usuario text;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if es_servidor() then v_usuario := 'servidor'; else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN')).email; end if;
  select nombre into v_cuenta_banco from cuentas_contables where id = c.cuenta_contable_id;
  if v_cuenta_banco is null then raise exception 'La cuenta % no tiene su cuenta contable de Xubio', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
             and destino_xubio = 'ASIENTO' and cuenta_contable is null and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos del asiento sin cuenta contable: clasificalos primero';
  end if;
  if not exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') then
    return null;
  end if;
  if exists (select 1 from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
             and anulado_en is null and estado_xubio = 'SUBIDA') then
    raise exception 'El asiento de ese día ya está en Xubio: anulalo para rehacerlo';
  end if;
  delete from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null and estado_xubio <> 'SUBIDA';
  insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
  values (c.empresa_id, p_cuenta, p_fecha, 'BANCARIO_DIARIO', 'Movimientos del extracto ' || c.nombre || ' ' || to_char(p_fecha, 'DD/MM/YYYY'), v_usuario)
  returning id into v_id;
  -- Cada cuenta, neta: un débito del banco va al debe de la cuenta y al haber del banco.
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, m.cuenta_contable, greatest(-sum(m.importe), 0), greatest(sum(m.importe), 0), string_agg(distinct m.categoria, ', ')
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  group by m.cuenta_contable having sum(m.importe) <> 0;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, v_cuenta_banco, greatest(sum(m.importe), 0), greatest(-sum(m.importe), 0), 'Banco'
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  having sum(m.importe) <> 0;
  update movimientos_bancarios set asiento_id = v_id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO' and estado <> 'IGNORADO';
  return v_id;
end $$;

-- Resultado del envío a Xubio de un asiento (servidor). Al subir, sus movimientos quedan contabilizados.
create or replace function resultado_asiento_xubio(p_id uuid, p_ok boolean, p_xubio_id text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update asientos set estado_xubio = case when p_ok then 'SUBIDA' else 'ERROR' end::estado_xubio,
    xubio_id = coalesce(p_xubio_id, xubio_id), xubio_error = case when p_ok then null else p_error end, envio_xubio_en = null
  where id = p_id;
  if p_ok then
    update movimientos_bancarios set estado = 'CONTABILIZADO' where asiento_id = p_id and estado in ('PENDIENTE', 'A_REVISAR');
  end if;
end $$;

-- Anular un asiento: se anula en el sistema y queda pendiente de anular en Xubio (lo hace el servidor solo).
create or replace function anular_asiento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; a asientos;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  select * into a from asientos where id = p_id for update;
  if a.id is null then raise exception 'Asiento inexistente'; end if;
  perform exigir_empresa(a.empresa_id);
  if a.anulado_en is not null then raise exception 'El asiento ya está anulado'; end if;
  update asientos set anulado_por = u.email, anulado_en = now(), motivo_anulacion = p_motivo,
    anulacion_xubio = case when a.xubio_id is not null then 'PENDIENTE' else 'HECHA' end
  where id = p_id;
  update movimientos_bancarios set asiento_id = null, estado = 'PENDIENTE' where asiento_id = p_id;
  perform registrar_auditoria(u, 'ANULAR', 'ASIENTO', p_id::text, p_motivo);
end $$;

-- Lectura de saldo de Xubio (servidor o a mano).
create or replace function registrar_lectura_xubio(p_empresa text, p_cuenta_xubio text, p_fecha date, p_saldo numeric, p_usuario text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_cuenta uuid; v_id uuid; v_usuario text;
begin
  perform exigir_empresa(p_empresa);
  if es_servidor() then v_usuario := coalesce(p_usuario, 'servidor');
  else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN')).email; end if;
  select c.id into v_cuenta from cuentas_origen c
  left join cuentas_contables cc on cc.id = c.cuenta_contable_id
  where c.empresa_id = p_empresa and (texto_banco(cc.nombre) = texto_banco(p_cuenta_xubio) or texto_banco(c.nombre) = texto_banco(p_cuenta_xubio))
  limit 1;
  insert into lecturas_xubio (empresa_id, cuenta_origen_id, cuenta_xubio, fecha, saldo, leido_por)
  values (p_empresa, v_cuenta, p_cuenta_xubio, p_fecha, p_saldo, v_usuario) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table reglas_extracto enable row level security;
alter table extractos enable row level security;
alter table saldos_bancarios enable row level security;
alter table lecturas_xubio enable row level security;
alter table asientos enable row level security;
alter table asiento_lineas enable row level security;
alter table transferencias_propias enable row level security;

create policy leer_reglas_extracto on reglas_extracto for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_extractos on extractos for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_saldos on saldos_bancarios for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_lecturas_xubio on lecturas_xubio for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_asientos on asientos for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_asiento_lineas on asiento_lineas for select to authenticated
  using (exists (select 1 from asientos a where a.id = asiento_id));
create policy leer_transferencias on transferencias_propias for select to authenticated using (empresa_id in (select empresas_visibles()));

revoke all on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria from public, anon, authenticated;
grant select on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria to authenticated;
grant all on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria to service_role;
grant usage, select on sequence asiento_lineas_id_seq to service_role;

revoke execute on function importar_extracto(jsonb), resultado_asiento_xubio(uuid, boolean, text, text),
  movimiento_consistente(), asiento_balanceado(), factura_de_extracto_pagada(),
  regla_para_movimiento(uuid, text, numeric) from public, anon, authenticated;
grant execute on function reclasificar_movimiento(uuid, text, text, text), marcar_sin_movimientos(uuid, date, boolean),
  registrar_saldo(uuid, date, numeric, text), generar_comprobante_gastos(uuid, date), generar_asiento_bancario(uuid, date),
  anular_asiento(uuid, text), registrar_lectura_xubio(text, text, date, numeric, text), texto_banco(text)
  to authenticated;


-- ======================================== 0025_cheques_y_cobros.sql
-- Tanda D3 · Cheques emitidos y cobros: reemplazan el Cash Flow de cheques, la pestaña Categoría y Cobros_Xubio.
--
-- Circuito de cheques (26/11): Tesorería paga con cheque o e-cheq → queda EMITIDO (el Flujo lo proyecta en su
-- fecha de pago) → al debitarse, Tesorería lo marca DEBITADO a mano (no depende del extracto) → el Flujo lo
-- pasa a la fecha del débito como real. Un cheque puede cubrir varios pagos del mismo lote.
--
-- Acreedor = el nombre con el que Tesorería agrupa los cheques (la pestaña Categoría del Cash Flow). Con la
-- base, el nombre es único por organización y los alias que antes había que adivinar quedan guardados.

-- ---------------------------------------------------------------- Acreedores

create table acreedores (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  nombre           text not null,
  tipo             text not null default 'PROVEEDOR' check (tipo in ('PROVEEDOR', 'FINANCIERA', 'OTRO')),
  proveedor_id     uuid references proveedores,
  alias            text[] not null default '{}',     -- otras formas en que aparece (beneficiario, Xubio, banco)
  activo           boolean not null default true,
  unique (organizacion_id, nombre)
);
create trigger trg_organizacion_acreedores before insert or update on acreedores
  for each row execute function poner_organizacion();

-- El acreedor de un beneficiario: por proveedor, por nombre exacto o por alias. Sin adivinar: si no hay
-- uno solo, devuelve null y Tesorería lo elige (y queda guardado como alias).
create or replace function acreedor_para(p_org uuid, p_proveedor uuid, p_texto text)
returns uuid language sql stable security definer set search_path = public as $$
  with c as (
    select a.id from acreedores a
    where a.organizacion_id = p_org and a.activo
      and ((p_proveedor is not null and a.proveedor_id = p_proveedor)
           or texto_banco(a.nombre) = texto_banco(p_texto)
           or exists (select 1 from unnest(a.alias) x where texto_banco(x) = texto_banco(p_texto)))
  )
  select case when (select count(*) from c) = 1 then (select id from c) end
$$;

-- ---------------------------------------------------------------- Cheques

create table cheques (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         text not null references empresas,
  cuenta_origen_id   uuid not null references cuentas_origen,      -- chequera / banco que debita
  tipo               text not null check (tipo in ('FISICO', 'ECHEQ', 'PAGARE')),
  numero             text not null,
  acreedor_id        uuid references acreedores,
  proveedor_id       uuid references proveedores,
  beneficiario       text not null,                                -- como figura en el cheque
  importe            numeric(16,2) not null check (importe > 0),
  fecha_emision      date not null,
  fecha_pago         date not null,                                -- fecha de cobro / vencimiento
  estado             text not null default 'EMITIDO'
                       check (estado in ('EMITIDO', 'ENTREGADO', 'DEBITADO', 'ANULADO', 'RECHAZADO')),
  origen             text not null default 'PAGO' check (origen in ('PAGO', 'FINANCIERA', 'MANUAL')),
  debitado_en        date,
  movimiento_id      uuid unique references movimientos_bancarios,
  marcado_por        text,
  marcado_en         timestamptz,
  estado_xubio       estado_xubio not null default 'PENDIENTE',
  xubio_emision_id   text,
  xubio_debito_id    text,
  anulado_por        text,
  anulado_en         timestamptz,
  motivo_anulacion   text,
  anulacion_xubio    text check (anulacion_xubio in ('PENDIENTE', 'HECHA', 'ERROR')),
  observaciones      text,
  creado_por         text not null,
  creado_en          timestamptz not null default now(),
  unique (cuenta_origen_id, tipo, numero),
  check (fecha_pago >= fecha_emision),
  check ((estado = 'DEBITADO') = (debitado_en is not null))
);
create index on cheques (empresa_id, estado, fecha_pago);

create table cheques_pagos (
  cheque_id  uuid not null references cheques on delete cascade,
  pago_id    uuid not null references pagos,
  importe    numeric(16,2) not null check (importe > 0),
  primary key (cheque_id, pago_id)
);

alter table movimientos_bancarios add column cheque_id uuid references cheques;

create or replace function cheque_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from cuentas_origen c where c.id = new.cuenta_origen_id and c.empresa_id = new.empresa_id) then
    raise exception 'La chequera es de otra empresa';
  end if;
  if tg_op = 'UPDATE' and old.estado = 'DEBITADO' and new.estado = 'DEBITADO'
     and (new.importe, new.numero, new.cuenta_origen_id) is distinct from (old.importe, old.numero, old.cuenta_origen_id) then
    raise exception 'El cheque ya se debitó: no se cambia importe, número ni chequera';
  end if;
  return new;
end $$;
create trigger trg_cheque_consistente before insert or update on cheques for each row execute function cheque_consistente();
create trigger trg_aislar_cheques before insert or update or delete on cheques for each row execute function aislar_por_empresa();

-- Emitir un cheque: desde un pago (o un lote de pagos) o a mano (financieras).
-- p: { empresa_id, cuenta_origen_id, tipo, numero, beneficiario, proveedor_id?, acreedor_id?, importe, fecha_emision,
--      fecha_pago, origen?, observaciones?, pagos: [{pago_id, importe}] }
create or replace function emitir_cheque(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_id uuid; v_org uuid; v_acr uuid; v_suma numeric;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  perform exigir_empresa(p->>'empresa_id');
  select organizacion_id into v_org from empresas where id = p->>'empresa_id';
  v_acr := coalesce((p->>'acreedor_id')::uuid, acreedor_para(v_org, (p->>'proveedor_id')::uuid, p->>'beneficiario'));
  insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, proveedor_id, beneficiario, importe,
                       fecha_emision, fecha_pago, origen, observaciones, creado_por)
  values (p->>'empresa_id', (p->>'cuenta_origen_id')::uuid, p->>'tipo', trim(p->>'numero'), v_acr, (p->>'proveedor_id')::uuid,
          trim(p->>'beneficiario'), round((p->>'importe')::numeric, 2), (p->>'fecha_emision')::date, (p->>'fecha_pago')::date,
          coalesce(p->>'origen', 'PAGO'), p->>'observaciones', u.email)
  returning id into v_id;
  insert into cheques_pagos (cheque_id, pago_id, importe)
  select v_id, (x->>'pago_id')::uuid, round((x->>'importe')::numeric, 2) from jsonb_array_elements(coalesce(p->'pagos', '[]')) x;
  if exists (select 1 from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = v_id and pg.empresa_id <> p->>'empresa_id') then
    raise exception 'Un pago del lote es de otra empresa';
  end if;
  select sum(importe) into v_suma from cheques_pagos where cheque_id = v_id;
  if v_suma is not null and v_suma <> round((p->>'importe')::numeric, 2) then
    raise exception 'Los pagos del lote suman % y el cheque es de %', v_suma, p->>'importe';
  end if;
  perform registrar_auditoria(u, 'EMITIR_CHEQUE', 'CHEQUE', v_id::text, (p->>'tipo') || ' ' || (p->>'numero') || ' · ' || (p->>'importe'));
  return v_id;
end $$;

-- Marcar debitado. Pide el número como confirmación: si no coincide con el cheque, no marca nada
-- (lo que en la planilla se hacía releyendo la fila antes de escribir "Pagado").
create or replace function marcar_cheque_debitado(p_id uuid, p_numero text, p_fecha date, p_movimiento uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; ch cheques; mv movimientos_bancarios;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into ch from cheques where id = p_id for update;
  if ch.id is null then raise exception 'Cheque inexistente'; end if;
  perform exigir_empresa(ch.empresa_id);
  if trim(p_numero) is distinct from ch.numero then raise exception 'El número no coincide con el cheque (%): no se marcó', ch.numero; end if;
  if ch.estado not in ('EMITIDO', 'ENTREGADO') then raise exception 'El cheque está %', ch.estado; end if;
  if p_movimiento is not null then
    select * into mv from movimientos_bancarios where id = p_movimiento for update;
    if mv.cuenta_origen_id <> ch.cuenta_origen_id or mv.importe <> -ch.importe then
      raise exception 'El movimiento no es de esa cuenta o no es por el importe del cheque';
    end if;
    update movimientos_bancarios set cheque_id = p_id, categoria = 'CHEQUE_PAGADO', estado = 'PENDIENTE' where id = p_movimiento;
  end if;
  update cheques set estado = 'DEBITADO', debitado_en = p_fecha, movimiento_id = p_movimiento, marcado_por = u.email, marcado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'CHEQUE_DEBITADO', 'CHEQUE', p_id::text, ch.numero || ' · ' || p_fecha);
end $$;

create or replace function anular_cheque(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; ch cheques;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  select * into ch from cheques where id = p_id for update;
  if ch.id is null then raise exception 'Cheque inexistente'; end if;
  perform exigir_empresa(ch.empresa_id);
  if ch.estado = 'DEBITADO' then raise exception 'El cheque ya se debitó: no se anula'; end if;
  update cheques set estado = 'ANULADO', anulado_por = u.email, anulado_en = now(), motivo_anulacion = p_motivo,
    anulacion_xubio = case when xubio_emision_id is not null then 'PENDIENTE' else 'HECHA' end
  where id = p_id;
  perform registrar_auditoria(u, 'ANULAR', 'CHEQUE', p_id::text, p_motivo);
end $$;

-- ---------------------------------------------------------------- Cobros

create table cobros (
  id                     uuid primary key default gen_random_uuid(),
  empresa_id             text not null references empresas,
  cuenta_origen_id       uuid references cuentas_origen,
  fecha                  date not null,
  cliente                text not null,
  cliente_cuit           char(11),
  recibo                 text,
  importe                numeric(16,2) not null check (importe > 0),
  descripcion            text,
  xubio_transaccion_id   text,
  movimiento_id          uuid unique references movimientos_bancarios,
  origen                 text not null default 'XUBIO' check (origen in ('XUBIO', 'EXTRACTO', 'MANUAL')),
  importado_en           timestamptz not null default now(),
  unique (empresa_id, xubio_transaccion_id)
);
create trigger trg_aislar_cobros before insert or update or delete on cobros for each row execute function aislar_por_empresa();
alter table movimientos_bancarios add column cobro_id uuid references cobros;

-- ---------------------------------------------------------------- Seguridad

alter table acreedores enable row level security;
alter table cheques enable row level security;
alter table cheques_pagos enable row level security;
alter table cobros enable row level security;
create policy leer_acreedores on acreedores for select to authenticated using (organizacion_id = organizacion_actual());
create policy leer_cheques on cheques for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_cheques_pagos on cheques_pagos for select to authenticated using (exists (select 1 from cheques c where c.id = cheque_id));
create policy leer_cobros on cobros for select to authenticated using (empresa_id in (select empresas_visibles()));

revoke all on acreedores, cheques, cheques_pagos, cobros from public, anon, authenticated;
grant select on acreedores, cheques, cheques_pagos, cobros to authenticated;
grant all on acreedores, cheques, cheques_pagos, cobros to service_role;
revoke execute on function cheque_consistente(), acreedor_para(uuid, uuid, text) from public, anon, authenticated;
grant execute on function emitir_cheque(jsonb), marcar_cheque_debitado(uuid, text, date, uuid), anular_cheque(uuid, text) to authenticated;


-- ======================================== 0026_flujo.sql
-- Tanda D4 · El Flujo de caja sale de la base: estructura, proyecciones, ajustes y control.
--
-- Reemplaza las pestañas por empresa del Flujo (original y v2), Llave Flujo v2, Mapa Flujo, Gastos Fijos,
-- Proyecciones y Flujo_Cambios_Manuales. Ya no hay una planilla que mantener sincronizada: el Flujo es una
-- consulta (flujo_lineas) sobre lo que ya está en la base.
--
--   REAL        pagos (no anulados, salvo los pagados con cheque) · cheques debitados · cobros ·
--               movimientos del banco que no son un pago, cobro ni cheque (impuestos, gastos, FCI) ·
--               rendimientos de FCI que salen de la conciliación.
--   PROYECTADO  facturas por pagar (con anticipo % + cuenta corriente) · cheques emitidos sin debitar ·
--               proyecciones (únicas o recurrentes: gastos fijos, planes de pago, sueldos, préstamos).
--
-- Reglas (25/11 y 26/11):
--   · Cada línea va a la fila de su cuenta contable (la que tiene asignada en el sistema). Las excepciones
--     (Mapa Flujo, reglas del estudio) son filas de flujo_reglas.
--   · Lo proyectado se puede mover, editar y eliminar; lo real no. Mover una factura cambia su fecha de pago
--     programada, no el vencimiento.
--   · Lo no pagado a término pasa al siguiente día hábil.
--   · Un anticipo pendiente se proyecta para el próximo día hábil; el resto, al vencimiento.
--   · Una factura que se paga con cheque a N días se proyecta a N días de su emisión.

-- ---------------------------------------------------------------- Estructura (filas de cada pestaña)

create table flujo_filas (
  id               uuid primary key default gen_random_uuid(),
  unidad_id        uuid not null references unidades on delete cascade,
  empresa_id       text not null references empresas,
  orden            integer not null,
  tipo             text not null check (tipo in ('SECCION', 'CUENTA', 'APERTURA', 'INTERNO')),
  seccion          text not null check (seccion in ('INGRESOS_OPERATIVOS', 'COSTOS', 'GASTOS_OPERATIVOS', 'IMPUESTOS', 'CAPEX',
                     'INGRESOS_FINANCIEROS', 'TOMA_DEUDA', 'DEVOLUCION_DEUDA', 'SOCIOS', 'INTERCOMPANY', 'ENTRE_CUENTAS', 'SIN_CLASIFICAR')),
  etiqueta         text not null,
  cuenta_contable  text,                    -- cuenta de Xubio (la llave del Flujo v2)
  apertura         text,                    -- proveedor, plan de pago o concepto dentro de la cuenta
  padre_id         uuid references flujo_filas,
  -- false: no cambia la caja total (entre cuentas propias, suscripción o rescate de FCI).
  mueve_caja       boolean not null default true,
  activa           boolean not null default true,
  unique (unidad_id, etiqueta)
);
create index on flujo_filas (unidad_id, cuenta_contable);

create or replace function fila_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select empresa_id into new.empresa_id from unidades where id = new.unidad_id;
  if new.padre_id is not null and not exists (select 1 from flujo_filas f where f.id = new.padre_id and f.unidad_id = new.unidad_id) then
    raise exception 'La fila padre es de otra unidad';
  end if;
  return new;
end $$;
create trigger trg_fila_consistente before insert or update on flujo_filas for each row execute function fila_consistente();

-- Filas que toda unidad necesita: una por sección, "Sin clasificar", "Entre cuentas propias" y rendimientos.
create or replace function crear_filas_base(p_unidad uuid)
returns void language sql security definer set search_path = public as $$
  insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, mueve_caja)
  select p_unidad, u.empresa_id, s.orden, s.tipo, s.seccion, s.etiqueta, s.cuenta, s.mueve
  from unidades u cross join (values
    (100,  'SECCION', 'INGRESOS_OPERATIVOS',  '1. INGRESOS OPERATIVOS', null::text, true),
    (200,  'SECCION', 'COSTOS',               '2. COSTOS', null, true),
    (300,  'SECCION', 'GASTOS_OPERATIVOS',    '3. GASTOS OPERATIVOS', null, true),
    (400,  'SECCION', 'IMPUESTOS',            '4. IMPUESTOS OPERATIVOS', null, true),
    (500,  'SECCION', 'CAPEX',                '5. CAPEX / IMPUESTO A LAS GANANCIAS', null, true),
    (600,  'SECCION', 'INGRESOS_FINANCIEROS', '6. INGRESOS FINANCIEROS', null, true),
    (610,  'CUENTA',  'INGRESOS_FINANCIEROS', 'Rendimientos FCI', 'Rendimientos FCI', true),
    (700,  'SECCION', 'TOMA_DEUDA',           '7. TOMA DE DEUDA', null, true),
    (800,  'SECCION', 'DEVOLUCION_DEUDA',     '8. DEVOLUCIÓN DE DEUDA', null, true),
    (900,  'SECCION', 'SOCIOS',               '9. SOCIOS (retiros y aportes)', null, true),
    (1000, 'SECCION', 'INTERCOMPANY',         '10. INTERCOMPANY Y OTROS MOVIMIENTOS', null, true),
    (1100, 'INTERNO', 'ENTRE_CUENTAS',        'Entre cuentas propias', null, false),
    (9999, 'INTERNO', 'SIN_CLASIFICAR',       'Sin clasificar', null, true)
  ) as s(orden, tipo, seccion, etiqueta, cuenta, mueve)
  where u.id = p_unidad
  on conflict (unidad_id, etiqueta) do nothing
$$;
select crear_filas_base(id) from unidades;

create or replace function unidad_con_filas()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform crear_filas_base(new.id); return null; end $$;
create trigger trg_unidad_con_filas after insert on unidades for each row execute function unidad_con_filas();

create or replace function fila_especial(p_unidad uuid, p_seccion text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from flujo_filas where unidad_id = p_unidad and seccion = p_seccion and tipo = 'INTERNO' order by orden limit 1
$$;

-- ---------------------------------------------------------------- Reglas de destino (excepciones)

create table flujo_reglas (
  id                   uuid primary key default gen_random_uuid(),
  organizacion_id      uuid not null references organizaciones,
  empresa_id           text references empresas,
  prioridad            integer not null default 100,
  -- Condiciones (todas las que no son null tienen que cumplirse).
  si_origen            text check (si_origen in ('PAGO', 'FACTURA', 'CHEQUE', 'COBRO', 'MOVIMIENTO', 'RENDIMIENTO', 'PROYECCION')),
  si_proveedor_id      uuid references proveedores,
  si_cuenta_contable   text,
  si_cuenta_origen_id  uuid references cuentas_origen,
  si_categoria         text,                -- categoría del movimiento bancario
  si_texto             text,                -- contenido en la descripción / beneficiario / cliente
  -- Resultado.
  unidad_id            uuid references unidades,
  fila_id              uuid references flujo_filas,
  excluir              boolean not null default false,   -- no va al Flujo (p. ej., transferencia propia duplicada)
  nota                 text,
  creada_por           text,
  creada_en            timestamptz not null default now(),
  check (excluir or fila_id is not null or unidad_id is not null)
);
create trigger trg_organizacion_flujo_reglas before insert or update on flujo_reglas
  for each row execute function poner_organizacion();

-- Dónde va una línea: primero las reglas (por prioridad); si no, la fila de su cuenta contable en su unidad
-- (la apertura del proveedor si existe, si no la cuenta); si no, "Sin clasificar".
create or replace function flujo_destino(p_empresa text, p_unidad uuid, p_origen text, p_proveedor uuid,
                                         p_cuenta_contable text, p_cuenta_origen uuid, p_categoria text, p_texto text)
returns table (unidad_id uuid, fila_id uuid, excluir boolean)
language plpgsql stable security definer set search_path = public as $$
declare r flujo_reglas; v_unidad uuid; v_fila uuid; v_prov text;
begin
  select x.* into r from flujo_reglas x join empresas e on e.id = p_empresa
  where x.organizacion_id = e.organizacion_id and (x.empresa_id is null or x.empresa_id = p_empresa)
    and (x.si_origen is null or x.si_origen = p_origen)
    and (x.si_proveedor_id is null or x.si_proveedor_id = p_proveedor)
    and (x.si_cuenta_contable is null or texto_banco(x.si_cuenta_contable) = texto_banco(p_cuenta_contable))
    and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = p_cuenta_origen)
    and (x.si_categoria is null or x.si_categoria = p_categoria)
    and (x.si_texto is null or position(texto_banco(x.si_texto) in texto_banco(p_texto)) > 0)
  order by x.prioridad, (x.empresa_id is null) limit 1;
  if r.id is not null and r.excluir then return query select null::uuid, null::uuid, true; return; end if;
  v_unidad := coalesce(r.unidad_id, p_unidad, unidad_por_defecto(p_empresa));
  v_fila := r.fila_id;
  if v_fila is null and p_cuenta_contable is not null then
    select nombre into v_prov from proveedores where id = p_proveedor;
    select f.id into v_fila from flujo_filas f
    where f.unidad_id = v_unidad and f.activa and f.tipo in ('CUENTA', 'APERTURA')
      and texto_banco(f.cuenta_contable) = texto_banco(p_cuenta_contable)
      and (f.tipo = 'CUENTA' or (v_prov is not null and position(texto_banco(f.apertura) in texto_banco(v_prov)) > 0))
    order by (f.tipo = 'APERTURA') desc, f.orden limit 1;
  end if;
  if v_fila is null then v_fila := fila_especial(v_unidad, 'SIN_CLASIFICAR'); end if;
  return query select v_unidad, v_fila, false;
end $$;

-- ---------------------------------------------------------------- Facturas: unidad y anticipo

alter table facturas add column unidad_id uuid references unidades;
alter table facturas add column anticipo_pct numeric(5,2) check (anticipo_pct > 0 and anticipo_pct < 100);

-- ---------------------------------------------------------------- Proyecciones (únicas y recurrentes)

create table proyecciones (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          text not null references empresas,
  unidad_id           uuid not null references unidades,
  fila_id             uuid not null references flujo_filas,
  concepto            text not null,
  proveedor_id        uuid references proveedores,
  -- Con signo: negativo = egreso, positivo = ingreso.
  importe             numeric(16,2) not null check (importe <> 0),
  fecha_inicio        date not null,
  recurrencia         text not null default 'UNICA' check (recurrencia in ('UNICA', 'SEMANAL', 'QUINCENAL', 'MENSUAL')),
  dia_mes             integer check (dia_mes between 1 and 31),
  hasta               date,
  cuotas              integer check (cuotas > 0),
  ajuste_pct_mensual  numeric(6,3) not null default 0,       -- ej. 2,5 = +2,5 % por mes
  estado              text not null default 'ACTIVA' check (estado in ('ACTIVA', 'PAUSADA', 'CANCELADA')),
  origen              text not null default 'MANUAL' check (origen in ('MANUAL', 'GASTO_FIJO', 'PLAN_PAGO', 'PRESTAMO', 'SUELDOS', 'COBRANZA')),
  nota                text,
  creado_por          text not null,
  creado_en           timestamptz not null default now(),
  cancelado_por       text,
  cancelado_en        timestamptz,
  check (recurrencia = 'UNICA' or hasta is not null or cuotas is not null),
  check (recurrencia <> 'MENSUAL' or dia_mes is not null)
);

create or replace function proyeccion_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from flujo_filas f join unidades u on u.id = f.unidad_id
                 where f.id = new.fila_id and f.unidad_id = new.unidad_id and u.empresa_id = new.empresa_id) then
    raise exception 'La fila no es de esa unidad o la unidad no es de esa empresa';
  end if;
  return new;
end $$;
create trigger trg_proyeccion_consistente before insert or update on proyecciones for each row execute function proyeccion_consistente();

-- Las fechas de una proyección entre dos días. Mensual: el día del mes (o el último si el mes es corto).
-- El ajuste mensual se compone desde el inicio. La fecha que cuenta para el Flujo es el día hábil siguiente.
create or replace function proyeccion_ocurrencias(p proyecciones, p_desde date, p_hasta date)
returns table (ocurrencia date, fecha date, importe numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_fin date; n integer := 0; d date; v_mes date;
begin
  v_fin := least(p_hasta, coalesce(p.hasta, p_hasta));
  if p.recurrencia = 'UNICA' then
    if p.fecha_inicio between p_desde and v_fin then
      return query select p.fecha_inicio, dia_habil_desde(p.fecha_inicio), p.importe;
    end if;
    return;
  end if;
  v_mes := date_trunc('month', p.fecha_inicio)::date;
  loop
    if p.recurrencia = 'MENSUAL' then
      d := least(v_mes + (p.dia_mes - 1), (v_mes + interval '1 month - 1 day')::date);
      v_mes := (v_mes + interval '1 month')::date;
      if d < p.fecha_inicio then continue; end if;
    elsif p.recurrencia = 'SEMANAL' then d := p.fecha_inicio + 7 * n;
    else d := p.fecha_inicio + 14 * n;
    end if;
    exit when d > v_fin or (p.cuotas is not null and n >= p.cuotas);
    if d >= p_desde then
      return query select d, dia_habil_desde(d),
        round(p.importe * power(1 + p.ajuste_pct_mensual / 100,
              (extract(year from age(d, p.fecha_inicio)) * 12 + extract(month from age(d, p.fecha_inicio)))::numeric), 2);
    end if;
    n := n + 1;
    exit when n > 400;
  end loop;
end $$;

-- ---------------------------------------------------------------- Ajustes a lo proyectado

-- Mover, cambiar el importe o eliminar UNA línea proyectada. Lo real no se toca.
--   FACTURA     ocurrencia 'ANTICIPO' o 'SALDO'   (mover el SALDO cambia facturas.fecha_pago, no se guarda acá)
--   CHEQUE      ocurrencia 'CHEQUE'
--   PROYECCION  ocurrencia = la fecha calculada (aaaa-mm-dd)
create table flujo_ajustes (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      text not null references empresas,
  origen_tipo     text not null check (origen_tipo in ('FACTURA', 'CHEQUE', 'PROYECCION')),
  origen_id       uuid not null,
  ocurrencia      text not null,
  fecha_nueva     date,
  importe_nuevo   numeric(16,2) check (importe_nuevo > 0),  -- en positivo; el signo lo pone la línea
  eliminada       boolean not null default false,
  motivo          text not null,
  creado_por      text not null,
  creado_en       timestamptz not null default now(),
  reemplazado_en  timestamptz,                              -- historial: el ajuste vigente es el que no tiene fecha
  check (eliminada or fecha_nueva is not null or importe_nuevo is not null)
);
create unique index flujo_ajustes_vigente on flujo_ajustes (origen_tipo, origen_id, ocurrencia) where reemplazado_en is null;

-- ---------------------------------------------------------------- Las líneas del Flujo (vista)

create view flujo_lineas with (security_invoker = true) as
with base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque)
  select p.empresa_id, coalesce(co.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, p.fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, p.cuenta_origen_id, null::text as categoria, false as vencido
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  union all
  -- REAL · cheques debitados
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros
  select cb.empresa_id, co.unidad_id, 'COBRO', cb.id, 'COBRO', cb.fecha, cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', cb.cuenta_origen_id, null, false
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  union all
  -- REAL · movimientos del banco que no son pago, cobro ni cheque (impuestos, gastos, FCI, intereses…)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.categoria not in ('PAGO', 'COBRO', 'CHEQUE_PAGADO')
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, 'FACTURA', f.id, t.ocurrencia, t.fecha, -t.importe, 'PROYECTADO',
         pr.nombre, f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0'),
         f.proveedor_id, f.cuenta_contable, null, null, false
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join lateral (
    select a.*, round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) as anticipo_total from (select 1) z
    cross join lateral (select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend) a
  ) q
  cross join lateral (values
    ('ANTICIPO', dia_habil_desde(greatest(f.fecha, current_date + 1)), q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  select b.empresa_id, d.unidad_id, d.fila_id, d.excluir, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto
  from base b
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- Control: caja del Flujo contra bancos

-- Por unidad y día con saldos completos (todas sus cuentas activas con saldo ese día): el cambio en los saldos
-- de los bancos tiene que ser igual a lo real que pasó entre el día anterior con saldos y este. Tolerancia $1.
create view flujo_control with (security_invoker = true) as
with cuentas as (
  select unidad_id, count(*) as n from cuentas_origen where activa and requiere_extracto group by unidad_id
), dias as (
  select co.unidad_id, s.fecha, sum(s.saldo) as saldo_bancos, count(*) as con_saldo
  from saldos_bancarios s join cuentas_origen co on co.id = s.cuenta_origen_id
  where co.activa and co.requiere_extracto
  group by co.unidad_id, s.fecha
), completos as (
  select d.*, c.n, d.con_saldo = c.n as completo,
         lag(d.fecha) over (partition by d.unidad_id order by d.fecha) as fecha_anterior,
         lag(d.saldo_bancos) over (partition by d.unidad_id order by d.fecha) as saldo_anterior
  from dias d join cuentas c on c.unidad_id = d.unidad_id
  where d.con_saldo = c.n
)
select u.empresa_id, k.unidad_id, u.nombre as unidad, k.fecha, k.fecha_anterior, k.saldo_anterior, k.saldo_bancos,
       r.movido as real_del_periodo,
       round(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0), 2) as diferencia,
       case when k.saldo_anterior is null then 'PRIMER_SALDO'
            when abs(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0)) <= 1 then 'OK'
            else 'F' end as estado
from completos k
join unidades u on u.id = k.unidad_id
left join lateral (
  select sum(l.importe) as movido from flujo_lineas l
  where l.unidad_id = k.unidad_id and l.naturaleza = 'REAL' and l.fecha > k.fecha_anterior and l.fecha <= k.fecha
) r on true;

-- ---------------------------------------------------------------- Acciones sobre el Flujo

-- Lo proyectado sigue proyectado: la factura no está pagada, el cheque no se debitó, la proyección está activa.
create or replace function linea_proyectada_de(p_tipo text, p_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_empresa text; v_ok boolean;
begin
  if p_tipo = 'FACTURA' then
    select empresa_id, estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and cuenta_origen_extracto_id is null into v_empresa, v_ok from facturas where id = p_id;
  elsif p_tipo = 'CHEQUE' then
    select empresa_id, estado in ('EMITIDO', 'ENTREGADO') into v_empresa, v_ok from cheques where id = p_id;
  elsif p_tipo = 'PROYECCION' then
    select empresa_id, estado = 'ACTIVA' into v_empresa, v_ok from proyecciones where id = p_id;
  else
    raise exception 'Lo real (pagos, débitos, cobros, movimientos) no se edita desde el Flujo';
  end if;
  if v_empresa is null then raise exception 'La línea no existe'; end if;
  if not v_ok then raise exception 'La línea ya no está proyectada (está pagada, debitada o cancelada)'; end if;
  perform exigir_empresa(v_empresa);
  return v_empresa;
end $$;

create or replace function ajustar_linea_flujo(p_tipo text, p_id uuid, p_ocurrencia text, p_fecha date, p_importe numeric,
                                               p_eliminar boolean, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_empresa text; v_prev flujo_ajustes;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  v_empresa := linea_proyectada_de(p_tipo, p_id);
  if p_tipo = 'FACTURA' and p_ocurrencia not in ('ANTICIPO', 'SALDO') then raise exception 'Ocurrencia de factura inválida'; end if;
  if p_tipo = 'CHEQUE' and p_ocurrencia <> 'CHEQUE' then raise exception 'Ocurrencia de cheque inválida'; end if;
  if p_fecha is not null and p_fecha < current_date then raise exception 'No se proyecta en el pasado'; end if;

  -- Mover el saldo de una factura = cambiar su fecha de pago programada (la ven también Pagos y Vencimientos).
  if p_tipo = 'FACTURA' and p_ocurrencia = 'SALDO' and p_fecha is not null and not coalesce(p_eliminar, false) then
    update facturas set fecha_pago = p_fecha, actualizado_en = now() where id = p_id;
    p_fecha := null;
    if p_importe is null then
      perform registrar_auditoria(u, 'FLUJO_MOVER', 'FACTURA', p_id::text, 'Fecha de pago ' || to_char(current_date, 'DD/MM/YYYY') || ' · ' || p_motivo);
      return;
    end if;
  end if;

  select * into v_prev from flujo_ajustes where origen_tipo = p_tipo and origen_id = p_id and ocurrencia = p_ocurrencia
    and reemplazado_en is null for update;
  if v_prev.id is not null then update flujo_ajustes set reemplazado_en = now() where id = v_prev.id; end if;
  insert into flujo_ajustes (empresa_id, origen_tipo, origen_id, ocurrencia, fecha_nueva, importe_nuevo, eliminada, motivo, creado_por)
  values (v_empresa, p_tipo, p_id, p_ocurrencia,
          coalesce(p_fecha, case when not coalesce(p_eliminar, false) then v_prev.fecha_nueva end),
          coalesce(abs(p_importe), case when not coalesce(p_eliminar, false) then v_prev.importe_nuevo end),
          coalesce(p_eliminar, false), p_motivo, u.email);
  perform registrar_auditoria(u, case when p_eliminar then 'FLUJO_ELIMINAR' else 'FLUJO_AJUSTAR' end, p_tipo, p_id::text,
                              p_ocurrencia || ' · ' || coalesce(p_fecha::text, '') || ' · ' || coalesce(p_importe::text, '') || ' · ' || p_motivo);
end $$;

-- Volver una línea a como la calcula el sistema.
create or replace function restaurar_linea_flujo(p_tipo text, p_id uuid, p_ocurrencia text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  perform linea_proyectada_de(p_tipo, p_id);
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = p_tipo and origen_id = p_id and ocurrencia = p_ocurrencia and reemplazado_en is null;
  perform registrar_auditoria(u, 'FLUJO_RESTAURAR', p_tipo, p_id::text, p_ocurrencia);
end $$;

-- Alta de una proyección (puntual o recurrente). p: columnas de proyecciones.
create or replace function crear_proyeccion(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_id uuid;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  perform exigir_empresa(p->>'empresa_id');
  insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, proveedor_id, importe, fecha_inicio, recurrencia, dia_mes,
                            hasta, cuotas, ajuste_pct_mensual, origen, nota, creado_por)
  values (p->>'empresa_id', (p->>'unidad_id')::uuid, (p->>'fila_id')::uuid, p->>'concepto', (p->>'proveedor_id')::uuid,
          round((p->>'importe')::numeric, 2), (p->>'fecha_inicio')::date, coalesce(p->>'recurrencia', 'UNICA'),
          (p->>'dia_mes')::integer, (p->>'hasta')::date, (p->>'cuotas')::integer, coalesce((p->>'ajuste_pct_mensual')::numeric, 0),
          coalesce(p->>'origen', 'MANUAL'), p->>'nota', u.email)
  returning id into v_id;
  perform registrar_auditoria(u, 'CREAR', 'PROYECCION', v_id::text, (p->>'concepto') || ' · ' || (p->>'importe'));
  return v_id;
end $$;

create or replace function cancelar_proyeccion(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_empresa text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  select empresa_id into v_empresa from proyecciones where id = p_id;
  if v_empresa is null then raise exception 'Proyección inexistente'; end if;
  perform exigir_empresa(v_empresa);
  update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
  where id = p_id;
  perform registrar_auditoria(u, 'CANCELAR', 'PROYECCION', p_id::text, p_motivo);
end $$;

-- Forma de pago de una factura: cuenta corriente, anticipado, o anticipo % + cuenta corriente.
create or replace function definir_pago_factura(p_id uuid, p_tipo_pago text, p_anticipo_pct numeric default null, p_unidad uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  perform exigir_empresa(f.empresa_id);
  if p_tipo_pago not in ('CUENTA_CORRIENTE', 'ANTICIPADO', 'ANTICIPO_PARCIAL') then raise exception 'Forma de pago inválida'; end if;
  if (p_tipo_pago = 'ANTICIPO_PARCIAL') <> (p_anticipo_pct is not null) then
    raise exception 'El porcentaje va solo con "Anticipo %% + Cta. Cte."';
  end if;
  if p_unidad is not null and not exists (select 1 from unidades where id = p_unidad and empresa_id = f.empresa_id) then
    raise exception 'La unidad es de otra empresa';
  end if;
  update facturas set tipo_pago = p_tipo_pago, anticipo_pct = p_anticipo_pct, unidad_id = coalesce(p_unidad, unidad_id), actualizado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'FORMA_PAGO', 'FACTURA', p_id::text, p_tipo_pago || coalesce(' ' || p_anticipo_pct || ' %', ''));
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table flujo_filas enable row level security;
alter table flujo_reglas enable row level security;
alter table proyecciones enable row level security;
alter table flujo_ajustes enable row level security;
create policy leer_flujo_filas on flujo_filas for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_flujo_reglas on flujo_reglas for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_proyecciones on proyecciones for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_flujo_ajustes on flujo_ajustes for select to authenticated using (empresa_id in (select empresas_visibles()));
create trigger trg_aislar_flujo_filas before insert or update or delete on flujo_filas for each row execute function aislar_por_empresa();
create trigger trg_aislar_proyecciones before insert or update or delete on proyecciones for each row execute function aislar_por_empresa();
create trigger trg_aislar_flujo_ajustes before insert or update or delete on flujo_ajustes for each row execute function aislar_por_empresa();

revoke all on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control from public, anon, authenticated;
grant select on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control to authenticated;
grant all on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control to service_role;

revoke execute on function fila_consistente(), crear_filas_base(uuid), unidad_con_filas(), proyeccion_consistente(),
  linea_proyectada_de(text, uuid) from public, anon, authenticated;
grant execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text), fila_especial(uuid, text),
  proyeccion_ocurrencias(proyecciones, date, date),
  ajustar_linea_flujo(text, uuid, text, date, numeric, boolean, text), restaurar_linea_flujo(text, uuid, text),
  crear_proyeccion(jsonb), cancelar_proyeccion(uuid, text), definir_pago_factura(uuid, text, numeric, uuid)
  to authenticated;


-- ======================================== 0027_operacion.sql
-- Tanda D5 · Operación sin planillas: control diario, registro de robots, bloqueos y catálogos chicos.
--
-- Reemplaza Control_Diario_Bancos, Robot_Echeqs_Log, Robot_Debitos_Log, Xubio_Pagos_Log,
-- Historial_Correcciones_IA y Catalogo_Percepciones_IIBB. El control diario es una vista: el mail de las
-- 8 h (días hábiles) lo arma una función programada de Netlify leyéndola.

-- ---------------------------------------------------------------- Control diario de bancos (vista)

create view control_bancos with (security_invoker = true) as
-- 1. Falta el extracto del día hábil anterior
select c.empresa_id, 'FALTA_EXTRACTO'::text as control, c.nombre as sujeto, dia_habil_anterior(current_date) as fecha,
       case when c.rinde_diario then 'Rinde todos los días: subí el extracto o confirmá sin rendimiento'
            else 'Subí el extracto o marcá "Sin movimientos"' end as detalle, null::numeric as importe, 1 as gravedad
from cuentas_origen c
where c.activa and c.requiere_extracto
  and not exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = c.id and s.fecha = dia_habil_anterior(current_date))
union all
-- 2. Diferencias de conciliación de los últimos 7 días
select cb.empresa_id, 'DIFERENCIA', cb.cuenta, cb.fecha, 'Banco ' || cb.saldo_extracto || ' · calculado ' || cb.saldo_calculado, cb.diferencia, 1
from conciliacion_bancaria cb
where cb.estado = 'DIFERENCIA' and cb.fecha >= current_date - 7
union all
-- 3. Movimientos sin clasificar
select m.empresa_id, 'A_REVISAR', co.nombre, m.fecha, m.descripcion, m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
where m.estado = 'A_REVISAR'
union all
-- 4. Comprobantes "Extracto Bancario" sin aprobar o con error en Xubio
select f.empresa_id, case when f.estado_xubio = 'ERROR' then 'COMPROBANTE_ERROR' else 'COMPROBANTE_PENDIENTE' end,
       pr.nombre, f.fecha, '09990-' || f.numero || coalesce(' · ' || f.xubio_error, ''), f.total, case when f.estado_xubio = 'ERROR' then 1 else 2 end
from facturas f join proveedores pr on pr.id = f.proveedor_id
where f.cuenta_origen_extracto_id is not null and (f.estado = 'PENDIENTE_APROBACION' or f.estado_xubio in ('PENDIENTE', 'ERROR'))
union all
-- 5. Asientos del banco con error o anulaciones pendientes en Xubio
select a.empresa_id, case when a.anulacion_xubio = 'PENDIENTE' then 'ANULAR_EN_XUBIO' else 'ASIENTO_ERROR' end, a.descripcion, a.fecha,
       coalesce(a.xubio_error, a.motivo_anulacion), null, 1
from asientos a where a.estado_xubio = 'ERROR' or a.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
-- 6. Control del Flujo en F
select fc.empresa_id, 'FLUJO_F', fc.unidad, fc.fecha, 'Bancos ' || fc.saldo_bancos || ' · diferencia ' || fc.diferencia, fc.diferencia, 1
from flujo_control fc where fc.estado = 'F' and fc.fecha >= current_date - 7
union all
-- 7. Cheques con fecha de pago vencida sin marcar
select ch.empresa_id, 'CHEQUE_SIN_MARCAR', ch.beneficiario, ch.fecha_pago, 'Cheque ' || ch.numero || ': ¿se debitó?', ch.importe, 2
from cheques ch where ch.estado in ('EMITIDO', 'ENTREGADO') and ch.fecha_pago < current_date;

-- Envíos del control (para no mandar dos veces el mismo día y saber qué se informó).
create table control_envios (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  fecha            date not null default current_date,
  destinatarios    text[] not null,
  hallazgos        jsonb not null,
  enviado_en       timestamptz not null default now(),
  unique (organizacion_id, fecha)
);
create trigger trg_organizacion_control_envios before insert or update on control_envios
  for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Registro de procesos automáticos

create table procesos_log (
  id               bigserial primary key,
  organizacion_id  uuid not null references organizaciones,
  empresa_id       text references empresas,
  proceso          text not null check (proceso in ('ROBOT_ECHEQS', 'ROBOT_DEBITOS', 'XUBIO_PAGOS', 'XUBIO_ASIENTOS',
                     'XUBIO_ANULACIONES', 'IMPORTAR_EXTRACTO', 'CONTROL_DIARIO', 'LECTURA_XUBIO', 'CARTERO_GMAIL', 'CARTERO_DRIVE')),
  modo             text not null default 'REAL' check (modo in ('PRUEBA', 'REAL')),
  entidad          text,
  entidad_id       text,
  estado           text not null check (estado in ('OK', 'PRUEBA_OK', 'ERROR', 'OMITIDO')),
  detalle          text,
  datos            jsonb,
  creado_en        timestamptz not null default now()
);
create index on procesos_log (proceso, creado_en desc);
create trigger trg_organizacion_procesos_log before insert on procesos_log for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Bloqueos (el "Hay otro proceso en curso")

-- En la base casi todo se resuelve con transacciones. Esto queda para trabajos largos del servidor
-- (importar un extracto grande, subir a Xubio): un recurso, un dueño, con vencimiento por si se corta.
create table bloqueos (
  recurso     text primary key,
  dueno       text not null,
  tomado_en   timestamptz not null default now(),
  vence_en    timestamptz not null
);

create or replace function tomar_bloqueo(p_recurso text, p_dueno text, p_segundos integer default 300)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from bloqueos where recurso = p_recurso and vence_en < now();
  insert into bloqueos (recurso, dueno, vence_en) values (p_recurso, p_dueno, now() + make_interval(secs => p_segundos))
  on conflict (recurso) do nothing;
  return exists (select 1 from bloqueos where recurso = p_recurso and dueno = p_dueno);
end $$;

create or replace function soltar_bloqueo(p_recurso text, p_dueno text)
returns void language sql security definer set search_path = public as $$
  delete from bloqueos where recurso = p_recurso and dueno = p_dueno
$$;

-- ---------------------------------------------------------------- Catálogos chicos

-- Percepciones de IIBB por jurisdicción: código de la factura → producto/cuenta de Xubio.
create table percepciones_iibb (
  organizacion_id  uuid not null references organizaciones,
  codigo           text not null,
  jurisdiccion     text not null,
  producto_xubio   text,
  cuenta_contable  text,
  primary key (organizacion_id, codigo)
);
create trigger trg_organizacion_percepciones before insert or update on percepciones_iibb
  for each row execute function poner_organizacion();

-- Correcciones a lo que leyó la IA (para medir y mejorar la lectura).
create table correcciones_ia (
  id           bigserial primary key,
  factura_id   uuid not null references facturas on delete cascade,
  campo        text not null,
  valor_ia     text,
  valor_final  text,
  usuario      text not null,
  creado_en    timestamptz not null default now()
);

-- ---------------------------------------------------------------- Seguridad

alter table control_envios enable row level security;
alter table procesos_log enable row level security;
alter table bloqueos enable row level security;
alter table percepciones_iibb enable row level security;
alter table correcciones_ia enable row level security;
create policy leer_control_envios on control_envios for select to authenticated using (organizacion_id = organizacion_actual());
create policy leer_procesos_log on procesos_log for select to authenticated
  using (organizacion_id = organizacion_actual() and (usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION', 'CONTROLLER')
         and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_percepciones on percepciones_iibb for select to authenticated using (organizacion_id = organizacion_actual());
create policy leer_correcciones_ia on correcciones_ia for select to authenticated using (exists (select 1 from facturas f where f.id = factura_id));
-- bloqueos: sin reglas de lectura, solo el servidor.

revoke all on control_bancos, control_envios, procesos_log, bloqueos, percepciones_iibb, correcciones_ia from public, anon, authenticated;
grant select on control_bancos, control_envios, procesos_log, percepciones_iibb, correcciones_ia to authenticated;
grant all on control_bancos, control_envios, procesos_log, bloqueos, percepciones_iibb, correcciones_ia to service_role;
grant usage, select on sequence procesos_log_id_seq, correcciones_ia_id_seq to service_role;
revoke execute on function tomar_bloqueo(text, text, integer), soltar_bloqueo(text, text) from public, anon, authenticated;


-- ======================================== 0028_espera_fc_flujo.sql
-- Tanda D5 · Pagos sin factura (ESPERA_FC) en el Flujo.
--
-- Lo que hacía gas/FlujoCaja.gs (fxAnticiposSinFactura_ + fxDescontarAnticipos_) pasa a la base:
--
--   · Un pago a un proveedor que todavía no tiene factura (anticipo) ya salió del banco: está en el Flujo
--     como REAL. Si además se proyectara entera la factura que llega después, el Flujo contaría dos veces
--     la misma plata.
--   · Por eso, lo pagado sin factura se descuenta de lo proyectado del MISMO proveedor y la MISMA empresa,
--     empezando por la factura más vieja (la que se paga primero) y siguiendo con la más nueva. Si el
--     anticipo cubre una factura entera, esa línea desaparece; lo que sobra pasa a la siguiente.
--   · Cuando la factura llega y el pago se vincula (pagos_facturas o factura_asociada), el pago deja de
--     ser anticipo y la factura baja sola por lo pagado: no hay doble descuento.
--
-- Pago sin factura (ESPERA_FC) =
--   no anulado · importe > 0 · con proveedor · sin factura vinculada (ni en pagos_facturas ni en el texto
--   factura_asociada) · y tipo_pago 'SIN_FACTURA' o cargado como orden de pago (la misma condición que usa el
--   ESTADO_CONTABLE = 'ESPERA_FC' de 0012/0022). Cuenta aunque ya esté contabilizado en Xubio: la plata ya
--   se fue y la factura todavía no está.

-- ---------------------------------------------------------------- Arreglo de 0024: la clave vieja de movimientos

-- 0024 quiso borrar la clave (cuenta, fecha, importe, referencia) con su nombre largo, pero Postgres la había
-- creado con el nombre truncado a 63 caracteres (…_refere_key): el "drop … if exists" no la encontró y siguió
-- viva. Con referencia vacía no se notaba (null ≠ null); con los extractos reales del Hipotecario, dos
-- movimientos iguales del mismo día con la misma referencia ("1666 Chq: 0") chocaban. La huella ya cubre eso.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'movimientos_bancarios'::regclass and contype = 'u'
             and conname like 'movimientos_bancarios_cuenta_origen_id_fecha_importe_ref%' loop
    execute format('alter table movimientos_bancarios drop constraint %I', c);
  end loop;
end $$;

-- ---------------------------------------------------------------- Pagos sin factura por proveedor

create or replace view anticipos_sin_factura with (security_invoker = true) as
select p.empresa_id, p.proveedor_id, count(*)::integer as pagos, sum(p.importe) as importe,
       min(p.fecha) as desde, max(p.fecha) as hasta
from pagos p
where p.estado <> 'ANULADO' and p.importe > 0 and p.proveedor_id is not null
  and coalesce(trim(p.factura_asociada), '') = ''
  and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
  and (upper(coalesce(p.tipo_pago, '')) = 'SIN_FACTURA' or p.forma_carga_xubio = 'ORDEN_PAGO')
group by p.empresa_id, p.proveedor_id;

-- ---------------------------------------------------------------- Las líneas del Flujo (misma vista, mismo orden de columnas)

create or replace view flujo_lineas with (security_invoker = true) as
with fac as (
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', dia_habil_desde(greatest(f.fecha, current_date + 1)), q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), fac_desc as (
  -- ESPERA_FC · lo pagado sin factura se descuenta de la más vieja a la más nueva (por fecha de pago
  -- proyectada, después por fecha de la factura), mismo proveedor y misma empresa.
  select x.*,
         least(x.importe, greatest(coalesce(a.importe, 0) - coalesce(x.acumulado_antes, 0), 0)) as descuento
  from (
    select fac.*,
           sum(fac.importe) over (partition by fac.empresa_id, fac.proveedor_id
                                  order by fac.fecha, fac.fecha_factura, fac.factura_id, fac.ocurrencia
                                  rows between unbounded preceding and 1 preceding) as acumulado_antes
    from fac
  ) x
  left join anticipos_sin_factura a on a.empresa_id = x.empresa_id and a.proveedor_id = x.proveedor_id
), base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque)
  select p.empresa_id, coalesce(co.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, p.fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, p.cuenta_origen_id, null::text as categoria, false as vencido
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  union all
  -- REAL · cheques debitados
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros
  select cb.empresa_id, co.unidad_id, 'COBRO', cb.id, 'COBRO', cb.fecha, cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', cb.cuenta_origen_id, null, false
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  union all
  -- REAL · movimientos del banco que no son pago, cobro ni cheque (impuestos, gastos, FCI, intereses…)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.categoria not in ('PAGO', 'COBRO', 'CHEQUE_PAGADO')
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, false
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  select b.empresa_id, d.unidad_id, d.fila_id, d.excluir, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto
  from base b
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- Seguridad

revoke all on anticipos_sin_factura, flujo_lineas from public, anon, authenticated;
grant select on anticipos_sin_factura, flujo_lineas to authenticated;
grant all on anticipos_sin_factura, flujo_lineas to service_role;


-- ======================================== 0029_cabos_tesoreria.sql
-- T-205 · Cabos sueltos de Tesorería sin planillas (después de 0023 a 0028).
--
--   1. importar_extracto: los saldos de una tenencia de FCI entran con origen TENENCIA (no EXTRACTO).
--      Parámetro nuevo en el jsonb: origen_saldos ('EXTRACTO' por defecto, o 'TENENCIA'). Las llamadas que
--      ya existen (migración desde planillas, pruebas) siguen igual. Además devuelve a_revisar (lo nuevo que
--      ninguna regla reconoció) y, en una tenencia sin movimientos, el período sale de los saldos.
--   2. Anulación "a mano" en Xubio: las órdenes de pago y la emisión de cheques no se borran por API, y el
--      borrado de asientos todavía no está confirmado. Quedan PENDIENTE o ERROR. Administración las anula en
--      Xubio y lo marca acá: marcar_anulacion_xubio_manual() la deja HECHA con quién, cuándo y la nota.
--   3. Vista xubio_bancos_pendientes: todo lo bancario que falta en Xubio (comprobantes, asientos y
--      anulaciones de asientos, pagos y cheques), con el último intento del robot.
--   4. control_bancos: el mail diario también avisa las anulaciones de pagos y cheques pendientes en Xubio.

-- ---------------------------------------------------------------- 1. Importar extracto (origen de los saldos)

-- p: { cuenta_origen_id, archivo: {nombre, path, hash, formato}, usuario,
--      movimientos: [{fecha, descripcion, referencia, importe, saldo, numero_cheque}],
--      saldos: [{fecha, saldo}],
--      origen_saldos: 'EXTRACTO' (por defecto) | 'TENENCIA' (informe de tenencia de un FCI o remunerada) }
create or replace function importar_extracto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; v_ext uuid; v_nuevos int := 0; v_total int := 0; v_revisar int := 0; m jsonb; r reglas_extracto;
  v_huella text; v_orden int; v_clave text; v_prev text := null; v_id uuid; v_usuario text := coalesce(p->>'usuario', 'servidor');
  v_desde date; v_hasta date; v_origen text := coalesce(nullif(p->>'origen_saldos', ''), 'EXTRACTO'); v_saldos int;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if coalesce(p->'archivo'->>'hash', '') = '' then raise exception 'Falta la huella del archivo'; end if;
  if v_origen not in ('EXTRACTO', 'TENENCIA') then raise exception 'Origen de saldos inválido: %', v_origen; end if;
  if v_origen = 'TENENCIA' and c.clase not in ('FCI', 'REMUNERADA') then
    raise exception 'Una tenencia va a una cuenta FCI o remunerada, no a % (%)', c.nombre, c.clase;
  end if;
  if v_origen = 'TENENCIA' and jsonb_array_length(coalesce(p->'movimientos', '[]')) > 0 then
    raise exception 'Una tenencia trae solo saldos: los movimientos del fondo entran por la cuenta madre';
  end if;

  select id into v_ext from extractos where cuenta_origen_id = c.id and archivo_hash = p->'archivo'->>'hash';
  if v_ext is not null then
    return jsonb_build_object('extracto_id', v_ext, 'repetido', true, 'movimientos', 0, 'nuevos', 0, 'a_revisar', 0,
                              'saldos', 0, 'origen_saldos', v_origen);
  end if;
  select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'movimientos', '[]')) x;
  if v_desde is null then
    select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'saldos', '[]')) x;
  end if;
  insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_path, archivo_hash, formato, desde, hasta, importado_por)
  values (c.empresa_id, c.id, p->'archivo'->>'nombre', p->'archivo'->>'path', p->'archivo'->>'hash', p->'archivo'->>'formato',
          v_desde, v_hasta, v_usuario)
  returning id into v_ext;

  -- La huella: fecha|importe|descripción|referencia|n.º de orden entre los iguales (igual que 0024).
  for m in select x from jsonb_array_elements(coalesce(p->'movimientos', '[]')) x
           order by x->>'fecha', x->>'importe', x->>'descripcion', coalesce(x->>'referencia', '') loop
    v_total := v_total + 1;
    v_clave := concat_ws('|', m->>'fecha', round((m->>'importe')::numeric, 2), texto_banco(m->>'descripcion'), coalesce(m->>'referencia', ''));
    v_orden := case when v_clave = v_prev then v_orden + 1 else 0 end;
    v_prev := v_clave;
    v_huella := md5(v_clave || '|' || v_orden);
    r := regla_para_movimiento(c.id, m->>'descripcion', (m->>'importe')::numeric);
    insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, referencia, numero_cheque,
                                       huella, extracto_id, orden, categoria, cuenta_contable, regla_id, destino_xubio, componente, estado)
    values (c.empresa_id, c.id, (m->>'fecha')::date, m->>'descripcion', round((m->>'importe')::numeric, 2),
            (m->>'saldo')::numeric, m->>'referencia', nullif(m->>'numero_cheque', ''), v_huella, v_ext, v_orden,
            coalesce(r.categoria, 'SIN_CLASIFICAR'), r.cuenta_contable, r.id, coalesce(r.destino_xubio, 'NINGUNO'), r.componente,
            case when r.id is null then 'A_REVISAR' when r.categoria = 'INFORMATIVO' then 'INFORMATIVO' else 'PENDIENTE' end)
    on conflict (cuenta_origen_id, huella) do nothing
    returning id into v_id;
    if v_id is not null then
      v_nuevos := v_nuevos + 1;
      if r.id is null then v_revisar := v_revisar + 1; end if;
      v_id := null;
    end if;
  end loop;

  -- Saldos de cierre: los que informa el archivo; si no, el saldo del último movimiento de cada día.
  -- Un saldo cargado a mano (MANUAL) no se pisa.
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, extracto_id, cargado_por)
  select c.id, d.fecha, c.empresa_id, d.saldo, v_origen, v_ext, v_usuario
  from (
    select (x->>'fecha')::date as fecha, (x->>'saldo')::numeric as saldo from jsonb_array_elements(coalesce(p->'saldos', '[]')) x
    union all
    (select distinct on ((t.x->>'fecha')::date) (t.x->>'fecha')::date, (t.x->>'saldo')::numeric
     from jsonb_array_elements(coalesce(p->'movimientos', '[]')) with ordinality as t(x, n)
     where t.x->>'saldo' is not null and jsonb_array_length(coalesce(p->'saldos', '[]')) = 0
     order by (t.x->>'fecha')::date, t.n desc)
  ) d
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = excluded.origen, extracto_id = excluded.extracto_id,
        cargado_por = excluded.cargado_por, cargado_en = now()
    where saldos_bancarios.origen <> 'MANUAL';
  get diagnostics v_saldos = row_count;

  update extractos set movimientos = v_total, nuevos = v_nuevos where id = v_ext;
  insert into auditoria (usuario, accion, entidad, entidad_id, detalle, empresa_id)
  values (v_usuario, case when v_origen = 'TENENCIA' then 'IMPORTAR_TENENCIA' else 'IMPORTAR_EXTRACTO' end, 'EXTRACTO', v_ext::text,
          c.nombre || ': ' || case when v_origen = 'TENENCIA' then v_saldos || ' saldo(s) de tenencia'
                                   else v_nuevos || ' nuevos de ' || v_total end, c.empresa_id);
  return jsonb_build_object('extracto_id', v_ext, 'repetido', false, 'movimientos', v_total, 'nuevos', v_nuevos,
                            'a_revisar', v_revisar, 'saldos', v_saldos, 'origen_saldos', v_origen);
end $$;

-- ---------------------------------------------------------------- 2. Anulación hecha a mano en Xubio

alter table asientos add column anulacion_manual_por text;
alter table asientos add column anulacion_manual_en timestamptz;
alter table asientos add column anulacion_manual_nota text;
alter table pagos add column anulacion_manual_por text;
alter table pagos add column anulacion_manual_en timestamptz;
alter table pagos add column anulacion_manual_nota text;
alter table cheques add column anulacion_manual_por text;
alter table cheques add column anulacion_manual_en timestamptz;
alter table cheques add column anulacion_manual_nota text;

-- p_tipo: 'PAGO' | 'CHEQUE' | 'ASIENTO'. Solo lo que está anulado en el sistema y pendiente (o con error) de
-- anular en Xubio. La nota es obligatoria (qué se hizo en Xubio: n.º de la anulación, fecha). Queda en la
-- auditoría y en procesos_log, y el robot ya no lo toma (busca solo PENDIENTE).
create or replace function marcar_anulacion_xubio_manual(p_tipo text, p_id uuid, p_nota text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_empresa text; v_estado text; v_desc text; v_org uuid;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_nota), '') = '' then raise exception 'Falta la nota: qué se hizo en Xubio (n.º de anulación, fecha)'; end if;
  if p_tipo = 'PAGO' then
    select empresa_id, anulacion_xubio, 'Pago ' || coalesce(xubio_id, id::text) into v_empresa, v_estado, v_desc from pagos where id = p_id for update;
  elsif p_tipo = 'CHEQUE' then
    select empresa_id, anulacion_xubio, 'Cheque ' || numero into v_empresa, v_estado, v_desc from cheques where id = p_id for update;
  elsif p_tipo = 'ASIENTO' then
    select empresa_id, anulacion_xubio, 'Asiento ' || coalesce(xubio_id, '') || ' ' || descripcion into v_empresa, v_estado, v_desc from asientos where id = p_id for update;
  else
    raise exception 'Tipo inválido: % (PAGO, CHEQUE o ASIENTO)', p_tipo;
  end if;
  if v_empresa is null then raise exception 'No existe ese %', lower(p_tipo); end if;
  perform exigir_empresa(v_empresa);
  if v_estado is null then raise exception 'No está anulado en el sistema: anulalo primero'; end if;
  if v_estado = 'HECHA' then raise exception 'La anulación en Xubio ya figura hecha'; end if;

  if p_tipo = 'PAGO' then
    update pagos set anulacion_xubio = 'HECHA', anulacion_manual_por = u.email, anulacion_manual_en = now(), anulacion_manual_nota = trim(p_nota) where id = p_id;
  elsif p_tipo = 'CHEQUE' then
    update cheques set anulacion_xubio = 'HECHA', anulacion_manual_por = u.email, anulacion_manual_en = now(), anulacion_manual_nota = trim(p_nota) where id = p_id;
  else
    update asientos set anulacion_xubio = 'HECHA', anulacion_manual_por = u.email, anulacion_manual_en = now(), anulacion_manual_nota = trim(p_nota) where id = p_id;
  end if;
  perform registrar_auditoria(u, 'ANULACION_XUBIO_MANUAL', p_tipo, p_id::text, v_desc || ' · antes ' || v_estado || ' · ' || trim(p_nota));
  select organizacion_id into v_org from empresas where id = v_empresa;
  insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle)
  values (v_org, v_empresa, 'XUBIO_ANULACIONES', 'REAL', 'ANULAR_' || p_tipo, p_id::text, 'OK',
          left('Anulada a mano en Xubio por ' || u.email || ': ' || trim(p_nota), 1000));
end $$;

-- ---------------------------------------------------------------- 3. Pendiente de Xubio (bancario)

-- estado: FALTA_APROBAR (comprobante todavía sin aprobar: el robot no lo toma), PENDIENTE, EN_CURSO
-- (reservado por un envío), ERROR. a_mano = el robot no lo puede hacer: hay que hacerlo en Xubio y marcarlo.
create view xubio_bancos_pendientes with (security_invoker = true) as
with base as (
  select f.empresa_id, 'COMPROBANTE'::text as tipo, f.id, f.fecha, '09990-' || f.numero || ' · ' || coalesce(pr.nombre, 'Banco') as descripcion,
         f.total as importe,
         case when f.estado = 'PENDIENTE_APROBACION' then 'FALTA_APROBAR'
              when f.estado_xubio = 'ERROR' then 'ERROR'
              when f.xubio_envio_en is not null then 'EN_CURSO' else 'PENDIENTE' end as estado,
         f.xubio_error as error, f.xubio_id, false as a_mano, f.cuenta_origen_extracto_id as cuenta_origen_id
  from facturas f left join proveedores pr on pr.id = f.proveedor_id
  where f.cuenta_origen_extracto_id is not null and f.estado_xubio in ('PENDIENTE', 'ERROR') and f.estado not in ('RECHAZADA', 'ERROR')
  union all
  select a.empresa_id, 'ASIENTO', a.id, a.fecha, a.descripcion, (select sum(l.debe) from asiento_lineas l where l.asiento_id = a.id),
         case when a.estado_xubio = 'ERROR' then 'ERROR' when a.envio_xubio_en is not null then 'EN_CURSO' else 'PENDIENTE' end,
         a.xubio_error, a.xubio_id, false, a.cuenta_origen_id
  from asientos a
  where a.anulado_en is null and a.estado_xubio in ('PENDIENTE', 'ERROR')
  union all
  select a.empresa_id, 'ANULAR_ASIENTO', a.id, a.fecha, a.descripcion || ' · ' || coalesce(a.motivo_anulacion, ''), null,
         a.anulacion_xubio, null, a.xubio_id, not coalesce(a.xubio_id ~ '^(OP-)?[0-9]+$', false), a.cuenta_origen_id
  from asientos a where a.anulacion_xubio in ('PENDIENTE', 'ERROR')
  union all
  select p.empresa_id, 'ANULAR_PAGO', p.id, p.fecha, coalesce(pr.nombre, 'Pago') || ' · ' || p.forma_carga_xubio::text || ' · ' || coalesce(p.motivo_anulacion, ''),
         p.importe, p.anulacion_xubio, null, p.xubio_id,
         not (p.forma_carga_xubio in ('SALIDA_FONDOS', 'ASIENTO_MANUAL') and coalesce(p.xubio_id ~ '^(OP-)?[0-9]+$', false)), p.cuenta_origen_id
  from pagos p left join proveedores pr on pr.id = p.proveedor_id
  where p.anulacion_xubio in ('PENDIENTE', 'ERROR')
  union all
  select ch.empresa_id, 'ANULAR_CHEQUE', ch.id, ch.fecha_pago, 'Cheque ' || ch.numero || ' · ' || ch.beneficiario || ' · ' || coalesce(ch.motivo_anulacion, ''),
         ch.importe, ch.anulacion_xubio, null, ch.xubio_emision_id, true, ch.cuenta_origen_id
  from cheques ch where ch.anulacion_xubio in ('PENDIENTE', 'ERROR')
)
select b.*, l.creado_en as ultimo_intento_en, l.estado as ultimo_intento_estado, l.modo as ultimo_intento_modo, l.detalle as ultimo_intento_detalle
from base b
left join lateral (
  select pl.creado_en, pl.estado, pl.modo, pl.detalle from procesos_log pl
  where pl.entidad_id = b.id::text and pl.proceso in ('XUBIO_ASIENTOS', 'XUBIO_ANULACIONES')
  order by pl.creado_en desc, pl.id desc limit 1
) l on true;

-- ---------------------------------------------------------------- 4. Control diario: anulaciones de pagos y cheques

create or replace view control_bancos with (security_invoker = true) as
select c.empresa_id, 'FALTA_EXTRACTO'::text as control, c.nombre as sujeto, dia_habil_anterior(current_date) as fecha,
       case when c.rinde_diario then 'Rinde todos los días: subí el extracto o confirmá sin rendimiento'
            else 'Subí el extracto o marcá "Sin movimientos"' end as detalle, null::numeric as importe, 1 as gravedad
from cuentas_origen c
where c.activa and c.requiere_extracto
  and not exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = c.id and s.fecha = dia_habil_anterior(current_date))
union all
select cb.empresa_id, 'DIFERENCIA', cb.cuenta, cb.fecha, 'Banco ' || cb.saldo_extracto || ' · calculado ' || cb.saldo_calculado, cb.diferencia, 1
from conciliacion_bancaria cb
where cb.estado = 'DIFERENCIA' and cb.fecha >= current_date - 7
union all
select m.empresa_id, 'A_REVISAR', co.nombre, m.fecha, m.descripcion, m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
where m.estado = 'A_REVISAR'
union all
select f.empresa_id, case when f.estado_xubio = 'ERROR' then 'COMPROBANTE_ERROR' else 'COMPROBANTE_PENDIENTE' end,
       pr.nombre, f.fecha, '09990-' || f.numero || coalesce(' · ' || f.xubio_error, ''), f.total, case when f.estado_xubio = 'ERROR' then 1 else 2 end
from facturas f join proveedores pr on pr.id = f.proveedor_id
where f.cuenta_origen_extracto_id is not null and (f.estado = 'PENDIENTE_APROBACION' or f.estado_xubio in ('PENDIENTE', 'ERROR'))
union all
select a.empresa_id, case when a.anulacion_xubio in ('PENDIENTE', 'ERROR') then 'ANULAR_EN_XUBIO' else 'ASIENTO_ERROR' end, a.descripcion, a.fecha,
       coalesce(a.xubio_error, a.motivo_anulacion), null, 1
from asientos a where a.estado_xubio = 'ERROR' or a.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
select fc.empresa_id, 'FLUJO_F', fc.unidad, fc.fecha, 'Bancos ' || fc.saldo_bancos || ' · diferencia ' || fc.diferencia, fc.diferencia, 1
from flujo_control fc where fc.estado = 'F' and fc.fecha >= current_date - 7
union all
select ch.empresa_id, 'CHEQUE_SIN_MARCAR', ch.beneficiario, ch.fecha_pago, 'Cheque ' || ch.numero || ': ¿se debitó?', ch.importe, 2
from cheques ch where ch.estado in ('EMITIDO', 'ENTREGADO') and ch.fecha_pago < current_date
union all
-- Nuevo en 0029: pagos y cheques anulados en el sistema que siguen vivos en Xubio.
select p.empresa_id, 'ANULAR_EN_XUBIO', coalesce(pr.nombre, 'Pago'), p.fecha,
       'Pago ' || coalesce(p.xubio_id, '') || ' anulado en el sistema: ' ||
       case when p.anulacion_xubio = 'ERROR' then 'anularlo a mano en Xubio y marcarlo' else 'pendiente de anular en Xubio' end, p.importe, 1
from pagos p left join proveedores pr on pr.id = p.proveedor_id where p.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
select ch.empresa_id, 'ANULAR_EN_XUBIO', ch.beneficiario, ch.fecha_pago,
       'Cheque ' || ch.numero || ' anulado en el sistema: anularlo a mano en Xubio y marcarlo', ch.importe, 1
from cheques ch where ch.anulacion_xubio in ('PENDIENTE', 'ERROR');

-- ---------------------------------------------------------------- Seguridad

revoke all on xubio_bancos_pendientes from public, anon, authenticated;
grant select on xubio_bancos_pendientes to authenticated;
grant all on xubio_bancos_pendientes to service_role;
revoke all on control_bancos from public, anon, authenticated;
grant select on control_bancos to authenticated;
grant all on control_bancos to service_role;
revoke execute on function importar_extracto(jsonb) from public, anon, authenticated;
grant execute on function importar_extracto(jsonb) to service_role;
revoke execute on function marcar_anulacion_xubio_manual(text, uuid, text) from public, anon;
grant execute on function marcar_anulacion_xubio_manual(text, uuid, text) to authenticated, service_role;


-- ======================================== 0030_ajustes_paralelo.sql
-- T-206 · Ajustes que salieron del simulacro del período en paralelo (noviembre 2026, datos reales en local).
--
-- Se corrió la base con los datos reales del 02/11 al 25/11 y se comparó, día por día, contra la fila
-- "Conciliación Bancaria" del Flujo original y contra Conciliacion_Diaria de VBI+. Las causas de los días que no
-- cerraban y que son reglas de la base se corrigen acá:
--
--   1. El pago y su débito en el banco se contaban dos veces. El extracto trae el débito (VBI+ lo marca INFORMATIVO
--      o SIN_CLASIFICAR) y el sistema trae el pago: los dos entraban al Flujo como REAL. Ahora el movimiento se
--      VINCULA a su documento (pago, cheque debitado o cobro): mismo importe, misma empresa, misma cuenta si el
--      documento la sabe, y fecha del banco dentro de una ventana corta. Un movimiento vinculado no entra al Flujo
--      (entra su documento); uno sin vincular SÍ entra, sea cual sea su categoría: la plata salió del banco.
--      Antes un débito con categoría PAGO, COBRO o CHEQUE_PAGADO sin documento desaparecía del Flujo.
--   2. El pago vinculado entra el día que lo debitó el banco y en la unidad de esa cuenta (no la fecha que se cargó
--      a mano ni la unidad por defecto de la empresa).
--   3. Los pagos no tenían cuenta bancaria (la copia de la hoja guarda el texto: nombre del banco, "XXXX - 1234",
--      "BANCO_X_CC_1234_EMPRESA …"). Sin cuenta, un pago desde una cuenta de Dax Salud caía en la unidad por defecto
--      de la empresa (Beratung S/Dax). Ahora la base la deduce del texto, sin adivinar: si hay más de una
--      posible, queda vacía (y la toma del movimiento cuando se vincula).
--   4. Suscripción o rescate de FCI desde la cuenta madre: si la cuenta tiene UN solo FCI o remunerada, el
--      movimiento lleva ese FCI como contraparte. Así la conciliación del FCI no confunde la suscripción con
--      rendimiento (antes: toda la suscripción aparecía como "rendimiento" del FCI y como egreso en la CC).
--   5. Destino de los cheques por categoría del acreedor (Cash Flow: P, FCON, FU…): flujo_reglas puede pedir una
--      unidad (si_unidad_id) y los cheques pasan la categoría del acreedor. Así "Cheques Financieras <financiera>" o
--      "Cheques Insumos hospitales" no caen en "Sin clasificar".
--   6. El control del Flujo contra bancos (flujo_control) suma solo lo que mueve un banco: un pago en efectivo
--      (medio CAJA) es real pero no está en ningún extracto.
--   8. Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta y no se excluye: una regla del
--      Flujo puede elegir su fila, pero no sacarlo de la unidad ni del Flujo (antes una transferencia propia registrada
--      como pago se excluía y el débito vinculado también desaparecía → F).
--   7. Un pago de una cuenta con extracto es REAL cuando el banco lo debita. Si el extracto de esa cuenta ya llegó
--      de ese día (un movimiento o un saldo que no sea MANUAL) y no hay débito vinculado, no entra al Flujo y aparece en la vista pagos_sin_debito
--      (duplicados de la hoja, cuenta equivocada, pagos que no salieron). Antes contaba igual y el control daba F.
--
-- flujo_lineas mantiene sus columnas y agrega dos al final: cuenta_origen_id y afecta_bancos.

-- ---------------------------------------------------------------- 3. La cuenta de un pago, desde el texto de la hoja

-- Sin adivinar: 1) un patrón o el nombre de la cuenta está en el texto (gana el más largo, si es uno solo);
-- 2) el banco está en el texto y es la única cuenta de ese banco; 3) si hay varias del banco, los últimos 4 dígitos
-- del número de cuenta lo deciden; 4) "Caja" / "Efectivo" → la cuenta CAJA si hay una. Si no, null.
create or replace function cuenta_de_pago(p_empresa text, p_cuenta_origen text, p_banco text, p_numero text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  t text := ' ' || regexp_replace(texto_banco(concat_ws(' ', p_cuenta_origen, p_banco, p_numero)), '[^A-Z0-9]+', ' ', 'g') || ' ';
  dig text := right(regexp_replace(coalesce(nullif(p_numero, ''), p_cuenta_origen, ''), '[^0-9]', '', 'g'), 4);
  v uuid[]; n int;
begin
  if trim(t) = '' then return null; end if;
  -- 1. Patrón o nombre contenido en el texto (de 8 letras o más, para no confundir "BANCO" con una cuenta).
  select array_agg(id order by largo desc) into v from (
    select c.id, max(length(x)) as largo
    from cuentas_origen c cross join lateral unnest(c.patrones || texto_banco(c.nombre)) x
    where c.empresa_id = p_empresa and c.activa and c.clase in ('CC', 'CA', 'BILLETERA', 'CAJA')
      and length(x) >= 8 and position(' ' || regexp_replace(x, '[^A-Z0-9]+', ' ', 'g') || ' ' in t) > 0
    group by c.id) z;
  n := coalesce(array_length(v, 1), 0);
  if n = 1 then return v[1]; end if;
  -- 2 y 3. Por banco y, si hace falta, por los últimos dígitos.
  select array_agg(c.id) into v from cuentas_origen c
  where c.empresa_id = p_empresa and c.activa and c.clase in ('CC', 'CA', 'BILLETERA')
    and c.banco is not null
    and (position(' ' || c.banco || ' ' in t) > 0 or (c.banco = 'MP' and position(' MERCADO PAGO ' in t) > 0));
  n := coalesce(array_length(v, 1), 0);
  if n = 1 then return v[1]; end if;
  if n > 1 and length(dig) = 4 then
    select array_agg(c.id) into v from cuentas_origen c
    where c.id = any(v) and (position(dig in regexp_replace(c.nombre || ' ' || coalesce(c.numero, ''), '[^0-9]', '', 'g')) > 0);
    if coalesce(array_length(v, 1), 0) = 1 then return v[1]; end if;
  end if;
  -- 4. Efectivo.
  if n = 0 and (position(' CAJA ' in t) > 0 or position(' EFECTIVO ' in t) > 0) then
    select array_agg(c.id) into v from cuentas_origen c where c.empresa_id = p_empresa and c.activa and c.clase = 'CAJA';
    if coalesce(array_length(v, 1), 0) = 1 then return v[1]; end if;
  end if;
  return null;
end $$;

create or replace function pago_con_cuenta()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cuenta_origen_id is null then
    new.cuenta_origen_id := cuenta_de_pago(new.empresa_id, new.cuenta_origen, new.banco_origen, new.numero_cuenta);
  end if;
  return new;
end $$;
create trigger trg_pago_con_cuenta before insert or update of cuenta_origen, banco_origen, numero_cuenta, empresa_id on pagos
  for each row execute function pago_con_cuenta();

-- Los pagos que ya están en la base sin cuenta. Devuelve cuántos tomaron una.
create or replace function vincular_pagos_a_cuentas()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update pagos p set cuenta_origen_id = x.c
  from (select id, cuenta_de_pago(empresa_id, cuenta_origen, banco_origen, numero_cuenta) as c from pagos where cuenta_origen_id is null) x
  where p.id = x.id and x.c is not null;
  get diagnostics n = row_count;
  return n;
end $$;
select vincular_pagos_a_cuentas();

-- ---------------------------------------------------------------- El extracto de una cuenta ya llegó hasta un día

-- El extracto de la cuenta cubre un día si hay evidencia del banco (un movimiento o un saldo que no se cargó a mano:
-- extracto, tenencia, "sin movimientos") ese día o antes Y ese día o después. Un saldo MANUAL (copiado del Flujo
-- viejo) no es evidencia: hasta que no llega el primer extracto de una cuenta, nada está cubierto.
create or replace function extracto_cubre(p_cuenta uuid, p_dia date)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (select 1 from movimientos_bancarios m where m.cuenta_origen_id = p_cuenta and m.fecha <= p_dia)
          or exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = p_cuenta and s.fecha <= p_dia and s.origen <> 'MANUAL'))
     and (exists (select 1 from movimientos_bancarios m where m.cuenta_origen_id = p_cuenta and m.fecha >= p_dia)
          or exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = p_cuenta and s.fecha >= p_dia and s.origen <> 'MANUAL'))
$$;

-- ---------------------------------------------------------------- 1, 4. Movimiento ↔ documento

-- Ventana: el banco puede debitar hasta 2 días antes de la fecha cargada (el pago se carga después) y hasta 5 días
-- después (transferencia diferida). Gana el más cercano; a igual distancia, el número de cheque y el orden.
create or replace function conciliar_movimientos(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n_pag int := 0; n_che int := 0; n_cob int := 0; n_fci int := 0;
begin
  -- FCI / remunerada: la contraparte es el único fondo de la cuenta madre (si el fondo no trae ya su propia pata).
  update movimientos_bancarios m set contraparte_cuenta_id = h.id
  from cuentas_origen h
  where m.empresa_id = p_empresa and m.categoria in ('FCI', 'TRANSFERENCIA_PROPIA') and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO'
    and h.cuenta_madre_id = m.cuenta_origen_id and h.activa and h.clase in ('FCI', 'REMUNERADA')
    and (select count(*) from cuentas_origen h2 where h2.cuenta_madre_id = m.cuenta_origen_id and h2.activa and h2.clase in ('FCI', 'REMUNERADA')) = 1
    and not exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = h.id and o.fecha = m.fecha and o.importe = -m.importe);
  get diagnostics n_fci = row_count;

  -- Cheques debitados.
  for r in
    select m.id as mid, ch.id as cid
    from movimientos_bancarios m
    join cheques ch on ch.cuenta_origen_id = m.cuenta_origen_id and ch.importe = -m.importe and ch.estado = 'DEBITADO'
                   and ch.movimiento_id is null and m.fecha between ch.debitado_en - 3 and ch.debitado_en + 3
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
    order by (m.numero_cheque is not null and right(regexp_replace(m.numero_cheque, '\D', '', 'g'), 4) = right(regexp_replace(ch.numero, '\D', '', 'g'), 4)) desc,
             abs(m.fecha - ch.debitado_en), m.fecha, m.orden, ch.numero
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cheque_id is null)
       and exists (select 1 from cheques where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cheque_id = r.cid where id = r.mid;
      update cheques set movimiento_id = r.mid where id = r.cid;
      n_che := n_che + 1;
    end if;
  end loop;

  -- Pagos (no cheques ni efectivo: el cheque cuenta cuando se debita; el efectivo no pasa por el banco).
  for r in
    select m.id as mid, p.id as pid
    from movimientos_bancarios m
    join pagos p on p.empresa_id = m.empresa_id and p.importe = -m.importe and p.estado <> 'ANULADO'
                and p.medio not in ('CHEQUE', 'ECHEQ')
                and (p.medio <> 'CAJA' or p.cuenta_origen_id is not null)   -- "Caja" con cuenta de banco: salió por el banco
                and (p.cuenta_origen_id is null or p.cuenta_origen_id = m.cuenta_origen_id)
                and m.fecha between p.fecha - 2 and p.fecha + 5
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not exists (select 1 from movimientos_bancarios x where x.pago_id = p.id)
    order by abs(m.fecha - p.fecha), (p.cuenta_origen_id is not null) desc, m.fecha, m.orden, p.fecha, p.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and pago_id is null and cheque_id is null)
       and not exists (select 1 from movimientos_bancarios where pago_id = r.pid) then
      update movimientos_bancarios set pago_id = r.pid where id = r.mid;
      n_pag := n_pag + 1;
    end if;
  end loop;

  -- Cobros.
  for r in
    select m.id as mid, c.id as cid
    from movimientos_bancarios m
    join cobros c on c.empresa_id = m.empresa_id and c.importe = m.importe and c.movimiento_id is null
                 and (c.cuenta_origen_id is null or c.cuenta_origen_id = m.cuenta_origen_id)
                 and m.fecha between c.fecha - 3 and c.fecha + 3
    where m.empresa_id = p_empresa and m.importe > 0 and m.estado <> 'IGNORADO'
      and m.cobro_id is null and m.pago_id is null and m.cheque_id is null
    order by abs(m.fecha - c.fecha), m.fecha, m.orden, c.fecha, c.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cobro_id is null)
       and exists (select 1 from cobros where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cobro_id = r.cid where id = r.mid;
      update cobros set movimiento_id = r.mid where id = r.cid;
      n_cob := n_cob + 1;
    end if;
  end loop;
  return jsonb_build_object('pagos', n_pag, 'cheques', n_che, 'cobros', n_cob, 'fci', n_fci);
end $$;

-- Se concilia solo: al entrar movimientos (extracto), pagos (copia de la hoja o sistema), cobros, y al marcar un
-- cheque debitado. Por sentencia, una vez por empresa afectada.
create or replace function conciliar_tras_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  for e in select distinct empresa_id from nuevos loop perform conciliar_movimientos(e); end loop;
  return null;
end $$;
create trigger trg_conciliar_movimientos after insert on movimientos_bancarios
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_pagos_alta after insert on pagos
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_pagos_cambio after update on pagos
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cobros after insert on cobros
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cheques after update on cheques
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cheques_alta after insert on cheques
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();

-- Un pago anulado suelta su movimiento (el débito vuelve a contar solo, hasta que se vincule otro documento).
create or replace function soltar_movimiento_de_anulado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'ANULADO' and old.estado is distinct from 'ANULADO' then
    update movimientos_bancarios set pago_id = null where pago_id = new.id;
  end if;
  return null;
end $$;
create trigger trg_soltar_movimiento_de_anulado after update of estado on pagos
  for each row execute function soltar_movimiento_de_anulado();

-- ---------------------------------------------------------------- 5. Destino por unidad y categoría del acreedor

alter table flujo_reglas add column si_unidad_id uuid references unidades;
alter table acreedores add column categoria text;      -- la del Cash Flow: P (proveedor), F… (financieras)

create or replace function flujo_destino(p_empresa text, p_unidad uuid, p_origen text, p_proveedor uuid,
                                         p_cuenta_contable text, p_cuenta_origen uuid, p_categoria text, p_texto text)
returns table (unidad_id uuid, fila_id uuid, excluir boolean)
language plpgsql stable security definer set search_path = public as $$
declare r flujo_reglas; v_unidad uuid; v_fila uuid; v_prov text; v_hint uuid := coalesce(p_unidad, unidad_por_defecto(p_empresa));
begin
  select x.* into r from flujo_reglas x join empresas e on e.id = p_empresa
  where x.organizacion_id = e.organizacion_id and (x.empresa_id is null or x.empresa_id = p_empresa)
    and (x.si_origen is null or x.si_origen = p_origen)
    and (x.si_proveedor_id is null or x.si_proveedor_id = p_proveedor)
    and (x.si_cuenta_contable is null or texto_banco(x.si_cuenta_contable) = texto_banco(p_cuenta_contable))
    and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = p_cuenta_origen)
    and (x.si_categoria is null or x.si_categoria = p_categoria)
    and (x.si_texto is null or position(texto_banco(x.si_texto) in texto_banco(p_texto)) > 0)
    and (x.si_unidad_id is null or x.si_unidad_id = v_hint)
  order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null) limit 1;
  if r.id is not null and r.excluir then return query select null::uuid, null::uuid, true; return; end if;
  v_unidad := coalesce(r.unidad_id, v_hint);
  v_fila := r.fila_id;
  if v_fila is null and p_cuenta_contable is not null then
    select nombre into v_prov from proveedores where id = p_proveedor;
    select f.id into v_fila from flujo_filas f
    where f.unidad_id = v_unidad and f.activa and f.tipo in ('CUENTA', 'APERTURA')
      and texto_banco(f.cuenta_contable) = texto_banco(p_cuenta_contable)
      and (f.tipo = 'CUENTA' or (v_prov is not null and position(texto_banco(f.apertura) in texto_banco(v_prov)) > 0))
    order by (f.tipo = 'APERTURA') desc, f.orden limit 1;
  end if;
  if v_fila is null then v_fila := fila_especial(v_unidad, 'SIN_CLASIFICAR'); end if;
  return query select v_unidad, v_fila, false;
end $$;

-- ---------------------------------------------------------------- 1, 2, 5, 6. Las líneas del Flujo

create or replace view flujo_lineas with (security_invoker = true) as
with fac as (
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', dia_habil_desde(greatest(f.fecha, current_date + 1)), q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), fac_desc as (
  select x.*,
         least(x.importe, greatest(coalesce(a.importe, 0) - coalesce(x.acumulado_antes, 0), 0)) as descuento
  from (
    select fac.*,
           sum(fac.importe) over (partition by fac.empresa_id, fac.proveedor_id
                                  order by fac.fecha, fac.fecha_factura, fac.factura_id, fac.ocurrencia
                                  rows between unbounded preceding and 1 preceding) as acumulado_antes
    from fac
  ) x
  left join anticipos_sin_factura a on a.empresa_id = x.empresa_id and a.proveedor_id = x.proveedor_id
), base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque). Si el banco ya lo debitó (movimiento
  -- vinculado), cuenta ese día y en la unidad de esa cuenta.
  select p.empresa_id, coalesce(co.unidad_id, cm.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, coalesce(mv.fecha, p.fecha) as fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, coalesce(p.cuenta_origen_id, mv.cuenta_origen_id) as cuenta_origen_id, null::text as categoria,
         false as vencido, (mv.fecha is not null or p.medio::text <> 'CAJA') as afecta_bancos
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join lateral (select m.fecha, m.cuenta_origen_id from movimientos_bancarios m where m.pago_id = p.id order by m.fecha limit 1) mv on true
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    -- Un pago de una cuenta con extracto es real cuando el banco lo debita. Si el extracto de esa cuenta para ese
    -- día está y el débito no aparece, el pago no salió (duplicado, otra cuenta, otra fecha): no entra y queda
    -- en pagos_sin_debito para revisar. Mientras el extracto no llegó, cuenta en su fecha.
    and (mv.fecha is not null or co.id is null or not co.requiere_extracto or p.medio = 'CAJA'
         or not extracto_cubre(co.id, p.fecha))
  union all
  -- REAL · cheques debitados (la categoría del acreedor elige la fila de cheques)
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, a.categoria, false, true
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros (el día y la cuenta del banco, si ya está vinculado)
  select cb.empresa_id, coalesce(cm.unidad_id, co.unidad_id), 'COBRO', cb.id, 'COBRO', coalesce(mv.fecha, cb.fecha), cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', coalesce(mv.cuenta_origen_id, cb.cuenta_origen_id),
         null, false, true
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  left join movimientos_bancarios mv on mv.id = cb.movimiento_id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  union all
  -- REAL · movimientos del banco sin documento vinculado (impuestos, gastos, FCI, transferencias… y débitos que
  -- todavía no tienen su pago, cheque o cobro: la plata ya se movió).
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false, true
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false, true
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false, true
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, false, true
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, a.categoria, false, true
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  -- Lo REAL que pasó por una cuenta bancaria queda en la unidad de esa cuenta y no se excluye: la plata se movió en
  -- ese banco y el control contra bancos tiene que verla. Si una regla lo mandaba a otra unidad o lo excluía
  -- (transferencia propia), va a "Entre cuentas propias" (excluida) o a "Sin clasificar" (otra unidad) de su unidad.
  select b.empresa_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null then cu.unidad_id else d.unidad_id end as unidad_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null and (d.excluir or d.unidad_id <> cu.unidad_id)
              then fila_especial(cu.unidad_id, case when d.excluir then 'ENTRE_CUENTAS' else 'SIN_CLASIFICAR' end)
              else d.fila_id end as fila_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null then false else d.excluir end as excluir,
         b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto, b.cuenta_origen_id, b.afecta_bancos
  from base b
  left join cuentas_origen cu on cu.id = b.cuenta_origen_id and b.afecta_bancos and cu.requiere_extracto
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable,
       t.cuenta_origen_id,
       t.afecta_bancos
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- 6. Control: solo lo que mueve un banco

create or replace view flujo_control with (security_invoker = true) as
with cuentas as (
  select unidad_id, count(*) as n from cuentas_origen where activa and requiere_extracto group by unidad_id
), dias as (
  select co.unidad_id, s.fecha, sum(s.saldo) as saldo_bancos, count(*) as con_saldo
  from saldos_bancarios s join cuentas_origen co on co.id = s.cuenta_origen_id
  where co.activa and co.requiere_extracto
  group by co.unidad_id, s.fecha
), completos as (
  select d.*, c.n, d.con_saldo = c.n as completo,
         lag(d.fecha) over (partition by d.unidad_id order by d.fecha) as fecha_anterior,
         lag(d.saldo_bancos) over (partition by d.unidad_id order by d.fecha) as saldo_anterior
  from dias d join cuentas c on c.unidad_id = d.unidad_id
  where d.con_saldo = c.n
)
select u.empresa_id, k.unidad_id, u.nombre as unidad, k.fecha, k.fecha_anterior, k.saldo_anterior, k.saldo_bancos,
       r.movido as real_del_periodo,
       round(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0), 2) as diferencia,
       case when k.saldo_anterior is null then 'PRIMER_SALDO'
            when abs(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0)) <= 1 then 'OK'
            else 'F' end as estado
from completos k
join unidades u on u.id = k.unidad_id
left join lateral (
  select sum(l.importe) as movido from flujo_lineas l
  where l.unidad_id = k.unidad_id and l.naturaleza = 'REAL' and l.afecta_bancos
    and l.fecha > k.fecha_anterior and l.fecha <= k.fecha
) r on true;

-- ---------------------------------------------------------------- Pagos que el banco no muestra

-- Pagos de una cuenta con extracto sin débito vinculado: el extracto cubre hasta 5 días después de la fecha del
-- pago (la ventana de vinculación cerró). posible_duplicado: hay otro pago igual (empresa, importe, proveedor, ±5 días).
create or replace view pagos_sin_debito with (security_invoker = true) as
select p.id, p.empresa_id, p.fecha, p.importe, p.proveedor_destino, p.estado, p.cuenta_origen_id, co.nombre as cuenta,
       p.sheets_fila_origen, p.hoja_id,
       exists (select 1 from pagos d where d.id <> p.id and d.empresa_id = p.empresa_id and d.importe = p.importe
                 and d.estado <> 'ANULADO' and abs(d.fecha - p.fecha) <= 5
                 and texto_comparable(coalesce(d.proveedor_destino, '')) = texto_comparable(coalesce(p.proveedor_destino, ''))) as posible_duplicado
from pagos p join cuentas_origen co on co.id = p.cuenta_origen_id
where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ') and co.requiere_extracto
  and not exists (select 1 from movimientos_bancarios m where m.pago_id = p.id)
  and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  and extracto_cubre(co.id, p.fecha + 5);

-- Lo que ya estaba cargado: conciliar una vez.
select conciliar_movimientos(id) from empresas;

-- ---------------------------------------------------------------- Seguridad

revoke all on flujo_lineas, flujo_control, pagos_sin_debito from public, anon, authenticated;
grant select on flujo_lineas, flujo_control, pagos_sin_debito to authenticated;
grant all on flujo_lineas, flujo_control, pagos_sin_debito to service_role;
revoke execute on function extracto_cubre(uuid, date), cuenta_de_pago(text, text, text, text), pago_con_cuenta(), vincular_pagos_a_cuentas(),
  conciliar_movimientos(text), conciliar_tras_cambio(), soltar_movimiento_de_anulado() from public, anon, authenticated;
grant execute on function vincular_pagos_a_cuentas(), conciliar_movimientos(text) to service_role;
grant execute on function extracto_cubre(uuid, date) to authenticated, service_role;
grant execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text) to authenticated, service_role;


-- ======================================== 0031_correcciones_revision.sql
-- T-208 · Correcciones de la revisión técnica de Tesorería sin planillas (T-207, 26/11/2026; 0023 a 0030).
--
-- No cambia migraciones anteriores: redefine lo que hace falta. Qué corrige (n.º del hallazgo de la revisión):
--
--    3. Rendimiento. La conciliación se calcula con funciones de ventana (antes: una subconsulta por fila). El
--       Flujo se arma en flujo_lineas_entre(desde, hasta, unidad, solo_real): el rango de fechas se aplica ANTES
--       de buscar el destino de cada línea, y el destino se resuelve por conjuntos (una vez por combinación
--       distinta de datos, no una llamada a flujo_destino por línea). El control contra bancos suma lo real
--       una sola vez por unidad y día. La pantalla pide flujo_rango() y flujo_control_rango() en una llamada.
--   17. hoy_ar(): "hoy" es la fecha de Buenos Aires, no la del servidor (UTC). De 21 a 24 h ya era mañana.
--    2. Comprobante "Extracto Bancario" por cuenta: 0999X-AAAAMMDD, con un dígito por cuenta del mismo banco
--       y empresa (cuentas_origen.digito_comprobante). Los comprobantes que ya existen (09990) no cambian.
--    1. Contraparte de FCI: asignar_contraparte() para cuando la cuenta tiene más de un fondo (con uno solo
--       ya lo hace 0030). Un "rendimiento" de más del 1 % diario queda REVISAR, no OK.
--    5, 6. Asiento del día: se puede regenerar (llegó otro movimiento, cambió una cuenta, dio error); no se
--       regenera ni se anula uno que se está enviando; si se anuló y Xubio lo aceptó, queda para anular allá.
--    7, 8, 15. Cheques: un pago no se cubre dos veces; acreedor y proveedor de la misma organización; marcar
--       debitado no reabre un movimiento contabilizado ni acepta fechas imposibles.
--   10, 19. importar_extracto: no duplica lo que entró por la migración desde planillas; el orden entre
--       movimientos iguales se calcula sobre la misma clave que la huella.
--   12. facturas_para_xubio no devuelve comprobantes bancarios (tienen su propio robot).
--   13. generar_comprobante_gastos no toca un comprobante que se está enviando.
--   14. Reclasificar o aprender GASTO_BANCARIO lo manda al comprobante.
--   16. flujo_reglas: unidad y fila de la empresa de la regla.
--   18. unidad_por_defecto, fila_especial y flujo_destino dejan de saltear las reglas de lectura.
--   20. Un ajuste de importe en una factura con pago sin factura (ESPERA_FC) no vuelve a sumar lo ya pagado.
--
-- (4: el doble conteo pago + débito ya lo resolvió 0030 al vincular el movimiento con su documento. 9, 11 y
--  21 son de las funciones de Netlify y del script de migración, no de la base.)

-- ---------------------------------------------------------------- 17. Hoy, en Buenos Aires

create or replace function hoy_ar()
returns date language sql stable as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date
$$;
revoke execute on function hoy_ar() from public, anon;
grant execute on function hoy_ar() to authenticated, service_role;

alter table control_envios alter column fecha set default hoy_ar();

-- ---------------------------------------------------------------- 18. Funciones que salteaban las reglas de lectura

-- Dentro de las vistas (que leen como la persona) y de los disparadores (que corren como el dueño) dan lo mismo
-- que antes; llamadas sueltas por una persona, ya no devuelven ids de empresas que no ve.
alter function unidad_por_defecto(text) security invoker;
alter function fila_especial(uuid, text) security invoker;
revoke execute on function unidad_por_defecto(text), fila_especial(uuid, text) from public, anon;

-- ---------------------------------------------------------------- 2. Dígito del comprobante por cuenta

-- 0999X: X identifica la cuenta entre las del mismo banco (CUIT) y la misma empresa. Se asigna solo (el menor
-- libre) cuando la cuenta toma su CUIT de banco y no cambia más: así el número del comprobante es estable.
alter table cuentas_origen add column digito_comprobante smallint check (digito_comprobante between 0 and 9);

-- Las cuentas que ya están: la que ya tiene comprobantes 09990 conserva el 0; las demás, por orden.
with r as (
  select c.id, row_number() over (
           partition by c.empresa_id, c.cuit_banco
           order by (select count(*) from facturas f where f.cuenta_origen_extracto_id = c.id and f.punto_venta = 9990) desc,
                    c.orden, c.nombre, c.id) - 1 as d
  from cuentas_origen c where c.cuit_banco is not null
)
update cuentas_origen c set digito_comprobante = r.d from r where r.id = c.id and r.d <= 9;

create unique index cuentas_origen_digito_comprobante on cuentas_origen (empresa_id, cuit_banco, digito_comprobante)
  where cuit_banco is not null and digito_comprobante is not null;

create or replace function cuenta_con_digito()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cuit_banco is null then
    new.digito_comprobante := null;
  elsif tg_op = 'INSERT' or new.digito_comprobante is null
        or (new.cuit_banco, new.empresa_id) is distinct from (old.cuit_banco, old.empresa_id) then
    -- El que pidieron, si está libre; si no, el menor libre. Con más de 10 cuentas del banco queda vacío
    -- (y generar_comprobante_gastos avisa).
    if new.digito_comprobante is null or tg_op = 'UPDATE' or exists (
         select 1 from cuentas_origen x where x.empresa_id = new.empresa_id and x.cuit_banco = new.cuit_banco
           and x.digito_comprobante = new.digito_comprobante and x.id <> new.id) then
      select min(g) into new.digito_comprobante from generate_series(0, 9) g
      where not exists (select 1 from cuentas_origen x where x.empresa_id = new.empresa_id and x.cuit_banco = new.cuit_banco
                          and x.digito_comprobante = g and x.id <> new.id);
    end if;
  end if;
  return new;
end $$;
create trigger trg_cuenta_con_digito before insert or update of cuit_banco, empresa_id, digito_comprobante on cuentas_origen
  for each row execute function cuenta_con_digito();
revoke execute on function cuenta_con_digito() from public, anon, authenticated;

-- Movimientos que quedaron apuntando al comprobante de OTRA cuenta (el error que se corrige): se sueltan si el
-- comprobante no subió. Vuelven a aparecer como "sin comprobante" y se regeneran, cada cuenta el suyo.
update movimientos_bancarios m set factura_id = null
from facturas f
where f.id = m.factura_id and f.cuenta_origen_extracto_id is not null and f.cuenta_origen_extracto_id <> m.cuenta_origen_id
  and f.estado_xubio <> 'SUBIDA' and f.xubio_envio_en is null;

-- Junta en un comprobante "Extracto Bancario" lo facturable del banco en la cuenta y el día. Número
-- 0999X-AAAAMMDD (X = dígito de la cuenta), proveedor = el banco (por CUIT). Si ya existe y no subió a Xubio,
-- lo actualiza; si ya subió o se está enviando, no lo toca (13).
create or replace function generar_comprobante_gastos(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; u usuarios; v_prov uuid; f facturas; otra facturas; v_neto numeric; v_iva numeric; v_perc numeric; v_perc_json jsonb;
  v_numero integer := to_char(p_fecha, 'YYYYMMDD')::integer; v_org uuid; v_pv integer; v_nro text;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if not es_servidor() then u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if c.cuit_banco is null then raise exception 'Falta el CUIT del banco en la cuenta %', c.nombre; end if;
  if c.digito_comprobante is null then
    raise exception 'La cuenta % no tiene dígito de comprobante: hay más de 10 cuentas de ese banco en la empresa', c.nombre;
  end if;
  v_pv := 9990 + c.digito_comprobante;

  select coalesce(sum(-importe) filter (where componente = 'NETO'), 0),
         coalesce(sum(-importe) filter (where componente = 'IVA'), 0),
         coalesce(sum(-importe) filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', componente, 'cuenta', cuenta_contable, 'importe', -importe, 'movimiento', id))
                  filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), '[]')
  into v_neto, v_iva, v_perc, v_perc_json
  from movimientos_bancarios
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';

  -- El comprobante de ESTA cuenta para ese día (los de antes de 0031 son todos 09990, sea cual sea el dígito).
  select * into f from facturas
  where empresa_id = c.empresa_id and tipo = 'Extracto Bancario' and cuenta_origen_extracto_id = c.id and numero = v_numero
    and punto_venta between 9990 and 9999
  order by (punto_venta = v_pv) desc limit 1 for update;
  v_nro := lpad(coalesce(f.punto_venta, v_pv)::text, 5, '0') || '-' || v_numero;

  if v_neto + v_iva + v_perc = 0 then
    -- Ya no queda nada facturable ese día (se reclasificó): un comprobante sin aprobar ni enviar queda rechazado.
    if f.id is not null and f.estado = 'PENDIENTE_APROBACION' and f.estado_xubio <> 'SUBIDA' and f.xubio_envio_en is null then
      update facturas set estado = 'RECHAZADA', motivo_validacion = 'Sin movimientos facturables: se reclasificaron', actualizado_en = now()
      where id = f.id;
    end if;
    return null;
  end if;
  if f.id is not null and f.estado_xubio = 'SUBIDA' then
    raise exception 'El comprobante % ya está en Xubio: no se regenera', v_nro;
  end if;
  if f.id is not null and f.xubio_envio_en is not null then
    raise exception 'El comprobante % se está enviando a Xubio: esperá el resultado', v_nro;
  end if;

  select organizacion_id into v_org from empresas where id = c.empresa_id;
  insert into proveedores (cuit, nombre, organizacion_id) values (c.cuit_banco, coalesce(c.banco, c.nombre), v_org)
  on conflict (organizacion_id, cuit) do nothing;
  select id into v_prov from proveedores where cuit = c.cuit_banco and organizacion_id = v_org;

  if f.id is null then
    select * into otra from facturas where empresa_id = c.empresa_id and proveedor_id = v_prov and tipo = 'Extracto Bancario'
      and punto_venta = v_pv and numero = v_numero;
    if otra.id is not null then
      raise exception 'El número % ya lo usa un comprobante de otra cuenta (de antes de separar por cuenta): rechazalo o anulalo y volvé a generar', v_nro;
    end if;
    insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, vencimiento, neto, iva, percepciones,
                          percepciones_json, total, origen, estado, validacion_ok, cuenta_contable, metodo_pago, cuenta_origen_extracto_id)
    values (c.empresa_id, v_prov, 'Extracto Bancario', v_pv, v_numero, p_fecha, p_fecha, v_neto, v_iva, v_perc, v_perc_json,
            v_neto + v_iva + v_perc, 'EXTRACTO', 'PENDIENTE_APROBACION', true, 'GASTOS BANCARIOS', 'DEBITO', c.id)
    returning * into f;
  else
    update facturas set neto = v_neto, iva = v_iva, percepciones = v_perc, percepciones_json = v_perc_json,
      total = v_neto + v_iva + v_perc, estado_xubio = 'PENDIENTE', xubio_error = null, actualizado_en = now()
    where id = f.id returning * into f;
  end if;
  update movimientos_bancarios set factura_id = f.id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';
  return f.id;
end $$;

-- 12. El subidor general de facturas no toma comprobantes bancarios: los sube xubio-bancos-pendientes. Antes
-- ocupaban el lote de 5 y las facturas comunes no subían nunca.
create or replace function facturas_para_xubio(p_max integer, p_organizacion uuid)
returns setof facturas language sql security definer set search_path = public as $$
  select f.* from facturas f join empresas e on e.id = f.empresa_id
  where e.organizacion_id = p_organizacion and e.erp = 'XUBIO' and f.estado_xubio = 'PENDIENTE' and f.xubio_envio_en is null
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA')
    and f.cuenta_origen_extracto_id is null
  order by f.aprobado_en nulls last
  limit p_max
$$;

-- ---------------------------------------------------------------- 5, 6. Asiento del día

create or replace function generar_asiento_bancario(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; a asientos; v_id uuid; v_cuenta_banco text; v_usuario text; v_nuevos boolean;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if es_servidor() then v_usuario := 'servidor'; else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN')).email; end if;
  select nombre into v_cuenta_banco from cuentas_contables where id = c.cuenta_contable_id;
  if v_cuenta_banco is null then raise exception 'La cuenta % no tiene su cuenta contable de Xubio', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
             and destino_xubio = 'ASIENTO' and cuenta_contable is null and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos del asiento sin cuenta contable: clasificalos primero';
  end if;
  select exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') into v_nuevos;
  select * into a from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null for update;
  -- Sin asiento vigente y sin movimientos para asentar: no hay nada que hacer.
  if a.id is null and not v_nuevos then return null; end if;
  if a.id is not null then
    -- Uno que se está enviando (o quedó "sin confirmar") no se toca: en Xubio puede estar creado.
    if a.envio_xubio_en is not null then
      raise exception 'El asiento de ese día se está enviando a Xubio: esperá el resultado';
    end if;
    if a.estado_xubio = 'SUBIDA' then
      if not v_nuevos then return null; end if;
      raise exception 'El asiento de ese día ya está en Xubio: anulalo para rehacerlo';
    end if;
    -- Vigente y sin subir (pendiente o con error): se rehace entero. Primero se sueltan sus movimientos.
    update movimientos_bancarios set asiento_id = null where asiento_id = a.id;
    delete from asientos where id = a.id;
  end if;
  if not exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and estado <> 'IGNORADO') then
    return null;   -- se reclasificó todo: el asiento viejo se fue y no hay uno nuevo
  end if;
  insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
  values (c.empresa_id, p_cuenta, p_fecha, 'BANCARIO_DIARIO', 'Movimientos del extracto ' || c.nombre || ' ' || to_char(p_fecha, 'DD/MM/YYYY'), v_usuario)
  returning id into v_id;
  -- Cada cuenta, neta: un débito del banco va al debe de la cuenta y al haber del banco.
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, m.cuenta_contable, greatest(-sum(m.importe), 0), greatest(sum(m.importe), 0), string_agg(distinct m.categoria, ', ')
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  group by m.cuenta_contable having sum(m.importe) <> 0;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, v_cuenta_banco, greatest(sum(m.importe), 0), greatest(-sum(m.importe), 0), 'Banco'
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  having sum(m.importe) <> 0;
  update movimientos_bancarios set asiento_id = v_id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO' and estado <> 'IGNORADO';
  return v_id;
end $$;

-- Si el asiento se anuló mientras se enviaba y Xubio lo aceptó, queda vivo allá: pendiente de anular en Xubio.
create or replace function resultado_asiento_xubio(p_id uuid, p_ok boolean, p_xubio_id text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update asientos set estado_xubio = case when p_ok then 'SUBIDA' else 'ERROR' end::estado_xubio,
    xubio_id = coalesce(p_xubio_id, xubio_id), xubio_error = case when p_ok then null else p_error end, envio_xubio_en = null,
    anulacion_xubio = case when p_ok and anulado_en is not null then 'PENDIENTE' else anulacion_xubio end
  where id = p_id;
  if p_ok then
    update movimientos_bancarios set estado = 'CONTABILIZADO' where asiento_id = p_id and estado in ('PENDIENTE', 'A_REVISAR');
  end if;
end $$;

create or replace function anular_asiento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; a asientos;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  select * into a from asientos where id = p_id for update;
  if a.id is null then raise exception 'Asiento inexistente'; end if;
  perform exigir_empresa(a.empresa_id);
  if a.anulado_en is not null then raise exception 'El asiento ya está anulado'; end if;
  if a.envio_xubio_en is not null and a.xubio_id is null then
    raise exception 'El asiento se está enviando a Xubio: esperá el resultado y anulalo después';
  end if;
  update asientos set anulado_por = u.email, anulado_en = now(), motivo_anulacion = p_motivo,
    anulacion_xubio = case when a.xubio_id is not null then 'PENDIENTE' else 'HECHA' end
  where id = p_id;
  update movimientos_bancarios set asiento_id = null, estado = 'PENDIENTE' where asiento_id = p_id;
  perform registrar_auditoria(u, 'ANULAR', 'ASIENTO', p_id::text, p_motivo);
end $$;

-- ---------------------------------------------------------------- 14. Reclasificar

-- p_componente (nuevo, opcional): qué parte del comprobante es (NETO, IVA, PERCEPCION_IVA, PERCEPCION_IIBB). Un
-- GASTO_BANCARIO sin componente va como NETO. Con componente, el movimiento va al comprobante; IMPUESTO, FCI,
-- rendimientos e intereses sin componente, al asiento. Si el movimiento estaba en un comprobante o un asiento
-- sin subir, se suelta y ese documento se rehace.
drop function reclasificar_movimiento(uuid, text, text, text);
create or replace function reclasificar_movimiento(p_id uuid, p_categoria text, p_cuenta text, p_aprender_patron text default null,
                                                   p_componente text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; mv movimientos_bancarios; r reglas_extracto; v_destino text; v_comp text; v_estado estado_xubio; v_envio timestamptz;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into mv from movimientos_bancarios where id = p_id for update;
  if mv.id is null then raise exception 'Movimiento inexistente'; end if;
  perform exigir_empresa(mv.empresa_id);
  if mv.estado in ('CONTABILIZADO', 'CARGADO_A_MANO') then raise exception 'El movimiento ya está contabilizado'; end if;
  v_comp := coalesce(nullif(trim(p_componente), ''), case when p_categoria = 'GASTO_BANCARIO' then 'NETO' end);
  v_destino := case when v_comp is not null then 'COMPROBANTE'
                    when p_categoria in ('IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES') then 'ASIENTO' else 'NINGUNO' end;
  if mv.factura_id is not null then
    select estado_xubio, xubio_envio_en into v_estado, v_envio from facturas where id = mv.factura_id;
    if v_estado = 'SUBIDA' or v_envio is not null then raise exception 'El movimiento está en un comprobante que ya se envió a Xubio'; end if;
  end if;
  if mv.asiento_id is not null then
    select estado_xubio, envio_xubio_en into v_estado, v_envio from asientos where id = mv.asiento_id;
    if v_estado = 'SUBIDA' or v_envio is not null then raise exception 'El movimiento está en un asiento que ya se envió a Xubio: anulá el asiento primero'; end if;
  end if;
  if p_aprender_patron is not null and trim(p_aprender_patron) <> '' then
    if position(texto_banco(p_aprender_patron) in texto_banco(mv.descripcion)) = 0 then
      raise exception 'El texto a aprender no está en la descripción del movimiento';
    end if;
    insert into reglas_extracto (empresa_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota, creada_por)
    values (mv.empresa_id, 5, array[texto_banco(p_aprender_patron)], case when mv.importe < 0 then 'DEBITO' else 'CREDITO' end,
            p_categoria, p_cuenta, v_destino, v_comp,
            'Aprendida de ' || u.email || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'), u.email)
    returning * into r;
  end if;
  update movimientos_bancarios set categoria = p_categoria, cuenta_contable = p_cuenta, regla_id = r.id,
    destino_xubio = v_destino, componente = v_comp, factura_id = null, asiento_id = null,
    estado = 'PENDIENTE', revisado_por = u.email, revisado_en = now()
  where id = p_id;
  -- El documento del que salió se rehace sin este movimiento (si quedó vacío, desaparece o queda rechazado).
  if mv.factura_id is not null then perform generar_comprobante_gastos(mv.cuenta_origen_id, mv.fecha); end if;
  if mv.asiento_id is not null then
    update movimientos_bancarios set asiento_id = null where asiento_id = mv.asiento_id;
    delete from asientos where id = mv.asiento_id;
    if exists (select 1 from cuentas_origen c where c.id = mv.cuenta_origen_id and c.cuenta_contable_id is not null)
       and not exists (select 1 from movimientos_bancarios where cuenta_origen_id = mv.cuenta_origen_id and fecha = mv.fecha
                         and destino_xubio = 'ASIENTO' and cuenta_contable is null and estado <> 'IGNORADO') then
      perform generar_asiento_bancario(mv.cuenta_origen_id, mv.fecha);
    end if;
  end if;
  perform registrar_auditoria(u, 'RECLASIFICAR', 'MOVIMIENTO', p_id::text, p_categoria || ' · ' || coalesce(p_cuenta, '') || coalesce(' · ' || v_comp, ''));
end $$;
revoke execute on function reclasificar_movimiento(uuid, text, text, text, text) from public, anon;
grant execute on function reclasificar_movimiento(uuid, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------- 1. Contraparte de un movimiento (FCI, entre cuentas)

-- Con un solo fondo en la cuenta madre lo completa 0030. Con varios, o en una transferencia entre cuentas
-- propias, lo elige Tesorería. p_cuenta null la quita.
create or replace function asignar_contraparte(p_mov uuid, p_cuenta uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; mv movimientos_bancarios; c cuentas_origen;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into mv from movimientos_bancarios where id = p_mov for update;
  if mv.id is null then raise exception 'Movimiento inexistente'; end if;
  perform exigir_empresa(mv.empresa_id);
  if mv.estado = 'IGNORADO' then raise exception 'El movimiento está ignorado'; end if;
  if p_cuenta is not null then
    select * into c from cuentas_origen where id = p_cuenta;
    if c.id is null or c.empresa_id <> mv.empresa_id then
      raise exception 'La contraparte tiene que ser otra cuenta de la misma empresa';
    end if;
    if not c.activa then raise exception '% está dada de baja', c.nombre; end if;
  end if;
  update movimientos_bancarios set contraparte_cuenta_id = p_cuenta, revisado_por = u.email, revisado_en = now() where id = p_mov;
  perform registrar_auditoria(u, 'CONTRAPARTE', 'MOVIMIENTO', p_mov::text, coalesce(c.nombre, 'sin contraparte'));
end $$;
revoke execute on function asignar_contraparte(uuid, uuid) from public, anon;
grant execute on function asignar_contraparte(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- 10, 19. Importar extracto

-- Igual que 0029, con tres cambios:
--   · Los movimientos se vinculan con su pago, cheque o cobro (0030) UNA vez al final del archivo, no después
--     de cada movimiento: con un año de datos, un extracto de 300 movimientos tardaba 30 veces más.
--   · El n.º de orden entre movimientos iguales se calcula sobre la clave normalizada (la misma de la huella).
--     Antes se ordenaba por el texto crudo: dos iguales que no quedaban juntos chocaban y uno se perdía.
--   · Lo que entró por la migración desde planillas (huella VBI:, MOTOR: o LEGADO-) no se duplica: si en la
--     cuenta ya hay un movimiento migrado del mismo día, importe y descripción, el del archivo no entra (uno
--     por cada migrado). Devuelve cuántos en ya_migrados.
create or replace function conciliar_tras_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  -- importar_extracto concilia una sola vez cuando termina de cargar el archivo.
  if current_setting('tesoreria.conciliar_al_final', true) = '1' then return null; end if;
  for e in select distinct empresa_id from nuevos loop perform conciliar_movimientos(e); end loop;
  return null;
end $$;
revoke execute on function conciliar_tras_cambio() from public, anon, authenticated;

create or replace function importar_extracto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; v_ext uuid; v_nuevos int := 0; v_total int := 0; v_revisar int := 0; v_migrados int := 0; m record; r reglas_extracto;
  v_huella text; v_id uuid; v_usuario text := coalesce(p->>'usuario', 'servidor');
  v_desde date; v_hasta date; v_origen text := coalesce(nullif(p->>'origen_saldos', ''), 'EXTRACTO'); v_saldos int;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if coalesce(p->'archivo'->>'hash', '') = '' then raise exception 'Falta la huella del archivo'; end if;
  if v_origen not in ('EXTRACTO', 'TENENCIA') then raise exception 'Origen de saldos inválido: %', v_origen; end if;
  if v_origen = 'TENENCIA' and c.clase not in ('FCI', 'REMUNERADA') then
    raise exception 'Una tenencia va a una cuenta FCI o remunerada, no a % (%)', c.nombre, c.clase;
  end if;
  if v_origen = 'TENENCIA' and jsonb_array_length(coalesce(p->'movimientos', '[]')) > 0 then
    raise exception 'Una tenencia trae solo saldos: los movimientos del fondo entran por la cuenta madre';
  end if;

  select id into v_ext from extractos where cuenta_origen_id = c.id and archivo_hash = p->'archivo'->>'hash';
  if v_ext is not null then
    return jsonb_build_object('extracto_id', v_ext, 'repetido', true, 'movimientos', 0, 'nuevos', 0, 'a_revisar', 0,
                              'saldos', 0, 'origen_saldos', v_origen, 'ya_migrados', 0);
  end if;
  select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'movimientos', '[]')) x;
  if v_desde is null then
    select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'saldos', '[]')) x;
  end if;
  insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_path, archivo_hash, formato, desde, hasta, importado_por)
  values (c.empresa_id, c.id, p->'archivo'->>'nombre', p->'archivo'->>'path', p->'archivo'->>'hash', p->'archivo'->>'formato',
          v_desde, v_hasta, v_usuario)
  returning id into v_ext;

  -- La huella: fecha|importe|descripción|referencia|n.º de orden entre los iguales. El orden sale de la misma
  -- clave (y, entre iguales, de la posición en el archivo).
  perform set_config('tesoreria.conciliar_al_final', '1', true);
  for m in
    select z.x, z.clave, z.fecha, z.importe, z.texto,
           (row_number() over (partition by z.clave order by z.n) - 1)::int as orden,
           (row_number() over (partition by z.fecha, z.importe, z.texto order by z.clave, z.n) - 1)::int as orden_sin_ref
    from (
      select t.x, t.n, (t.x->>'fecha')::date as fecha, round((t.x->>'importe')::numeric, 2) as importe, texto_banco(t.x->>'descripcion') as texto,
             concat_ws('|', t.x->>'fecha', round((t.x->>'importe')::numeric, 2), texto_banco(t.x->>'descripcion'), coalesce(t.x->>'referencia', '')) as clave
      from jsonb_array_elements(coalesce(p->'movimientos', '[]')) with ordinality as t(x, n)
    ) z
    order by z.clave, z.n
  loop
    v_total := v_total + 1;
    -- ¿Ya entró por la migración desde planillas? (uno del archivo por cada migrado igual)
    if m.orden_sin_ref < (select count(*) from movimientos_bancarios l
                          where l.cuenta_origen_id = c.id and l.fecha = m.fecha and l.importe = m.importe
                            and texto_banco(l.descripcion) = m.texto
                            and (l.huella like 'VBI:%' or l.huella like 'MOTOR:%' or l.huella like 'LEGADO-%')) then
      v_migrados := v_migrados + 1;
      continue;
    end if;
    v_huella := md5(m.clave || '|' || m.orden);
    r := regla_para_movimiento(c.id, m.x->>'descripcion', (m.x->>'importe')::numeric);
    insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, referencia, numero_cheque,
                                       huella, extracto_id, orden, categoria, cuenta_contable, regla_id, destino_xubio, componente, estado)
    values (c.empresa_id, c.id, m.fecha, m.x->>'descripcion', m.importe,
            (m.x->>'saldo')::numeric, m.x->>'referencia', nullif(m.x->>'numero_cheque', ''), v_huella, v_ext, m.orden,
            coalesce(r.categoria, 'SIN_CLASIFICAR'), r.cuenta_contable, r.id, coalesce(r.destino_xubio, 'NINGUNO'), r.componente,
            case when r.id is null then 'A_REVISAR' when r.categoria = 'INFORMATIVO' then 'INFORMATIVO' else 'PENDIENTE' end)
    on conflict (cuenta_origen_id, huella) do nothing
    returning id into v_id;
    if v_id is not null then
      v_nuevos := v_nuevos + 1;
      if r.id is null then v_revisar := v_revisar + 1; end if;
      v_id := null;
    end if;
  end loop;
  -- Vincular cada movimiento con su pago, cheque o cobro: una vez, con todo el archivo adentro.
  perform set_config('tesoreria.conciliar_al_final', '', true);
  if v_nuevos > 0 then perform conciliar_movimientos(c.empresa_id); end if;

  -- Saldos de cierre: los que informa el archivo; si no, el saldo del último movimiento de cada día.
  -- Un saldo cargado a mano (MANUAL) no se pisa.
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, extracto_id, cargado_por)
  select c.id, d.fecha, c.empresa_id, d.saldo, v_origen, v_ext, v_usuario
  from (
    select (x->>'fecha')::date as fecha, (x->>'saldo')::numeric as saldo from jsonb_array_elements(coalesce(p->'saldos', '[]')) x
    union all
    (select distinct on ((t.x->>'fecha')::date) (t.x->>'fecha')::date, (t.x->>'saldo')::numeric
     from jsonb_array_elements(coalesce(p->'movimientos', '[]')) with ordinality as t(x, n)
     where t.x->>'saldo' is not null and jsonb_array_length(coalesce(p->'saldos', '[]')) = 0
     order by (t.x->>'fecha')::date, t.n desc)
  ) d
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = excluded.origen, extracto_id = excluded.extracto_id,
        cargado_por = excluded.cargado_por, cargado_en = now()
    where saldos_bancarios.origen <> 'MANUAL';
  get diagnostics v_saldos = row_count;

  update extractos set movimientos = v_total, nuevos = v_nuevos where id = v_ext;
  insert into auditoria (usuario, accion, entidad, entidad_id, detalle, empresa_id)
  values (v_usuario, case when v_origen = 'TENENCIA' then 'IMPORTAR_TENENCIA' else 'IMPORTAR_EXTRACTO' end, 'EXTRACTO', v_ext::text,
          c.nombre || ': ' || case when v_origen = 'TENENCIA' then v_saldos || ' saldo(s) de tenencia'
                                   else v_nuevos || ' nuevos de ' || v_total end
            || case when v_migrados > 0 then ' (' || v_migrados || ' ya migrados de la planilla)' else '' end, c.empresa_id);
  return jsonb_build_object('extracto_id', v_ext, 'repetido', false, 'movimientos', v_total, 'nuevos', v_nuevos,
                            'a_revisar', v_revisar, 'saldos', v_saldos, 'origen_saldos', v_origen, 'ya_migrados', v_migrados);
end $$;
revoke execute on function importar_extracto(jsonb) from public, anon, authenticated;
grant execute on function importar_extracto(jsonb) to service_role;

-- ---------------------------------------------------------------- 7, 8, 15. Cheques

-- 8. En cualquier camino: el acreedor y el proveedor de un cheque son de la organización de su empresa.
create or replace function cheque_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if not exists (select 1 from cuentas_origen c where c.id = new.cuenta_origen_id and c.empresa_id = new.empresa_id) then
    raise exception 'La chequera es de otra empresa';
  end if;
  if new.acreedor_id is not null or new.proveedor_id is not null then
    select organizacion_id into v_org from empresas where id = new.empresa_id;
    if new.acreedor_id is not null and not exists (select 1 from acreedores a where a.id = new.acreedor_id and a.organizacion_id = v_org) then
      raise exception 'El acreedor es de otra organización';
    end if;
    if new.proveedor_id is not null and not exists (select 1 from proveedores p where p.id = new.proveedor_id and p.organizacion_id = v_org) then
      raise exception 'El proveedor es de otra organización';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.estado = 'DEBITADO' and new.estado = 'DEBITADO'
     and (new.importe, new.numero, new.cuenta_origen_id) is distinct from (old.importe, old.numero, old.cuenta_origen_id) then
    raise exception 'El cheque ya se debitó: no se cambia importe, número ni chequera';
  end if;
  return new;
end $$;

-- 7. Un pago no se cubre con cheques por más que su importe (los anulados y rechazados no cuentan).
create or replace function emitir_cheque(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_id uuid; v_org uuid; v_acr uuid; v_suma numeric;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  perform exigir_empresa(p->>'empresa_id');
  select organizacion_id into v_org from empresas where id = p->>'empresa_id';
  v_acr := coalesce((p->>'acreedor_id')::uuid, acreedor_para(v_org, (p->>'proveedor_id')::uuid, p->>'beneficiario'));
  insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, proveedor_id, beneficiario, importe,
                       fecha_emision, fecha_pago, origen, observaciones, creado_por)
  values (p->>'empresa_id', (p->>'cuenta_origen_id')::uuid, p->>'tipo', trim(p->>'numero'), v_acr, (p->>'proveedor_id')::uuid,
          trim(p->>'beneficiario'), round((p->>'importe')::numeric, 2), (p->>'fecha_emision')::date, (p->>'fecha_pago')::date,
          coalesce(p->>'origen', 'PAGO'), p->>'observaciones', u.email)
  returning id into v_id;
  insert into cheques_pagos (cheque_id, pago_id, importe)
  select v_id, (x->>'pago_id')::uuid, round((x->>'importe')::numeric, 2) from jsonb_array_elements(coalesce(p->'pagos', '[]')) x;
  if exists (select 1 from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = v_id and pg.empresa_id <> p->>'empresa_id') then
    raise exception 'Un pago del lote es de otra empresa';
  end if;
  select sum(importe) into v_suma from cheques_pagos where cheque_id = v_id;
  if v_suma is not null and v_suma <> round((p->>'importe')::numeric, 2) then
    raise exception 'Los pagos del lote suman % y el cheque es de %', v_suma, p->>'importe';
  end if;
  if exists (select 1 from cheques_pagos cp join cheques ch on ch.id = cp.cheque_id join pagos pg on pg.id = cp.pago_id
             where cp.pago_id in (select x.pago_id from cheques_pagos x where x.cheque_id = v_id)
               and ch.estado not in ('ANULADO', 'RECHAZADO')
             group by cp.pago_id, pg.importe having sum(cp.importe) > pg.importe) then
    raise exception 'Un pago del lote ya está cubierto por otro cheque';
  end if;
  perform registrar_auditoria(u, 'EMITIR_CHEQUE', 'CHEQUE', v_id::text, (p->>'tipo') || ' ' || (p->>'numero') || ' · ' || (p->>'importe'));
  return v_id;
end $$;

-- 15. Marcar debitado: la fecha va entre la emisión y hoy, y un movimiento ya contabilizado no se reabre.
create or replace function marcar_cheque_debitado(p_id uuid, p_numero text, p_fecha date, p_movimiento uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; ch cheques; mv movimientos_bancarios;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into ch from cheques where id = p_id for update;
  if ch.id is null then raise exception 'Cheque inexistente'; end if;
  perform exigir_empresa(ch.empresa_id);
  if trim(p_numero) is distinct from ch.numero then raise exception 'El número no coincide con el cheque (%): no se marcó', ch.numero; end if;
  if ch.estado not in ('EMITIDO', 'ENTREGADO') then raise exception 'El cheque está %', ch.estado; end if;
  if p_fecha is null then raise exception 'Falta la fecha del débito'; end if;
  if p_fecha < ch.fecha_emision then
    raise exception 'El débito (%) no puede ser anterior a la emisión del cheque (%)', to_char(p_fecha, 'DD/MM/YYYY'), to_char(ch.fecha_emision, 'DD/MM/YYYY');
  end if;
  if p_fecha > hoy_ar() then raise exception 'El débito no puede tener fecha futura (%)', to_char(p_fecha, 'DD/MM/YYYY'); end if;
  if p_movimiento is not null then
    select * into mv from movimientos_bancarios where id = p_movimiento for update;
    if mv.id is null or mv.cuenta_origen_id <> ch.cuenta_origen_id or mv.importe <> -ch.importe then
      raise exception 'El movimiento no es de esa cuenta o no es por el importe del cheque';
    end if;
    update movimientos_bancarios set cheque_id = p_id, categoria = 'CHEQUE_PAGADO',
      estado = case when estado in ('CONTABILIZADO', 'CARGADO_A_MANO') then estado else 'PENDIENTE' end
    where id = p_movimiento;
  end if;
  update cheques set estado = 'DEBITADO', debitado_en = p_fecha, movimiento_id = p_movimiento, marcado_por = u.email, marcado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'CHEQUE_DEBITADO', 'CHEQUE', p_id::text, ch.numero || ' · ' || p_fecha);
end $$;

-- ---------------------------------------------------------------- 16. Reglas del Flujo consistentes

-- La unidad y la fila de una regla son de su empresa, y la fila es de esa unidad. Una regla de toda la
-- organización (sin empresa) no puede mandar a una unidad ni a una fila: solo excluir. Si viene la fila sin
-- la unidad, la unidad es la de la fila.
create or replace function flujo_regla_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_unidad_fila uuid; v_empresa_fila text;
begin
  if new.empresa_id is null and (new.unidad_id is not null or new.fila_id is not null or new.si_unidad_id is not null) then
    raise exception 'Una regla de toda la organización no puede elegir unidad ni fila: ponele la empresa';
  end if;
  if new.fila_id is not null then
    select f.unidad_id, u.empresa_id into v_unidad_fila, v_empresa_fila from flujo_filas f join unidades u on u.id = f.unidad_id where f.id = new.fila_id;
    if v_empresa_fila is distinct from new.empresa_id then raise exception 'La fila es de otra empresa'; end if;
    if new.unidad_id is null then new.unidad_id := v_unidad_fila;
    elsif new.unidad_id <> v_unidad_fila then raise exception 'La fila no es de esa unidad'; end if;
  end if;
  if new.unidad_id is not null and not exists (select 1 from unidades u where u.id = new.unidad_id and u.empresa_id = new.empresa_id) then
    raise exception 'La unidad es de otra empresa';
  end if;
  if new.si_unidad_id is not null and not exists (select 1 from unidades u where u.id = new.si_unidad_id and u.empresa_id = new.empresa_id) then
    raise exception 'La unidad de la condición es de otra empresa';
  end if;
  return new;
end $$;
create trigger trg_flujo_regla_consistente before insert or update on flujo_reglas
  for each row execute function flujo_regla_consistente();
revoke execute on function flujo_regla_consistente() from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. Rendimiento: índices y textos ya normalizados

-- El destino de una línea compara textos normalizados (texto_banco). Guardados en la fila y en la regla, no se
-- recalculan por cada línea del Flujo.
alter table flujo_filas add column cuenta_norm text generated always as (texto_banco(cuenta_contable)) stored;
alter table flujo_filas add column apertura_norm text generated always as (texto_banco(apertura)) stored;
alter table flujo_reglas add column si_cuenta_norm text generated always as (case when si_cuenta_contable is not null then texto_banco(si_cuenta_contable) end) stored;
alter table flujo_reglas add column si_texto_norm text generated always as (case when si_texto is not null then texto_banco(si_texto) end) stored;
create index flujo_filas_unidad_cuenta_norm on flujo_filas (unidad_id, cuenta_norm);
create index movimientos_bancarios_fecha on movimientos_bancarios (fecha);
create index movimientos_bancarios_pago on movimientos_bancarios (pago_id, fecha) where pago_id is not null;
create index movimientos_bancarios_contraparte on movimientos_bancarios (contraparte_cuenta_id, fecha) where contraparte_cuenta_id is not null;
create index movimientos_bancarios_factura on movimientos_bancarios (factura_id) where factura_id is not null;
create index movimientos_bancarios_asiento on movimientos_bancarios (asiento_id) where asiento_id is not null;

-- Las vistas que se rehacen (dependen unas de otras). Se vuelven a crear más abajo con las mismas columnas.
drop view control_bancos;
drop view flujo_control;
drop view flujo_lineas;
drop view conciliacion_bancaria;

-- ---------------------------------------------------------------- 3, 1. Conciliación con funciones de ventana

-- Por cuenta y día con saldo o con movimientos. Saldo calculado = último saldo anterior + movimientos desde
-- ese día (exclusive) hasta este (inclusive). Tolerancia: $1. Mismos resultados que la vista de 0024, en una
-- pasada: cada saldo abre un tramo y los movimientos se acumulan dentro del tramo.
-- p_solo_rinden: solo las cuentas FCI y remuneradas (lo que necesita el Flujo para el rendimiento).
create or replace function conciliacion_calculo(p_solo_rinden boolean default false)
returns table (empresa_id text, unidad_id uuid, cuenta_origen_id uuid, cuenta text, clase text, fecha date, fecha_anterior date,
               saldo_anterior numeric, creditos numeric, debitos numeric, movimientos bigint, saldo_calculado numeric,
               saldo_extracto numeric, origen text, diferencia numeric, rendimiento numeric, saldo_xubio numeric,
               diferencia_xubio numeric, estado text)
language sql stable as $$
  with ctas as (
    select c.id, c.empresa_id, c.unidad_id, c.nombre, c.clase from cuentas_origen c
    where not coalesce(p_solo_rinden, false) or c.clase in ('FCI', 'REMUNERADA')
  ), mov as (
    select m.cuenta_origen_id as cuenta_id, m.fecha, m.importe from movimientos_bancarios m
    where m.estado <> 'IGNORADO' and (not coalesce(p_solo_rinden, false) or m.cuenta_origen_id in (select id from ctas))
    union all
    select m.contraparte_cuenta_id, m.fecha, -m.importe from movimientos_bancarios m
    where m.contraparte_cuenta_id is not null and m.estado <> 'IGNORADO'
      and (not coalesce(p_solo_rinden, false) or m.contraparte_cuenta_id in (select id from ctas))
  ), pd as (
    select cuenta_id, fecha, coalesce(sum(importe) filter (where importe > 0), 0) as cred,
           coalesce(-sum(importe) filter (where importe < 0), 0) as deb, count(*) as n
    from mov group by cuenta_id, fecha
  ), d as (
    select coalesce(s.cuenta_origen_id, p.cuenta_id) as cuenta_id, coalesce(s.fecha, p.fecha) as fecha, s.saldo, s.origen,
           coalesce(p.cred, 0) as cred, coalesce(p.deb, 0) as deb, coalesce(p.n, 0) as n
    from (select s.* from saldos_bancarios s where not coalesce(p_solo_rinden, false) or s.cuenta_origen_id in (select id from ctas)) s
    full join pd p on p.cuenta_id = s.cuenta_origen_id and p.fecha = s.fecha
  ), g as (
    -- grupo = cuántos saldos hay antes de este día: los días de un mismo tramo comparten el saldo anterior.
    select d.*, count(d.saldo) over w1 as grupo, max(case when d.saldo is not null then d.fecha end) over w1 as fecha_anterior
    from d window w1 as (partition by d.cuenta_id order by d.fecha rows between unbounded preceding and 1 preceding)
  ), k as (
    select g.cuenta_id, g.fecha, g.saldo as saldo_extracto, g.origen, g.fecha_anterior, a.saldo as saldo_anterior,
           sum(g.cred) over w2 as creditos, sum(g.deb) over w2 as debitos, (sum(g.n) over w2)::bigint as movimientos
    from g left join saldos_bancarios a on a.cuenta_origen_id = g.cuenta_id and a.fecha = g.fecha_anterior
    window w2 as (partition by g.cuenta_id, g.grupo order by g.fecha)
  ), lx as (
    select distinct on (l.cuenta_origen_id, l.fecha) l.cuenta_origen_id, l.fecha, l.saldo
    from lecturas_xubio l where l.cuenta_origen_id is not null
    order by l.cuenta_origen_id, l.fecha, l.leido_en desc
  )
  select c.empresa_id, c.unidad_id, k.cuenta_id, c.nombre, c.clase, k.fecha,
         k.fecha_anterior, k.saldo_anterior, k.creditos, k.debitos, k.movimientos,
         k.saldo_anterior + k.creditos - k.debitos,
         k.saldo_extracto, k.origen,
         round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2),
         -- En un FCI o una remunerada lo que no explican los movimientos es el rendimiento del día.
         case when c.clase in ('FCI', 'REMUNERADA') and k.saldo_anterior is not null and k.saldo_extracto is not null
              then round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2) end,
         x.saldo,
         round(k.saldo_extracto - x.saldo, 2),
         case
           when k.saldo_extracto is null then 'SIN_EXTRACTO'
           when k.origen = 'SIN_MOVIMIENTOS' then 'SIN_MOVIMIENTOS'
           when k.saldo_anterior is null then 'PRIMER_SALDO'
           -- Un fondo no rinde más del 1 % por día: si "rindió" más, falta una suscripción o un rescate.
           when c.clase in ('FCI', 'REMUNERADA')
                and abs(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos))
                    > greatest(abs(k.saldo_anterior) * 0.01 * greatest(k.fecha - k.fecha_anterior, 1), 1) then 'REVISAR'
           when c.clase in ('FCI', 'REMUNERADA') then 'OK'
           when abs(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos)) <= 1 then 'OK'
           else 'DIFERENCIA'
         end
  from k
  join ctas c on c.id = k.cuenta_id
  left join lx x on x.cuenta_origen_id = k.cuenta_id and x.fecha = k.fecha
$$;
revoke execute on function conciliacion_calculo(boolean) from public, anon;
grant execute on function conciliacion_calculo(boolean) to authenticated, service_role;

create view conciliacion_bancaria with (security_invoker = true) as
select * from conciliacion_calculo(false);

-- ---------------------------------------------------------------- 3, 17, 20. Las líneas del Flujo

-- flujo_destino queda para consultas sueltas (el Flujo ya no la llama por línea): mismas reglas que
-- flujo_lineas_entre, leyendo como quien la llama, y con desempate fijo entre reglas iguales.
create or replace function flujo_destino(p_empresa text, p_unidad uuid, p_origen text, p_proveedor uuid,
                                         p_cuenta_contable text, p_cuenta_origen uuid, p_categoria text, p_texto text)
returns table (unidad_id uuid, fila_id uuid, excluir boolean)
language plpgsql stable security invoker set search_path = public as $$
declare r flujo_reglas; v_unidad uuid; v_fila uuid; v_prov text; v_hint uuid := coalesce(p_unidad, unidad_por_defecto(p_empresa));
begin
  select x.* into r from flujo_reglas x join empresas e on e.id = p_empresa
  where x.organizacion_id = e.organizacion_id and (x.empresa_id is null or x.empresa_id = p_empresa)
    and (x.si_origen is null or x.si_origen = p_origen)
    and (x.si_proveedor_id is null or x.si_proveedor_id = p_proveedor)
    and (x.si_cuenta_norm is null or x.si_cuenta_norm = texto_banco(p_cuenta_contable))
    and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = p_cuenta_origen)
    and (x.si_categoria is null or x.si_categoria = p_categoria)
    and (x.si_texto_norm is null or position(x.si_texto_norm in texto_banco(p_texto)) > 0)
    and (x.si_unidad_id is null or x.si_unidad_id = v_hint)
  order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null), x.creada_en, x.id limit 1;
  if r.id is not null and r.excluir then return query select null::uuid, null::uuid, true; return; end if;
  v_unidad := coalesce(r.unidad_id, v_hint);
  v_fila := r.fila_id;
  if v_fila is null and p_cuenta_contable is not null then
    select nombre into v_prov from proveedores where id = p_proveedor;
    select f.id into v_fila from flujo_filas f
    where f.unidad_id = v_unidad and f.activa and f.tipo in ('CUENTA', 'APERTURA')
      and f.cuenta_norm = texto_banco(p_cuenta_contable)
      and (f.tipo = 'CUENTA' or (v_prov is not null and position(f.apertura_norm in texto_banco(v_prov)) > 0))
    order by (f.tipo = 'APERTURA') desc, f.orden, f.id limit 1;
  end if;
  if v_fila is null then v_fila := fila_especial(v_unidad, 'SIN_CLASIFICAR'); end if;
  return query select v_unidad, v_fila, false;
end $$;
revoke execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text) from public, anon;
grant execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text) to authenticated, service_role;

-- Las líneas del Flujo entre dos fechas (null = sin límite), de una unidad (null = todas las que la persona
-- ve) y, con p_solo_real, solo lo real. Mismas reglas que la vista de 0030. Lo que cambia es CÓMO se calcula:
--   · el rango de fechas se aplica a cada origen antes de buscar su destino;
--   · el destino (regla, fila de la cuenta contable, "Sin clasificar") se resuelve una vez por cada combinación
--     distinta de empresa, origen, proveedor, cuenta, categoría y texto, y se une por conjuntos;
--   · "el extracto cubre ese día" sale de un rango por cuenta, no de una función por pago;
--   · el rendimiento de los FCI sale de la conciliación de esas cuentas solamente;
--   · "hoy" es hoy_ar() (17) y un ajuste de importe de una factura con pago sin factura descontado tiene como
--     tope lo que queda por pagar (20).
create or replace function flujo_lineas_entre(p_desde date default null, p_hasta date default null, p_unidad uuid default null,
                                              p_solo_real boolean default false)
returns table (empresa_id text, unidad_id uuid, fila_id uuid, fila text, seccion text, mueve_caja boolean,
               origen_tipo text, origen_id uuid, ocurrencia text, naturaleza text, fecha date, fecha_calculada date,
               importe numeric, contraparte text, concepto text, vencido boolean, ajustada boolean, editable boolean,
               cuenta_origen_id uuid, afecta_bancos boolean)
language sql stable as $$
with hoy as materialized (
  select hoy_ar() as h, dia_habil_desde(hoy_ar()) as habil
), reglas as materialized (
  select x.id, x.organizacion_id, x.empresa_id, x.prioridad, x.si_origen, x.si_proveedor_id, x.si_cuenta_norm, x.si_cuenta_origen_id,
         x.si_categoria, x.si_texto_norm, x.si_unidad_id, x.unidad_id, x.fila_id, x.excluir, x.creada_en
  from flujo_reglas x
), esp as materialized (
  -- Filas internas de cada unidad ("Sin clasificar", "Entre cuentas propias"): lo que devolvía fila_especial.
  select distinct on (f.unidad_id, f.seccion) f.unidad_id, f.seccion, f.id
  from flujo_filas f where f.tipo = 'INTERNO' and f.seccion in ('SIN_CLASIFICAR', 'ENTRE_CUENTAS')
  order by f.unidad_id, f.seccion, f.orden, f.id
), fcta as materialized (
  select distinct on (f.unidad_id, f.cuenta_norm) f.unidad_id, f.cuenta_norm, f.id
  from flujo_filas f where f.activa and f.tipo = 'CUENTA'
  order by f.unidad_id, f.cuenta_norm, f.orden, f.id
), fape as materialized (
  select f.unidad_id, f.cuenta_norm, f.apertura_norm, f.id, f.orden from flujo_filas f where f.activa and f.tipo = 'APERTURA'
), cob as materialized (
  -- Hasta dónde llegó el extracto de cada cuenta (extracto_cubre de 0030, por conjuntos): hay evidencia del
  -- banco (un movimiento o un saldo que no se cargó a mano) ese día o antes Y ese día o después.
  select c.id as cuenta_id,
         least((select min(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
               (select min(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as desde,
         greatest((select max(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
                  (select max(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as hasta
  from cuentas_origen c where c.requiere_extracto
), mvp as (
  -- El débito del banco vinculado a cada pago (el primero).
  select distinct on (m.pago_id) m.pago_id, m.fecha, m.cuenta_origen_id
  from movimientos_bancarios m where m.pago_id is not null
  order by m.pago_id, m.fecha, m.id
), fac as (
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join hoy
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', case when q.anticipo_pend > 0 then dia_habil_desde(greatest(f.fecha, hoy.h + 1)) end, q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where not coalesce(p_solo_real, false)
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), fac_desc as (
  -- ESPERA_FC (0028): lo pagado sin factura se descuenta de la más vieja a la más nueva.
  select x.*,
         least(x.importe, greatest(coalesce(a.importe, 0) - coalesce(x.acumulado_antes, 0), 0)) as descuento
  from (
    select fac.*,
           sum(fac.importe) over (partition by fac.empresa_id, fac.proveedor_id
                                  order by fac.fecha, fac.fecha_factura, fac.factura_id, fac.ocurrencia
                                  rows between unbounded preceding and 1 preceding) as acumulado_antes
    from fac
  ) x
  left join anticipos_sin_factura a on a.empresa_id = x.empresa_id and a.proveedor_id = x.proveedor_id
), base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque). Si el banco ya lo debitó (movimiento
  -- vinculado), cuenta ese día y en la unidad de esa cuenta.
  select p.empresa_id, coalesce(co.unidad_id, cm.unidad_id) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, coalesce(mv.fecha, p.fecha) as fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, coalesce(p.cuenta_origen_id, mv.cuenta_origen_id) as cuenta_origen_id, null::text as categoria,
         (mv.fecha is not null or p.medio::text <> 'CAJA') as afecta_bancos, 0::numeric as descuento
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join mvp mv on mv.pago_id = p.id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  left join cob on cob.cuenta_id = co.id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    -- Un pago de una cuenta con extracto es real cuando el banco lo debita. Si el extracto de esa cuenta para ese
    -- día está y el débito no aparece, el pago no salió: no entra y queda en pagos_sin_debito.
    and (mv.fecha is not null or co.id is null or not co.requiere_extracto or p.medio = 'CAJA'
         or not coalesce(cob.desde <= p.fecha and cob.hasta >= p.fecha, false))
    and (p_desde is null or coalesce(mv.fecha, p.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, p.fecha) <= p_hasta)
  union all
  -- REAL · cheques debitados (la categoría del acreedor elige la fila de cheques)
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
    and (p_desde is null or ch.debitado_en >= p_desde) and (p_hasta is null or ch.debitado_en <= p_hasta)
  union all
  -- REAL · cobros (el día y la cuenta del banco, si ya está vinculado)
  select cb.empresa_id, coalesce(cm.unidad_id, co.unidad_id), 'COBRO', cb.id, 'COBRO', coalesce(mv.fecha, cb.fecha), cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', coalesce(mv.cuenta_origen_id, cb.cuenta_origen_id),
         null, true, 0
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  left join movimientos_bancarios mv on mv.id = cb.movimiento_id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  where (p_desde is null or coalesce(mv.fecha, cb.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, cb.fecha) <= p_hasta)
  union all
  -- REAL · movimientos del banco sin documento vinculado (impuestos, gastos, FCI, transferencias… y débitos que
  -- todavía no tienen su pago, cheque o cobro: la plata ya se movió).
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación de esas cuentas)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', true, 0
  from conciliacion_calculo(true) cb
  where cb.rendimiento is not null and cb.rendimiento <> 0
    and (p_desde is null or cb.fecha >= p_desde) and (p_hasta is null or cb.fecha <= p_hasta)
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, true, d.descuento
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where not coalesce(p_solo_real, false) and ch.estado in ('EMITIDO', 'ENTREGADO')
), b2 as materialized (
  -- Cada línea con lo que hace falta para buscar su destino, calculado una sola vez.
  select b.*, e.organizacion_id, coalesce(b.unidad_hint, ud.id) as hint,
         texto_banco(b.cuenta_contable) as cuenta_norm,
         case when (select bool_or(x.si_texto_norm is not null) from reglas x)
              then texto_banco(coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) else '' end as texto_norm,
         coalesce(b.proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_prov,
         coalesce(b.cuenta_origen_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_cta,
         coalesce(b.categoria, '') as k_cat,
         -- Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta (0030, punto 8).
         cu.unidad_id as unidad_cuenta
  from base b
  join empresas e on e.id = b.empresa_id
  left join unidades ud on ud.empresa_id = b.empresa_id and ud.por_defecto
  left join cuentas_origen cu on cu.id = b.cuenta_origen_id and b.afecta_bancos and cu.requiere_extracto and b.naturaleza = 'REAL'
  where p_unidad is null or cu.unidad_id is null or cu.unidad_id = p_unidad
), claves as (
  select distinct b.organizacion_id, b.empresa_id, b.hint, b.origen_tipo, b.k_prov, b.cuenta_norm, b.k_cta, b.k_cat, b.texto_norm
  from b2 b
), dest as materialized (
  -- La regla que aplica a cada combinación: la primera por prioridad; lo más específico gana.
  select c.*, r.regla_id, r.r_unidad, r.r_fila, coalesce(r.r_excluir, false) as r_excluir
  from claves c
  left join lateral (
    select x.id as regla_id, x.unidad_id as r_unidad, x.fila_id as r_fila, x.excluir as r_excluir
    from reglas x
    where x.organizacion_id = c.organizacion_id and (x.empresa_id is null or x.empresa_id = c.empresa_id)
      and (x.si_origen is null or x.si_origen = c.origen_tipo)
      and (x.si_proveedor_id is null or x.si_proveedor_id = c.k_prov)
      and (x.si_cuenta_norm is null or x.si_cuenta_norm = c.cuenta_norm)
      and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = c.k_cta)
      and (x.si_categoria is null or x.si_categoria = nullif(c.k_cat, ''))
      and (x.si_texto_norm is null or position(x.si_texto_norm in c.texto_norm) > 0)
      and (x.si_unidad_id is null or x.si_unidad_id = c.hint)
    order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null), x.creada_en, x.id
    limit 1
  ) r on true
), res as (
  -- Unidad y fila de cada línea: la de la regla; si no, la apertura del proveedor o la fila de su cuenta
  -- contable en su unidad; si no, "Sin clasificar".
  select b.empresa_id, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe, b.naturaleza, b.contraparte, b.concepto,
         b.cuenta_origen_id, b.afecta_bancos, b.descuento, b.unidad_cuenta, d.r_excluir,
         coalesce(d.r_unidad, b.hint) as v_unidad,
         coalesce(d.r_fila, ap.id, fc.id, sc.id) as v_fila
  from b2 b
  join dest d on d.organizacion_id = b.organizacion_id and d.empresa_id = b.empresa_id and d.hint is not distinct from b.hint
             and d.origen_tipo = b.origen_tipo and d.k_prov = b.k_prov and d.cuenta_norm = b.cuenta_norm and d.k_cta = b.k_cta
             and d.k_cat = b.k_cat and d.texto_norm = b.texto_norm
  left join proveedores pv on pv.id = b.proveedor_id
  left join fcta fc on fc.unidad_id = coalesce(d.r_unidad, b.hint) and fc.cuenta_norm = b.cuenta_norm
                   and b.cuenta_contable is not null and d.r_fila is null
  left join lateral (
    select f.id from fape f
    where b.proveedor_id is not null and b.cuenta_contable is not null and d.r_fila is null and pv.nombre is not null
      and f.unidad_id = coalesce(d.r_unidad, b.hint) and f.cuenta_norm = b.cuenta_norm
      and position(f.apertura_norm in texto_banco(pv.nombre)) > 0
    order by f.orden, f.id limit 1
  ) ap on true
  left join esp sc on sc.unidad_id = coalesce(d.r_unidad, b.hint) and sc.seccion = 'SIN_CLASIFICAR'
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto
  from proyecciones p
  cross join hoy
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, hoy.h, hoy.h + 180) o
  where not coalesce(p_solo_real, false) and p.estado = 'ACTIVA'
), todas as (
  -- Lo REAL que pasó por una cuenta bancaria queda en la unidad de esa cuenta y no se excluye. Si una regla lo
  -- mandaba a otra unidad o lo excluía (transferencia propia), va a "Entre cuentas propias" (excluida) o a
  -- "Sin clasificar" (otra unidad) de su unidad.
  select r.empresa_id,
         coalesce(r.unidad_cuenta, r.v_unidad) as unidad_id,
         case when r.unidad_cuenta is not null and r.r_excluir then ec.id
              when r.unidad_cuenta is not null and r.v_unidad is distinct from r.unidad_cuenta then su.id
              else r.v_fila end as fila_id,
         r.origen_tipo, r.origen_id, r.ocurrencia, r.fecha, r.importe, r.naturaleza, r.contraparte, r.concepto,
         r.cuenta_origen_id, r.afecta_bancos, r.descuento
  from res r
  left join esp ec on ec.unidad_id = r.unidad_cuenta and ec.seccion = 'ENTRE_CUENTAS'
  left join esp su on su.unidad_id = r.unidad_cuenta and su.seccion = 'SIN_CLASIFICAR'
  where r.unidad_cuenta is not null or not r.r_excluir
  union all
  select empresa_id, unidad_id, fila_id, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true, 0
  from proy
), fin as (
  select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
         t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
         -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
         case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h
              then hoy.habil else coalesce(a.fecha_nueva, t.fecha) end as fecha,
         t.fecha as fecha_calculada,
         case when a.importe_nuevo is null then t.importe
              -- 20. Con un pago sin factura descontado, el ajuste no puede volver a sumarlo: tope = lo que queda.
              when t.origen_tipo = 'FACTURA' and t.descuento > 0 then -least(a.importe_nuevo, -t.importe)
              else sign(t.importe) * a.importe_nuevo end as importe,
         t.contraparte, t.concepto,
         t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h as vencido,
         a.id is not null as ajustada,
         t.naturaleza = 'PROYECTADO' as editable,
         t.cuenta_origen_id,
         t.afecta_bancos
  from todas t
  cross join hoy
  join flujo_filas ff on ff.id = t.fila_id
  left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                           and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
  where not coalesce(a.eliminada, false)
)
select f.* from fin f
where (p_unidad is null or f.unidad_id = p_unidad)
  and (p_desde is null or f.fecha >= p_desde) and (p_hasta is null or f.fecha <= p_hasta)
$$;
revoke execute on function flujo_lineas_entre(date, date, uuid, boolean) from public, anon;
grant execute on function flujo_lineas_entre(date, date, uuid, boolean) to authenticated, service_role;

create view flujo_lineas with (security_invoker = true) as
select * from flujo_lineas_entre(null, null, null, false);

-- Lo que pide la pantalla Flujo: las líneas de una unidad (o de todas, con null) entre dos fechas, en UNA
-- llamada y como un solo valor (así no la corta el tope de filas de la API ni hace falta paginar).
create or replace function flujo_rango(p_unidad uuid, p_desde date, p_hasta date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(l) order by l.fecha, l.origen_tipo, l.origen_id, l.ocurrencia), '[]'::jsonb)
  from flujo_lineas_entre(p_desde, p_hasta, p_unidad, false) l
$$;
revoke execute on function flujo_rango(uuid, date, date) from public, anon;
grant execute on function flujo_rango(uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------- 3. Control: caja del Flujo contra bancos

-- Por unidad y día con saldos completos: el cambio en los saldos de los bancos tiene que ser igual a lo real
-- que pasó entre el día anterior con saldos y este (tolerancia $1; solo lo que mueve un banco). Lo real se suma
-- UNA vez por unidad y día y se acumula; antes se recalculaba todo el Flujo por cada día.
create or replace function flujo_control_entre(p_desde date default null, p_hasta date default null)
returns table (empresa_id text, unidad_id uuid, unidad text, fecha date, fecha_anterior date, saldo_anterior numeric,
               saldo_bancos numeric, real_del_periodo numeric, diferencia numeric, estado text)
language sql stable as $$
with cuentas as (
  select c.unidad_id, count(*) as n from cuentas_origen c where c.activa and c.requiere_extracto group by c.unidad_id
), dias as (
  select co.unidad_id, s.fecha, sum(s.saldo) as saldo_bancos, count(*) as con_saldo
  from saldos_bancarios s join cuentas_origen co on co.id = s.cuenta_origen_id
  where co.activa and co.requiere_extracto
  group by co.unidad_id, s.fecha
), completos as (
  select d.unidad_id, d.fecha, d.saldo_bancos,
         lag(d.fecha) over (partition by d.unidad_id order by d.fecha) as fecha_anterior,
         lag(d.saldo_bancos) over (partition by d.unidad_id order by d.fecha) as saldo_anterior
  from dias d join cuentas c on c.unidad_id = d.unidad_id
  where d.con_saldo = c.n
), k as materialized (
  select * from completos c where (p_desde is null or c.fecha >= p_desde) and (p_hasta is null or c.fecha <= p_hasta)
), lim as materialized (
  -- Lo real que hace falta: desde el día anterior más viejo hasta el último día pedido.
  select coalesce(min(k.fecha_anterior), max(k.fecha)) as desde, max(k.fecha) as hasta from k
), rd as materialized (
  select l.unidad_id, l.fecha, sum(l.importe) as s, count(*) as n
  from flujo_lineas_entre((select desde from lim), (select hasta from lim), null, true) l
  where l.naturaleza = 'REAL' and l.afecta_bancos and exists (select 1 from k)
  group by l.unidad_id, l.fecha
), ejes as (
  select k.unidad_id, k.fecha from k
  union select k.unidad_id, k.fecha_anterior from k where k.fecha_anterior is not null
  union select rd.unidad_id, rd.fecha from rd
), acum as (
  select e.unidad_id, e.fecha,
         sum(coalesce(rd.s, 0)) over w as s, sum(coalesce(rd.n, 0)) over w as n
  from ejes e left join rd on rd.unidad_id = e.unidad_id and rd.fecha = e.fecha
  window w as (partition by e.unidad_id order by e.fecha)
), kr as (
  select k.*, case when a1.n - a0.n > 0 then a1.s - a0.s end as movido
  from k
  left join acum a1 on a1.unidad_id = k.unidad_id and a1.fecha = k.fecha
  left join acum a0 on a0.unidad_id = k.unidad_id and a0.fecha = k.fecha_anterior
)
select u.empresa_id, k.unidad_id, u.nombre, k.fecha, k.fecha_anterior, k.saldo_anterior, k.saldo_bancos,
       k.movido,
       round(k.saldo_bancos - k.saldo_anterior - coalesce(k.movido, 0), 2),
       case when k.saldo_anterior is null then 'PRIMER_SALDO'
            when abs(k.saldo_bancos - k.saldo_anterior - coalesce(k.movido, 0)) <= 1 then 'OK'
            else 'F' end
from kr k
join unidades u on u.id = k.unidad_id
$$;
revoke execute on function flujo_control_entre(date, date) from public, anon;
grant execute on function flujo_control_entre(date, date) to authenticated, service_role;

create view flujo_control with (security_invoker = true) as
select * from flujo_control_entre(null, null);

-- Lo que pide la pantalla: el control desde una fecha, en una llamada.
create or replace function flujo_control_rango(p_desde date, p_hasta date default null)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.unidad_id, c.fecha), '[]'::jsonb) from flujo_control_entre(p_desde, p_hasta) c
$$;
revoke execute on function flujo_control_rango(date, date) from public, anon;
grant execute on function flujo_control_rango(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------- 17. Ajustar una línea: "hoy" de Buenos Aires

create or replace function ajustar_linea_flujo(p_tipo text, p_id uuid, p_ocurrencia text, p_fecha date, p_importe numeric,
                                               p_eliminar boolean, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_empresa text; v_prev flujo_ajustes;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  v_empresa := linea_proyectada_de(p_tipo, p_id);
  if p_tipo = 'FACTURA' and p_ocurrencia not in ('ANTICIPO', 'SALDO') then raise exception 'Ocurrencia de factura inválida'; end if;
  if p_tipo = 'CHEQUE' and p_ocurrencia <> 'CHEQUE' then raise exception 'Ocurrencia de cheque inválida'; end if;
  if p_fecha is not null and p_fecha < hoy_ar() then raise exception 'No se proyecta en el pasado'; end if;

  -- Mover el saldo de una factura = cambiar su fecha de pago programada (la ven también Pagos y Vencimientos).
  if p_tipo = 'FACTURA' and p_ocurrencia = 'SALDO' and p_fecha is not null and not coalesce(p_eliminar, false) then
    update facturas set fecha_pago = p_fecha, actualizado_en = now() where id = p_id;
    if p_importe is null then
      perform registrar_auditoria(u, 'FLUJO_MOVER', 'FACTURA', p_id::text, 'Fecha de pago ' || to_char(p_fecha, 'DD/MM/YYYY') || ' · ' || p_motivo);
      return;
    end if;
    p_fecha := null;
  end if;

  select * into v_prev from flujo_ajustes where origen_tipo = p_tipo and origen_id = p_id and ocurrencia = p_ocurrencia
    and reemplazado_en is null for update;
  if v_prev.id is not null then update flujo_ajustes set reemplazado_en = now() where id = v_prev.id; end if;
  insert into flujo_ajustes (empresa_id, origen_tipo, origen_id, ocurrencia, fecha_nueva, importe_nuevo, eliminada, motivo, creado_por)
  values (v_empresa, p_tipo, p_id, p_ocurrencia,
          coalesce(p_fecha, case when not coalesce(p_eliminar, false) then v_prev.fecha_nueva end),
          coalesce(abs(p_importe), case when not coalesce(p_eliminar, false) then v_prev.importe_nuevo end),
          coalesce(p_eliminar, false), p_motivo, u.email);
  perform registrar_auditoria(u, case when p_eliminar then 'FLUJO_ELIMINAR' else 'FLUJO_AJUSTAR' end, p_tipo, p_id::text,
                              p_ocurrencia || ' · ' || coalesce(p_fecha::text, '') || ' · ' || coalesce(p_importe::text, '') || ' · ' || p_motivo);
end $$;

-- ---------------------------------------------------------------- Control diario de bancos (vista)

-- Igual que 0029, con "hoy" de Buenos Aires, el control del Flujo de los últimos 7 días calculado solo para
-- esos días, el número real del comprobante (0999X) y tres avisos nuevos:
--   RENDIMIENTO_A_REVISAR  un FCI o remunerada "rindió" más del 1 % en un día: falta una suscripción o un rescate
--   FCI_SIN_CONTRAPARTE    suscripción o rescate en una cuenta con más de un fondo: hay que decir cuál (asignar_contraparte)
--   SIN_COMPROBANTE        movimientos facturables de días anteriores que no están en ningún comprobante
create view control_bancos with (security_invoker = true) as
with hoy as materialized (
  select hoy_ar() as h, dia_habil_anterior(hoy_ar()) as anterior
)
select c.empresa_id, 'FALTA_EXTRACTO'::text as control, c.nombre as sujeto, hoy.anterior as fecha,
       case when c.rinde_diario then 'Rinde todos los días: subí el extracto o confirmá sin rendimiento'
            else 'Subí el extracto o marcá "Sin movimientos"' end as detalle, null::numeric as importe, 1 as gravedad
from cuentas_origen c cross join hoy
where c.activa and c.requiere_extracto
  and not exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = c.id and s.fecha = hoy.anterior)
union all
select cb.empresa_id, 'DIFERENCIA', cb.cuenta, cb.fecha, 'Banco ' || cb.saldo_extracto || ' · calculado ' || cb.saldo_calculado, cb.diferencia, 1
from conciliacion_bancaria cb cross join hoy
where cb.estado = 'DIFERENCIA' and cb.fecha >= hoy.h - 7
union all
select cb.empresa_id, 'RENDIMIENTO_A_REVISAR', cb.cuenta, cb.fecha,
       'Rendimiento de ' || cb.rendimiento || ' sobre ' || cb.saldo_anterior || ': ¿falta una suscripción o un rescate?', cb.rendimiento, 1
from conciliacion_bancaria cb cross join hoy
where cb.estado = 'REVISAR' and cb.fecha >= hoy.h - 7
union all
select m.empresa_id, 'A_REVISAR', co.nombre, m.fecha, m.descripcion, m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
where m.estado = 'A_REVISAR'
union all
select m.empresa_id, 'FCI_SIN_CONTRAPARTE', co.nombre, m.fecha, m.descripcion || ' · elegí a qué fondo corresponde', m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
where m.categoria = 'FCI' and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO'
  and (select count(*) from cuentas_origen h where h.cuenta_madre_id = co.id and h.activa and h.clase in ('FCI', 'REMUNERADA')) > 1
union all
select m.empresa_id, 'SIN_COMPROBANTE', co.nombre, m.fecha, m.descripcion || ' · no está en ningún comprobante de gastos', m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id cross join hoy
where m.destino_xubio = 'COMPROBANTE' and m.factura_id is null and m.estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO')
  and m.fecha < hoy.anterior
union all
select f.empresa_id, case when f.estado_xubio = 'ERROR' then 'COMPROBANTE_ERROR' else 'COMPROBANTE_PENDIENTE' end,
       pr.nombre, f.fecha, lpad(f.punto_venta::text, 5, '0') || '-' || f.numero || coalesce(' · ' || f.xubio_error, ''), f.total,
       case when f.estado_xubio = 'ERROR' then 1 else 2 end
from facturas f join proveedores pr on pr.id = f.proveedor_id
where f.cuenta_origen_extracto_id is not null and f.estado not in ('RECHAZADA')
  and (f.estado = 'PENDIENTE_APROBACION' or f.estado_xubio in ('PENDIENTE', 'ERROR'))
union all
select a.empresa_id, case when a.anulacion_xubio in ('PENDIENTE', 'ERROR') then 'ANULAR_EN_XUBIO' else 'ASIENTO_ERROR' end, a.descripcion, a.fecha,
       coalesce(a.xubio_error, a.motivo_anulacion), null, 1
from asientos a where a.estado_xubio = 'ERROR' or a.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
select fc.empresa_id, 'FLUJO_F', fc.unidad, fc.fecha, 'Bancos ' || fc.saldo_bancos || ' · diferencia ' || fc.diferencia, fc.diferencia, 1
from flujo_control_entre(hoy_ar() - 7, null) fc where fc.estado = 'F'
union all
select ch.empresa_id, 'CHEQUE_SIN_MARCAR', ch.beneficiario, ch.fecha_pago, 'Cheque ' || ch.numero || ': ¿se debitó?', ch.importe, 2
from cheques ch cross join hoy where ch.estado in ('EMITIDO', 'ENTREGADO') and ch.fecha_pago < hoy.h
union all
select p.empresa_id, 'ANULAR_EN_XUBIO', coalesce(pr.nombre, 'Pago'), p.fecha,
       'Pago ' || coalesce(p.xubio_id, '') || ' anulado en el sistema: ' ||
       case when p.anulacion_xubio = 'ERROR' then 'anularlo a mano en Xubio y marcarlo' else 'pendiente de anular en Xubio' end, p.importe, 1
from pagos p left join proveedores pr on pr.id = p.proveedor_id where p.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
select ch.empresa_id, 'ANULAR_EN_XUBIO', ch.beneficiario, ch.fecha_pago,
       'Cheque ' || ch.numero || ' anulado en el sistema: anularlo a mano en Xubio y marcarlo', ch.importe, 1
from cheques ch where ch.anulacion_xubio in ('PENDIENTE', 'ERROR');

-- El número del comprobante con su punto de venta real (0999X).
create or replace view xubio_bancos_pendientes with (security_invoker = true) as
with base as (
  select f.empresa_id, 'COMPROBANTE'::text as tipo, f.id, f.fecha,
         lpad(f.punto_venta::text, 5, '0') || '-' || f.numero || ' · ' || coalesce(pr.nombre, 'Banco') as descripcion,
         f.total as importe,
         case when f.estado = 'PENDIENTE_APROBACION' then 'FALTA_APROBAR'
              when f.estado_xubio = 'ERROR' then 'ERROR'
              when f.xubio_envio_en is not null then 'EN_CURSO' else 'PENDIENTE' end as estado,
         f.xubio_error as error, f.xubio_id, false as a_mano, f.cuenta_origen_extracto_id as cuenta_origen_id
  from facturas f left join proveedores pr on pr.id = f.proveedor_id
  where f.cuenta_origen_extracto_id is not null and f.estado_xubio in ('PENDIENTE', 'ERROR') and f.estado not in ('RECHAZADA', 'ERROR')
  union all
  select a.empresa_id, 'ASIENTO', a.id, a.fecha, a.descripcion, (select sum(l.debe) from asiento_lineas l where l.asiento_id = a.id),
         case when a.estado_xubio = 'ERROR' then 'ERROR' when a.envio_xubio_en is not null then 'EN_CURSO' else 'PENDIENTE' end,
         a.xubio_error, a.xubio_id, false, a.cuenta_origen_id
  from asientos a
  where a.anulado_en is null and a.estado_xubio in ('PENDIENTE', 'ERROR')
  union all
  select a.empresa_id, 'ANULAR_ASIENTO', a.id, a.fecha, a.descripcion || ' · ' || coalesce(a.motivo_anulacion, ''), null,
         a.anulacion_xubio, null, a.xubio_id, not coalesce(a.xubio_id ~ '^(OP-)?[0-9]+$', false), a.cuenta_origen_id
  from asientos a where a.anulacion_xubio in ('PENDIENTE', 'ERROR')
  union all
  select p.empresa_id, 'ANULAR_PAGO', p.id, p.fecha, coalesce(pr.nombre, 'Pago') || ' · ' || p.forma_carga_xubio::text || ' · ' || coalesce(p.motivo_anulacion, ''),
         p.importe, p.anulacion_xubio, null, p.xubio_id,
         not (p.forma_carga_xubio in ('SALIDA_FONDOS', 'ASIENTO_MANUAL') and coalesce(p.xubio_id ~ '^(OP-)?[0-9]+$', false)), p.cuenta_origen_id
  from pagos p left join proveedores pr on pr.id = p.proveedor_id
  where p.anulacion_xubio in ('PENDIENTE', 'ERROR')
  union all
  select ch.empresa_id, 'ANULAR_CHEQUE', ch.id, ch.fecha_pago, 'Cheque ' || ch.numero || ' · ' || ch.beneficiario || ' · ' || coalesce(ch.motivo_anulacion, ''),
         ch.importe, ch.anulacion_xubio, null, ch.xubio_emision_id, true, ch.cuenta_origen_id
  from cheques ch where ch.anulacion_xubio in ('PENDIENTE', 'ERROR')
)
select b.*, l.creado_en as ultimo_intento_en, l.estado as ultimo_intento_estado, l.modo as ultimo_intento_modo, l.detalle as ultimo_intento_detalle
from base b
left join lateral (
  select pl.creado_en, pl.estado, pl.modo, pl.detalle from procesos_log pl
  where pl.entidad_id = b.id::text and pl.proceso in ('XUBIO_ASIENTOS', 'XUBIO_ANULACIONES')
  order by pl.creado_en desc, pl.id desc limit 1
) l on true;

-- ---------------------------------------------------------------- Seguridad (las vistas se volvieron a crear)

revoke all on conciliacion_bancaria, flujo_lineas, flujo_control, control_bancos, xubio_bancos_pendientes from public, anon, authenticated;
grant select on conciliacion_bancaria, flujo_lineas, flujo_control, control_bancos, xubio_bancos_pendientes to authenticated;
grant all on conciliacion_bancaria, flujo_lineas, flujo_control, control_bancos, xubio_bancos_pendientes to service_role;


-- ======================================== 0032_conciliacion_lotes.sql
-- T-209 · Conciliación en lote y pagos sin débito clasificados (después del simulacro del paralelo de noviembre).
--
-- No cambia migraciones anteriores: redefine lo que hace falta.
--
--   1. Débitos en lote. Un débito del banco puede pagar varios pagos de la hoja (prestadores, sueldos) y un pago
--      puede salir en varios débitos. 0030 vinculaba solo 1 a 1. Ahora, después del 1 a 1:
--        · 1 débito ↔ N pagos (movimientos_pagos): misma empresa, misma cuenta (si el pago la sabe), fecha del banco
--          en la ventana de 0030 (2 días antes a 5 después de la fecha del pago), suma EXACTA al centavo, de 2 a 12
--          pagos. Se busca primero entre los pagos del mismo día que el débito y, si no hay, en toda la ventana.
--        · N débitos ↔ 1 pago (movimientos_bancarios.pago_id en cada débito): débitos del mismo día y cuenta.
--        · Un pago con un débito propio por su importe exacto (aunque mal fechado) no entra en un lote, ni un débito
--          con un pago propio por su importe exacto se usa para armar otro pago: evita lotes por coincidencia.
--        · Si hay más de una combinación distinta (distinto conjunto de importes) o más de 14 candidatos, NO se
--          vincula: queda en conciliacion_revisar para que lo decida una persona.
--        · Importes iguales son intercambiables: entre dos pagos de $100 se toma el de fecha más vieja y, a igual
--          fecha, el de id menor. El mismo desempate fijo (fecha, luego id) reemplaza al de 0030 en el 1 a 1, que
--          entre dos movimientos iguales del mismo día dependía del orden físico de la tabla.
--   2. pagos_sin_debito dice por qué: POSIBLE_DUPLICADO (otro pago igual: proveedor, importe, ±5 días),
--      CUENTA_O_FECHA (hay un débito igual sin vincular en otra cuenta de la empresa o fuera de la ventana, hasta
--      45 días) o SIN_EXPLICACION.
--   3. El Flujo (flujo_lineas_entre de 0031) toma los vínculos en lote: el débito no entra y cada pago del lote
--      cuenta el día del débito, en la unidad de esa cuenta.

-- ---------------------------------------------------------------- Vínculos en lote

create table movimientos_pagos (
  movimiento_id  uuid not null references movimientos_bancarios on delete cascade,
  pago_id        uuid not null references pagos on delete cascade,
  importe        numeric(16,2) not null check (importe > 0),
  vinculado_en   timestamptz not null default now(),
  primary key (movimiento_id, pago_id),
  unique (pago_id)                       -- un pago va en un solo lote
);
create index on movimientos_pagos (movimiento_id);

-- Lo que no se vinculó porque había más de una forma (o demasiados candidatos): lo decide una persona.
create table conciliacion_revisar (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     text not null references empresas,
  tipo           text not null check (tipo in ('DEBITO_LOTE', 'PAGO_EN_VARIOS_DEBITOS')),
  movimiento_id  uuid references movimientos_bancarios on delete cascade,
  pago_id        uuid references pagos on delete cascade,
  motivo         text not null check (motivo in ('VARIAS_COMBINACIONES', 'DEMASIADOS_CANDIDATOS')),
  combinaciones  integer,
  candidatos     integer not null,
  importe        numeric(16,2) not null,
  detectado_en   timestamptz not null default now(),
  check ((tipo = 'DEBITO_LOTE') = (movimiento_id is not null))
);
create unique index conciliacion_revisar_mov on conciliacion_revisar (movimiento_id) where movimiento_id is not null;
create unique index conciliacion_revisar_pago on conciliacion_revisar (pago_id) where pago_id is not null and movimiento_id is null;

-- ¿Un movimiento o un pago ya tiene documento o débito?
create or replace function movimiento_vinculado(p_mov uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from movimientos_bancarios m where m.id = p_mov
                   and (m.pago_id is not null or m.cheque_id is not null or m.cobro_id is not null))
      or exists (select 1 from movimientos_pagos x where x.movimiento_id = p_mov)
$$;
create or replace function pago_vinculado(p_pago uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from movimientos_bancarios m where m.pago_id = p_pago)
      or exists (select 1 from movimientos_pagos x where x.pago_id = p_pago)
$$;

-- Subconjunto de p_imp (centavos, en el orden de desempate) que suma p_objetivo, de p_min a p_max elementos.
-- Devuelve {estado: UNICO | AMBIGUO | NINGUNO | DEMASIADOS, indices: [1-based], combinaciones}. Dos soluciones con
-- los mismos importes son la misma (los iguales son intercambiables): se toman los primeros índices de cada importe.
create or replace function subconjunto_unico(p_imp bigint[], p_objetivo bigint, p_min integer default 2, p_max integer default 12,
                                             p_tope integer default 14)
returns jsonb language plpgsql immutable as $$
declare
  n int := coalesce(array_length(p_imp, 1), 0); mask int; i int; s bigint; k int;
  firma text; primera text := null; distintas int := 0; elegido bigint[]; usados int[] := '{}'; idx int[] := '{}'; v bigint;
begin
  if n < p_min then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  if n > p_tope then return jsonb_build_object('estado', 'DEMASIADOS', 'combinaciones', null); end if;
  if (select sum(x) from unnest(p_imp) x) < p_objetivo then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  for mask in 1 .. (1 << n) - 1 loop
    s := 0; k := 0;
    for i in 1 .. n loop
      if (mask >> (i - 1)) & 1 = 1 then s := s + p_imp[i]; k := k + 1; exit when s > p_objetivo; end if;
    end loop;
    continue when s <> p_objetivo or k < p_min or k > p_max;
    select string_agg(x::text, ',' order by x) into firma
    from unnest(p_imp) with ordinality u(x, o) where (mask >> (o::int - 1)) & 1 = 1;
    if primera is null then primera := firma; distintas := 1;
    elsif firma <> primera and distintas = 1 then distintas := 2;   -- con dos alcanza: ya es ambiguo
    end if;
  end loop;
  if primera is null then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  if distintas > 1 then return jsonb_build_object('estado', 'AMBIGUO', 'combinaciones', distintas); end if;
  -- Los primeros índices (orden de desempate) de cada importe de la firma.
  elegido := string_to_array(primera, ',')::bigint[];
  foreach v in array elegido loop
    select min(o::int) into i from unnest(p_imp) with ordinality u(x, o) where x = v and not (o::int = any(usados));
    usados := usados || i; idx := idx || i;
  end loop;
  return jsonb_build_object('estado', 'UNICO', 'indices', to_jsonb((select array_agg(x order by x) from unnest(idx) x)), 'combinaciones', 1);
end $$;

-- Lotes de una empresa: 1 débito ↔ N pagos y N débitos ↔ 1 pago. Devuelve cuántos vinculó y cuántos dejó para revisar.
create or replace function conciliar_lotes(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m record; p record; cand record; ids uuid[]; imps bigint[]; res jsonb; etapa int; j int;
  n_lotes int := 0; n_pagos_lote int := 0; n_multi int := 0; n_rev int := 0; total_cand int;
begin
  delete from conciliacion_revisar where empresa_id = p_empresa;

  -- N débitos ↔ 1 pago (débitos del mismo día y cuenta). Va primero: un pago partido es más específico que un lote.
  for p in
    select q.id, q.cuenta_origen_id, q.fecha, (q.importe * 100)::bigint as objetivo, q.importe
    from pagos q
    where q.empresa_id = p_empresa and q.estado <> 'ANULADO' and q.importe > 0
      and q.medio not in ('CHEQUE', 'ECHEQ') and (q.medio <> 'CAJA' or q.cuenta_origen_id is not null)
      and not exists (select 1 from cheques_pagos cp where cp.pago_id = q.id)
      and not pago_vinculado(q.id)
    order by q.fecha, q.id
  loop
    for cand in
      select x.cuenta_origen_id, x.fecha
      from movimientos_bancarios x
      where x.empresa_id = p_empresa and x.importe < 0 and x.estado <> 'IGNORADO' and -x.importe < p.importe
        and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA')
        and (p.cuenta_origen_id is null or x.cuenta_origen_id = p.cuenta_origen_id)
        and x.fecha between p.fecha - 2 and p.fecha + 5 and not movimiento_vinculado(x.id)
      group by x.cuenta_origen_id, x.fecha
      having count(*) >= 2 and sum(-x.importe) >= p.importe
      order by abs(x.fecha - p.fecha), x.fecha, x.cuenta_origen_id
    loop
      select array_agg(x.id order by x.fecha, x.id), array_agg((-x.importe * 100)::bigint order by x.fecha, x.id), count(*)
        into ids, imps, total_cand
      from movimientos_bancarios x
      where x.empresa_id = p_empresa and x.cuenta_origen_id = cand.cuenta_origen_id and x.fecha = cand.fecha
        and x.importe < 0 and x.estado <> 'IGNORADO' and -x.importe < p.importe
        and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA') and not movimiento_vinculado(x.id)
        -- Un débito que tiene un pago propio por su importe exacto no se usa para armar otro pago.
        and not exists (select 1 from pagos o where o.empresa_id = p_empresa and o.importe = -x.importe and o.id <> p.id
                          and o.estado <> 'ANULADO' and abs(o.fecha - x.fecha) <= 45 and not pago_vinculado(o.id));
      res := subconjunto_unico(imps, p.objetivo);
      if res->>'estado' = 'UNICO' then
        for j in select (e)::int from jsonb_array_elements_text(res->'indices') e loop
          update movimientos_bancarios set pago_id = p.id where id = ids[j];
        end loop;
        n_multi := n_multi + 1;
        exit;
      elsif res->>'estado' = 'AMBIGUO' then
        insert into conciliacion_revisar (empresa_id, tipo, pago_id, motivo, combinaciones, candidatos, importe)
        values (p_empresa, 'PAGO_EN_VARIOS_DEBITOS', p.id, 'VARIAS_COMBINACIONES', 2, total_cand, p.importe)
        on conflict do nothing;
        n_rev := n_rev + 1;
        exit;
      end if;
    end loop;
  end loop;
  -- 1 débito ↔ N pagos.
  for m in
    select x.id, x.cuenta_origen_id, x.fecha, (-x.importe * 100)::bigint as objetivo, -x.importe as importe
    from movimientos_bancarios x
    where x.empresa_id = p_empresa and x.importe < 0 and x.estado <> 'IGNORADO'
      and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA')
      and not movimiento_vinculado(x.id)
    order by x.fecha, x.id
  loop
    for etapa in 1 .. 2 loop
      select array_agg(q.id order by q.fecha, q.id), array_agg((q.importe * 100)::bigint order by q.fecha, q.id), count(*)
        into ids, imps, total_cand
      from pagos q
      where q.empresa_id = p_empresa and q.estado <> 'ANULADO' and q.importe > 0 and q.importe < m.importe
        and q.medio not in ('CHEQUE', 'ECHEQ') and (q.medio <> 'CAJA' or q.cuenta_origen_id is not null)
        and (q.cuenta_origen_id is null or q.cuenta_origen_id = m.cuenta_origen_id)
        and m.fecha between q.fecha - 2 and q.fecha + 5
        and (etapa = 2 or q.fecha = m.fecha)
        and not exists (select 1 from cheques_pagos cp where cp.pago_id = q.id)
        and not pago_vinculado(q.id)
        -- Un pago que tiene un débito propio por su importe exacto (aunque esté fuera de la ventana o en otra
        -- cuenta) no entra en un lote: es un pago mal fechado, no parte de un débito en lote.
        and not exists (select 1 from movimientos_bancarios o where o.empresa_id = p_empresa and o.importe = -q.importe
                          and o.estado <> 'IGNORADO' and abs(o.fecha - q.fecha) <= 45 and not movimiento_vinculado(o.id));
      res := subconjunto_unico(imps, m.objetivo);
      if res->>'estado' = 'UNICO' then
        for j in select (e)::int from jsonb_array_elements_text(res->'indices') e loop
          insert into movimientos_pagos (movimiento_id, pago_id, importe)
          select m.id, ids[j], q.importe from pagos q where q.id = ids[j];
          n_pagos_lote := n_pagos_lote + 1;
        end loop;
        n_lotes := n_lotes + 1;
        exit;
      elsif res->>'estado' in ('AMBIGUO', 'DEMASIADOS') then
        insert into conciliacion_revisar (empresa_id, tipo, movimiento_id, motivo, combinaciones, candidatos, importe)
        values (p_empresa, 'DEBITO_LOTE', m.id, case res->>'estado' when 'AMBIGUO' then 'VARIAS_COMBINACIONES' else 'DEMASIADOS_CANDIDATOS' end,
                (res->>'combinaciones')::int, total_cand, m.importe)
        on conflict do nothing;
        n_rev := n_rev + 1;
        exit;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('lotes', n_lotes, 'pagos_en_lotes', n_pagos_lote, 'pagos_en_varios_debitos', n_multi, 'revisar', n_rev);
end $$;

-- ---------------------------------------------------------------- Conciliación (1 a 1 de 0030 + lotes, desempate fijo)

create or replace function conciliar_movimientos(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n_pag int := 0; n_che int := 0; n_cob int := 0; n_fci int := 0;
begin
  -- FCI / remunerada: la contraparte es el único fondo de la cuenta madre (si el fondo no trae ya su propia pata).
  update movimientos_bancarios m set contraparte_cuenta_id = h.id
  from cuentas_origen h
  where m.empresa_id = p_empresa and m.categoria in ('FCI', 'TRANSFERENCIA_PROPIA') and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO'
    and h.cuenta_madre_id = m.cuenta_origen_id and h.activa and h.clase in ('FCI', 'REMUNERADA')
    and (select count(*) from cuentas_origen h2 where h2.cuenta_madre_id = m.cuenta_origen_id and h2.activa and h2.clase in ('FCI', 'REMUNERADA')) = 1
    and not exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = h.id and o.fecha = m.fecha and o.importe = -m.importe);
  get diagnostics n_fci = row_count;

  -- Cheques debitados.
  for r in
    select m.id as mid, ch.id as cid
    from movimientos_bancarios m
    join cheques ch on ch.cuenta_origen_id = m.cuenta_origen_id and ch.importe = -m.importe and ch.estado = 'DEBITADO'
                   and ch.movimiento_id is null and m.fecha between ch.debitado_en - 3 and ch.debitado_en + 3
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by (m.numero_cheque is not null and right(regexp_replace(m.numero_cheque, '\D', '', 'g'), 4) = right(regexp_replace(ch.numero, '\D', '', 'g'), 4)) desc,
             abs(m.fecha - ch.debitado_en), m.fecha, m.id, ch.debitado_en, ch.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cheque_id is null)
       and exists (select 1 from cheques where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cheque_id = r.cid where id = r.mid;
      update cheques set movimiento_id = r.mid where id = r.cid;
      n_che := n_che + 1;
    end if;
  end loop;

  -- Pagos (no cheques ni efectivo: el cheque cuenta cuando se debita; el efectivo no pasa por el banco).
  for r in
    select m.id as mid, p.id as pid
    from movimientos_bancarios m
    join pagos p on p.empresa_id = m.empresa_id and p.importe = -m.importe and p.estado <> 'ANULADO'
                and p.medio not in ('CHEQUE', 'ECHEQ')
                and (p.medio <> 'CAJA' or p.cuenta_origen_id is not null)   -- "Caja" con cuenta de banco: salió por el banco
                and (p.cuenta_origen_id is null or p.cuenta_origen_id = m.cuenta_origen_id)
                and m.fecha between p.fecha - 2 and p.fecha + 5
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not pago_vinculado(p.id)
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by abs(m.fecha - p.fecha), (p.cuenta_origen_id is not null) desc, m.fecha, m.id, p.fecha, p.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and pago_id is null and cheque_id is null)
       and not pago_vinculado(r.pid) then
      update movimientos_bancarios set pago_id = r.pid where id = r.mid;
      n_pag := n_pag + 1;
    end if;
  end loop;

  -- Cobros.
  for r in
    select m.id as mid, c.id as cid
    from movimientos_bancarios m
    join cobros c on c.empresa_id = m.empresa_id and c.importe = m.importe and c.movimiento_id is null
                 and (c.cuenta_origen_id is null or c.cuenta_origen_id = m.cuenta_origen_id)
                 and m.fecha between c.fecha - 3 and c.fecha + 3
    where m.empresa_id = p_empresa and m.importe > 0 and m.estado <> 'IGNORADO'
      and m.cobro_id is null and m.pago_id is null and m.cheque_id is null
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by abs(m.fecha - c.fecha), m.fecha, m.id, c.fecha, c.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cobro_id is null)
       and exists (select 1 from cobros where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cobro_id = r.cid where id = r.mid;
      update cobros set movimiento_id = r.mid where id = r.cid;
      n_cob := n_cob + 1;
    end if;
  end loop;
  -- Después del 1 a 1: lotes (1 débito ↔ N pagos, N débitos ↔ 1 pago).
  return jsonb_build_object('pagos', n_pag, 'cheques', n_che, 'cobros', n_cob, 'fci', n_fci) || conciliar_lotes(p_empresa);
end $$;

-- Un pago anulado suelta su débito (1 a 1 o en lote): el débito vuelve a contar solo hasta que se vincule otro documento.
create or replace function soltar_movimiento_de_anulado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'ANULADO' and old.estado is distinct from 'ANULADO' then
    update movimientos_bancarios set pago_id = null where pago_id = new.id;
    delete from movimientos_pagos where movimiento_id in (select movimiento_id from movimientos_pagos where pago_id = new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- Pagos sin débito, con su motivo

-- Mismas columnas que 0030 y dos al final: motivo y el débito parecido (para revisar).
create or replace view pagos_sin_debito with (security_invoker = true) as
with base as (
  select p.id, p.empresa_id, p.fecha, p.importe, p.proveedor_destino, p.estado, p.cuenta_origen_id, co.nombre as cuenta,
         p.sheets_fila_origen, p.hoja_id,
         exists (select 1 from pagos d where d.id <> p.id and d.empresa_id = p.empresa_id and d.importe = p.importe
                   and d.estado <> 'ANULADO' and abs(d.fecha - p.fecha) <= 5
                   and texto_comparable(coalesce(d.proveedor_destino, '')) = texto_comparable(coalesce(p.proveedor_destino, ''))) as posible_duplicado
  from pagos p join cuentas_origen co on co.id = p.cuenta_origen_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ') and co.requiere_extracto
    and not pago_vinculado(p.id)
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    and extracto_cubre(co.id, p.fecha + 5)
)
select b.*,
       case when b.posible_duplicado then 'POSIBLE_DUPLICADO'
            when d.id is not null then 'CUENTA_O_FECHA'
            else 'SIN_EXPLICACION' end as motivo,
       d.id as debito_parecido_id
from base b
left join lateral (
  -- Un débito igual sin vincular en otra cuenta de la empresa, o en la misma fuera de la ventana (hasta 45 días).
  select m.id from movimientos_bancarios m
  where m.empresa_id = b.empresa_id and m.importe = -b.importe and m.estado <> 'IGNORADO'
    and abs(m.fecha - b.fecha) <= 45 and not movimiento_vinculado(m.id)
    and (m.cuenta_origen_id <> b.cuenta_origen_id or m.fecha not between b.fecha - 2 and b.fecha + 5)
  order by abs(m.fecha - b.fecha), m.fecha, m.id limit 1
) d on true;

-- ---------------------------------------------------------------- El Flujo toma los lotes

create or replace function flujo_lineas_entre(p_desde date default null, p_hasta date default null, p_unidad uuid default null,
                                              p_solo_real boolean default false)
returns table (empresa_id text, unidad_id uuid, fila_id uuid, fila text, seccion text, mueve_caja boolean,
               origen_tipo text, origen_id uuid, ocurrencia text, naturaleza text, fecha date, fecha_calculada date,
               importe numeric, contraparte text, concepto text, vencido boolean, ajustada boolean, editable boolean,
               cuenta_origen_id uuid, afecta_bancos boolean)
language sql stable as $$
with hoy as materialized (
  select hoy_ar() as h, dia_habil_desde(hoy_ar()) as habil
), reglas as materialized (
  select x.id, x.organizacion_id, x.empresa_id, x.prioridad, x.si_origen, x.si_proveedor_id, x.si_cuenta_norm, x.si_cuenta_origen_id,
         x.si_categoria, x.si_texto_norm, x.si_unidad_id, x.unidad_id, x.fila_id, x.excluir, x.creada_en
  from flujo_reglas x
), esp as materialized (
  -- Filas internas de cada unidad ("Sin clasificar", "Entre cuentas propias"): lo que devolvía fila_especial.
  select distinct on (f.unidad_id, f.seccion) f.unidad_id, f.seccion, f.id
  from flujo_filas f where f.tipo = 'INTERNO' and f.seccion in ('SIN_CLASIFICAR', 'ENTRE_CUENTAS')
  order by f.unidad_id, f.seccion, f.orden, f.id
), fcta as materialized (
  select distinct on (f.unidad_id, f.cuenta_norm) f.unidad_id, f.cuenta_norm, f.id
  from flujo_filas f where f.activa and f.tipo = 'CUENTA'
  order by f.unidad_id, f.cuenta_norm, f.orden, f.id
), fape as materialized (
  select f.unidad_id, f.cuenta_norm, f.apertura_norm, f.id, f.orden from flujo_filas f where f.activa and f.tipo = 'APERTURA'
), cob as materialized (
  -- Hasta dónde llegó el extracto de cada cuenta (extracto_cubre de 0030, por conjuntos): hay evidencia del
  -- banco (un movimiento o un saldo que no se cargó a mano) ese día o antes Y ese día o después.
  select c.id as cuenta_id,
         least((select min(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
               (select min(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as desde,
         greatest((select max(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
                  (select max(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as hasta
  from cuentas_origen c where c.requiere_extracto
), mvp as (
  -- El débito del banco vinculado a cada pago (el primero).
  -- (0032) también los pagos de un débito en lote.
  select distinct on (v.pago_id) v.pago_id, v.fecha, v.cuenta_origen_id
  from (select m.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_bancarios m where m.pago_id is not null
        union all
        select x.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_pagos x join movimientos_bancarios m on m.id = x.movimiento_id) v
  order by v.pago_id, v.fecha, v.id
), fac as (
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join hoy
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', case when q.anticipo_pend > 0 then dia_habil_desde(greatest(f.fecha, hoy.h + 1)) end, q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where not coalesce(p_solo_real, false)
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), fac_desc as (
  -- ESPERA_FC (0028): lo pagado sin factura se descuenta de la más vieja a la más nueva.
  select x.*,
         least(x.importe, greatest(coalesce(a.importe, 0) - coalesce(x.acumulado_antes, 0), 0)) as descuento
  from (
    select fac.*,
           sum(fac.importe) over (partition by fac.empresa_id, fac.proveedor_id
                                  order by fac.fecha, fac.fecha_factura, fac.factura_id, fac.ocurrencia
                                  rows between unbounded preceding and 1 preceding) as acumulado_antes
    from fac
  ) x
  left join anticipos_sin_factura a on a.empresa_id = x.empresa_id and a.proveedor_id = x.proveedor_id
), base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque). Si el banco ya lo debitó (movimiento
  -- vinculado), cuenta ese día y en la unidad de esa cuenta.
  select p.empresa_id, coalesce(co.unidad_id, cm.unidad_id) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, coalesce(mv.fecha, p.fecha) as fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, coalesce(p.cuenta_origen_id, mv.cuenta_origen_id) as cuenta_origen_id, null::text as categoria,
         (mv.fecha is not null or p.medio::text <> 'CAJA') as afecta_bancos, 0::numeric as descuento
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join mvp mv on mv.pago_id = p.id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  left join cob on cob.cuenta_id = co.id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    -- Un pago de una cuenta con extracto es real cuando el banco lo debita. Si el extracto de esa cuenta para ese
    -- día está y el débito no aparece, el pago no salió: no entra y queda en pagos_sin_debito.
    and (mv.fecha is not null or co.id is null or not co.requiere_extracto or p.medio = 'CAJA'
         or not coalesce(cob.desde <= p.fecha and cob.hasta >= p.fecha, false))
    and (p_desde is null or coalesce(mv.fecha, p.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, p.fecha) <= p_hasta)
  union all
  -- REAL · cheques debitados (la categoría del acreedor elige la fila de cheques)
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
    and (p_desde is null or ch.debitado_en >= p_desde) and (p_hasta is null or ch.debitado_en <= p_hasta)
  union all
  -- REAL · cobros (el día y la cuenta del banco, si ya está vinculado)
  select cb.empresa_id, coalesce(cm.unidad_id, co.unidad_id), 'COBRO', cb.id, 'COBRO', coalesce(mv.fecha, cb.fecha), cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', coalesce(mv.cuenta_origen_id, cb.cuenta_origen_id),
         null, true, 0
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  left join movimientos_bancarios mv on mv.id = cb.movimiento_id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  where (p_desde is null or coalesce(mv.fecha, cb.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, cb.fecha) <= p_hasta)
  union all
  -- REAL · movimientos del banco sin documento vinculado (impuestos, gastos, FCI, transferencias… y débitos que
  -- todavía no tienen su pago, cheque o cobro: la plata ya se movió).
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación de esas cuentas)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', true, 0
  from conciliacion_calculo(true) cb
  where cb.rendimiento is not null and cb.rendimiento <> 0
    and (p_desde is null or cb.fecha >= p_desde) and (p_hasta is null or cb.fecha <= p_hasta)
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, true, d.descuento
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where not coalesce(p_solo_real, false) and ch.estado in ('EMITIDO', 'ENTREGADO')
), b2 as materialized (
  -- Cada línea con lo que hace falta para buscar su destino, calculado una sola vez.
  select b.*, e.organizacion_id, coalesce(b.unidad_hint, ud.id) as hint,
         texto_banco(b.cuenta_contable) as cuenta_norm,
         case when (select bool_or(x.si_texto_norm is not null) from reglas x)
              then texto_banco(coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) else '' end as texto_norm,
         coalesce(b.proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_prov,
         coalesce(b.cuenta_origen_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_cta,
         coalesce(b.categoria, '') as k_cat,
         -- Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta (0030, punto 8).
         cu.unidad_id as unidad_cuenta
  from base b
  join empresas e on e.id = b.empresa_id
  left join unidades ud on ud.empresa_id = b.empresa_id and ud.por_defecto
  left join cuentas_origen cu on cu.id = b.cuenta_origen_id and b.afecta_bancos and cu.requiere_extracto and b.naturaleza = 'REAL'
  where p_unidad is null or cu.unidad_id is null or cu.unidad_id = p_unidad
), claves as (
  select distinct b.organizacion_id, b.empresa_id, b.hint, b.origen_tipo, b.k_prov, b.cuenta_norm, b.k_cta, b.k_cat, b.texto_norm
  from b2 b
), dest as materialized (
  -- La regla que aplica a cada combinación: la primera por prioridad; lo más específico gana.
  select c.*, r.regla_id, r.r_unidad, r.r_fila, coalesce(r.r_excluir, false) as r_excluir
  from claves c
  left join lateral (
    select x.id as regla_id, x.unidad_id as r_unidad, x.fila_id as r_fila, x.excluir as r_excluir
    from reglas x
    where x.organizacion_id = c.organizacion_id and (x.empresa_id is null or x.empresa_id = c.empresa_id)
      and (x.si_origen is null or x.si_origen = c.origen_tipo)
      and (x.si_proveedor_id is null or x.si_proveedor_id = c.k_prov)
      and (x.si_cuenta_norm is null or x.si_cuenta_norm = c.cuenta_norm)
      and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = c.k_cta)
      and (x.si_categoria is null or x.si_categoria = nullif(c.k_cat, ''))
      and (x.si_texto_norm is null or position(x.si_texto_norm in c.texto_norm) > 0)
      and (x.si_unidad_id is null or x.si_unidad_id = c.hint)
    order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null), x.creada_en, x.id
    limit 1
  ) r on true
), res as (
  -- Unidad y fila de cada línea: la de la regla; si no, la apertura del proveedor o la fila de su cuenta
  -- contable en su unidad; si no, "Sin clasificar".
  select b.empresa_id, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe, b.naturaleza, b.contraparte, b.concepto,
         b.cuenta_origen_id, b.afecta_bancos, b.descuento, b.unidad_cuenta, d.r_excluir,
         coalesce(d.r_unidad, b.hint) as v_unidad,
         coalesce(d.r_fila, ap.id, fc.id, sc.id) as v_fila
  from b2 b
  join dest d on d.organizacion_id = b.organizacion_id and d.empresa_id = b.empresa_id and d.hint is not distinct from b.hint
             and d.origen_tipo = b.origen_tipo and d.k_prov = b.k_prov and d.cuenta_norm = b.cuenta_norm and d.k_cta = b.k_cta
             and d.k_cat = b.k_cat and d.texto_norm = b.texto_norm
  left join proveedores pv on pv.id = b.proveedor_id
  left join fcta fc on fc.unidad_id = coalesce(d.r_unidad, b.hint) and fc.cuenta_norm = b.cuenta_norm
                   and b.cuenta_contable is not null and d.r_fila is null
  left join lateral (
    select f.id from fape f
    where b.proveedor_id is not null and b.cuenta_contable is not null and d.r_fila is null and pv.nombre is not null
      and f.unidad_id = coalesce(d.r_unidad, b.hint) and f.cuenta_norm = b.cuenta_norm
      and position(f.apertura_norm in texto_banco(pv.nombre)) > 0
    order by f.orden, f.id limit 1
  ) ap on true
  left join esp sc on sc.unidad_id = coalesce(d.r_unidad, b.hint) and sc.seccion = 'SIN_CLASIFICAR'
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto
  from proyecciones p
  cross join hoy
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, hoy.h, hoy.h + 180) o
  where not coalesce(p_solo_real, false) and p.estado = 'ACTIVA'
), todas as (
  -- Lo REAL que pasó por una cuenta bancaria queda en la unidad de esa cuenta y no se excluye. Si una regla lo
  -- mandaba a otra unidad o lo excluía (transferencia propia), va a "Entre cuentas propias" (excluida) o a
  -- "Sin clasificar" (otra unidad) de su unidad.
  select r.empresa_id,
         coalesce(r.unidad_cuenta, r.v_unidad) as unidad_id,
         case when r.unidad_cuenta is not null and r.r_excluir then ec.id
              when r.unidad_cuenta is not null and r.v_unidad is distinct from r.unidad_cuenta then su.id
              else r.v_fila end as fila_id,
         r.origen_tipo, r.origen_id, r.ocurrencia, r.fecha, r.importe, r.naturaleza, r.contraparte, r.concepto,
         r.cuenta_origen_id, r.afecta_bancos, r.descuento
  from res r
  left join esp ec on ec.unidad_id = r.unidad_cuenta and ec.seccion = 'ENTRE_CUENTAS'
  left join esp su on su.unidad_id = r.unidad_cuenta and su.seccion = 'SIN_CLASIFICAR'
  where r.unidad_cuenta is not null or not r.r_excluir
  union all
  select empresa_id, unidad_id, fila_id, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true, 0
  from proy
), fin as (
  select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
         t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
         -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
         case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h
              then hoy.habil else coalesce(a.fecha_nueva, t.fecha) end as fecha,
         t.fecha as fecha_calculada,
         case when a.importe_nuevo is null then t.importe
              -- 20. Con un pago sin factura descontado, el ajuste no puede volver a sumarlo: tope = lo que queda.
              when t.origen_tipo = 'FACTURA' and t.descuento > 0 then -least(a.importe_nuevo, -t.importe)
              else sign(t.importe) * a.importe_nuevo end as importe,
         t.contraparte, t.concepto,
         t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h as vencido,
         a.id is not null as ajustada,
         t.naturaleza = 'PROYECTADO' as editable,
         t.cuenta_origen_id,
         t.afecta_bancos
  from todas t
  cross join hoy
  join flujo_filas ff on ff.id = t.fila_id
  left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                           and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
  where not coalesce(a.eliminada, false)
)
select f.* from fin f
where (p_unidad is null or f.unidad_id = p_unidad)
  and (p_desde is null or f.fecha >= p_desde) and (p_hasta is null or f.fecha <= p_hasta)
$$;

-- ---------------------------------------------------------------- Lo que ya estaba cargado: conciliar una vez

select conciliar_movimientos(id) from empresas;

-- ---------------------------------------------------------------- Seguridad

alter table movimientos_pagos enable row level security;
alter table conciliacion_revisar enable row level security;
create policy leer_movimientos_pagos on movimientos_pagos for select to authenticated
  using (exists (select 1 from movimientos_bancarios m where m.id = movimiento_id));
create policy leer_conciliacion_revisar on conciliacion_revisar for select to authenticated
  using (empresa_id in (select empresas_visibles()));
revoke all on movimientos_pagos, conciliacion_revisar, pagos_sin_debito from public, anon, authenticated;
grant select on movimientos_pagos, conciliacion_revisar, pagos_sin_debito to authenticated;
grant all on movimientos_pagos, conciliacion_revisar, pagos_sin_debito to service_role;
revoke execute on function conciliar_lotes(text), conciliar_movimientos(text), soltar_movimiento_de_anulado() from public, anon, authenticated;
grant execute on function conciliar_lotes(text), conciliar_movimientos(text) to service_role;
revoke execute on function movimiento_vinculado(uuid), pago_vinculado(uuid), subconjunto_unico(bigint[], bigint, integer, integer, integer) from public, anon;
grant execute on function movimiento_vinculado(uuid), pago_vinculado(uuid), subconjunto_unico(bigint[], bigint, integer, integer, integer) to authenticated, service_role;
revoke execute on function flujo_lineas_entre(date, date, uuid, boolean) from public, anon;
grant execute on function flujo_lineas_entre(date, date, uuid, boolean) to authenticated, service_role;


-- ======================================== 0033_conciliar_sin_trabar_espejo.sql
-- Revisión de la integración de Tesorería (26/11): la conciliación automática no puede trabar ni volver lenta
-- la copia de la hoja.
--
-- 0030 agregó disparadores por sentencia sobre pagos, cobros, cheques y movimientos que llaman a
-- conciliar_movimientos (y desde 0032, a conciliar_lotes). La copia de la hoja (espejar_pagos) escribe pago por
-- pago, así que cada fila disparaba la conciliación completa de la empresa; y si la conciliación fallaba, se caía
-- también la copia de los pagos.
--
-- Ahora:
--   · Lo que escribe el servidor por la API (rol service_role: copia de la hoja, marcas del Cash Flow, envíos a
--     Xubio, cobros) no concilia fila por fila. El servidor concilia una vez al terminar: la copia de la hoja al
--     final de cada lote de pagos (netlify/functions/espejo.mts) e importar_extracto al final del archivo (0031).
--   · Lo que hace una persona desde la app (marcar un cheque debitado, cargar un pago) sigue conciliando al momento.
--   · Si la conciliación falla, queda un aviso y el cambio que la disparó se guarda igual.

create or replace function conciliar_tras_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  -- importar_extracto concilia una sola vez cuando termina de cargar el archivo.
  if current_setting('tesoreria.conciliar_al_final', true) = '1' then return null; end if;
  -- El servidor por la API concilia al final de su lote (copia de la hoja, importación de extractos).
  if coalesce(current_setting('role', true), '') = 'service_role' then return null; end if;
  for e in select distinct empresa_id from nuevos loop
    begin
      perform conciliar_movimientos(e);
    exception when others then
      raise warning 'No se pudo conciliar %: %', e, sqlerrm;
    end;
  end loop;
  return null;
end $$;
revoke execute on function conciliar_tras_cambio() from public, anon, authenticated;

