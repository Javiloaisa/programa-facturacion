#!/usr/bin/env bash
# Instalacion idempotente de la app de facturacion en un VPS (Debian/Ubuntu).
# Se puede volver a ejecutar tras actualizar el codigo: no toca auth.json ni
# los datos ya existentes en FACTURACION_DATA.
set -euo pipefail

APP_USER=facturacion
APP_DIR=/opt/facturacion
DATA_DIR=/var/lib/facturacion
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script necesita ejecutarse como root (sudo)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "No se encuentra 'node' en el PATH. Instala Node.js 22 antes de continuar." >&2
  exit 1
fi

echo "== Usuario del servicio =="
if id -u "$APP_USER" >/dev/null 2>&1; then
  echo "El usuario '$APP_USER' ya existe."
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  echo "Usuario '$APP_USER' creado."
fi

echo "== Directorios =="
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/backups"
echo "  $APP_DIR"
echo "  $DATA_DIR (y $DATA_DIR/backups)"

echo "== Copiando la aplicacion a $APP_DIR =="
# Solo lo que forma parte del entregable en ejecucion: nunca auth.json ni
# datos de negocio, que viven fuera del arbol del codigo.
rsync -a --delete \
  --exclude ".git" \
  --exclude "deploy" \
  --exclude "test" \
  --exclude "node_modules" \
  --exclude "auth.json" \
  --exclude "*.md" \
  "$PROJECT_DIR"/server.js "$PROJECT_DIR"/package.json "$PROJECT_DIR"/lib "$PROJECT_DIR"/public \
  "$APP_DIR"/

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

echo "== Unidades de systemd =="
cp "$SCRIPT_DIR/facturacion.service" "$SCRIPT_DIR/backup.service" "$SCRIPT_DIR/backup.timer" /etc/systemd/system/
systemctl daemon-reload

echo "== Copia de seguridad diaria =="
systemctl enable --now backup.timer
echo "backup.timer activo (copia diaria a las 03:00, se conservan 30)."

echo "== Servicio principal =="
systemctl enable facturacion.service >/dev/null

if [ -f "$APP_DIR/auth.json" ]; then
  systemctl restart facturacion.service
  echo "facturacion.service (re)iniciado."
else
  cat <<EOF

Todavia no hay credenciales en $APP_DIR/auth.json.
El servicio esta habilitado para arrancar en el proximo reinicio, pero
NO se ha iniciado ahora para evitar que entre en bucle de reintentos.

Antes de arrancarlo, ejecuta como el usuario '$APP_USER':

  sudo -u $APP_USER FACTURACION_AUTH_FILE=$APP_DIR/auth.json \\
    node $APP_DIR/server.js --set-password

Y despues arranca el servicio:

  sudo systemctl start facturacion.service

EOF
fi

echo "Instalacion completada. Revisa deploy/README-despliegue.md para el resto (Tailscale, cortafuegos)."
