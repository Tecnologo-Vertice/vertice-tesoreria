-- 0038 · Flujo: lo que usan en la grilla (Tanda 6 de PARIDAD_COMPLETA.md, 27/11/2026).
--
-- Copia el comportamiento del Apps Script (FlujoCaja.js y ConectorFlujoV2.js):
--   1. "Esta y las siguientes" al cambiar una proyección recurrente (fbProyCambiar).
--   3. Filas MANUAL (se marcan por el código de la hoja, FB_MANUAL_): en esas filas el motor no suma y se carga un importe a mano de un día (FB_MANUAL_, fbAgregarDesdeGrilla).
--      Acá la carga a mano es una proyección puntual (origen MANUAL) y entra sola en los subtotales y la caja.
--   4. Prestador persona física pagado desde Dax: va a Consultorios (regla 3 de ConectorFlujoV2.js).
--   5. Planilla de gastos del mes ("Gastos Mes" y "Gastos Mes Control", con ±1 %): gastosMesPreparar_.
--   6. Foto mensual de la proyección (sacarFotoProyeccionMes): tabla de fotos, acción para sacarla y comparar.
-- (El punto 2, exportar la grilla, se hace en la pantalla: no toca la base.)
--
-- Las funciones vuelven a crearse desde la última versión que las define: crear_proyeccion (0026) y
-- flujo_lineas_entre (0034). Nada de esta migración depende de la 0037.

-- ---------------------------------------------------------------- Estructura: filas manuales y fila de personas físicas

alter table flujo_filas add column if not exists manual boolean not null default false;
alter table flujo_filas add column if not exists para_persona_fisica boolean not null default false;
-- Código de la hoja: la columna B de las pestañas v2 del motor (SUELDOS, COMISIONES__ID...). Lo guarda el migrador
-- (scripts/migrar-desde-planillas): las filas ya cargadas se completan la próxima vez que corra la carga, que es idempotente.
alter table flujo_filas add column if not exists codigo_hoja text;
-- Una sola fila por unidad recibe a las personas físicas pagadas desde esa unidad (en Beratung: Consultorios de Dax Salud).
create unique index if not exists flujo_filas_una_persona_fisica on flujo_filas (unidad_id) where para_persona_fisica and activa;

-- La lista FB_MANUAL_ del Apps Script (FlujoCaja.js): los códigos de hoja que empiezan así son filas MANUAL.
create or replace function es_codigo_manual(p_codigo text)
returns boolean language sql immutable as $$
  select btrim(coalesce(p_codigo, '')) ~ '^(COMISIONES__ID|MANAGEMENT|SUELDOS|CARGAS_SOCIALES|SINDICATO|REPRESENTACION|MIS_FACILIDADES|IVA_SALDO|IMPUESTO_A_LAS_GANANCIAS|ANTICIPOS|RENDIMIENTOS|FONDOS|PRESTAMO|CHEQUES|INTERESES|LEASING|CUENTA_CON|CREDITOS_FINANCIERAS|INGRESOS_BRUTOS_A_PAGAR|PROVISION|BELTRAMINO|NICOLAS_SISELES|ALEJO_SISELES|RETENCION_DE_IVA_EFECTUADA|RETENCION_GANANCIAS_EFECTUADA|RETENCION_INGRESOS_BRUTOS_EFECTUADA)'
$$;

-- Cuando se carga o cambia el código de la hoja, la fila se marca sola. Marcar o desmarcar a mano (marcar_fila_flujo) sigue valiendo
-- hasta que el código cambie.
create or replace function fila_manual_por_codigo()
returns trigger language plpgsql set search_path = public as $$
begin
  if es_codigo_manual(new.codigo_hoja) and (tg_op = 'INSERT' or new.codigo_hoja is distinct from old.codigo_hoja) then new.manual := true; end if;
  return new;
end $$;
drop trigger if exists trg_fila_manual_por_codigo on flujo_filas;
create trigger trg_fila_manual_por_codigo before insert or update of codigo_hoja on flujo_filas for each row execute function fila_manual_por_codigo();

-- Las filas que ya tengan código (si se cargó antes) se marcan ahora. El nombre de la cuenta NO se usa: no es el criterio del Apps Script.
update flujo_filas set manual = true where es_codigo_manual(codigo_hoja) and not manual;

-- Persona física: en la unidad llamada "Dax…", la fila de CUENTA (no las aperturas) de prestaciones médicas de Consultorios; si hay
-- varias, la de menor orden. Si ya hay una marcada en la unidad, no se toca. A confirmar con Tecnología (es una suposición por nombre).
update flujo_filas f set para_persona_fisica = true
where f.id in (
  select distinct on (x.unidad_id) x.id
  from flujo_filas x join unidades u on u.id = x.unidad_id
  where x.activa and x.tipo = 'CUENTA' and upper(u.nombre) like 'DAX%'
    and texto_banco(x.cuenta_contable) like '%PRESTACIONES MEDICAS%' and texto_banco(x.cuenta_contable) like '%CONSULTORIO%'
    and not exists (select 1 from flujo_filas y where y.unidad_id = x.unidad_id and y.para_persona_fisica and y.activa)
  order by x.unidad_id, x.orden, x.id
);
do $$
declare n integer;
begin
  select count(*) into n from unidades u
  where upper(u.nombre) like 'DAX%' and not exists (select 1 from flujo_filas f where f.unidad_id = u.id and f.para_persona_fisica and f.activa);
  if n > 0 then raise notice 'Personas físicas: % unidad(es) "Dax…" quedaron sin fila marcada (se marca con marcar_fila_flujo o desde el Flujo)', n; end if;
end $$;

alter table proyecciones drop constraint if exists proyecciones_origen_check;
alter table proyecciones add constraint proyecciones_origen_check
  check (origen in ('MANUAL', 'GASTO_FIJO', 'PLAN_PAGO', 'PRESTAMO', 'SUELDOS', 'COBRANZA', 'PLANILLA_GASTOS'));

-- Marcar o desmarcar una fila del Flujo como "manual" o como destino de las personas físicas.
create or replace function marcar_fila_flujo(p_fila uuid, p_manual boolean, p_persona_fisica boolean)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f flujo_filas;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  select * into f from flujo_filas where id = p_fila for update;
  if f.id is null then raise exception 'La fila no existe'; end if;
  perform exigir_empresa(f.empresa_id);
  if f.tipo not in ('CUENTA', 'APERTURA') then raise exception 'Solo las filas de cuenta se marcan'; end if;
  if coalesce(p_persona_fisica, false) and f.tipo <> 'CUENTA' then raise exception 'La fila de las personas físicas tiene que ser una fila de cuenta, no una apertura'; end if;
  if coalesce(p_persona_fisica, false) then
    update flujo_filas set para_persona_fisica = false where unidad_id = f.unidad_id and para_persona_fisica and id <> f.id;
  end if;
  update flujo_filas set manual = coalesce(p_manual, false), para_persona_fisica = coalesce(p_persona_fisica, false) where id = p_fila;
  perform registrar_auditoria(u, 'FLUJO_FILA', 'FLUJO_FILA', p_fila::text,
    f.etiqueta || ' · manual ' || case when coalesce(p_manual, false) then 'sí' else 'no' end ||
    ' · personas físicas ' || case when coalesce(p_persona_fisica, false) then 'sí' else 'no' end);
end $$;

-- Persona física = el nombre no trae forma societaria (S.A., S.R.L., SAS, sociedad, cooperativa). Es el criterio del motor.
create or replace function es_persona_fisica(p_nombre text)
returns boolean language sql immutable as $$
  select btrim(coalesce(p_nombre, '')) <> ''
     and regexp_replace(texto_banco(p_nombre), '[^A-Z0-9]+', ' ', 'g') !~ '(^| )(S ?A|S ?R ?L|SAS|SOCIEDAD|COOP)( |$)'
$$;

-- ---------------------------------------------------------------- 3. Alta de proyecciones: las filas manuales no repiten

-- Igual que en 0026. En una fila MANUAL solo se carga el importe de un día (sin recurrencia, de hoy en adelante) y se anota como
-- carga manual: es lo que hace fbAgregarDesdeGrilla en las filas manuales del Apps Script.
create or replace function crear_proyeccion(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_id uuid; v_fila flujo_filas; v_rec text := coalesce(p->>'recurrencia', 'UNICA'); v_origen text := coalesce(p->>'origen', 'MANUAL');
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  perform exigir_empresa(p->>'empresa_id');
  select * into v_fila from flujo_filas where id = (p->>'fila_id')::uuid;
  if v_fila.id is not null and v_fila.manual then
    if v_rec <> 'UNICA' then raise exception 'Esa fila se carga a mano en el Flujo: cargá el importe de un día (sin recurrencia)'; end if;
    if (p->>'fecha_inicio')::date < hoy_ar() then raise exception 'Solo se carga de hoy en adelante'; end if;
    v_origen := 'MANUAL';
  end if;
  insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, proveedor_id, importe, fecha_inicio, recurrencia, dia_mes,
                            hasta, cuotas, ajuste_pct_mensual, origen, nota, creado_por)
  values (p->>'empresa_id', (p->>'unidad_id')::uuid, (p->>'fila_id')::uuid, p->>'concepto', (p->>'proveedor_id')::uuid,
          round((p->>'importe')::numeric, 2), (p->>'fecha_inicio')::date, v_rec,
          (p->>'dia_mes')::integer, (p->>'hasta')::date, (p->>'cuotas')::integer, coalesce((p->>'ajuste_pct_mensual')::numeric, 0),
          v_origen, p->>'nota', u.email)
  returning id into v_id;
  perform registrar_auditoria(u, 'CREAR', 'PROYECCION', v_id::text,
    (p->>'concepto') || ' · ' || (p->>'importe') || case when v_fila.manual then ' · carga manual' else '' end);
  return v_id;
end $$;

-- ---------------------------------------------------------------- 1. "Esta y las siguientes" (fbProyCambiar)

-- Cambiar o borrar una ocurrencia de una proyección.
--   SOLO_ESTA   una excepción en esa fecha (importe y/o fecha). En una proyección puntual, borrarla la da de baja.
--   DESDE_ESTA  corta la serie el día anterior y, si no se borra, crea una serie nueva desde esta ocurrencia con los
--               cambios (misma recurrencia, mismo final y mismo ajuste; las cuotas que quedan). Devuelve la serie nueva.
-- Las excepciones que la serie vieja tenía de esta fecha en adelante pasan a la nueva (si la fecha no cambió).
create or replace function cambiar_proyeccion(p_id uuid, p_ocurrencia date, p_alcance text, p_accion text,
                                              p_importe numeric default null, p_fecha date default null, p_motivo text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; p proyecciones; o record; v_hoy date := hoy_ar(); v_antes integer; v_ult_antes date; v_nueva uuid; v_imp numeric; v_inicio date; v_borrar boolean;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if p_alcance not in ('SOLO_ESTA', 'DESDE_ESTA') then raise exception 'El alcance es SOLO_ESTA o DESDE_ESTA'; end if;
  if p_accion not in ('EDITAR', 'BORRAR') then raise exception 'La acción es EDITAR o BORRAR'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  v_borrar := p_accion = 'BORRAR';
  if not v_borrar and p_importe is null and p_fecha is null then raise exception 'No hay nada para cambiar: falta el importe o la fecha'; end if;
  if p_importe is not null and p_importe <= 0 then raise exception 'El importe va en positivo: el signo lo pone la proyección'; end if;
  select * into p from proyecciones where id = p_id for update;
  if p.id is null then raise exception 'No encontré la proyección'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.estado <> 'ACTIVA' then raise exception 'La proyección ya no está activa'; end if;
  if p_ocurrencia < v_hoy then raise exception 'No se cambia lo que ya pasó'; end if;
  if p_fecha is not null and p_fecha < v_hoy then raise exception 'No se proyecta en el pasado'; end if;
  select x.* into o from proyeccion_ocurrencias(p, p_ocurrencia, p_ocurrencia) x where x.ocurrencia = p_ocurrencia;
  if o.ocurrencia is null then raise exception 'La proyección no tiene una ocurrencia el %', p_ocurrencia; end if;

  -- Una sola vez (o solo esta): como el Apps Script, una puntual se trata siempre como "solo esta".
  if p_alcance = 'SOLO_ESTA' or p.recurrencia = 'UNICA' then
    if p.recurrencia = 'UNICA' and v_borrar then
      update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
      where id = p_id;
    else
      perform ajustar_linea_flujo('PROYECCION', p_id, p_ocurrencia::text, p_fecha, p_importe, v_borrar, p_motivo);
    end if;
    perform registrar_auditoria(u, 'PROYECCION_CAMBIAR', 'PROYECCION', p_id::text,
      'Solo la del ' || p_ocurrencia || ' · ' || p_accion || coalesce(' · importe ' || p_importe, '') || coalesce(' · al ' || p_fecha, '') || ' · ' || p_motivo);
    return null;
  end if;

  -- Esta y las siguientes.
  select count(*), max(x.ocurrencia) into v_antes, v_ult_antes from proyeccion_ocurrencias(p, p.fecha_inicio, p_ocurrencia - 1) x;
  v_inicio := coalesce(p_fecha, p_ocurrencia);
  if not v_borrar and v_ult_antes is not null and v_inicio <= v_ult_antes then
    raise exception 'La fecha nueva queda antes de la ocurrencia anterior (%): elegí una posterior', v_ult_antes;
  end if;
  if not v_borrar and p.hasta is not null and v_inicio > p.hasta then raise exception 'La fecha nueva queda después del final de la serie'; end if;
  -- Las excepciones de esta ocurrencia ya no valen (cambia la serie); las de después pasan a la nueva si la fecha no cambió.
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null and ocurrencia = p_ocurrencia::text;
  if v_antes = 0 then
    update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
    where id = p_id;
  else
    update proyecciones set hasta = p_ocurrencia - 1 where id = p_id;
  end if;
  if not v_borrar then
    v_imp := coalesce(p_importe, abs(o.importe)) * case when p.importe < 0 then -1 else 1 end;
    insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, proveedor_id, importe, fecha_inicio, recurrencia, dia_mes,
                              hasta, cuotas, ajuste_pct_mensual, origen, nota, creado_por)
    values (p.empresa_id, p.unidad_id, p.fila_id, p.concepto, p.proveedor_id, v_imp, v_inicio, p.recurrencia,
            case when p.recurrencia = 'MENSUAL' then case when p_fecha is null then p.dia_mes else extract(day from p_fecha)::integer end end,
            p.hasta, case when p.cuotas is not null then p.cuotas - v_antes end, p.ajuste_pct_mensual, p.origen,
            concat_ws(' · ', 'Sigue a ' || left(p_id::text, 8), p_motivo), u.email)
    returning id into v_nueva;
    if p_fecha is null then
      update flujo_ajustes set origen_id = v_nueva
      where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null
        and ocurrencia ~ '^\d{4}-\d{2}-\d{2}$' and ocurrencia::date > p_ocurrencia;
    end if;
  end if;
  -- Lo que quedó sin dueño (se borró, o la fecha cambió): se da de baja para que no se vea como una excepción vigente.
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null
    and ocurrencia ~ '^\d{4}-\d{2}-\d{2}$' and ocurrencia::date > p_ocurrencia;
  perform registrar_auditoria(u, 'PROYECCION_CAMBIAR', 'PROYECCION', p_id::text,
    'Desde el ' || p_ocurrencia || ' · ' || p_accion || coalesce(' · importe ' || p_importe, '') || coalesce(' · al ' || p_fecha, '') ||
    coalesce(' · serie nueva ' || v_nueva, '') || ' · ' || p_motivo);
  return v_nueva;
end $$;

-- Ayudas de texto (las usa el Flujo y la planilla de gastos).
-- Misma plata: hasta $1, o hasta el 1 % del importe de la factura (gmCerca_).
create or replace function importes_cercanos(a numeric, b numeric)
returns boolean language sql immutable as $$
  select abs(a - b) <= greatest(1, abs(b) * 0.01)
$$;

-- Mismo proveedor: comparten alguna palabra de más de 3 letras (gmMismoProv_).
create or replace function mismo_proveedor_texto(a text, b text)
returns boolean language sql immutable as $$
  select exists (
    select 1 from unnest(string_to_array(regexp_replace(texto_banco(a), '[^A-Z0-9]+', ' ', 'g'), ' ')) x
    where length(x) > 3 and x = any(string_to_array(regexp_replace(texto_banco(b), '[^A-Z0-9]+', ' ', 'g'), ' ')))
$$;

-- "00001-00000123", "FA 1-123" → "1-123": primer y último grupo de dígitos, sin ceros (gmFac_).
create or replace function clave_factura_texto(p text)
returns text language sql immutable as $$
  select case when cardinality(a) < 2 then '' else a[1]::bigint::text || '-' || a[cardinality(a)]::bigint::text end
  from (select array(select left(replace(t.x, ' ', ''), 18)
                     from unnest(string_to_array(regexp_replace(coalesce(p, ''), '[^0-9-]', ' ', 'g'), '-')) with ordinality as t(x, n)
                     where replace(t.x, ' ', '') <> '' order by t.n) as a) q
$$;

-- ---------------------------------------------------------------- 4. El Flujo: persona física pagada desde Dax va a Consultorios

-- Igual que 0034, con una sola diferencia: la fila final de un PAGO real que salió de una cuenta con extracto pasa a la fila
-- marcada "personas físicas" de esa unidad cuando:
--   · el proveedor es una persona física (el nombre no trae S.A., S.R.L., SAS, sociedad ni cooperativa),
--   · ninguna regla del Flujo mandó el pago a otro lado (en el motor: "sin Reglas Estudio"), y
--   · el pago cayó en "Sin clasificar" o en una cuenta genérica (honorarios profesionales, gastos generales, sin cuenta).
-- (ConectorFlujoV2.js, paso 3: "prestador persona física pagado desde Dax… criterio del Flujo real").
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
), pfuera as materialized (
  -- (0034) Pagos que NO entran al Flujo como pago: los de caja (efectivo; impactan por la reposición del fondo) y,
  -- desde el corte del 17/11/2026, los que no están en Xubio (estado SUBIDO, YA_EN_XUBIO o CARGADO_A_MANO; los
  -- cargados en el sistema nuevo cuentan cuando están contabilizados con su id de Xubio). Es el filtro del motor
  -- (ConectorFlujoV2.js). Su débito, si el banco ya lo tiene, sigue entrando por la rama de movimientos.
  select p.id as pago_id
  from pagos p
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio::text not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    and (p.medio::text = 'CAJA'
         or (p.fecha > date '2026-11-17'
             and upper(btrim(coalesce(p.estado_xubio_pago, ''))) not in ('SUBIDO', 'YA_EN_XUBIO', 'CARGADO_A_MANO')
             and not (p.estado_xubio_pago is null and p.gestion = 'SISTEMA'
                      and p.estado in ('CONTABILIZADO', 'CONCILIADO') and p.xubio_id is not null)))
), lote_fuera as materialized (
  -- De un débito en lote: cuántos de sus pagos quedan fuera y por cuánto.
  select x.movimiento_id, count(*) as n, count(pf.pago_id) as fuera_n, coalesce(sum(x.importe) filter (where pf.pago_id is not null), 0) as fuera_imp
  from movimientos_pagos x left join pfuera pf on pf.pago_id = x.pago_id
  group by x.movimiento_id
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
), fac0 as (
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
), deb_libres as materialized (
  -- (0034) Débitos del banco sin documento: la plata ya salió y cuentan como reales.
  select m.id, m.empresa_id, m.fecha, -m.importe as imp
  from movimientos_bancarios m
  where m.estado <> 'IGNORADO' and m.importe < 0 and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.contraparte_cuenta_id is null and m.categoria in ('PAGO', 'SIN_CLASIFICAR') and m.destino_xubio = 'NINGUNO'
    and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    and exists (select 1 from fac0)
), dup_par as (
  -- (0034) Doble conteo: una factura proyectada que el extracto ya muestra pagada (paso "REAL (extracto)" del motor):
  -- débito sin documento, misma empresa, mismo importe al centavo, de 30 días antes a 3 después de la fecha de la
  -- factura. Solo cuenta si la pareja es ÚNICA de los dos lados.
  select f.factura_id, f.ocurrencia, d.id as mov_id,
         count(*) over (partition by f.factura_id, f.ocurrencia) as n_mov,
         count(*) over (partition by d.id) as n_fac
  from fac0 f join deb_libres d on d.empresa_id = f.empresa_id and d.imp = f.importe and d.fecha between f.fecha - 30 and f.fecha + 3
), fac as (
  -- Se excluye la proyección (el débito ya cuenta como real, en su fecha y su cuenta).
  select f.* from fac0 f
  where not exists (select 1 from dup_par x where x.n_mov = 1 and x.n_fac = 1 and x.factura_id = f.factura_id and x.ocurrencia = f.ocurrencia)
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
    and not exists (select 1 from pfuera pf where pf.pago_id = p.id)
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
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha,
         -- (0034) de un lote con pagos fuera del Flujo cuenta solo la parte de esos pagos
         case when lf.movimiento_id is null or lf.fuera_n = lf.n then m.importe else -lf.fuera_imp end,
         'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  left join lote_fuera lf on lf.movimiento_id = m.id
  where m.estado <> 'IGNORADO'
    -- (0034) un débito vinculado a un pago que no entra al Flujo (no está en Xubio, o es de caja) sigue contando
    and (m.pago_id is null or exists (select 1 from pfuera pf where pf.pago_id = m.pago_id))
    and m.cobro_id is null and m.cheque_id is null
    and (lf.movimiento_id is null or lf.fuera_n > 0)
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
         -- (0038) para la regla de personas físicas: la regla que aplicó y si el pago tiene proveedor o destino escrito
         d.regla_id, coalesce(fr.nota like 'Mapa Flujo%', false) as regla_mapa, (b.proveedor_id is not null or exists (select 1 from pagos pg where pg.id = b.origen_id and b.origen_tipo = 'PAGO'
                                                              and btrim(coalesce(pg.proveedor_destino, '')) <> '')) as con_proveedor,
         coalesce(d.r_unidad, b.hint) as v_unidad,
         coalesce(d.r_fila, ap.id, fc.id, sc.id) as v_fila
  from b2 b
  join dest d on d.organizacion_id = b.organizacion_id and d.empresa_id = b.empresa_id and d.hint is not distinct from b.hint
             and d.origen_tipo = b.origen_tipo and d.k_prov = b.k_prov and d.cuenta_norm = b.cuenta_norm and d.k_cta = b.k_cta
             and d.k_cat = b.k_cat and d.texto_norm = b.texto_norm
  left join proveedores pv on pv.id = b.proveedor_id
  left join flujo_reglas fr on fr.id = d.regla_id
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
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.origen
  from proyecciones p
  cross join hoy
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, hoy.h, hoy.h + 180) o
  where not coalesce(p_solo_real, false) and p.estado = 'ACTIVA'
    -- (0038) lo pendiente de factura de la planilla de gastos deja de sumar cuando llega la factura (mismo proveedor, ±1 %)
    and not (p.origen = 'PLANILLA_GASTOS' and exists (
          select 1 from fac f where f.empresa_id = p.empresa_id
            and mismo_proveedor_texto(split_part(p.concepto, ' · GASTOS ', 1), f.proveedor) and importes_cercanos(abs(p.importe), f.importe)))
), proy_f as (
  -- (0038) Fila MANUAL: lo cargado a mano en la app (origen MANUAL) reemplaza a las demás proyecciones de esa fila y ese día (así no se
  -- suma dos veces, como en el Apps Script, donde el motor no proyecta en las filas manuales). Si ese día no hay carga a mano, las otras
  -- proyecciones (planes de pago, sueldos y gastos fijos que vienen de la planilla) siguen sumando como siempre.
  select x.* from proy x
  where x.origen = 'MANUAL'
     or not exists (select 1 from proy y join flujo_filas fm on fm.id = y.fila_id and fm.manual
                    where y.origen = 'MANUAL' and y.fila_id = x.fila_id and y.fecha = x.fecha)
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
         r.cuenta_origen_id, r.afecta_bancos, r.descuento,
         r.unidad_cuenta is not null and (r.regla_id is null or r.regla_mapa) and r.con_proveedor as pf_posible
  from res r
  left join esp ec on ec.unidad_id = r.unidad_cuenta and ec.seccion = 'ENTRE_CUENTAS'
  left join esp su on su.unidad_id = r.unidad_cuenta and su.seccion = 'SIN_CLASIFICAR'
  where r.unidad_cuenta is not null or not r.r_excluir
  union all
  select empresa_id, unidad_id, fila_id, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true, 0, false
  from proy_f
), fin as (
  select t.empresa_id, t.unidad_id, ff.id as fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
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
  join flujo_filas f0 on f0.id = t.fila_id
  -- (0038) persona física pagada desde la cuenta de una unidad: a la fila de personas físicas de esa unidad (Consultorios en Dax)
  left join flujo_filas pf on pf.unidad_id = t.unidad_id and pf.para_persona_fisica and pf.activa
                          and t.pf_posible and t.origen_tipo = 'PAGO' and t.naturaleza = 'REAL' and pf.id <> t.fila_id
                          and (f0.seccion = 'SIN_CLASIFICAR'
                               or f0.cuenta_norm ~ '(^| )(HONORARIOS PROFESIONALES|GASTOS GENERALES ESTABLECIMIENTO|GASTOS GENERALES|SIN CUENTA)$')
                          and es_persona_fisica(t.contraparte)
  join flujo_filas ff on ff.id = coalesce(pf.id, t.fila_id)
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

-- ---------------------------------------------------------------- 5. Planilla de gastos del mes (gastosMesPreparar_)

-- El Apps Script lee un Excel mensual "GASTOS <MES>" (colaboradores, honorarios) y lo cruza con las facturas que el Flujo
-- proyecta en Dax Salud: si el renglón y la factura coinciden, la fecha de pago es la de la planilla; si no hay factura y
-- no está vencido, se agrega como pendiente de factura. Y anota en "Gastos Mes Control" qué filas y meses manda la planilla.
-- Acá la planilla se carga con cargar_gastos_mes (el lector del Excel queda aparte: manda las líneas ya leídas).

create table if not exists gastos_mes (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     text not null references empresas,
  unidad_id      uuid not null references unidades on delete cascade,
  anio           integer not null,
  mes            integer not null check (mes between 1 and 12),
  archivo        text,
  orden          integer not null,
  hoja           text,
  nombre         text not null,
  cuit           text,
  factura        text,
  factura_clave  text not null default '',
  importe        numeric(16,2) not null,
  fecha          date,
  pami           boolean not null default false,          -- se paga cuando PAMI acredita
  fila           text,                                    -- etiqueta de la fila del Flujo que dice la planilla
  -- Qué hizo la carga con el renglón.
  usada          boolean not null default false,
  factura_id     uuid references facturas on delete set null,
  fecha_flujo    date,
  resultado      text check (resultado in ('CON_FACTURA', 'PENDIENTE', 'SALTEADA')),
  cargado_por    text not null,
  cargado_en     timestamptz not null default now()
);
create index if not exists gastos_mes_unidad_mes on gastos_mes (unidad_id, anio, mes);

-- Qué filas y qué meses manda la planilla (en la fila y el mes marcados, lo del Flujo sale de ella).
create table if not exists gastos_mes_control (
  unidad_id       uuid not null references unidades on delete cascade,
  empresa_id      text not null references empresas,
  fila_norm       text not null,
  fila            text not null,
  mes             text not null check (mes ~ '^\d{2}/\d{4}$'),
  archivo         text,
  actualizado_en  timestamptz not null default now(),
  primary key (unidad_id, fila_norm, mes)
);

-- Carga la planilla del mes de una unidad (reemplaza la carga anterior de esa unidad).
--   p_lineas: [{ hoja, nombre, cuit, factura, importe, fecha 'aaaa-mm-dd', pami true/false, fila }]
create or replace function cargar_gastos_mes(p_unidad uuid, p_anio integer, p_mes integer, p_archivo text, p_lineas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; un unidades; v_hoy date := hoy_ar(); v_manana date := hoy_ar() + 1;
  v_pami date; v_ult date; v_mes_txt text; v_fin_mes date;
  g gastos_mes; fl record; v_t date; v_fecha date; v_con integer := 0; v_pend integer := 0; v_salt integer := 0; v_total integer;
  v_fila uuid; v_etiq text; v_prev flujo_ajustes; v_nf text;
  meses text[] := array['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if p_mes not between 1 and 12 or p_anio not between 2000 and 2100 then raise exception 'El mes o el año de la planilla no es válido'; end if;
  select * into un from unidades where id = p_unidad;
  if un.id is null then raise exception 'La unidad no existe'; end if;
  perform exigir_empresa(un.empresa_id);
  if jsonb_typeof(p_lineas) <> 'array' then raise exception 'Las líneas tienen que ser una lista'; end if;
  if jsonb_array_length(p_lineas) > 2000 then raise exception 'Son demasiadas líneas (máximo 2000)'; end if;
  v_mes_txt := lpad(p_mes::text, 2, '0') || '/' || p_anio;
  v_fin_mes := (make_date(p_anio, p_mes, 1) + interval '1 month - 1 day')::date;

  -- Lo de una carga anterior se deshace: las fechas que puso la planilla, lo pendiente de factura y el control.
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = 'FACTURA' and reemplazado_en is null and motivo like 'Planilla GASTOS%'
    and origen_id in (select factura_id from gastos_mes where unidad_id = p_unidad and factura_id is not null);
  update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(),
         nota = concat_ws(' · ', nota, 'Reemplazada por una carga nueva de la planilla')
  where unidad_id = p_unidad and origen = 'PLANILLA_GASTOS' and estado = 'ACTIVA';
  delete from gastos_mes where unidad_id = p_unidad;
  delete from gastos_mes_control where unidad_id = p_unidad;

  insert into gastos_mes (empresa_id, unidad_id, anio, mes, archivo, orden, hoja, nombre, cuit, factura, factura_clave, importe, fecha, pami, fila, cargado_por)
  select un.empresa_id, p_unidad, p_anio, p_mes, p_archivo, x.n, x.e->>'hoja', btrim(x.e->>'nombre'), x.e->>'cuit', x.e->>'factura',
         clave_factura_texto(x.e->>'factura'), round((x.e->>'importe')::numeric, 2), nullif(x.e->>'fecha', '')::date,
         coalesce((x.e->>'pami')::boolean, false), nullif(btrim(coalesce(x.e->>'fila', '')), ''), u.email
  from jsonb_array_elements(p_lineas) with ordinality as x(e, n)
  where coalesce((x.e->>'importe')::numeric, 0) <> 0 and btrim(coalesce(x.e->>'nombre', '')) <> '';
  select count(*) into v_total from gastos_mes where unidad_id = p_unidad;

  -- Fecha de PAMI: el primer cobro de Consultorios proyectado del mes; si no hay, el último día hábil del mes.
  select min(l.fecha) into v_pami
  from flujo_lineas_entre(v_hoy, v_fin_mes, p_unidad, false) l
  join flujo_filas ff on ff.id = l.fila_id
  where l.fecha >= v_hoy and to_char(l.fecha, 'MM/YYYY') = v_mes_txt
    and texto_banco(concat_ws(' ', ff.etiqueta, ff.cuenta_contable, ff.apertura)) like '%DEUDORES POR VENTAS%'
    and texto_banco(concat_ws(' ', ff.etiqueta, ff.cuenta_contable, ff.apertura)) like '%CONSULTORIO%';
  if v_pami is null then
    v_ult := dia_habil_anterior(v_fin_mes + 1);
    v_pami := case when to_char(v_ult, 'MM/YYYY') = v_mes_txt and v_ult >= v_hoy then v_ult else v_manana end;
  end if;

  -- Cruce con las facturas que el Flujo proyecta: mismo número y (mismo proveedor o importe cercano), o mismo proveedor e importe cercano.
  for fl in
    select x.origen_id, x.ocurrencia, abs(x.importe) as importe, x.contraparte, x.fila_id, f.punto_venta, f.numero
    from flujo_lineas_entre(v_hoy, v_hoy + 180, p_unidad, false) x
    join facturas f on f.id = x.origen_id
    where x.origen_tipo = 'FACTURA' and x.naturaleza = 'PROYECTADO'
    order by x.fecha, x.origen_id, x.ocurrencia
  loop
    v_nf := fl.punto_venta::bigint::text || '-' || fl.numero::bigint::text;
    g := null;
    select * into g from gastos_mes m
    where m.unidad_id = p_unidad and not m.usada
      and ((m.factura_clave <> '' and m.factura_clave = v_nf and (mismo_proveedor_texto(m.nombre, fl.contraparte) or importes_cercanos(m.importe, fl.importe)))
           or (mismo_proveedor_texto(m.nombre, fl.contraparte) and importes_cercanos(m.importe, fl.importe)))
    order by m.orden limit 1;
    if g.id is null then continue; end if;
    -- Fecha de pago de la planilla: PAMI o la que dice; lo vencido pasa a mañana; siempre un día hábil.
    v_t := case when g.pami then v_pami else g.fecha end;
    v_fecha := case when v_t is null then null else dia_habil_desde(case when v_t < v_hoy then v_manana else v_t end) end;
    update gastos_mes set usada = true, factura_id = fl.origen_id, resultado = 'CON_FACTURA', fecha_flujo = v_fecha where id = g.id;
    if v_fecha is not null then
      v_prev := null;
      select * into v_prev from flujo_ajustes where origen_tipo = 'FACTURA' and origen_id = fl.origen_id and ocurrencia = fl.ocurrencia
        and reemplazado_en is null for update;
      if v_prev.id is not null then update flujo_ajustes set reemplazado_en = now() where id = v_prev.id; end if;
      insert into flujo_ajustes (empresa_id, origen_tipo, origen_id, ocurrencia, fecha_nueva, importe_nuevo, eliminada, motivo, creado_por)
      values (un.empresa_id, 'FACTURA', fl.origen_id, fl.ocurrencia, v_fecha, v_prev.importe_nuevo, false,
              'Planilla GASTOS ' || meses[p_mes] || coalesce(' · ' || p_archivo, ''), u.email);
    end if;
    select etiqueta into v_etiq from flujo_filas where id = fl.fila_id;
    insert into gastos_mes_control (unidad_id, empresa_id, fila_norm, fila, mes, archivo)
    select distinct p_unidad, un.empresa_id, texto_banco(k.fila), k.fila, k.mes, p_archivo
    from (select e.fila, m.mes from unnest(array[g.fila, v_etiq]) as e(fila)
          cross join unnest(array[v_mes_txt, case when v_fecha is not null then to_char(v_fecha, 'MM/YYYY') end]) as m(mes)) k
    where k.fila is not null and k.mes is not null and texto_banco(k.fila) <> 'SIN CUENTA ASIGNADA' and btrim(k.fila) <> ''
    on conflict do nothing;
    v_con := v_con + 1;
  end loop;

  -- Los renglones que no tienen factura: pendientes de factura, salvo los ya vencidos (se toman como pagados).
  for g in select * from gastos_mes where unidad_id = p_unidad and not usada order by orden loop
    v_t := case when g.pami then v_pami else g.fecha end;
    if v_t is null or (not g.pami and g.fecha < v_hoy) then
      update gastos_mes set resultado = 'SALTEADA' where id = g.id;
      v_salt := v_salt + 1;
      continue;
    end if;
    v_fecha := dia_habil_desde(case when v_t < v_hoy then v_manana else v_t end);
    v_fila := null;
    if g.fila is not null then
      select id into v_fila from flujo_filas where unidad_id = p_unidad and activa and tipo in ('CUENTA', 'APERTURA')
        and texto_banco(etiqueta) = texto_banco(g.fila) order by orden, id limit 1;
    end if;
    v_fila := coalesce(v_fila, fila_especial(p_unidad, 'SIN_CLASIFICAR'));
    insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, importe, fecha_inicio, recurrencia, origen, nota, creado_por)
    values (un.empresa_id, p_unidad, v_fila, g.nombre || ' · GASTOS ' || coalesce(nullif(btrim(g.factura), ''), g.hoja, ''), -g.importe, v_fecha, 'UNICA',
            'PLANILLA_GASTOS', 'Planilla GASTOS ' || meses[p_mes] || ' (sin factura cargada)' || coalesce(' · ' || p_archivo, ''), u.email);
    update gastos_mes set resultado = 'PENDIENTE', fecha_flujo = v_fecha where id = g.id;
    insert into gastos_mes_control (unidad_id, empresa_id, fila_norm, fila, mes, archivo)
    select distinct p_unidad, un.empresa_id, texto_banco(g.fila), g.fila, m.mes, p_archivo
    from unnest(array[v_mes_txt, to_char(v_fecha, 'MM/YYYY')]) as m(mes)
    where g.fila is not null and texto_banco(g.fila) <> 'SIN CUENTA ASIGNADA'
    on conflict do nothing;
    v_pend := v_pend + 1;
  end loop;

  perform registrar_auditoria(u, 'GASTOS_MES', 'UNIDAD', p_unidad::text,
    meses[p_mes] || ' ' || p_anio || coalesce(' · ' || p_archivo, '') || ' · ' || v_total || ' renglones · ' || v_con || ' con factura · '
    || v_pend || ' pendientes · ' || v_salt || ' salteados');
  return jsonb_build_object('lineas', v_total, 'con_factura', v_con, 'pendientes', v_pend, 'salteadas', v_salt);
end $$;

-- ---------------------------------------------------------------- 6. Foto mensual de la proyección (sacarFotoProyeccionMes)

-- Una vez por mes se guarda cómo se veía el mes en el Flujo (por unidad y día) para compararlo después con lo que pasó
-- ("Flujo Proyectado" y "Real vs Proyectado" de la planilla del motor).
create table if not exists flujo_fotos (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           text not null references empresas,
  unidad_id            uuid not null references unidades on delete cascade,
  mes                  text not null check (mes ~ '^\d{4}-\d{2}$'),
  dia                  date not null,
  ingresos_operativos  numeric(16,2) not null default 0,
  costos               numeric(16,2) not null default 0,
  gastos_operativos    numeric(16,2) not null default 0,
  impuestos            numeric(16,2) not null default 0,
  subtotal             numeric(16,2) not null default 0,   -- ingresos + costos + gastos operativos + impuestos (a confirmar)
  socios               numeric(16,2) not null default 0,
  intercompany         numeric(16,2) not null default 0,
  variacion_caja       numeric(16,2) not null default 0,   -- todo lo que mueve la caja del día
  parcial              boolean not null default false,     -- una foto parcial no cuenta como "ya hay foto del mes"
  tomada_en            timestamptz not null default now(),
  tomada_por           text not null,
  unique (unidad_id, dia)
);
create index if not exists flujo_fotos_unidad_mes on flujo_fotos (unidad_id, mes);

-- El Flujo de una unidad resumido por día y sección (con signo: egreso negativo). Lo usan la foto y la comparación.
create or replace function resumen_flujo_dias(p_unidad uuid, p_desde date, p_hasta date)
returns table (dia date, ingresos_operativos numeric, costos numeric, gastos_operativos numeric, impuestos numeric, subtotal numeric,
               socios numeric, intercompany numeric, variacion_caja numeric)
language sql stable as $$
  with l as (select fecha, seccion, mueve_caja, importe from flujo_lineas_entre(p_desde, p_hasta, p_unidad, false)),
  dias as (select d::date as dia from generate_series(p_desde, p_hasta, interval '1 day') d where es_dia_habil(d::date)
           union select fecha from l)
  select d.dia,
         round(coalesce(sum(l.importe) filter (where l.seccion = 'INGRESOS_OPERATIVOS'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion = 'COSTOS'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion = 'GASTOS_OPERATIVOS'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion = 'IMPUESTOS'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion in ('INGRESOS_OPERATIVOS', 'COSTOS', 'GASTOS_OPERATIVOS', 'IMPUESTOS')), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion = 'SOCIOS'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.seccion = 'INTERCOMPANY'), 0), 2),
         round(coalesce(sum(l.importe) filter (where l.mueve_caja), 0), 2)
  from dias d left join l on l.fecha = d.dia
  group by d.dia order by d.dia
$$;

-- La foto del mes de UNA unidad. Si ya hay una (que no sea parcial), no hace nada, salvo que se pida forzar.
-- La puede sacar una persona de Tesorería o el servidor (la tarea programada, a las 10 de Argentina).
create or replace function sacar_foto_flujo_unidad(p_unidad uuid, p_forzar boolean default false, p_parcial boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; un unidades; v_hoy date := hoy_ar(); v_mes text; v_txt text; v_ini date; v_fin date; v_n integer; v_quien text; v_filas jsonb;
begin
  select * into un from unidades where id = p_unidad;
  if un.id is null then raise exception 'La unidad no existe'; end if;
  if es_servidor() then
    v_quien := 'Sistema (tarea programada)';
  else
    u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
    perform exigir_empresa(un.empresa_id);
    v_quien := u.email;
  end if;
  v_mes := to_char(v_hoy, 'YYYY-MM');
  v_txt := to_char(v_hoy, 'MM/YYYY');
  -- Una sola foto a la vez por unidad y mes (la tarea programada y una persona no se pisan)
  perform pg_advisory_xact_lock(hashtext('flujo_foto:' || p_unidad::text || ':' || v_mes));
  if not coalesce(p_forzar, false) and exists (select 1 from flujo_fotos where unidad_id = p_unidad and mes = v_mes and not parcial) then
    return 'Ya hay foto de ' || v_txt;
  end if;
  v_ini := date_trunc('month', v_hoy)::date;
  v_fin := (v_ini + interval '1 month - 1 day')::date;
  -- El Flujo se calcula una sola vez
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_filas from resumen_flujo_dias(p_unidad, v_ini, v_fin) r;
  v_n := jsonb_array_length(v_filas);
  if v_n = 0 then return 'Sin días de ' || v_txt; end if;
  delete from flujo_fotos where unidad_id = p_unidad and mes = v_mes;
  insert into flujo_fotos (empresa_id, unidad_id, mes, dia, ingresos_operativos, costos, gastos_operativos, impuestos, subtotal, socios,
                           intercompany, variacion_caja, parcial, tomada_por)
  select un.empresa_id, p_unidad, v_mes, r.dia, r.ingresos_operativos, r.costos, r.gastos_operativos, r.impuestos, r.subtotal, r.socios,
         r.intercompany, r.variacion_caja, coalesce(p_parcial, false), v_quien
  from jsonb_to_recordset(v_filas) as r(dia date, ingresos_operativos numeric, costos numeric, gastos_operativos numeric, impuestos numeric,
                                        subtotal numeric, socios numeric, intercompany numeric, variacion_caja numeric);
  if u.email is not null then
    perform registrar_auditoria(u, 'FLUJO_FOTO', 'UNIDAD', p_unidad::text,
      un.nombre || ' · ' || v_txt || ' · ' || v_n || ' días' || case when coalesce(p_forzar, false) then ' · reemplazada' else '' end);
  else
    insert into auditoria (usuario, accion, entidad, entidad_id, detalle)
    values (v_quien, 'FLUJO_FOTO', 'UNIDAD', p_unidad::text, un.nombre || ' · ' || v_txt || ' · ' || v_n || ' días');
  end if;
  return 'Foto de ' || v_txt || ': ' || v_n || ' filas';
end $$;

-- Las fotos de todas las unidades que corresponden: las de la organización (servidor) o las que la persona ve.
create or replace function sacar_fotos_flujo(p_organizacion uuid default null, p_forzar boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_res jsonb := '[]'::jsonb; v_msg text; v_srv boolean := es_servidor();
begin
  if v_srv then
    if p_organizacion is null then raise exception 'Falta la organización'; end if;
  else
    perform exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  end if;
  for r in
    select un.id, un.nombre from unidades un join empresas e on e.id = un.empresa_id
    where un.activa and (case when v_srv then e.organizacion_id = p_organizacion else e.id in (select empresas_visibles()) end)
    order by e.id, un.orden, un.id
  loop
    begin
      v_msg := sacar_foto_flujo_unidad(r.id, p_forzar, false);
    exception when others then
      v_msg := 'Error: ' || sqlerrm;
    end;
    v_res := v_res || jsonb_build_object('unidad_id', r.id, 'unidad', r.nombre, 'resultado', v_msg);
  end loop;
  return v_res;
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table gastos_mes enable row level security;
alter table gastos_mes_control enable row level security;
alter table flujo_fotos enable row level security;
drop policy if exists leer_gastos_mes on gastos_mes;
create policy leer_gastos_mes on gastos_mes for select to authenticated using (empresa_id in (select empresas_visibles()));
drop policy if exists leer_gastos_mes_control on gastos_mes_control;
create policy leer_gastos_mes_control on gastos_mes_control for select to authenticated using (empresa_id in (select empresas_visibles()));
drop policy if exists leer_flujo_fotos on flujo_fotos;
create policy leer_flujo_fotos on flujo_fotos for select to authenticated using (empresa_id in (select empresas_visibles()));
drop trigger if exists trg_aislar_gastos_mes on gastos_mes;
create trigger trg_aislar_gastos_mes before insert or update or delete on gastos_mes for each row execute function aislar_por_empresa();
drop trigger if exists trg_aislar_gastos_mes_control on gastos_mes_control;
create trigger trg_aislar_gastos_mes_control before insert or update or delete on gastos_mes_control for each row execute function aislar_por_empresa();
drop trigger if exists trg_aislar_flujo_fotos on flujo_fotos;
create trigger trg_aislar_flujo_fotos before insert or update or delete on flujo_fotos for each row execute function aislar_por_empresa();

-- Las personas leen; escriben solo por las funciones de arriba (que validan el rol y dejan auditoría).
revoke all on gastos_mes, gastos_mes_control, flujo_fotos from public, anon, authenticated;
grant select on gastos_mes, gastos_mes_control, flujo_fotos to authenticated;
grant all on gastos_mes, gastos_mes_control, flujo_fotos to service_role;

revoke execute on function
  marcar_fila_flujo(uuid, boolean, boolean),
  cambiar_proyeccion(uuid, date, text, text, numeric, date, text),
  cargar_gastos_mes(uuid, integer, integer, text, jsonb),
  resumen_flujo_dias(uuid, date, date),
  sacar_foto_flujo_unidad(uuid, boolean, boolean),
  sacar_fotos_flujo(uuid, boolean),
  es_persona_fisica(text), importes_cercanos(numeric, numeric), mismo_proveedor_texto(text, text), clave_factura_texto(text), es_codigo_manual(text)
from public, anon;
grant execute on function
  marcar_fila_flujo(uuid, boolean, boolean),
  cambiar_proyeccion(uuid, date, text, text, numeric, date, text),
  cargar_gastos_mes(uuid, integer, integer, text, jsonb),
  resumen_flujo_dias(uuid, date, date),
  sacar_foto_flujo_unidad(uuid, boolean, boolean),
  sacar_fotos_flujo(uuid, boolean),
  es_persona_fisica(text), importes_cercanos(numeric, numeric), mismo_proveedor_texto(text, text), clave_factura_texto(text), es_codigo_manual(text)
to authenticated, service_role;
revoke execute on function fila_manual_por_codigo() from public, anon, authenticated;
-- crear_proyeccion: los permisos de 0026 (authenticated) más el servidor; anon no (sin sesión no hace nada, pero no hace falta que pueda llamarla).
revoke execute on function crear_proyeccion(jsonb) from public, anon;
grant execute on function crear_proyeccion(jsonb) to authenticated, service_role;
