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
