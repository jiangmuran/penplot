"""python -m penplot.web serve | dump-openapi | reset-password | check"""
import argparse
import json
import logging
import os
import sys


def _logging(level):
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO),
                        format='%(levelname)s %(name)s %(message)s', stream=sys.stderr)


def cmd_serve(args):
    from .config import Config
    cfg = Config.from_env()
    if args.port:
        cfg.port = args.port
    if args.host:
        cfg.host = args.host
    _logging(cfg.log_level)
    import uvicorn
    from .app import create_app
    app = create_app(cfg)
    kw = dict(host=cfg.host, port=cfg.port, loop='asyncio', http='h11', ws='websockets-sansio',
              access_log=False, log_level=cfg.log_level.lower(), ws_ping_interval=15,
              ws_ping_timeout=30, timeout_graceful_shutdown=40, lifespan='on',
              # Keep idle browser connections (uvicorn default: 5 s). On the board's lossy WiFi a
              # fresh TCP connection costs p50 180 ms / p90 1 s vs 13 ms / 0.4 s on a kept-alive
              # one (09-perf), and every click after a 5 s pause used to pay it.
              timeout_keep_alive=int(os.environ.get('PENPLOT_KEEPALIVE_S', '75')))
    if cfg.tls_cert and cfg.tls_key:
        kw.update(ssl_certfile=cfg.tls_cert, ssl_keyfile=cfg.tls_key)
    uvicorn.run(app, **kw)
    return 0


def cmd_dump_openapi(args):
    from .app import create_app
    from .config import Config
    app = create_app(Config.from_env(env={}), start_services=False)
    spec = app.openapi()
    out = json.dumps(spec, ensure_ascii=False, indent=1, sort_keys=False)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(out + '\n')
    else:
        sys.stdout.write(out + '\n')
    return 0


def cmd_reset_password(args):
    from .auth import AuthService
    from .config import Config
    from .db import DB
    cfg = Config.from_env()
    db = DB(cfg.db_path)
    db.migrate()
    a = AuthService(db, cfg)
    if not a.has_admin():
        print('no users yet: open the web UI and use setup code %s' % a.ensure_setup_code())
        return 0
    user, pw = a.reset_password(args.password, args.user)
    print('password for %s %s; their sessions were revoked' % (user, 'set' if args.password else 'is now: ' + pw))
    return 0


def cmd_check(args):
    """Preflight for deploy: imports, migrations dry-run, static present."""
    from .config import Config
    from .db import DB, SchemaTooNew
    cfg = Config.from_env()
    ok = True
    try:
        from . import app as _app  # noqa
        from .context import AppContext  # noqa
        print('imports: ok')
    except Exception as e:
        print('imports: FAIL %s' % e)
        ok = False
    if os.path.exists(cfg.db_path):
        try:
            todo = DB(cfg.db_path).migrate(dry_run=True)
            print('migrations pending: %s' % (todo or 'none'))
        except SchemaTooNew as e:
            print('db: FAIL %s' % e)
            ok = False
    else:
        print('db: not created yet (fresh install)')
    static = os.path.isfile(os.path.join(cfg.static_dir, 'index.html'))
    print('static: %s (%s)' % ('ok' if static else 'MISSING', cfg.static_dir))
    from .context import probe_features
    print('features: %s' % probe_features())
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog='penplot-web')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('serve')
    p.add_argument('--host')
    p.add_argument('--port', type=int)
    p.set_defaults(fn=cmd_serve)
    p = sub.add_parser('dump-openapi')
    p.add_argument('-o', '--out')
    p.set_defaults(fn=cmd_dump_openapi)
    p = sub.add_parser('reset-password')
    p.add_argument('--password', help='new password (default: a random one is printed)')
    p.add_argument('--user', help='username (default: the first admin)')
    p.set_defaults(fn=cmd_reset_password)
    p = sub.add_parser('check')
    p.set_defaults(fn=cmd_check)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
