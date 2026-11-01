#!/usr/bin/env bash
# Deploy from the dev PC:  ./deploy/deploy.sh [host] [--force] [--deps] [--no-build]
#   host: argument or $PENPLOT_DEPLOY_HOST (e.g. root@plotter.local); port from PENPLOT_PORT (default 8080)
#   PENPLOT_PIP_INDEX: optional PyPI mirror for the board (e.g. https://pypi.tuna.tsinghua.edu.cn/simple)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${PENPLOT_DEPLOY_HOST:-}"
FORCE=0; DEPS=0; BUILD=1
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --deps) DEPS=1 ;;
    --no-build) BUILD=0 ;;
    -*) echo "unknown flag $a"; exit 2 ;;
    *) HOST="$a"; [[ "$HOST" == *@* ]] || HOST="root@$HOST" ;;
  esac
done
[ -n "$HOST" ] || { echo "usage: deploy.sh <user@host> (or set PENPLOT_DEPLOY_HOST)"; exit 2; }
PORT="${PENPLOT_PORT:-8080}"
BOARD="${HOST#*@}"
TS="$(date -u +%Y%m%d-%H%M%SZ)"   # UTC: local clocks jump at DST changes
SSH="ssh -o BatchMode=yes $HOST"

echo "== 1 build SPA"
if [ "$BUILD" = 1 ]; then
  (cd webui && npm ci && npm run build)
  rm -rf penplot/web/static && cp -r webui/dist penplot/web/static
fi
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{"version":"%s","sha":"%s","built_at":"%s"}\n' \
  "$(python3 -c 'import re;print(re.search(r"__version__ = .(.+).", open("penplot/__init__.py").read()).group(1))')" \
  "$SHA" "$(date -u +%FT%TZ)" > penplot/web/static/_build.json

echo "== 2 lock"
if [ "$DEPS" = 1 ] || [ pyproject.toml -nt requirements-web.lock ]; then
  uv pip compile pyproject.toml --extra web --extra image --extra vector --extra office --extra pdf \
    --python-platform aarch64-unknown-linux-gnu --python-version 3.12 --only-binary :all: \
    --generate-hashes -o requirements-web.lock
fi

echo "== 3 guard"
# fail CLOSED: an unreachable/slow board might be mid-job
H="$(curl -fs --max-time 8 "http://$BOARD:$PORT/api/v1/system/health" || echo UNREACHABLE)"
if [ "$FORCE" = 0 ]; then
  if [ "$H" = UNREACHABLE ]; then
    if $SSH 'systemctl is-active -q penplot-web'; then
      echo "!! service is running but health did not answer; rerun with --force"; exit 1
    fi
  elif ! echo "$H" | grep -q '"job_active":false'; then
    echo "!! a job (or teletype session) is active on the plotter; rerun with --force"; exit 1
  fi
fi

echo "== 4 upload -> /opt/penplot/releases/$TS"
LINK=""
$SSH 'test -e /opt/penplot/current' && LINK="--link-dest=/opt/penplot/current/"
# allowlist: tracked + new-but-not-ignored files under the shipped dirs (never core dumps, DBs, .env)
LIST="$(mktemp)"
git ls-files --cached --others --exclude-standard -- penplot configs seed deploy pyproject.toml \
  requirements-web.lock README.md | grep -v -E '(^|/)core(\.[0-9]+)?$|\.db$|\.env$|__pycache__' > "$LIST"
find penplot/web/static -type f >> "$LIST"
rsync -az --chmod=Da+rx,Fa+r --delete $LINK --files-from="$LIST" ./ "$HOST:/opt/penplot/releases/$TS/"
rm -f "$LIST"

echo "== 5 deps"
$SSH "set -e; cd /opt/penplot/releases/$TS; NEW=\$(sha256sum requirements-web.lock | cut -d' ' -f1); \
  OLD=\$(cat /opt/penplot/venv/.lock-sha 2>/dev/null || true); \
  if [ \"\$NEW\" != \"\$OLD\" ] || [ $DEPS = 1 ]; then \
    PIP_NO_CACHE_DIR=1 /opt/penplot/venv/bin/pip install -q --default-timeout=60 ${PENPLOT_PIP_INDEX:+-i $PENPLOT_PIP_INDEX} --only-binary=:all: --require-hashes -r requirements-web.lock; \
    echo \$NEW > /opt/penplot/venv/.lock-sha; fi"

echo "== 6 precompile + 7 preflight"
$SSH "set -e; /opt/penplot/venv/bin/python -m compileall -q -j 4 /opt/penplot/releases/$TS/penplot; \
  cd /opt/penplot/releases/$TS && set -a && . /etc/penplot/web.env && set +a && \
  PYTHONPATH=/opt/penplot/releases/$TS /opt/penplot/venv/bin/python -m penplot.web check"

echo "== 8 switch"
PREV="$($SSH 'readlink /opt/penplot/current || true')"
$SSH "cd /opt/penplot && ln -sfn releases/$TS current.new && mv -T current.new current && systemctl restart penplot-web"

echo "== 9 health"
ok=0
for i in $(seq 1 30); do
  sleep 1
  if curl -fs --max-time 2 "http://$BOARD:$PORT/api/v1/system/health" >/dev/null; then ok=1; break; fi
done
if [ "$ok" != 1 ]; then
  echo "!! health check failed, rolling back to $PREV"
  if [ -n "$PREV" ]; then
    $SSH "cd /opt/penplot && ln -sfn $PREV current.new && mv -T current.new current && systemctl restart penplot-web"
  fi
  exit 1
fi

echo "== 10 prune (keep 3)"
$SSH 'cd /opt/penplot/releases && CUR=$(basename "$(readlink -f /opt/penplot/current)") && ls -1d */ | sed "s#/##" | grep -vx "$CUR" | sort | head -n -2 | xargs -r rm -rf'
echo "deployed $TS ($SHA) -> http://$BOARD:$PORT/"
