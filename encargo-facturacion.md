# Encargo: aplicación de facturación en servidor

Construye una aplicación web de facturación y contabilidad para un autónomo
español, pensada para correr en un VPS de Hetzner y usarse desde dos equipos
distintos (casa y oficina).

Ya existe un módulo de cálculo fiscal escrito y probado en `lib/fiscal.js` y una
capa de almacenamiento en `lib/store.js`. **Úsalos tal cual.** No reimplementes
los cálculos ni cambies el mapeo de casillas sin decirlo explícitamente: son la
parte del proyecto donde un error cuesta dinero.

---

## 1. Contexto del usuario

Un único usuario. Persona física, alta en el RETA y modelo 036 presentados con
fecha 1 de septiembre de 2026.

| Dato | Valor |
|---|---|
| Epígrafe IAE | 763 – Programadores y analistas de informática (sección segunda) |
| Régimen IVA | General, 21 % |
| Retención IRPF en factura | 15 % |
| Estimación | Directa simplificada |
| Modelos | 303 trimestral, 390 anual, 130 trimestral (ver §6) |
| Domicilio de la actividad | Benissa (Alicante), sin local afecto |
| Vivienda afecta | 10 % previsto (pendiente de un 036 de modificación) |
| Hipoteca | Posterior a 2013 – sin deducción en la casilla 16 del 130 |
| Ejercicio anterior | Sin actividad económica – minoración de 100 € en la casilla 13 |

En 2026 emitirá al menos dos facturas: 1.400 € y 4.500 € de base, más IVA.

---

## 2. Restricciones técnicas

Son restricciones, no sugerencias.

- **Node.js 22, sin dependencias de npm.** Solo módulos nativos (`node:http`,
  `node:fs`, `node:crypto`, `node:path`). Sin Express, sin frameworks.
- **Frontend en HTML, CSS y JavaScript planos.** Sin React, sin build, sin
  bundler. Los ficheros de `public/` se sirven tal cual.
- **Nada de `localStorage` ni `sessionStorage`.** Los datos viven solo en el
  servidor: es la razón de ser del proyecto. Si el usuario abre la app en la
  oficina tiene que ver exactamente lo mismo que dejó en casa.
- **Persistencia en ficheros JSON** en un directorio configurable
  (`FACTURACION_DATA`, por defecto `/var/lib/facturacion`), mediante `Store`.
- El servidor escucha en `127.0.0.1` por defecto. La exposición a la red la
  resuelve Tailscale (§8), no la aplicación.
- Sin telemetría, sin llamadas salientes, sin CDNs. La app debe funcionar con
  el cortafuegos cerrado a cal y canto.

---

## 3. Modelo de datos

Seis colecciones, todas gestionadas por `Store` (`lib/store.js`).

### `config` (objeto)
Ya definido en `CONFIG_INICIAL`. Datos del emisor, serie y contador de
numeración, tipos por defecto, `presenta130`, y un bloque `avanzado` con
`porcentaje130`, `rendimientoEjercicioAnterior`, `saldoIvaInicial` y
`anioInicioActividad`.

### `clientes` (lista)
`id`, `nombre`, `nif`, `direccion`, `cp`, `poblacion`, `provincia`, `pais`,
`email`, `notas`. Marca `intracomunitario` (booleano) y `vies` para el futuro:
si está activo, la factura va sin IVA con la mención de inversión del sujeto
pasivo. **No** se aplica todavía – el usuario no está en el ROI. Deja el campo
guardado y la lógica desactivada, con un aviso en la interfaz.

### `facturas` (lista)
`id`, `orden` (entero correlativo global, define la cadena de huellas),
`serie`, `numero` (`A-0001`), `fecha`, `fechaVencimiento`, `clienteId`,
`clienteSnapshot` (copia congelada de los datos del cliente en el momento de
emitir), `lineas[]` (`concepto`, `cantidad`, `precio`), `base`, `tipoIva`,
`cuotaIva`, `tipoIrpf`, `cuotaIrpf`, `total`, `tipo` (`F1` ordinaria, `R1`
rectificativa), `rectificaA` (id de la factura rectificada), `motivo`,
`cobrada`, `fechaCobro`, `nifEmisor`, `generadaEn` (ISO con huso),
`huellaAnterior`, `huella`.

### `gastos` (lista)
`id`, `fecha`, `proveedor`, `nif`, `concepto`, `categoria`, `base`, `tipoIva`,
`cuotaIva`, `afectacionPct`, `ivaDeduciblePct`, `formaPago`, `adjunto`.

### `bienes` (lista)
Bienes de inversión: `id`, `fecha`, `descripcion`, `proveedor`, `nif`, `base`,
`cuotaIva`, `categoria` (una de `TABLA_AMORTIZACION`), `coef`,
`afectacionPct`, `ivaDeduciblePct`, `baja` (fecha o null).

### `presentaciones` (lista)
Registro de lo ya presentado, necesario para el arrastre entre trimestres:
`modelo` (`303` / `130`), `anio`, `trimestre`, `fechaPresentacion`,
`casillas` (copia del objeto calculado), y para el 130 los campos `c07`, `c16`
y `c17` que `modelo130` consume como `presentacionesPrevias`.

---

## 4. Reglas de negocio innegociables

1. **Numeración correlativa y sin huecos.** El número se asigna al confirmar la
   factura, nunca al abrir el formulario. Series independientes para ordinarias
   (`A`) y rectificativas (`R`), pero un único `orden` global para la cadena.
2. **Una factura confirmada no se edita ni se borra.** La única corrección es
   emitir una rectificativa que la referencie. La interfaz no debe ofrecer
   siquiera el botón. Sí existe un estado *borrador* previo, que sí es editable
   y aún no consume número.
3. **Encadenado de huellas desde la factura número 1.** Cada factura guarda la
   huella de la anterior y la suya propia (`huellaFactura`). Al arrancar, el
   servidor ejecuta `verificarCadena` y, si detecta una rotura, arranca en modo
   solo lectura y lo muestra en rojo en la pantalla principal.
4. **Snapshot del cliente.** Cambiar la dirección de un cliente no puede alterar
   una factura ya emitida.
5. **Los importes se calculan en el servidor.** El navegador puede previsualizar,
   pero el valor que se guarda lo produce `calcularFactura`.

---

## 5. Funcionalidad

### Facturas
- Listado por año y trimestre, con filtro por cliente y por estado de cobro.
- Alta de factura: cliente, fecha, líneas, tipos de IVA e IRPF (por defecto los
  de configuración), vencimiento calculado a partir de `vencimientoDias`.
- Guardar como borrador / confirmar y numerar.
- Rectificativa: parte de una factura existente, permite rectificación total
  (negativo íntegro) o parcial por importe.
- Marcar cobrada, con fecha.
- Vista de impresión: hoja de estilos `@media print` a A4, sin cromo de la
  aplicación, con todos los datos obligatorios del art. 6 del Reglamento de
  facturación. El PDF lo genera el navegador; no incluyas librerías de PDF.

### Gastos
- Alta rápida con categoría. Categorías: `general`, `suministros_vivienda`,
  `cuota_autonomos`, `profesionales`, `software`, `viajes`, `otros`.
- `suministros_vivienda` tiene tratamiento especial y ya está resuelto en
  `desgloseGasto`: el 30 % de la parte proporcional afecta es deducible en IRPF
  y el IVA no se deduce. La interfaz debe explicarlo en una línea, no dejar que
  el usuario meta porcentajes contradictorios.
- La cuota de autónomos es gasto deducible en IRPF y no lleva IVA.

### Bienes de inversión
- Alta con categoría de la `TABLA_AMORTIZACION`, que precarga el coeficiente
  máximo pero permite bajarlo.
- Cuadro de amortización por ejercicio usando `amortizacionEjercicio`, con
  cuota del año, acumulada y pendiente.

### Libros registro
Tres vistas exportables a CSV, con las columnas que exige el art. 68 del
Reglamento del IRPF:
- Ventas e ingresos
- Compras y gastos
- Bienes de inversión

### Impuestos
- Pantalla por año y trimestre que muestra el resultado de `modelo303` y, si
  `presenta130` está activo, el de `modelo130`, **casilla a casilla**, con el
  número de casilla visible junto a cada importe para poder teclearlo en la
  sede electrónica sin dudar.
- Botón «marcar como presentado» que escribe en `presentaciones`. Es lo que
  alimenta el arrastre: la casilla 78 del 303 y las casillas 05 y 15 del 130
  del trimestre siguiente salen de ahí.
- Aviso visible de los plazos próximos (`plazos()`), con los días que faltan.

### Ajustes
- Datos del emisor, serie, tipos por defecto.
- Un desplegable **Ajustes avanzados**, cerrado por defecto, con el bloque
  `avanzado`: porcentaje del 130, rendimiento del ejercicio anterior, saldo de
  IVA inicial y año de inicio de actividad. No deben estar a la vista en el uso
  diario.
- Exportar todo a JSON y volver a importarlo.

---

## 6. El modelo 130 es configurable, y hay una razón

El usuario está en sección segunda (profesional) y aplica el 15 % de retención
en todas sus facturas. Un profesional queda exento del pago fraccionado si al
menos el 70 % de sus ingresos soportaron retención, así que probablemente no
tenga que presentar el 130 – pero en el 036 declaró la obligación y está
pendiente de resolverlo con un gestor.

Por eso `config.presenta130` existe. Cuando está en `false`, la aplicación
oculta el bloque del 130 en la pantalla de impuestos y en los avisos de plazo,
pero **sigue calculándolo por dentro** y lo muestra en una sección plegada
titulada «Cálculo informativo del 130», para que el usuario pueda comprobar
qué le habría salido. No borres el cálculo, solo la obligación.

---

## 7. Autenticación

Un solo usuario. Sin registro, sin recuperación de contraseña.

- Contraseña almacenada como `scrypt` con sal aleatoria, en un fichero aparte
  del directorio de datos. Se establece con un comando de arranque
  (`node server.js --set-password`), nunca desde la web.
- Sesión mediante cookie firmada con HMAC-SHA256 y un secreto persistente:
  `HttpOnly`, `SameSite=Strict`, `Secure`, caducidad de 12 horas.
- Comparación de credenciales en tiempo constante
  (`crypto.timingSafeEqual`).
- Retardo progresivo tras intentos fallidos desde la misma IP.
- Todas las rutas de la API exigen sesión salvo `/login`.
- Cabeceras: `Content-Security-Policy` restrictiva sin `unsafe-inline`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

Es una aplicación con datos fiscales y el NIF del usuario. No hace falta ser
paranoico, pero tampoco dejarla abierta.

---

## 8. Despliegue

VPS de Hetzner. **No hay dominio registrado**, así que la solución es Tailscale,
que da HTTPS con certificado válido sobre un nombre `*.ts.net` sin necesidad de
comprar nada.

Entrega en `deploy/`:

- **`facturacion.service`** – unidad de systemd. Usuario dedicado sin shell,
  `WorkingDirectory` en la carpeta de la app, `Environment` con `PORT`,
  `HOST=127.0.0.1` y `FACTURACION_DATA`. Endurecida:
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `ReadWritePaths` limitado al directorio de datos. `Restart=always`.
- **`instalar.sh`** – script idempotente que crea el usuario, copia los
  ficheros, prepara `/var/lib/facturacion`, instala la unidad y la arranca.
- **`backup.timer` y `backup.service`** – copia diaria a las 03:00 llamando a
  `Store.backup()`, conservando 30 copias.
- **`README-despliegue.md`** con los pasos concretos:
  1. `ufw default deny incoming`, permitir solo SSH y `tailscale0`.
  2. Instalar Tailscale y unir el servidor a la tailnet.
  3. `tailscale serve --bg 8080` para publicar el servicio con HTTPS dentro de
     la tailnet.
  4. Instalar el cliente de Tailscale en el portátil y en el equipo de la
     oficina.
  5. Comprobar que el puerto 8080 **no** responde desde la IP pública.

Añade una nota al final: si más adelante quiere acceso sin instalar Tailscale
en cada máquina, un dominio cuesta unos 10 € al año, es gasto deducible, y
entonces la alternativa es Caddy con Let's Encrypt delante del mismo servicio.

---

## 9. Diseño de la interfaz

Es una herramienta de trabajo para una sola persona que la abrirá cuatro veces
al año con prisa y el plazo encima. Densidad y legibilidad por encima de todo.

- Navegación lateral fija: Facturas, Gastos, Inversiones, Libros, Impuestos,
  Ajustes.
- Tablas densas, filas compactas, cifras alineadas a la derecha con tipografía
  de ancho fijo para que las columnas de importes cuadren visualmente.
- Paleta sobria de documento administrativo. Un único color de acento, y el
  rojo reservado para «a ingresar» y para la cadena de huellas rota. Nada de
  degradados ni tarjetas con sombra.
- Los números de casilla se muestran siempre junto al importe correspondiente.
- Atajos de teclado para lo que se repite: nueva factura, nuevo gasto, guardar.
- Estados vacíos que digan qué hacer, no «no hay datos».
- Responsive hasta móvil, foco de teclado visible, `prefers-reduced-motion`
  respetado.

---

## 10. Pruebas

Escribe pruebas con `node:test`, sin dependencias. Como mínimo:

**Cálculo de factura**
- Base 1.400 → IVA 294, IRPF 210, total 1.484.
- Base 4.500 → IVA 945, IRPF 675, total 4.770.

**Modelo 303, 3T de 2026** con esas dos facturas, un gasto general de 100 € +
21 € de IVA, un suministro de vivienda de 80 € + 16,80 € al 10 % de afectación,
y un equipo informático de 1.200 € + 252 €:
- casilla 07 = 5.900, casilla 09 = 1.239, casilla 27 = 1.239
- casilla 29 = 21, casilla 31 = 252, casilla 45 = 273
- casilla 46 = 966, casilla 71 = 966

**Modelo 130, 3T de 2026** con los mismos datos:
- casilla 01 = 5.900, casilla 02 = 180,61, casilla 03 = 5.719,39
- casilla 04 = 1.143,88, casilla 06 = 885, casilla 07 = 258,88
- casilla 13 = 100, casilla 17 = 158,88

**Arrastre del saldo de IVA.** Un trimestre con resultado negativo de 300 €
seguido de otro con resultado positivo de 200 €: el segundo debe aplicar 200 en
la casilla 110, dejar la 71 a cero y arrastrar 100 en la casilla 78. Este caso
concreto estaba mal en la versión anterior de la herramienta, así que la prueba
es obligatoria.

**Amortización.** Equipo informático de 1.200 € dado de alta el 1/9/2026 al
26 %: 104,28 € en 2026 (prorrateo por días) y 312 € en 2027.

**Cadena de huellas.** Dos facturas encadenadas verifican correctamente;
alterar el importe de la primera hace fallar `verificarCadena`.

**Numeración.** Cien altas concurrentes no producen números repetidos ni huecos.

---

## 11. Fuera de alcance

No lo construyas, pero deja el terreno preparado.

- **VeriFactu completo.** El encadenado de huellas ya está, pero falta el
  registro de facturación en XML, el QR, el envío a la AEAT y la declaración
  responsable. Es exigible a personas físicas desde el **1 de julio de 2027**
  (Real Decreto-ley 15/2025). Escribe en el README qué falta exactamente.
- **Modelo 390** (resumen anual) y **modelo 347**. El 347 solo hace falta si
  algún cliente supera 3.005,06 € en el año: añade un aviso que lo detecte y lo
  avise en enero, pero no generes el modelo.
- **Facturación intracomunitaria.** Campos guardados, lógica desactivada.
- Multiusuario, multiempresa, integración bancaria, envío de correo.

---

## 12. Entregable

```
facturacion/
├── server.js
├── lib/
│   ├── fiscal.js          – ya escrito, no tocar
│   ├── store.js           – ya escrito, no tocar
│   └── auth.js
├── public/
│   ├── index.html
│   ├── app.js
│   ├── estilos.css
│   └── impresion.css
├── test/
│   ├── fiscal.test.js
│   └── api.test.js
├── deploy/
│   ├── facturacion.service
│   ├── backup.service
│   ├── backup.timer
│   ├── instalar.sh
│   └── README-despliegue.md
└── README.md
```

Empieza por `server.js` y la API, deja la interfaz para el final, y ejecuta las
pruebas antes de dar nada por terminado.

---

## Aviso

El mapeo de casillas de `fiscal.js` se verificó contra las instrucciones de la
AEAT, pero **debe contrastarse con el formulario real** la primera vez que se
presente cada modelo. El punto más delicado es el encadenamiento de las
casillas 05, 07 y 16 del 130 entre trimestres. Ni el autor del encargo ni esta
herramienta son un asesor fiscal.
