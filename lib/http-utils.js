'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const LIMITE_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB, de sobra para JSON de esta app.

class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

function leerJSON(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let bytes = 0;
    req.on('data', (trozo) => {
      bytes += trozo.length;
      if (bytes > LIMITE_BODY_BYTES) {
        reject(new ErrorHttp(413, 'Cuerpo de la petición demasiado grande.'));
        req.destroy();
        return;
      }
      trozos.push(trozo);
    });
    req.on('end', () => {
      if (bytes === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(trozos).toString('utf8')));
      } catch {
        reject(new ErrorHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function enviarJSON(res, status, datos) {
  const cuerpo = JSON.stringify(datos, null, 0);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(cuerpo),
  });
  res.end(cuerpo);
}

function enviarError(res, status, mensaje) {
  enviarJSON(res, status, { error: mensaje });
}

// ISO 8601 con el huso horario local del servidor (Date#toISOString siempre
// da 'Z'/UTC, y huellaFactura necesita FechaHoraHusoGenRegistro con offset).
function isoConHuso(d = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const signo = offsetMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${signo}${oh}:${om}`
  );
}

// ---------------------------------------------------------------------------
// CSV para los libros registro.
// ---------------------------------------------------------------------------

function celdaCSV(valor) {
  const s = valor === null || valor === undefined ? '' : String(valor);
  if (/[",;\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function generarCSV(cabeceras, filas) {
  const lineas = [cabeceras.map(celdaCSV).join(',')];
  for (const fila of filas) lineas.push(fila.map(celdaCSV).join(','));
  return lineas.join('\r\n') + '\r\n';
}

function enviarCSV(res, nombreFichero, cabeceras, filas) {
  const cuerpo = '﻿' + generarCSV(cabeceras, filas); // BOM: Excel abre UTF-8 bien
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${nombreFichero}"`,
    'Content-Length': Buffer.byteLength(cuerpo),
  });
  res.end(cuerpo);
}

// ---------------------------------------------------------------------------
// Ficheros estaticos (public/), sin path traversal.
// ---------------------------------------------------------------------------

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function tipoMime(fichero) {
  return TIPOS_MIME[path.extname(fichero).toLowerCase()] || 'application/octet-stream';
}

async function servirEstatico(res, pathname, publicDir) {
  let decodificado;
  try {
    decodificado = decodeURIComponent(pathname);
  } catch {
    enviarError(res, 400, 'Ruta inválida.');
    return;
  }
  const relativo = decodificado === '/' ? '/index.html' : decodificado;
  const raiz = path.resolve(publicDir);
  const destino = path.resolve(raiz, `.${relativo}`);
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
    enviarError(res, 400, 'Ruta inválida.');
    return;
  }
  try {
    const datos = await fsp.readFile(destino);
    res.writeHead(200, {
      'Content-Type': tipoMime(destino),
      'Content-Length': datos.length,
      'Cache-Control': 'no-cache',
    });
    res.end(datos);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      enviarError(res, 404, 'No encontrado.');
      return;
    }
    throw err;
  }
}

module.exports = {
  ErrorHttp,
  leerJSON,
  enviarJSON,
  enviarError,
  isoConHuso,
  generarCSV,
  enviarCSV,
  tipoMime,
  servirEstatico,
};
