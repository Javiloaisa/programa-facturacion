'use strict';

// PDF de facturas y presupuestos generado en el servidor, sin dependencias.
// Sirve para mandar el documento como fichero adjunto (WhatsApp, correo...)
// desde el móvil: el texto es texto de verdad, no una imagen, así que pesa
// poco y el cliente puede copiar el número o el IBAN.
//
// Usa las fuentes estándar de PDF (Helvetica, Helvetica-Bold, Courier), que
// todo lector trae de serie, con codificación WinAnsi: cubre acentos, ñ, ü,
// ¿¡, º/ª y €. Lo que no quepa en WinAnsi se aproxima (sin tilde) o sale "?".
// El diseño imita la vista de la factura en pantalla (estilos.css).

const zlib = require('node:zlib');

const A4 = { ancho: 595.28, alto: 841.89 };

// ---------------------------------------------------------------------------
// Métricas de las fuentes (anchos en milésimas de em, de los AFM de Adobe)
// ---------------------------------------------------------------------------

// Caracteres 32..126.
const ANCHOS_ASCII = {
  normal: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  negrita: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};
for (const [fuente, anchos] of Object.entries(ANCHOS_ASCII)) {
  if (anchos.length !== 95) throw new Error(`Tabla de anchos ${fuente} incompleta.`);
}

// Fuera de ASCII. Las letras acentuadas miden lo mismo que su letra base y
// se resuelven solas (ver anchoCaracter); aquí solo los símbolos.
const ANCHOS_EXTRA = {
  normal: {
    '€': 556, '…': 1000, '‘': 222, '’': 222, '‚': 222, '“': 333, '”': 333, '„': 333, '•': 350,
    '–': 556, '—': 1000, '™': 1000, ' ': 278, '¡': 333, '¿': 611, 'ª': 370, 'º': 365,
    '°': 400, '·': 278, '«': 556, '»': 556, '©': 737, '®': 737, '×': 584, '÷': 584, '§': 556,
    'ß': 611, 'æ': 889, 'Æ': 1000, 'ø': 611, 'Ø': 778, '±': 584, '²': 333, '³': 333, '¹': 333,
  },
  negrita: {
    '€': 556, '…': 1000, '‘': 278, '’': 278, '‚': 278, '“': 500, '”': 500, '„': 500, '•': 350,
    '–': 556, '—': 1000, '™': 1000, ' ': 278, '¡': 333, '¿': 611, 'ª': 370, 'º': 365,
    '°': 400, '·': 278, '«': 556, '»': 556, '©': 737, '®': 737, '×': 584, '÷': 584, '§': 556,
    'ß': 611, 'æ': 889, 'Æ': 1000, 'ø': 611, 'Ø': 778, '±': 584, '²': 333, '³': 333, '¹': 333,
  },
};

const FUENTES = {
  normal: { ref: 'F1', base: 'Helvetica' },
  negrita: { ref: 'F2', base: 'Helvetica-Bold' },
  mono: { ref: 'F3', base: 'Courier' },
};

// Huecos 0x80..0x9F de WinAnsi (el resto, 0xA0..0xFF, coincide con Latin-1).
const WINANSI_ALTOS = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
  '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
  '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const WINANSI_INVERSO = Object.fromEntries(Object.entries(WINANSI_ALTOS).map(([c, b]) => [b, c]));

function sinTilde(c) {
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Texto Unicode -> cadena en la que cada carácter es un byte WinAnsi.
function aWinAnsi(texto) {
  let r = '';
  for (const c of String(texto ?? '').normalize('NFC')) {
    const cp = c.codePointAt(0);
    if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) r += c;
    else if (WINANSI_ALTOS[c] !== undefined) r += String.fromCharCode(WINANSI_ALTOS[c]);
    else if (/\s/.test(c)) r += ' ';
    else {
      const base = sinTilde(c);
      const cpBase = base.length === 1 ? base.codePointAt(0) : -1;
      r += (cpBase >= 32 && cpBase <= 126) || (cpBase >= 160 && cpBase <= 255) ? base : '?';
    }
  }
  return r;
}

function anchoCaracter(byte, fuente) {
  if (fuente === 'mono') return 600;
  if (byte >= 32 && byte <= 126) return ANCHOS_ASCII[fuente][byte - 32];
  const c = byte >= 160 ? String.fromCharCode(byte) : WINANSI_INVERSO[byte];
  const extra = ANCHOS_EXTRA[fuente][c];
  if (extra !== undefined) return extra;
  const base = c ? sinTilde(c) : '';
  if (base.length === 1 && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126) {
    return ANCHOS_ASCII[fuente][base.charCodeAt(0) - 32];
  }
  return 556;
}

function anchoTexto(texto, fuente, tam) {
  const bytes = aWinAnsi(texto);
  let total = 0;
  for (let i = 0; i < bytes.length; i++) total += anchoCaracter(bytes.charCodeAt(i), fuente);
  return (total * tam) / 1000;
}

// Reparte un texto en líneas que quepan en anchoMax. Respeta los saltos de
// línea del texto y parte por letras una palabra que no quepa entera.
function partirLineas(texto, fuente, tam, anchoMax) {
  const resultado = [];
  for (const parrafo of String(texto ?? '').split(/\r?\n/)) {
    let actual = '';
    for (const palabra of parrafo.split(/ +/).filter(Boolean)) {
      const candidata = actual ? `${actual} ${palabra}` : palabra;
      if (anchoTexto(candidata, fuente, tam) <= anchoMax) {
        actual = candidata;
        continue;
      }
      if (actual) resultado.push(actual);
      actual = '';
      let trozo = '';
      for (const c of palabra) {
        if (trozo && anchoTexto(trozo + c, fuente, tam) > anchoMax) {
          resultado.push(trozo);
          trozo = '';
        }
        trozo += c;
      }
      actual = trozo;
    }
    resultado.push(actual);
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Lienzo: operaciones de dibujo con coordenadas desde arriba a la izquierda
// (como en pantalla); se pasan al sistema de PDF, que mide desde abajo.
// ---------------------------------------------------------------------------

function num(v) {
  return String(Math.round(v * 100) / 100);
}

function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => num(c / 255)).join(' ');
}

function escaparCadena(s) {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

class LienzoPDF {
  constructor() {
    this.paginas = [];
    this.nuevaPagina();
  }

  nuevaPagina() {
    this.ops = [];
    this.paginas.push(this.ops);
  }

  texto(x, y, texto, { fuente = 'normal', tam = 10, relleno = '#000000', alinear = 'izquierda' } = {}) {
    if (texto === '' || texto === null || texto === undefined) return;
    let x0 = x;
    if (alinear !== 'izquierda') {
      const ancho = anchoTexto(texto, fuente, tam);
      x0 = alinear === 'derecha' ? x - ancho : x - ancho / 2;
    }
    this.ops.push(
      `BT /${FUENTES[fuente].ref} ${num(tam)} Tf ${color(relleno)} rg ${num(x0)} ${num(A4.alto - y)} Td ` +
        `(${escaparCadena(aWinAnsi(texto))}) Tj ET`
    );
  }

  // radios: un número, o [arriba-izq, arriba-der, abajo-der, abajo-izq].
  rect(x, y, ancho, alto, { relleno, trazo, grosor = 0.75, radios = 0 } = {}) {
    const [ri, rd, rbd, rbi] = Array.isArray(radios) ? radios : [radios, radios, radios, radios];
    const k = 0.5523; // aproximación de un cuarto de círculo con una curva de Bézier
    const izq = x;
    const der = x + ancho;
    const arriba = A4.alto - y;
    const abajo = A4.alto - y - alto;
    const p = (...v) => v.map(num).join(' ');
    const camino = [`${p(izq + ri, arriba)} m`, `${p(der - rd, arriba)} l`];
    if (rd) camino.push(`${p(der - rd + rd * k, arriba, der, arriba - rd + rd * k, der, arriba - rd)} c`);
    camino.push(`${p(der, abajo + rbd)} l`);
    if (rbd) camino.push(`${p(der, abajo + rbd - rbd * k, der - rbd + rbd * k, abajo, der - rbd, abajo)} c`);
    camino.push(`${p(izq + rbi, abajo)} l`);
    if (rbi) camino.push(`${p(izq + rbi - rbi * k, abajo, izq, abajo + rbi - rbi * k, izq, abajo + rbi)} c`);
    camino.push(`${p(izq, arriba - ri)} l`);
    if (ri) camino.push(`${p(izq, arriba - ri + ri * k, izq + ri - ri * k, arriba, izq + ri, arriba)} c`);
    camino.push('h');

    const estilo = [];
    if (relleno) estilo.push(`${color(relleno)} rg`);
    if (trazo) estilo.push(`${color(trazo)} RG ${num(grosor)} w`);
    const pintar = relleno && trazo ? 'B' : relleno ? 'f' : 'S';
    this.ops.push(`q ${estilo.join(' ')} ${camino.join(' ')} ${pintar} Q`);
  }

  linea(x1, y1, x2, y2, { trazo = '#000000', grosor = 0.75 } = {}) {
    this.ops.push(
      `q ${color(trazo)} RG ${num(grosor)} w ${num(x1)} ${num(A4.alto - y1)} m ${num(x2)} ${num(A4.alto - y2)} l S Q`
    );
  }

  // Ensambla el fichero: catálogo, fuentes, páginas y tabla de referencias.
  aBuffer({ titulo = '' } = {}) {
    const objetos = [];
    const nuevo = (contenido) => objetos.push(contenido); // devuelve el número de objeto

    const idCatalogo = nuevo(null);
    const idPaginas = nuevo(null);
    const idsFuente = {};
    for (const [clave, f] of Object.entries(FUENTES)) {
      idsFuente[clave] = nuevo(
        Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`)
      );
    }
    const tituloHex = 'FEFF' + [...String(titulo)].map((c) => {
      const unidades = c.length === 2 ? [c.charCodeAt(0), c.charCodeAt(1)] : [c.charCodeAt(0)];
      return unidades.map((u) => u.toString(16).padStart(4, '0')).join('');
    }).join('');
    const idInfo = nuevo(Buffer.from(`<< /Title <${tituloHex}> /Producer (Facturacion) >>`));

    const fuentesRecurso = Object.entries(FUENTES).map(([clave, f]) => `/${f.ref} ${idsFuente[clave]} 0 R`).join(' ');
    const idsPagina = [];
    for (const ops of this.paginas) {
      const comprimido = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const idContenido = nuevo(Buffer.concat([
        Buffer.from(`<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\n`),
        comprimido,
        Buffer.from('\nendstream'),
      ]));
      idsPagina.push(nuevo(Buffer.from(
        `<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 ${A4.ancho} ${A4.alto}] ` +
          `/Resources << /Font << ${fuentesRecurso} >> >> /Contents ${idContenido} 0 R >>`
      )));
    }
    objetos[idCatalogo - 1] = Buffer.from(`<< /Type /Catalog /Pages ${idPaginas} 0 R >>`);
    objetos[idPaginas - 1] = Buffer.from(
      `<< /Type /Pages /Kids [${idsPagina.map((id) => `${id} 0 R`).join(' ')}] /Count ${idsPagina.length} >>`
    );

    const trozos = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let posicion = trozos[0].length;
    const desplazamientos = [];
    objetos.forEach((cuerpo, i) => {
      const trozo = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), cuerpo, Buffer.from('\nendobj\n')]);
      desplazamientos.push(posicion);
      trozos.push(trozo);
      posicion += trozo.length;
    });
    const xref = [
      'xref',
      `0 ${objetos.length + 1}`,
      '0000000000 65535 f ',
      ...desplazamientos.map((d) => `${String(d).padStart(10, '0')} 00000 n `),
      'trailer',
      `<< /Size ${objetos.length + 1} /Root ${idCatalogo} 0 R /Info ${idInfo} 0 R >>`,
      'startxref',
      String(posicion),
      '%%EOF',
      '',
    ].join('\n');
    trozos.push(Buffer.from(xref));
    return Buffer.concat(trozos);
  }
}

// ---------------------------------------------------------------------------
// Maqueta común de factura y presupuesto
// ---------------------------------------------------------------------------

const COLOR = {
  acento: '#1d4e6b',
  texto: '#1c1c1a',
  suave: '#5a5a55',
  borde: '#d8d8d4',
  fondo: '#f4f4f2',
  blanco: '#ffffff',
  separadorCabecera: '#4a7189',
};

const MARGEN = 56.69; // 20 mm, como @page en impresion.css
const ANCHO_UTIL = A4.ancho - 2 * MARGEN;
const LIMITE_INFERIOR = A4.alto - MARGEN;

// useGrouping 'always': en es-ES el punto de miles por defecto solo aparece
// a partir de 10.000, y en una misma factura salía "9800,00" junto a "12.350,00".
const formatoImporte = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const formatoCantidad = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4, useGrouping: 'always' });

function fmtEUR(n) {
  return `${formatoImporte.format(Number(n || 0))} €`;
}

function fmtFecha(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

function lineaCiudad(p) {
  return `${p.cp || ''} ${p.poblacion || ''}`.trim() + (p.provincia ? ` (${p.provincia})` : '');
}

function parteEmisor(e) {
  return {
    nombre: e.nombre || '',
    filas: [
      `Dirección: ${e.direccion || ''}`,
      `NIF: ${e.nif || ''}`,
      `CP y ciudad: ${lineaCiudad(e)}`,
      ...(e.email ? [`Email: ${e.email}`] : []),
      ...(e.telefono ? [`Teléfono: ${e.telefono}`] : []),
    ],
  };
}

function parteCliente(c) {
  return {
    nombre: c.nombre || '',
    filas: [`Dirección: ${c.direccion || ''}`, `NIF: ${c.nif || ''}`, `CP y ciudad: ${lineaCiudad(c)}`],
  };
}

function totalesDe(d) {
  return [
    ['Base', fmtEUR(d.base)],
    [`IVA (${d.tipoIva}%)`, fmtEUR(d.cuotaIva)],
    [`Retención IRPF (-${d.tipoIrpf}%)`, fmtEUR(-Number(d.cuotaIrpf || 0))],
    ['Total', fmtEUR(d.total)],
  ];
}

// Bloque Emisor / Cliente. Devuelve la altura ocupada.
function dibujarParte(lz, x, y, ancho, etiqueta, parte) {
  lz.texto(x, y + 7, etiqueta.toUpperCase(), { tam: 7, relleno: COLOR.suave });
  let base = y + 23;
  const lineasNombre = partirLineas(parte.nombre, 'negrita', 12, ancho);
  lineasNombre.forEach((l, i) => {
    lz.texto(x, base + i * 15, l, { fuente: 'negrita', tam: 12, relleno: COLOR.acento });
  });
  base += (lineasNombre.length - 1) * 15 + 6;
  lz.linea(x, base, x + ancho, base, { trazo: COLOR.acento, grosor: 0.75 });
  for (const fila of parte.filas) {
    for (const l of partirLineas(fila, 'normal', 9.5, ancho)) {
      base += 15;
      lz.texto(x, base, l, { tam: 9.5, relleno: COLOR.suave });
    }
  }
  return base - y + 4;
}

function documentoComercial(d) {
  const lz = new LienzoPDF();
  let y = MARGEN;
  const asegurarEspacio = (alto) => {
    if (y + alto > LIMITE_INFERIOR) {
      lz.nuevaPagina();
      y = MARGEN;
      return true;
    }
    return false;
  };

  // Título
  lz.texto(MARGEN, y + 20, d.titulo, { fuente: 'negrita', tam: 22, relleno: COLOR.acento });
  y += 34;

  // Mini tabla: número, fecha...
  const anchoMini = ANCHO_UTIL / 2;
  const anchoEtiqueta = 88;
  const altoFila = 20;
  const altoMini = d.cabecera.length * altoFila;
  lz.rect(MARGEN, y, anchoMini, altoMini, { relleno: COLOR.fondo, radios: 4 });
  lz.rect(MARGEN, y, anchoEtiqueta, altoMini, { relleno: COLOR.acento, radios: [4, 0, 0, 4] });
  d.cabecera.forEach(([etiqueta, valor], i) => {
    const yFila = y + i * altoFila;
    if (i > 0) {
      lz.linea(MARGEN, yFila, MARGEN + anchoEtiqueta, yFila, { trazo: COLOR.separadorCabecera, grosor: 0.5 });
      lz.linea(MARGEN + anchoEtiqueta, yFila, MARGEN + anchoMini, yFila, { trazo: COLOR.borde, grosor: 0.5 });
    }
    lz.texto(MARGEN + 10, yFila + 13.5, etiqueta, { fuente: 'negrita', tam: 9, relleno: COLOR.blanco });
    lz.texto(MARGEN + anchoEtiqueta + 10, yFila + 13.5, valor, { tam: 9, relleno: COLOR.texto });
  });
  lz.rect(MARGEN, y, anchoMini, altoMini, { trazo: COLOR.borde, grosor: 0.5, radios: 4 });
  y += altoMini + 28;

  for (const aviso of d.avisos || []) {
    for (const l of partirLineas(aviso, 'normal', 9, ANCHO_UTIL)) {
      lz.texto(MARGEN, y + 9, l, { tam: 9, relleno: COLOR.suave });
      y += 13;
    }
    y += 6;
  }

  // Emisor y cliente
  const hueco = 24;
  const anchoCol = (ANCHO_UTIL - hueco) / 2;
  const altoPartes = Math.max(
    dibujarParte(lz, MARGEN, y, anchoCol, 'Emisor', d.emisor),
    dibujarParte(lz, MARGEN + anchoCol + hueco, y, anchoCol, 'Cliente', d.cliente)
  );
  y += altoPartes + 28;

  // Líneas
  const relleno = 8;
  const columnas = [
    { titulo: 'CONCEPTO', ancho: ANCHO_UTIL - 70 - 85 - 90 },
    { titulo: 'CANTIDAD', ancho: 70, derecha: true },
    { titulo: 'PRECIO', ancho: 85, derecha: true },
    { titulo: 'IMPORTE', ancho: 90, derecha: true },
  ];
  const celdas = (valores, opciones) => {
    let x = MARGEN;
    columnas.forEach((c, i) => {
      if (c.derecha) lz.texto(x + c.ancho - relleno, opciones.base, valores[i], { ...opciones.estilo, alinear: 'derecha' });
      x += c.ancho;
    });
  };
  const cabeceraLineas = () => {
    lz.rect(MARGEN, y, ANCHO_UTIL, 24, { relleno: COLOR.acento, radios: 4 });
    lz.texto(MARGEN + relleno, y + 15.5, columnas[0].titulo, { fuente: 'negrita', tam: 8, relleno: COLOR.blanco });
    celdas(columnas.map((c) => c.titulo), { base: y + 15.5, estilo: { fuente: 'negrita', tam: 8, relleno: COLOR.blanco } });
    y += 24;
  };
  asegurarEspacio(24 + 30);
  cabeceraLineas();
  d.lineas.forEach((l, i) => {
    const textoConcepto = partirLineas(l.concepto, 'normal', 9.5, columnas[0].ancho - 2 * relleno);
    const alto = textoConcepto.length * 13 + 14;
    if (asegurarEspacio(alto)) cabeceraLineas();
    if (i % 2 === 1) lz.rect(MARGEN, y, ANCHO_UTIL, alto, { relleno: COLOR.fondo });
    const base = y + 16;
    textoConcepto.forEach((t, j) => lz.texto(MARGEN + relleno, base + j * 13, t, { tam: 9.5, relleno: COLOR.suave }));
    const cantidad = Number(l.cantidad);
    const precio = Number(l.precio);
    celdas(['', formatoCantidad.format(cantidad), fmtEUR(precio), fmtEUR(cantidad * precio)], {
      base,
      estilo: { tam: 9.5, relleno: COLOR.suave },
    });
    lz.linea(MARGEN, y + alto, MARGEN + ANCHO_UTIL, y + alto, { trazo: COLOR.borde, grosor: 0.5 });
    y += alto;
  });
  y += 24;

  // Totales
  const anchoTotales = 210;
  const xTotales = MARGEN + ANCHO_UTIL - anchoTotales;
  const filasTotales = d.totales.slice(0, -1);
  const [etiquetaTotal, valorTotal] = d.totales[d.totales.length - 1];
  asegurarEspacio(filasTotales.length * 17 + 32);
  for (const [etiqueta, valor] of filasTotales) {
    y += 17;
    lz.texto(xTotales, y - 5, etiqueta, { tam: 10, relleno: COLOR.suave });
    lz.texto(xTotales + anchoTotales, y - 5, valor, { tam: 10, relleno: COLOR.suave, alinear: 'derecha' });
  }
  y += 8;
  lz.linea(xTotales, y, xTotales + anchoTotales, y, { trazo: COLOR.acento, grosor: 1.5 });
  y += 20;
  lz.texto(xTotales, y - 4, etiquetaTotal, { fuente: 'negrita', tam: 12, relleno: COLOR.acento });
  lz.texto(xTotales + anchoTotales, y - 4, valorTotal, { fuente: 'negrita', tam: 12, relleno: COLOR.acento, alinear: 'derecha' });
  y += 20;

  // Notas (presupuesto)
  for (const nota of (d.notas || []).filter(Boolean)) {
    y += 6;
    for (const l of partirLineas(nota, 'normal', 9, ANCHO_UTIL)) {
      asegurarEspacio(13);
      lz.texto(MARGEN, y + 9, l, { tam: 9, relleno: COLOR.suave });
      y += 13;
    }
  }

  // Cuenta de pago
  if (d.iban) {
    y += 22;
    asegurarEspacio(52);
    lz.rect(MARGEN, y, ANCHO_UTIL, 24, { relleno: COLOR.acento, radios: [4, 4, 0, 0] });
    lz.texto(MARGEN + 12, y + 16, 'Cuenta de pago', { fuente: 'negrita', tam: 10, relleno: COLOR.blanco });
    lz.rect(MARGEN, y + 24, ANCHO_UTIL, 28, { relleno: COLOR.fondo, radios: [0, 0, 4, 4] });
    lz.texto(MARGEN + 12, y + 24 + 18, d.iban, { fuente: 'mono', tam: 10.5, relleno: COLOR.texto });
    y += 52;
  }

  // Numeración de páginas solo si hay más de una.
  const total = lz.paginas.length;
  if (total > 1) {
    lz.paginas.forEach((ops, i) => {
      lz.ops = ops;
      lz.texto(MARGEN + ANCHO_UTIL, A4.alto - MARGEN / 2, `${d.nombre} · Página ${i + 1} de ${total}`, {
        tam: 8,
        relleno: COLOR.suave,
        alinear: 'derecha',
      });
    });
  }

  return lz.aBuffer({ titulo: d.nombre });
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

function nombreFactura(f) {
  return `Factura ${f.numero || 'borrador'}`;
}

function nombrePresupuesto(p) {
  return `Presupuesto ${p.numero || ''}`.trim();
}

function pdfFactura(f, emisor = {}) {
  return documentoComercial({
    nombre: nombreFactura(f),
    titulo: f.tipo === 'R1' ? 'Factura rectificativa' : 'Factura',
    cabecera: [
      ['Número', f.numero || 'Borrador'],
      ['Fecha', fmtFecha(f.fecha)],
    ],
    avisos: f.rectificaA ? [`Rectifica a la factura ${f.rectificaA}`] : [],
    emisor: parteEmisor(emisor),
    cliente: parteCliente(f.clienteSnapshot || {}),
    lineas: f.lineas || [],
    totales: totalesDe(f),
    iban: emisor.iban || '',
  });
}

function pdfPresupuesto(p, emisor = {}) {
  return documentoComercial({
    nombre: nombrePresupuesto(p),
    titulo: 'Presupuesto',
    cabecera: [
      ['Número', p.numero || ''],
      ['Fecha', fmtFecha(p.fecha)],
      ['Válido hasta', fmtFecha(p.validoHasta)],
    ],
    emisor: parteEmisor(emisor),
    cliente: parteCliente(p.clienteSnapshot || {}),
    lineas: p.lineas || [],
    totales: totalesDe(p),
    notas: [
      p.notas,
      `Presupuesto sin valor de factura. Válido hasta el ${fmtFecha(p.validoHasta)}; los importes no incluyen posibles cambios de alcance acordados después.`,
    ],
  });
}

module.exports = {
  pdfFactura,
  pdfPresupuesto,
  nombreFactura,
  nombrePresupuesto,
  // Expuestas para los tests.
  aWinAnsi,
  anchoTexto,
  partirLineas,
};
