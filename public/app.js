'use strict';

// Estado de trabajo solo en memoria de módulo: nunca localStorage/
// sessionStorage. Cada vista repide datos frescos al servidor.
const estado = {
  autenticado: false,
  soloLectura: false,
  motivos: [],
  clientes: [],
  config: null,
};

const CATEGORIAS_GASTO = [
  ['general', 'General'],
  ['suministros_vivienda', 'Suministros de vivienda (afecta parcial)'],
  ['cuota_autonomos', 'Cuota de autónomos'],
  ['profesionales', 'Profesionales'],
  ['software', 'Software'],
  ['viajes', 'Viajes'],
  ['otros', 'Otros'],
];

// Copia de referencia de fiscal.js::TABLA_AMORTIZACION (datos normativos
// estáticos, no de negocio: no hace falta una ruta API solo para esto).
const TABLA_AMORTIZACION = [
  { id: 'edificios', nombre: 'Edificios y otras construcciones', coef: 3 },
  { id: 'instalaciones', nombre: 'Instalaciones, mobiliario y enseres', coef: 10 },
  { id: 'maquinaria', nombre: 'Maquinaria', coef: 12 },
  { id: 'transporte', nombre: 'Elementos de transporte', coef: 16 },
  { id: 'informatica', nombre: 'Equipos informáticos y software', coef: 26 },
  { id: 'utiles', nombre: 'Útiles y herramientas', coef: 30 },
  { id: 'intangible', nombre: 'Inmovilizado intangible', coef: 15 },
  { id: 'resto', nombre: 'Resto de inmovilizado material', coef: 10 },
];

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

class ErrorApi extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

async function api(method, ruta, body) {
  const res = await fetch(ruta, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    mostrarLogin();
    throw new ErrorApi(401, 'No autenticado.');
  }
  const tipo = res.headers.get('content-type') || '';
  const datos = tipo.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ErrorApi(res.status, (datos && datos.error) || 'Error inesperado.');
  return datos;
}

function descargar(ruta) {
  const a = document.createElement('a');
  a.href = ruta;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

function fmtEUR(n) {
  return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtFecha(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function anioActual() {
  return new Date().getFullYear();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Arranque: login vs app
// ---------------------------------------------------------------------------

const $login = document.getElementById('vista-login');
const $app = document.getElementById('app');
const $contenido = document.getElementById('contenido');
const $avisoSoloLectura = document.getElementById('aviso-solo-lectura');

function mostrarLogin() {
  estado.autenticado = false;
  $app.hidden = true;
  $login.hidden = false;
  document.getElementById('login-password').focus();
}

async function mostrarApp() {
  estado.autenticado = true;
  $login.hidden = true;
  $app.hidden = false;
  actualizarAvisoSoloLectura();
  const [clientes, config] = await Promise.all([api('GET', '/api/clientes'), api('GET', '/api/config')]);
  estado.clientes = clientes;
  estado.config = config;
  renderRuta();
}

function actualizarAvisoSoloLectura() {
  if (estado.soloLectura) {
    $avisoSoloLectura.hidden = false;
    $avisoSoloLectura.textContent =
      'Modo solo lectura: ' + (estado.motivos[0] || 'la cadena de huellas de facturas no es consistente.') +
      ' No se pueden crear, editar ni confirmar facturas hasta resolverlo.';
  } else {
    $avisoSoloLectura.hidden = true;
  }
}

$login.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const password = document.getElementById('login-password').value;
  const $error = document.getElementById('login-error');
  $error.textContent = '';
  try {
    await api('POST', '/api/login', { password });
    const sesion = await api('GET', '/api/sesion');
    estado.soloLectura = sesion.soloLectura;
    estado.motivos = sesion.motivos || [];
    document.getElementById('login-password').value = '';
    await mostrarApp();
  } catch (err) {
    $error.textContent = err instanceof ErrorApi && err.status === 429 ? 'Demasiados intentos. Espera un momento.' : 'Contraseña incorrecta.';
  }
});

document.getElementById('boton-salir').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch { /* si ya no hay sesión, no pasa nada */ }
  mostrarLogin();
});

async function arrancar() {
  try {
    const sesion = await api('GET', '/api/sesion');
    estado.soloLectura = sesion.soloLectura;
    estado.motivos = sesion.motivos || [];
    await mostrarApp();
  } catch {
    mostrarLogin();
  }
}

// ---------------------------------------------------------------------------
// Router por hash
// ---------------------------------------------------------------------------

const rutas = [];
function ruta(patron, manejador) {
  const nombres = [];
  const regex = new RegExp('^' + patron.replace(/:[^/]+/g, (m) => { nombres.push(m.slice(1)); return '([^/]+)'; }) + '$');
  rutas.push({ regex, nombres, manejador });
}

// Navegar tras una acción (guardar, confirmar...) puede apuntar al mismo
// hash en el que ya estamos (p.ej. confirmar una factura no cambia su id
// en la URL): asignar el mismo valor a location.hash no dispara
// 'hashchange', así que hay que forzar el re-render a mano en ese caso.
function irA(nuevoHash) {
  if (location.hash === nuevoHash) renderRuta();
  else location.hash = nuevoHash;
}

async function renderRuta() {
  if (!estado.autenticado) return;
  if (!location.hash) history.replaceState(null, '', '#/facturas');
  const hash = location.hash.replace(/^#/, '');
  const seccion = hash.split('/')[1] || 'facturas';
  for (const a of document.querySelectorAll('#nav-lateral a')) {
    a.classList.toggle('activo', a.dataset.seccion === seccion);
  }
  for (const r of rutas) {
    const m = hash.match(r.regex);
    if (!m) continue;
    const params = {};
    r.nombres.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    try {
      await r.manejador(params);
      $contenido.focus();
    } catch (err) {
      if (err instanceof ErrorApi && err.status === 401) return;
      $contenido.innerHTML = `<p class="mensaje-error">${esc(err.message || 'Error inesperado.')}</p>`;
    }
    return;
  }
  $contenido.innerHTML = '<p class="mensaje-error">Página no encontrada.</p>';
}
window.addEventListener('hashchange', renderRuta);

// ---------------------------------------------------------------------------
// Atajos de teclado: nueva factura/gasto, guardar, escape para cancelar.
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (ev) => {
  const enCampo = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    const formulario = $contenido.querySelector('form');
    if (formulario) {
      ev.preventDefault();
      formulario.requestSubmit();
    }
    return;
  }

  if (!enCampo && ev.key === 'n' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const seccion = (location.hash.split('/')[1] || '');
    if (seccion === 'facturas') { ev.preventDefault(); location.hash = '#/facturas/nueva'; }
    else if (seccion === 'gastos') { ev.preventDefault(); location.hash = '#/gastos/nueva'; }
    else if (seccion === 'inversiones') { ev.preventDefault(); location.hash = '#/inversiones/nuevo'; }
  }

  if (ev.key === 'Escape' && !enCampo) {
    const seccion = (location.hash.split('/')[1] || '');
    if (seccion) location.hash = `#/${seccion}`;
  }
});

// ---------------------------------------------------------------------------
// Facturas
// ---------------------------------------------------------------------------

ruta('/facturas', async () => {
  const q = new URLSearchParams(location.search);
  const anio = Number(q.get('anio')) || anioActual();
  const trimestre = q.get('trimestre') || '';
  const facturas = await api('GET', `/api/facturas?anio=${anio}${trimestre ? `&trimestre=${trimestre}` : ''}`);
  facturas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  $contenido.innerHTML = `
    <h2>Facturas</h2>
    <div class="barra-acciones">
      <label class="filtro-linea">Año
        <select id="f-anio">${opcionesAnios(anio)}</select>
      </label>
      <label class="filtro-linea">Trimestre
        <select id="f-trimestre">
          <option value="">Todos</option>
          ${[1, 2, 3, 4].map((t) => `<option value="${t}" ${String(t) === trimestre ? 'selected' : ''}>${t}T</option>`).join('')}
        </select>
      </label>
      <div class="espaciador"></div>
      <button type="button" id="btn-clientes">Clientes</button>
      <button type="button" class="primario" id="btn-nueva">Nueva factura (n)</button>
    </div>
    ${facturas.length === 0
      ? `<div class="estado-vacio">Todavía no hay facturas en este período. Crea la primera con «Nueva factura».</div>`
      : tablaFacturas(facturas)}
  `;

  document.getElementById('f-anio').addEventListener('change', (e) => navegarFiltro({ anio: e.target.value }));
  document.getElementById('f-trimestre').addEventListener('change', (e) => navegarFiltro({ trimestre: e.target.value }));
  document.getElementById('btn-nueva').addEventListener('click', () => { location.hash = '#/facturas/nueva'; });
  document.getElementById('btn-clientes').addEventListener('click', () => { location.hash = '#/clientes'; });
  $contenido.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = `#/facturas/${tr.dataset.id}`; });
  });
});

function navegarFiltro(cambios) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(cambios)) { if (v) q.set(k, v); else q.delete(k); }
  location.hash = `#/facturas?${q.toString()}`;
}

function opcionesAnios(seleccionado) {
  const base = anioActual();
  const anios = [];
  for (let a = base + 1; a >= base - 4; a--) anios.push(a);
  return anios.map((a) => `<option value="${a}" ${a === seleccionado ? 'selected' : ''}>${a}</option>`).join('');
}

function tablaFacturas(facturas) {
  return `
  <div class="tabla-envoltorio"><table>
    <thead><tr>
      <th>Fecha</th><th>Número</th><th>Cliente</th><th class="num">Base</th><th class="num">Total</th><th>Estado</th><th>Cobro</th>
    </tr></thead>
    <tbody>
      ${facturas.map((f) => `
        <tr data-id="${f.id}" tabindex="0">
          <td>${fmtFecha(f.fecha)}</td>
          <td>${esc(f.numero || '(borrador)')}</td>
          <td>${esc(f.clienteSnapshot?.nombre || '')}</td>
          <td class="num">${fmtEUR(f.base)}</td>
          <td class="num">${fmtEUR(f.total)}</td>
          <td><span class="etiqueta ${f.estado}">${f.estado === 'confirmada' ? 'confirmada' : 'borrador'}</span></td>
          <td>${f.estado !== 'confirmada' ? '' : `<span class="etiqueta ${f.cobrada ? 'cobrada' : 'pendiente'}">${f.cobrada ? 'cobrada' : 'pendiente'}</span>`}</td>
        </tr>`).join('')}
    </tbody>
  </table></div>`;
}

ruta('/facturas/nueva', async () => {
  renderFormularioFactura(null);
});

ruta('/facturas/:id', async ({ id }) => {
  const facturas = await api('GET', '/api/facturas');
  const factura = facturas.find((f) => f.id === id);
  if (!factura) { $contenido.innerHTML = '<p class="mensaje-error">Factura no encontrada.</p>'; return; }
  if (factura.estado === 'borrador') renderFormularioFactura(factura);
  else renderDetalleFactura(factura);
});

function renderFormularioFactura(factura) {
  if (estado.clientes.length === 0) {
    $contenido.innerHTML = `<div class="estado-vacio">Necesitas al menos un cliente antes de facturar. <a href="#/clientes">Crea uno aquí</a>.</div>`;
    return;
  }
  const c = estado.config;
  const lineas = factura?.lineas?.length ? factura.lineas : [{ concepto: '', cantidad: 1, precio: 0 }];

  $contenido.innerHTML = `
    <h2>${factura ? 'Editar borrador' : 'Nueva factura'}</h2>
    <form id="form-factura">
      <div class="fila-campos">
        <div class="campo">
          <label for="ff-cliente">Cliente</label>
          <select id="ff-cliente" required>
            ${estado.clientes.map((cl) => `<option value="${cl.id}" ${factura?.clienteId === cl.id ? 'selected' : ''}>${esc(cl.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label for="ff-fecha">Fecha</label>
          <input id="ff-fecha" type="date" required value="${factura?.fecha || new Date().toISOString().slice(0, 10)}">
        </div>
        <div class="campo">
          <label for="ff-iva">Tipo IVA %</label>
          <input id="ff-iva" type="number" step="0.01" value="${factura?.tipoIva ?? c.tipoIva}">
        </div>
        <div class="campo">
          <label for="ff-irpf">Tipo IRPF %</label>
          <input id="ff-irpf" type="number" step="0.01" value="${factura?.tipoIrpf ?? c.tipoIrpf}">
        </div>
      </div>

      <table id="tabla-lineas">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Precio</th><th></th></tr></thead>
        <tbody>
          ${lineas.map((l) => filaLinea(l)).join('')}
        </tbody>
      </table>
      <p><button type="button" id="btn-add-linea">+ Añadir línea</button></p>

      <div class="bloque" id="ff-preview">
        <div class="linea-total">Base <span>—</span></div>
      </div>

      <div class="campo">
        <label for="ff-motivo">Notas / motivo (opcional)</label>
        <input id="ff-motivo" value="${esc(factura?.motivo || '')}">
      </div>

      <div class="barra-acciones">
        <button type="submit" class="primario" ${estado.soloLectura ? 'disabled' : ''}>Guardar borrador (Ctrl+S)</button>
        ${factura ? `<button type="button" id="btn-confirmar-factura" data-id="${factura.id}" ${estado.soloLectura ? 'disabled' : ''}>Confirmar y numerar</button>` : ''}
        <a href="#/facturas">Cancelar (Esc)</a>
      </div>
    </form>
  `;

  const $tbody = document.querySelector('#tabla-lineas tbody');
  document.getElementById('btn-add-linea').addEventListener('click', () => {
    $tbody.insertAdjacentHTML('beforeend', filaLinea({ concepto: '', cantidad: 1, precio: 0 }));
    actualizarPreview();
  });
  $tbody.addEventListener('click', (e) => {
    if (e.target.dataset.accion === 'quitar') {
      e.target.closest('tr').remove();
      actualizarPreview();
    }
  });
  // Escuchar en el <form>, no en $contenido: $contenido persiste entre
  // renders (solo se reemplaza su innerHTML), así que volver a esta ruta
  // varias veces iría acumulando un listener por visita.
  document.getElementById('form-factura').addEventListener('input', actualizarPreview);

  async function actualizarPreview() {
    try {
      const body = leerFormularioFactura();
      const calculo = await api('POST', '/api/facturas/previsualizar', body);
      document.getElementById('ff-preview').innerHTML = `
        <div class="linea-total">Base <span>${fmtEUR(calculo.base)}</span></div>
        <div class="linea-total">Cuota IVA (${calculo.tipoIva}%) <span>${fmtEUR(calculo.cuotaIva)}</span></div>
        <div class="linea-total">Retención IRPF (-${calculo.tipoIrpf}%) <span>-${fmtEUR(calculo.cuotaIrpf)}</span></div>
        <div class="linea-total gran-total">Total <span>${fmtEUR(calculo.total)}</span></div>
      `;
    } catch { /* líneas incompletas todavía: se ignora hasta que sean válidas */ }
  }
  actualizarPreview();

  function leerFormularioFactura() {
    const lineas = [...$tbody.querySelectorAll('tr')].map((tr) => ({
      concepto: tr.querySelector('.l-concepto').value,
      cantidad: Number(tr.querySelector('.l-cantidad').value),
      precio: Number(tr.querySelector('.l-precio').value),
    }));
    return {
      clienteId: document.getElementById('ff-cliente').value,
      fecha: document.getElementById('ff-fecha').value,
      tipoIva: Number(document.getElementById('ff-iva').value),
      tipoIrpf: Number(document.getElementById('ff-irpf').value),
      lineas,
      motivo: document.getElementById('ff-motivo').value,
    };
  }

  document.getElementById('form-factura').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = leerFormularioFactura();
    try {
      const guardada = factura
        ? await api('PUT', `/api/facturas/${factura.id}`, body)
        : await api('POST', '/api/facturas', body);
      irA(`#/facturas/${guardada.id}`);
    } catch (err) {
      mostrarErrorFormulario(err);
    }
  });
}

function filaLinea(l) {
  return `<tr>
    <td><input class="l-concepto" value="${esc(l.concepto)}" required></td>
    <td class="num"><input class="l-cantidad" type="number" step="0.01" value="${l.cantidad}"></td>
    <td class="num"><input class="l-precio" type="number" step="0.01" value="${l.precio}"></td>
    <td><button type="button" data-accion="quitar" aria-label="Quitar línea">×</button></td>
  </tr>`;
}

function mostrarErrorFormulario(err) {
  const previo = $contenido.querySelector('.mensaje-error');
  if (previo) previo.remove();
  $contenido.querySelector('form')?.insertAdjacentHTML('afterbegin', `<p class="mensaje-error">${esc(err.message)}</p>`);
}

function renderDetalleFactura(f) {
  const emisor = estado.config?.emisor || {};
  $contenido.innerHTML = `
    <div class="barra-acciones no-imprimir">
      <a href="#/facturas">← Volver</a>
      <div class="espaciador"></div>
      ${f.estado === 'confirmada' && !f.cobrada && !estado.soloLectura ? `<button id="btn-cobrar">Marcar cobrada</button>` : ''}
      ${f.estado === 'confirmada' && f.tipo !== 'R1' && !estado.soloLectura ? `<button id="btn-rectificar">Rectificar</button>` : ''}
      <button id="btn-imprimir" class="primario">Imprimir</button>
    </div>
    <article class="factura-doc">
      <div class="factura-cuerpo">
        <div class="factura-titulo">Factura</div>
        <table class="factura-mini-tabla">
          <tr><th>Número</th><td>${esc(f.numero || 'Borrador')}</td></tr>
          <tr><th>Fecha</th><td>${fmtFecha(f.fecha)}</td></tr>
        </table>
        ${f.rectificaA ? `<p class="factura-nota">Rectifica a la factura ${esc(f.rectificaA)}</p>` : ''}

        <div class="factura-partes">
          <div class="parte">
            <h4>${esc(emisor.nombre || '')}</h4>
            <p>
              Dirección: ${esc(emisor.direccion || '')}<br>
              NIF: ${esc(emisor.nif || '')}<br>
              CP y ciudad: ${esc(emisor.cp || '')} ${esc(emisor.poblacion || '')}${emisor.provincia ? ` (${esc(emisor.provincia)})` : ''}
              ${emisor.email ? `<br>Email: ${esc(emisor.email)}` : ''}
              ${emisor.telefono ? `<br>Teléfono: ${esc(emisor.telefono)}` : ''}
            </p>
          </div>
          <div class="parte">
            <h4>${esc(f.clienteSnapshot?.nombre || '')}</h4>
            <p>
              Dirección: ${esc(f.clienteSnapshot?.direccion || '')}<br>
              NIF: ${esc(f.clienteSnapshot?.nif || '')}<br>
              CP y ciudad: ${esc(f.clienteSnapshot?.cp || '')} ${esc(f.clienteSnapshot?.poblacion || '')}${f.clienteSnapshot?.provincia ? ` (${esc(f.clienteSnapshot.provincia)})` : ''}
            </p>
          </div>
        </div>

        <table class="factura-lineas">
          <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead>
          <tbody>
            ${f.lineas.map((l) => `<tr><td>${esc(l.concepto)}</td><td class="num">${l.cantidad}</td><td class="num">${fmtEUR(l.precio)}</td><td class="num">${fmtEUR(l.cantidad * l.precio)}</td></tr>`).join('')}
          </tbody>
        </table>

        <div class="totales-caja">
          <div class="totales">
            <div class="linea-total">Base <span>${fmtEUR(f.base)}</span></div>
            <div class="linea-total">IVA (${f.tipoIva}%) <span>${fmtEUR(f.cuotaIva)}</span></div>
            <div class="linea-total">Retención IRPF (-${f.tipoIrpf}%) <span>-${fmtEUR(f.cuotaIrpf)}</span></div>
            <div class="linea-total gran-total">Total <span>${fmtEUR(f.total)}</span></div>
          </div>
        </div>

        ${emisor.iban ? `
        <div class="factura-pago">
          <div class="factura-pago-titulo">Cuenta de pago</div>
          <div class="factura-pago-valor">${esc(emisor.iban)}</div>
        </div>` : ''}
      </div>
    </article>
  `;
  document.getElementById('btn-imprimir').addEventListener('click', () => window.print());
  document.getElementById('btn-cobrar')?.addEventListener('click', async () => {
    const fecha = prompt('Fecha de cobro (AAAA-MM-DD):', new Date().toISOString().slice(0, 10));
    if (!fecha) return;
    try { await api('POST', `/api/facturas/${f.id}/cobrar`, { fecha }); renderRuta(); }
    catch (err) { alert(err.message); }
  });
  document.getElementById('btn-rectificar')?.addEventListener('click', async () => {
    if (!confirm(`¿Rectificar totalmente la factura ${f.numero}? Se creará un borrador de abono a confirmar.`)) return;
    try {
      const rect = await api('POST', `/api/facturas/${f.id}/rectificar`, { tipo: 'total' });
      location.hash = `#/facturas/${rect.id}`;
    } catch (err) { alert(err.message); }
  });
}

// Confirmar factura: acción dentro del borrador solo cuando ya está guardado.
document.addEventListener('click', async (ev) => {
  if (ev.target.id === 'btn-confirmar-factura') {
    const id = ev.target.dataset.id;
    try { await api('POST', `/api/facturas/${id}/confirmar`, null); irA(`#/facturas/${id}`); }
    catch (err) { alert(err.message); }
  }
});

// ---------------------------------------------------------------------------
// Clientes (accesible desde Facturas; no lleva entrada propia en la nav).
// ---------------------------------------------------------------------------

ruta('/clientes', async () => {
  const clientes = await api('GET', `/api/clientes?anio=${anioActual()}`);
  $contenido.innerHTML = `
    <h2>Clientes</h2>
    <div class="barra-acciones"><a href="#/facturas">← Volver a facturas</a></div>
    <div class="bloque">
      <h3>Nuevo cliente</h3>
      <form id="form-cliente">
        <div class="fila-campos">
          <div class="campo"><label for="c-nombre">Nombre</label><input id="c-nombre" required></div>
          <div class="campo"><label for="c-nif">NIF</label><input id="c-nif" required></div>
        </div>
        <div class="fila-campos">
          <div class="campo"><label for="c-direccion">Dirección</label><input id="c-direccion"></div>
          <div class="campo"><label for="c-cp">CP</label><input id="c-cp"></div>
          <div class="campo"><label for="c-poblacion">Población</label><input id="c-poblacion"></div>
          <div class="campo"><label for="c-provincia">Provincia</label><input id="c-provincia"></div>
        </div>
        <div class="fila-campos">
          <div class="campo"><label for="c-email">Email</label><input id="c-email" type="email"></div>
          <div class="campo campo-final">
            <label><input id="c-vies" type="checkbox"> Intracomunitario (VIES)</label>
          </div>
        </div>
        <p class="mensaje-info">La exención intracomunitaria todavía no se aplica automáticamente aunque marques VIES (fuera de alcance mientras no se dé de alta en el ROI).</p>
        <button type="submit" class="primario">Guardar cliente</button>
      </form>
    </div>
    ${clientes.length === 0 ? '<div class="estado-vacio">Todavía no hay clientes. Da de alta el primero con el formulario de arriba.</div>' : `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Nombre</th><th>NIF</th><th>Población</th><th class="num">Total ${anioActual()}</th><th></th></tr></thead>
      <tbody>
        ${clientes.map((c) => `<tr>
          <td>${esc(c.nombre)}</td><td>${esc(c.nif)}</td><td>${esc(c.poblacion)}</td>
          <td class="num">${fmtEUR(c.totalAnio)}</td>
          <td>${c.aviso347 ? '<span class="etiqueta pendiente">aviso 347</span>' : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`}
  `;
  document.getElementById('form-cliente').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = crypto.randomUUID();
    try {
      await api('POST', `/api/clientes/${id}`, {
        nombre: document.getElementById('c-nombre').value,
        nif: document.getElementById('c-nif').value,
        direccion: document.getElementById('c-direccion').value,
        cp: document.getElementById('c-cp').value,
        poblacion: document.getElementById('c-poblacion').value,
        provincia: document.getElementById('c-provincia').value,
        email: document.getElementById('c-email').value,
        vies: document.getElementById('c-vies').checked,
        intracomunitario: document.getElementById('c-vies').checked,
      });
      estado.clientes = await api('GET', '/api/clientes');
      renderRuta();
    } catch (err) { mostrarErrorFormulario(err); }
  });
});

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

ruta('/gastos', async () => {
  const anio = Number(new URLSearchParams(location.search).get('anio')) || anioActual();
  const gastos = await api('GET', `/api/gastos?anio=${anio}`);
  gastos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  $contenido.innerHTML = `
    <h2>Gastos</h2>
    <div class="barra-acciones">
      <label class="filtro-linea">Año <select id="g-anio">${opcionesAnios(anio)}</select></label>
      <div class="espaciador"></div>
      <button type="button" class="primario" id="btn-nuevo-gasto">Nuevo gasto (n)</button>
    </div>
    ${gastos.length === 0 ? '<div class="estado-vacio">Todavía no hay gastos en este año. Da de alta el primero con «Nuevo gasto».</div>' : `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Fecha</th><th>Proveedor</th><th>Concepto</th><th>Categoría</th><th class="num">Base</th><th class="num">IVA ded.</th><th class="num">IRPF ded.</th></tr></thead>
      <tbody>
        ${gastos.map((g) => `<tr>
          <td>${fmtFecha(g.fecha)}</td><td>${esc(g.proveedor)}</td><td>${esc(g.concepto)}</td>
          <td>${etiquetaCategoria(g.categoria)}</td>
          <td class="num">${fmtEUR(g.base)}</td>
          <td class="num">${fmtEUR(g.desglose.ivaDeducible)}</td>
          <td class="num">${fmtEUR(g.desglose.deducibleIrpf)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`}
  `;
  document.getElementById('g-anio').addEventListener('change', (e) => { location.hash = `#/gastos?anio=${e.target.value}`; });
  document.getElementById('btn-nuevo-gasto').addEventListener('click', () => { location.hash = '#/gastos/nueva'; });
});

function etiquetaCategoria(id) {
  return esc((CATEGORIAS_GASTO.find((c) => c[0] === id) || [id, id])[1]);
}

ruta('/gastos/nueva', async () => {
  $contenido.innerHTML = `
    <h2>Nuevo gasto</h2>
    <form id="form-gasto">
      <div class="fila-campos">
        <div class="campo"><label for="gf-fecha">Fecha</label><input id="gf-fecha" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="campo"><label for="gf-proveedor">Proveedor</label><input id="gf-proveedor"></div>
        <div class="campo"><label for="gf-nif">NIF proveedor</label><input id="gf-nif"></div>
      </div>
      <div class="campo"><label for="gf-concepto">Concepto</label><input id="gf-concepto" required></div>
      <div class="fila-campos">
        <div class="campo">
          <label for="gf-categoria">Categoría</label>
          <select id="gf-categoria">${CATEGORIAS_GASTO.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select>
        </div>
        <div class="campo"><label for="gf-base">Base €</label><input id="gf-base" type="number" step="0.01" value="0" required></div>
        <div class="campo"><label for="gf-tipoiva">Tipo IVA %</label><input id="gf-tipoiva" type="number" step="0.01" value="21"></div>
        <div class="campo"><label for="gf-cuotaiva">Cuota IVA €</label><input id="gf-cuotaiva" type="number" step="0.01" value="0"></div>
      </div>
      <div class="fila-campos">
        <div class="campo"><label for="gf-afectacion">% afecto a la actividad</label><input id="gf-afectacion" type="number" step="1" value="100"></div>
        <div class="campo" id="campo-iva-deducible"><label for="gf-ivaded">% de IVA deducible</label><input id="gf-ivaded" type="number" step="1" value="100"></div>
        <div class="campo"><label for="gf-pago">Forma de pago</label><input id="gf-pago"></div>
      </div>
      <p class="mensaje-info" id="nota-vivienda" hidden>
        Suministros de vivienda parcialmente afecta: el 30&nbsp;% de la parte proporcional afecta es deducible en IRPF.
        El IVA de estos suministros no se considera deducible (se ignora el campo de IVA deducible).
      </p>
      <div class="barra-acciones">
        <button type="submit" class="primario">Guardar gasto (Ctrl+S)</button>
        <a href="#/gastos">Cancelar (Esc)</a>
      </div>
    </form>
  `;
  const $categoria = document.getElementById('gf-categoria');
  const $notaVivienda = document.getElementById('nota-vivienda');
  const $campoIvaDed = document.getElementById('campo-iva-deducible');
  function alCambiarCategoria() {
    const esVivienda = $categoria.value === 'suministros_vivienda';
    $notaVivienda.hidden = !esVivienda;
    $campoIvaDed.hidden = esVivienda;
  }
  $categoria.addEventListener('change', alCambiarCategoria);
  alCambiarCategoria();

  document.getElementById('form-gasto').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/gastos', {
        fecha: document.getElementById('gf-fecha').value,
        proveedor: document.getElementById('gf-proveedor').value,
        nif: document.getElementById('gf-nif').value,
        concepto: document.getElementById('gf-concepto').value,
        categoria: $categoria.value,
        base: Number(document.getElementById('gf-base').value),
        tipoIva: Number(document.getElementById('gf-tipoiva').value),
        cuotaIva: Number(document.getElementById('gf-cuotaiva').value),
        afectacionPct: Number(document.getElementById('gf-afectacion').value),
        ivaDeduciblePct: Number(document.getElementById('gf-ivaded').value),
        formaPago: document.getElementById('gf-pago').value,
      });
      location.hash = '#/gastos';
    } catch (err) { mostrarErrorFormulario(err); }
  });
});

// ---------------------------------------------------------------------------
// Inversiones (bienes)
// ---------------------------------------------------------------------------

ruta('/inversiones', async () => {
  const bienes = await api('GET', '/api/bienes');
  const anio = anioActual();
  const amortizaciones = await Promise.all(bienes.map((b) => api('GET', `/api/bienes/${b.id}/amortizacion?anio=${anio}`)));
  $contenido.innerHTML = `
    <h2>Inversiones</h2>
    <div class="barra-acciones">
      <div class="espaciador"></div>
      <button type="button" class="primario" id="btn-nuevo-bien">Nuevo bien (n)</button>
    </div>
    ${bienes.length === 0 ? '<div class="estado-vacio">Todavía no hay bienes de inversión. Da de alta el primero con «Nuevo bien».</div>' : `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th class="num">Base</th><th class="num">Coef. %</th><th class="num">Amort. ${anio}</th><th class="num">Pendiente</th></tr></thead>
      <tbody>
        ${bienes.map((b, i) => `<tr>
          <td>${fmtFecha(b.fecha)}</td><td>${esc(b.descripcion)}</td>
          <td>${esc((TABLA_AMORTIZACION.find((t) => t.id === b.categoria) || {}).nombre || b.categoria)}</td>
          <td class="num">${fmtEUR(b.base)}</td><td class="num">${b.coef}</td>
          <td class="num">${fmtEUR(amortizaciones[i].anual)}</td>
          <td class="num">${fmtEUR(amortizaciones[i].pendiente)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`}
  `;
  document.getElementById('btn-nuevo-bien').addEventListener('click', () => { location.hash = '#/inversiones/nuevo'; });
});

ruta('/inversiones/nuevo', async () => {
  $contenido.innerHTML = `
    <h2>Nuevo bien de inversión</h2>
    <form id="form-bien">
      <div class="fila-campos">
        <div class="campo"><label for="bf-fecha">Fecha de alta</label><input id="bf-fecha" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="campo"><label for="bf-descripcion">Descripción</label><input id="bf-descripcion" required></div>
      </div>
      <div class="fila-campos">
        <div class="campo"><label for="bf-proveedor">Proveedor</label><input id="bf-proveedor"></div>
        <div class="campo"><label for="bf-nif">NIF proveedor</label><input id="bf-nif"></div>
      </div>
      <div class="fila-campos">
        <div class="campo">
          <label for="bf-categoria">Categoría de amortización</label>
          <select id="bf-categoria">${TABLA_AMORTIZACION.map((t) => `<option value="${t.id}" data-coef="${t.coef}">${esc(t.nombre)} (máx. ${t.coef}%)</option>`).join('')}</select>
        </div>
        <div class="campo"><label for="bf-coef">Coeficiente aplicado %</label><input id="bf-coef" type="number" step="0.01" value="${TABLA_AMORTIZACION[0].coef}"></div>
      </div>
      <div class="fila-campos">
        <div class="campo"><label for="bf-base">Base €</label><input id="bf-base" type="number" step="0.01" value="0" required></div>
        <div class="campo"><label for="bf-cuotaiva">Cuota IVA €</label><input id="bf-cuotaiva" type="number" step="0.01" value="0"></div>
        <div class="campo"><label for="bf-afectacion">% afecto a la actividad</label><input id="bf-afectacion" type="number" step="1" value="100"></div>
      </div>
      <div class="barra-acciones">
        <button type="submit" class="primario">Guardar bien (Ctrl+S)</button>
        <a href="#/inversiones">Cancelar (Esc)</a>
      </div>
    </form>
  `;
  const $categoria = document.getElementById('bf-categoria');
  const $coef = document.getElementById('bf-coef');
  $categoria.addEventListener('change', () => { $coef.value = $categoria.selectedOptions[0].dataset.coef; });

  document.getElementById('form-bien').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/bienes', {
        fecha: document.getElementById('bf-fecha').value,
        descripcion: document.getElementById('bf-descripcion').value,
        proveedor: document.getElementById('bf-proveedor').value,
        nif: document.getElementById('bf-nif').value,
        categoria: $categoria.value,
        coef: Number($coef.value),
        base: Number(document.getElementById('bf-base').value),
        cuotaIva: Number(document.getElementById('bf-cuotaiva').value),
        afectacionPct: Number(document.getElementById('bf-afectacion').value),
      });
      location.hash = '#/inversiones';
    } catch (err) { mostrarErrorFormulario(err); }
  });
});

// ---------------------------------------------------------------------------
// Libros registro
// ---------------------------------------------------------------------------

ruta('/libros', async () => {
  const anio = anioActual();
  $contenido.innerHTML = `
    <h2>Libros registro</h2>
    <div class="campo campo-estrecho"><label for="l-anio">Año</label><select id="l-anio">${opcionesAnios(anio)}</select></div>
    <div class="bloque">
      <h3>Ventas e ingresos</h3>
      <p class="mensaje-info">Facturas confirmadas del año, columnas del art. 68 del Reglamento del IRPF.</p>
      <button type="button" id="btn-ventas">Descargar CSV</button>
    </div>
    <div class="bloque">
      <h3>Compras y gastos</h3>
      <button type="button" id="btn-compras">Descargar CSV</button>
    </div>
    <div class="bloque">
      <h3>Bienes de inversión</h3>
      <button type="button" id="btn-bienes">Descargar CSV</button>
    </div>
  `;
  const $anio = document.getElementById('l-anio');
  document.getElementById('btn-ventas').addEventListener('click', () => descargar(`/api/libros/ventas.csv?anio=${$anio.value}`));
  document.getElementById('btn-compras').addEventListener('click', () => descargar(`/api/libros/compras.csv?anio=${$anio.value}`));
  document.getElementById('btn-bienes').addEventListener('click', () => descargar(`/api/libros/bienes.csv?anio=${$anio.value}`));
});

// ---------------------------------------------------------------------------
// Impuestos
// ---------------------------------------------------------------------------

function trimestreActual() {
  return Math.floor(new Date().getMonth() / 3) + 1;
}

ruta('/impuestos', async () => {
  const q = new URLSearchParams(location.search);
  const anio = Number(q.get('anio')) || anioActual();
  const trimestre = Number(q.get('trimestre')) || trimestreActual();

  const [r303, r130, plazos] = await Promise.all([
    api('GET', `/api/impuestos/303?anio=${anio}&trimestre=${trimestre}`),
    api('GET', `/api/impuestos/130?anio=${anio}&trimestre=${trimestre}`),
    api('GET', `/api/impuestos/plazos?anio=${anio}`),
  ]);

  $contenido.innerHTML = `
    <h2>Impuestos</h2>
    <div class="barra-acciones">
      <label class="filtro-linea">Año <select id="i-anio">${opcionesAnios(anio)}</select></label>
      <label class="filtro-linea">Trimestre <select id="i-trimestre">${[1, 2, 3, 4].map((t) => `<option value="${t}" ${t === trimestre ? 'selected' : ''}>${t}T</option>`).join('')}</select></label>
    </div>

    <div class="bloque">
      <h3>Modelo 303 — IVA (${trimestre}T ${anio})</h3>
      ${bloqueCasillas303(r303)}
      <div class="barra-acciones"><button type="button" id="btn-presentar-303" ${estado.soloLectura ? 'disabled' : ''}>Marcar como presentado</button></div>
    </div>

    ${estado.config.presenta130 ? `
    <div class="bloque">
      <h3>Modelo 130 — Pago fraccionado IRPF (${trimestre}T ${anio})</h3>
      ${bloqueCasillas130(r130)}
      <div class="barra-acciones"><button type="button" id="btn-presentar-130" ${estado.soloLectura ? 'disabled' : ''}>Marcar como presentado</button></div>
    </div>` : `
    <details class="avanzado">
      <summary>Cálculo informativo del 130 (no obligatorio según ajustes)</summary>
      ${bloqueCasillas130(r130)}
    </details>`}

    <div class="bloque">
      <h3>Plazos</h3>
      ${plazos.map((p) => `<div class="casilla"><span>${esc(p.modelo)} — ${esc(p.periodo)}</span><span class="valor ${p.diasRestantes >= 0 && p.diasRestantes <= 15 ? 'a-ingresar' : ''}">${esc(p.limite)} (${p.diasRestantes >= 0 ? `${p.diasRestantes} días` : 'pasado'})</span></div>`).join('')}
    </div>
  `;

  document.getElementById('i-anio').addEventListener('change', (e) => { location.hash = `#/impuestos?anio=${e.target.value}&trimestre=${trimestre}`; });
  document.getElementById('i-trimestre').addEventListener('change', (e) => { location.hash = `#/impuestos?anio=${anio}&trimestre=${e.target.value}`; });
  document.getElementById('btn-presentar-303')?.addEventListener('click', () => presentar('303', anio, trimestre));
  document.getElementById('btn-presentar-130')?.addEventListener('click', () => presentar('130', anio, trimestre));

  async function presentar(modelo, anio, trimestre) {
    if (!confirm(`¿Marcar el modelo ${modelo} de ${trimestre}T ${anio} como presentado? Alimentará el arrastre del trimestre siguiente.`)) return;
    try { await api('POST', `/api/impuestos/${modelo}/presentar`, { anio, trimestre }); renderRuta(); }
    catch (err) { alert(err.message); }
  }
});

function bloqueCasillas303(r) {
  const c = r.casillas;
  const filas = [
    ['07', 'Base al 21%', c['07']], ['09', 'Cuota devengada 21%', c['09']], ['27', 'Total cuota devengada', c['27']],
    ['28', 'Base op. corrientes deducible', c['28']], ['29', 'Cuota IVA deducible op. corrientes', c['29']],
    ['30', 'Base bienes de inversión deducible', c['30']], ['31', 'Cuota IVA deducible bienes inversión', c['31']],
    ['45', 'Total a deducir', c['45']], ['46', 'Resultado régimen general', c['46']],
    ['110', 'Compensación de cuotas anteriores', c['110']], ['78', 'A compensar en periodos futuros', c['78']],
    ['71', 'Resultado de la liquidación', c['71']],
  ];
  return filas.map(([n, etiqueta, valor]) => filaCasilla(n, etiqueta, valor, n === '71')).join('');
}

function bloqueCasillas130(r) {
  const c = r.casillas;
  const filas = [
    ['01', 'Ingresos íntegros acumulados', c['01']], ['02', 'Gastos deducibles acumulados', c['02']],
    ['03', 'Rendimiento neto', c['03']], ['04', '20% del rendimiento neto', c['04']],
    ['05', 'Pagos fraccionados trimestres anteriores', c['05']], ['06', 'Retenciones soportadas', c['06']],
    ['07', 'Diferencia (04-05-06)', c['07']], ['13', 'Minoración por rendimientos bajos', c['13']],
    ['14', 'Resultado tras minoración', c['14']], ['15', 'Negativos de trimestres anteriores', c['15']],
    ['16', 'Deducción vivienda anterior a 2013', c['16']], ['17', 'Resultado del pago fraccionado', c['17']],
  ];
  return filas.map(([n, etiqueta, valor]) => filaCasilla(n, etiqueta, valor, n === '17')).join('');
}

function filaCasilla(numero, etiqueta, valor, esResultado) {
  const aIngresar = esResultado && Number(valor) > 0;
  return `<div class="casilla">
    <span><span class="num-casilla">[${numero}]</span> ${esc(etiqueta)}</span>
    <span class="valor ${aIngresar ? 'a-ingresar' : ''}">${fmtEUR(valor)}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

ruta('/ajustes', async () => {
  const c = await api('GET', '/api/config');
  $contenido.innerHTML = `
    <h2>Ajustes</h2>
    <form id="form-ajustes">
      <div class="bloque">
        <h3>Emisor</h3>
        <div class="fila-campos">
          <div class="campo"><label for="a-nombre">Nombre</label><input id="a-nombre" value="${esc(c.emisor.nombre)}"></div>
          <div class="campo"><label for="a-nif">NIF</label><input id="a-nif" value="${esc(c.emisor.nif)}"></div>
        </div>
        <div class="fila-campos">
          <div class="campo"><label for="a-direccion">Dirección</label><input id="a-direccion" value="${esc(c.emisor.direccion)}"></div>
          <div class="campo"><label for="a-cp">CP</label><input id="a-cp" value="${esc(c.emisor.cp)}"></div>
          <div class="campo"><label for="a-poblacion">Población</label><input id="a-poblacion" value="${esc(c.emisor.poblacion)}"></div>
          <div class="campo"><label for="a-provincia">Provincia</label><input id="a-provincia" value="${esc(c.emisor.provincia)}"></div>
        </div>
        <div class="fila-campos">
          <div class="campo"><label for="a-email">Email</label><input id="a-email" type="email" value="${esc(c.emisor.email)}"></div>
          <div class="campo"><label for="a-telefono">Teléfono</label><input id="a-telefono" value="${esc(c.emisor.telefono)}"></div>
          <div class="campo"><label for="a-iban">IBAN</label><input id="a-iban" value="${esc(c.emisor.iban)}"></div>
        </div>
        <div class="campo"><label for="a-epigrafe">Epígrafe IAE</label><input id="a-epigrafe" value="${esc(c.emisor.epigrafe)}"></div>
      </div>

      <div class="bloque">
        <h3>Facturación</h3>
        <div class="fila-campos">
          <div class="campo"><label for="a-serie">Serie ordinaria</label><input id="a-serie" value="${esc(c.serie)}"></div>
          <div class="campo"><label for="a-serie-r">Serie rectificativa</label><input id="a-serie-r" value="${esc(c.serieRectificativa)}"></div>
          <div class="campo"><label for="a-tipoiva">IVA por defecto %</label><input id="a-tipoiva" type="number" step="0.01" value="${c.tipoIva}"></div>
          <div class="campo"><label for="a-tipoirpf">IRPF por defecto %</label><input id="a-tipoirpf" type="number" step="0.01" value="${c.tipoIrpf}"></div>
          <div class="campo"><label for="a-vencimiento">Vencimiento (días)</label><input id="a-vencimiento" type="number" value="${c.vencimientoDias}"></div>
        </div>
        <label><input id="a-presenta130" type="checkbox" ${c.presenta130 ? 'checked' : ''}> Presenta modelo 130</label>
      </div>

      <details class="avanzado">
        <summary>Ajustes avanzados</summary>
        <div class="fila-campos">
          <div class="campo"><label for="a-pct130">% del 130</label><input id="a-pct130" type="number" step="0.01" value="${c.avanzado.porcentaje130}"></div>
          <div class="campo"><label for="a-rendanterior">Rendimiento ejercicio anterior €</label><input id="a-rendanterior" type="number" step="0.01" value="${c.avanzado.rendimientoEjercicioAnterior}"></div>
          <div class="campo"><label for="a-saldoiva">Saldo de IVA inicial €</label><input id="a-saldoiva" type="number" step="0.01" value="${c.avanzado.saldoIvaInicial}"></div>
          <div class="campo"><label for="a-aniostart">Año de inicio de actividad</label><input id="a-aniostart" type="number" value="${c.avanzado.anioInicioActividad}"></div>
        </div>
      </details>

      <div class="barra-acciones">
        <button type="submit" class="primario">Guardar ajustes (Ctrl+S)</button>
      </div>
    </form>

    <div class="bloque">
      <h3>Copia de seguridad</h3>
      <div class="barra-acciones">
        <button type="button" id="btn-exportar">Exportar todo a JSON</button>
        <label class="no-imprimir filtro-linea">
          <button type="button" id="btn-importar-elegir">Importar JSON</button>
          <input id="input-importar" type="file" accept="application/json" hidden>
        </label>
      </div>
      <p class="mensaje-info">Importar sobrescribe los datos actuales (se guarda una copia previa automáticamente en el servidor).</p>
    </div>
  `;

  document.getElementById('form-ajustes').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const nuevo = await api('PUT', '/api/config', {
        emisor: {
          nombre: val('a-nombre'), nif: val('a-nif'), direccion: val('a-direccion'), cp: val('a-cp'),
          poblacion: val('a-poblacion'), provincia: val('a-provincia'), email: val('a-email'),
          telefono: val('a-telefono'), iban: val('a-iban'), epigrafe: val('a-epigrafe'),
        },
        serie: val('a-serie'), serieRectificativa: val('a-serie-r'),
        tipoIva: Number(val('a-tipoiva')), tipoIrpf: Number(val('a-tipoirpf')),
        vencimientoDias: Number(val('a-vencimiento')),
        presenta130: document.getElementById('a-presenta130').checked,
        avanzado: {
          porcentaje130: Number(val('a-pct130')), rendimientoEjercicioAnterior: Number(val('a-rendanterior')),
          saldoIvaInicial: Number(val('a-saldoiva')), anioInicioActividad: Number(val('a-aniostart')),
        },
      });
      estado.config = nuevo;
      alert('Ajustes guardados.');
    } catch (err) { mostrarErrorFormulario(err); }
  });

  function val(id) { return document.getElementById(id).value; }

  document.getElementById('btn-exportar').addEventListener('click', () => descargar('/api/exportar'));
  document.getElementById('btn-importar-elegir').addEventListener('click', () => document.getElementById('input-importar').click());
  document.getElementById('input-importar').addEventListener('change', async (ev) => {
    const archivo = ev.target.files[0];
    if (!archivo) return;
    if (!confirm('Esto sobrescribe todos los datos actuales con el contenido del fichero. ¿Continuar?')) { ev.target.value = ''; return; }
    try {
      const texto = await archivo.text();
      const datos = JSON.parse(texto);
      const resultado = await api('POST', '/api/importar', datos);
      estado.soloLectura = resultado.soloLectura;
      estado.motivos = resultado.motivos || [];
      actualizarAvisoSoloLectura();
      alert('Importación completada.');
      location.hash = '#/facturas';
    } catch (err) {
      alert('No se pudo importar: ' + err.message);
    } finally {
      ev.target.value = '';
    }
  });
});

arrancar();
