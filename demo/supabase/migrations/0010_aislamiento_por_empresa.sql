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
