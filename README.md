# Facturación

Aplicación de facturación y contabilidad para un autónomo español (epígrafe
IAE 763, estimación directa simplificada), pensada para un único usuario y
para correr en un VPS propio. Node.js puro sin dependencias de npm,
frontend en HTML/CSS/JS planos sin build, datos solo en el servidor (nunca
`localStorage`): abrir la app desde casa o desde la oficina muestra
siempre el mismo estado.

El encargo original está en [encargo-facturacion.md](encargo-facturacion.md)
y todas las decisiones de arquitectura, con su porqué, en [PLAN.md](PLAN.md).

## Series adicionales

Además de la serie principal (`A`) y la rectificativa (`R`), en Ajustes se
pueden crear series de facturas adicionales (`B`, `C`…), cada una con su
propio contador desde 0001. En la factura se elige la serie (el selector solo
aparece si hay alguna adicional) y el número se asigna al confirmar. Una serie
con facturas confirmadas no se puede quitar ni cambiar de código. Las
rectificativas de cualquier serie van todas a la serie `R`.

## Presupuestos

Añadidos después del encargo. Un presupuesto **no es un documento fiscal**:
tiene su propia serie (`P-0001` por defecto) y su propio contador, se numera
al guardarlo, se puede editar y borrar siempre, y no aparece ni en los libros
registro ni en los modelos 303/130 ni en la cadena de huellas. Lo único que
le da efectos fiscales es «Convertir en factura», que crea un **borrador** de
factura con las mismas líneas; a partir de ahí es una factura corriente y se
numera al confirmarla. Serie y días de validez se cambian en Ajustes.

## Arrancar en local

Requiere Node.js ≥ 22.

```bash
npm test                    # node --test test/ (50 casos: fiscal.js + API)
node server.js --set-password   # fija la contraseña (pide dos veces, sin eco)
node server.js                  # arranca en http://127.0.0.1:8080
```

Variables de entorno (todas opcionales, con valores por defecto pensados
para producción):

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `8080` | Puerto de escucha. |
| `HOST` | `127.0.0.1` | Interfaz de escucha; no exponer directamente a Internet. |
| `FACTURACION_DATA` | `/var/lib/facturacion` | Directorio de los ficheros JSON de negocio. |
| `FACTURACION_AUTH_FILE` | `<junto a server.js>/auth.json` | Fichero de credenciales, fuera de `FACTURACION_DATA` a propósito. |

## Estructura

```
server.js          crearApp() (testable sin .listen()) + arranque CLI
lib/
  fiscal.js         cálculo fiscal (dado por el encargo, sin modificar)
  store.js          persistencia JSON con colas por colección (sin modificar)
  auth.js           scrypt, sesión HMAC-SHA256, rate limiting de login
  http-utils.js      body JSON, CSV, estáticos sin path traversal
public/             SPA sin build: index.html + app.js + estilos.css + impresion.css
test/               node:test — fiscal.test.js y api.test.js
deploy/             systemd (servicio + backup) y guía de despliegue con Tailscale
```

## Copias de seguridad y backup manual

`node server.js --backup` escribe una copia fechada en
`FACTURACION_DATA/backups/` y conserva las últimas 30 (lo usa
`deploy/backup.timer`, diario a las 03:00). Desde la propia app, Ajustes →
«Exportar todo a JSON» descarga el mismo contenido para guardarlo aparte.

## Despliegue

Ver [deploy/README-despliegue.md](deploy/README-despliegue.md): cortafuegos,
`deploy/instalar.sh` (idempotente) y publicación con Tailscale (sin
dominio ni certificados que gestionar a mano).

## Fuera de alcance (a propósito, ver encargo §11)

- **VeriFactu completo.** Ya existe el encadenado de huellas
  (`huellaFactura`/`verificarCadena` en `lib/fiscal.js`, verificado al
  arrancar el servidor) porque es la parte que hay que llevar desde la
  factura número 1. Falta todo lo demás: el registro de facturación en
  XML, el código QR, el envío a la AEAT y la declaración responsable del
  "productor" del software. Exigible a personas físicas desde el
  **1 de julio de 2027** (Real Decreto-ley 15/2025) — hay margen, pero no
  hay que dejarlo para el último trimestre.
- **Modelo 390** (resumen anual de IVA). No se genera.
- **Modelo 347.** Solo hace falta si algún cliente supera 3.005,06 € de
  operaciones en el año. La app lo detecta y avisa (columna «aviso 347»
  en la ficha de cada cliente), pero no genera el modelo.
- **Facturación intracomunitaria.** El cliente puede marcarse como
  `intracomunitario`/VIES y el dato se guarda, pero la exención (factura
  sin IVA con inversión del sujeto pasivo) no se aplica automáticamente:
  el usuario no está dado de alta en el ROI todavía.
- Multiusuario, multiempresa, integración bancaria, envío de correo: no
  contemplados, es una herramienta de un solo autónomo.

## Aviso

El mapeo de casillas de `lib/fiscal.js` (modelos 303 y 130) se verificó
contra las instrucciones de la AEAT pero debe contrastarse con el
formulario real la primera vez que se presente cada modelo, en especial el
encadenamiento de las casillas 05, 07 y 16 del 130 entre trimestres. Ni el
encargo ni esta herramienta sustituyen a un asesor fiscal.
