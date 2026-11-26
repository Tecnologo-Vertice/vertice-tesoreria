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
