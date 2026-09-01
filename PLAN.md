# Plan — Aplicación de facturación y contabilidad (autónomo España)

## Contexto

El usuario (autónomo, epígrafe 763, alta en RETA desde el 1/9/2026) necesita una
app de facturación y contabilidad que corra en un VPS de Hetzner, sin dependencias
npm, con persistencia solo en servidor (nunca `localStorage`) para poder trabajar
desde casa y desde la oficina viendo siempre el mismo estado. El encargo
(`encargo-facturacion.md`) ya fija con mucho detalle las reglas de negocio, el
modelo de datos, y da dos módulos completos y ya probados —`lib/fiscal.js`
(cálculo fiscal) y `lib/store.js` (persistencia JSON con colas por colección)—
que hay que usar tal cual, sin tocar su lógica. El motivo: un error en el cálculo
fiscal o en la numeración de facturas tiene consecuencias económicas y legales
reales (Reglamento de facturación, preparación de VeriFactu).

Este plan cubre todo lo que hay que construir desde cero alrededor de esos dos
módulos: servidor HTTP puro, autenticación, rutas API, frontend sin build,
pruebas y despliegue.

## Decisiones de arquitectura (con justificación)

1. **CommonJS en todo el backend**, no ESM. `lib/fiscal.js` y `lib/store.js` usan
   `require`/`module.exports`; mezclar `"type":"module"` en `package.json`
   obligaría a tocar esos ficheros (renombrarlos `.cjs` o reescribir los
   `require`), lo que el encargo prohíbe explícitamente. `package.json` sin
   campo `type` (por defecto CommonJS), solo con `engines.node >= 22`. El
   frontend en `public/js` usa `<script type="module">` de forma independiente
   —es JS de navegador, no tiene relación con el sistema de módulos de Node—.

2. **Vista de impresión y login integrados en la misma SPA**, no páginas nuevas.
   El encargo (§5 y §12) es explícito: la vista de impresión es `impresion.css`
   con `@media print` sobre la propia interfaz, y el árbol de entrega solo lista
   `index.html` + `app.js` + `estilos.css` + `impresion.css`, sin páginas
   adicionales. El login es un estado más de `app.js` (si `GET /api/sesion`
   devuelve 401, se renderiza el formulario de acceso en el mismo `index.html`);
   la vista de detalle de factura se renderiza igual en pantalla y en impresión,
   y `impresion.css` oculta la navegación y el cromo de la app y ajusta layout a
   A4 solo dentro de `@media print`.

3. **`server.js` único punto de entrada, testable sin subproceso.** Expone
   `crearApp(opciones)` que devuelve el manejador de peticiones (sin `.listen()`)
   y usa el patrón estándar de Node `if (require.main === module) { ...arranca... }`
   para que `node server.js` funcione normal y `test/api.test.js` pueda hacer
   `require('../server.js').crearApp({...})` y levantar un puerto efímero sin
   pasar por CLI. Dentro de `lib/` se admite dividir los grupos de rutas en
   módulos pequeños (`lib/rutas-facturas.js`, etc.) si `server.js` se vuelve
   inabarcable en un solo fichero — es una cuestión de mantenibilidad interna,
   no cambia el comportamiento ni el árbol de entrega visible.

4. **Sin TLS en Node.** El encargo (§8) ya resuelve HTTPS con
   `tailscale serve --bg 8080`, que hace terminación TLS y reenvía en HTTP plano
   al puerto local. El servidor Node solo escucha HTTP en `127.0.0.1:8080`; no
   hace falta `https.createServer` ni `tailscale cert` en la app. La cookie de
   sesión con `Secure` funciona igual porque el navegador solo ve la conexión
   HTTPS de Tailscale.

5. **Numeración y cadena de huellas atómicas mediante colas anidadas de `Store`.**
   Confirmar una factura ocurre dentro de un único `Store.actualizar('facturas', fn)`;
   dentro de `fn` se anida `Store.actualizar('config', fnConfig)` para reservar
   `orden`/`numero` y actualizar `ultimaHuella`. Como la cola de `config` solo se
   entra desde dentro de la cola de `facturas`, y esta última procesa una
   petición a la vez, ambas colecciones avanzan en el mismo orden estricto sin
   lock adicional. Regla de oro: todo lo que pueda lanzar (factura no existe, no
   es borrador, cliente no existe, líneas inválidas, `soloLectura`) se valida
   **antes** de reservar número; a partir de ahí no puede haber excepciones, para
   que nunca quede un contador avanzado sin factura escrita.

6. **Modo solo lectura.** Al arrancar: `verificarCadena(facturas)` +
   comprobación de que `siguienteNumero-1`/`siguienteRectificativa-1` coincide
   con el nº de confirmadas de cada serie. Si algo no cuadra, `soloLectura=true`
   en memoria; middleware de escritura en rutas de facturas devuelve `423` para
   cualquier operación que modifique la colección (crear/editar borrador,
   confirmar, rectificar, marcar cobrada). Lectura, libros e impuestos siguen
   funcionando. El aviso se muestra en rojo en pantalla principal (según §9).

## Correcciones a nombres de campos exigidos por `fiscal.js`

`huellaFactura(f, huellaAnterior)` lee literalmente `f.nifEmisor`, `f.numero`,
`f.fecha`, `f.tipo`, `f.cuotaIva`, `f.total`, `f.generadaEn`. Al confirmar:

- `numero` es el **string final** `"A-0001"` (serie + `siguienteNumero`/
  `siguienteRectificativa` con `padStart(4,'0')`), no el contador crudo.
- `tipo` es `'F1'` (ordinaria) o `'R1'` (rectificativa), separado de `serie`
  (`'A'`/`'R'`, decide qué contador usar).
- `nifEmisor` se copia de `config.emisor.nif` en el momento de confirmar.
- `generadaEn` es ISO **con huso horario** (offset local, no `Z` de UTC) —
  pequeño helper propio, ya que `Date.toISOString()` siempre da `Z`.
- `rectificaA` guarda el `id` de la factura original (nombre exacto del
  encargo §3, no inventar `facturaOriginalId`).
- `modelo303`/`modelo130`/exportación CSV de libros deben recibir solo
  facturas con `estado==='confirmada'` — los borradores no son eventos
  fiscales y `fiscal.js` no distingue borrador/confirmada por sí mismo (solo
  entiende `anulada`, que esta app nunca usa).

## Estructura de entrega

Sigo el árbol exacto del encargo §12, permitiendo solo módulos internos extra
bajo `lib/` si hacen falta por mantenibilidad (no en `public/`, `test/` ni
`deploy/`, que se mantienen tal cual se listan):

```
facturacion/
├── server.js                # crearApp() + arranque CLI (--set-password / listen)
├── package.json             # sin "type" (CommonJS), engines.node >=22
├── lib/
│   ├── fiscal.js            # dado, sin tocar
│   ├── store.js             # dado, sin tocar
│   ├── auth.js              # scrypt, sesión HMAC, prompt oculto de contraseña
│   └── (opcional) rutas-*.js  # división interna si server.js crece demasiado
├── public/
│   ├── index.html
│   ├── app.js
│   ├── estilos.css
│   └── impresion.css
├── test/
│   ├── fiscal.test.js
│   └── api.test.js          # incluye pruebas de auth y de concurrencia
├── deploy/
│   ├── facturacion.service
│   ├── backup.service
│   ├── backup.timer
│   ├── instalar.sh
│   └── README-despliegue.md
└── README.md
```

## `lib/auth.js`

- `auth.json` en la raíz del proyecto (configurable con `FACTURACION_AUTH_FILE`),
  **fuera** de `FACTURACION_DATA`: si viviera dentro, un `Store.importar()` de un
  backup de otro entorno sobrescribiría credenciales de producción, y un
  `Store.exportar()` filtraría el hash. Formato:
  `{ scrypt: {saltHex, hashHex, N, r, p, keylen}, sesionSecretoHex, creado }`.
- `node server.js --set-password`: pide contraseña dos veces, sin eco, con
  `process.stdin.setRawMode(true)` (API pública documentada de TTY, más robusta
  que hackear el interno `_writeToOutput` de `readline`), mínimo 12 caracteres,
  genera salt + hash scrypt + secreto de sesión, escribe `auth.json`. Si el
  servidor arranca en modo normal sin `auth.json`, falla con mensaje claro.
- Comparación con `crypto.timingSafeEqual`. Cookie de sesión:
  payload base64url (`{exp}`) + `.` + firma HMAC-SHA256 base64url,
  `HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=43200`.
- Rate limiting de login en memoria por IP (`Map`), backoff exponencial tras 5
  fallos, tope 5 min, limpieza periódica de entradas viejas.

## Rutas API (todas bajo `/api/`, todas requieren sesión salvo `/api/login`)

- **Sesión**: `POST /api/login` `{password}` → cookie + `200`; `GET /api/sesion`
  → `200`/`401` (usado por `app.js` para decidir si mostrar login o app).
- **Clientes**: `GET /api/clientes?anio=` (incluye `totalAnio`/`aviso347`
  calculados, no persistidos), `POST/PUT /api/clientes/:id`. No hay borrado real
  de clientes referenciados por facturas confirmadas (por el snapshot, borrar no
  rompe nada, pero se puede desactivar en vez de borrar).
- **Facturas**: `GET /api/facturas?anio=&trimestre=&clienteId=&cobrada=`,
  `POST /api/facturas` (crea borrador), `PUT /api/facturas/:id` (solo si
  `estado==='borrador'`), `POST /api/facturas/previsualizar` (llama a
  `calcularFactura` sin persistir, para que el navegador nunca calcule importes
  fiscales), `POST /api/facturas/:id/confirmar`, `POST /api/facturas/:id/rectificar`
  `{tipo:'total'|'parcial', importe?}` (crea un nuevo **borrador** `R1` con
  `rectificaA`, que sigue el mismo flujo de confirmación), `POST /api/facturas/:id/cobrar`
  `{fecha}`.
- **Gastos**: `GET/POST /api/gastos`, con `desgloseGasto` aplicado en cada
  respuesta para mostrar el desglose IRPF/IVA.
- **Bienes**: `GET/POST /api/bienes`, `GET /api/bienes/:id/amortizacion` (usa
  `amortizacionEjercicio`).
- **Libros**: `GET /api/libros/{ventas,compras,bienes}.csv` (solo facturas/gastos
  confirmados, columnas del art. 68 RIRPF).
- **Impuestos**: `GET /api/impuestos/303?anio=&trimestre=` (usa
  `saldoPendiente` de la última `presentacion` de ese modelo),
  `GET /api/impuestos/130?anio=&trimestre=` (siempre calcula, devuelve
  `oculto: !config.presenta130` — el frontend decide plegar, el servidor nunca
  omite el cálculo), `POST /api/impuestos/:modelo/presentar` (escribe en
  `presentaciones`), `GET /api/impuestos/plazos`.
- **Ajustes**: `GET/PUT /api/config` (incluye bloque `avanzado`),
  `GET /api/exportar`, `POST /api/importar`.

Avisos incluidos en las respuestas (no solo en frontend, para que sean
auditables independientemente del cliente HTTP): factura de cliente con
`vies:true` → aviso de que la exención intracomunitaria no se aplica
automáticamente; cliente que supera 3.005,06 €/año → aviso de modelo 347 (sin
generarlo).

## Frontend (`public/`)

- `index.html` + `app.js` como SPA de una sola página con enrutado por hash
  hecho a mano (sin librería), estado de trabajo solo en memoria de módulo
  (nunca `localStorage`/`sessionStorage` — cada vista repide datos frescos al
  servidor). Secciones: Facturas, Gastos, Inversiones, Libros, Impuestos,
  Ajustes, más el estado de login.
- Formularios nativos (`<form>`, `<table>`, `tabindex`) para que `Enter`/`Esc`/
  navegación por teclado funcionen gratis; atajos explícitos para nueva
  factura, nuevo gasto, guardar.
- `estilos.css`: paleta sobria, tablas densas, tipografía monoespaciada para
  importes, único color de acento, rojo reservado para "a ingresar" y cadena de
  huellas rota, `prefers-reduced-motion` respetado.
- `impresion.css`: `@media print` sobre la vista de detalle de factura —
  `@page { size:A4; margin:20mm }`, oculta nav/botones, muestra los datos
  obligatorios del art. 6 del Reglamento de facturación. Sin librerías de PDF;
  el navegador genera el PDF con `window.print()`.
- CSP sin `unsafe-inline`: nada de `onclick=""` ni `<style>` embebido; todo el
  JS en `app.js` (o módulos que importa), estilos dinámicos vía `el.style.prop`
  desde JS cuando sea imprescindible.

## Pruebas (`node:test`)

- `test/fiscal.test.js`: los casos exactos del encargo §10 (factura, 303, 130,
  arrastre de saldo IVA, amortización, cadena de huellas rota) con
  `assert.strictEqual`/`deepStrictEqual`.
- `test/api.test.js`: usa `crearApp({puerto:0, dataDir: tmp, authFile: tmpAuth})`
  sobre un directorio temporal; genera `auth.json` de prueba llamando
  directamente a las funciones de `lib/auth.js` (sin prompt interactivo).
  Cubre: login correcto/incorrecto, 401 sin cookie, 429 tras 5 fallos, CRUD de
  clientes/gastos/bienes, ciclo completo borrador→confirmar→rectificar,
  modo solo lectura si se corrompe la cadena, y la prueba obligatoria de **100
  altas concurrentes** (`Promise.all` de 100 confirmaciones en paralelo, luego
  comprobar `numero`/`orden` 1..100 sin huecos ni duplicados y
  `verificarCadena` en verde).

## Despliegue (`deploy/`)

- `facturacion.service`: usuario dedicado sin shell, `WorkingDirectory`,
  `Environment=PORT/HOST=127.0.0.1/FACTURACION_DATA`, endurecido
  (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `ReadWritePaths` limitado al directorio de datos), `Restart=always`.
- `backup.service`/`backup.timer`: diario a las 03:00, `Store.backup()` +
  poda a 30 copias.
- `instalar.sh`: idempotente — crea usuario, copia ficheros, prepara
  `/var/lib/facturacion`, instala unidades, las arranca; recuerda ejecutar
  `--set-password` antes de arrancar el servicio.
- `README-despliegue.md`: `ufw default deny incoming` + permitir SSH y
  `tailscale0`, instalar Tailscale, `tailscale serve --bg 8080` (sin cert ni
  TLS en Node, ver decisión 4), instalar Tailscale en portátil y equipo de
  oficina, comprobar que el puerto no responde desde la IP pública. Nota final
  sobre la alternativa con dominio + Caddy si más adelante no quieren instalar
  Tailscale en cada máquina.

## Orden de implementación

1. Scaffold (`package.json` CommonJS, copiar `lib/fiscal.js`/`lib/store.js` sin
   tocar) + `test/fiscal.test.js` primero, para validar el módulo de mayor
   riesgo antes de construir nada encima.
2. `lib/auth.js` (hash, sesión, prompt oculto).
3. `server.js`: utilidades HTTP internas (parseo body/cookies, respuesta JSON,
   servir estáticos sin path traversal, cabeceras de seguridad), router
   mínimo, middleware de sesión, arranque con `verificarCadena` + comprobación
   de contadores.
4. Rutas en este orden: clientes → facturas (incluye el bloque crítico de
   numeración/huella y `previsualizar`) → gastos → bienes → libros (CSV) →
   impuestos → ajustes.
5. `test/api.test.js`, incluida la prueba de concurrencia.
6. Frontend: esqueleto de `index.html`/`app.js` con login inline, luego una
   vista por dominio en el mismo orden que las rutas, luego el layout de
   impresión con `impresion.css`.
7. `deploy/` y `README.md` raíz (incluye la nota de qué falta para VeriFactu
   completo y el aviso de modelo 347/390 fuera de alcance, según §11).
8. Repaso final contra el encargo: checklist de reglas de negocio innegociables
   (§4), seguridad (§7), diseño de interfaz (§9).

## Verificación

- `node --test test/` debe pasar en verde, incluyendo los valores exactos del
  encargo §10 y la prueba de 100 altas concurrentes.
- Arrancar `node server.js --set-password`, luego `node server.js` y probar a
  mano: login, alta de cliente, alta y confirmación de factura (comprobar
  numeración y huella), marcar cobrada, alta de gasto de suministros de
  vivienda (comprobar el desglose 30%/sin IVA), alta de bien de inversión y
  cuadro de amortización, exportar libros CSV, ver 303/130 del trimestre con
  casillas visibles, exportar/importar JSON completo, y forzar una rotura de
  cadena de huellas editando a mano el fichero `facturas.json` para comprobar
  que el servidor arranca en modo solo lectura y lo muestra en rojo.
