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
