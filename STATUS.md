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

## Pendiente (en este orden, según PLAN.md → "Orden de implementación")

1. **`test/fiscal.test.js`** — escribir los casos exactos del encargo §10
   (factura, modelo 303, modelo 130, arrastre de saldo IVA, amortización,
   cadena de huellas) y ejecutarlos contra `lib/fiscal.js` antes de construir
   nada más. Es el primer paso real de código pendiente.
2. **`lib/auth.js`** — scrypt + sal, `auth.json` fuera de `FACTURACION_DATA`,
   sesión firmada HMAC-SHA256, prompt de contraseña oculto con
   `process.stdin.setRawMode(true)`, rate limiting de login en memoria.
3. **`server.js`** — `crearApp(opciones)` sin `.listen()` propio (testable),
   router mínimo sobre `node:http`, middleware de sesión, servir `public/`
   sin path traversal, cabeceras de seguridad (CSP sin `unsafe-inline`,
   `X-Content-Type-Options`, `Referrer-Policy`), arranque con
   `verificarCadena` + comprobación de contadores → `soloLectura`.
4. Rutas API en orden: clientes → facturas (numeración/huella atómicas +
   `previsualizar`) → gastos → bienes → libros (CSV) → impuestos → ajustes.
   Ver PLAN.md → "Rutas API" para las firmas exactas de cada endpoint y los
   nombres de campo que `fiscal.js` exige literalmente en las facturas
   (`numero` como string `"A-0001"`, `tipo` `F1`/`R1`, `nifEmisor`,
   `generadaEn` con huso horario, `rectificaA`).
5. **`test/api.test.js`** — incluye la prueba obligatoria de 100 altas de
   factura concurrentes sin huecos ni duplicados en la numeración.
6. Frontend (`public/index.html`, `public/app.js`, `public/estilos.css`,
   `public/impresion.css`) — SPA de una sola página, sin build, sin
   `localStorage`. Login como estado de la propia SPA, impresión vía
   `@media print` en `impresion.css` (NO páginas separadas).
7. `deploy/` (systemd + Tailscale) y `README.md` raíz (incluye qué falta
   para VeriFactu completo y el aviso del modelo 347, ambos fuera de
   alcance según encargo §11).
8. Repaso final contra el encargo: reglas de negocio innegociables (§4),
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

Retomar por el punto 1 de "Pendiente" (`test/fiscal.test.js`), siguiendo el
orden de implementación de `PLAN.md`. No hace falta releer el encargo
completo: `PLAN.md` ya resume todas las decisiones necesarias.
