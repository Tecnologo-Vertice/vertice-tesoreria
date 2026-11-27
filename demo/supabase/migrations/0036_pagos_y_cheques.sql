-- Pagos del día a día y cheques completos, copiando lo que hace el Apps Script (27/11/2026).
--
-- Tanda 1 · Pagos
--   1. Vincular un pago sin factura a su factura: al aprobar la factura (solo si hay un único pago de ese
--      proveedor) y a mano. La factura baja por lo pagado (PagoFactura.js: vincularPagoSinFC). También se corrige
--      el proveedor de un pago que todavía no está en Xubio (corregirProveedorPagoSinFC).
--   2. Adjuntar o quitar el comprobante de un pago ya cargado (adjuntarComprobantePago / quitarComprobantePagoAdjunto).
--      Acá hay un solo comprobante por pago (el del almacenamiento): adjuntar reemplaza el que había.
--   3. Tarjeta de crédito: al aprobar, la factura pasa directo a PAGADA con la fecha de hoy (Code.js: aprobarFacturaFlujo).
--   4. Proveedor que "no va a Xubio" (proveedores_empresa.saltar_xubio): al aprobar queda en SIN_ERP y no se sube.
--   5. "Ya pagada, falta comprobante": el pago que Administración registra al aprobar queda marcado hasta que
--      Tesorería adjunta el comprobante (PagoAlAprobar.js: completarPagoYaPagado).
--      Para que los pagos que se cargan acá cuenten como "sin factura", registrar_pago marca tipo_pago = 'SIN_FACTURA' cuando
--      el pago es a un proveedor y no trae facturas (antes solo lo hacía la hoja o la forma "orden de pago"). Así entran en
--      anticipos_sin_factura (el Flujo los descuenta de lo proyectado, como en el Apps Script) y en la lista de espera.
--   6. Posible duplicado al cargar el pago: mismo importe, misma empresa y mismo destino a ±3 días (o el mismo
--      número de cheque). Es un aviso para revisar, no bloquea (ParchePagos.js: marcarPosiblesDuplicadosPagos_).
-- Tanda 2 · Cheques
--   7. Un pago con medio cheque o e-cheq crea (o vincula) su fila en `cheques` (CashFlowCheques.js).
--   8. Acreedor por núcleo: sin SA, SRL, SAS…; "uno contiene al otro"; entre alias iguales, el más usado.
--   9. Movimiento del extracto de un cheque sin número: se sugiere el cheque por importe con $1 de tolerancia
--      ("puede ser el cheque X"). Marcar debitado sigue siendo a mano (decisión del 26/11): solo se sugiere.
--
-- Las funciones se redefinen desde la última versión que las define: aprobar_factura (0005), aprobar_factura_ya_pagada
-- (0011), registrar_pago (0019) y acreedor_para (0025). Las pruebas que ya existen no cambian.

-- ---------------------------------------------------------------- Columnas nuevas

alter table pagos add column if not exists posible_duplicado text;       -- otros pagos parecidos, para revisar
alter table pagos add column if not exists aviso_cheque text;            -- qué pasó con su fila en Cheques
alter table pagos add column if not exists falta_comprobante boolean not null default false;

-- Los pagos que ya creó aprobar_factura_ya_pagada sin comprobante. No cuentan los de caja ni los de tarjeta (se pagan con el
-- resumen de la tarjeta, como en el Apps Script) ni los que gobierna la hoja.
update pagos set falta_comprobante = true
where descripcion ilike '%pagada antes de aprobar' and comprobante_path is null and comprobante_url is null
  and gestion = 'SISTEMA' and estado::text <> 'ANULADO' and medio::text not in ('CAJA', 'TARJETA') and coalesce(lower(cuenta_origen), '') <> 'caja';

-- ---------------------------------------------------------------- 8. Acreedor por núcleo

-- Nombre "de fondo": sin tildes ni palabras que cambian de un lado a otro (S.A., SRL, Laboratorios, Droguería…).
-- Las letras sueltas seguidas se juntan: S.A.C.I.F.I.A. → sacifia (se descarta); D&R → dr (queda).
create or replace function nucleo_acreedor(p text)
returns text[] language plpgsql immutable as $$
declare
  partes text[]; w text; txts text[] := '{}'; sueltas boolean[] := '{}'; n integer; res text[];
  genericas text[] := array['sa', 'srl', 'sas', 'sau', 'sh', 'saic', 'sacif', 'sacifia', 'sacifi', 'cia', 'compania', 'de', 'del', 'la', 'las', 'los', 'el', 'y',
    'seguros', 'laboratorio', 'laboratorios', 'lab', 'drogueria', 'droguerias', 'group', 'argentina', 'arg', 'hnos', 'inc', 'ltda'];
begin
  partes := string_to_array(trim(regexp_replace(lower(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunaeiouun')), '[^a-z0-9]+', ' ', 'g')), ' ');
  foreach w in array partes loop
    if w = '' then continue; end if;
    n := coalesce(array_length(txts, 1), 0);
    if length(w) = 1 and n > 0 and sueltas[n] then
      txts[n] := txts[n] || w;
    else
      txts := txts || w;
      sueltas := sueltas || (length(w) = 1);
    end if;
  end loop;
  select coalesce(array_agg(t order by o), '{}') into res
  from unnest(txts) with ordinality as x(t, o)
  where length(t) > 1 and not (t = any(genericas));
  return res;
end $$;

-- Distancia de edición acotada: 0, 1 o 2 (2 = "dos o más"). Para un error de tipeo en nombres largos.
create or replace function distancia_hasta_1(a text, b text)
returns integer language plpgsql immutable as $$
declare i integer := 1; j integer := 1; dif integer := 0;
begin
  if a = b then return 0; end if;
  if abs(length(a) - length(b)) > 1 then return 2; end if;
  while i <= length(a) and j <= length(b) loop
    if substr(a, i, 1) = substr(b, j, 1) then i := i + 1; j := j + 1; continue; end if;
    dif := dif + 1;
    if dif > 1 then return 2; end if;
    if length(a) > length(b) then i := i + 1;
    elsif length(b) > length(a) then j := j + 1;
    else i := i + 1; j := j + 1; end if;
  end loop;
  return dif + (length(a) - i + 1) + (length(b) - j + 1);
end $$;

-- Entre varios acreedores empatados, el que Tesorería más usó (más cheques). Si hay uno solo, ese; si el
-- más usado empata con otro, no se decide (null): Tesorería lo elige.
create or replace function acreedor_mas_usado(p_ids uuid[])
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_n integer := coalesce(array_length(p_ids, 1), 0); r record; v_primero integer; v_segundo integer;
begin
  if v_n = 0 then return null; end if;
  if v_n = 1 then return p_ids[1]; end if;
  select x.id, x.usos into r from (
    select a.id, (select count(*) from cheques c where c.acreedor_id = a.id)::integer as usos
    from acreedores a where a.id = any(p_ids)) x order by x.usos desc, x.id limit 1;
  v_primero := r.usos;
  select max(x.usos) into v_segundo from (
    select (select count(*) from cheques c where c.acreedor_id = a.id)::integer as usos
    from acreedores a where a.id = any(p_ids) and a.id <> r.id) x;
  if v_primero > coalesce(v_segundo, -1) then return r.id; end if;
  return null;
end $$;

-- El acreedor de un beneficiario, en este orden (el primero que da resultado):
--   1. por proveedor, por nombre exacto o por alias;
--   2. igual "de fondo" (sin SA, SRL, Laboratorios…), o con un error de tipeo en nombres largos;
--   3. todas las palabras del nombre más corto están en el otro (si empatan dos proveedores distintos, no decide);
--   4. uno contiene al otro (nombres de 6 letras o más; gana el más largo).
-- En cada paso, si hay varios acreedores, gana el más usado. Sin adivinar: si no hay uno solo, devuelve null
-- y Tesorería lo elige (queda guardado como alias).
create or replace function acreedor_para(p_org uuid, p_proveedor uuid, p_texto text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_norm text := texto_banco(p_texto);
  v_nuc text[] := nucleo_acreedor(p_texto);
  v_junto text := array_to_string(nucleo_acreedor(p_texto), '');
  v_ids uuid[];
  v_n integer;
begin
  -- 1. Proveedor, nombre exacto o alias.
  select array_agg(distinct a.id) into v_ids from acreedores a
  where a.organizacion_id = p_org and a.activo
    and ((p_proveedor is not null and a.proveedor_id = p_proveedor)
         or (coalesce(v_norm, '') <> '' and (texto_banco(a.nombre) = v_norm
             or exists (select 1 from unnest(a.alias) x where texto_banco(x) = v_norm))));
  if v_ids is not null then return acreedor_mas_usado(v_ids); end if;
  if coalesce(v_norm, '') = '' then return null; end if;

  -- 2. Igual de fondo (con un error de tipeo en nombres largos).
  if length(v_junto) >= 3 then
    select array_agg(distinct x.id) into v_ids from (
      select a.id, array_to_string(nucleo_acreedor(nm), '') as junto
      from acreedores a cross join lateral unnest(array[a.nombre] || a.alias) as nm
      where a.organizacion_id = p_org and a.activo) x
    where x.junto <> '' and ((x.junto = v_junto and length(v_junto) >= 3)
                             or (length(v_junto) >= 8 and distancia_hasta_1(x.junto, v_junto) <= 1));
    if v_ids is not null then return acreedor_mas_usado(v_ids); end if;
  end if;

  -- 3. Todas las palabras del más corto están en el otro; gana el que sobra menos. Si empatan dos nombres de fondo distintos, no se decide.
  if cardinality(v_nuc) > 0 then
    with n as (
      select a.id, nucleo_acreedor(nm) as nuc
      from acreedores a cross join lateral unnest(array[a.nombre] || a.alias) as nm
      where a.organizacion_id = p_org and a.activo),
    m as (
      select id, array_to_string(nuc, '') as junto, abs(cardinality(nuc) - cardinality(v_nuc)) as extra
      from n
      where cardinality(nuc) > 0
        and case when cardinality(v_nuc) <= cardinality(nuc)
                 then v_nuc <@ nuc and length(v_junto) >= 5
                 else nuc <@ v_nuc and length(array_to_string(nuc, '')) >= 5 end)
    select array_agg(distinct id), count(distinct junto) into v_ids, v_n from m where extra = (select min(extra) from m);
    if v_ids is not null and v_n = 1 then return acreedor_mas_usado(v_ids); end if;
  end if;

  -- 4. Uno contiene al otro (nombres largos): gana el más largo.
  if length(v_norm) >= 6 then
    select array_agg(distinct x.id) into v_ids from (
      select a.id, texto_banco(nm) as t, max(length(texto_banco(nm))) over () as mayor
      from acreedores a cross join lateral unnest(array[a.nombre] || a.alias) as nm
      where a.organizacion_id = p_org and a.activo
        and length(texto_banco(nm)) >= 6
        and (position(texto_banco(nm) in v_norm) > 0 or position(v_norm in texto_banco(nm)) > 0)) x
    where length(x.t) = x.mayor;
    if v_ids is not null then return acreedor_mas_usado(v_ids); end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- Pagos sin factura (los que esperan su factura)

-- La misma condición de anticipos_sin_factura (0028), pero fila por pago y sin exigir proveedor: así también
-- aparecen los que hay que corregir.
create or replace view pagos_sin_factura with (security_invoker = true) as
select p.id as pago_id, p.empresa_id, p.proveedor_id, p.fecha, p.importe, p.medio::text as medio, p.numero_cheque,
       p.estado::text as estado, p.gestion, p.cargado_por, p.cargado_en,
       greatest(0, hoy_ar() - (p.cargado_en at time zone 'America/Argentina/Buenos_Aires')::date) as dias_espera
from pagos p
where p.estado::text <> 'ANULADO' and p.importe > 0
  and coalesce(trim(p.factura_asociada), '') = ''
  and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
  and (upper(coalesce(p.tipo_pago, '')) = 'SIN_FACTURA' or p.forma_carga_xubio = 'ORDEN_PAGO');

-- ---------------------------------------------------------------- 6. Posible duplicado

-- Otros pagos de la misma empresa que parecen el mismo: si los dos tienen N° de cheque, el mismo número y el
-- mismo importe; si no, mismo importe (menos de $1), fechas a ±3 días y mismo destino (o alguno sin destino).
-- Los pagos del mismo comprobante son un solo lote y no se marcan. Devuelve null si no hay ninguno.
create or replace function posible_duplicado_pago(p_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare a pagos; v_txt text; v_na text;
begin
  select * into a from pagos where id = p_id;
  if a.id is null then return null; end if;
  -- El destino: el proveedor, o el texto que trae el pago (los de la hoja). "Sin destino" es vacío o S/D.
  v_na := texto_comparable(coalesce((select nombre from proveedores where id = a.proveedor_id), a.proveedor_destino));
  select string_agg(t.txt, ' | ') into v_txt from (
    select to_char(b.fecha, 'DD/MM/YYYY') || ' · ' || coalesce(pr.nombre, nullif(b.proveedor_destino, ''), 'sin destino') || ' · $ ' || b.importe::text
           || ' · ' || case b.estado::text when 'CARGADO' then 'Para contabilizar' when 'CONTABILIZADO' then 'Contabilizado' else b.estado::text end as txt
    from pagos b left join proveedores pr on pr.id = b.proveedor_id
    where b.id <> a.id and b.empresa_id = a.empresa_id and b.estado::text <> 'ANULADO' and b.importe > 0
      and not (coalesce(a.comprobante_path, '') <> '' and a.comprobante_path = b.comprobante_path)
      and case
            when coalesce(trim(a.numero_cheque), '') <> '' and coalesce(trim(b.numero_cheque), '') <> ''
              then trim(a.numero_cheque) = trim(b.numero_cheque) and abs(a.importe - b.importe) < 1
            else abs(a.importe - b.importe) < 1 and abs(a.fecha - b.fecha) <= 3
                 and (v_na in ('', 'sd') or texto_comparable(coalesce(pr.nombre, b.proveedor_destino)) in ('', 'sd')
                      or v_na = texto_comparable(coalesce(pr.nombre, b.proveedor_destino))
                      or (a.proveedor_id is not null and a.proveedor_id = b.proveedor_id))
          end
    order by b.fecha desc, b.id limit 3) t;
  return v_txt;
end $$;

-- ---------------------------------------------------------------- 7. Un pago con cheque crea (o vincula) su fila en Cheques

-- Devuelve el aviso para la pantalla (null si el pago no es con cheque). Si algo falla no rompe el pago: queda el aviso.
-- Mismas reglas que CashFlowCheques.js: necesita N° y fecha de cobro; no duplica un cheque (misma chequera y número);
-- un cheque para varias facturas es una sola fila.
create or replace function crear_cheque_de_pago(p_pago uuid, p_usuario usuarios)
returns text language plpgsql security definer set search_path = public as $$
declare
  pg pagos; v_num text; v_tipo text; v_org uuid; v_benef text; v_acr uuid; v_id uuid; ch cheques; v_ya numeric; v_prov text;
begin
  select * into pg from pagos where id = p_pago;
  if pg.id is null or pg.estado::text = 'ANULADO' or pg.medio::text not in ('CHEQUE', 'ECHEQ') then return null; end if;
  v_num := nullif(trim(coalesce(pg.numero_cheque, '')), '');
  if v_num is null then return null; end if;
  if pg.fecha_acreditacion is null then
    return 'Cheque ' || v_num || ': falta la fecha de cobro, todavía no se cargó en Cheques.';
  end if;
  if pg.cuenta_origen_id is null then
    return 'Cheque ' || v_num || ': no se reconoce la cuenta de origen como una chequera, cargalo en Cheques.';
  end if;
  v_tipo := case when upper(coalesce(pg.tipo_cheque, '')) in ('ECHEQ', 'FISICO', 'PAGARE') then upper(pg.tipo_cheque)
                 when pg.medio::text = 'ECHEQ' then 'ECHEQ' else 'FISICO' end;
  begin
    -- ¿Ya está ese cheque en esa chequera? (sin ceros a la izquierda; los anulados y rechazados no cuentan)
    select * into ch from cheques c
    where c.cuenta_origen_id = pg.cuenta_origen_id and ltrim(c.numero, '0') = ltrim(v_num, '0')
      and c.estado not in ('ANULADO', 'RECHAZADO')
    order by c.creado_en limit 1;
    if ch.id is null and exists (select 1 from cheques c where c.cuenta_origen_id = pg.cuenta_origen_id and c.tipo = v_tipo and ltrim(c.numero, '0') = ltrim(v_num, '0')) then
      return 'Cheque ' || v_num || ': ese número figura anulado o rechazado en Cheques para esa chequera, por eso no se cargó solo. Revisá que el número esté bien y cargalo desde Cheques.';
    end if;
    if ch.id is not null then
      select coalesce(sum(importe), 0) into v_ya from cheques_pagos where cheque_id = ch.id and pago_id <> pg.id;
      if exists (select 1 from cheques_pagos where cheque_id = ch.id and pago_id = pg.id) then
        return 'Cheque ' || v_num || ': ya estaba en Cheques, no se duplicó.';
      end if;
      if v_ya + pg.importe <= ch.importe + 0.005 then
        insert into cheques_pagos (cheque_id, pago_id, importe) values (ch.id, pg.id, pg.importe);
        perform registrar_auditoria(p_usuario, 'CHEQUE_VINCULADO_A_PAGO', 'CHEQUE', ch.id::text, v_num || ' · pago ' || pg.id);
        return 'Cheque ' || v_num || ': ya estaba en Cheques, no se duplicó; quedó vinculado a este pago.';
      end if;
      return 'Cheque ' || v_num || ': ya estaba en Cheques por $ ' || ch.importe || ' y no alcanza para este pago ($ ' || pg.importe || '). Revisalo en Cheques.';
    end if;

    select e.organizacion_id into v_org from empresas e where e.id = pg.empresa_id;
    select nombre into v_prov from proveedores where id = pg.proveedor_id;
    v_benef := coalesce(nullif(trim(v_prov), ''), nullif(trim(pg.proveedor_destino), ''), nullif(left(trim(coalesce(pg.descripcion, '')), 80), ''), 'Sin beneficiario');
    v_acr := acreedor_para(v_org, pg.proveedor_id, v_benef);
    insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, proveedor_id, beneficiario, importe,
                         fecha_emision, fecha_pago, origen, observaciones, creado_por)
    values (pg.empresa_id, pg.cuenta_origen_id, v_tipo, v_num, v_acr, pg.proveedor_id, v_benef, pg.importe,
            least(pg.fecha, pg.fecha_acreditacion), pg.fecha_acreditacion, 'PAGO', 'Cargado desde el pago ' || pg.id, p_usuario.email)
    returning id into v_id;
    insert into cheques_pagos (cheque_id, pago_id, importe) values (v_id, pg.id, pg.importe);
    perform registrar_auditoria(p_usuario, 'CHEQUE_DE_PAGO', 'CHEQUE', v_id::text, v_tipo || ' ' || v_num || ' · ' || pg.importe);
    return 'Cheque ' || v_num || ': se cargó en Cheques.' || case when v_acr is null then ' Revisá el acreedor: no coincide con ninguno.' else '' end;
  exception
    when unique_violation then
      return 'Cheque ' || v_num || ': ese número ya está usado en Cheques para esa chequera, por eso no se cargó solo. Revisá que el número esté bien y cargalo desde Cheques.';
    when others then
      return 'Cheque ' || v_num || ': no se pudo cargar en Cheques (' || sqlerrm || '). Cargalo a mano desde Cheques.';
  end;
end $$;

-- ---------------------------------------------------------------- 6 y 7. registrar_pago (0019) con duplicado y cheque

create or replace function registrar_pago(p_datos jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; e empresas; v_id uuid; v_importe numeric; v_restante numeric; v_fid uuid;
  f facturas; v_pendiente numeric; v_aplica numeric; v_completas integer := 0;
  v_prov uuid; v_medio metodo_pago; v_n_facturas integer;
begin
  u := exigir_rol('TESORERIA', 'ADMIN', 'ADMINISTRACION');
  select * into e from empresas where id = p_datos ->> 'empresa_id';
  if e.id is null then raise exception 'Empresa inexistente'; end if;
  v_importe := round((p_datos ->> 'importe')::numeric, 2);
  if v_importe is null or v_importe <= 0 then raise exception 'El importe debe ser mayor a cero'; end if;
  v_prov := nullif(p_datos ->> 'proveedor_id', '')::uuid;
  v_medio := (p_datos ->> 'medio')::metodo_pago;
  if v_medio in ('CHEQUE', 'ECHEQ') and (coalesce(p_datos ->> 'numero_cheque', '') = '' or coalesce(p_datos ->> 'fecha_acreditacion', '') = '') then
    raise exception 'Un pago con cheque necesita número y fecha de vencimiento del cheque';
  end if;
  v_n_facturas := jsonb_array_length(coalesce(p_datos -> 'factura_ids', '[]'::jsonb));

  -- Validar todas las facturas antes de escribir nada.
  v_pendiente := 0;
  for f in select * from facturas where id in (select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb))) loop
    if f.empresa_id <> e.id then raise exception 'La factura % es de otra empresa', f.numero; end if;
    if f.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then raise exception 'La factura % no está para pagar (estado %)', f.numero, f.estado; end if;
    if v_prov is not null and f.proveedor_id <> v_prov then raise exception 'La factura % es de otro proveedor', f.numero; end if;
    v_pendiente := v_pendiente + (f.total - f.pagado);
  end loop;
  if v_n_facturas > 0 and v_importe > v_pendiente + 1 then
    raise exception 'El pago (%) supera lo pendiente de las facturas vinculadas (%). Cargá el excedente como un pago aparte.', v_importe, v_pendiente;
  end if;

  insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque,
                     fecha_acreditacion, descripcion, observaciones, cuenta_contable, sugerencia_origen, sugerencia_confianza,
                     forma_carga_xubio, estado, comprobante_path, cargado_por, tipo_cheque, tipo_pago)
  values (e.id, v_prov, (p_datos ->> 'fecha')::date, v_importe,
          v_medio, p_datos ->> 'cuenta_origen', p_datos ->> 'banco_destino', p_datos ->> 'numero_cheque',
          (p_datos ->> 'fecha_acreditacion')::date, p_datos ->> 'descripcion', p_datos ->> 'observaciones', p_datos ->> 'cuenta_contable',
          p_datos ->> 'sugerencia_origen', (p_datos ->> 'sugerencia_confianza')::numeric,
          coalesce((p_datos ->> 'forma_carga_xubio')::forma_carga_xubio, 'SALIDA_FONDOS'),
          (case when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
          p_datos ->> 'comprobante_path', u.nombre, nullif(upper(p_datos ->> 'tipo_cheque'), ''),
          -- Un pago a un proveedor sin facturas vinculadas espera su factura (ESPERA_FC del Apps Script): queda marcado así.
          -- Los pagos sin proveedor (banco, impuestos) no esperan nada.
          case when v_n_facturas = 0 and v_prov is not null then 'SIN_FACTURA' end)
  returning id into v_id;

  -- El comprobante tiene que estar en la carpeta de esta empresa (0019). Va después de crear el pago para
  -- que quien no ve la empresa reciba el rechazo de siempre y no se entere de nada de la ruta.
  perform exigir_ruta_de_empresa(p_datos ->> 'comprobante_path', e.id);

  -- Aplicar el pago a las facturas vinculadas, en el orden recibido, hasta agotar el importe.
  v_restante := v_importe;
  for v_fid in select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb)) loop
    select * into f from facturas where id = v_fid for update;
    if f.id is null then raise exception 'Factura % inexistente', v_fid; end if;
    v_pendiente := f.total - f.pagado;
    v_aplica := least(v_pendiente, v_restante);
    if v_aplica <= 0 then continue; end if;
    v_restante := v_restante - v_aplica;
    insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fid, v_aplica);
    update facturas set pagado = pagado + v_aplica,
                        estado = case when pagado + v_aplica >= total then 'PAGADA' else 'PAGADA_PARCIAL' end::estado_factura,
                        actualizado_en = now()
    where id = v_fid;
    if f.pagado + v_aplica >= f.total then v_completas := v_completas + 1; end if;
  end loop;

  perform registrar_auditoria(u, 'PAGO_CARGADO', 'PAGO', v_id::text,
    v_medio || ' · ' || coalesce(p_datos ->> 'cuenta_origen', '') || ' · ' || v_n_facturas || ' factura(s)');
  if v_completas > 0 then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sistema', 'ADMIN', 'MAIL_PENDIENTE', 'PAGO', v_id::text, 'Mail al proveedor pendiente de envío: ' || v_completas || ' factura(s) canceladas');
  end if;

  -- 6. Aviso de posible duplicado (no bloquea) y 7. la fila del cheque.
  update pagos set posible_duplicado = posible_duplicado_pago(v_id), aviso_cheque = crear_cheque_de_pago(v_id, u) where id = v_id;
  if (select posible_duplicado from pagos where id = v_id) is not null then
    perform registrar_auditoria(u, 'POSIBLE_DUPLICADO', 'PAGO', v_id::text, (select posible_duplicado from pagos where id = v_id));
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- 3 y 4. Aprobar: tarjeta directa a pagada y "no va a Xubio"

-- Es la aprobación de 0005 con dos agregados. p_tarjeta_directa = false la deja como antes para el pago de una
-- factura que se aprueba ya pagada (ahí el pago se crea aparte). Devuelve cómo quedó.
create or replace function aprobar_factura_interna(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer, p_tarjeta_directa boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas; v_saltar boolean; v_tarjeta boolean;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');   -- Dirección ve todo pero no modifica
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado <> 'PENDIENTE_APROBACION' then raise exception 'La factura no está pendiente de aprobación'; end if;
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  select * into e from empresas where id = f.empresa_id;
  select coalesce(bool_or(pe.saltar_xubio), false) into v_saltar from proveedores_empresa pe
  where pe.proveedor_id = f.proveedor_id and pe.empresa_id = f.empresa_id;
  -- Tarjeta de crédito: se paga con el resumen de la tarjeta, así que nace pagada (una nota de crédito no).
  v_tarjeta := p_tarjeta_directa and p_metodo = 'TARJETA' and f.tipo not ilike 'nota de cr%';
  update facturas set
    estado = (case when v_tarjeta then 'PAGADA' else 'PARA_PAGAR' end)::estado_factura,
    pagado = case when v_tarjeta then total else pagado end,
    fecha_pago = case when v_tarjeta then hoy_ar() else fecha_pago end,
    cuenta_contable = p_cuenta, metodo_pago = p_metodo, dias_cheque = p_dias,
    aprobado_por = u.nombre, aprobado_en = now(), actualizado_en = now(),
    estado_xubio = (case when e.erp = 'XUBIO'
                         then (case when estado_xubio = 'SUBIDA' then 'SUBIDA' when v_saltar then 'SIN_ERP' else 'PENDIENTE' end)
                         else 'PENDIENTE_RALPHARMA' end)::estado_xubio
  where id = p_id;
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, veces, actualizado_por)
  values (f.proveedor_id, f.empresa_id, p_cuenta, p_metodo, 1, u.nombre)
  on conflict (proveedor_id, empresa_id) do update set
    cuenta_contable = excluded.cuenta_contable, metodo_pago = excluded.metodo_pago,
    veces = proveedores_empresa.veces + 1, actualizado_por = excluded.actualizado_por, actualizado_en = now();
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text,
    'Cuenta ' || p_cuenta || ' · ' || p_metodo
    || case when v_tarjeta then ' · tarjeta de crédito: queda pagada' else '' end
    || case when v_saltar and e.erp = 'XUBIO' then ' · el proveedor no va a Xubio' else '' end);
  return jsonb_build_object(
    'estado', (select estado from facturas where id = p_id),
    'estado_xubio', (select estado_xubio from facturas where id = p_id),
    'tarjeta', v_tarjeta);
end $$;

create or replace function aprobar_factura(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform aprobar_factura_interna(p_id, p_cuenta, p_metodo, p_dias, true);
end $$;

-- ---------------------------------------------------------------- 1. Vincular un pago sin factura a su factura

-- Lo que hace vincularPagoSinFC: la factura baja por lo pagado (hasta su saldo) sin crear otro pago, y el pago
-- pasa a ser el pago de esa factura. Si ya estaba en Xubio no se vuelve a cargar. Si el pago supera el saldo, se avisa.
create or replace function vincular_pago_interno(p_pago uuid, p_factura uuid, p_usuario usuarios)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pg pagos; f facturas; v_saldo numeric; v_monto numeric; v_sobra numeric; v_nombre text; v_pct numeric; v_numero text;
begin
  select * into pg from pagos where id = p_pago for update;
  select * into f from facturas where id = p_factura for update;
  if pg.id is null then raise exception 'Pago inexistente'; end if;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  perform exigir_empresa(pg.empresa_id);
  if pg.estado::text = 'ANULADO' then raise exception 'El pago está anulado'; end if;
  if pg.gestion = 'HOJA' then raise exception 'Este pago viene de la hoja del Apps Script: se vincula ahí'; end if;
  if exists (select 1 from pagos_facturas where pago_id = pg.id) or coalesce(trim(pg.factura_asociada), '') <> '' then
    raise exception 'Ese pago ya no está esperando factura';
  end if;
  if not (pg.importe > 0) then raise exception 'El pago no tiene monto'; end if;
  if f.empresa_id <> pg.empresa_id then raise exception 'La factura es de otra empresa'; end if;
  if pg.proveedor_id is not null and f.proveedor_id <> pg.proveedor_id then raise exception 'La factura es de otro proveedor'; end if;
  if f.tipo ilike 'nota de cr%' then raise exception 'Es una nota de crédito: no se le vincula un pago'; end if;
  if f.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then
    raise exception 'La factura tiene que estar aprobada (en Para pagar) para vincularle el pago';
  end if;
  v_saldo := round(f.total - f.pagado, 2);
  if not (v_saldo > 0.009) then raise exception 'La factura ya está pagada'; end if;
  v_monto := least(pg.importe, v_saldo);
  v_sobra := round(pg.importe - v_saldo, 2);
  v_numero := lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0');
  select nombre into v_nombre from proveedores where id = f.proveedor_id;
  v_pct := case when f.total > 0 then round(least(100, v_monto / f.total * 100), 2) else 100 end;

  insert into pagos_facturas (pago_id, factura_id, importe) values (pg.id, f.id, v_monto);
  update facturas set pagado = pagado + v_monto,
    estado = (case when pagado + v_monto >= total then 'PAGADA' else 'PAGADA_PARCIAL' end)::estado_factura,
    actualizado_en = now()
  where id = f.id;
  update pagos set
    tipo_pago = 'FACTURA', factura_asociada = v_numero, proveedor_id = coalesce(proveedor_id, f.proveedor_id), proveedor_destino = v_nombre,
    descripcion = 'Pago ' || v_pct || '% Factura ' || v_numero || ' (pago sin FC del ' || to_char(fecha, 'DD/MM/YYYY') || ', vinculado)',
    forma_carga_xubio = 'ORDEN_PAGO', cuenta_contable = coalesce(nullif(f.cuenta_contable, ''), cuenta_contable),
    observaciones = coalesce(nullif(observaciones, '') || ' · ', '') || 'Vinculado a la FC ' || v_numero || ' por ' || p_usuario.nombre
                    || case when v_sobra >= 1 then '. El pago supera el saldo de la factura en $ ' || v_sobra else '' end
  where id = pg.id;
  perform registrar_auditoria(p_usuario, 'PAGO_VINCULADO', 'PAGO', pg.id::text,
    'Vinculado a la factura ' || v_numero || ' por $ ' || v_monto || case when v_sobra >= 1 then ' (sobran $ ' || v_sobra || ')' else '' end);
  perform registrar_auditoria(p_usuario, 'PAGO_VINCULADO', 'FACTURA', f.id::text, 'Pago sin factura vinculado por $ ' || v_monto);
  if f.pagado + v_monto >= f.total then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sistema', 'ADMIN', 'MAIL_PENDIENTE', 'PAGO', pg.id::text, 'Mail al proveedor pendiente de envío: 1 factura(s) canceladas');
  end if;
  return jsonb_build_object('factura', f.id, 'numero', v_numero, 'monto', v_monto, 'sobra', greatest(v_sobra, 0),
                            'completa', f.pagado + v_monto >= f.total, 'ya_en_xubio', pg.estado::text in ('CONTABILIZADO', 'CONCILIADO'));
end $$;

create or replace function vincular_pago_sin_factura(p_pago uuid, p_factura uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  return vincular_pago_interno(p_pago, p_factura, u);
end $$;

-- Aprobar y vincular solo: si queda en Para pagar y hay UN solo pago sin factura de ese proveedor y esa empresa, se
-- vincula solo; si hay más de uno, queda el aviso para vincularlo a mano. Devuelve cómo quedó la factura y un mensaje.
create or replace function aprobar_factura_y_vincular(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; r jsonb; f facturas; v_ids uuid[]; v_n integer; v jsonb; v_msg text;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  r := aprobar_factura_interna(p_id, p_cuenta, p_metodo, p_dias, true);
  select * into f from facturas where id = p_id;
  if f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.tipo not ilike 'nota de cr%' then
    select array_agg(s.pago_id order by s.fecha, s.pago_id) into v_ids from pagos_sin_factura s
    where s.empresa_id = f.empresa_id and s.proveedor_id = f.proveedor_id;
    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n > 1 then
      v_msg := 'Hay ' || v_n || ' pagos sin factura de este proveedor: vinculá el que corresponda desde la factura en Para pagar.';
    elsif v_n = 1 then
      begin
        v := vincular_pago_interno(v_ids[1], p_id, u);
        v_msg := 'Se vinculó sola con el pago sin factura de este proveedor.'
                 || case when (v ->> 'sobra')::numeric >= 1 then ' Ojo: el pago es $ ' || (v ->> 'sobra') || ' mayor que el saldo de la factura.' else '' end;
        r := r || jsonb_build_object('vinculado', true, 'pago', v_ids[1]);
      exception when others then
        v_msg := 'Hay un pago sin factura de este proveedor pero no se pudo vincular solo (' || sqlerrm || '): vinculalo desde Para pagar.';
      end;
    end if;
  end if;
  return r || jsonb_build_object('mensaje', v_msg);
end $$;

-- ---------------------------------------------------------------- 1. Corregir el proveedor de un pago sin factura

create or replace function corregir_proveedor_pago(p_pago uuid, p_proveedor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; pg pagos; v_nombre text; v_antes text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Ese pago ya no existe'; end if;
  perform exigir_empresa(pg.empresa_id);
  select nombre into v_nombre from proveedores where id = p_proveedor;
  if v_nombre is null then raise exception 'Indicá el proveedor'; end if;
  if pg.estado::text = 'ANULADO' then raise exception 'El pago está anulado'; end if;
  if pg.gestion = 'HOJA' then raise exception 'Este pago viene de la hoja del Apps Script: se corrige ahí'; end if;
  if exists (select 1 from pagos_facturas where pago_id = pg.id) then raise exception 'Ese pago ya está vinculado a una factura'; end if;
  if pg.estado::text not in ('CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA') or pg.envio_xubio_en is not null then
    raise exception 'Este pago ya está registrado en Xubio. Si quedó con otro proveedor, primero hay que anular esa orden de pago en Xubio.';
  end if;
  select nombre into v_antes from proveedores where id = pg.proveedor_id;
  update pagos set proveedor_id = p_proveedor, proveedor_destino = v_nombre where id = p_pago;   -- el control de organización lo hace el disparador
  perform registrar_auditoria(u, 'PAGO_PROVEEDOR_CORREGIDO', 'PAGO', p_pago::text, coalesce(v_antes, pg.proveedor_destino, 'sin proveedor') || ' → ' || v_nombre);
end $$;

-- ---------------------------------------------------------------- 2 y 5. Adjuntar o quitar el comprobante de un pago

-- p_cuenta_origen: para el pago "ya pagado" que Administración cargó sin banco (hay que completarlo con el comprobante).
create or replace function adjuntar_comprobante_pago(p_pago uuid, p_ruta text, p_cuenta_origen text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; pg pagos; v_ruta text := nullif(trim(coalesce(p_ruta, '')), ''); v_cuenta text := nullif(trim(coalesce(p_cuenta_origen, '')), '');
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Ese pago ya no existe'; end if;
  perform exigir_empresa(pg.empresa_id);
  if v_ruta is null then raise exception 'Adjuntá el comprobante del pago'; end if;
  if pg.estado::text = 'ANULADO' then raise exception 'El pago está anulado'; end if;
  perform exigir_ruta_de_empresa(v_ruta, pg.empresa_id);
  if pg.falta_comprobante and coalesce(trim(pg.cuenta_origen), '') = '' and v_cuenta is null then
    raise exception 'Completá el banco desde el que se pagó';
  end if;
  update pagos set comprobante_path = v_ruta, falta_comprobante = false,
    cuenta_origen = case when coalesce(trim(cuenta_origen), '') = '' and v_cuenta is not null then v_cuenta else cuenta_origen end
  where id = p_pago;
  perform registrar_auditoria(u, 'COMPROBANTE_ADJUNTADO', 'PAGO', p_pago::text,
    case when pg.comprobante_path is not null then 'Reemplaza a ' || pg.comprobante_path else 'Comprobante agregado' end
    || case when v_cuenta is not null and coalesce(trim(pg.cuenta_origen), '') = '' then ' · banco ' || v_cuenta else '' end);
end $$;

create or replace function quitar_comprobante_pago(p_pago uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; pg pagos;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Ese pago ya no existe'; end if;
  perform exigir_empresa(pg.empresa_id);
  if pg.estado::text = 'ANULADO' then raise exception 'El pago está anulado'; end if;
  if pg.comprobante_path is null then return; end if;   -- ya no tiene: no hay nada que hacer (se puede repetir sin problema)
  -- Sin comprobante, un pago bancario vuelve a la lista "falta comprobante" (caja y tarjeta no tienen comprobante bancario).
  update pagos set comprobante_path = null,
    falta_comprobante = (medio::text not in ('CAJA', 'TARJETA') and coalesce(lower(cuenta_origen), '') <> 'caja' and comprobante_url is null)
  where id = p_pago;
  perform registrar_auditoria(u, 'COMPROBANTE_QUITADO', 'PAGO', p_pago::text, 'Se quitó ' || pg.comprobante_path);
end $$;

-- ---------------------------------------------------------------- 5. Aprobar una factura ya pagada (0011)

-- Igual que 0011 con tres cambios: la aprobación no la paga sola la tarjeta (acá el pago se crea aparte), "hoy" es la
-- fecha de Argentina, y el pago nace marcado "falta comprobante" y, si es con cheque, también crea su fila en Cheques.
create or replace function aprobar_factura_ya_pagada(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_pago jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas; v_pago uuid; v_origen text; v_ya boolean; v_fecha date; v_saldo numeric;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  perform exigir_empresa((select empresa_id from facturas where id = p_id));
  v_ya := coalesce((p_pago ->> 'ya_en_xubio')::boolean, false);
  v_origen := nullif(trim(coalesce(p_pago ->> 'cuenta_origen', '')), '');
  v_fecha := coalesce(nullif(p_pago ->> 'fecha', '')::date, hoy_ar());
  if p_metodo in ('CHEQUE', 'ECHEQ') and (v_ya or v_origen is not null)
     and (coalesce(p_pago ->> 'numero_cheque', '') = '' or coalesce(p_pago ->> 'fecha_acreditacion', '') = '') then
    raise exception 'Un pago con cheque necesita número y fecha de vencimiento del cheque';
  end if;

  -- Misma aprobación de siempre: cuenta, método, memoria del proveedor y cola de Xubio.
  perform aprobar_factura_interna(p_id, p_cuenta, p_metodo, null, false);
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
    xubio_id, contabilizado_por, contabilizado_en, falta_comprobante)
  values (f.empresa_id, f.proveedor_id, v_fecha, v_saldo, p_metodo,
    coalesce(v_origen, case when p_metodo = 'CAJA' then 'Caja' end),
    nullif(p_pago ->> 'numero_cheque', ''), nullif(p_pago ->> 'fecha_acreditacion', '')::date,
    'Factura ' || f.punto_venta || '-' || f.numero || ' pagada antes de aprobar', nullif(p_pago ->> 'observaciones', ''),
    p_cuenta, 'ORDEN_PAGO',
    (case when v_ya then 'CONTABILIZADO' when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
    u.nombre,
    case when v_ya then 'CARGADO_A_MANO' end, case when v_ya then u.nombre end, case when v_ya then now() end,
    p_metodo not in ('CAJA', 'TARJETA'))
  returning id into v_pago;
  insert into pagos_facturas (pago_id, factura_id, importe) values (v_pago, f.id, v_saldo);
  update facturas set pagado = total, estado = 'PAGADA', actualizado_en = now() where id = p_id;
  update pagos set aviso_cheque = crear_cheque_de_pago(v_pago, u) where id = v_pago;
  perform registrar_auditoria(u, 'APROBADA_YA_PAGADA', 'PAGO', v_pago::text,
    case when v_ya then 'Ya cargado a mano en Xubio: queda contabilizado sin enviar nada'
         else 'Pago creado al aprobar: va a Contabilización' end);
  return case when v_ya then 'CONTABILIZADO' else 'PARA_CONTABILIZAR' end;
end $$;

-- ---------------------------------------------------------------- 9. "Puede ser el cheque X"

-- Un débito de cheque propio sin número (el extracto no lo trae) con UN solo cheque emitido de esa cuenta por el mismo
-- importe (tolerancia de $1): se sugiere. Si hay más de uno (de cualquiera de los dos lados), no se sugiere ninguno (como el Apps Script). No marca nada.
create or replace view movimientos_cheque_sugerido with (security_invoker = true) as
select x.movimiento_id, x.cheque_id, x.numero, x.importe, x.fecha_pago, x.beneficiario
from (
  select m.id as movimiento_id, c.id as cheque_id, c.numero, c.importe, c.fecha_pago, c.beneficiario,
         count(*) over (partition by m.id) as candidatos, count(*) over (partition by c.id) as movimientos
  from movimientos_bancarios m
  join cheques c on c.cuenta_origen_id = m.cuenta_origen_id and c.estado in ('EMITIDO', 'ENTREGADO') and c.movimiento_id is null
                and abs(c.importe + m.importe) <= 1
  where m.importe < 0 and m.categoria = 'CHEQUE_PAGADO' and m.cheque_id is null and m.pago_id is null
    and m.estado <> 'IGNORADO' and nullif(trim(coalesce(m.numero_cheque, '')), '') is null
) x
where x.candidatos = 1 and x.movimientos = 1;   -- ni un movimiento con dos cheques ni un cheque con dos movimientos

-- ---------------------------------------------------------------- 9. Marcar debitado con el movimiento sugerido (0031)

-- Igual que 0031 con un solo cambio: el movimiento puede diferir del importe del cheque hasta $1 (la misma tolerancia
-- con la que se sugiere). Sigue siendo a mano: con el número del cheque como confirmación.
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
    if mv.id is null or mv.cuenta_origen_id <> ch.cuenta_origen_id or abs(mv.importe + ch.importe) > 1 then
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

-- ---------------------------------------------------------------- Permisos
-- En la base real las funciones nuevas no dan EXECUTE por defecto (0021, 0035).

revoke all on pagos_sin_factura, movimientos_cheque_sugerido from public, anon, authenticated;
grant select on pagos_sin_factura, movimientos_cheque_sugerido to authenticated;
grant all on pagos_sin_factura, movimientos_cheque_sugerido to service_role;

-- Las que llama la pantalla (como 0007 y 0031: primero se le quita a public y anon).
revoke execute on function
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer),
  vincular_pago_sin_factura(uuid, uuid),
  corregir_proveedor_pago(uuid, uuid),
  adjuntar_comprobante_pago(uuid, text, text),
  quitar_comprobante_pago(uuid),
  nucleo_acreedor(text),
  distancia_hasta_1(text, text)
from public, anon;
grant execute on function
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer),
  vincular_pago_sin_factura(uuid, uuid),
  corregir_proveedor_pago(uuid, uuid),
  adjuntar_comprobante_pago(uuid, text, text),
  quitar_comprobante_pago(uuid)
to authenticated, service_role;

-- Las internas: solo las llaman otras funciones (que corren con permisos de su dueño) o el servidor.
revoke execute on function
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean),
  vincular_pago_interno(uuid, uuid, usuarios),
  crear_cheque_de_pago(uuid, usuarios),
  posible_duplicado_pago(uuid),
  acreedor_mas_usado(uuid[])
from public, anon, authenticated;
grant execute on function
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean),
  vincular_pago_interno(uuid, uuid, usuarios),
  crear_cheque_de_pago(uuid, usuarios),
  posible_duplicado_pago(uuid),
  acreedor_mas_usado(uuid[]),
  nucleo_acreedor(text),
  distancia_hasta_1(text, text),
  acreedor_para(uuid, uuid, text)
to service_role;
