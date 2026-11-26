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
