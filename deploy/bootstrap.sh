#!/usr/bin/env bash
# One-time board setup (run ON the Orange Pi as root). Idempotent.
#   scp deploy/bootstrap.sh deploy/penplot-web.service deploy/99-penplot-serial.rules \
#       deploy/web.env.example deploy/journald-penplot.conf root@opi:/tmp/penplot-bootstrap/
#   ssh root@opi 'bash /tmp/penplot-bootstrap/bootstrap.sh [--journald] [--port 8090]'
# Does not start the service until a release exists.
# Optional: PENPLOT_FONT_SRC=/path/to/fonts to copy an existing font folder on the board.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=""
JOURNALD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --journald) JOURNALD=1 ;;
    --port) PORT="$2"; shift ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

echo "== packages"
command -v python3.12 >/dev/null || { echo "python3.12 missing"; exit 1; }
python3.12 -c 'import venv, ensurepip' 2>/dev/null || apt-get install -y python3.12-venv

echo "== user"
id penplot >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /var/lib/penplot -G dialout,systemd-journal penplot
usermod -a -G dialout,systemd-journal penplot

echo "== dirs + venv"
mkdir -p /opt/penplot/releases /etc/penplot
[ -x /opt/penplot/venv/bin/python ] || python3.12 -m venv /opt/penplot/venv
install -d -o penplot -g penplot -m 0750 /var/lib/penplot /var/lib/penplot/fonts /var/lib/penplot/tmp
FONT_SRC="${PENPLOT_FONT_SRC:-}"
if [ -n "$FONT_SRC" ] && [ -d "$FONT_SRC" ] && [ -z "$(ls -A /var/lib/penplot/fonts)" ]; then
  echo "   copying fonts on the board (not over WiFi)"
  cp -a "$FONT_SRC"/. /var/lib/penplot/fonts/
fi
chown -R penplot:penplot /var/lib/penplot

echo "== env"
if [ ! -f /etc/penplot/web.env ]; then
  install -m 0640 -g penplot "$HERE/web.env.example" /etc/penplot/web.env
fi

echo "== port / unit name check"
WANT="${PORT:-$(grep -E '^PENPLOT_PORT=' /etc/penplot/web.env | cut -d= -f2)}"
WANT="${WANT:-8080}"
if ss -ltnp | grep -q ":$WANT "; then
  if ! ss -ltnp | grep ":$WANT " | grep -q penplot.web; then
    echo "!! port $WANT already in use by another service:"; ss -ltnp | grep ":$WANT " || true
    echo "   rerun with --port 8090"; exit 1
  fi
fi
if [ -n "$PORT" ]; then sed -i "s/^PENPLOT_PORT=.*/PENPLOT_PORT=$PORT/" /etc/penplot/web.env; fi
systemctl list-units --all | grep penplot || true

echo "== systemd + udev"
install -m 0644 "$HERE/penplot-web.service" /etc/systemd/system/penplot-web.service
install -m 0644 "$HERE/99-penplot-serial.rules" /etc/udev/rules.d/99-penplot-serial.rules
udevadm control --reload && udevadm trigger --subsystem-match=tty || true
if [ "$JOURNALD" = 1 ]; then
  mkdir -p /etc/systemd/journald.conf.d
  install -m 0644 "$HERE/journald-penplot.conf" /etc/systemd/journald.conf.d/penplot.conf
  systemctl restart systemd-journald
fi
systemctl daemon-reload
systemctl enable penplot-web
if [ -e /opt/penplot/current ]; then
  systemctl restart penplot-web
else
  echo "no release yet: run deploy/deploy.sh from the dev PC"
fi
echo "== done. setup code: journalctl -u penplot-web | grep 'setup code'  (or cat /var/lib/penplot/setup-code)"
