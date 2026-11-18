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

