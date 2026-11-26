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
