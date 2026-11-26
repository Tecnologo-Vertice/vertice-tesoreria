-- Tanda D5 · Operación sin planillas: control diario, registro de robots, bloqueos y catálogos chicos.
--
-- Reemplaza Control_Diario_Bancos, Robot_Echeqs_Log, Robot_Debitos_Log, Xubio_Pagos_Log,
-- Historial_Correcciones_IA y Catalogo_Percepciones_IIBB. El control diario es una vista: el mail de las
-- 8 h (días hábiles) lo arma una función programada de Netlify leyéndola.

-- ---------------------------------------------------------------- Control diario de bancos (vista)

create view control_bancos with (security_invoker = true) as
-- 1. Falta el extracto del día hábil anterior
select c.empresa_id, 'FALTA_EXTRACTO'::text as control, c.nombre as sujeto, dia_habil_anterior(current_date) as fecha,
       case when c.rinde_diario then 'Rinde todos los días: subí el extracto o confirmá sin rendimiento'
            else 'Subí el extracto o marcá "Sin movimientos"' end as detalle, null::numeric as importe, 1 as gravedad
from cuentas_origen c
where c.activa and c.requiere_extracto
  and not exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = c.id and s.fecha = dia_habil_anterior(current_date))
union all
-- 2. Diferencias de conciliación de los últimos 7 días
select cb.empresa_id, 'DIFERENCIA', cb.cuenta, cb.fecha, 'Banco ' || cb.saldo_extracto || ' · calculado ' || cb.saldo_calculado, cb.diferencia, 1
from conciliacion_bancaria cb
where cb.estado = 'DIFERENCIA' and cb.fecha >= current_date - 7
union all
-- 3. Movimientos sin clasificar
select m.empresa_id, 'A_REVISAR', co.nombre, m.fecha, m.descripcion, m.importe, 2
from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
where m.estado = 'A_REVISAR'
union all
-- 4. Comprobantes "Extracto Bancario" sin aprobar o con error en Xubio
select f.empresa_id, case when f.estado_xubio = 'ERROR' then 'COMPROBANTE_ERROR' else 'COMPROBANTE_PENDIENTE' end,
       pr.nombre, f.fecha, '09990-' || f.numero || coalesce(' · ' || f.xubio_error, ''), f.total, case when f.estado_xubio = 'ERROR' then 1 else 2 end
from facturas f join proveedores pr on pr.id = f.proveedor_id
where f.cuenta_origen_extracto_id is not null and (f.estado = 'PENDIENTE_APROBACION' or f.estado_xubio in ('PENDIENTE', 'ERROR'))
union all
-- 5. Asientos del banco con error o anulaciones pendientes en Xubio
select a.empresa_id, case when a.anulacion_xubio = 'PENDIENTE' then 'ANULAR_EN_XUBIO' else 'ASIENTO_ERROR' end, a.descripcion, a.fecha,
       coalesce(a.xubio_error, a.motivo_anulacion), null, 1
from asientos a where a.estado_xubio = 'ERROR' or a.anulacion_xubio in ('PENDIENTE', 'ERROR')
union all
-- 6. Control del Flujo en F
select fc.empresa_id, 'FLUJO_F', fc.unidad, fc.fecha, 'Bancos ' || fc.saldo_bancos || ' · diferencia ' || fc.diferencia, fc.diferencia, 1
from flujo_control fc where fc.estado = 'F' and fc.fecha >= current_date - 7
union all
-- 7. Cheques con fecha de pago vencida sin marcar
select ch.empresa_id, 'CHEQUE_SIN_MARCAR', ch.beneficiario, ch.fecha_pago, 'Cheque ' || ch.numero || ': ¿se debitó?', ch.importe, 2
from cheques ch where ch.estado in ('EMITIDO', 'ENTREGADO') and ch.fecha_pago < current_date;

-- Envíos del control (para no mandar dos veces el mismo día y saber qué se informó).
create table control_envios (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  fecha            date not null default current_date,
  destinatarios    text[] not null,
  hallazgos        jsonb not null,
  enviado_en       timestamptz not null default now(),
  unique (organizacion_id, fecha)
);
create trigger trg_organizacion_control_envios before insert or update on control_envios
  for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Registro de procesos automáticos

create table procesos_log (
  id               bigserial primary key,
  organizacion_id  uuid not null references organizaciones,
  empresa_id       text references empresas,
  proceso          text not null check (proceso in ('ROBOT_ECHEQS', 'ROBOT_DEBITOS', 'XUBIO_PAGOS', 'XUBIO_ASIENTOS',
                     'XUBIO_ANULACIONES', 'IMPORTAR_EXTRACTO', 'CONTROL_DIARIO', 'LECTURA_XUBIO', 'CARTERO_GMAIL', 'CARTERO_DRIVE')),
  modo             text not null default 'REAL' check (modo in ('PRUEBA', 'REAL')),
  entidad          text,
  entidad_id       text,
  estado           text not null check (estado in ('OK', 'PRUEBA_OK', 'ERROR', 'OMITIDO')),
  detalle          text,
  datos            jsonb,
  creado_en        timestamptz not null default now()
);
create index on procesos_log (proceso, creado_en desc);
create trigger trg_organizacion_procesos_log before insert on procesos_log for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Bloqueos (el "Hay otro proceso en curso")

-- En la base casi todo se resuelve con transacciones. Esto queda para trabajos largos del servidor
-- (importar un extracto grande, subir a Xubio): un recurso, un dueño, con vencimiento por si se corta.
create table bloqueos (
  recurso     text primary key,
  dueno       text not null,
  tomado_en   timestamptz not null default now(),
  vence_en    timestamptz not null
);

create or replace function tomar_bloqueo(p_recurso text, p_dueno text, p_segundos integer default 300)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from bloqueos where recurso = p_recurso and vence_en < now();
  insert into bloqueos (recurso, dueno, vence_en) values (p_recurso, p_dueno, now() + make_interval(secs => p_segundos))
  on conflict (recurso) do nothing;
  return exists (select 1 from bloqueos where recurso = p_recurso and dueno = p_dueno);
end $$;

create or replace function soltar_bloqueo(p_recurso text, p_dueno text)
returns void language sql security definer set search_path = public as $$
  delete from bloqueos where recurso = p_recurso and dueno = p_dueno
$$;

-- ---------------------------------------------------------------- Catálogos chicos

-- Percepciones de IIBB por jurisdicción: código de la factura → producto/cuenta de Xubio.
create table percepciones_iibb (
  organizacion_id  uuid not null references organizaciones,
  codigo           text not null,
  jurisdiccion     text not null,
  producto_xubio   text,
  cuenta_contable  text,
  primary key (organizacion_id, codigo)
);
create trigger trg_organizacion_percepciones before insert or update on percepciones_iibb
  for each row execute function poner_organizacion();

-- Correcciones a lo que leyó la IA (para medir y mejorar la lectura).
create table correcciones_ia (
  id           bigserial primary key,
  factura_id   uuid not null references facturas on delete cascade,
  campo        text not null,
  valor_ia     text,
  valor_final  text,
  usuario      text not null,
  creado_en    timestamptz not null default now()
);

-- ---------------------------------------------------------------- Seguridad

alter table control_envios enable row level security;
alter table procesos_log enable row level security;
alter table bloqueos enable row level security;
alter table percepciones_iibb enable row level security;
alter table correcciones_ia enable row level security;
create policy leer_control_envios on control_envios for select to authenticated using (organizacion_id = organizacion_actual());
create policy leer_procesos_log on procesos_log for select to authenticated
  using (organizacion_id = organizacion_actual() and (usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION', 'CONTROLLER')
         and (empresa_id is null or empresa_id in (select empresas_visibles())));
create policy leer_percepciones on percepciones_iibb for select to authenticated using (organizacion_id = organizacion_actual());
create policy leer_correcciones_ia on correcciones_ia for select to authenticated using (exists (select 1 from facturas f where f.id = factura_id));
-- bloqueos: sin reglas de lectura, solo el servidor.

revoke all on control_bancos, control_envios, procesos_log, bloqueos, percepciones_iibb, correcciones_ia from public, anon, authenticated;
grant select on control_bancos, control_envios, procesos_log, percepciones_iibb, correcciones_ia to authenticated;
grant all on control_bancos, control_envios, procesos_log, bloqueos, percepciones_iibb, correcciones_ia to service_role;
grant usage, select on sequence procesos_log_id_seq, correcciones_ia_id_seq to service_role;
revoke execute on function tomar_bloqueo(text, text, integer), soltar_bloqueo(text, text) from public, anon, authenticated;
