# Estado del proyecto

Este fichero existe para poder continuar el desarrollo en otra sesión sin
perder contexto. El plan completo y aprobado está en [PLAN.md](PLAN.md); el
encargo original está en [encargo-facturacion.md](encargo-facturacion.md).

## Hecho

- [x] `lib/fiscal.js` — copiado tal cual del encargo, sin modificar.
- [x] `lib/store.js` — copiado tal cual del encargo, sin modificar.
- [x] `package.json` — CommonJS (sin `"type":"module"`), `engines.node >= 22`.
- [x] `.gitignore` — excluye `datos/`, `auth.json`, `node_modules/`.
- [x] `PLAN.md` — plan técnico completo con todas las decisiones de
      arquitectura ya tomadas (ver ese fichero para el detalle).
- [x] Repositorio git inicializado y subido a
      https://github.com/Javiloaisa/programa-facturacion.git
- [x] `test/fiscal.test.js` — 12 casos con los valores exactos del encargo
      §10 (factura, modelo 303, modelo 130, arrastre de saldo de IVA,
      amortización con prorrateo por días, cadena de huellas). Todos pasan
      sin tocar `lib/fiscal.js`. De paso se corrigió el script `test` de
      `package.json`: `node --test test/` da `MODULE_NOT_FOUND` en esta
      instalación de Node (v24.15.0, Windows) tanto en bash como en
      PowerShell; `node --test` sin argumento (autodescubrimiento) sí
      funciona y es lo que usa ahora `npm test`.
- [x] `lib/auth.js` — hash scrypt con sal + `timingSafeEqual`, `auth.json`
      fuera de `FACTURACION_DATA`, cookie de sesión firmada HMAC-SHA256
      (12h), rate limiting de login en memoria por IP (backoff exponencial
      tras 5 fallos, tope 5 min, limpieza perezosa), prompt de contraseña
      oculto con `process.stdin.setRawMode(true)` para `--set-password`.
      Probado manualmente y ahora también cubierto por `test/api.test.js`
      (ver más abajo).
- [x] `server.js` + `lib/http-utils.js` — `crearApp(opciones)` testable sin
      `.listen()` propio, router mínimo por regex, cabeceras de seguridad,
      sesión obligatoria en toda `/api/` salvo `/api/login`, modo solo
      lectura (423 solo en escritura de facturas), y todas las rutas de
      PLAN.md → "Rutas API" (clientes, facturas con numeración/huella
      atómicas + previsualizar/rectificar/cobrar, gastos, bienes, libros
      CSV, impuestos 303/130 + presentar + plazos, config protegido,
      exportar/importar). CLI con `--set-password` y arranque normal.
- [x] `test/api.test.js` — 40 tests en total (fiscal + API) en verde,
      incluida la prueba obligatoria de 100 altas de factura concurrentes
      sin huecos ni duplicados, el rate limiting de login (429 tras 5
      fallos), y el modo solo lectura al corromper a mano una huella.

## Pendiente (en este orden, según PLAN.md → "Orden de implementación")

1. Frontend (`public/index.html`, `public/app.js`, `public/estilos.css`,
   `public/impresion.css`) — SPA de una sola página, sin build, sin
   `localStorage`. Login como estado de la propia SPA, impresión vía
   `@media print` en `impresion.css` (NO páginas separadas).
2. `deploy/` (systemd + Tailscale) y `README.md` raíz (incluye qué falta
   para VeriFactu completo y el aviso del modelo 347, ambos fuera de
   alcance según encargo §11).
3. Repaso final contra el encargo: reglas de negocio innegociables (§4),
   autenticación (§7), diseño de interfaz (§9).

## Decisiones ya cerradas (no volver a discutir, ver PLAN.md para el porqué)

- CommonJS en todo el backend (no ESM), porque `fiscal.js`/`store.js` usan
  `require`/`module.exports`.
- Sin páginas HTML adicionales para login o impresión: todo vive en
  `index.html`/`app.js`, la impresión se resuelve con `@media print`.
- Sin TLS en Node: `tailscale serve` hace la terminación HTTPS delante del
  puerto local en HTTP plano.
- `auth.json` vive en la raíz del proyecto, fuera del directorio de datos
  (`FACTURACION_DATA`), para que exportar/importar backups de negocio nunca
  toque las credenciales.

## Cómo continuar

Retomar por el punto 1 de "Pendiente" (frontend en `public/`), siguiendo el
orden de implementación de `PLAN.md`. El backend completo ya existe y está
probado (`npm test` → 40/40 en verde); el frontend solo necesita consumir
las rutas ya descritas en PLAN.md → "Rutas API". No hace falta releer el
encargo completo: `PLAN.md` ya resume todas las decisiones necesarias.
