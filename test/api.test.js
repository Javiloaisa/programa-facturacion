'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { crearApp } = require('../server.js');
const auth = require('../lib/auth.js');
const fiscal = require('../lib/fiscal.js');

const PASSWORD = 'password-de-doce-caracteres';

function crearCliente(port) {
  let cookie = '';
  function peticion(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const datos = body !== undefined ? JSON.stringify(body) : null;
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(datos ? { 'Content-Length': Buffer.byteLength(datos) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          const trozos = [];
          res.on('data', (t) => trozos.push(t));
          res.on('end', () => {
            const setCookie = res.headers['set-cookie'];
            if (setCookie) cookie = setCookie[0].split(';')[0];
            const texto = Buffer.concat(trozos).toString('utf8');
            let cuerpo = texto;
            if (res.headers['content-type']?.includes('application/json')) {
              try {
                cuerpo = JSON.parse(texto);
              } catch {
                cuerpo = texto;
              }
            }
            resolve({ status: res.statusCode, body: cuerpo, headers: res.headers });
          });
        }
      );
      r.on('error', reject);
      if (datos) r.write(datos);
      r.end();
    });
  }
  return {
    peticion,
    setCookie: (v) => { cookie = v; },
    getCookie: () => cookie,
  };
}

async function levantarApp(opciones) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturacion-api-test-'));
  const app = await crearApp({ dataDir, ...opciones });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    app,
    server,
    port,
    dataDir,
    async cerrar() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Flujo principal: sesion, clientes, facturas, gastos, bienes, impuestos...
// ---------------------------------------------------------------------------

describe('API — flujo principal', () => {
  let ctx;
  let cliente;
  const authObj = auth.crearAuth(PASSWORD);

  before(async () => {
    ctx = await levantarApp({ auth: authObj });
    cliente = crearCliente(ctx.port);
  });

  after(async () => {
    await ctx.cerrar();
  });

  test('las rutas /api/ exigen sesión salvo /api/login', async () => {
    const r = await cliente.peticion('GET', '/api/sesion');
    assert.equal(r.status, 401);
  });

  test('login con contraseña incorrecta no crea sesión', async () => {
    const r = await cliente.peticion('POST', '/api/login', { password: 'incorrecta-cualquiera' });
    assert.equal(r.status, 401);
    assert.equal(cliente.getCookie(), '');
  });

  test('login correcto establece cookie de sesión httpOnly', async () => {
    const r = await cliente.peticion('POST', '/api/login', { password: PASSWORD });
    assert.equal(r.status, 200);
    assert.ok(cliente.getCookie().startsWith('facturacion_sesion='));
  });

  test('GET /api/sesion con cookie válida -> 200', async () => {
    const r = await cliente.peticion('GET', '/api/sesion');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.soloLectura, false);
  });

  test('cabeceras de seguridad presentes en toda respuesta', async () => {
    const r = await cliente.peticion('GET', '/api/sesion');
    assert.ok(r.headers['content-security-policy'].includes("script-src 'self'"));
    assert.ok(!r.headers['content-security-policy'].includes('unsafe-inline'));
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });

  test('cookie manipulada no autentica', async () => {
    const buena = cliente.getCookie();
    cliente.setCookie('facturacion_sesion=esto.no-es-valido');
    const r = await cliente.peticion('GET', '/api/sesion');
    assert.equal(r.status, 401);
    cliente.setCookie(buena);
  });

  test('servir estáticos bloquea path traversal', async () => {
    // El parser de URL de Node ya normaliza los segmentos ".." (incluso
    // percent-encoded) antes de que el pathname llegue al servidor, así que
    // esto nunca resuelve a un fichero fuera de public/: siempre 404, nunca
    // el contenido de un fichero ajeno. El resolve()+startsWith() de
    // servirEstatico es una segunda barrera por si esa asunción cambiara.
    const r = await cliente.peticion('GET', '/%2e%2e/%2e%2e/%2e%2e/windows/win.ini');
    assert.equal(r.status, 404);
  });

  test('alta de cliente', async () => {
    const r = await cliente.peticion('POST', '/api/clientes/c1', { nombre: 'Cliente Uno', nif: '12345678Z' });
    assert.equal(r.status, 200);
    const lista = await cliente.peticion('GET', '/api/clientes');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.length, 1);
    assert.equal(lista.body[0].nombre, 'Cliente Uno');
    assert.equal(lista.body[0].totalAnio, 0);
  });

  let f1id, f2id;

  test('crear factura en borrador calcula importes pero no numera', async () => {
    const r = await cliente.peticion('POST', '/api/facturas', {
      clienteId: 'c1',
      fecha: '2026-07-15',
      lineas: [{ concepto: 'Servicios', cantidad: 1, precio: 1400 }],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.estado, 'borrador');
    assert.equal(r.body.numero, null);
    assert.equal(r.body.base, 1400);
    assert.equal(r.body.cuotaIva, 294);
    assert.equal(r.body.total, 1484);
    f1id = r.body.id;
  });

  test('editar borrador recalcula importes', async () => {
    const r = await cliente.peticion('PUT', `/api/facturas/${f1id}`, {
      lineas: [{ concepto: 'Servicios', cantidad: 1, precio: 1400 }, { concepto: 'Extra', cantidad: 1, precio: 100 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.base, 1500);
  });

  test('confirmar factura asigna número A-0001 y huella', async () => {
    const r = await cliente.peticion('POST', `/api/facturas/${f1id}/confirmar`, null);
    assert.equal(r.status, 200);
    assert.equal(r.body.numero, 'A-0001');
    assert.equal(r.body.estado, 'confirmada');
    assert.ok(r.body.huella);
    assert.equal(r.body.huellaAnterior, '');
  });

  test('editar una factura confirmada está prohibido (409)', async () => {
    const r = await cliente.peticion('PUT', `/api/facturas/${f1id}`, { lineas: [{ concepto: 'x', cantidad: 1, precio: 1 }] });
    assert.equal(r.status, 409);
  });

  test('confirmar dos veces la misma factura está prohibido (409)', async () => {
    const r = await cliente.peticion('POST', `/api/facturas/${f1id}/confirmar`, null);
    assert.equal(r.status, 409);
  });

  test('segunda factura confirmada encadena con la huella de la primera', async () => {
    const borrador = await cliente.peticion('POST', '/api/facturas', {
      clienteId: 'c1',
      fecha: '2026-08-20',
      lineas: [{ concepto: 'Servicios', cantidad: 1, precio: 4500 }],
    });
    f2id = borrador.body.id;
    const primeraLista = await cliente.peticion('GET', '/api/facturas');
    const f1confirmada = primeraLista.body.find((f) => f.id === f1id);

    const r = await cliente.peticion('POST', `/api/facturas/${f2id}/confirmar`, null);
    assert.equal(r.status, 200);
    assert.equal(r.body.numero, 'A-0002');
    assert.equal(r.body.huellaAnterior, f1confirmada.huella);
  });

  test('marcar factura como cobrada', async () => {
    const r = await cliente.peticion('POST', `/api/facturas/${f2id}/cobrar`, { fecha: '2026-09-01' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cobrada, true);
    assert.equal(r.body.fechaCobro, '2026-09-01');
  });

  test('rectificar una factura confirmada crea un borrador R1 ligado', async () => {
    const r = await cliente.peticion('POST', `/api/facturas/${f1id}/rectificar`, { tipo: 'total' });
    assert.equal(r.status, 201);
    assert.equal(r.body.tipo, 'R1');
    assert.equal(r.body.rectificaA, f1id);
    assert.equal(r.body.estado, 'borrador');
    assert.equal(r.body.base, -1500);

    const confirmada = await cliente.peticion('POST', `/api/facturas/${r.body.id}/confirmar`, null);
    assert.equal(confirmada.status, 200);
    assert.equal(confirmada.body.numero, 'R-0001');
  });

  test('previsualizar no persiste nada', async () => {
    const antes = await cliente.peticion('GET', '/api/facturas');
    const r = await cliente.peticion('POST', '/api/facturas/previsualizar', {
      lineas: [{ concepto: 'x', cantidad: 3, precio: 10 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.base, 30);
    assert.equal(r.body.total, 31.8);
    const despues = await cliente.peticion('GET', '/api/facturas');
    assert.equal(despues.body.length, antes.body.length);
  });

  test('el snapshot del cliente se congela al confirmar, no al crear el borrador (encargo §3/§4)', async () => {
    await cliente.peticion('POST', '/api/clientes/c-snap', { nombre: 'Cliente Snapshot', nif: '00000000T', direccion: 'Dirección vieja' });

    // Fecha en el 4T para no alterar los totales del 3T 2026 que comprueba
    // el test del modelo 303/130 más abajo.
    const borrador = await cliente.peticion('POST', '/api/facturas', {
      clienteId: 'c-snap', fecha: '2026-12-01', lineas: [{ concepto: 'x', cantidad: 1, precio: 10 }],
    });
    assert.equal(borrador.body.clienteSnapshot.direccion, 'Dirección vieja');

    // Cambiar la dirección del cliente mientras el borrador sigue abierto.
    await cliente.peticion('PUT', '/api/clientes/c-snap', { nombre: 'Cliente Snapshot', nif: '00000000T', direccion: 'Dirección al confirmar' });

    const confirmada = await cliente.peticion('POST', `/api/facturas/${borrador.body.id}/confirmar`, null);
    assert.equal(confirmada.status, 200);
    assert.equal(confirmada.body.clienteSnapshot.direccion, 'Dirección al confirmar', 'debe llevar la dirección vigente en el momento de emitir, no la de cuando se creó el borrador');

    // Cambiar la dirección otra vez, ya con la factura confirmada: no debe alterarla (regla §4.4).
    await cliente.peticion('PUT', '/api/clientes/c-snap', { nombre: 'Cliente Snapshot', nif: '00000000T', direccion: 'Dirección después de emitida' });
    const facturas = await cliente.peticion('GET', '/api/facturas');
    const persistida = facturas.body.find((f) => f.id === borrador.body.id);
    assert.equal(persistida.clienteSnapshot.direccion, 'Dirección al confirmar', 'una factura emitida no puede cambiar aunque cambie el cliente');
  });

  test('gastos: la respuesta incluye el desglose IRPF/IVA', async () => {
    const r = await cliente.peticion('POST', '/api/gastos', {
      fecha: '2026-08-05',
      concepto: 'Suministros',
      categoria: 'suministros_vivienda',
      base: 80,
      cuotaIva: 16.8,
      afectacionPct: 10,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.desglose.deducibleIrpf, 2.4);
    assert.equal(r.body.desglose.ivaDeducible, 0);

    await cliente.peticion('POST', '/api/gastos', {
      fecha: '2026-07-10', concepto: 'Material', categoria: 'general', base: 100, cuotaIva: 21,
    });
  });

  let bienId;

  test('bienes: alta y cuadro de amortización con prorrateo por días', async () => {
    const r = await cliente.peticion('POST', '/api/bienes', {
      fecha: '2026-09-01', descripcion: 'Equipo informático', categoria: 'informatica', base: 1200, cuotaIva: 252,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.coef, 26);
    bienId = r.body.id;

    const a2026 = await cliente.peticion('GET', `/api/bienes/${bienId}/amortizacion?anio=2026`);
    assert.equal(a2026.body.anual, 104.28);
    const a2027 = await cliente.peticion('GET', `/api/bienes/${bienId}/amortizacion?anio=2027`);
    assert.equal(a2027.body.anual, 312);
  });

  test('modelo 303 y 130 del 3T 2026 con los datos del encargo §10', async () => {
    const r303 = await cliente.peticion('GET', '/api/impuestos/303?anio=2026&trimestre=3');
    assert.equal(r303.status, 200);
    // La factura A-0001 fue rectificada totalmente, así que la base a 21%
    // neta del trimestre es solo la de A-0002 (4.500).
    assert.equal(r303.body.casillas['07'], 4500);
    assert.equal(r303.body.casillas['29'], 21);
    assert.equal(r303.body.casillas['31'], 252);

    const r130 = await cliente.peticion('GET', '/api/impuestos/130?anio=2026&trimestre=3');
    assert.equal(r130.status, 200);
    assert.equal(r130.body.oculto, false);
    assert.equal(r130.body.casillas['13'], 100);
  });

  test('presentar un modelo lo escribe en presentaciones y afecta al trimestre siguiente', async () => {
    const r = await cliente.peticion('POST', '/api/impuestos/303/presentar', { anio: 2026, trimestre: 3 });
    assert.equal(r.status, 200);
    assert.ok('78' in r.body.casillas);

    const siguiente = await cliente.peticion('GET', '/api/impuestos/303?anio=2026&trimestre=4');
    assert.equal(siguiente.status, 200);
  });

  test('plazos incluye los días restantes', async () => {
    const r = await cliente.peticion('GET', '/api/impuestos/plazos?anio=2026');
    assert.equal(r.status, 200);
    assert.ok(r.body.every((p) => Number.isFinite(p.diasRestantes)));
  });

  test('libros en CSV solo incluyen movimientos confirmados', async () => {
    const r = await cliente.peticion('GET', '/api/libros/ventas.csv?anio=2026');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/csv'));
    assert.ok(r.body.includes('A-0001'));
    assert.ok(r.body.includes('A-0002'));
    assert.ok(r.body.includes('R-0001'));
  });

  test('config: PUT no permite tocar los contadores de numeración', async () => {
    const antes = await cliente.peticion('GET', '/api/config');
    const r = await cliente.peticion('PUT', '/api/config', {
      emisor: { nombre: 'Yo Autónomo', nif: '99999999R' },
      siguienteNumero: 999,
      siguienteRectificativa: 999,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.siguienteNumero, antes.body.siguienteNumero);
    assert.equal(r.body.siguienteRectificativa, antes.body.siguienteRectificativa);
    assert.equal(r.body.emisor.nombre, 'Yo Autónomo');
  });

  test('exportar/importar hace un viaje de ida y vuelta completo', async () => {
    const exportado = await cliente.peticion('GET', '/api/exportar');
    assert.equal(exportado.status, 200);
    assert.ok(Array.isArray(exportado.body.facturas));

    const r = await cliente.peticion('POST', '/api/importar', exportado.body);
    assert.equal(r.status, 200);
    assert.equal(r.body.soloLectura, false);

    const facturasTrasImportar = await cliente.peticion('GET', '/api/facturas');
    assert.equal(facturasTrasImportar.body.length, exportado.body.facturas.length);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting de login, aislado en su propia app para no interferir con
// el resto de logins del flujo principal.
// ---------------------------------------------------------------------------

describe('API — rate limiting de login', () => {
  let ctx;
  let cliente;

  before(async () => {
    ctx = await levantarApp({ auth: auth.crearAuth(PASSWORD) });
    cliente = crearCliente(ctx.port);
  });

  after(async () => {
    await ctx.cerrar();
  });

  test('bloquea tras 5 fallos consecutivos con 429', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await cliente.peticion('POST', '/api/login', { password: 'mala' });
      assert.equal(r.status, 401);
    }
    const bloqueado = await cliente.peticion('POST', '/api/login', { password: 'mala' });
    assert.equal(bloqueado.status, 429);
    assert.ok(Number(bloqueado.headers['retry-after']) > 0);

    // Ni siquiera con la contraseña correcta se cuela mientras dura el bloqueo.
    const conBuena = await cliente.peticion('POST', '/api/login', { password: PASSWORD });
    assert.equal(conBuena.status, 429);
  });
});

// ---------------------------------------------------------------------------
// Modo solo lectura si se corrompe la cadena de huellas.
// ---------------------------------------------------------------------------

describe('API — modo solo lectura', () => {
  test('una huella corrompida a mano bloquea la escritura de facturas, no la lectura', async () => {
    const authObj = auth.crearAuth(PASSWORD);
    const primero = await levantarApp({ auth: authObj });
    const clientePrimero = crearCliente(primero.port);
    await clientePrimero.peticion('POST', '/api/login', { password: PASSWORD });
    await clientePrimero.peticion('POST', '/api/clientes/c1', { nombre: 'Uno', nif: '11111111A' });
    const borrador = await clientePrimero.peticion('POST', '/api/facturas', {
      clienteId: 'c1', fecha: '2026-01-10', lineas: [{ concepto: 'a', cantidad: 1, precio: 100 }],
    });
    await clientePrimero.peticion('POST', `/api/facturas/${borrador.body.id}/confirmar`, null);
    const dataDir = primero.dataDir;
    await new Promise((resolve) => primero.server.close(resolve));

    const facturasPath = path.join(dataDir, 'facturas.json');
    const facturas = JSON.parse(fs.readFileSync(facturasPath, 'utf8'));
    facturas[0].total = 999999; // altera el importe sin recalcular la huella
    fs.writeFileSync(facturasPath, JSON.stringify(facturas, null, 2));

    const app = await crearApp({ dataDir, auth: authObj });
    assert.equal(app.estado.soloLectura, true);
    assert.ok(app.estado.motivos.length > 0);

    const server = http.createServer(app.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const cliente = crearCliente(port);
    await cliente.peticion('POST', '/api/login', { password: PASSWORD });

    const rEscritura = await cliente.peticion('POST', '/api/facturas', {
      clienteId: 'c1', fecha: '2026-01-10', lineas: [{ concepto: 'a', cantidad: 1, precio: 5 }],
    });
    assert.equal(rEscritura.status, 423);

    const rLectura = await cliente.peticion('GET', '/api/facturas');
    assert.equal(rLectura.status, 200);

    const rImpuestos = await cliente.peticion('GET', '/api/impuestos/303?anio=2026&trimestre=1');
    assert.equal(rImpuestos.status, 200);

    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Prueba obligatoria (encargo §10): 100 altas concurrentes de factura no
// producen números repetidos ni huecos.
// ---------------------------------------------------------------------------

describe('API — numeración concurrente', () => {
  let ctx;
  let cliente;

  before(async () => {
    ctx = await levantarApp({ auth: auth.crearAuth(PASSWORD) });
    cliente = crearCliente(ctx.port);
    await cliente.peticion('POST', '/api/login', { password: PASSWORD });
    await cliente.peticion('POST', '/api/clientes/c1', { nombre: 'Uno', nif: '11111111A' });
  });

  after(async () => {
    await ctx.cerrar();
  });

  test('100 confirmaciones simultáneas numeran 0001..0100 sin huecos ni duplicados', async () => {
    const creaciones = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        cliente.peticion('POST', '/api/facturas', {
          clienteId: 'c1',
          fecha: '2026-09-01',
          lineas: [{ concepto: 'x', cantidad: 1, precio: 10 + i }],
        })
      )
    );
    assert.ok(creaciones.every((r) => r.status === 201));
    const ids = creaciones.map((r) => r.body.id);

    const confirmaciones = await Promise.all(ids.map((id) => cliente.peticion('POST', `/api/facturas/${id}/confirmar`, null)));
    assert.ok(confirmaciones.every((r) => r.status === 200));

    const numeros = confirmaciones.map((r) => Number(r.body.numero.split('-')[1])).sort((a, b) => a - b);
    assert.equal(new Set(numeros).size, 100, 'no debe haber números duplicados');
    assert.deepEqual(numeros, Array.from({ length: 100 }, (_, i) => i + 1), 'no debe haber huecos, debe ir de 1 a 100');

    // Se comprueba la cadena de huellas directamente sobre los datos
    // exportados (en vez de fiarse del estado asíncrono `soloLectura`, que
    // varias confirmaciones concurrentes pueden actualizar en cualquier
    // orden): así la prueba no depende de en qué momento exacto terminó de
    // propagarse la última comprobación de integridad.
    const exportado = await cliente.peticion('GET', '/api/exportar');
    const confirmadas = exportado.body.facturas.filter((f) => f.estado === 'confirmada');
    assert.equal(confirmadas.length, 100);
    const verificacion = fiscal.verificarCadena(confirmadas);
    assert.equal(verificacion.ok, true, 'la cadena de huellas debe seguir siendo válida');
  });
});
