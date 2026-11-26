-- Tanda D4 · El Flujo de caja sale de la base: estructura, proyecciones, ajustes y control.
--
-- Reemplaza las pestañas por empresa del Flujo (original y v2), Llave Flujo v2, Mapa Flujo, Gastos Fijos,
-- Proyecciones y Flujo_Cambios_Manuales. Ya no hay una planilla que mantener sincronizada: el Flujo es una
-- consulta (flujo_lineas) sobre lo que ya está en la base.
--
--   REAL        pagos (no anulados, salvo los pagados con cheque) · cheques debitados · cobros ·
--               movimientos del banco que no son un pago, cobro ni cheque (impuestos, gastos, FCI) ·
--               rendimientos de FCI que salen de la conciliación.
--   PROYECTADO  facturas por pagar (con anticipo % + cuenta corriente) · cheques emitidos sin debitar ·
--               proyecciones (únicas o recurrentes: gastos fijos, planes de pago, sueldos, préstamos).
--
-- Reglas (25/11 y 26/11):
--   · Cada línea va a la fila de su cuenta contable (la que tiene asignada en el sistema). Las excepciones
--     (Mapa Flujo, reglas del estudio) son filas de flujo_reglas.
--   · Lo proyectado se puede mover, editar y eliminar; lo real no. Mover una factura cambia su fecha de pago
--     programada, no el vencimiento.
--   · Lo no pagado a término pasa al siguiente día hábil.
--   · Un anticipo pendiente se proyecta para el próximo día hábil; el resto, al vencimiento.
--   · Una factura que se paga con cheque a N días se proyecta a N días de su emisión.

-- ---------------------------------------------------------------- Estructura (filas de cada pestaña)

create table flujo_filas (
  id               uuid primary key default gen_random_uuid(),
  unidad_id        uuid not null references unidades on delete cascade,
  empresa_id       text not null references empresas,
  orden            integer not null,
  tipo             text not null check (tipo in ('SECCION', 'CUENTA', 'APERTURA', 'INTERNO')),
  seccion          text not null check (seccion in ('INGRESOS_OPERATIVOS', 'COSTOS', 'GASTOS_OPERATIVOS', 'IMPUESTOS', 'CAPEX',
                     'INGRESOS_FINANCIEROS', 'TOMA_DEUDA', 'DEVOLUCION_DEUDA', 'SOCIOS', 'INTERCOMPANY', 'ENTRE_CUENTAS', 'SIN_CLASIFICAR')),
  etiqueta         text not null,
  cuenta_contable  text,                    -- cuenta de Xubio (la llave del Flujo v2)
  apertura         text,                    -- proveedor, plan de pago o concepto dentro de la cuenta
  padre_id         uuid references flujo_filas,
  -- false: no cambia la caja total (entre cuentas propias, suscripción o rescate de FCI).
  mueve_caja       boolean not null default true,
  activa           boolean not null default true,
  unique (unidad_id, etiqueta)
);
create index on flujo_filas (unidad_id, cuenta_contable);

create or replace function fila_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select empresa_id into new.empresa_id from unidades where id = new.unidad_id;
  if new.padre_id is not null and not exists (select 1 from flujo_filas f where f.id = new.padre_id and f.unidad_id = new.unidad_id) then
    raise exception 'La fila padre es de otra unidad';
  end if;
  return new;
end $$;
create trigger trg_fila_consistente before insert or update on flujo_filas for each row execute function fila_consistente();

-- Filas que toda unidad necesita: una por sección, "Sin clasificar", "Entre cuentas propias" y rendimientos.
create or replace function crear_filas_base(p_unidad uuid)
returns void language sql security definer set search_path = public as $$
  insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, mueve_caja)
  select p_unidad, u.empresa_id, s.orden, s.tipo, s.seccion, s.etiqueta, s.cuenta, s.mueve
  from unidades u cross join (values
    (100,  'SECCION', 'INGRESOS_OPERATIVOS',  '1. INGRESOS OPERATIVOS', null::text, true),
    (200,  'SECCION', 'COSTOS',               '2. COSTOS', null, true),
    (300,  'SECCION', 'GASTOS_OPERATIVOS',    '3. GASTOS OPERATIVOS', null, true),
    (400,  'SECCION', 'IMPUESTOS',            '4. IMPUESTOS OPERATIVOS', null, true),
    (500,  'SECCION', 'CAPEX',                '5. CAPEX / IMPUESTO A LAS GANANCIAS', null, true),
    (600,  'SECCION', 'INGRESOS_FINANCIEROS', '6. INGRESOS FINANCIEROS', null, true),
    (610,  'CUENTA',  'INGRESOS_FINANCIEROS', 'Rendimientos FCI', 'Rendimientos FCI', true),
    (700,  'SECCION', 'TOMA_DEUDA',           '7. TOMA DE DEUDA', null, true),
    (800,  'SECCION', 'DEVOLUCION_DEUDA',     '8. DEVOLUCIÓN DE DEUDA', null, true),
    (900,  'SECCION', 'SOCIOS',               '9. SOCIOS (retiros y aportes)', null, true),
    (1000, 'SECCION', 'INTERCOMPANY',         '10. INTERCOMPANY Y OTROS MOVIMIENTOS', null, true),
    (1100, 'INTERNO', 'ENTRE_CUENTAS',        'Entre cuentas propias', null, false),
    (9999, 'INTERNO', 'SIN_CLASIFICAR',       'Sin clasificar', null, true)
  ) as s(orden, tipo, seccion, etiqueta, cuenta, mueve)
  where u.id = p_unidad
  on conflict (unidad_id, etiqueta) do nothing
$$;
select crear_filas_base(id) from unidades;

create or replace function unidad_con_filas()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform crear_filas_base(new.id); return null; end $$;
create trigger trg_unidad_con_filas after insert on unidades for each row execute function unidad_con_filas();

create or replace function fila_especial(p_unidad uuid, p_seccion text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from flujo_filas where unidad_id = p_unidad and seccion = p_seccion and tipo = 'INTERNO' order by orden limit 1
$$;

-- ---------------------------------------------------------------- Reglas de destino (excepciones)

create table flujo_reglas (
  id                   uuid primary key default gen_random_uuid(),
  organizacion_id      uuid not null references organizaciones,
  empresa_id           text references empresas,
  prioridad            integer not null default 100,
  -- Condiciones (todas las que no son null tienen que cumplirse).
  si_origen            text check (si_origen in ('PAGO', 'FACTURA', 'CHEQUE', 'COBRO', 'MOVIMIENTO', 'RENDIMIENTO', 'PROYECCION')),
  si_proveedor_id      uuid references proveedores,
  si_cuenta_contable   text,
  si_cuenta_origen_id  uuid references cuentas_origen,
  si_categoria         text,                -- categoría del movimiento bancario
  si_texto             text,                -- contenido en la descripción / beneficiario / cliente
  -- Resultado.
  unidad_id            uuid references unidades,
  fila_id              uuid references flujo_filas,
  excluir              boolean not null default false,   -- no va al Flujo (p. ej., transferencia propia duplicada)
  nota                 text,
  creada_por           text,
  creada_en            timestamptz not null default now(),
  check (excluir or fila_id is not null or unidad_id is not null)
);
create trigger trg_organizacion_flujo_reglas before insert or update on flujo_reglas
  for each row execute function poner_organizacion();

-- Dónde va una línea: primero las reglas (por prioridad); si no, la fila de su cuenta contable en su unidad
-- (la apertura del proveedor si existe, si no la cuenta); si no, "Sin clasificar".
create or replace function flujo_destino(p_empresa text, p_unidad uuid, p_origen text, p_proveedor uuid,
                                         p_cuenta_contable text, p_cuenta_origen uuid, p_categoria text, p_texto text)
returns table (unidad_id uuid, fila_id uuid, excluir boolean)
language plpgsql stable security definer set search_path = public as $$
declare r flujo_reglas; v_unidad uuid; v_fila uuid; v_prov text;
begin
  select x.* into r from flujo_reglas x join empresas e on e.id = p_empresa
  where x.organizacion_id = e.organizacion_id and (x.empresa_id is null or x.empresa_id = p_empresa)
    and (x.si_origen is null or x.si_origen = p_origen)
    and (x.si_proveedor_id is null or x.si_proveedor_id = p_proveedor)
    and (x.si_cuenta_contable is null or texto_banco(x.si_cuenta_contable) = texto_banco(p_cuenta_contable))
    and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = p_cuenta_origen)
    and (x.si_categoria is null or x.si_categoria = p_categoria)
    and (x.si_texto is null or position(texto_banco(x.si_texto) in texto_banco(p_texto)) > 0)
  order by x.prioridad, (x.empresa_id is null) limit 1;
  if r.id is not null and r.excluir then return query select null::uuid, null::uuid, true; return; end if;
  v_unidad := coalesce(r.unidad_id, p_unidad, unidad_por_defecto(p_empresa));
  v_fila := r.fila_id;
  if v_fila is null and p_cuenta_contable is not null then
    select nombre into v_prov from proveedores where id = p_proveedor;
    select f.id into v_fila from flujo_filas f
    where f.unidad_id = v_unidad and f.activa and f.tipo in ('CUENTA', 'APERTURA')
      and texto_banco(f.cuenta_contable) = texto_banco(p_cuenta_contable)
      and (f.tipo = 'CUENTA' or (v_prov is not null and position(texto_banco(f.apertura) in texto_banco(v_prov)) > 0))
    order by (f.tipo = 'APERTURA') desc, f.orden limit 1;
  end if;
  if v_fila is null then v_fila := fila_especial(v_unidad, 'SIN_CLASIFICAR'); end if;
  return query select v_unidad, v_fila, false;
end $$;

-- ---------------------------------------------------------------- Facturas: unidad y anticipo

alter table facturas add column unidad_id uuid references unidades;
alter table facturas add column anticipo_pct numeric(5,2) check (anticipo_pct > 0 and anticipo_pct < 100);

-- ---------------------------------------------------------------- Proyecciones (únicas y recurrentes)

create table proyecciones (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          text not null references empresas,
  unidad_id           uuid not null references unidades,
  fila_id             uuid not null references flujo_filas,
  concepto            text not null,
  proveedor_id        uuid references proveedores,
  -- Con signo: negativo = egreso, positivo = ingreso.
  importe             numeric(16,2) not null check (importe <> 0),
  fecha_inicio        date not null,
  recurrencia         text not null default 'UNICA' check (recurrencia in ('UNICA', 'SEMANAL', 'QUINCENAL', 'MENSUAL')),
  dia_mes             integer check (dia_mes between 1 and 31),
  hasta               date,
  cuotas              integer check (cuotas > 0),
  ajuste_pct_mensual  numeric(6,3) not null default 0,       -- ej. 2,5 = +2,5 % por mes
  estado              text not null default 'ACTIVA' check (estado in ('ACTIVA', 'PAUSADA', 'CANCELADA')),
  origen              text not null default 'MANUAL' check (origen in ('MANUAL', 'GASTO_FIJO', 'PLAN_PAGO', 'PRESTAMO', 'SUELDOS', 'COBRANZA')),
  nota                text,
  creado_por          text not null,
  creado_en           timestamptz not null default now(),
  cancelado_por       text,
  cancelado_en        timestamptz,
  check (recurrencia = 'UNICA' or hasta is not null or cuotas is not null),
  check (recurrencia <> 'MENSUAL' or dia_mes is not null)
);

create or replace function proyeccion_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from flujo_filas f join unidades u on u.id = f.unidad_id
                 where f.id = new.fila_id and f.unidad_id = new.unidad_id and u.empresa_id = new.empresa_id) then
    raise exception 'La fila no es de esa unidad o la unidad no es de esa empresa';
  end if;
  return new;
end $$;
create trigger trg_proyeccion_consistente before insert or update on proyecciones for each row execute function proyeccion_consistente();

-- Las fechas de una proyección entre dos días. Mensual: el día del mes (o el último si el mes es corto).
-- El ajuste mensual se compone desde el inicio. La fecha que cuenta para el Flujo es el día hábil siguiente.
create or replace function proyeccion_ocurrencias(p proyecciones, p_desde date, p_hasta date)
returns table (ocurrencia date, fecha date, importe numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_fin date; n integer := 0; d date; v_mes date;
begin
  v_fin := least(p_hasta, coalesce(p.hasta, p_hasta));
  if p.recurrencia = 'UNICA' then
    if p.fecha_inicio between p_desde and v_fin then
      return query select p.fecha_inicio, dia_habil_desde(p.fecha_inicio), p.importe;
    end if;
    return;
  end if;
  v_mes := date_trunc('month', p.fecha_inicio)::date;
  loop
    if p.recurrencia = 'MENSUAL' then
      d := least(v_mes + (p.dia_mes - 1), (v_mes + interval '1 month - 1 day')::date);
      v_mes := (v_mes + interval '1 month')::date;
      if d < p.fecha_inicio then continue; end if;
    elsif p.recurrencia = 'SEMANAL' then d := p.fecha_inicio + 7 * n;
    else d := p.fecha_inicio + 14 * n;
    end if;
    exit when d > v_fin or (p.cuotas is not null and n >= p.cuotas);
    if d >= p_desde then
      return query select d, dia_habil_desde(d),
        round(p.importe * power(1 + p.ajuste_pct_mensual / 100,
              (extract(year from age(d, p.fecha_inicio)) * 12 + extract(month from age(d, p.fecha_inicio)))::numeric), 2);
    end if;
    n := n + 1;
    exit when n > 400;
  end loop;
end $$;

-- ---------------------------------------------------------------- Ajustes a lo proyectado

-- Mover, cambiar el importe o eliminar UNA línea proyectada. Lo real no se toca.
--   FACTURA     ocurrencia 'ANTICIPO' o 'SALDO'   (mover el SALDO cambia facturas.fecha_pago, no se guarda acá)
--   CHEQUE      ocurrencia 'CHEQUE'
--   PROYECCION  ocurrencia = la fecha calculada (aaaa-mm-dd)
create table flujo_ajustes (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      text not null references empresas,
  origen_tipo     text not null check (origen_tipo in ('FACTURA', 'CHEQUE', 'PROYECCION')),
  origen_id       uuid not null,
  ocurrencia      text not null,
  fecha_nueva     date,
  importe_nuevo   numeric(16,2) check (importe_nuevo > 0),  -- en positivo; el signo lo pone la línea
  eliminada       boolean not null default false,
  motivo          text not null,
  creado_por      text not null,
  creado_en       timestamptz not null default now(),
  reemplazado_en  timestamptz,                              -- historial: el ajuste vigente es el que no tiene fecha
  check (eliminada or fecha_nueva is not null or importe_nuevo is not null)
);
create unique index flujo_ajustes_vigente on flujo_ajustes (origen_tipo, origen_id, ocurrencia) where reemplazado_en is null;

-- ---------------------------------------------------------------- Las líneas del Flujo (vista)

create view flujo_lineas with (security_invoker = true) as
with base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque)
  select p.empresa_id, coalesce(co.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, p.fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, p.cuenta_origen_id, null::text as categoria, false as vencido
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  union all
  -- REAL · cheques debitados
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros
  select cb.empresa_id, co.unidad_id, 'COBRO', cb.id, 'COBRO', cb.fecha, cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', cb.cuenta_origen_id, null, false
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  union all
  -- REAL · movimientos del banco que no son pago, cobro ni cheque (impuestos, gastos, FCI, intereses…)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.categoria not in ('PAGO', 'COBRO', 'CHEQUE_PAGADO')
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, 'FACTURA', f.id, t.ocurrencia, t.fecha, -t.importe, 'PROYECTADO',
         pr.nombre, f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0'),
         f.proveedor_id, f.cuenta_contable, null, null, false
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join lateral (
    select a.*, round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) as anticipo_total from (select 1) z
    cross join lateral (select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend) a
  ) q
  cross join lateral (values
    ('ANTICIPO', dia_habil_desde(greatest(f.fecha, current_date + 1)), q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  select b.empresa_id, d.unidad_id, d.fila_id, d.excluir, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto
  from base b
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- Control: caja del Flujo contra bancos

-- Por unidad y día con saldos completos (todas sus cuentas activas con saldo ese día): el cambio en los saldos
-- de los bancos tiene que ser igual a lo real que pasó entre el día anterior con saldos y este. Tolerancia $1.
create view flujo_control with (security_invoker = true) as
with cuentas as (
  select unidad_id, count(*) as n from cuentas_origen where activa and requiere_extracto group by unidad_id
), dias as (
  select co.unidad_id, s.fecha, sum(s.saldo) as saldo_bancos, count(*) as con_saldo
  from saldos_bancarios s join cuentas_origen co on co.id = s.cuenta_origen_id
  where co.activa and co.requiere_extracto
  group by co.unidad_id, s.fecha
), completos as (
  select d.*, c.n, d.con_saldo = c.n as completo,
         lag(d.fecha) over (partition by d.unidad_id order by d.fecha) as fecha_anterior,
         lag(d.saldo_bancos) over (partition by d.unidad_id order by d.fecha) as saldo_anterior
  from dias d join cuentas c on c.unidad_id = d.unidad_id
  where d.con_saldo = c.n
)
select u.empresa_id, k.unidad_id, u.nombre as unidad, k.fecha, k.fecha_anterior, k.saldo_anterior, k.saldo_bancos,
       r.movido as real_del_periodo,
       round(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0), 2) as diferencia,
       case when k.saldo_anterior is null then 'PRIMER_SALDO'
            when abs(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0)) <= 1 then 'OK'
            else 'F' end as estado
from completos k
join unidades u on u.id = k.unidad_id
left join lateral (
  select sum(l.importe) as movido from flujo_lineas l
  where l.unidad_id = k.unidad_id and l.naturaleza = 'REAL' and l.fecha > k.fecha_anterior and l.fecha <= k.fecha
) r on true;

-- ---------------------------------------------------------------- Acciones sobre el Flujo

-- Lo proyectado sigue proyectado: la factura no está pagada, el cheque no se debitó, la proyección está activa.
create or replace function linea_proyectada_de(p_tipo text, p_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_empresa text; v_ok boolean;
begin
  if p_tipo = 'FACTURA' then
    select empresa_id, estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and cuenta_origen_extracto_id is null into v_empresa, v_ok from facturas where id = p_id;
  elsif p_tipo = 'CHEQUE' then
    select empresa_id, estado in ('EMITIDO', 'ENTREGADO') into v_empresa, v_ok from cheques where id = p_id;
  elsif p_tipo = 'PROYECCION' then
    select empresa_id, estado = 'ACTIVA' into v_empresa, v_ok from proyecciones where id = p_id;
  else
    raise exception 'Lo real (pagos, débitos, cobros, movimientos) no se edita desde el Flujo';
  end if;
  if v_empresa is null then raise exception 'La línea no existe'; end if;
  if not v_ok then raise exception 'La línea ya no está proyectada (está pagada, debitada o cancelada)'; end if;
  perform exigir_empresa(v_empresa);
  return v_empresa;
end $$;

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
  if p_fecha is not null and p_fecha < current_date then raise exception 'No se proyecta en el pasado'; end if;

  -- Mover el saldo de una factura = cambiar su fecha de pago programada (la ven también Pagos y Vencimientos).
  if p_tipo = 'FACTURA' and p_ocurrencia = 'SALDO' and p_fecha is not null and not coalesce(p_eliminar, false) then
    update facturas set fecha_pago = p_fecha, actualizado_en = now() where id = p_id;
    p_fecha := null;
    if p_importe is null then
      perform registrar_auditoria(u, 'FLUJO_MOVER', 'FACTURA', p_id::text, 'Fecha de pago ' || to_char(current_date, 'DD/MM/YYYY') || ' · ' || p_motivo);
      return;
    end if;
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

-- Volver una línea a como la calcula el sistema.
create or replace function restaurar_linea_flujo(p_tipo text, p_id uuid, p_ocurrencia text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  perform linea_proyectada_de(p_tipo, p_id);
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = p_tipo and origen_id = p_id and ocurrencia = p_ocurrencia and reemplazado_en is null;
  perform registrar_auditoria(u, 'FLUJO_RESTAURAR', p_tipo, p_id::text, p_ocurrencia);
end $$;

-- Alta de una proyección (puntual o recurrente). p: columnas de proyecciones.
create or replace function crear_proyeccion(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_id uuid;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  perform exigir_empresa(p->>'empresa_id');
  insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, proveedor_id, importe, fecha_inicio, recurrencia, dia_mes,
                            hasta, cuotas, ajuste_pct_mensual, origen, nota, creado_por)
  values (p->>'empresa_id', (p->>'unidad_id')::uuid, (p->>'fila_id')::uuid, p->>'concepto', (p->>'proveedor_id')::uuid,
          round((p->>'importe')::numeric, 2), (p->>'fecha_inicio')::date, coalesce(p->>'recurrencia', 'UNICA'),
          (p->>'dia_mes')::integer, (p->>'hasta')::date, (p->>'cuotas')::integer, coalesce((p->>'ajuste_pct_mensual')::numeric, 0),
          coalesce(p->>'origen', 'MANUAL'), p->>'nota', u.email)
  returning id into v_id;
  perform registrar_auditoria(u, 'CREAR', 'PROYECCION', v_id::text, (p->>'concepto') || ' · ' || (p->>'importe'));
  return v_id;
end $$;

create or replace function cancelar_proyeccion(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_empresa text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  select empresa_id into v_empresa from proyecciones where id = p_id;
  if v_empresa is null then raise exception 'Proyección inexistente'; end if;
  perform exigir_empresa(v_empresa);
  update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
  where id = p_id;
  perform registrar_auditoria(u, 'CANCELAR', 'PROYECCION', p_id::text, p_motivo);
end $$;

-- Forma de pago de una factura: cuenta corriente, anticipado, o anticipo % + cuenta corriente.
create or replace function definir_pago_factura(p_id uuid, p_tipo_pago text, p_anticipo_pct numeric default null, p_unidad uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  perform exigir_empresa(f.empresa_id);
  if p_tipo_pago not in ('CUENTA_CORRIENTE', 'ANTICIPADO', 'ANTICIPO_PARCIAL') then raise exception 'Forma de pago inválida'; end if;
  if (p_tipo_pago = 'ANTICIPO_PARCIAL') <> (p_anticipo_pct is not null) then
    raise exception 'El porcentaje va solo con "Anticipo %% + Cta. Cte."';
  end if;
  if p_unidad is not null and not exists (select 1 from unidades where id = p_unidad and empresa_id = f.empresa_id) then
    raise exception 'La unidad es de otra empresa';
  end if;
  update facturas set tipo_pago = p_tipo_pago, anticipo_pct = p_anticipo_pct, unidad_id = coalesce(p_unidad, unidad_id), actualizado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'FORMA_PAGO', 'FACTURA', p_id::text, p_tipo_pago || coalesce(' ' || p_anticipo_pct || ' %', ''));
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table flujo_filas enable row level security;
alter table flujo_reglas enable row level security;
alter table proyecciones enable row level security;
alter table flujo_ajustes enable row level security;
create policy leer_flujo_filas on flujo_filas for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_flujo_reglas on flujo_reglas for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_proyecciones on proyecciones for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_flujo_ajustes on flujo_ajustes for select to authenticated using (empresa_id in (select empresas_visibles()));
create trigger trg_aislar_flujo_filas before insert or update or delete on flujo_filas for each row execute function aislar_por_empresa();
create trigger trg_aislar_proyecciones before insert or update or delete on proyecciones for each row execute function aislar_por_empresa();
create trigger trg_aislar_flujo_ajustes before insert or update or delete on flujo_ajustes for each row execute function aislar_por_empresa();

revoke all on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control from public, anon, authenticated;
grant select on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control to authenticated;
grant all on flujo_filas, flujo_reglas, proyecciones, flujo_ajustes, flujo_lineas, flujo_control to service_role;

revoke execute on function fila_consistente(), crear_filas_base(uuid), unidad_con_filas(), proyeccion_consistente(),
  linea_proyectada_de(text, uuid) from public, anon, authenticated;
grant execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text), fila_especial(uuid, text),
  proyeccion_ocurrencias(proyecciones, date, date),
  ajustar_linea_flujo(text, uuid, text, date, numeric, boolean, text), restaurar_linea_flujo(text, uuid, text),
  crear_proyeccion(jsonb), cancelar_proyeccion(uuid, text), definir_pago_factura(uuid, text, numeric, uuid)
  to authenticated;
