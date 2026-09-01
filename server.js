'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store } = require('./lib/store.js');
const fiscal = require('./lib/fiscal.js');
const auth = require('./lib/auth.js');
const {
  ErrorHttp,
  leerJSON,
  enviarJSON,
  enviarError,
  isoConHuso,
  enviarCSV,
  servirEstatico,
} = require('./lib/http-utils.js');

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Router minimo, sin dependencias.
// ---------------------------------------------------------------------------

function crearRouter() {
  const rutas = [];

  function definir(metodo, patron, manejador) {
    const nombres = [];
    const regex = new RegExp(
      '^' + patron.replace(/:[^/]+/g, (m) => { nombres.push(m.slice(1)); return '([^/]+)'; }) + '$'
    );
    rutas.push({ metodo, regex, nombres, manejador });
  }

  return {
    get: (p, m) => definir('GET', p, m),
    post: (p, m) => definir('POST', p, m),
    put: (p, m) => definir('PUT', p, m),
    async despachar(req, res, ctx) {
      for (const r of rutas) {
        if (r.metodo !== req.method) continue;
        const m = ctx.pathname.match(r.regex);
        if (!m) continue;
        const params = {};
        r.nombres.forEach((nombre, i) => { params[nombre] = decodeURIComponent(m[i + 1]); });
        await r.manejador(req, res, ctx, params);
        return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Utilidades de negocio compartidas entre rutas.
// ---------------------------------------------------------------------------

function pad4(n) {
  return String(n).padStart(4, '0');
}

function sumarDias(fechaISO, dias) {
  const d = new Date(`${fechaISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw new ErrorHttp(400, 'La factura necesita al menos una línea.');
  }
  for (const l of lineas) {
    if (!l || typeof l.concepto !== 'string' || !l.concepto.trim()) {
      throw new ErrorHttp(400, 'Cada línea necesita un concepto.');
    }
    if (!Number.isFinite(Number(l.cantidad)) || !Number.isFinite(Number(l.precio))) {
      throw new ErrorHttp(400, 'Cada línea necesita cantidad y precio numéricos.');
    }
  }
}

function comprobarIntegridadFacturas(facturas, config) {
  const confirmadas = facturas.filter((f) => f.estado === 'confirmada');
  const verificacion = fiscal.verificarCadena(confirmadas);
  const numOrdinarias = confirmadas.filter((f) => f.tipo === 'F1').length;
  const numRectificativas = confirmadas.filter((f) => f.tipo === 'R1').length;

  const motivos = [];
  if (!verificacion.ok) motivos.push('La cadena de huellas de las facturas confirmadas está rota.');
  if (numOrdinarias !== config.siguienteNumero - 1) {
    motivos.push(
      `Serie ${config.serie}: hay ${numOrdinarias} facturas confirmadas pero el contador espera ${config.siguienteNumero - 1}.`
    );
  }
  if (numRectificativas !== config.siguienteRectificativa - 1) {
    motivos.push(
      `Serie ${config.serieRectificativa}: hay ${numRectificativas} rectificativas confirmadas pero el contador espera ${config.siguienteRectificativa - 1}.`
    );
  }
  return { soloLectura: motivos.length > 0, motivos };
}

function comparaPeriodo(a, b) {
  return (a.anio * 4 + a.trimestre) - (b.anio * 4 + b.trimestre);
}

async function calcularSaldoPendiente303(store, anio, trimestre) {
  const config = await store.leer('config');
  const presentaciones = await store.leer('presentaciones');
  const anteriores = presentaciones
    .filter((p) => p.modelo === '303' && comparaPeriodo(p, { anio, trimestre }) < 0)
    .sort(comparaPeriodo);
  if (anteriores.length === 0) return Number(config.avanzado?.saldoIvaInicial || 0);
  const ultimo = anteriores[anteriores.length - 1];
  return Number(ultimo.casillas?.['78'] || 0);
}

async function calcularModelo303(store, anio, trimestre) {
  const [facturas, gastos, bienes] = await Promise.all([
    store.leer('facturas'),
    store.leer('gastos'),
    store.leer('bienes'),
  ]);
  const saldoPendiente = await calcularSaldoPendiente303(store, anio, trimestre);
  return fiscal.modelo303({
    facturas: facturas.filter((f) => f.estado === 'confirmada'),
    gastos,
    bienes,
    anio,
    trimestre,
    saldoPendiente,
  });
}

async function calcularModelo130(store, anio, trimestre) {
  const [facturas, gastos, bienes, config, presentaciones] = await Promise.all([
    store.leer('facturas'),
    store.leer('gastos'),
    store.leer('bienes'),
    store.leer('config'),
    store.leer('presentaciones'),
  ]);
  return fiscal.modelo130({
    facturas: facturas.filter((f) => f.estado === 'confirmada'),
    gastos,
    bienes,
    anio,
    trimestre,
    presentacionesPrevias: presentaciones.filter((p) => p.modelo === '130'),
    rendimientoAnterior: config.avanzado?.rendimientoEjercicioAnterior || 0,
    porcentaje: config.avanzado?.porcentaje130 ?? 20,
  });
}

// ---------------------------------------------------------------------------
// crearApp: fabrica el manejador HTTP. No hace .listen() para poder testear
// levantando un puerto efimero desde test/api.test.js.
// ---------------------------------------------------------------------------

async function crearApp(opciones = {}) {
  const dataDir = opciones.dataDir || process.env.FACTURACION_DATA || '/var/lib/facturacion';
  const authFile = opciones.authFile || process.env.FACTURACION_AUTH_FILE || path.join(__dirname, 'auth.json');
  const publicDir = opciones.publicDir || PUBLIC_DIR;

  const store = new Store(dataDir);
  const authData = opciones.auth || (await auth.cargarAuth(authFile));
  const limitadorLogin = auth.crearLimitadorLogin();

  const estado = { soloLectura: false, motivos: [] };
  async function revisarIntegridad() {
    const [facturas, config] = await Promise.all([store.leer('facturas'), store.leer('config')]);
    const r = comprobarIntegridadFacturas(facturas, config);
    estado.soloLectura = r.soloLectura;
    estado.motivos = r.motivos;
  }
  await revisarIntegridad();

  const router = crearRouter();
  registrarRutas(router, { store, estado, revisarIntegridad });

  async function manejador(req, res) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      enviarError(res, 400, 'URL inválida.');
      return;
    }
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          enviarError(res, 405, 'Método no permitido.');
          return;
        }
        await servirEstatico(res, pathname, publicDir);
        return;
      }

      const ip = req.socket.remoteAddress || 'desconocida';

      if (pathname === '/api/login' && req.method === 'POST') {
        if (!limitadorLogin.puedeIntentar(ip)) {
          res.setHeader('Retry-After', String(Math.ceil(limitadorLogin.esperaMs(ip) / 1000)));
          enviarError(res, 429, 'Demasiados intentos. Inténtalo más tarde.');
          return;
        }
        const body = await leerJSON(req);
        if (auth.verificarPassword(body.password, authData.scrypt)) {
          limitadorLogin.registrarExito(ip);
          res.setHeader('Set-Cookie', auth.cabeceraCookieSesion(authData.sesionSecretoHex));
          enviarJSON(res, 200, { ok: true });
        } else {
          limitadorLogin.registrarFallo(ip);
          enviarError(res, 401, 'Credenciales incorrectas.');
        }
        return;
      }

      const sesionValida = auth.sesionValidaDesdeCabecera(req.headers.cookie, authData.sesionSecretoHex);
      if (!sesionValida) {
        enviarError(res, 401, 'No autenticado.');
        return;
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', auth.cabeceraCookieBorrarSesion());
        enviarJSON(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/sesion' && req.method === 'GET') {
        enviarJSON(res, 200, { ok: true, soloLectura: estado.soloLectura, motivos: estado.motivos });
        return;
      }

      const ctx = { pathname, url, store, estado };
      const encontrada = await router.despachar(req, res, ctx);
      if (!encontrada) enviarError(res, 404, 'Ruta no encontrada.');
    } catch (err) {
      if (err instanceof ErrorHttp) {
        enviarError(res, err.status, err.message);
      } else {
        console.error(err);
        enviarError(res, 500, 'Error interno.');
      }
    }
  }

  return { handler: manejador, store, estado, revisarIntegridad };
}

// ---------------------------------------------------------------------------
// Rutas de negocio.
// ---------------------------------------------------------------------------

function registrarRutas(router, { store, estado, revisarIntegridad }) {
  function exigirEscritura() {
    if (estado.soloLectura) {
      throw new ErrorHttp(423, 'Aplicación en modo solo lectura: revisa la cadena de huellas de facturas.');
    }
  }

  // --- Clientes -------------------------------------------------------

  router.get('/api/clientes', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const [clientes, facturas] = await Promise.all([store.leer('clientes'), store.leer('facturas')]);
    const confirmadas = facturas.filter((f) => f.estado === 'confirmada' && fiscal.anioDe(f.fecha) === anio);
    const resultado = clientes.map((c) => {
      const totalAnio = fiscal.suma(confirmadas.filter((f) => f.clienteId === c.id), (f) => Number(f.total || 0));
      return { ...c, totalAnio, aviso347: totalAnio > 3005.06 };
    });
    enviarJSON(res, 200, resultado);
  });

  router.post('/api/clientes/:id', crearOActualizarCliente);
  router.put('/api/clientes/:id', crearOActualizarCliente);

  async function crearOActualizarCliente(req, res, ctx, { id }) {
    const body = await leerJSON(req);
    if (!body.nombre || !body.nif) throw new ErrorHttp(400, 'El cliente necesita nombre y NIF.');
    await store.actualizar('clientes', (clientes) => {
      const idx = clientes.findIndex((c) => c.id === id);
      const cliente = {
        id,
        nombre: body.nombre,
        nif: body.nif,
        direccion: body.direccion || '',
        cp: body.cp || '',
        poblacion: body.poblacion || '',
        provincia: body.provincia || '',
        pais: body.pais || 'España',
        email: body.email || '',
        notas: body.notas || '',
        intracomunitario: !!body.intracomunitario,
        vies: !!body.vies,
        activo: body.activo !== false,
      };
      if (idx === -1) clientes.push(cliente);
      else clientes[idx] = cliente;
      return clientes;
    });
    enviarJSON(res, 200, { ok: true, id });
  }

  // --- Facturas ---------------------------------------------------------

  router.get('/api/facturas', async (req, res, ctx) => {
    const q = ctx.url.searchParams;
    let facturas = await store.leer('facturas');
    const anio = q.get('anio') ? Number(q.get('anio')) : null;
    const trimestre = q.get('trimestre') ? Number(q.get('trimestre')) : null;
    const clienteId = q.get('clienteId');
    const cobrada = q.get('cobrada');
    if (anio) facturas = facturas.filter((f) => fiscal.anioDe(f.fecha) === anio);
    if (trimestre) facturas = facturas.filter((f) => fiscal.trimestreDe(f.fecha) === trimestre);
    if (clienteId) facturas = facturas.filter((f) => f.clienteId === clienteId);
    if (cobrada === 'true') facturas = facturas.filter((f) => f.cobrada === true);
    if (cobrada === 'false') facturas = facturas.filter((f) => f.cobrada !== true);
    enviarJSON(res, 200, facturas);
  });

  router.post('/api/facturas/previsualizar', async (req, res) => {
    const body = await leerJSON(req);
    validarLineas(body.lineas);
    const config = await store.leer('config');
    const calculo = fiscal.calcularFactura({
      lineas: body.lineas,
      tipoIva: body.tipoIva ?? config.tipoIva,
      tipoIrpf: body.tipoIrpf ?? config.tipoIrpf,
    });
    enviarJSON(res, 200, calculo);
  });

  router.post('/api/facturas', async (req, res) => {
    exigirEscritura();
    const body = await leerJSON(req);
    if (!body.clienteId) throw new ErrorHttp(400, 'Falta clienteId.');
    if (!body.fecha) throw new ErrorHttp(400, 'Falta fecha.');
    validarLineas(body.lineas);

    const [clientes, config] = await Promise.all([store.leer('clientes'), store.leer('config')]);
    const cliente = clientes.find((c) => c.id === body.clienteId);
    if (!cliente) throw new ErrorHttp(400, 'El cliente indicado no existe.');

    const tipoIva = body.tipoIva ?? config.tipoIva;
    const tipoIrpf = body.tipoIrpf ?? config.tipoIrpf;
    const calculo = fiscal.calcularFactura({ lineas: body.lineas, tipoIva, tipoIrpf });

    const factura = {
      id: crypto.randomUUID(),
      orden: null,
      serie: config.serie,
      numero: null,
      fecha: body.fecha,
      fechaVencimiento: sumarDias(body.fecha, config.vencimientoDias),
      clienteId: body.clienteId,
      clienteSnapshot: { ...cliente },
      lineas: body.lineas,
      ...calculo,
      tipo: 'F1',
      rectificaA: null,
      motivo: body.motivo || '',
      estado: 'borrador',
      cobrada: false,
      fechaCobro: null,
      nifEmisor: null,
      generadaEn: null,
      huellaAnterior: null,
      huella: null,
    };
    await store.actualizar('facturas', (facturas) => {
      facturas.push(factura);
      return facturas;
    });
    enviarJSON(res, 201, factura);
  });

  router.put('/api/facturas/:id', async (req, res, ctx, { id }) => {
    exigirEscritura();
    const body = await leerJSON(req);
    const config = await store.leer('config');
    let clientes = null;

    let facturaActualizada = null;
    await store.actualizar('facturas', async (facturas) => {
      const idx = facturas.findIndex((f) => f.id === id);
      if (idx === -1) throw new ErrorHttp(404, 'Factura no encontrada.');
      const actual = facturas[idx];
      if (actual.estado !== 'borrador') throw new ErrorHttp(409, 'Solo se pueden editar borradores.');

      const lineas = body.lineas ?? actual.lineas;
      validarLineas(lineas);
      const tipoIva = body.tipoIva ?? actual.tipoIva;
      const tipoIrpf = body.tipoIrpf ?? actual.tipoIrpf;
      const fecha = body.fecha ?? actual.fecha;
      const calculo = fiscal.calcularFactura({ lineas, tipoIva, tipoIrpf });

      let clienteSnapshot = actual.clienteSnapshot;
      let clienteId = actual.clienteId;
      if (body.clienteId && body.clienteId !== actual.clienteId) {
        clientes = clientes || (await store.leer('clientes'));
        const cliente = clientes.find((c) => c.id === body.clienteId);
        if (!cliente) throw new ErrorHttp(400, 'El cliente indicado no existe.');
        clienteId = cliente.id;
        clienteSnapshot = { ...cliente };
      }

      facturaActualizada = {
        ...actual,
        clienteId,
        clienteSnapshot,
        fecha,
        fechaVencimiento: sumarDias(fecha, config.vencimientoDias),
        lineas,
        ...calculo,
        motivo: body.motivo ?? actual.motivo,
      };
      facturas[idx] = facturaActualizada;
      return facturas;
    });
    enviarJSON(res, 200, facturaActualizada);
  });

  router.post('/api/facturas/:id/confirmar', async (req, res, ctx, { id }) => {
    exigirEscritura();
    let facturaConfirmada = null;
    await store.actualizar('facturas', async (facturas) => {
      const idx = facturas.findIndex((f) => f.id === id);
      if (idx === -1) throw new ErrorHttp(404, 'Factura no encontrada.');
      const actual = facturas[idx];
      if (actual.estado !== 'borrador') throw new ErrorHttp(409, 'Esta factura ya está confirmada.');
      validarLineas(actual.lineas);

      await store.actualizar('config', (config) => {
        const esRectificativa = actual.tipo === 'R1';
        const campoContador = esRectificativa ? 'siguienteRectificativa' : 'siguienteNumero';
        const serieUsar = esRectificativa ? config.serieRectificativa : config.serie;
        const numeroActual = config[campoContador];

        const confirmadas = facturas.filter((f) => f.estado === 'confirmada');
        const ultimaOrden = confirmadas.reduce((max, f) => Math.max(max, f.orden || 0), 0);
        const anterior = [...confirmadas].sort((a, b) => a.orden - b.orden).at(-1);
        const huellaAnterior = anterior ? anterior.huella : '';

        const candidata = {
          ...actual,
          estado: 'confirmada',
          serie: serieUsar,
          numero: `${serieUsar}-${pad4(numeroActual)}`,
          nifEmisor: config.emisor.nif,
          generadaEn: isoConHuso(),
          orden: ultimaOrden + 1,
          huellaAnterior,
        };
        candidata.huella = fiscal.huellaFactura(candidata, huellaAnterior);

        facturaConfirmada = candidata;
        config[campoContador] = numeroActual + 1;
        return config;
      });

      facturas[idx] = facturaConfirmada;
      return facturas;
    });
    await revisarIntegridad();
    enviarJSON(res, 200, facturaConfirmada);
  });

  router.post('/api/facturas/:id/rectificar', async (req, res, ctx, { id }) => {
    exigirEscritura();
    const body = await leerJSON(req);
    const tipoRect = body.tipo === 'parcial' ? 'parcial' : 'total';
    if (tipoRect === 'parcial' && !(Number(body.importe) > 0)) {
      throw new ErrorHttp(400, 'Indica un importe positivo para la rectificación parcial.');
    }

    const facturas = await store.leer('facturas');
    const original = facturas.find((f) => f.id === id);
    if (!original) throw new ErrorHttp(404, 'Factura no encontrada.');
    if (original.estado !== 'confirmada') throw new ErrorHttp(409, 'Solo se pueden rectificar facturas confirmadas.');

    const importeBase = tipoRect === 'total' ? original.base : Number(body.importe);
    const lineas = [
      {
        concepto: `Rectificación ${tipoRect} de la factura ${original.numero}`,
        cantidad: 1,
        precio: r2neg(importeBase),
      },
    ];
    const calculo = fiscal.calcularFactura({ lineas, tipoIva: original.tipoIva, tipoIrpf: original.tipoIrpf });

    const rectificativa = {
      id: crypto.randomUUID(),
      orden: null,
      serie: null,
      numero: null,
      fecha: body.fecha || new Date().toISOString().slice(0, 10),
      fechaVencimiento: null,
      clienteId: original.clienteId,
      clienteSnapshot: original.clienteSnapshot,
      lineas,
      ...calculo,
      tipo: 'R1',
      rectificaA: original.id,
      motivo: body.motivo || '',
      estado: 'borrador',
      cobrada: false,
      fechaCobro: null,
      nifEmisor: null,
      generadaEn: null,
      huellaAnterior: null,
      huella: null,
    };
    const config = await store.leer('config');
    rectificativa.fechaVencimiento = sumarDias(rectificativa.fecha, config.vencimientoDias);

    await store.actualizar('facturas', (lista) => {
      lista.push(rectificativa);
      return lista;
    });
    enviarJSON(res, 201, rectificativa);
  });

  function r2neg(n) {
    return -Math.abs(fiscal.r2(Number(n)));
  }

  router.post('/api/facturas/:id/cobrar', async (req, res, ctx, { id }) => {
    exigirEscritura();
    const body = await leerJSON(req);
    if (!body.fecha) throw new ErrorHttp(400, 'Falta la fecha de cobro.');
    let facturaCobrada = null;
    await store.actualizar('facturas', (facturas) => {
      const idx = facturas.findIndex((f) => f.id === id);
      if (idx === -1) throw new ErrorHttp(404, 'Factura no encontrada.');
      if (facturas[idx].estado !== 'confirmada') throw new ErrorHttp(409, 'Solo se pueden cobrar facturas confirmadas.');
      facturaCobrada = { ...facturas[idx], cobrada: true, fechaCobro: body.fecha };
      facturas[idx] = facturaCobrada;
      return facturas;
    });
    enviarJSON(res, 200, facturaCobrada);
  });

  // --- Gastos -------------------------------------------------------------

  router.get('/api/gastos', async (req, res, ctx) => {
    const q = ctx.url.searchParams;
    let gastos = await store.leer('gastos');
    const anio = q.get('anio') ? Number(q.get('anio')) : null;
    const trimestre = q.get('trimestre') ? Number(q.get('trimestre')) : null;
    if (anio) gastos = gastos.filter((g) => fiscal.anioDe(g.fecha) === anio);
    if (trimestre) gastos = gastos.filter((g) => fiscal.trimestreDe(g.fecha) === trimestre);
    enviarJSON(res, 200, gastos.map((g) => ({ ...g, desglose: fiscal.desgloseGasto(g) })));
  });

  router.post('/api/gastos', async (req, res) => {
    const body = await leerJSON(req);
    if (!body.fecha || !body.concepto) throw new ErrorHttp(400, 'Faltan datos del gasto.');
    const gasto = {
      id: crypto.randomUUID(),
      fecha: body.fecha,
      proveedor: body.proveedor || '',
      nif: body.nif || '',
      concepto: body.concepto,
      categoria: body.categoria || 'general',
      base: Number(body.base || 0),
      tipoIva: Number(body.tipoIva ?? 21),
      cuotaIva: Number(body.cuotaIva || 0),
      afectacionPct: body.afectacionPct ?? 100,
      ivaDeduciblePct: body.ivaDeduciblePct ?? 100,
      formaPago: body.formaPago || '',
      adjunto: body.adjunto || null,
    };
    await store.actualizar('gastos', (gastos) => {
      gastos.push(gasto);
      return gastos;
    });
    enviarJSON(res, 201, { ...gasto, desglose: fiscal.desgloseGasto(gasto) });
  });

  // --- Bienes de inversion --------------------------------------------------

  router.get('/api/bienes', async (req, res) => {
    enviarJSON(res, 200, await store.leer('bienes'));
  });

  router.post('/api/bienes', async (req, res) => {
    const body = await leerJSON(req);
    if (!body.fecha || !body.descripcion || !body.categoria) throw new ErrorHttp(400, 'Faltan datos del bien.');
    const tablaEntry = fiscal.TABLA_AMORTIZACION.find((t) => t.id === body.categoria);
    if (!tablaEntry) throw new ErrorHttp(400, 'Categoría de amortización desconocida.');
    const bien = {
      id: crypto.randomUUID(),
      fecha: body.fecha,
      descripcion: body.descripcion,
      proveedor: body.proveedor || '',
      nif: body.nif || '',
      base: Number(body.base || 0),
      cuotaIva: Number(body.cuotaIva || 0),
      categoria: body.categoria,
      coef: body.coef != null ? Number(body.coef) : tablaEntry.coef,
      afectacionPct: body.afectacionPct ?? 100,
      ivaDeduciblePct: body.ivaDeduciblePct ?? 100,
      baja: body.baja || null,
    };
    await store.actualizar('bienes', (bienes) => {
      bienes.push(bien);
      return bienes;
    });
    enviarJSON(res, 201, bien);
  });

  router.get('/api/bienes/:id/amortizacion', async (req, res, ctx, { id }) => {
    const bienes = await store.leer('bienes');
    const bien = bienes.find((b) => b.id === id);
    if (!bien) throw new ErrorHttp(404, 'Bien no encontrado.');
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    enviarJSON(res, 200, fiscal.amortizacionEjercicio(bien, anio));
  });

  // --- Libros registro (CSV) -----------------------------------------------

  router.get('/api/libros/ventas.csv', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const facturas = (await store.leer('facturas'))
      .filter((f) => f.estado === 'confirmada' && fiscal.anioDe(f.fecha) === anio)
      .sort((a, b) => a.orden - b.orden);
    enviarCSV(
      res,
      `libro-ventas-${anio}.csv`,
      ['Fecha', 'Número', 'Cliente', 'NIF', 'Base', 'Tipo IVA', 'Cuota IVA', 'Tipo IRPF', 'Cuota IRPF', 'Total'],
      facturas.map((f) => [
        f.fecha, f.numero, f.clienteSnapshot?.nombre || '', f.clienteSnapshot?.nif || '',
        f.base, f.tipoIva, f.cuotaIva, f.tipoIrpf, f.cuotaIrpf, f.total,
      ])
    );
  });

  router.get('/api/libros/compras.csv', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const gastos = (await store.leer('gastos')).filter((g) => fiscal.anioDe(g.fecha) === anio);
    enviarCSV(
      res,
      `libro-compras-${anio}.csv`,
      ['Fecha', 'Proveedor', 'NIF', 'Concepto', 'Categoría', 'Base', 'Tipo IVA', 'Cuota IVA', 'Base ded. IVA', 'IVA deducible', 'Deducible IRPF'],
      gastos.map((g) => {
        const d = fiscal.desgloseGasto(g);
        return [g.fecha, g.proveedor, g.nif, g.concepto, g.categoria, d.base, g.tipoIva, d.cuotaIva, d.baseDeducibleIva, d.ivaDeducible, d.deducibleIrpf];
      })
    );
  });

  router.get('/api/libros/bienes.csv', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const bienes = await store.leer('bienes');
    enviarCSV(
      res,
      `libro-bienes-${anio}.csv`,
      ['Fecha', 'Descripción', 'Proveedor', 'NIF', 'Base', 'Cuota IVA', 'Categoría', 'Coef. %', 'Amort. año', 'Amort. acumulada', 'Pendiente'],
      bienes.map((b) => {
        const a = fiscal.amortizacionEjercicio(b, anio);
        return [b.fecha, b.descripcion, b.proveedor, b.nif, b.base, b.cuotaIva, b.categoria, b.coef, a.anual, a.acumulada, a.pendiente];
      })
    );
  });

  // --- Impuestos ------------------------------------------------------------

  router.get('/api/impuestos/303', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const trimestre = Number(ctx.url.searchParams.get('trimestre')) || fiscal.trimestreDe(new Date().toISOString());
    enviarJSON(res, 200, await calcularModelo303(store, anio, trimestre));
  });

  router.get('/api/impuestos/130', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const trimestre = Number(ctx.url.searchParams.get('trimestre')) || fiscal.trimestreDe(new Date().toISOString());
    const config = await store.leer('config');
    const resultado = await calcularModelo130(store, anio, trimestre);
    enviarJSON(res, 200, { ...resultado, oculto: !config.presenta130 });
  });

  router.post('/api/impuestos/:modelo/presentar', async (req, res, ctx, { modelo }) => {
    if (modelo !== '303' && modelo !== '130') throw new ErrorHttp(404, 'Modelo desconocido.');
    const body = await leerJSON(req);
    const anio = Number(body.anio);
    const trimestre = Number(body.trimestre);
    if (!anio || !trimestre) throw new ErrorHttp(400, 'Faltan anio/trimestre.');

    const resultado = modelo === '303' ? await calcularModelo303(store, anio, trimestre) : await calcularModelo130(store, anio, trimestre);
    const entrada = {
      modelo,
      anio,
      trimestre,
      fechaPresentacion: isoConHuso(),
      casillas: resultado.casillas,
    };
    if (modelo === '130') {
      entrada.c07 = resultado.casillas['07'];
      entrada.c16 = resultado.casillas['16'];
      entrada.c17 = resultado.casillas['17'];
    }

    await store.actualizar('presentaciones', (lista) => {
      const filtrada = lista.filter((p) => !(p.modelo === modelo && p.anio === anio && p.trimestre === trimestre));
      filtrada.push(entrada);
      return filtrada;
    });
    enviarJSON(res, 200, entrada);
  });

  router.get('/api/impuestos/plazos', async (req, res, ctx) => {
    const anio = Number(ctx.url.searchParams.get('anio')) || new Date().getFullYear();
    const hoy = Date.now();
    const lista = fiscal.plazos(anio).map((p) => ({
      ...p,
      diasRestantes: Math.ceil((Date.parse(`${p.limite}T00:00:00`) - hoy) / 86400000),
    }));
    enviarJSON(res, 200, lista);
  });

  // --- Ajustes ----------------------------------------------------------

  router.get('/api/config', async (req, res) => {
    enviarJSON(res, 200, await store.leer('config'));
  });

  router.put('/api/config', async (req, res) => {
    const body = await leerJSON(req);
    const nuevo = await store.actualizar('config', (config) => {
      if (body.emisor) config.emisor = { ...config.emisor, ...body.emisor };
      if (typeof body.serie === 'string') config.serie = body.serie;
      if (typeof body.serieRectificativa === 'string') config.serieRectificativa = body.serieRectificativa;
      if (Number.isFinite(body.tipoIva)) config.tipoIva = body.tipoIva;
      if (Number.isFinite(body.tipoIrpf)) config.tipoIrpf = body.tipoIrpf;
      if (typeof body.presenta130 === 'boolean') config.presenta130 = body.presenta130;
      if (Number.isFinite(body.vencimientoDias)) config.vencimientoDias = body.vencimientoDias;
      if (body.avanzado) config.avanzado = { ...config.avanzado, ...body.avanzado };
      return config;
      // siguienteNumero/siguienteRectificativa no se tocan aqui: solo los
      // avanza la confirmacion de facturas, para no romper la numeracion.
    });
    enviarJSON(res, 200, nuevo);
  });

  router.get('/api/exportar', async (req, res) => {
    const datos = await store.exportar();
    const cuerpo = JSON.stringify(datos, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="facturacion-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Length': Buffer.byteLength(cuerpo),
    });
    res.end(cuerpo);
  });

  router.post('/api/importar', async (req, res) => {
    exigirEscritura();
    const body = await leerJSON(req);
    await store.importar(body);
    await revisarIntegridad();
    enviarJSON(res, 200, { ok: true, soloLectura: estado.soloLectura, motivos: estado.motivos });
  });
}

// ---------------------------------------------------------------------------
// Arranque en linea de comandos.
// ---------------------------------------------------------------------------

async function arrancarCLI() {
  const authFile = process.env.FACTURACION_AUTH_FILE || path.join(__dirname, 'auth.json');

  if (process.argv.includes('--set-password')) {
    try {
      await auth.flujoEstablecerPassword(authFile);
      console.log(`Credenciales guardadas en ${authFile}.`);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (!auth.existeAuth(authFile)) {
    console.error(
      `No existe el fichero de credenciales (${authFile}). Ejecuta primero: node server.js --set-password`
    );
    process.exit(1);
    return;
  }

  const puerto = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  const { handler, estado } = await crearApp({ authFile });

  http.createServer(handler).listen(puerto, host, () => {
    console.log(`Servidor escuchando en http://${host}:${puerto}`);
    if (estado.soloLectura) {
      console.warn('AVISO: arrancando en modo SOLO LECTURA:');
      for (const motivo of estado.motivos) console.warn(`  - ${motivo}`);
    }
  });
}

if (require.main === module) {
  arrancarCLI().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { crearApp };
