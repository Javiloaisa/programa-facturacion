'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Redondeo
// ---------------------------------------------------------------------------
// Todo el dinero se maneja en euros con 2 decimales y redondeo half-up.
// Se redondea en cada paso que la AEAT consigna por separado (base, cuota,
// retencion) para que la suma cuadre con lo que se imprime en la factura.

function r2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function suma(lista, fn) {
  return r2(lista.reduce((acc, x) => acc + (fn ? fn(x) : x), 0));
}

// ---------------------------------------------------------------------------
// Trimestres
// ---------------------------------------------------------------------------

function trimestreDe(fechaISO) {
  const mes = Number(fechaISO.slice(5, 7));
  return Math.floor((mes - 1) / 3) + 1;
}

function anioDe(fechaISO) {
  return Number(fechaISO.slice(0, 4));
}

function enPeriodo(fechaISO, anio, trimestre) {
  if (anioDe(fechaISO) !== anio) return false;
  if (!trimestre) return true;
  return trimestreDe(fechaISO) === trimestre;
}

// Acumulado desde el 1 de enero hasta el final del trimestre indicado.
function enAcumulado(fechaISO, anio, trimestre) {
  return anioDe(fechaISO) === anio && trimestreDe(fechaISO) <= trimestre;
}

// ---------------------------------------------------------------------------
// Factura
// ---------------------------------------------------------------------------

function calcularFactura({ lineas = [], tipoIva = 21, tipoIrpf = 15 }) {
  const base = suma(lineas, (l) => r2(Number(l.cantidad || 0) * Number(l.precio || 0)));
  const cuotaIva = r2(base * (Number(tipoIva) / 100));
  const cuotaIrpf = r2(base * (Number(tipoIrpf) / 100));
  return {
    base,
    tipoIva: Number(tipoIva),
    cuotaIva,
    tipoIrpf: Number(tipoIrpf),
    cuotaIrpf,
    total: r2(base + cuotaIva - cuotaIrpf),
  };
}

// ---------------------------------------------------------------------------
// Huella / encadenado (preparación VeriFactu)
// ---------------------------------------------------------------------------
// El RRSIF exige que cada registro de facturacion incorpore la huella del
// anterior, formando una cadena inalterable. El campo y el orden siguen el
// esquema de la AEAT, pero esto NO es una implementacion certificada: no
// genera el XML de remision ni la declaracion responsable del fabricante.
// Sirve para que, cuando VeriFactu sea exigible (1/7/2027 para personas
// fisicas), la cadena historica ya exista desde la factura numero 1.

function huellaFactura(f, huellaAnterior) {
  const campos = [
    `IDEmisorFactura=${f.nifEmisor || ''}`,
    `NumSerieFactura=${f.numero || ''}`,
    `FechaExpedicionFactura=${f.fecha || ''}`,
    `TipoFactura=${f.tipo || 'F1'}`,
    `CuotaTotal=${(f.cuotaIva || 0).toFixed(2)}`,
    `ImporteTotal=${(f.total || 0).toFixed(2)}`,
    `Huella=${huellaAnterior || ''}`,
    `FechaHoraHusoGenRegistro=${f.generadaEn || ''}`,
  ].join('&');
  return crypto.createHash('sha256').update(campos, 'utf8').digest('hex').toUpperCase();
}

function verificarCadena(facturas) {
  const ordenadas = [...facturas].sort((a, b) => a.orden - b.orden);
  const rotas = [];
  let anterior = '';
  for (const f of ordenadas) {
    const esperada = huellaFactura(f, anterior);
    if (f.huella !== esperada) rotas.push({ numero: f.numero, esperada, guardada: f.huella });
    anterior = f.huella;
  }
  return { ok: rotas.length === 0, rotas };
}

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------
// Dos porcentajes independientes, porque IRPF e IVA no siguen la misma regla:
//
//   - afectacionPct  -> parte del gasto afecta a la actividad (IRPF)
//   - ivaDeduciblePct -> parte de la cuota soportada que se deduce (IVA)
//
// Categoria "suministros_vivienda": art. 30.2.5a b) LIRPF. Sobre la parte
// proporcional de metros afectos se deduce solo el 30 %. El IVA de los
// suministros de la vivienda parcialmente afecta no se considera deducible,
// asi que el porcentaje de IVA se fuerza a 0.

function desgloseGasto(g) {
  const base = r2(Number(g.base || 0));
  const cuotaIva = r2(Number(g.cuotaIva || 0));
  const afect = Number(g.afectacionPct ?? 100) / 100;

  let deducibleIrpf;
  if (g.categoria === 'suministros_vivienda') {
    deducibleIrpf = r2(base * afect * 0.30);
  } else {
    deducibleIrpf = r2(base * afect);
  }

  const ivaPct = g.categoria === 'suministros_vivienda' ? 0 : Number(g.ivaDeduciblePct ?? 100) / 100;
  const ivaDeducible = r2(cuotaIva * ivaPct);
  const baseDeducibleIva = r2(base * ivaPct);

  return { base, cuotaIva, deducibleIrpf, ivaDeducible, baseDeducibleIva };
}

// ---------------------------------------------------------------------------
// Bienes de inversion y amortizacion
// ---------------------------------------------------------------------------
// Tabla de amortizacion simplificada (estimacion directa simplificada).
// Coeficiente lineal maximo y periodo maximo en anos.

const TABLA_AMORTIZACION = [
  { id: 'edificios', nombre: 'Edificios y otras construcciones', coef: 3, anios: 68 },
  { id: 'instalaciones', nombre: 'Instalaciones, mobiliario y enseres', coef: 10, anios: 20 },
  { id: 'maquinaria', nombre: 'Maquinaria', coef: 12, anios: 18 },
  { id: 'transporte', nombre: 'Elementos de transporte', coef: 16, anios: 14 },
  { id: 'informatica', nombre: 'Equipos informaticos y software', coef: 26, anios: 10 },
  { id: 'utiles', nombre: 'Utiles y herramientas', coef: 30, anios: 8 },
  { id: 'intangible', nombre: 'Inmovilizado intangible', coef: 15, anios: 10 },
  { id: 'resto', nombre: 'Resto de inmovilizado material', coef: 10, anios: 20 },
];

function diasEnAnio(anio) {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0 ? 366 : 365;
}

// Amortizacion del ejercicio, lineal, prorrateada por dias en el ano de alta.
// Nunca amortiza por encima del valor pendiente.
function amortizacionEjercicio(bien, anio) {
  const base = r2(Number(bien.base || 0) * (Number(bien.afectacionPct ?? 100) / 100));
  const coef = Number(bien.coef || 10) / 100;
  const alta = new Date(`${bien.fecha}T00:00:00Z`);
  const anioAlta = alta.getUTCFullYear();
  if (anio < anioAlta) return { anual: 0, acumulada: 0, pendiente: base };

  const cuotaPlena = r2(base * coef);
  const anual = (a) => {
    if (a < anioAlta) return 0;
    if (a > anioAlta) return cuotaPlena;
    const inicioAnio = Date.UTC(anioAlta, 0, 1);
    const finAnio = Date.UTC(anioAlta, 11, 31);
    const dias = Math.floor((finAnio - Math.max(alta.getTime(), inicioAnio)) / 86400000) + 1;
    return r2(cuotaPlena * (dias / diasEnAnio(anioAlta)));
  };

  let acumulada = 0;
  for (let a = anioAlta; a < anio; a++) acumulada = r2(acumulada + anual(a));
  acumulada = Math.min(acumulada, base);

  const delAnio = Math.min(anual(anio), r2(base - acumulada));
  return {
    anual: r2(Math.max(delAnio, 0)),
    acumulada: r2(acumulada),
    pendiente: r2(base - acumulada - Math.max(delAnio, 0)),
  };
}

// Reparto trimestral de la amortizacion, para el modelo 130 acumulado.
function amortizacionAcumulada(bienes, anio, trimestre) {
  let total = 0;
  for (const b of bienes) {
    const { anual } = amortizacionEjercicio(b, anio);
    total = r2(total + r2(anual * (trimestre / 4)));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Modelo 303
// ---------------------------------------------------------------------------
// Casillas mapeadas: 07/08/09 (base, tipo y cuota al 21 %), 27 (total
// devengado), 28/29 (operaciones interiores corrientes), 30/31 (bienes de
// inversion), 45 (total a deducir), 46 (resultado regimen general),
// 110 (compensacion de periodos anteriores aplicada en este periodo),
// 78 (saldo a compensar que queda pendiente), 71 (resultado).
//
// VERIFICAR contra el formulario real antes de la primera presentacion.

function modelo303({ facturas, gastos, bienes, anio, trimestre, saldoPendiente = 0 }) {
  const emitidas = facturas.filter((f) => !f.anulada && enPeriodo(f.fecha, anio, trimestre));

  const porTipo = new Map();
  for (const f of emitidas) {
    const t = Number(f.tipoIva || 0);
    const acc = porTipo.get(t) || { base: 0, cuota: 0 };
    acc.base = r2(acc.base + Number(f.base || 0));
    acc.cuota = r2(acc.cuota + Number(f.cuotaIva || 0));
    porTipo.set(t, acc);
  }

  const gen = porTipo.get(21) || { base: 0, cuota: 0 };
  const otrosTipos = [...porTipo.entries()].filter(([t]) => t !== 21);
  const cuotaDevengada = suma([...porTipo.values()], (v) => v.cuota);

  const gastosPeriodo = gastos.filter((g) => enPeriodo(g.fecha, anio, trimestre));
  const corrientes = gastosPeriodo.map(desgloseGasto);
  const baseCorriente = suma(corrientes, (d) => d.baseDeducibleIva);
  const cuotaCorriente = suma(corrientes, (d) => d.ivaDeducible);

  const bienesPeriodo = bienes.filter((b) => enPeriodo(b.fecha, anio, trimestre));
  const baseInversion = suma(bienesPeriodo, (b) => r2(Number(b.base || 0) * (Number(b.ivaDeduciblePct ?? 100) / 100)));
  const cuotaInversion = suma(bienesPeriodo, (b) => r2(Number(b.cuotaIva || 0) * (Number(b.ivaDeduciblePct ?? 100) / 100)));

  const totalDeducir = r2(cuotaCorriente + cuotaInversion);
  const resultadoRegimen = r2(cuotaDevengada - totalDeducir);

  // Compensacion: solo se aplica hasta anular un resultado positivo.
  const compensacionAplicada = resultadoRegimen > 0 ? r2(Math.min(saldoPendiente, resultadoRegimen)) : 0;
  const resultado = r2(resultadoRegimen - compensacionAplicada);

  // Lo que queda para arrastrar al trimestre siguiente:
  // el saldo anterior no consumido, mas el negativo generado este trimestre.
  const saldoNuevo = r2(
    saldoPendiente - compensacionAplicada + (resultado < 0 ? Math.abs(resultado) : 0)
  );

  return {
    anio,
    trimestre,
    casillas: {
      '07': gen.base,
      '08': 21,
      '09': gen.cuota,
      '27': cuotaDevengada,
      '28': baseCorriente,
      '29': cuotaCorriente,
      '30': baseInversion,
      '31': cuotaInversion,
      '45': totalDeducir,
      '46': resultadoRegimen,
      '110': compensacionAplicada,
      '78': saldoNuevo,
      '71': resultado > 0 ? resultado : 0,
    },
    otrosTipos: otrosTipos.map(([tipo, v]) => ({ tipo, ...v })),
    resultado,
    aCompensar: resultado < 0 ? r2(Math.abs(resultado)) : 0,
    saldoPendienteSiguiente: saldoNuevo,
    numFacturas: emitidas.length,
    numGastos: gastosPeriodo.length,
  };
}

// ---------------------------------------------------------------------------
// Modelo 130
// ---------------------------------------------------------------------------
// Casillas: 01 ingresos acumulados, 02 gastos acumulados, 03 rendimiento neto,
// 04 el 20 % de la 03, 05 pagos de trimestres anteriores (S07 - S16),
// 06 retenciones soportadas acumuladas, 07 = 04 - 05 - 06, 12 = 07 + 11,
// 13 minoracion por rendimientos bajos, 14 = 12 - 13, 15 negativos anteriores,
// 16 deduccion por prestamo de vivienda anterior a 2013, 17 resultado.
//
// La minoracion de la casilla 13 depende del rendimiento neto del ejercicio
// ANTERIOR, no del actual.

function minoracion13(rendimientoAnterior) {
  const r = Number(rendimientoAnterior || 0);
  if (r > 12000) return 0;
  if (r > 11000) return 25;
  if (r > 10000) return 50;
  if (r > 9000) return 75;
  return 100;
}

function modelo130({
  facturas,
  gastos,
  bienes,
  anio,
  trimestre,
  presentacionesPrevias = [],
  rendimientoAnterior = 0,
  porcentaje = 20,
}) {
  const emitidas = facturas.filter((f) => !f.anulada && enAcumulado(f.fecha, anio, trimestre));
  const ingresos = suma(emitidas, (f) => Number(f.base || 0));
  const retenciones = suma(emitidas, (f) => Number(f.cuotaIrpf || 0));

  const gastosAcum = gastos.filter((g) => enAcumulado(g.fecha, anio, trimestre)).map(desgloseGasto);
  const gastosCorrientes = suma(gastosAcum, (d) => d.deducibleIrpf);
  const amort = amortizacionAcumulada(
    bienes.filter((b) => anioDe(b.fecha) <= anio),
    anio,
    trimestre
  );
  const gastosTotales = r2(gastosCorrientes + amort);

  const c03 = r2(ingresos - gastosTotales);
  const c04 = c03 > 0 ? r2(c03 * (Number(porcentaje) / 100)) : 0;

  const previas = presentacionesPrevias.filter((p) => p.anio === anio && p.trimestre < trimestre);
  const sumaC07 = suma(previas.map((p) => Math.max(Number(p.c07 || 0), 0)));
  const sumaC16 = suma(previas.map((p) => Number(p.c16 || 0)));
  const c05 = r2(sumaC07 - sumaC16);

  const c06 = retenciones;
  const c07 = r2(c04 - c05 - c06);
  const c12 = c07;

  const c13base = minoracion13(rendimientoAnterior);
  const c13 = c12 > 0 ? Math.min(c13base, c12) : 0;
  const c14 = r2(c12 - c13);

  const c15 = suma(previas.map((p) => (Number(p.c17 || 0) < 0 ? Math.abs(Number(p.c17)) : 0)));
  const c16 = 0; // hipoteca posterior a 2013: sin deduccion
  const c17 = r2(c14 - (c14 > 0 ? c15 : 0) - c16);

  return {
    anio,
    trimestre,
    casillas: {
      '01': ingresos,
      '02': gastosTotales,
      '03': c03,
      '04': c04,
      '05': c05,
      '06': c06,
      '07': c07,
      '12': c12,
      '13': c13,
      '14': c14,
      '15': c14 > 0 ? c15 : 0,
      '16': c16,
      '17': c17,
    },
    desglose: { gastosCorrientes, amortizacion: amort },
    resultado: c17 > 0 ? c17 : 0,
    negativo: c17 < 0 ? r2(Math.abs(c17)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Plazos
// ---------------------------------------------------------------------------

function plazos(anio) {
  return [
    { modelo: '303 y 130', periodo: `1T ${anio}`, limite: `${anio}-04-20` },
    { modelo: '303 y 130', periodo: `2T ${anio}`, limite: `${anio}-07-20` },
    { modelo: '303 y 130', periodo: `3T ${anio}`, limite: `${anio}-10-20` },
    { modelo: '303, 130 y 390', periodo: `4T ${anio}`, limite: `${anio + 1}-01-30` },
    { modelo: '347', periodo: `${anio}`, limite: `${anio + 1}-02-28` },
  ];
}

module.exports = {
  r2,
  suma,
  trimestreDe,
  anioDe,
  enPeriodo,
  enAcumulado,
  calcularFactura,
  huellaFactura,
  verificarCadena,
  desgloseGasto,
  TABLA_AMORTIZACION,
  amortizacionEjercicio,
  amortizacionAcumulada,
  modelo303,
  modelo130,
  minoracion13,
  plazos,
};
