'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  calcularFactura,
  huellaFactura,
  verificarCadena,
  amortizacionEjercicio,
  modelo303,
  modelo130,
} = require('../lib/fiscal.js');

describe('calcularFactura', () => {
  test('base 1.400 -> IVA 294, IRPF 210, total 1.484', () => {
    const f = calcularFactura({ lineas: [{ cantidad: 1, precio: 1400 }], tipoIva: 21, tipoIrpf: 15 });
    assert.equal(f.base, 1400);
    assert.equal(f.cuotaIva, 294);
    assert.equal(f.cuotaIrpf, 210);
    assert.equal(f.total, 1484);
  });

  test('base 4.500 -> IVA 945, IRPF 675, total 4.770', () => {
    const f = calcularFactura({ lineas: [{ cantidad: 1, precio: 4500 }], tipoIva: 21, tipoIrpf: 15 });
    assert.equal(f.base, 4500);
    assert.equal(f.cuotaIva, 945);
    assert.equal(f.cuotaIrpf, 675);
    assert.equal(f.total, 4770);
  });
});

describe('modelo 303, 3T 2026 (encargo §10)', () => {
  const facturas = [
    { fecha: '2026-07-15', tipoIva: 21, base: 1400, cuotaIva: 294, cuotaIrpf: 210 },
    { fecha: '2026-08-20', tipoIva: 21, base: 4500, cuotaIva: 945, cuotaIrpf: 675 },
  ];
  const gastos = [
    { fecha: '2026-07-10', categoria: 'general', base: 100, cuotaIva: 21, afectacionPct: 100, ivaDeduciblePct: 100 },
    { fecha: '2026-08-05', categoria: 'suministros_vivienda', base: 80, cuotaIva: 16.8, afectacionPct: 10 },
  ];
  const bienes = [
    { fecha: '2026-09-01', categoria: 'informatica', base: 1200, cuotaIva: 252, coef: 26, afectacionPct: 100, ivaDeduciblePct: 100 },
  ];

  const r = modelo303({ facturas, gastos, bienes, anio: 2026, trimestre: 3, saldoPendiente: 0 });

  test('casilla 07 = 5.900, 09 = 1.239, 27 = 1.239', () => {
    assert.equal(r.casillas['07'], 5900);
    assert.equal(r.casillas['09'], 1239);
    assert.equal(r.casillas['27'], 1239);
  });

  test('casilla 29 = 21, 31 = 252, 45 = 273', () => {
    assert.equal(r.casillas['29'], 21);
    assert.equal(r.casillas['31'], 252);
    assert.equal(r.casillas['45'], 273);
  });

  test('casilla 46 = 966, 71 = 966', () => {
    assert.equal(r.casillas['46'], 966);
    assert.equal(r.casillas['71'], 966);
  });
});

describe('modelo 130, 3T 2026 (encargo §10)', () => {
  const facturas = [
    { fecha: '2026-07-15', tipoIva: 21, base: 1400, cuotaIva: 294, cuotaIrpf: 210 },
    { fecha: '2026-08-20', tipoIva: 21, base: 4500, cuotaIva: 945, cuotaIrpf: 675 },
  ];
  const gastos = [
    { fecha: '2026-07-10', categoria: 'general', base: 100, cuotaIva: 21, afectacionPct: 100, ivaDeduciblePct: 100 },
    { fecha: '2026-08-05', categoria: 'suministros_vivienda', base: 80, cuotaIva: 16.8, afectacionPct: 10 },
  ];
  const bienes = [
    { fecha: '2026-09-01', categoria: 'informatica', base: 1200, cuotaIva: 252, coef: 26, afectacionPct: 100, ivaDeduciblePct: 100 },
  ];

  const r = modelo130({
    facturas,
    gastos,
    bienes,
    anio: 2026,
    trimestre: 3,
    presentacionesPrevias: [],
    rendimientoAnterior: 0,
    porcentaje: 20,
  });

  test('casilla 01 = 5.900, 02 = 180,61, 03 = 5.719,39', () => {
    assert.equal(r.casillas['01'], 5900);
    assert.equal(r.casillas['02'], 180.61);
    assert.equal(r.casillas['03'], 5719.39);
  });

  test('casilla 04 = 1.143,88, 06 = 885, 07 = 258,88', () => {
    assert.equal(r.casillas['04'], 1143.88);
    assert.equal(r.casillas['06'], 885);
    assert.equal(r.casillas['07'], 258.88);
  });

  test('casilla 13 = 100, 17 = 158,88', () => {
    assert.equal(r.casillas['13'], 100);
    assert.equal(r.casillas['17'], 158.88);
  });
});

describe('arrastre del saldo de IVA entre trimestres (caso obligatorio)', () => {
  test('un 1T negativo de -300 seguido de un 2T positivo de 200 deja 200 en la 110, 0 en la 71 y arrastra 100 en la 78', () => {
    const q1 = modelo303({
      facturas: [{ fecha: '2026-01-15', tipoIva: 21, base: 1000, cuotaIva: 210 }],
      gastos: [{ fecha: '2026-01-20', categoria: 'general', base: 2500, cuotaIva: 510, afectacionPct: 100, ivaDeduciblePct: 100 }],
      bienes: [],
      anio: 2026,
      trimestre: 1,
      saldoPendiente: 0,
    });
    assert.equal(q1.resultado, -300);
    assert.equal(q1.casillas['78'], 300);
    assert.equal(q1.casillas['71'], 0);

    const q2 = modelo303({
      facturas: [{ fecha: '2026-04-15', tipoIva: 21, base: 1000, cuotaIva: 210 }],
      gastos: [{ fecha: '2026-04-20', categoria: 'general', base: 50, cuotaIva: 10, afectacionPct: 100, ivaDeduciblePct: 100 }],
      bienes: [],
      anio: 2026,
      trimestre: 2,
      saldoPendiente: q1.saldoPendienteSiguiente,
    });
    assert.equal(q2.casillas['110'], 200);
    assert.equal(q2.casillas['71'], 0);
    assert.equal(q2.casillas['78'], 100);
  });
});

describe('amortizacion (encargo §10)', () => {
  test('equipo informatico de 1.200 € al 26%, alta 1/9/2026: 104,28 € en 2026 y 312 € en 2027', () => {
    const bien = { fecha: '2026-09-01', base: 1200, coef: 26, afectacionPct: 100 };
    const a2026 = amortizacionEjercicio(bien, 2026);
    const a2027 = amortizacionEjercicio(bien, 2027);
    assert.equal(a2026.anual, 104.28);
    assert.equal(a2027.anual, 312);
  });
});

describe('cadena de huellas', () => {
  function factura(overrides) {
    return {
      nifEmisor: '12345678Z',
      tipo: 'F1',
      generadaEn: '2026-09-01T10:00:00+02:00',
      ...overrides,
    };
  }

  test('dos facturas encadenadas verifican correctamente', () => {
    const f1 = factura({ orden: 1, numero: 'A-0001', fecha: '2026-09-01', cuotaIva: 294, total: 1484 });
    f1.huellaAnterior = '';
    f1.huella = huellaFactura(f1, '');

    const f2 = factura({ orden: 2, numero: 'A-0002', fecha: '2026-09-05', cuotaIva: 945, total: 4770 });
    f2.huellaAnterior = f1.huella;
    f2.huella = huellaFactura(f2, f1.huella);

    const resultado = verificarCadena([f1, f2]);
    assert.equal(resultado.ok, true);
    assert.deepEqual(resultado.rotas, []);
  });

  test('alterar el importe de la primera factura rompe verificarCadena', () => {
    const f1 = factura({ orden: 1, numero: 'A-0001', fecha: '2026-09-01', cuotaIva: 294, total: 1484 });
    f1.huellaAnterior = '';
    f1.huella = huellaFactura(f1, '');

    const f2 = factura({ orden: 2, numero: 'A-0002', fecha: '2026-09-05', cuotaIva: 945, total: 4770 });
    f2.huellaAnterior = f1.huella;
    f2.huella = huellaFactura(f2, f1.huella);

    const f1Alterada = { ...f1, total: 9999 };

    const resultado = verificarCadena([f1Alterada, f2]);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.rotas.length > 0, true);
  });
});
