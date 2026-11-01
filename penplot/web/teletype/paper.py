# -*- coding: utf-8 -*-
"""Character-grid paper + per-character G-code (ported from demos/teletype).

Writers send small ops: ('c', col, ch) draw a char on the current row,
('n',) line feed, ('x', col) move the (displayed) cursor. Characters are
queued to a streamer with their id as tag; the streamer acks them.
Events go out through emit(kind, **data).

Cells: a CJK / full-width character takes two grid cells (East-Asian
width, glyphs.char_width). The current row remembers which character
covers each cell, so backspace steps back over a whole wide character and
the next one overstrikes it exactly.

Wire format of a char: [id, ch, row, col, st, w, gk] - st 'q' queued /
'ok' acknowledged by the controller, w cells, gk a glyph key into the
`glyphs` map ({gk: SVG path d in cell-local mm}) sent alongside.
"""
import collections
import threading

from .glyphs import MONO, Glyphs, char_width, path_d


def num(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def geometry(cfg, glyphs):
    """Grid for one page. letter_spacing (mm, None = auto) is the gap per
    half-width cell; line_spacing (× char_h, None = font default)."""
    h = float(cfg['char_h'])
    gap = cfg.get('letter_spacing')
    gap = h * (0.8 - 4.0 / 6.0) if gap is None else float(gap)
    cw = max(0.3, h * glyphs.cell_ratio + gap)
    ls = cfg.get('line_spacing')
    lh = h * float(ls if ls else glyphs.line_default)
    lh = max(lh, h * 0.8)
    cols = int((cfg['paper_w'] - 2 * cfg['margin']) // cw)
    rows = int((cfg['paper_h'] - 2 * cfg['margin'] - h) // lh) + 1
    return dict(h=h, cw=cw, lh=lh, cols=max(cols, 10), rows=max(rows, 1),
                margin=cfg['margin'], paper_w=cfg['paper_w'], paper_h=cfg['paper_h'])


class Paper:
    def __init__(self, cfg, streamer, emit, glyphs=None):
        self.cfg = cfg
        self.g = streamer
        self.emit = emit
        self.lock = threading.RLock()
        self.glyphs = glyphs or Glyphs()
        self.next_glyphs = None               # font change waiting for an empty page
        self.page = 1
        self.next_id = 1
        self.need_paper = False
        self.overflow = collections.deque()   # ops waiting for a new sheet
        self.queued = 0                       # chars sent to the streamer, not acked
        self.skipped = 0                      # chars dropped by the backlog guard
        self.written = 0                      # chars acked, whole session
        self.missing = []                     # chars drawn as a box (no glyph anywhere)
        self.reset_page()

    # -------------------------------------------------------- geometry
    def geometry(self):
        return geometry(self.cfg, self.glyphs)

    def reset_page(self):
        with self.lock:
            if self.next_glyphs is not None:
                self.glyphs, self.next_glyphs = self.next_glyphs, None
            self.geo = self.geometry()
            self.row = self.col = 0
            self.chars = []          # dicts: id,ch,row,col,st,w,gk
            self.by_id = {}
            self.occ = {}            # current row: cell -> (start col, width) of the char on it
            self.gd = {}             # gk -> path d (this page's geometry)

    def font_info(self):
        return self.glyphs.info()

    def snapshot(self):
        with self.lock:
            return dict(page=self.page, geo=self.geo, row=self.row, col=self.col,
                        chars=[self._tuple(c) for c in self.chars],
                        glyphs={c['gk']: self.gd[c['gk']] for c in self.chars},
                        need_paper=self.need_paper, overflow=len(self.overflow),
                        queued=self.queued, skipped=self.skipped, written=self.written,
                        font=self.font_info(), missing=list(self.missing))

    @staticmethod
    def _tuple(c):
        return [c['id'], c['ch'], c['row'], c['col'], c['st'], c['w'], c['gk']]

    # -------------------------------------------------------- writing
    def apply(self, ops):
        """Terminal ops (TtyFilter): built-in font only."""
        new = []
        with self.lock:
            limit = self.cfg['max_backlog']
            if self.skipped and self.queued < limit // 2 and not self.need_paper:
                n, self.skipped = self.skipped, 0
                if self.col:
                    self._newline()
                for i, ch in enumerate('[... %d chars not printed ...]' % n):
                    self._char(i, ch, new, mono=True)
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
                    self._char(op[1], op[2], new, mono=True)
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
            cols = self.geo['cols']
            for ch in text:
                if ch == '\n':
                    self._newline()
                elif ch == '\b':
                    if self.col > 0:
                        cell = self.occ.get(self.col - 1)
                        self.col = cell[0] if cell else self.col - 1
                elif ch == '\t':
                    self.col = min(cols - 1, (self.col // 8 + 1) * 8)
                else:
                    w = self.glyphs.width(ch)
                    if w == 0:
                        continue
                    if self.col + w > cols:
                        self._newline()
                    if self.need_paper:
                        break
                    if ch.isspace():
                        self._occupy(self.col, w)
                        self.col += w
                    else:
                        self._char(self.col, ch, new, w=w)   # advances the carriage
                if self.need_paper:
                    break
        self._publish(new)
        return True

    def newline_if_needed(self):
        with self.lock:
            if self.col and not self.need_paper:
                self._newline()
        self._cursor()

    def _occupy(self, col, w):
        for k in range(col, col + w):
            self.occ[k] = (col, w)

    def _char(self, col, ch, new, w=None, mono=False):
        if w is None:
            w = char_width(ch)
        if col >= self.geo['cols'] or ch == ' ' or w == 0:
            return
        strokes, src = self.glyphs.draw(ch, w, self.geo, mono_only=mono)
        gk = '%s%d:%s' % (src[0], w, ch)
        if gk not in self.gd:
            self.gd[gk] = path_d(strokes)
        if src == 'box' and ch not in self.missing and len(self.missing) < 200:
            self.missing.append(ch)
            self.emit('missing', chars=[ch], font=self.glyphs.font_id)
        c = dict(id=self.next_id, ch=ch, row=self.row, col=col, st='q', w=w, gk=gk)
        self.next_id += 1
        self.chars.append(c)
        self.by_id[c['id']] = c
        new.append(c)
        self.queued += 1
        self.g.queue(self.gcode(c, strokes), tag=c['id'])
        self._occupy(col, w)
        self.col = col + w

    def park_cmds(self):
        return ['G90 G1 Z%s F%d' % (num(self.cfg['z_up']), self.cfg['z_speed']), 'G0 X0 Y0']

    def _newline(self):
        self.col = 0
        self.row += 1
        self.occ = {}
        if self.row >= self.geo['rows']:
            self.need_paper = True
            self.g.queue(self.park_cmds())     # park at origin, pen up
            self.emit('need_paper', on=True, page=self.page,
                      message='第 %d 页写满：换纸后点「已换纸」继续' % self.page)

    def _publish(self, new):
        if new:
            self.emit('chars', list=[self._tuple(c) for c in new],
                      glyphs={c['gk']: self.gd[c['gk']] for c in new})
        self._cursor()

    def _cursor(self):
        self.emit('cursor', row=self.row, col=self.col, queued=self.queued)

    def change_paper(self):
        with self.lock:
            if self.need_paper:
                return
            self.need_paper = True
            self.g.queue(self.park_cmds())
        self.emit('need_paper', on=True, page=self.page, message='请换纸')

    def new_sheet(self):
        """Paper was changed: start a fresh page and flush overflow."""
        with self.lock:
            self.need_paper = False
            self.page += 1
            self.reset_page()
            pending = list(self.overflow)
            self.overflow.clear()
        self.emit('need_paper', on=False, page=self.page, message='')
        self.emit('snapshot', paper=self.snapshot())
        if pending:
            self.apply(pending)

    def ack(self, cid):
        with self.lock:
            c = self.by_id.get(cid)
            self.queued = max(0, self.queued - 1)
            self.written += 1
            if c:
                c['st'] = 'ok'
        self.emit('ack', id=cid)

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
                self.occ = {}
                for c in self.chars:
                    if c['row'] == self.row:
                        self._occupy(c['col'], c['w'])
            if self.need_paper and self.row < self.geo['rows']:
                self.need_paper = False
                self.emit('need_paper', on=False, page=self.page, message='')
        self.emit('dropped', ids=[c['id'] for c in gone])
        self._cursor()

    # -------------------------------------------------------- gcode
    def gcode(self, c, strokes=None):
        geo, cfg = self.geo, self.cfg
        if strokes is None:
            strokes, _ = self.glyphs.draw(c['ch'], c['w'], geo, mono_only=c['gk'][0] == 'm')
        ox = geo['margin'] + c['col'] * geo['cw']
        oy = geo['margin'] + c['row'] * geo['lh']
        down = 'G1 Z%s F%d' % (num(cfg['z_down']), cfg['z_speed'])
        up = 'G1 Z%s F%d' % (num(cfg['z_up']), cfg['z_speed'])
        out = []
        for stroke in strokes:
            pts = [(ox + x, -(oy + y)) for x, y in stroke]
            out.append('G0 X%s Y%s' % (num(pts[0][0]), num(pts[0][1])))
            out.append(down)
            first = True
            for x, y in pts[1:]:
                out.append('G1 X%s Y%s%s' % (num(x), num(y), ' F%d' % cfg['feed'] if first else ''))
                first = False
            out.append(up)
        return out


def layout_preview(text, cfg, glyphs, max_chars=400):
    """Lay out sample text without a streamer (idle preview): the same
    grid, widths and glyphs as a session would use."""
    geo = geometry(cfg, glyphs)
    chars, gd, missing = [], {}, []
    row = col = 0
    for ch in text[:max_chars]:
        if ch == '\n':
            row, col = row + 1, 0
            continue
        ch = glyphs.prepare(ch)
        for c in ch:
            w = glyphs.width(c)
            if w == 0:
                continue
            if col + w > geo['cols']:
                row, col = row + 1, 0
            if row >= geo['rows']:
                break
            if not c.isspace():
                strokes, src = glyphs.draw(c, w, geo)
                gk = '%s%d:%s' % (src[0], w, c)
                gd.setdefault(gk, path_d(strokes))
                if src == 'box' and c not in missing:
                    missing.append(c)
                chars.append([len(chars) + 1, c, row, col, 'q', w, gk])
            col += w
    return {'geo': geo, 'chars': chars, 'glyphs': gd, 'missing': missing, 'font': glyphs.info(),
            'mono': MONO.info()}
