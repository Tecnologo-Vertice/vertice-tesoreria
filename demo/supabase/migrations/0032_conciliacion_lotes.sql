-- T-209 · Conciliación en lote y pagos sin débito clasificados (después del simulacro del paralelo de noviembre).
--
-- No cambia migraciones anteriores: redefine lo que hace falta.
--
--   1. Débitos en lote. Un débito del banco puede pagar varios pagos de la hoja (prestadores, sueldos) y un pago
--      puede salir en varios débitos. 0030 vinculaba solo 1 a 1. Ahora, después del 1 a 1:
--        · 1 débito ↔ N pagos (movimientos_pagos): misma empresa, misma cuenta (si el pago la sabe), fecha del banco
--          en la ventana de 0030 (2 días antes a 5 después de la fecha del pago), suma EXACTA al centavo, de 2 a 12
--          pagos. Se busca primero entre los pagos del mismo día que el débito y, si no hay, en toda la ventana.
--        · N débitos ↔ 1 pago (movimientos_bancarios.pago_id en cada débito): débitos del mismo día y cuenta.
--        · Un pago con un débito propio por su importe exacto (aunque mal fechado) no entra en un lote, ni un débito
--          con un pago propio por su importe exacto se usa para armar otro pago: evita lotes por coincidencia.
--        · Si hay más de una combinación distinta (distinto conjunto de importes) o más de 14 candidatos, NO se
--          vincula: queda en conciliacion_revisar para que lo decida una persona.
--        · Importes iguales son intercambiables: entre dos pagos de $100 se toma el de fecha más vieja y, a igual
--          fecha, el de id menor. El mismo desempate fijo (fecha, luego id) reemplaza al de 0030 en el 1 a 1, que
--          entre dos movimientos iguales del mismo día dependía del orden físico de la tabla.
--   2. pagos_sin_debito dice por qué: POSIBLE_DUPLICADO (otro pago igual: proveedor, importe, ±5 días),
--      CUENTA_O_FECHA (hay un débito igual sin vincular en otra cuenta de la empresa o fuera de la ventana, hasta
--      45 días) o SIN_EXPLICACION.
--   3. El Flujo (flujo_lineas_entre de 0031) toma los vínculos en lote: el débito no entra y cada pago del lote
--      cuenta el día del débito, en la unidad de esa cuenta.

-- ---------------------------------------------------------------- Vínculos en lote

create table movimientos_pagos (
  movimiento_id  uuid not null references movimientos_bancarios on delete cascade,
  pago_id        uuid not null references pagos on delete cascade,
  importe        numeric(16,2) not null check (importe > 0),
  vinculado_en   timestamptz not null default now(),
  primary key (movimiento_id, pago_id),
  unique (pago_id)                       -- un pago va en un solo lote
);
create index on movimientos_pagos (movimiento_id);

-- Lo que no se vinculó porque había más de una forma (o demasiados candidatos): lo decide una persona.
create table conciliacion_revisar (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     text not null references empresas,
  tipo           text not null check (tipo in ('DEBITO_LOTE', 'PAGO_EN_VARIOS_DEBITOS')),
  movimiento_id  uuid references movimientos_bancarios on delete cascade,
  pago_id        uuid references pagos on delete cascade,
  motivo         text not null check (motivo in ('VARIAS_COMBINACIONES', 'DEMASIADOS_CANDIDATOS')),
  combinaciones  integer,
  candidatos     integer not null,
  importe        numeric(16,2) not null,
  detectado_en   timestamptz not null default now(),
  check ((tipo = 'DEBITO_LOTE') = (movimiento_id is not null))
);
create unique index conciliacion_revisar_mov on conciliacion_revisar (movimiento_id) where movimiento_id is not null;
create unique index conciliacion_revisar_pago on conciliacion_revisar (pago_id) where pago_id is not null and movimiento_id is null;

-- ¿Un movimiento o un pago ya tiene documento o débito?
create or replace function movimiento_vinculado(p_mov uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from movimientos_bancarios m where m.id = p_mov
                   and (m.pago_id is not null or m.cheque_id is not null or m.cobro_id is not null))
      or exists (select 1 from movimientos_pagos x where x.movimiento_id = p_mov)
$$;
create or replace function pago_vinculado(p_pago uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from movimientos_bancarios m where m.pago_id = p_pago)
      or exists (select 1 from movimientos_pagos x where x.pago_id = p_pago)
$$;

-- Subconjunto de p_imp (centavos, en el orden de desempate) que suma p_objetivo, de p_min a p_max elementos.
-- Devuelve {estado: UNICO | AMBIGUO | NINGUNO | DEMASIADOS, indices: [1-based], combinaciones}. Dos soluciones con
-- los mismos importes son la misma (los iguales son intercambiables): se toman los primeros índices de cada importe.
create or replace function subconjunto_unico(p_imp bigint[], p_objetivo bigint, p_min integer default 2, p_max integer default 12,
                                             p_tope integer default 14)
returns jsonb language plpgsql immutable as $$
declare
  n int := coalesce(array_length(p_imp, 1), 0); mask int; i int; s bigint; k int;
  firma text; primera text := null; distintas int := 0; elegido bigint[]; usados int[] := '{}'; idx int[] := '{}'; v bigint;
begin
  if n < p_min then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  if n > p_tope then return jsonb_build_object('estado', 'DEMASIADOS', 'combinaciones', null); end if;
  if (select sum(x) from unnest(p_imp) x) < p_objetivo then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  for mask in 1 .. (1 << n) - 1 loop
    s := 0; k := 0;
    for i in 1 .. n loop
      if (mask >> (i - 1)) & 1 = 1 then s := s + p_imp[i]; k := k + 1; exit when s > p_objetivo; end if;
    end loop;
    continue when s <> p_objetivo or k < p_min or k > p_max;
    select string_agg(x::text, ',' order by x) into firma
    from unnest(p_imp) with ordinality u(x, o) where (mask >> (o::int - 1)) & 1 = 1;
    if primera is null then primera := firma; distintas := 1;
    elsif firma <> primera and distintas = 1 then distintas := 2;   -- con dos alcanza: ya es ambiguo
    end if;
  end loop;
  if primera is null then return jsonb_build_object('estado', 'NINGUNO', 'combinaciones', 0); end if;
  if distintas > 1 then return jsonb_build_object('estado', 'AMBIGUO', 'combinaciones', distintas); end if;
  -- Los primeros índices (orden de desempate) de cada importe de la firma.
  elegido := string_to_array(primera, ',')::bigint[];
  foreach v in array elegido loop
    select min(o::int) into i from unnest(p_imp) with ordinality u(x, o) where x = v and not (o::int = any(usados));
    usados := usados || i; idx := idx || i;
  end loop;
  return jsonb_build_object('estado', 'UNICO', 'indices', to_jsonb((select array_agg(x order by x) from unnest(idx) x)), 'combinaciones', 1);
end $$;

-- Lotes de una empresa: 1 débito ↔ N pagos y N débitos ↔ 1 pago. Devuelve cuántos vinculó y cuántos dejó para revisar.
create or replace function conciliar_lotes(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m record; p record; cand record; ids uuid[]; imps bigint[]; res jsonb; etapa int; j int;
  n_lotes int := 0; n_pagos_lote int := 0; n_multi int := 0; n_rev int := 0; total_cand int;
begin
  delete from conciliacion_revisar where empresa_id = p_empresa;

  -- N débitos ↔ 1 pago (débitos del mismo día y cuenta). Va primero: un pago partido es más específico que un lote.
  for p in
    select q.id, q.cuenta_origen_id, q.fecha, (q.importe * 100)::bigint as objetivo, q.importe
    from pagos q
    where q.empresa_id = p_empresa and q.estado <> 'ANULADO' and q.importe > 0
      and q.medio not in ('CHEQUE', 'ECHEQ') and (q.medio <> 'CAJA' or q.cuenta_origen_id is not null)
      and not exists (select 1 from cheques_pagos cp where cp.pago_id = q.id)
      and not pago_vinculado(q.id)
    order by q.fecha, q.id
  loop
    for cand in
      select x.cuenta_origen_id, x.fecha
      from movimientos_bancarios x
      where x.empresa_id = p_empresa and x.importe < 0 and x.estado <> 'IGNORADO' and -x.importe < p.importe
        and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA')
        and (p.cuenta_origen_id is null or x.cuenta_origen_id = p.cuenta_origen_id)
        and x.fecha between p.fecha - 2 and p.fecha + 5 and not movimiento_vinculado(x.id)
      group by x.cuenta_origen_id, x.fecha
      having count(*) >= 2 and sum(-x.importe) >= p.importe
      order by abs(x.fecha - p.fecha), x.fecha, x.cuenta_origen_id
    loop
      select array_agg(x.id order by x.fecha, x.id), array_agg((-x.importe * 100)::bigint order by x.fecha, x.id), count(*)
        into ids, imps, total_cand
      from movimientos_bancarios x
      where x.empresa_id = p_empresa and x.cuenta_origen_id = cand.cuenta_origen_id and x.fecha = cand.fecha
        and x.importe < 0 and x.estado <> 'IGNORADO' and -x.importe < p.importe
        and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA') and not movimiento_vinculado(x.id)
        -- Un débito que tiene un pago propio por su importe exacto no se usa para armar otro pago.
        and not exists (select 1 from pagos o where o.empresa_id = p_empresa and o.importe = -x.importe and o.id <> p.id
                          and o.estado <> 'ANULADO' and abs(o.fecha - x.fecha) <= 45 and not pago_vinculado(o.id));
      res := subconjunto_unico(imps, p.objetivo);
      if res->>'estado' = 'UNICO' then
        for j in select (e)::int from jsonb_array_elements_text(res->'indices') e loop
          update movimientos_bancarios set pago_id = p.id where id = ids[j];
        end loop;
        n_multi := n_multi + 1;
        exit;
      elsif res->>'estado' = 'AMBIGUO' then
        insert into conciliacion_revisar (empresa_id, tipo, pago_id, motivo, combinaciones, candidatos, importe)
        values (p_empresa, 'PAGO_EN_VARIOS_DEBITOS', p.id, 'VARIAS_COMBINACIONES', 2, total_cand, p.importe)
        on conflict do nothing;
        n_rev := n_rev + 1;
        exit;
      end if;
    end loop;
  end loop;
  -- 1 débito ↔ N pagos.
  for m in
    select x.id, x.cuenta_origen_id, x.fecha, (-x.importe * 100)::bigint as objetivo, -x.importe as importe
    from movimientos_bancarios x
    where x.empresa_id = p_empresa and x.importe < 0 and x.estado <> 'IGNORADO'
      and x.categoria in ('SIN_CLASIFICAR', 'PAGO', 'TRANSFERENCIA_PROPIA')
      and not movimiento_vinculado(x.id)
    order by x.fecha, x.id
  loop
    for etapa in 1 .. 2 loop
      select array_agg(q.id order by q.fecha, q.id), array_agg((q.importe * 100)::bigint order by q.fecha, q.id), count(*)
        into ids, imps, total_cand
      from pagos q
      where q.empresa_id = p_empresa and q.estado <> 'ANULADO' and q.importe > 0 and q.importe < m.importe
        and q.medio not in ('CHEQUE', 'ECHEQ') and (q.medio <> 'CAJA' or q.cuenta_origen_id is not null)
        and (q.cuenta_origen_id is null or q.cuenta_origen_id = m.cuenta_origen_id)
        and m.fecha between q.fecha - 2 and q.fecha + 5
        and (etapa = 2 or q.fecha = m.fecha)
        and not exists (select 1 from cheques_pagos cp where cp.pago_id = q.id)
        and not pago_vinculado(q.id)
        -- Un pago que tiene un débito propio por su importe exacto (aunque esté fuera de la ventana o en otra
        -- cuenta) no entra en un lote: es un pago mal fechado, no parte de un débito en lote.
        and not exists (select 1 from movimientos_bancarios o where o.empresa_id = p_empresa and o.importe = -q.importe
                          and o.estado <> 'IGNORADO' and abs(o.fecha - q.fecha) <= 45 and not movimiento_vinculado(o.id));
      res := subconjunto_unico(imps, m.objetivo);
      if res->>'estado' = 'UNICO' then
        for j in select (e)::int from jsonb_array_elements_text(res->'indices') e loop
          insert into movimientos_pagos (movimiento_id, pago_id, importe)
          select m.id, ids[j], q.importe from pagos q where q.id = ids[j];
          n_pagos_lote := n_pagos_lote + 1;
        end loop;
        n_lotes := n_lotes + 1;
        exit;
      elsif res->>'estado' in ('AMBIGUO', 'DEMASIADOS') then
        insert into conciliacion_revisar (empresa_id, tipo, movimiento_id, motivo, combinaciones, candidatos, importe)
        values (p_empresa, 'DEBITO_LOTE', m.id, case res->>'estado' when 'AMBIGUO' then 'VARIAS_COMBINACIONES' else 'DEMASIADOS_CANDIDATOS' end,
                (res->>'combinaciones')::int, total_cand, m.importe)
        on conflict do nothing;
        n_rev := n_rev + 1;
        exit;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('lotes', n_lotes, 'pagos_en_lotes', n_pagos_lote, 'pagos_en_varios_debitos', n_multi, 'revisar', n_rev);
end $$;

-- ---------------------------------------------------------------- Conciliación (1 a 1 de 0030 + lotes, desempate fijo)

create or replace function conciliar_movimientos(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n_pag int := 0; n_che int := 0; n_cob int := 0; n_fci int := 0;
begin
  -- FCI / remunerada: la contraparte es el único fondo de la cuenta madre (si el fondo no trae ya su propia pata).
  update movimientos_bancarios m set contraparte_cuenta_id = h.id
  from cuentas_origen h
  where m.empresa_id = p_empresa and m.categoria in ('FCI', 'TRANSFERENCIA_PROPIA') and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO'
    and h.cuenta_madre_id = m.cuenta_origen_id and h.activa and h.clase in ('FCI', 'REMUNERADA')
    and (select count(*) from cuentas_origen h2 where h2.cuenta_madre_id = m.cuenta_origen_id and h2.activa and h2.clase in ('FCI', 'REMUNERADA')) = 1
    and not exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = h.id and o.fecha = m.fecha and o.importe = -m.importe);
  get diagnostics n_fci = row_count;

  -- Cheques debitados.
  for r in
    select m.id as mid, ch.id as cid
    from movimientos_bancarios m
    join cheques ch on ch.cuenta_origen_id = m.cuenta_origen_id and ch.importe = -m.importe and ch.estado = 'DEBITADO'
                   and ch.movimiento_id is null and m.fecha between ch.debitado_en - 3 and ch.debitado_en + 3
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by (m.numero_cheque is not null and right(regexp_replace(m.numero_cheque, '\D', '', 'g'), 4) = right(regexp_replace(ch.numero, '\D', '', 'g'), 4)) desc,
             abs(m.fecha - ch.debitado_en), m.fecha, m.id, ch.debitado_en, ch.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cheque_id is null)
       and exists (select 1 from cheques where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cheque_id = r.cid where id = r.mid;
      update cheques set movimiento_id = r.mid where id = r.cid;
      n_che := n_che + 1;
    end if;
  end loop;

  -- Pagos (no cheques ni efectivo: el cheque cuenta cuando se debita; el efectivo no pasa por el banco).
  for r in
    select m.id as mid, p.id as pid
    from movimientos_bancarios m
    join pagos p on p.empresa_id = m.empresa_id and p.importe = -m.importe and p.estado <> 'ANULADO'
                and p.medio not in ('CHEQUE', 'ECHEQ')
                and (p.medio <> 'CAJA' or p.cuenta_origen_id is not null)   -- "Caja" con cuenta de banco: salió por el banco
                and (p.cuenta_origen_id is null or p.cuenta_origen_id = m.cuenta_origen_id)
                and m.fecha between p.fecha - 2 and p.fecha + 5
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not pago_vinculado(p.id)
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by abs(m.fecha - p.fecha), (p.cuenta_origen_id is not null) desc, m.fecha, m.id, p.fecha, p.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and pago_id is null and cheque_id is null)
       and not pago_vinculado(r.pid) then
      update movimientos_bancarios set pago_id = r.pid where id = r.mid;
      n_pag := n_pag + 1;
    end if;
  end loop;

  -- Cobros.
  for r in
    select m.id as mid, c.id as cid
    from movimientos_bancarios m
    join cobros c on c.empresa_id = m.empresa_id and c.importe = m.importe and c.movimiento_id is null
                 and (c.cuenta_origen_id is null or c.cuenta_origen_id = m.cuenta_origen_id)
                 and m.fecha between c.fecha - 3 and c.fecha + 3
    where m.empresa_id = p_empresa and m.importe > 0 and m.estado <> 'IGNORADO'
      and m.cobro_id is null and m.pago_id is null and m.cheque_id is null
      and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    order by abs(m.fecha - c.fecha), m.fecha, m.id, c.fecha, c.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cobro_id is null)
       and exists (select 1 from cobros where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cobro_id = r.cid where id = r.mid;
      update cobros set movimiento_id = r.mid where id = r.cid;
      n_cob := n_cob + 1;
    end if;
  end loop;
  -- Después del 1 a 1: lotes (1 débito ↔ N pagos, N débitos ↔ 1 pago).
  return jsonb_build_object('pagos', n_pag, 'cheques', n_che, 'cobros', n_cob, 'fci', n_fci) || conciliar_lotes(p_empresa);
end $$;

-- Un pago anulado suelta su débito (1 a 1 o en lote): el débito vuelve a contar solo hasta que se vincule otro documento.
create or replace function soltar_movimiento_de_anulado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'ANULADO' and old.estado is distinct from 'ANULADO' then
    update movimientos_bancarios set pago_id = null where pago_id = new.id;
    delete from movimientos_pagos where movimiento_id in (select movimiento_id from movimientos_pagos where pago_id = new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- Pagos sin débito, con su motivo

-- Mismas columnas que 0030 y dos al final: motivo y el débito parecido (para revisar).
create or replace view pagos_sin_debito with (security_invoker = true) as
with base as (
  select p.id, p.empresa_id, p.fecha, p.importe, p.proveedor_destino, p.estado, p.cuenta_origen_id, co.nombre as cuenta,
         p.sheets_fila_origen, p.hoja_id,
         exists (select 1 from pagos d where d.id <> p.id and d.empresa_id = p.empresa_id and d.importe = p.importe
                   and d.estado <> 'ANULADO' and abs(d.fecha - p.fecha) <= 5
                   and texto_comparable(coalesce(d.proveedor_destino, '')) = texto_comparable(coalesce(p.proveedor_destino, ''))) as posible_duplicado
  from pagos p join cuentas_origen co on co.id = p.cuenta_origen_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ') and co.requiere_extracto
    and not pago_vinculado(p.id)
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    and extracto_cubre(co.id, p.fecha + 5)
)
select b.*,
       case when b.posible_duplicado then 'POSIBLE_DUPLICADO'
            when d.id is not null then 'CUENTA_O_FECHA'
            else 'SIN_EXPLICACION' end as motivo,
       d.id as debito_parecido_id
from base b
left join lateral (
  -- Un débito igual sin vincular en otra cuenta de la empresa, o en la misma fuera de la ventana (hasta 45 días).
  select m.id from movimientos_bancarios m
  where m.empresa_id = b.empresa_id and m.importe = -b.importe and m.estado <> 'IGNORADO'
    and abs(m.fecha - b.fecha) <= 45 and not movimiento_vinculado(m.id)
    and (m.cuenta_origen_id <> b.cuenta_origen_id or m.fecha not between b.fecha - 2 and b.fecha + 5)
  order by abs(m.fecha - b.fecha), m.fecha, m.id limit 1
) d on true;

-- ---------------------------------------------------------------- El Flujo toma los lotes

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
  -- (0032) también los pagos de un débito en lote.
  select distinct on (v.pago_id) v.pago_id, v.fecha, v.cuenta_origen_id
  from (select m.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_bancarios m where m.pago_id is not null
        union all
        select x.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_pagos x join movimientos_bancarios m on m.id = x.movimiento_id) v
  order by v.pago_id, v.fecha, v.id
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
    and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
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

-- ---------------------------------------------------------------- Lo que ya estaba cargado: conciliar una vez

select conciliar_movimientos(id) from empresas;

-- ---------------------------------------------------------------- Seguridad

alter table movimientos_pagos enable row level security;
alter table conciliacion_revisar enable row level security;
create policy leer_movimientos_pagos on movimientos_pagos for select to authenticated
  using (exists (select 1 from movimientos_bancarios m where m.id = movimiento_id));
create policy leer_conciliacion_revisar on conciliacion_revisar for select to authenticated
  using (empresa_id in (select empresas_visibles()));
revoke all on movimientos_pagos, conciliacion_revisar, pagos_sin_debito from public, anon, authenticated;
grant select on movimientos_pagos, conciliacion_revisar, pagos_sin_debito to authenticated;
grant all on movimientos_pagos, conciliacion_revisar, pagos_sin_debito to service_role;
revoke execute on function conciliar_lotes(text), conciliar_movimientos(text), soltar_movimiento_de_anulado() from public, anon, authenticated;
grant execute on function conciliar_lotes(text), conciliar_movimientos(text) to service_role;
revoke execute on function movimiento_vinculado(uuid), pago_vinculado(uuid), subconjunto_unico(bigint[], bigint, integer, integer, integer) from public, anon;
grant execute on function movimiento_vinculado(uuid), pago_vinculado(uuid), subconjunto_unico(bigint[], bigint, integer, integer, integer) to authenticated, service_role;
revoke execute on function flujo_lineas_entre(date, date, uuid, boolean) from public, anon;
grant execute on function flujo_lineas_entre(date, date, uuid, boolean) to authenticated, service_role;
