// Pruebas del simulacro del paralelo con datos FICTICIOS (sin planillas reales): lectura de la fórmula de la fila
// "Conciliación Bancaria", comparación planilla vs base y control de la migración con y sin las correcciones de T-206.
// Uso (desde demo/): node scripts/paralelo/probar.mjs
import { filasDeFormula, indiceColumna } from './planillas.mjs'
import { compararFlujo, compararConciliacion, cent } from './comparar.mjs'
import { controlMigracion } from './reporte.mjs'
import { causaDelDia } from './diagnostico.mjs'
import { transformar } from '../migrar-desde-planillas/transformar.mjs'
import { opciones } from '../migrar-desde-planillas/migrar.mjs'
import { planillasFicticias } from '../migrar-desde-planillas/fixtures.mjs'
import { pesosAR } from '../migrar-desde-planillas/leer.mjs'

let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }

// Fórmula real de la planilla (con otras filas): bancos 109 a 113 contra la caja de la fila 108.
const r = filasDeFormula('=IF(COUNTBLANK(O109:O113)>0;"Sin extracto";IF(AND((SUM(O109:O113)-O108)<1;(SUM(O109:O113)-O108)>-1);"Ok";"F"))')
check('fórmula de Conciliación Bancaria → filas de bancos y de caja', r?.desde === 109 && r?.hasta === 113 && r?.caja === 108, JSON.stringify(r))
check('fórmula que no es la de conciliación → null', filasDeFormula('=O105+O107') === null)
check('columna AE = 30, A = 0, CQ = 94', indiceColumna('AE') === 30 && indiceColumna('A') === 0 && indiceColumna('CQ') === 94)
check('numeric de la base → centavos sin float ("-1234.5" → −123450)', cent('-1234.5') === -123450n && cent('0.07') === 7n && cent(null) === null)

// Comparación por unidad y día.
const pl = [
  { unidad: 'india', pestana: 'India', fecha: '2026-11-03', estado: 'OK', saldo_bancos: 100000n, diferencia: 0n, caja_periodo: 500n },
  { unidad: 'india', pestana: 'India', fecha: '2026-11-04', estado: 'OK', saldo_bancos: 90000n, diferencia: 0n, caja_periodo: -10000n },
  { unidad: 'india', pestana: 'India', fecha: '2026-11-05', estado: 'SIN_EXTRACTO', saldo_bancos: null },
  { unidad: 'india', pestana: 'India', fecha: '2026-11-06', estado: 'OK', saldo_bancos: 90000n },
]
const base = { control: new Map([
  ['india|2026-11-03', { estado: 'PRIMER_SALDO', saldo_bancos: 100000n, diferencia: null, real_del_periodo: 0n }],
  ['india|2026-11-04', { estado: 'OK', saldo_bancos: 90500n, diferencia: 0n, real_del_periodo: -9500n }],
  ['india|2026-11-06', { estado: 'F', saldo_bancos: 90000n, diferencia: 300n, real_del_periodo: -300n }],
]), parciales: new Map() }
const c = compararFlujo(pl, base)
check('"Primer saldo" en la base: no comparable y no coincide', c[0].comparable === false && c[0].coincide === false)
check('mismo estado pero saldo de bancos distinto en más de $1: no coincide', c[1].coincide === false && c[1].dif_saldo === 500n)
check('"Sin extracto" en la planilla y sin control en la base: coincide', c[2].estado_base === 'SIN_EXTRACTO' && c[2].coincide === true)
check('Ok en la planilla y F en la base: no coincide', c[3].coincide === false)

// Conciliación por cuenta: el primer día de una cuenta VBI+ dice DIFERENCIA y la base PRIMER_SALDO → coincide.
const cc = compararConciliacion(
  [{ fila: 2, fecha: '2026-11-02', empresa: 'india', banco: 'BRUBANK', estado: 'DIFERENCIA', diferencia: 500n, saldo_inicial: null },
   { fila: 3, fecha: '2026-11-03', empresa: 'india', banco: 'BRUBANK', estado: 'OK', diferencia: 0n, saldo_inicial: 1n }],
  [{ ref: 'Conciliacion_Diaria fila 2', empresa: 'india', cuenta: 'BRUBANK CC' }, { ref: 'Conciliacion_Diaria fila 3', empresa: 'india', cuenta: 'BRUBANK CC' }],
  new Map([['india|BRUBANK CC|2026-11-02', { estado: 'PRIMER_SALDO', diferencia: null }], ['india|BRUBANK CC|2026-11-03', { estado: 'OK', diferencia: 0n }]]))
check('conciliación: primer día (VBI+ DIFERENCIA sin saldo inicial, base PRIMER_SALDO) coincide; día normal Ok coincide', cc.every((x) => x.coincide))

check('causa del día: cuenta con saldo MANUAL sin extracto + pago sin débito',
  causaDelDia({ cuentas: [{ cuenta: 'MP', dif: 100n, manual: true, sin_extracto: true }], docs_sin_debito: [{ tipo: 'PAGO', n: 1, suma: 100n }] }, pesosAR)
    .includes('saldo MANUAL') )

// Migración con planillas ficticias, con y sin correcciones: el control cierra en las dos.
const sin = transformar(planillasFicticias(), { ...opciones(['--hoy', '2026-11-26']), correcciones: false })
const con = transformar(planillasFicticias(), { ...opciones(['--hoy', '2026-11-26']), correcciones: true })
check('control de la migración sin correcciones: cierra', controlMigracion(sin.control).cierra, controlMigracion(sin.control).malas.join(' | '))
check('control de la migración con correcciones: cierra', controlMigracion(con.control).cierra, controlMigracion(con.control).malas.join(' | '))
check('sin correcciones no hay reglas de cheques por categoría', !sin.plan.flujo_reglas.some((x) => x.si_origen === 'CHEQUE'))
check('ningún cheque DEBITADO sin correcciones', !sin.plan.cheques.some((x) => x.estado === 'DEBITADO'))

console.log(`\n${ok} OK · ${mal} MAL`)
if (mal) process.exit(1)
