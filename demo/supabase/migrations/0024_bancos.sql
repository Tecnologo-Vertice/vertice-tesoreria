-- Tanda D2 · Bancos: extractos, reglas, saldos diarios, conciliación, comprobante de gastos y asientos.
--
-- Reemplaza las pestañas Extractos_Movimientos, Extractos_Reglas, Conciliacion_Diaria, Saldos Xubio Historial
-- y Bancos Movimientos. El circuito queda así:
--
--   1. Tesorería sube el archivo del banco. Netlify lo lee (cada banco tiene su formato) y llama a
--      importar_extracto(): guarda el archivo una sola vez (huella), los movimientos sin duplicar y el saldo
--      de cierre de cada día. Cada movimiento se clasifica con las reglas.
--   2. Lo que el banco cobra con factura (comisiones, IVA, percepciones, IIBB) se junta en un comprobante
--      "Extracto Bancario" por banco y día: generar_comprobante_gastos(). Se aprueba como una factura y ya
--      nace pagado (el banco lo debitó), así que no se proyecta como deuda.
--   3. Lo demás que va a Xubio sin comprobante (Ley 25413, rendimientos, FCI) va en un asiento por banco y
--      día: generar_asiento_bancario().
--   4. Un día sin movimientos se marca con marcar_sin_movimientos(): repite el saldo anterior. Una cuenta que
--      rinde todos los días (Mercado Pago, remunerada) pide confirmación explícita.
--   5. La conciliación es una vista: saldo anterior + movimientos = saldo calculado, contra el saldo del banco
--      y contra la última lectura de Xubio. En un FCI la diferencia es el rendimiento del día.

-- ---------------------------------------------------------------- Reglas de clasificación

create table reglas_extracto (
  id                  uuid primary key default gen_random_uuid(),
  organizacion_id     uuid not null references organizaciones,
  empresa_id          text references empresas,           -- null = todas las empresas de la organización
  cuenta_origen_id    uuid references cuentas_origen,     -- null = todos los bancos
  orden               integer not null,
  patrones            text[] not null check (cardinality(patrones) > 0),
  sentido             text not null default 'AMBOS' check (sentido in ('DEBITO', 'CREDITO', 'AMBOS')),
  categoria           text not null check (categoria in ('PAGO', 'COBRO', 'IMPUESTO', 'GASTO_BANCARIO', 'FCI',
                        'FCI_RENDIMIENTO', 'TRANSFERENCIA_PROPIA', 'CHEQUE_PAGADO', 'INTERESES', 'PRESTAMO', 'INFORMATIVO')),
  cuenta_contable     text,                               -- nombre de la cuenta de Xubio (como en facturas)
  -- Dónde termina en Xubio: dentro del comprobante "Extracto Bancario", en el asiento del día, o en nada
  -- (lo registra otro circuito: pagos, cobros, cheques).
  destino_xubio       text not null default 'NINGUNO' check (destino_xubio in ('COMPROBANTE', 'ASIENTO', 'NINGUNO')),
  -- Qué parte del comprobante es: neto gravado, IVA, percepción.
  componente          text check (componente in ('NETO', 'IVA', 'PERCEPCION_IVA', 'PERCEPCION_IIBB')),
  nota                text,
  activa              boolean not null default true,
  creada_por          text,
  creada_en           timestamptz not null default now(),
  check (destino_xubio <> 'COMPROBANTE' or componente is not null)
);
create index on reglas_extracto (organizacion_id, orden);
create trigger trg_organizacion_reglas_extracto before insert or update on reglas_extracto
  for each row execute function poner_organizacion();

-- Las reglas de Extractos_Reglas al 26/11/2026, con el destino que se decidió (19/11 y 20/11):
-- IIBB y percepciones van dentro del comprobante; Ley 25413 y rendimientos, al asiento.
insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota)
select o.id, r.orden, r.patrones, r.sentido, r.categoria, r.cuenta, r.destino, r.componente, r.nota
from organizaciones o cross join (values
  (5,  array['DBCR S DB TASA GRAL'], 'AMBOS', 'IMPUESTO', 'IMPUESTO DEB/CRED BANCARIO', 'ASIENTO', null, 'Aprendida 25/11/2026'),
  (10, array['LEY 25413','25.413','IMP. DEB','IMP DEB','IMP.DEB','IMP. CRED','IMP CRED','IMP.CRED','IMPUESTO DEB','IMPUESTO CRED','DEB/CRED','DB/CR','IDCB','LEY25413','IMP.LEY','IMP S/DEB','IMP S/CRED'],
       'AMBOS', 'IMPUESTO', 'IMPUESTO DEB/CRED BANCARIO', 'ASIENTO', null, 'Impuesto al cheque'),
  (15, array['IIBB TUCUMAN','IB TUCUMAN','PCIA TUCUMAN','FINAN-TUCUMAN','FINAN TUCUMAN','RENTAS TUCUMAN'],
       'AMBOS', 'IMPUESTO', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', 'COMPROBANTE', 'PERCEPCION_IIBB', 'Recaudación IIBB Tucumán (19/11: sin cuenta propia)'),
  (20, array['SIRCREB','IIBB','INGRESOS BRUTOS','ING. BRUTOS','ING BRUTOS','RET. IB','RETENCION IB'],
       'AMBOS', 'IMPUESTO', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', 'COMPROBANTE', 'PERCEPCION_IIBB', 'Retención IIBB bancaria'),
  (30, array['PERCEPCION IVA','PERC. IVA','PERC IVA','RG 2408','RG2408','PERCEP. IVA'],
       'AMBOS', 'IMPUESTO', 'PERCEPCIÓN IVA DE PROVEEDORES', 'COMPROBANTE', 'PERCEPCION_IVA', 'Percepción IVA'),
  (40, array['IVA','I.V.A','I V A'], 'DEBITO', 'IMPUESTO', 'IVA COMPRAS', 'COMPROBANTE', 'IVA', 'IVA sobre comisiones'),
  (50, array['COMISION','COM.','MANTENIMIENTO','MANT.','GASTO','CARGO','SEGURO','CHEQUERA','PAQUETE','SERVICIO DE CUENTA','ABONO'],
       'DEBITO', 'GASTO_BANCARIO', 'GASTOS BANCARIOS', 'COMPROBANTE', 'NETO', 'Gastos y comisiones'),
  (60, array['RENDIMIENTO','RENTA FCI','INTERES FCI','UTILIDAD FCI'], 'AMBOS', 'FCI_RENDIMIENTO', 'Rendimientos FCI', 'ASIENTO', null, 'Rendimiento del fondo'),
  (70, array['FCI','FONDO COMUN','FIMA','SUSCRIPCION','RESCATE','SUPER AHORRO','PIONEER','CUOTAPARTE'],
       'AMBOS', 'FCI', 'Fondos Comun de Inversion Bancos', 'ASIENTO', null, 'Suscripción / rescate de FCI'),
  (80, array['ECHEQ','E-CHEQ','CHEQUE','CH/','CH CAMARA','CH.CAMARA','CLEARING','CLEAR.','CAMARA','CANJE','CHQ'],
       'DEBITO', 'CHEQUE_PAGADO', null, 'NINGUNO', null, 'Cheque propio debitado')
) as r(orden, patrones, sentido, categoria, cuenta, destino, componente, nota)
where o.es_proveedor;

-- Texto comparable: mayúsculas, sin tildes, espacios simples.
create or replace function texto_banco(p text)
returns text language sql immutable as $$
  select regexp_replace(upper(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '\s+', ' ', 'g')
$$;

-- La primera regla que aplica, por orden. Lo más específico (empresa, banco) gana a igual orden.
create or replace function regla_para_movimiento(p_cuenta uuid, p_descripcion text, p_importe numeric)
returns reglas_extracto language sql stable security definer set search_path = public as $$
  select r.* from reglas_extracto r
  join cuentas_origen c on c.id = p_cuenta
  join empresas e on e.id = c.empresa_id
  where r.activa and r.organizacion_id = e.organizacion_id
    and (r.empresa_id is null or r.empresa_id = c.empresa_id)
    and (r.cuenta_origen_id is null or r.cuenta_origen_id = c.id)
    and (r.sentido = 'AMBOS' or (r.sentido = 'DEBITO' and p_importe < 0) or (r.sentido = 'CREDITO' and p_importe > 0))
    and exists (select 1 from unnest(r.patrones) x where position(texto_banco(x) in texto_banco(p_descripcion)) > 0)
  order by r.orden, (r.cuenta_origen_id is null), (r.empresa_id is null)
  limit 1
$$;

-- ---------------------------------------------------------------- Archivos de extracto

create table extractos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid not null references cuentas_origen,
  archivo_nombre    text not null,
  archivo_path      text,                               -- en el bucket privado
  archivo_hash      text not null,                      -- el mismo archivo no entra dos veces
  formato           text,                               -- HIPOTECARIO_CSV, BRUBANK_XLSX, FCI_TENENCIA…
  desde             date,
  hasta             date,
  movimientos       integer not null default 0,
  nuevos            integer not null default 0,
  importado_por     text not null,
  importado_en      timestamptz not null default now(),
  unique (cuenta_origen_id, archivo_hash)
);

-- ---------------------------------------------------------------- Movimientos

-- La clave de antes (cuenta, fecha, importe, referencia) dejaba afuera dos impuestos iguales del mismo
-- día. Ahora cada movimiento tiene su huella, que incluye su posición entre los iguales del día.
alter table movimientos_bancarios drop constraint if exists movimientos_bancarios_cuenta_origen_id_fecha_importe_referencia_key;
alter table movimientos_bancarios alter column cuenta_origen_id set not null;
alter table movimientos_bancarios add column huella text;
alter table movimientos_bancarios add column extracto_id uuid references extractos;
alter table movimientos_bancarios add column orden integer not null default 0;
alter table movimientos_bancarios add column numero_cheque text;
alter table movimientos_bancarios add column categoria text not null default 'SIN_CLASIFICAR'
  check (categoria in ('SIN_CLASIFICAR', 'PAGO', 'COBRO', 'IMPUESTO', 'GASTO_BANCARIO', 'FCI', 'FCI_RENDIMIENTO',
                       'TRANSFERENCIA_PROPIA', 'CHEQUE_PAGADO', 'INTERESES', 'PRESTAMO', 'INFORMATIVO'));
alter table movimientos_bancarios add column cuenta_contable text;
alter table movimientos_bancarios add column regla_id uuid references reglas_extracto on delete set null;
alter table movimientos_bancarios add column destino_xubio text not null default 'NINGUNO'
  check (destino_xubio in ('COMPROBANTE', 'ASIENTO', 'NINGUNO'));
alter table movimientos_bancarios add column componente text check (componente in ('NETO', 'IVA', 'PERCEPCION_IVA', 'PERCEPCION_IIBB'));
-- La otra cuenta propia de un FCI, una remunerada o una transferencia entre cuentas: la conciliación de
-- esa cuenta lo cuenta con el signo cambiado.
alter table movimientos_bancarios add column contraparte_cuenta_id uuid references cuentas_origen;
alter table movimientos_bancarios add column estado text not null default 'A_REVISAR'
  check (estado in ('A_REVISAR', 'PENDIENTE', 'CONTABILIZADO', 'CARGADO_A_MANO', 'INFORMATIVO', 'IGNORADO'));
alter table movimientos_bancarios add column factura_id uuid references facturas;   -- comprobante "Extracto Bancario"
alter table movimientos_bancarios add column revisado_por text;
alter table movimientos_bancarios add column revisado_en timestamptz;
update movimientos_bancarios set huella = 'LEGADO-' || id::text where huella is null;
alter table movimientos_bancarios alter column huella set not null;
alter table movimientos_bancarios add constraint movimientos_bancarios_cuenta_huella_key unique (cuenta_origen_id, huella);
create index on movimientos_bancarios (cuenta_origen_id, fecha);
create index on movimientos_bancarios (empresa_id, estado);

create or replace function movimiento_consistente()
returns trigger language plpgsql security definer set search_path = public as $$
declare c cuentas_origen;
begin
  select * into c from cuentas_origen where id = new.cuenta_origen_id;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  if new.empresa_id is distinct from c.empresa_id then raise exception 'El movimiento es de otra empresa que la cuenta'; end if;
  if new.contraparte_cuenta_id is not null then
    if new.contraparte_cuenta_id = new.cuenta_origen_id then raise exception 'La contraparte no puede ser la misma cuenta'; end if;
    if not exists (select 1 from cuentas_origen x where x.id = new.contraparte_cuenta_id and x.empresa_id = new.empresa_id) then
      raise exception 'La contraparte es de otra empresa (eso es intercompany, no entre cuentas propias)';
    end if;
  end if;
  -- Un movimiento ya contabilizado no cambia de importe, fecha ni cuenta.
  if tg_op = 'UPDATE' and old.estado in ('CONTABILIZADO', 'CARGADO_A_MANO')
     and (new.importe, new.fecha, new.cuenta_origen_id) is distinct from (old.importe, old.fecha, old.cuenta_origen_id) then
    raise exception 'El movimiento ya está contabilizado: no se cambia importe, fecha ni cuenta';
  end if;
  return new;
end $$;
create trigger trg_movimiento_consistente before insert or update on movimientos_bancarios
  for each row execute function movimiento_consistente();
create trigger trg_aislar_movimientos before insert or update or delete on movimientos_bancarios
  for each row execute function aislar_por_empresa();

-- ---------------------------------------------------------------- Saldos de cierre por día

create table saldos_bancarios (
  cuenta_origen_id  uuid not null references cuentas_origen,
  fecha             date not null,
  empresa_id        text not null references empresas,
  saldo             numeric(16,2) not null,
  -- EXTRACTO: lo dice el archivo · TENENCIA: informe del FCI · SIN_MOVIMIENTOS: se repitió el anterior
  -- · MANUAL: lo cargó una persona.
  origen            text not null check (origen in ('EXTRACTO', 'TENENCIA', 'SIN_MOVIMIENTOS', 'MANUAL')),
  extracto_id       uuid references extractos,
  cargado_por       text not null,
  cargado_en        timestamptz not null default now(),
  primary key (cuenta_origen_id, fecha)
);
create trigger trg_aislar_saldos before insert or update or delete on saldos_bancarios
  for each row execute function aislar_por_empresa();

-- Lecturas del saldo en Xubio (reporte Finanzas › Fondos). Se guardan todas: la conciliación usa la última del día.
create table lecturas_xubio (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid references cuentas_origen,      -- null si todavía no se sabe de qué cuenta es
  cuenta_xubio      text not null,
  fecha             date not null,
  saldo             numeric(16,2) not null,
  leido_de          text not null default 'Xubio · Finanzas › Fondos',
  leido_en          timestamptz not null default now(),
  leido_por         text not null
);
create index on lecturas_xubio (cuenta_origen_id, fecha, leido_en desc);
create trigger trg_aislar_lecturas_xubio before insert or update or delete on lecturas_xubio
  for each row execute function aislar_por_empresa();

-- ---------------------------------------------------------------- Asientos (lo que va a Xubio sin comprobante)

create table asientos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  cuenta_origen_id  uuid references cuentas_origen,
  fecha             date not null,
  tipo              text not null check (tipo in ('BANCARIO_DIARIO', 'TRANSFERENCIA_PROPIA', 'AJUSTE')),
  descripcion       text not null,
  estado_xubio      estado_xubio not null default 'PENDIENTE',
  xubio_id          text,
  xubio_error       text,
  envio_xubio_en    timestamptz,
  -- Lo que se anula en el sistema se anula también en Xubio (decisión del 25/11), sin paso manual.
  anulado_por       text,
  anulado_en        timestamptz,
  motivo_anulacion  text,
  anulacion_xubio   text check (anulacion_xubio in ('PENDIENTE', 'HECHA', 'ERROR')),
  creado_por        text not null,
  creado_en         timestamptz not null default now(),
  check ((anulado_en is null) = (anulacion_xubio is null))
);
create unique index asientos_uno_por_banco_y_dia on asientos (cuenta_origen_id, fecha)
  where tipo = 'BANCARIO_DIARIO' and anulado_en is null;

create table asiento_lineas (
  id              bigserial primary key,
  asiento_id      uuid not null references asientos on delete cascade,
  cuenta_contable text not null,
  debe            numeric(16,2) not null default 0 check (debe >= 0),
  haber           numeric(16,2) not null default 0 check (haber >= 0),
  detalle         text,
  check ((debe = 0) <> (haber = 0))
);

-- Debe = haber al terminar la transacción.
create or replace function asiento_balanceado()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.asiento_id, old.asiento_id); v_dif numeric;
begin
  select coalesce(sum(debe - haber), 0) into v_dif from asiento_lineas where asiento_id = v_id;
  if v_dif <> 0 then raise exception 'El asiento no balancea (debe - haber = %)', v_dif; end if;
  return null;
end $$;
create constraint trigger trg_asiento_balanceado after insert or update or delete on asiento_lineas
  deferrable initially deferred for each row execute function asiento_balanceado();

alter table movimientos_bancarios add column asiento_id uuid references asientos;
create trigger trg_aislar_asientos before insert or update or delete on asientos
  for each row execute function aislar_por_empresa();

-- Transferencias entre cuentas propias de la misma empresa (las dos patas).
create table transferencias_propias (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references empresas,
  fecha             date not null,
  importe           numeric(16,2) not null check (importe > 0),
  desde_cuenta_id   uuid not null references cuentas_origen,
  hacia_cuenta_id   uuid not null references cuentas_origen,
  mov_salida_id     uuid unique references movimientos_bancarios,
  mov_entrada_id    uuid unique references movimientos_bancarios,
  asiento_id        uuid references asientos,
  anulado_en        timestamptz,
  creado_por        text not null,
  creado_en         timestamptz not null default now(),
  check (desde_cuenta_id <> hacia_cuenta_id)
);
create trigger trg_aislar_transferencias before insert or update or delete on transferencias_propias
  for each row execute function aislar_por_empresa();

-- Pagos: la anulación también se replica en Xubio.
alter table pagos add column anulacion_xubio text check (anulacion_xubio in ('PENDIENTE', 'HECHA', 'ERROR'));
update pagos set anulacion_xubio = 'PENDIENTE' where estado = 'ANULADO' and xubio_id is not null;

-- ---------------------------------------------------------------- Comprobante "Extracto Bancario"

-- La factura que sale del extracto: el banco es el proveedor, nace pagada (ya la debitó).
alter table facturas add column cuenta_origen_extracto_id uuid references cuentas_origen;
create or replace function factura_de_extracto_pagada()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cuenta_origen_extracto_id is not null then
    new.pagado := new.total;
    if new.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') then new.estado := 'PAGADA'; end if;
  end if;
  return new;
end $$;
create trigger trg_factura_de_extracto_pagada before insert or update on facturas
  for each row execute function factura_de_extracto_pagada();

-- ---------------------------------------------------------------- Conciliación (vista)

-- Por cuenta y día con saldo o con movimientos. Saldo calculado = último saldo anterior + movimientos
-- desde ese día (exclusive) hasta este (inclusive). Tolerancia: $1.
create view conciliacion_bancaria with (security_invoker = true) as
with mov as (
  select cuenta_origen_id as cuenta_id, fecha, importe from movimientos_bancarios where estado <> 'IGNORADO'
  union all
  select contraparte_cuenta_id, fecha, -importe from movimientos_bancarios
  where contraparte_cuenta_id is not null and estado <> 'IGNORADO'
), dias as (
  select cuenta_origen_id as cuenta_id, fecha from saldos_bancarios
  union
  select cuenta_id, fecha from mov
), calc as (
  select d.cuenta_id, d.fecha, s.saldo as saldo_extracto, s.origen,
         ant.fecha as fecha_anterior, ant.saldo as saldo_anterior,
         coalesce(m.creditos, 0) as creditos, coalesce(m.debitos, 0) as debitos, coalesce(m.n, 0) as movimientos
  from dias d
  left join saldos_bancarios s on s.cuenta_origen_id = d.cuenta_id and s.fecha = d.fecha
  left join lateral (
    select a.fecha, a.saldo from saldos_bancarios a
    where a.cuenta_origen_id = d.cuenta_id and a.fecha < d.fecha order by a.fecha desc limit 1
  ) ant on true
  left join lateral (
    select sum(importe) filter (where importe > 0) as creditos, -sum(importe) filter (where importe < 0) as debitos, count(*) as n
    from mov x where x.cuenta_id = d.cuenta_id and x.fecha <= d.fecha and (ant.fecha is null or x.fecha > ant.fecha)
  ) m on true
)
select c.empresa_id, c.unidad_id, k.cuenta_id as cuenta_origen_id, c.nombre as cuenta, c.clase, k.fecha,
       k.fecha_anterior, k.saldo_anterior, k.creditos, k.debitos, k.movimientos,
       k.saldo_anterior + k.creditos - k.debitos as saldo_calculado,
       k.saldo_extracto, k.origen,
       round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2) as diferencia,
       -- En un FCI o una remunerada lo que no explican los movimientos es el rendimiento del día.
       case when c.clase in ('FCI', 'REMUNERADA') and k.saldo_anterior is not null and k.saldo_extracto is not null
            then round(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos), 2) end as rendimiento,
       x.saldo as saldo_xubio,
       round(k.saldo_extracto - x.saldo, 2) as diferencia_xubio,
       case
         when k.saldo_extracto is null then 'SIN_EXTRACTO'
         when k.origen = 'SIN_MOVIMIENTOS' then 'SIN_MOVIMIENTOS'
         when k.saldo_anterior is null then 'PRIMER_SALDO'
         when c.clase in ('FCI', 'REMUNERADA') then 'OK'
         when abs(k.saldo_extracto - (k.saldo_anterior + k.creditos - k.debitos)) <= 1 then 'OK'
         else 'DIFERENCIA'
       end as estado
from calc k
join cuentas_origen c on c.id = k.cuenta_id
left join lateral (
  select l.saldo from lecturas_xubio l where l.cuenta_origen_id = k.cuenta_id and l.fecha = k.fecha
  order by l.leido_en desc limit 1
) x on true;

-- ---------------------------------------------------------------- Funciones

-- Importa un extracto ya leído por Netlify. Solo el servidor.
-- p: { cuenta_origen_id, archivo: {nombre, path, hash, formato}, usuario,
--      movimientos: [{fecha, descripcion, referencia, importe, saldo, numero_cheque}],
--      saldos: [{fecha, saldo}]  ← cierre de cada día si el banco lo informa (si no, se toma el del último movimiento) }
create or replace function importar_extracto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; v_ext uuid; v_nuevos int := 0; v_total int := 0; m jsonb; r reglas_extracto;
  v_huella text; v_orden int; v_clave text; v_prev text := null; v_id uuid; v_usuario text := coalesce(p->>'usuario', 'servidor');
  v_desde date; v_hasta date;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if coalesce(p->'archivo'->>'hash', '') = '' then raise exception 'Falta la huella del archivo'; end if;

  select id into v_ext from extractos where cuenta_origen_id = c.id and archivo_hash = p->'archivo'->>'hash';
  if v_ext is not null then
    return jsonb_build_object('extracto_id', v_ext, 'repetido', true, 'nuevos', 0);
  end if;
  select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(p->'movimientos') x;
  insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_path, archivo_hash, formato, desde, hasta, importado_por)
  values (c.empresa_id, c.id, p->'archivo'->>'nombre', p->'archivo'->>'path', p->'archivo'->>'hash', p->'archivo'->>'formato',
          v_desde, v_hasta, v_usuario)
  returning id into v_ext;

  -- La huella: fecha|importe|descripción|referencia|n.º de orden entre los iguales. Así un archivo que se
  -- superpone con el anterior no duplica, y dos impuestos iguales del mismo día entran los dos.
  for m in select x from jsonb_array_elements(p->'movimientos') x
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
    if v_id is not null then v_nuevos := v_nuevos + 1; v_id := null; end if;
  end loop;

  -- Saldos de cierre: los que informa el archivo; si no, el saldo del último movimiento de cada día.
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, extracto_id, cargado_por)
  select c.id, d.fecha, c.empresa_id, d.saldo, 'EXTRACTO', v_ext, v_usuario
  from (
    select (x->>'fecha')::date as fecha, (x->>'saldo')::numeric as saldo from jsonb_array_elements(coalesce(p->'saldos', '[]')) x
    union all
    (select distinct on ((t.x->>'fecha')::date) (t.x->>'fecha')::date, (t.x->>'saldo')::numeric
     from jsonb_array_elements(p->'movimientos') with ordinality as t(x, n)
     where t.x->>'saldo' is not null and jsonb_array_length(coalesce(p->'saldos', '[]')) = 0
     order by (t.x->>'fecha')::date, t.n desc)
  ) d
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = 'EXTRACTO', extracto_id = excluded.extracto_id,
        cargado_por = excluded.cargado_por, cargado_en = now()
    where saldos_bancarios.origen <> 'MANUAL';

  update extractos set movimientos = v_total, nuevos = v_nuevos where id = v_ext;
  insert into auditoria (usuario, accion, entidad, entidad_id, detalle, empresa_id)
  values (v_usuario, 'IMPORTAR_EXTRACTO', 'EXTRACTO', v_ext::text, c.nombre || ': ' || v_nuevos || ' nuevos de ' || v_total, c.empresa_id);
  return jsonb_build_object('extracto_id', v_ext, 'repetido', false, 'movimientos', v_total, 'nuevos', v_nuevos);
end $$;

-- Tesorería corrige la clasificación de un movimiento. Con p_aprender, la próxima vez entra solo.
create or replace function reclasificar_movimiento(p_id uuid, p_categoria text, p_cuenta text, p_aprender_patron text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; mv movimientos_bancarios; r reglas_extracto;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into mv from movimientos_bancarios where id = p_id for update;
  if mv.id is null then raise exception 'Movimiento inexistente'; end if;
  perform exigir_empresa(mv.empresa_id);
  if mv.estado in ('CONTABILIZADO', 'CARGADO_A_MANO') then raise exception 'El movimiento ya está contabilizado'; end if;
  if p_aprender_patron is not null and trim(p_aprender_patron) <> '' then
    if position(texto_banco(p_aprender_patron) in texto_banco(mv.descripcion)) = 0 then
      raise exception 'El texto a aprender no está en la descripción del movimiento';
    end if;
    insert into reglas_extracto (empresa_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, nota, creada_por)
    values (mv.empresa_id, 5, array[texto_banco(p_aprender_patron)], case when mv.importe < 0 then 'DEBITO' else 'CREDITO' end,
            p_categoria, p_cuenta,
            case when p_categoria in ('IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES') then 'ASIENTO' else 'NINGUNO' end,
            'Aprendida de ' || u.email || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'), u.email)
    returning * into r;
  end if;
  update movimientos_bancarios set categoria = p_categoria, cuenta_contable = p_cuenta, regla_id = r.id,
    destino_xubio = coalesce(r.destino_xubio, case when p_categoria in ('IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES') then 'ASIENTO' else 'NINGUNO' end),
    estado = 'PENDIENTE', revisado_por = u.email, revisado_en = now()
  where id = p_id;
  perform registrar_auditoria(u, 'RECLASIFICAR', 'MOVIMIENTO', p_id::text, p_categoria || ' · ' || coalesce(p_cuenta, ''));
end $$;

-- Un día sin movimientos repite el saldo anterior. En una cuenta que rinde todos los días hay que confirmarlo.
create or replace function marcar_sin_movimientos(p_cuenta uuid, p_fecha date, p_confirmo_sin_rendimiento boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare u usuarios; c cuentas_origen; v_saldo numeric; v_desde date;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if c.rinde_diario and not p_confirmo_sin_rendimiento then
    raise exception '% rinde todos los días: subí el extracto o confirmá que no hubo rendimiento', c.nombre;
  end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and estado <> 'IGNORADO') then
    raise exception 'Ese día tiene movimientos: no se puede marcar sin movimientos';
  end if;
  if exists (select 1 from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and origen <> 'SIN_MOVIMIENTOS') then
    raise exception 'Ese día ya tiene saldo del banco';
  end if;
  select saldo, fecha into v_saldo, v_desde from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha < p_fecha
  order by fecha desc limit 1;
  if v_saldo is null then raise exception 'No hay un saldo anterior: cargá el saldo de % a mano', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha > v_desde and fecha < p_fecha and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos entre % y % sin saldo de cierre: subí ese extracto primero', v_desde, p_fecha;
  end if;
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
  values (p_cuenta, p_fecha, c.empresa_id, v_saldo, 'SIN_MOVIMIENTOS', u.email)
  on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, cargado_por = excluded.cargado_por, cargado_en = now();
  perform registrar_auditoria(u, 'SIN_MOVIMIENTOS', 'CUENTA', p_cuenta::text, c.nombre || ' ' || p_fecha || ' · saldo ' || v_saldo || ' (de ' || v_desde || ')');
  return v_saldo;
end $$;

-- Saldo cargado a mano o tenencia de un FCI (informe del fondo).
create or replace function registrar_saldo(p_cuenta uuid, p_fecha date, p_saldo numeric, p_origen text default 'TENENCIA')
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; c cuentas_origen;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if p_origen not in ('TENENCIA', 'MANUAL') then raise exception 'Origen inválido'; end if;
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
  values (p_cuenta, p_fecha, c.empresa_id, round(p_saldo, 2), p_origen, u.email)
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = excluded.origen, cargado_por = excluded.cargado_por, cargado_en = now();
  perform registrar_auditoria(u, 'SALDO_' || p_origen, 'CUENTA', p_cuenta::text, c.nombre || ' ' || p_fecha || ' · ' || p_saldo);
end $$;

-- Junta en un comprobante "Extracto Bancario" lo facturable del banco en el día. Número 09990-AAAAMMDD,
-- proveedor = el banco (por CUIT). Si ya existe y no subió a Xubio, lo actualiza; si ya subió, no lo toca.
create or replace function generar_comprobante_gastos(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; u usuarios; v_prov uuid; f facturas; v_neto numeric; v_iva numeric; v_perc numeric; v_perc_json jsonb;
  v_numero integer := to_char(p_fecha, 'YYYYMMDD')::integer; v_org uuid;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if not es_servidor() then u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if c.cuit_banco is null then raise exception 'Falta el CUIT del banco en la cuenta %', c.nombre; end if;

  select coalesce(sum(-importe) filter (where componente = 'NETO'), 0),
         coalesce(sum(-importe) filter (where componente = 'IVA'), 0),
         coalesce(sum(-importe) filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', componente, 'cuenta', cuenta_contable, 'importe', -importe, 'movimiento', id))
                  filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), '[]')
  into v_neto, v_iva, v_perc, v_perc_json
  from movimientos_bancarios
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';
  if v_neto + v_iva + v_perc = 0 then return null; end if;

  select organizacion_id into v_org from empresas where id = c.empresa_id;
  insert into proveedores (cuit, nombre, organizacion_id) values (c.cuit_banco, coalesce(c.banco, c.nombre), v_org)
  on conflict (organizacion_id, cuit) do nothing;
  select id into v_prov from proveedores where cuit = c.cuit_banco and organizacion_id = v_org;

  select * into f from facturas where empresa_id = c.empresa_id and proveedor_id = v_prov and tipo = 'Extracto Bancario'
    and punto_venta = 9990 and numero = v_numero for update;
  if f.id is not null and f.estado_xubio = 'SUBIDA' then
    raise exception 'El comprobante % ya está en Xubio: no se regenera', '09990-' || v_numero;
  end if;
  if f.id is null then
    insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, vencimiento, neto, iva, percepciones,
                          percepciones_json, total, origen, estado, validacion_ok, cuenta_contable, metodo_pago, cuenta_origen_extracto_id)
    values (c.empresa_id, v_prov, 'Extracto Bancario', 9990, v_numero, p_fecha, p_fecha, v_neto, v_iva, v_perc, v_perc_json,
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

-- Asiento del día por banco con lo que va a Xubio sin comprobante. Banco contra cada cuenta.
create or replace function generar_asiento_bancario(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; v_id uuid; v_cuenta_banco text; v_usuario text;
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
  if not exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') then
    return null;
  end if;
  if exists (select 1 from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
             and anulado_en is null and estado_xubio = 'SUBIDA') then
    raise exception 'El asiento de ese día ya está en Xubio: anulalo para rehacerlo';
  end if;
  delete from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null and estado_xubio <> 'SUBIDA';
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

-- Resultado del envío a Xubio de un asiento (servidor). Al subir, sus movimientos quedan contabilizados.
create or replace function resultado_asiento_xubio(p_id uuid, p_ok boolean, p_xubio_id text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update asientos set estado_xubio = case when p_ok then 'SUBIDA' else 'ERROR' end::estado_xubio,
    xubio_id = coalesce(p_xubio_id, xubio_id), xubio_error = case when p_ok then null else p_error end, envio_xubio_en = null
  where id = p_id;
  if p_ok then
    update movimientos_bancarios set estado = 'CONTABILIZADO' where asiento_id = p_id and estado in ('PENDIENTE', 'A_REVISAR');
  end if;
end $$;

-- Anular un asiento: se anula en el sistema y queda pendiente de anular en Xubio (lo hace el servidor solo).
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
  update asientos set anulado_por = u.email, anulado_en = now(), motivo_anulacion = p_motivo,
    anulacion_xubio = case when a.xubio_id is not null then 'PENDIENTE' else 'HECHA' end
  where id = p_id;
  update movimientos_bancarios set asiento_id = null, estado = 'PENDIENTE' where asiento_id = p_id;
  perform registrar_auditoria(u, 'ANULAR', 'ASIENTO', p_id::text, p_motivo);
end $$;

-- Lectura de saldo de Xubio (servidor o a mano).
create or replace function registrar_lectura_xubio(p_empresa text, p_cuenta_xubio text, p_fecha date, p_saldo numeric, p_usuario text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_cuenta uuid; v_id uuid; v_usuario text;
begin
  perform exigir_empresa(p_empresa);
  if es_servidor() then v_usuario := coalesce(p_usuario, 'servidor');
  else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN')).email; end if;
  select c.id into v_cuenta from cuentas_origen c
  left join cuentas_contables cc on cc.id = c.cuenta_contable_id
  where c.empresa_id = p_empresa and (texto_banco(cc.nombre) = texto_banco(p_cuenta_xubio) or texto_banco(c.nombre) = texto_banco(p_cuenta_xubio))
  limit 1;
  insert into lecturas_xubio (empresa_id, cuenta_origen_id, cuenta_xubio, fecha, saldo, leido_por)
  values (p_empresa, v_cuenta, p_cuenta_xubio, p_fecha, p_saldo, v_usuario) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- Seguridad

alter table reglas_extracto enable row level security;
alter table extractos enable row level security;
alter table saldos_bancarios enable row level security;
alter table lecturas_xubio enable row level security;
alter table asientos enable row level security;
alter table asiento_lineas enable row level security;
alter table transferencias_propias enable row level security;

create policy leer_reglas_extracto on reglas_extracto for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_extractos on extractos for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_saldos on saldos_bancarios for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_lecturas_xubio on lecturas_xubio for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_asientos on asientos for select to authenticated using (empresa_id in (select empresas_visibles()));
create policy leer_asiento_lineas on asiento_lineas for select to authenticated
  using (exists (select 1 from asientos a where a.id = asiento_id));
create policy leer_transferencias on transferencias_propias for select to authenticated using (empresa_id in (select empresas_visibles()));

revoke all on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria from public, anon, authenticated;
grant select on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria to authenticated;
grant all on reglas_extracto, extractos, saldos_bancarios, lecturas_xubio, asientos, asiento_lineas, transferencias_propias,
  conciliacion_bancaria to service_role;
grant usage, select on sequence asiento_lineas_id_seq to service_role;

revoke execute on function importar_extracto(jsonb), resultado_asiento_xubio(uuid, boolean, text, text),
  movimiento_consistente(), asiento_balanceado(), factura_de_extracto_pagada(),
  regla_para_movimiento(uuid, text, numeric) from public, anon, authenticated;
grant execute on function reclasificar_movimiento(uuid, text, text, text), marcar_sin_movimientos(uuid, date, boolean),
  registrar_saldo(uuid, date, numeric, text), generar_comprobante_gastos(uuid, date), generar_asiento_bancario(uuid, date),
  anular_asiento(uuid, text), registrar_lectura_xubio(text, text, date, numeric, text), texto_banco(text)
  to authenticated;
