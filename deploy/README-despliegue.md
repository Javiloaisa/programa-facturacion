# Despliegue en el VPS de Hetzner

No hay dominio registrado, así que el acceso HTTPS lo da Tailscale
(`*.ts.net` con certificado válido), no la propia aplicación: Node solo
escucha HTTP en `127.0.0.1:8080` (ver PLAN.md → decisión 4).

## 1. Cortafuegos

Cierra todo lo que no sea SSH y la interfaz de Tailscale:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow in on tailscale0
sudo ufw enable
```

## 2. Instalar la aplicación

Desde el checkout del proyecto en el servidor:

```bash
sudo bash deploy/instalar.sh
```

Es idempotente: crea el usuario de sistema `facturacion` (sin shell), copia
`server.js`, `package.json`, `lib/` y `public/` a `/opt/facturacion`,
prepara `/var/lib/facturacion`, instala las unidades de systemd y activa el
temporizador de copia de seguridad diaria. Si todavía no existe
`/opt/facturacion/auth.json`, el script no arranca el servicio principal
(para no dejarlo en bucle de reinicios) y muestra el comando exacto para
fijar la contraseña.

Para volver a desplegar tras `git pull` de una versión nueva, ejecuta
`deploy/instalar.sh` otra vez: no toca `auth.json` ni los datos ya
guardados en `/var/lib/facturacion`.

## 3. Tailscale en el servidor

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8080
```

`tailscale serve` hace de proxy HTTPS delante del puerto local en HTTP
plano: no hace falta `tailscale cert` ni configurar TLS en Node. La URL
resultante (`https://<nombre-del-equipo>.<tailnet>.ts.net`) solo es
alcanzable desde dispositivos de la misma tailnet.

## 4. Tailscale en el portátil y en el equipo de la oficina

Instala el cliente de Tailscale en ambos equipos y haz login con la misma
cuenta con la que se unió el servidor a la tailnet. La app quedará
accesible en la URL `https://*.ts.net` desde los dos sitios, viendo
siempre el mismo estado porque los datos solo viven en el servidor.

## 5. Comprobar que no hay exposición pública

Desde una red que **no** sea la tailnet (datos móviles, por ejemplo):

```bash
curl -m 5 http://<IP-pública-del-VPS>:8080/
```

Debe fallar (timeout o conexión rechazada). Si responde, revisa `ufw
status` y que el servicio no esté escuchando en `0.0.0.0` (`HOST` debe
seguir siendo `127.0.0.1` en `facturacion.service`).

## Nota: alternativa sin instalar Tailscale en cada equipo

Si en el futuro no quieres instalar Tailscale en cada máquina, un dominio
propio cuesta del orden de 10 €/año (gasto deducible de la actividad). En
ese caso la alternativa es poner **Caddy** delante del mismo servicio:
Caddy obtiene y renueva el certificado con Let's Encrypt automáticamente y
hace de proxy inverso hacia `127.0.0.1:8080`, sin tocar nada de `server.js`.
