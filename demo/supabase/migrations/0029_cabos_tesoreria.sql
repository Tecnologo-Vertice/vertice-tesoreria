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
