"""stdlib sqlite3 (WAL), one connection behind a lock, hand-written SQL.

Migrations: penplot/web/migrations/NNN_*.sql, applied at startup inside a
transaction; the DB is backed up first (sqlite backup API).
"""
import json
import os
import sqlite3
import threading
import time

MIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'migrations')


def migrations():
    out = []
    for fn in sorted(os.listdir(MIG_DIR)):
        if fn.endswith('.sql') and fn[:3].isdigit():
            out.append((int(fn[:3]), os.path.join(MIG_DIR, fn)))
    return out


LATEST = max(n for n, _ in migrations())


class SchemaTooNew(RuntimeError):
    pass


class DB:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        if path != ':memory:':
            os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        for p in ('journal_mode=WAL', 'synchronous=NORMAL', 'temp_store=MEMORY',
                  'busy_timeout=5000', 'foreign_keys=ON'):
            self.conn.execute('PRAGMA ' + p)

    # ------------------------------------------------------------ schema
    def schema_version(self):
        with self._lock:
            try:
                r = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            except sqlite3.OperationalError:
                return 0
            return int(r[0]) if r else 0

    def migrate(self, dry_run=False):
        cur = self.schema_version()
        if cur > LATEST:
            raise SchemaTooNew('database schema %d is newer than this release (%d)' % (cur, LATEST))
        todo = [(n, p) for n, p in migrations() if n > cur]
        if dry_run or not todo:
            return [n for n, _ in todo]
        if cur > 0 and self.path != ':memory:':
            bak = sqlite3.connect('%s.bak-%d' % (self.path, cur))
            with self._lock:
                self.conn.backup(bak)
            bak.close()
        with self._lock:
            for n, p in todo:
                sql = open(p, encoding='utf-8').read()
                self.conn.execute('BEGIN')
                try:
                    for stmt in _split_sql(sql):
                        self.conn.execute(stmt)
                    self.conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)",
                                      (str(n),))
                    self.conn.execute('COMMIT')
                except Exception:
                    self.conn.execute('ROLLBACK')
                    raise
        return [n for n, _ in todo]

    # ------------------------------------------------------------ access
    def execute(self, sql, args=()):
        with self._lock:
            return self.conn.execute(sql, args)

    def executemany(self, sql, seq):
        with self._lock:
            return self.conn.executemany(sql, seq)

    def all(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        with self._lock:
            r = self.conn.execute(sql, args).fetchone()
            return dict(r) if r else None

    def scalar(self, sql, args=()):
        with self._lock:
            r = self.conn.execute(sql, args).fetchone()
            return r[0] if r else None

    def tx(self):
        return _Tx(self)

    def close(self):
        with self._lock:
            try:
                self.conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------ helpers
    def audit(self, actor, action, detail=None):
        self.execute('INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)',
                     (time.time(), actor or '-', action, json.dumps(detail, ensure_ascii=False)
                      if detail is not None else None))

    def get_setting(self, key, default=None):
        r = self.scalar('SELECT value FROM settings WHERE key=?', (key,))
        return json.loads(r) if r is not None else default

    def set_setting(self, key, value):
        self.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',
                     (key, json.dumps(value, ensure_ascii=False)))


class _Tx:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        self.db._lock.acquire()
        self.db.conn.execute('BEGIN')
        return self.db

    def __exit__(self, et, e, tb):
        try:
            self.db.conn.execute('COMMIT' if et is None else 'ROLLBACK')
        finally:
            self.db._lock.release()
        return False


def _split_sql(sql):
    out, buf = [], []
    for line in sql.split('\n'):
        s = line.strip()
        if s.startswith('--'):
            continue
        buf.append(line)
        if s.endswith(';'):
            stmt = '\n'.join(buf).strip().rstrip(';')
            if stmt:
                out.append(stmt)
            buf = []
    rest = '\n'.join(buf).strip()
    if rest:
        out.append(rest)
    return out


def jdump(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def jload(s, default=None):
    if s is None:
        return default
    try:
        return json.loads(s)
    except ValueError:
        return default
