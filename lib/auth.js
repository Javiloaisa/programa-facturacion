'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Un solo usuario. La contrasena se guarda como scrypt con sal aleatoria en
// un fichero separado del directorio de datos de negocio (ver PLAN.md: asi
// un Store.importar() de un backup de otro entorno nunca toca credenciales).
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const LONGITUD_MINIMA_PASSWORD = 12;
const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12 horas
const DURACION_SESION_S = DURACION_SESION_MS / 1000;
const COOKIE_NOMBRE = 'facturacion_sesion';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// ---------------------------------------------------------------------------
// Hash de contrasena
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return {
    saltHex: salt.toString('hex'),
    hashHex: hash.toString('hex'),
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
  };
}

function verificarPassword(password, scryptData) {
  if (!scryptData) return false;
  const salt = Buffer.from(scryptData.saltHex, 'hex');
  const esperado = Buffer.from(scryptData.hashHex, 'hex');
  const calculado = crypto.scryptSync(password, salt, scryptData.keylen, {
    N: scryptData.N,
    r: scryptData.r,
    p: scryptData.p,
  });
  if (calculado.length !== esperado.length) return false;
  return crypto.timingSafeEqual(calculado, esperado);
}

function validarLongitudPassword(password) {
  return typeof password === 'string' && password.length >= LONGITUD_MINIMA_PASSWORD;
}

// ---------------------------------------------------------------------------
// Fichero auth.json
// ---------------------------------------------------------------------------

function crearAuth(password) {
  return {
    scrypt: hashPassword(password),
    sesionSecretoHex: crypto.randomBytes(32).toString('hex'),
    creado: new Date().toISOString(),
  };
}

async function guardarAuth(rutaAuthFile, auth) {
  await fsp.writeFile(rutaAuthFile, JSON.stringify(auth, null, 2), 'utf8');
}

async function cargarAuth(rutaAuthFile) {
  try {
    const txt = await fsp.readFile(rutaAuthFile, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No existe el fichero de credenciales (${rutaAuthFile}). ` +
          'Ejecuta primero: node server.js --set-password'
      );
    }
    throw err;
  }
}

function existeAuth(rutaAuthFile) {
  return fs.existsSync(rutaAuthFile);
}

// ---------------------------------------------------------------------------
// Sesion: cookie firmada con HMAC-SHA256
// ---------------------------------------------------------------------------

function firmarSesion(secretoHex, exp) {
  const payload = base64url(JSON.stringify({ exp }));
  const firma = base64url(
    crypto.createHmac('sha256', Buffer.from(secretoHex, 'hex')).update(payload).digest()
  );
  return `${payload}.${firma}`;
}

function verificarSesion(secretoHex, token) {
  if (typeof token !== 'string') return false;
  const partes = token.split('.');
  if (partes.length !== 2) return false;
  const [payload, firma] = partes;
  const firmaEsperada = base64url(
    crypto.createHmac('sha256', Buffer.from(secretoHex, 'hex')).update(payload).digest()
  );
  const a = Buffer.from(firma);
  const b = Buffer.from(firmaEsperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let datos;
  try {
    datos = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  return Number.isFinite(datos.exp) && datos.exp > Date.now();
}

function cabeceraCookieSesion(secretoHex) {
  const exp = Date.now() + DURACION_SESION_MS;
  const token = firmarSesion(secretoHex, exp);
  return `${COOKIE_NOMBRE}=${token}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${DURACION_SESION_S}`;
}

function cabeceraCookieBorrarSesion() {
  return `${COOKIE_NOMBRE}=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0`;
}

function tokenDesdeCabeceraCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const parte of cookieHeader.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    const nombre = parte.slice(0, i).trim();
    if (nombre === COOKIE_NOMBRE) return parte.slice(i + 1).trim();
  }
  return null;
}

function sesionValidaDesdeCabecera(cookieHeader, secretoHex) {
  const token = tokenDesdeCabeceraCookie(cookieHeader);
  if (!token) return false;
  return verificarSesion(secretoHex, token);
}

// ---------------------------------------------------------------------------
// Rate limiting de login por IP, en memoria.
// A partir del quinto fallo, backoff exponencial (base 1s, tope 5 min).
// Limpieza perezosa: cada llamada tiene una probabilidad baja de purgar
// entradas inactivas desde hace mas de una hora, sin usar temporizadores
// (asi no deja handles vivos en los tests).
// ---------------------------------------------------------------------------

const UMBRAL_BACKOFF = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_TOPE_MS = 5 * 60 * 1000;
const INACTIVIDAD_LIMPIEZA_MS = 60 * 60 * 1000;

function crearLimitadorLogin() {
  const porIp = new Map();

  function limpiarSiToca(ahora) {
    if (Math.random() >= 0.01) return;
    for (const [ip, entrada] of porIp) {
      if (ahora - entrada.ultimoIntento > INACTIVIDAD_LIMPIEZA_MS) porIp.delete(ip);
    }
  }

  return {
    puedeIntentar(ip) {
      const ahora = Date.now();
      limpiarSiToca(ahora);
      const entrada = porIp.get(ip);
      if (!entrada) return true;
      return ahora >= entrada.bloqueadoHasta;
    },

    esperaMs(ip) {
      const entrada = porIp.get(ip);
      if (!entrada) return 0;
      return Math.max(0, entrada.bloqueadoHasta - Date.now());
    },

    registrarFallo(ip) {
      const ahora = Date.now();
      const entrada = porIp.get(ip) || { fallos: 0, bloqueadoHasta: 0, ultimoIntento: ahora };
      entrada.fallos += 1;
      entrada.ultimoIntento = ahora;
      if (entrada.fallos >= UMBRAL_BACKOFF) {
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (entrada.fallos - UMBRAL_BACKOFF), BACKOFF_TOPE_MS);
        entrada.bloqueadoHasta = ahora + backoff;
      }
      porIp.set(ip, entrada);
    },

    registrarExito(ip) {
      porIp.delete(ip);
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt de contrasena oculta en TTY (para `node server.js --set-password`).
// ---------------------------------------------------------------------------

function pedirPasswordOculto(mensaje) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('Se necesita una terminal interactiva para --set-password.'));
      return;
    }
    stdout.write(mensaje);
    let buffer = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '': // Ctrl+D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(buffer);
          break;
        case '': // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          reject(new Error('Cancelado.'));
          break;
        case '': // Backspace
        case '\b':
          buffer = buffer.slice(0, -1);
          break;
        default:
          buffer += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function flujoEstablecerPassword(rutaAuthFile) {
  const p1 = await pedirPasswordOculto('Nueva contrasena (min. 12 caracteres): ');
  if (!validarLongitudPassword(p1)) {
    throw new Error(`La contrasena debe tener al menos ${LONGITUD_MINIMA_PASSWORD} caracteres.`);
  }
  const p2 = await pedirPasswordOculto('Repite la contrasena: ');
  if (p1 !== p2) {
    throw new Error('Las contrasenas no coinciden.');
  }
  const auth = crearAuth(p1);
  await guardarAuth(rutaAuthFile, auth);
  return auth;
}

module.exports = {
  LONGITUD_MINIMA_PASSWORD,
  COOKIE_NOMBRE,
  DURACION_SESION_S,
  hashPassword,
  verificarPassword,
  validarLongitudPassword,
  crearAuth,
  guardarAuth,
  cargarAuth,
  existeAuth,
  firmarSesion,
  verificarSesion,
  cabeceraCookieSesion,
  cabeceraCookieBorrarSesion,
  tokenDesdeCabeceraCookie,
  sesionValidaDesdeCabecera,
  crearLimitadorLogin,
  pedirPasswordOculto,
  flujoEstablecerPassword,
};
