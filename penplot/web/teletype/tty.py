# -*- coding: utf-8 -*-
"""Terminal byte stream -> teletype paper ops (ported from demos/teletype)."""
import unicodedata


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


