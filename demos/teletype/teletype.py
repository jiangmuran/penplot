# -*- coding: utf-8 -*-
"""Teletype demo: a web page drives the pen plotter as a live paper terminal.

Runs ON the plotter host (Orange Pi). Needs only the stdlib + pyserial.
The browser (any PC on the LAN) is the keyboard and the monitor:

  typing mode    every key is drawn on paper immediately (typewriter;
                 Backspace moves the carriage back, next char overstrikes)
  terminal mode  a real interactive login shell on a PTY (ssh, python, ...);
                 the browser is a full xterm, the paper gets a teletype
                 transcript of the session in small text

usage:
  python teletype.py                       # real plotter (configs/grbl-zpen.json)
  python teletype.py --port fake           # simulated GRBL, for trying the UI
Open the URL it prints (contains the access key, the shell runs as this user).

Paper: origin = pen position at start (park the pen at the paper's top-left
corner, pen up). X right, Y negative downward.
"""
import argparse
import collections
import json
import math
import codecs
import fcntl
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import font  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_PORT = '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'


# =========================================================== event hub
class Hub:
    """Fan-out of JSON events to every connected browser (SSE)."""

    def __init__(self):
        self.clients = {}
        self.lock = threading.Lock()

    def add(self):
        q = collections.deque()
        ev = threading.Event()
        with self.lock:
            self.clients[id(q)] = (q, ev)
        return q, ev

    def remove(self, q):
        with self.lock:
            self.clients.pop(id(q), None)

    def send(self, **msg):
        data = json.dumps(msg, ensure_ascii=False)
        with self.lock:
            for q, ev in self.clients.values():
                if len(q) < 5000:
                    q.append(data)
                ev.set()


HUB = Hub()


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)
    HUB.send(t='log', msg=msg)


# =========================================================== fake GRBL
class FakeSerial:
    """Minimal GRBL 1.1 simulator: 15-block planner, real-time motion,
    '?' status, '!' / '~' hold, 0x18 reset, G10 L20 work zero."""

    def __init__(self):
        self.out = bytearray()
        self.lock = threading.Lock()
        self.lines = collections.deque()
        self.buf = b''
        self.planner = collections.deque()
        self.pos = [0.0, 0.0, 0.0]
        self.wco = [0.0, 0.0, 0.0]
        self.feed = 1000.0
        self.hold = False
        self.is_open = True
        self._reset()
        threading.Thread(target=self._run, daemon=True).start()

    def _reply(self, s):
        with self.lock:
            self.out += (s + '\r\n').encode()

    def _reset(self):
        self.lines.clear()
        self.planner.clear()
        self.hold = False
        self._reply('')
        self._reply("Grbl 1.1f ['$' for help]")

    @property
    def in_waiting(self):
        with self.lock:
            return len(self.out)

    def read(self, n):
        with self.lock:
            d, self.out = bytes(self.out[:n]), self.out[n:]
        return d

    def write(self, data):
        for b in data:
            c = bytes([b])
            if c == b'?':
                st = 'Hold:0' if self.hold else ('Run' if self.planner else 'Idle')
                p = ','.join('%.3f' % v for v in self.pos)
                w = ','.join('%.3f' % v for v in self.wco)
                self._reply('<%s|MPos:%s|FS:%d,0|WCO:%s>' % (st, p, self.feed, w))
            elif c == b'!':
                self.hold = True
            elif c == b'~':
                self.hold = False
            elif c == b'\x18':
                self._reset()
            elif c == b'\n':
                self.lines.append(self.buf.decode().strip())
                self.buf = b''
            elif c != b'\r':
                self.buf += c
        return len(data)

    def close(self):
        self.is_open = False

    def _parse(self, line):
        u = line.upper().replace(' ', '')
        if u.startswith('G10') and 'L20' in u:
            self.wco = list(self.pos)
            return None
        if u.startswith('$'):
            return None
        words = dict((m.group(1), float(m.group(2)))
                     for m in re.finditer(r'([A-Z])(-?[\d.]+)', u))
        if 'F' in words:
            self.feed = words['F']
        if not any(k in words for k in 'XYZ'):
            return None
        rapid = 'G0' in u and 'G1' not in u
        tgt = [words[k] + self.wco[i] if k in words else self.pos[i]
               for i, k in enumerate('XYZ')]
        return tgt, (6000.0 if rapid else self.feed)

    def _run(self):
        while self.is_open:
            while self.lines and len(self.planner) < 15:
                mv = self._parse(self.lines.popleft())
                if mv:
                    self.planner.append(mv)
                self._reply('ok')
            if self.planner and not self.hold:
                tgt, f = self.planner[0]
                d = math.dist(tgt, self.pos)
                step = f / 60.0 * 0.01
                if d <= step:
                    self.pos = list(tgt)
                    self.planner.popleft()
                    time.sleep(0.003)
                else:
                    self.pos = [p + (t - p) * step / d for p, t in zip(self.pos, tgt)]
                    time.sleep(0.01)
            else:
                time.sleep(0.005)


# =========================================================== GRBL stream
class Grbl:
    """Append-only G-code streamer with character-counting flow control.

    Every queued line may carry a tag; when the line is acknowledged the
    tag is reported through on_ack (used to mark characters as sent)."""

    RX = 120   # bytes of GRBL's 128-byte RX buffer we allow in flight

    def __init__(self, port, baud=115200, on_ack=None):
        self.port, self.baud = port, baud
        self.on_ack = on_ack or (lambda tag: None)
        self.ser = None
        self.q = collections.deque()          # (line, tag)
        self.inflight = collections.deque()   # (nbytes, tag)
        self.cv = threading.Condition()
        self.banner = threading.Event()
        self.state = 'Offline'
        self.wpos = (0.0, 0.0, 0.0)
        self.wco = (0.0, 0.0, 0.0)
        self.params = {}
        self.errors = 0
        self.wlock = threading.Lock()

    # -------------------------------------------------------- connect
    def open(self):
        if self.port == 'fake':
            self.ser = FakeSerial()
        else:
            import serial
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
        threading.Thread(target=self._rx_loop, daemon=True).start()
        threading.Thread(target=self._tx_loop, daemon=True).start()
        threading.Thread(target=self._poll_loop, daemon=True).start()
        if not self.banner.wait(3.0):         # opening may not reset the board
            self.realtime(b'\x18')
            if not self.banner.wait(3.0):
                raise RuntimeError('no GRBL banner on %s' % self.port)
        time.sleep(0.2)

    def _write(self, data):
        with self.wlock:
            self.ser.write(data)

    def realtime(self, b):
        self._write(b)

    # -------------------------------------------------------- queue
    def queue(self, lines, tag=None):
        """Append lines; the tag is attached to the LAST line."""
        with self.cv:
            for i, ln in enumerate(lines):
                self.q.append((ln, tag if i == len(lines) - 1 else None))
            self.cv.notify_all()

    def command(self, line, timeout=10.0):
        """Queue one line and wait until it is acknowledged."""
        done = threading.Event()
        self.queue([line], tag=('sync', done))
        return done.wait(timeout)

    def pending(self):
        with self.cv:
            return len(self.q) + len(self.inflight)

    def flush(self):
        """Drop everything not yet sent; returns the dropped tags."""
        with self.cv:
            tags = [t for _, t in self.q if t is not None]
            self.q.clear()
            return tags

    def wait_drained(self, timeout=600):
        end = time.time() + timeout
        while time.time() < end:
            if self.pending() == 0 and self.state.startswith('Idle'):
                return True
            time.sleep(0.1)
        return False

    def stop(self):
        """Feed hold + soft reset: kills buffered motion, keeps position."""
        dropped = self.flush()
        self.realtime(b'!')
        time.sleep(0.5)
        self.banner.clear()
        with self.cv:
            dropped += [t for _, t in self.inflight if t is not None]
            self.inflight.clear()
            self.cv.notify_all()
        self.realtime(b'\x18')
        self.banner.wait(3.0)
        time.sleep(0.2)
        return dropped

    # -------------------------------------------------------- loops
    def _tx_loop(self):
        while True:
            with self.cv:
                while not self.q or (self.inflight and
                                     sum(n for n, _ in self.inflight)
                                     + len(self.q[0][0]) + 1 > self.RX):
                    self.cv.wait(0.5)
                line, tag = self.q.popleft()
                self.inflight.append((len(line) + 1, tag))
                self._write((line + '\n').encode())

    def _poll_loop(self):
        while True:
            time.sleep(0.2)
            try:
                if self.banner.is_set():
                    self._write(b'?')
            except Exception:
                pass

    def _rx_loop(self):
        buf = b''
        while True:
            try:
                n = self.ser.in_waiting
                chunk = self.ser.read(n or 1) if n else b''
            except Exception as e:
                log('serial error: %s' % e)
                self.state = 'Offline'
                return
            if not chunk:
                time.sleep(0.005)
                continue
            buf += chunk
            while b'\n' in buf:
                raw, buf = buf.split(b'\n', 1)
                line = raw.decode('utf-8', 'replace').strip()
                if line:
                    self._handle(line)

    def _ack(self, ok, line):
        with self.cv:
            tag = self.inflight.popleft()[1] if self.inflight else None
            self.cv.notify_all()
        if not ok:
            self.errors += 1
            log('GRBL %s' % line)
        if isinstance(tag, tuple) and tag and tag[0] == 'sync':
            tag[1].set()
        elif tag is not None:
            self.on_ack(tag)

    def _handle(self, line):
        if line == 'ok':
            self._ack(True, line)
        elif line.startswith('error'):
            self._ack(False, line)
        elif line.startswith('<'):
            self._status(line[1:-1])
        elif line.startswith('Grbl'):
            with self.cv:
                self.inflight.clear()
                self.cv.notify_all()
            self.banner.set()
            log('controller: %s' % line)
        elif line.startswith('ALARM'):
            self.state = 'Alarm'
            dropped = self.flush()
            log('%s — 队列已清空 (%d 字未打印)' % (line, len(dropped)))
            HUB.send(t='dropped', ids=[t for t in dropped if isinstance(t, int)])
        elif line.startswith('$') and '=' in line:
            k, v = line.split('=', 1)
            self.params[k] = v.split()[0]
        elif line.startswith('[MSG'):
            log(line)

    def _status(self, body):
        parts = body.split('|')
        self.state = parts[0]
        mpos = wpos = None
        for p in parts[1:]:
            key, _, val = p.partition(':')
            try:
                vals = tuple(float(v) for v in val.split(','))
            except ValueError:
                continue
            if key == 'MPos':
                mpos = vals
            elif key == 'WPos':
                wpos = vals
            elif key == 'WCO':
                self.wco = vals
        if wpos is None and mpos is not None:
            wpos = tuple(m - w for m, w in zip(mpos, self.wco))
        if wpos:
            self.wpos = wpos


# =========================================================== text helpers
PUNCT = {'，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!',
         '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[',
         '】': ']', '《': '<', '》': '>', '—': '-', '–': '-', '…': '...', '·': '.',
         '～': '~', '￥': '$', '　': ' '}


def normalize(ch):
    """Map full-width / CJK punctuation to the ASCII the pen font has."""
    o = ord(ch)
    if 0xFF01 <= o <= 0xFF5E:
        return chr(o - 0xFEE0)
    return PUNCT.get(ch, ch)


def cell_width(ch):
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


# =========================================================== paper model
class Paper:
    """Character grid on the sheet + G-code generation per character.

    Writers send small ops: ('c', col, ch) draw a char on the current row,
    ('n',) line feed, ('x', col) move the (displayed) cursor."""

    def __init__(self, cfg, grbl):
        self.cfg = cfg
        self.g = grbl
        self.lock = threading.RLock()
        self.page = 1
        self.next_id = 1
        self.need_paper = False
        self.overflow = collections.deque()   # ops waiting for a new sheet
        self.queued = 0                       # chars sent to GRBL, not acked
        self.skipped = 0                      # chars dropped by backlog guard
        self.reset_page()

    # -------------------------------------------------------- geometry
    def geometry(self):
        c = self.cfg
        h = c['char_h']
        cw, lh = h * c['cell_w'], h * c['line_h']
        cols = int((c['paper_w'] - 2 * c['margin']) // cw)
        rows = int((c['paper_h'] - 2 * c['margin'] - h) // lh) + 1
        return dict(h=h, cw=cw, lh=lh, cols=max(cols, 10), rows=max(rows, 1),
                    margin=c['margin'], paper_w=c['paper_w'], paper_h=c['paper_h'])

    def reset_page(self):
        with self.lock:
            self.geo = self.geometry()
            self.row = self.col = 0
            self.chars = []          # dicts: id,ch,row,col,st (q/ok)
            self.by_id = {}

    def snapshot(self):
        with self.lock:
            return dict(page=self.page, geo=self.geo, row=self.row, col=self.col,
                        chars=[[c['id'], c['ch'], c['row'], c['col'], c['st']]
                               for c in self.chars],
                        need_paper=self.need_paper, overflow=len(self.overflow))

    # -------------------------------------------------------- writing
    def apply(self, ops):
        new = []
        with self.lock:
            limit = self.cfg['max_backlog']
            if self.skipped and self.queued < limit // 2 and not self.need_paper:
                n, self.skipped = self.skipped, 0
                if self.col:
                    self._newline()
                for i, ch in enumerate('[... %d chars not printed ...]' % n):
                    self._char(i, ch, new)
                self._newline()
            for i, op in enumerate(ops):
                if self.need_paper:
                    if len(self.overflow) < 20000:
                        self.overflow.extend(ops[i:])
                    break
                if op[0] == 'c':
                    if self.queued >= limit or self.skipped:
                        self.skipped += 1
                        continue
                    self._char(op[1], op[2], new)
                elif op[0] == 'n':
                    if not self.skipped:
                        self._newline()
                elif op[0] == 'x':
                    if not self.skipped:
                        self.col = min(op[1], self.geo['cols'])
        self._publish(new)

    def typewrite(self, text):
        """Typewriter semantics, driven by the paper's own carriage."""
        new = []
        with self.lock:
            if self.need_paper:
                return False
            for ch in text:
                if ch == '\n':
                    self._newline()
                elif ch == '\b':
                    self.col = max(0, self.col - 1)
                elif ch == '\t':
                    self.col = min(self.geo['cols'] - 1, (self.col // 8 + 1) * 8)
                else:
                    if self.col >= self.geo['cols']:
                        self._newline()
                    if self.need_paper:
                        break
                    if ch != ' ':
                        self._char(self.col, ch, new)   # advances the carriage
                    else:
                        self.col += 1
                if self.need_paper:
                    break
        self._publish(new)
        return True

    def newline_if_needed(self):
        with self.lock:
            if self.col and not self.need_paper:
                self._newline()
        self._cursor()

    def _char(self, col, ch, new):
        if col >= self.geo['cols'] or ch == ' ':
            return
        c = dict(id=self.next_id, ch=ch, row=self.row, col=col, st='q')
        self.next_id += 1
        self.chars.append(c)
        self.by_id[c['id']] = c
        new.append(c)
        self.queued += 1
        self.g.queue(self.gcode(c), tag=c['id'])
        self.col = col + 1

    def _newline(self):
        self.col = 0
        self.row += 1
        if self.row >= self.geo['rows']:
            self.need_paper = True
            self.g.queue(['G0 X0 Y0'])     # park at origin, pen is up
            log('第 %d 页写满：换纸后点「已换纸」继续' % self.page)
            HUB.send(t='need_paper', on=True)

    def _publish(self, new):
        if new:
            HUB.send(t='chars', list=[[c['id'], c['ch'], c['row'], c['col'], 'q']
                                      for c in new])
        self._cursor()

    def _cursor(self):
        HUB.send(t='cursor', row=self.row, col=self.col)

    def new_sheet(self):
        """Paper was changed: start a fresh page and flush overflow."""
        with self.lock:
            self.need_paper = False
            self.page += 1
            self.reset_page()
            pending = list(self.overflow)
            self.overflow.clear()
        HUB.send(t='snapshot', **self.snapshot())
        if pending:
            self.apply(pending)

    def ack(self, cid):
        c = self.by_id.get(cid)
        self.queued = max(0, self.queued - 1)
        if c:
            c['st'] = 'ok'
            HUB.send(t='ack', id=cid)

    def dropped(self, ids):
        """Chars that never reached the plotter: forget them and move the
        cursor back to where the first of them was, so the page stays true."""
        with self.lock:
            self.overflow.clear()
            self.queued = 0
            self.skipped = 0
            gone = [self.by_id[i] for i in ids if i in self.by_id]
            if gone:
                first = min(gone, key=lambda c: c['id'])
                self.row, self.col = first['row'], first['col']
                self.chars = [c for c in self.chars if c['id'] < first['id']]
                self.by_id = {c['id']: c for c in self.chars}
            if self.need_paper and self.row < self.geo['rows']:
                self.need_paper = False
                HUB.send(t='need_paper', on=False)
            elif self.need_paper:      # the park move was dropped too
                self.g.queue(['G0 X0 Y0'])
        HUB.send(t='dropped', ids=[c['id'] for c in gone])
        self._cursor()

    # -------------------------------------------------------- gcode
    def gcode(self, c):
        geo, cfg = self.geo, self.cfg
        u = geo['h'] / 6.0
        x0 = geo['margin'] + c['col'] * geo['cw'] + (geo['cw'] - 4 * u) / 2
        y0 = geo['margin'] + c['row'] * geo['lh']
        down = 'G1 Z%s F%d' % (num(cfg['z_down']), cfg['z_speed'])
        up = 'G1 Z%s F%d' % (num(cfg['z_up']), cfg['z_speed'])
        out = []
        for stroke in font.glyph(c['ch']):
            pts = [(x0 + gx * u, -(y0 + gy * u)) for gx, gy in stroke]
            out.append('G0 X%s Y%s' % (num(pts[0][0]), num(pts[0][1])))
            out.append(down)
            first = True
            for x, y in pts[1:]:
                out.append('G1 X%s Y%s%s' % (num(x), num(y),
                                             ' F%d' % cfg['feed'] if first else ''))
                first = False
            out.append(up)
        return out


def num(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


# =========================================================== tty -> paper
class TtyFilter:
    """Turns a terminal byte stream into teletype paper ops.

    Keeps a model of the current line. A character landing on a blank cell
    is inked immediately (echo, streaming output). Rewrites of already-inked
    cells (\\r, backspace, readline redraws, progress bars) are held and
    overstruck once when the line is finished, so a spinner doesn't turn
    into a blot. Full-screen programs (alternate screen) are not printed.
    """

    NOTE = '[full-screen program - not printed]'

    def __init__(self, cols):
        self.cols = cols
        self.x = 0
        self.alt = False
        self.state = 'g'
        self.buf = ''
        self.reset_line()

    def reset_line(self):
        self.cells = [' '] * self.cols
        self.ink = [' '] * self.cols

    def resize(self, cols):
        self.cols = cols
        self.x = min(self.x, cols - 1)
        self.reset_line()

    def mark_printed(self):
        self.ink = list(self.cells)

    def reprint_line(self):
        """Ops that put the whole current line on a fresh paper line."""
        self.ink = [' '] * self.cols
        ops = [('c', i, ch) for i, ch in enumerate(self.cells) if ch != ' ']
        self.ink = list(self.cells)
        ops.append(('x', self.x))
        return ops

    # -------------------------------------------------------- feed
    def feed(self, text):
        ops = []
        for ch in text:
            st = self.state
            if st == 'g':
                self._ground(ch, ops)
            elif st == 'esc':
                self.state = 'g'
                if ch == '[':
                    self.state, self.buf = 'csi', ''
                elif ch in ']PX^_':
                    self.state = 'osc'
                elif ch in '()*+#%':
                    self.state = 'skip1'
            elif st == 'csi':
                if '\x40' <= ch <= '\x7e':
                    self.state = 'g'
                    self._csi(self.buf, ch, ops)
                elif len(self.buf) < 32:
                    self.buf += ch
                else:
                    self.state = 'g'
            elif st == 'osc':
                if ch == '\x07':
                    self.state = 'g'
                elif ch == '\x1b':
                    self.state = 'osc_esc'
            elif st == 'osc_esc':
                self.state = 'g' if ch == '\\' else 'osc'
            elif st == 'skip1':
                self.state = 'g'
        if not self.alt:
            ops.append(('x', min(self.x, self.cols)))
        return ops

    def _ground(self, ch, ops):
        if ch == '\x1b':
            self.state = 'esc'
            return
        if self.alt:
            return
        if ch == '\r':
            self.x = 0
        elif ch == '\n':
            self._commit(ops)
            ops.append(('n',))
            self.reset_line()
        elif ch == '\b':
            self.x = max(0, self.x - 1)
        elif ch == '\t':
            self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
        elif ch < ' ' or ch == '\x7f':
            pass
        else:
            for c in normalize(ch):
                self._put(c, ops)

    def _put(self, c, ops):
        w = cell_width(c)
        if self.x + w > self.cols:          # auto-wrap like a real terminal
            self._commit(ops)
            ops.append(('n',))
            self.reset_line()
            self.x = 0
        self.cells[self.x] = c
        if w == 2:
            self.cells[self.x + 1] = ' '
        if self.ink[self.x] == ' ' and c != ' ':
            ops.append(('c', self.x, c))
            self.ink[self.x] = c
        self.x += w

    def _commit(self, ops):
        for i, (c, k) in enumerate(zip(self.cells, self.ink)):
            if c != k and c != ' ':
                ops.append(('c', i, c))
            elif c == ' ' and k not in (' ', '/'):
                ops.append(('c', i, '/'))      # ink can't be erased: strike it
        self.ink = list(self.cells)

    def _csi(self, buf, final, ops):
        private = buf[:1] in '?>=<' and buf != ''
        nums = []
        for p in buf.lstrip('?>=<').split(';'):
            nums.append(int(p) if p.isdigit() else 0)
        n = max(1, nums[0]) if nums else 1
        if private and final in 'hl' and set(nums) & {47, 1047, 1049}:
            on = final == 'h'
            if on and not self.alt:
                self._commit(ops)
                if any(c != ' ' for c in self.ink):
                    ops.append(('n',))
                ops += [('c', i, c) for i, c in enumerate(self.NOTE[:self.cols])]
                ops.append(('n',))
            self.alt = on
            self.reset_line()
            return
        if self.alt or private:
            return
        cells, x = self.cells, self.x
        if final == 'K':
            mode = nums[0] if nums else 0
            rng = range(x, self.cols) if mode == 0 else (
                range(0, min(x + 1, self.cols)) if mode == 1 else range(self.cols))
            for i in rng:
                cells[i] = ' '
        elif final == 'D':
            self.x = max(0, x - n)
        elif final == 'C':
            self.x = min(self.cols - 1, x + n)
        elif final in 'G`':
            self.x = min(self.cols - 1, n - 1)
        elif final in 'Hf':
            col = nums[1] if len(nums) > 1 and nums[1] else 1
            self.x = min(self.cols - 1, col - 1)
        elif final == 'P':
            x = min(x, self.cols)
            self.cells = cells[:x] + cells[x + n:] + [' '] * min(n, self.cols - x)
            self.cells = self.cells[:self.cols]
        elif final == '@':
            self.cells = (cells[:x] + [' '] * n + cells[x:])[:self.cols]
        elif final == 'X':
            for i in range(x, min(self.cols, x + n)):
                cells[i] = ' '
        elif final == 'J' and (nums[0] if nums else 0) in (2, 3):
            self._commit(ops)
            if any(c != ' ' for c in self.ink):
                ops.append(('n',))
            self.reset_line()


# =========================================================== pty shell
class Pty:
    """A real interactive login shell on a pseudo-terminal."""

    ROWS = 30

    def __init__(self, on_output, cols):
        self.on_output = on_output
        self.cols = cols
        self.fd = None
        self.proc = None
        self.lock = threading.Lock()

    def start(self):
        master, slave = os.openpty()
        self._winsize(slave, self.cols)
        env = dict(os.environ, TERM='xterm-256color', COLORTERM='',
                   LANG=os.environ.get('LANG', 'C.UTF-8'),
                   COLUMNS=str(self.cols), LINES=str(self.ROWS))
        env.pop('PROMPT_COMMAND', None)
        try:                                   # systemd services have no HOME/USER
            import pwd
            pw = pwd.getpwuid(os.getuid())
            env.setdefault('HOME', pw.pw_dir)
            env.setdefault('USER', pw.pw_name)
            env.setdefault('SHELL', pw.pw_shell or '/bin/bash')
        except (ImportError, KeyError):
            pass

        def ctty():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(
            ['bash', '-l'], stdin=slave, stdout=slave, stderr=slave,
            cwd=os.path.expanduser('~'), env=env, start_new_session=True,
            preexec_fn=ctty, close_fds=True)
        os.close(slave)
        self.fd = master
        threading.Thread(target=self._reader, args=(master, self.proc),
                         daemon=True).start()

    def _winsize(self, fd, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', self.ROWS, cols, 0, 0))

    def resize(self, cols):
        self.cols = cols
        if self.fd is not None:
            try:
                self._winsize(self.fd, cols)
            except OSError:
                pass

    def write(self, data):
        if self.fd is None:
            return
        with self.lock:
            b = data.encode('utf-8')
            while b:
                n = os.write(self.fd, b)
                b = b[n:]

    def _reader(self, fd, proc):
        dec = codecs.getincrementaldecoder('utf-8')('replace')
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                data = b''
            if not data:
                break
            self.on_output(dec.decode(data))
        proc.wait()
        os.close(fd)
        self.fd = None
        self.on_output('\r\n[shell exited %s, restarting]\r\n' % proc.returncode)
        time.sleep(1)
        self.start()


# =========================================================== app
class App:
    def __init__(self, args):
        z = load_pen(args.config)
        self.cfg = dict(char_h=args.char_h, cell_w=0.8, line_h=1.6,
                        paper_w=args.paper[0], paper_h=args.paper[1],
                        margin=args.margin, feed=args.feed,
                        z_down=z['zOn'] if args.z_down is None else args.z_down,
                        z_up=z['zOff'] if args.z_up is None else args.z_up,
                        z_speed=z['zSpeed'], max_backlog=args.max_backlog)
        self.mode = 'type'
        self.grbl = Grbl(args.port, on_ack=lambda tag: self.paper.ack(tag))
        self.paper = Paper(self.cfg, self.grbl)
        cols = self.paper.geo['cols']
        self.tty = TtyFilter(cols)
        self.pty = Pty(self.on_pty, cols)
        self.pty_log = collections.deque()      # monitor replay for new tabs
        self.pty_log_len = 0
        self.typed_log = ''
        self.lock = threading.Lock()
        self.paused = False

    def start(self):
        log('connecting %s ...' % self.grbl.port)
        self.grbl.open()
        g = self.grbl
        g.command('$X')
        g.command('G21 G90')
        g.command('G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed']))
        g.command('G10 L20 P0 X0 Y0 Z0')     # origin = where the pen is parked
        g.command('$$')
        p = g.params
        log('ready. $110/$111 max X/Y %s/%s mm/min, $120/$121 accel %s/%s, '
            '$112 Z %s mm/min' % (p.get('$110'), p.get('$111'), p.get('$120'),
                                  p.get('$121'), p.get('$112')))
        self.pty.start()
        threading.Thread(target=self._status_loop, daemon=True).start()

    def _status_loop(self):
        last, t_last = None, 0
        while True:
            g = self.grbl
            msg = (g.state, round(g.wpos[0], 2), round(g.wpos[1], 2),
                   round(g.wpos[2], 2), g.pending(), self.paused)
            if msg != last or time.time() - t_last > 2:   # resend for new tabs
                HUB.send(t='status', state=g.state, x=msg[1], y=msg[2], z=msg[3],
                         pending=msg[4], paused=self.paused)
                last, t_last = msg, time.time()
            time.sleep(0.15)

    # -------------------------------------------------------- pty stream
    def on_pty(self, text):
        with self.lock:
            HUB.send(t='pty', data=text)
            self.pty_log.append(text)
            self.pty_log_len += len(text)
            while self.pty_log_len > 200000 and len(self.pty_log) > 1:
                self.pty_log_len -= len(self.pty_log.popleft())
            ops = self.tty.feed(text)          # always: keeps the line model
            if self.mode == 'term':
                self.paper.apply(ops)

    def state(self):
        with self.lock:
            pty_log = ''.join(self.pty_log)
        return dict(mode=self.mode, cfg=self.cfg, paper=self.paper.snapshot(),
                    font=font.as_json(), cols=self.tty.cols, rows=Pty.ROWS,
                    pty_log=pty_log, typed_log=self.typed_log[-20000:])

    def set_mode(self, m):
        with self.lock:
            if m == self.mode:
                return
            self.mode = m
            self.paper.newline_if_needed()
            if m == 'term':                    # put the current prompt on paper
                self.paper.apply(self.tty.reprint_line())
        HUB.send(t='mode', mode=m)

    def typed(self, data):
        """Typing mode input (xterm onData): returns echo for the monitor."""
        out, echo = [], []
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == '\x1b':                   # arrow keys etc: ignore
                j = i + 1
                if j < len(data) and data[j] in '[O':
                    j += 1
                    while j < len(data) and not ('\x40' <= data[j] <= '\x7e'):
                        j += 1
                i = j + 1
                continue
            if ch in '\r\n':
                out.append('\n')
                echo.append('\r\n')
            elif ch in '\x7f\b':
                out.append('\b')
                echo.append('\b')
            elif ch == '\t':
                out.append('\t')
                echo.append('\t')
            elif ch >= ' ':
                for c in normalize(ch):
                    out.append(c)
                    echo.append(c)
            i += 1
        if not self.paper.typewrite(''.join(out)):
            return False
        e = ''.join(echo)
        self.typed_log += e
        HUB.send(t='typed', data=e)
        return True

    # -------------------------------------------------------- api
    def api(self, path, body):
        if path == '/api/keys':
            if self.mode != 'type':
                return {'ok': False, 'error': '当前是终端模式'}
            if not self.typed(body.get('data', '')):
                return {'ok': False, 'error': '纸写满了，先换纸'}
            return {'ok': True}
        if path == '/api/pty':
            if self.mode != 'term':
                return {'ok': False, 'error': '当前是打字模式'}
            self.pty.write(body.get('data', ''))
            return {'ok': True}
        if path == '/api/mode':
            m = body.get('mode')
            if m in ('type', 'term'):
                self.set_mode(m)
            return {'ok': True}
        if path == '/api/settings':
            for k in ('feed', 'z_up', 'z_down', 'max_backlog', 'char_h', 'margin',
                      'paper_w', 'paper_h'):
                if k in body:
                    self.cfg[k] = type(self.cfg[k])(body[k])
            self.cfg['z_up'] = max(0.0, min(self.cfg['z_up'], self.cfg['z_down']))
            note = ''
            if self.paper.chars or self.paper.col or self.paper.row:
                note = '字号/纸张/边距在下一页生效'
            else:
                self.paper.reset_page()
                self._apply_cols()
                HUB.send(t='snapshot', **self.paper.snapshot())
            HUB.send(t='cfg', cfg=self.cfg)
            return {'ok': True, 'note': note}
        if path == '/api/action':
            return self.action(body.get('a'))
        if path == '/api/jog':
            if self.grbl.pending():
                return {'ok': False, 'error': '正在打印，不能点动'}
            dx, dy = float(body.get('dx', 0)), float(body.get('dy', 0))
            self.grbl.queue(['$J=G21G91X%sY%sF3000' % (num(dx), num(dy))])
            return {'ok': True}
        return {'ok': False, 'error': 'unknown api'}

    def _apply_cols(self):
        cols = self.paper.geo['cols']
        if cols != self.tty.cols:
            self.tty.resize(cols)
            self.pty.resize(cols)
            HUB.send(t='cols', cols=cols)

    def action(self, a):
        g = self.grbl
        if a == 'pause':
            g.realtime(b'!')
            self.paused = True
        elif a == 'resume':
            g.realtime(b'~')
            self.paused = False
        elif a == 'stop':
            dropped = g.stop()
            self.paused = False
            g.command('$X')
            g.command('G90 G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed']))
            ids = [t for t in dropped if isinstance(t, int)]
            with self.lock:
                self.paper.dropped(ids)
                self.paper.newline_if_needed()
                self.tty.mark_printed()        # don't overstrike what was dropped
            log('已停止，丢弃 %d 个未打印字符' % len(ids))
        elif a == 'interrupt':
            self.pty.write('\x03')
        elif a == 'change_paper':
            if not self.paper.need_paper:
                self.paper.need_paper = True
                g.queue(['G90 G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed']),
                         'G0 X0 Y0'])
                HUB.send(t='need_paper', on=True)
        elif a == 'new_sheet':
            with self.lock:
                self.paper.new_sheet()
                self._apply_cols()
                if self.mode == 'term' and not self.paper.chars:
                    self.paper.apply(self.tty.reprint_line())
        elif a == 'set_origin':
            if g.pending():
                return {'ok': False, 'error': '正在打印'}
            g.queue(['G10 L20 P0 X0 Y0 Z0'])
        elif a == 'home':
            g.queue(['G90 G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed']),
                     'G0 X0 Y0'])
        elif a == 'pen_up':
            g.queue(['G90 G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed'])])
        else:
            return {'ok': False, 'error': 'unknown action'}
        return {'ok': True}


def load_pen(path):
    d = {'zOn': 8.0, 'zOff': 0.0, 'zSpeed': 5000}
    try:
        with open(path, encoding='utf-8') as fh:
            d.update(json.load(fh).get('grbl', {}))
    except OSError:
        log('config %s not found, using Z8 down / Z0 up' % path)
    return d


# =========================================================== http
def make_handler(app, key):
    page = open(os.path.join(HERE, 'index.html'), 'rb').read()

    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def _authed(self):
            q = parse_qs(urlparse(self.path).query)
            if q.get('k', [''])[0] == key:
                return True
            return ('tt_key=' + key) in (self.headers.get('Cookie') or '')

        def _send(self, code, body, ctype='application/json', extra=()):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in extra:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._authed():
                return self._send(403, b'forbidden: open the URL with ?k=<key>',
                                  'text/plain')
            path = urlparse(self.path).path
            if path == '/':
                return self._send(200, page, 'text/html; charset=utf-8',
                                  [('Set-Cookie', 'tt_key=%s; Path=/; SameSite=Strict'
                                    % key)])
            if path.startswith('/static/'):
                name = os.path.basename(path)
                fp = os.path.join(HERE, 'static', name)
                if os.path.isfile(fp):
                    ctype = {'.js': 'application/javascript', '.css': 'text/css'}.get(
                        os.path.splitext(name)[1], 'application/octet-stream')
                    with open(fp, 'rb') as fh:
                        return self._send(200, fh.read(), ctype)
            if path == '/api/state':
                return self._send(200, app.state())
            if path == '/events':
                return self._events()
            self._send(404, b'not found', 'text/plain')

        def do_POST(self):
            if not self._authed():
                return self._send(403, {'ok': False, 'error': 'forbidden'})
            n = int(self.headers.get('Content-Length') or 0)
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
                res = app.api(urlparse(self.path).path, body)
            except Exception as e:
                res = {'ok': False, 'error': str(e)}
            self._send(200, res)

        def _events(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            q, ev = HUB.add()
            # snapshot first; events that raced in are idempotent on the client
            q.appendleft(json.dumps(dict(t='hello', **app.state()), ensure_ascii=False))
            ev.set()
            try:
                self.wfile.write(b'retry: 1000\n\n')
                while True:
                    ev.wait(15)
                    ev.clear()
                    if not q:
                        self.wfile.write(b': ping\n\n')
                    chunk = []
                    while q:
                        chunk.append(b'data: ' + q.popleft().encode() + b'\n\n')
                    if chunk:
                        self.wfile.write(b''.join(chunk))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                HUB.remove(q)

    return H


def load_key():
    path = os.path.expanduser('~/.teletype_key')
    try:
        with open(path) as fh:
            k = fh.read().strip()
            if k:
                return k
    except OSError:
        pass
    k = secrets.token_urlsafe(9)
    with open(path, 'w') as fh:
        fh.write(k)
    os.chmod(path, 0o600)
    return k


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.168.0.1', 9))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', default=DEFAULT_PORT, help="serial port or 'fake'")
    ap.add_argument('--config', default=os.path.join(REPO, 'configs', 'grbl-zpen.json'))
    ap.add_argument('--listen', default='0.0.0.0')
    ap.add_argument('--http-port', type=int, default=8765)
    ap.add_argument('--char-h', type=float, default=3.0, help='cap height mm')
    ap.add_argument('--paper', type=float, nargs=2, default=(210, 297), metavar=('W', 'H'))
    ap.add_argument('--margin', type=float, default=8.0)
    ap.add_argument('--feed', type=int, default=4000, help='drawing feed mm/min '
                    '(GRBL caps it at $110/$111)')
    ap.add_argument('--z-down', type=float, default=None)
    ap.add_argument('--z-up', type=float, default=None,
                    help='travel Z between strokes (default: config zOff)')
    ap.add_argument('--max-backlog', type=int, default=1500,
                    help='terminal: skip output on paper while more than this many '
                         'chars are waiting to be drawn')
    ap.add_argument('--no-key', action='store_true', help='no access key (unsafe)')
    args = ap.parse_args()

    app = App(args)
    app.start()
    key = '' if args.no_key else load_key()
    srv = ThreadingHTTPServer((args.listen, args.http_port), make_handler(app, key))
    srv.daemon_threads = True
    host = lan_ip() if args.listen == '0.0.0.0' else args.listen
    log('open  http://%s:%d/%s' % (host, args.http_port, '?k=' + key if key else ''))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
