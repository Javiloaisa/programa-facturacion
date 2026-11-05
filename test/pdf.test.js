'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const pdf = require('../lib/pdf.js');

const emisor = {
  nombre: 'Emisor Pérez',
  nif: '12345678Z',
  direccion: 'C/ Mayor 1, 3º B',
  cp: '28013',
  poblacion: 'Madrid',
  iban: 'ES91 2100 0418 4502 0005 1332',
};
const factura = {
  numero: 'A-0007',
  fecha: '2026-11-05',
  tipo: 'F1',
  clienteSnapshot: { nombre: 'Añón S.L.', nif: 'B12345674', direccion: 'Avda. Constitución 4' },
  lineas: [{ concepto: 'Diseño (fase 1) \\ revisión', cantidad: 2, precio: 4900 }],
  tipoIva: 21,
  tipoIrpf: 15,
  base: 9800,
  cuotaIva: 2058,
  cuotaIrpf: 1470,
  total: 10388,
};

// Comprueba la tabla xref: cada entrada apunta al inicio de su objeto.
function comprobarEstructura(buf) {
  const texto = buf.toString('latin1');
  assert.ok(texto.startsWith('%PDF-1.4\n'));
  assert.ok(texto.endsWith('%%EOF\n'));
  const inicioXref = Number(texto.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.ok(texto.startsWith('xref\n', inicioXref));
  const [, cuantos] = texto.slice(inicioXref).match(/^xref\n0 (\d+)\n/);
  const entradas = texto.slice(inicioXref).split('\n').slice(3, 2 + Number(cuantos));
  entradas.forEach((linea, i) => {
    const desplazamiento = Number(linea.slice(0, 10));
    assert.ok(texto.startsWith(`${i + 1} 0 obj\n`, desplazamiento), `objeto ${i + 1} mal referenciado`);
  });
  return texto;
}

function contenidoPaginas(texto) {
  const buf = Buffer.from(texto, 'latin1');
  const resultado = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m;
  while ((m = re.exec(texto))) {
    const inicio = m.index + m[0].length;
    resultado.push(zlib.inflateSync(buf.subarray(inicio, inicio + Number(m[1]))).toString('latin1'));
  }
  return resultado;
}

test('aWinAnsi: acentos, ñ y € a su byte; lo que no cabe se aproxima o sale "?"', () => {
  assert.equal(pdf.aWinAnsi('Añón 3º ¿€?'), 'A\xf1\xf3n 3\xba \xbf\x80?');
  // ó está en WinAnsi; ź no, pero se descompone en z + tilde; Ł no se descompone.
  assert.equal(pdf.aWinAnsi('Łódź'), '?\xf3dz');
});

test('partirLineas respeta el ancho, los saltos de línea y parte palabras larguísimas', () => {
  const lineas = pdf.partirLineas('uno dos tres cuatro cinco seis siete\nocho', 'normal', 10, 60);
  assert.ok(lineas.length > 2);
  assert.equal(lineas[lineas.length - 1], 'ocho');
  for (const l of lineas) assert.ok(pdf.anchoTexto(l, 'normal', 10) <= 60);
  const largas = pdf.partirLineas('x'.repeat(200), 'normal', 10, 50);
  assert.ok(largas.length > 1);
  assert.equal(largas.join(''), 'x'.repeat(200));
});

test('pdfFactura genera un PDF válido con el texto de la factura', () => {
  const texto = comprobarEstructura(pdf.pdfFactura(factura, emisor));
  const [pagina] = contenidoPaginas(texto);
  assert.ok(pagina.includes('(Factura)'));
  assert.ok(pagina.includes('(A-0007)'));
  assert.ok(pagina.includes('(Direcci\xf3n: C/ Mayor 1, 3\xba B)'));
  assert.ok(pagina.includes('(A\xf1\xf3n S.L.)'));
  assert.ok(pagina.includes('Dise\xf1o \\(fase 1\\) \\\\ revisi\xf3n'), 'paréntesis y barra escapados');
  assert.ok(pagina.includes('(10.388,00 \x80)'), 'total con punto de miles y euro');
  assert.ok(pagina.includes('(-1.470,00 \x80)'), 'retención en negativo');
  assert.ok(pagina.includes('(ES91 2100 0418 4502 0005 1332)'));
});

test('una rectificativa lo dice en el título y referencia la factura original', () => {
  const rect = { ...factura, tipo: 'R1', numero: 'R-0001', rectificaA: 'A-0007', base: -9800, cuotaIva: -2058, cuotaIrpf: -1470, total: -10388 };
  const [pagina] = contenidoPaginas(comprobarEstructura(pdf.pdfFactura(rect, emisor)));
  assert.ok(pagina.includes('(Factura rectificativa)'));
  assert.ok(pagina.includes('(Rectifica a la factura A-0007)'));
  assert.ok(pagina.includes('(1.470,00 \x80)'), 'la retención de un abono sale en positivo, sin doble signo');
});

test('muchas líneas pasan a varias páginas numeradas y repiten la cabecera de la tabla', () => {
  const lineas = Array.from({ length: 60 }, (_, i) => ({ concepto: `Línea ${i + 1}`, cantidad: 1, precio: 1 }));
  const texto = comprobarEstructura(pdf.pdfFactura({ ...factura, lineas }, emisor));
  const paginas = contenidoPaginas(texto);
  assert.ok(paginas.length >= 2);
  assert.ok(texto.includes(`/Count ${paginas.length}`));
  paginas.forEach((p, i) => {
    assert.ok(p.includes('(CONCEPTO)'));
    assert.ok(p.includes(`P\xe1gina ${i + 1} de ${paginas.length})`));
  });
});

test('pdfPresupuesto incluye la validez y las notas', () => {
  const p = { ...factura, numero: 'P-0003', validoHasta: '2026-12-05', notas: 'Incluye formación' };
  const [pagina] = contenidoPaginas(comprobarEstructura(pdf.pdfPresupuesto(p, emisor)));
  assert.ok(pagina.includes('(Presupuesto)'));
  assert.ok(pagina.includes('(05/12/2026)'));
  assert.ok(pagina.includes('(Incluye formaci\xf3n)'));
  assert.ok(!pagina.includes('ES91'), 'el presupuesto no lleva cuenta de pago');
});
