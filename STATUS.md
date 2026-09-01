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
- [x] Frontend (`public/index.html`, `public/app.js`, `public/estilos.css`,
      `public/impresion.css`) — SPA de una sola página con enrutado por
      hash hecho a mano, sin build, sin `localStorage`/`sessionStorage`.
      Login como estado de la propia SPA (formulario visible cuando
      `GET /api/sesion` da 401). Secciones Facturas (con gestión de
      clientes colgando de Facturas, sin entrada propia en la nav, tal
      como pide el encargo §9), Gastos, Inversiones, Libros, Impuestos
      (casilla junto a cada importe, rojo solo en "a ingresar"), Ajustes
      (avanzado plegado, exportar/importar). CSP sin `unsafe-inline`
      respetada: nada de `style=""` ni `onclick=""` en el HTML.
      Verificado end to end con Playwright headless (login, alta de
      cliente, factura completa borrador→confirmar con numeración e
      importes reales calculados en servidor, gasto de suministros de
      vivienda con el desglose correcto, bien de inversión con la
      amortización de encargo §10, impuestos 303/130, vista de
      impresión con `@media print` comprobada por computed style, atajos
      de teclado "n" y Escape). Dos bugs reales encontrados y corregidos
      en esa verificación: (1) `location.hash` no dispara `hashchange`
      cuando se asigna el mismo valor que ya tenía — pasaba al confirmar
      una factura o al editar un borrador existente, así que ahora esas
      acciones usan un helper `irA()` que fuerza el re-render a mano
      cuando el hash no cambia; (2) la ruta por defecto (hash vacío) solo
      se resolvía en una variable local sin escribir `#/facturas` de
      vuelta en `location.hash`, así que los atajos de teclado que miran
      la sección activa vía `location.hash` no funcionaban nada más
      entrar. `npm test` sigue en 40/40 tras estos cambios (no tocan el
      backend).

- [x] `deploy/` — `facturacion.service` (endurecido, usuario dedicado sin
      shell) y `backup.service`/`backup.timer` (diario 03:00, usan el
      nuevo `node server.js --backup`, que llama a `Store.backup()` y
      conserva 30 copias), `instalar.sh` idempotente (no toca `auth.json`
      ni los datos en reinstalaciones; no arranca el servicio si aún no
      hay contraseña fijada, para no dejarlo en bucle de reintentos),
      `README-despliegue.md` con cortafuegos + Tailscale (`serve --bg
      8080`, sin TLS en Node) + comprobación de que el puerto no responde
      desde la IP pública, y la nota final de la alternativa con dominio
      + Caddy.
- [x] `README.md` raíz — arranque en local, variables de entorno, mapa de
      la estructura, backup manual, qué queda fuera de alcance a
      propósito (VeriFactu completo con su fecha límite del 1/7/2027,
      modelo 390, modelo 347 con el aviso ya implementado, facturación
      intracomunitaria) y el aviso de verificar el mapeo de casillas
      contra el formulario real.

- [x] Repaso final contra el encargo (§4, §7, §9). Se encontraron y
      corrigieron 4 desviaciones reales: el snapshot del cliente se
      tomaba al crear el borrador en vez de al confirmar (§4.4); el
      rojo se usaba también fuera de "a ingresar"/cadena rota (§9); dos
      estados vacíos no decían qué hacer (§9); y una fuga de listeners
      en el formulario de factura (bug de calidad, no del encargo, pero
      salió al revisar con Playwright). Todo con test o verificación en
      navegador — ver el commit para el detalle. `npm test` → 41/41.

## Pendiente

Nada del árbol de PLAN.md/encargo §12 queda por hacer. Antes de dar el
proyecto por terminado del todo: desplegar de verdad en el VPS siguiendo
`deploy/README-despliegue.md` y probar a mano el ciclo completo ahí (el
encargo lo pide explícitamente en su sección "Verificación" — login real,
alta y confirmación de factura, forzar una rotura de cadena editando
`facturas.json` a mano para comprobar el modo solo lectura en producción,
etc.), algo que esta sesión no puede hacer por sí sola al no tener acceso
al VPS real.

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

El código está completo y probado (`npm test` → 41/41, backend y frontend
verificados a mano con Playwright). Lo único que queda es el despliegue
real en el VPS de Hetzner siguiendo `deploy/README-despliegue.md`, y la
prueba manual de extremo a extremo ya en producción que pide el encargo en
su sección "Verificación".
