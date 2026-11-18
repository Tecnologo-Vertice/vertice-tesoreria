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
