"""FontIndex: font metadata + coverage cached in SQLite keyed by (size, mtime);
header-only indexing of .gfont (gfont.read_header); loaded fonts in a small
LRU (B18: never load all 224 MB of fonts)."""
import collections
import logging
import os
import re
import secrets
import threading
import zlib

from ..gfont import GFont, read_header
from ..psf import load_font, read_psf, write_gfont_bytes, write_psf
from .db import jdump, jload
from .errors import ApiError, not_found

log = logging.getLogger('penplot.web.fonts')
LRU_FONTS = 6


def encode_coverage(codes):
    bmp = bytearray(8192)
    astral = []
    for c in codes:
        if c < 0x10000:
            bmp[c >> 3] |= 1 << (c & 7)
        else:
            astral.append(c)
    return zlib.compress(bytes(bmp) + b''.join(c.to_bytes(4, 'little') for c in sorted(astral)), 6)


class Coverage:
    __slots__ = ('bmp', 'astral', 'count')

    def __init__(self, blob):
        raw = zlib.decompress(blob) if blob else bytes(8192)
        self.bmp = raw[:8192]
        self.astral = {int.from_bytes(raw[i:i + 4], 'little') for i in range(8192, len(raw), 4)}
        self.count = None

    def __contains__(self, c):
        if c < 0x10000:
            return bool(self.bmp[c >> 3] & (1 << (c & 7)))
        return c in self.astral

    def codes(self):
        out = []
        for i, b in enumerate(self.bmp):
            if b:
                for k in range(8):
                    if b & (1 << k):
                        out.append(i * 8 + k)
        return out + sorted(self.astral)


def fix_mojibake(s):
    """GBK names stored as latin-1 by an old unzip (B17)."""
    try:
        if any(0x80 <= ord(ch) <= 0xFF for ch in s) and all(ord(ch) <= 0xFF for ch in s):
            return s.encode('latin-1').decode('gbk')
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return s


def display_name(stem, header_b=''):
    fixed = fix_mojibake(stem)
    m = re.match(r'^(.*?)_(kvenjoy|xiongzai)_(.*)$', fixed)
    base = m.group(1) if m else fixed
    b = (header_b or '').strip()
    if b and len(b) >= 2 and not any(0x80 <= ord(ch) <= 0xFF for ch in b):
        return b[:60]
    return base[:60] or fixed[:60]


def _summary_counts(cov_codes):
    cjk = latin = sym = 0
    for c in cov_codes:
        if 0x4E00 <= c <= 0x9FFF:
            cjk += 1
        elif 0x20 <= c <= 0x7E or 0xA0 <= c <= 0xFF:
            latin += 1
        elif 0x2000 <= c <= 0x2BFF or 0x3000 <= c <= 0x303F or 0xFF00 <= c <= 0xFFEF:
            sym += 1
    return {'total': len(cov_codes), 'cjk': cjk, 'latin': latin, 'symbols': sym}


class FontIndex:
    def __init__(self, db, cfg, tasks=None):
        self.db = db
        self.cfg = cfg
        self.dir = cfg.font_dir
        self.tasks = tasks
        self._rows = {}
        self._cov = {}
        self._lru = collections.OrderedDict()
        self._samples = collections.OrderedDict()   # sample-svg cache (small strings)
        self._load_lock = threading.Lock()            # one font load at a time in the main process
        self._lock = threading.RLock()

    # ------------------------------------------------------------ index
    def scan(self, force=False, progress=None):
        os.makedirs(self.dir, exist_ok=True)
        files = sorted(fn for fn in os.listdir(self.dir) if fn.lower().endswith(('.gfont', '.psf')))
        known = {r['id']: r for r in self.db.all('SELECT * FROM fonts')}
        seen = set()
        n_new = 0
        for i, fn in enumerate(files):
            path = os.path.join(self.dir, fn)
            fid = os.path.splitext(fn)[0]
            seen.add(fid)
            try:
                st = os.stat(path)
            except OSError:
                continue
            r = known.get(fid)
            if r and not force and r['size_bytes'] == st.st_size and abs(r['mtime'] - st.st_mtime) < 1e-3:
                continue
            try:
                row = self._index_file(fid, fn, path, st, r)
            except Exception as e:
                log.warning('font %s: %s', fn, e)
                continue
            n_new += 1
            self.db.execute(
                'INSERT OR REPLACE INTO fonts(id,filename,format,display_name,glyph_count,size_bytes,mtime,'
                'ref_size,coverage,source,hidden,custom_name,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (row['id'], row['filename'], row['format'], row['display_name'], row['glyph_count'],
                 row['size_bytes'], row['mtime'], row['ref_size'], row['coverage'], row['source'],
                 row['hidden'], row['custom_name'], row['meta']))
            if progress:
                progress((i + 1) / max(1, len(files)))
        for fid, r in known.items():
            if fid not in seen and r['source'] != 'builtin':
                self.db.execute('DELETE FROM fonts WHERE id=?', (fid,))
        if 'penplot-sans' not in seen and 'penplot-sans' not in known:
            from ..builtin_font import load_builtin
            f = load_builtin()
            codes = sorted(f.glyphs)
            self.db.execute(
                'INSERT OR REPLACE INTO fonts(id,filename,format,display_name,glyph_count,size_bytes,mtime,'
                'ref_size,coverage,source,hidden,custom_name,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('penplot-sans', '', 'psf', 'penplot Sans（内置）', len(codes), 0, 0.0, float(f.size),
                 encode_coverage(codes), 'builtin', 0, None, '{}'))
        self._load()
        return {'indexed': n_new, 'fonts': len(self._rows)}

    def _index_file(self, fid, fn, path, st, old):
        fmt = 'psf' if fn.lower().endswith('.psf') else 'gfont'
        if fmt == 'gfont':
            h, codes = read_header(path)
            header = {'version': h.version, 'name': h.name, 'b': h.b, 'a': h.a, 'c': h.c[:200],
                      'n': h.n[:200], 'o': h.o[:200], 'type_ordinal': h.type_ordinal}
            ref = float(h.size or 100)
            dn = display_name(fid, h.b)
        else:
            f = read_psf(path)
            codes = sorted(c for c, g in f.glyphs.items() if g.ops or g.advance)
            header = {'version': 1, 'name': f.name, 'b': f.family, 'a': f.author, 'c': '', 'n': '', 'o': '',
                      'type_ordinal': f.type_ordinal}
            ref = float(f.size or 100)
            dn = display_name(fid, f.name if f.name and f.name != fid else '')
        src = old['source'] if old else 'bundled'
        return {'id': fid, 'filename': fn, 'format': fmt, 'display_name': dn, 'glyph_count': len(codes),
                'size_bytes': st.st_size, 'mtime': st.st_mtime, 'ref_size': ref,
                'coverage': encode_coverage(codes), 'source': src,
                'hidden': old['hidden'] if old else 0, 'custom_name': old['custom_name'] if old else None,
                'meta': jdump({'header': header})}

    def _load(self):
        with self._lock:
            rows = self.db.all('SELECT * FROM fonts ORDER BY display_name')
            self._rows = {r['id']: r for r in rows}
            self._cov = {}
            self._lru.clear()

    def reindex(self, progress=None):
        return self.scan(force=True, progress=progress)

    # ------------------------------------------------------------ access
    def _row(self, fid):
        r = self._rows.get(fid)
        if r is None:
            raise not_found('字体', {'font_id': fid})
        return r

    def cov(self, fid):
        c = self._cov.get(fid)
        if c is None:
            c = Coverage(self._row(fid)['coverage'])
            self._cov[fid] = c
        return c

    def path(self, fid):
        r = self._row(fid)
        return os.path.join(self.dir, r['filename']) if r['filename'] else None

    def paths(self):
        return {fid: (os.path.join(self.dir, r['filename']) if r['filename'] else None)
                for fid, r in self._rows.items()}

    def exists(self, fid):
        return fid in self._rows

    def default_font(self, preferred=None):
        for f in (preferred, 'penplot-sans'):
            if f and f in self._rows:
                return f
        return next(iter(self._rows), None)

    def font(self, fid):
        with self._lock:
            f = self._lru.get(fid)
            if f is not None:
                self._lru.move_to_end(fid)
                return f
        p = self.path(fid)
        with self._load_lock:
            with self._lock:
                f = self._lru.get(fid)
            if f is not None:
                return f
            if p is None:
                from ..builtin_font import load_builtin
                f = load_builtin()
            else:
                f = load_font(p)
        with self._lock:
            self._lru[fid] = f
            while len(self._lru) > LRU_FONTS:
                self._lru.popitem(last=False)
        return f

    def summary(self, r, missing=None):
        return {'id': r['id'], 'display_name': r['custom_name'] or r['display_name'], 'filename': r['filename'],
                'format': r['format'], 'glyph_count': r['glyph_count'], 'size_bytes': r['size_bytes'],
                'source': r['source'], 'hidden': bool(r['hidden']), 'missing': missing}

    def list(self, q=None, covers=None, fmt=None, source=None, include_hidden=False):
        out = []
        want = sorted({ord(ch) for ch in (covers or '') if not ch.isspace()})
        for r in self._rows.values():
            if r['hidden'] and not include_hidden:
                continue
            if fmt and r['format'] != fmt:
                continue
            if source and r['source'] != source:
                continue
            if q:
                ql = q.lower()
                if ql not in (r['custom_name'] or r['display_name']).lower() and ql not in r['id'].lower():
                    continue
            missing = None
            if covers is not None:
                c = self.cov(r['id'])
                missing = [chr(cp) for cp in want if cp not in c]
            out.append(self.summary(r, missing))
        if covers:
            out.sort(key=lambda s: (len(s['missing'] or []), -s['glyph_count']))
        return out

    def detail(self, fid):
        r = self._row(fid)
        d = self.summary(r)
        meta = jload(r['meta'], {}) or {}
        codes = self.cov(fid).codes()
        d.update({'ref_size': r['ref_size'], 'mtime': r['mtime'],
                  'header': meta.get('header') or {}, 'coverage_summary': _summary_counts(codes)})
        return d

    def coverage(self, fid, text=None):
        c = self.cov(fid)
        if text is not None:
            seen = []
            for ch in text:
                if ch.isspace() or ch in seen:
                    continue
                if ord(ch) not in c:
                    seen.append(ch)
            return {'missing': seen, 'ranges': None}
        codes = c.codes()
        ranges = []
        for cp in codes:
            if ranges and cp == ranges[-1][1] + 1:
                ranges[-1][1] = cp
            else:
                ranges.append([cp, cp])
        return {'missing': None, 'ranges': ranges}

    # ------------------------------------------------------------ glyphs
    @staticmethod
    def _glyph_d(g):
        d = []
        c = g.coords
        for i, op in enumerate(g.ops):
            d.append('%s%.1f %.1f' % ('M' if op == 0 else 'L', c[2 * i], c[2 * i + 1]))
        return ''.join(d)

    def glyph_svg(self, fid, cp):
        r = self._row(fid)
        f = self.font(fid)
        g = f.glyph(cp)
        if g is None:
            raise not_found('字形', {'codepoint': cp})
        size = float(r['ref_size'] or 100)
        bb = None
        if g.coords:
            xs, ys = g.coords[0::2], g.coords[1::2]
            bb = (min(xs), min(ys), max(xs), max(ys))
        x0 = min(0.0, bb[0]) if bb else 0.0
        x1 = max(size, bb[2]) if bb else size
        y0 = min(-size, bb[1]) if bb else -size
        y1 = max(size * 0.25, bb[3]) if bb else size * 0.25
        pad = size * 0.05
        sw = size / 40.0
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f">'
               '<path d="%s" fill="none" stroke="currentColor" stroke-width="%.2f" stroke-linecap="round" '
               'stroke-linejoin="round"/></svg>' % (x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad,
                                                     self._glyph_d(g), sw))
        etag = '"%s-%d-%x"' % (re.sub(r'[^A-Za-z0-9]', '', fid)[:20] or 'f', int(r['mtime']), cp)
        return svg, etag

    def glyph_page(self, fid, start, count, text=None):
        r = self._row(fid)
        if text:
            codes = []
            for ch in text:
                if ord(ch) not in codes:
                    codes.append(ord(ch))
        else:
            codes = self.cov(fid).codes()
        total = len(codes)
        sel = codes[start:start + count]
        f = self.font(fid)
        out = []
        for cp in sel:
            g = f.glyph(cp)
            if g is None:
                continue
            w = getattr(g, 'advance', None)
            if not w:
                xs = g.coords[0::2]
                w = (max(xs) - min(0.0, min(xs))) if xs else float(r['ref_size']) * 0.3
            out.append({'cp': cp, 'char': chr(cp), 'w': round(float(w), 2), 'path_d': self._glyph_d(g)})
        nxt = start + count if start + count < total else None
        return {'font_id': fid, 'ref_size': r['ref_size'], 'total': total, 'next_from': nxt, 'glyphs': out}

    def sample_job(self, fid, text, size_mm=8.0, width_mm=None):
        """-> (cache_key, cached_svg_or_None, task_args). Rendering runs in a task
        worker; the main process only picks the text and answers from cache."""
        self._row(fid)
        if not text:
            cov = self.cov(fid)
            parts = [t for t in ('永和九年，岁在癸丑', 'Hello 123')
                     if sum(ord(ch) in cov for ch in t if not ch.isspace()) * 2 >= len(t.replace(' ', ''))]
            text = ' '.join(parts) or '永和九年，岁在癸丑 Hello 123'
        path = self.path(fid)
        try:
            st = os.stat(path) if path else None
            ver = (st.st_mtime_ns, st.st_size) if st else None
        except OSError:
            ver = None
        key = (fid, ver, text, round(float(size_mm), 3), None if width_mm is None else round(float(width_mm), 3))
        with self._lock:
            svg = self._samples.get(key)
            if svg is not None:
                self._samples.move_to_end(key)
        args = {'font_id': fid, 'path': path, 'text': text, 'size_mm': float(size_mm),
                'width_mm': None if width_mm is None else float(width_mm)}
        return key, svg, args

    def sample_store(self, key, svg):
        with self._lock:
            self._samples[key] = svg
            while len(self._samples) > 400:
                self._samples.popitem(last=False)

    def sample_svg(self, fid, text, size_mm=8.0, width_mm=None):
        from ..compose import Resolver, preview_svg, text_box_paths
        from ..geometry import bbox_of
        from ..settings import Settings
        self._row(fid)
        if not text:
            # default sample in the scripts the font actually covers (a CJK-only
            # TTF conversion has no Latin, a Latin one no hanzi)
            cov = self.cov(fid)
            parts = [t for t in ('永和九年，岁在癸丑', 'Hello 123')
                     if sum(ord(ch) in cov for ch in t if not ch.isspace()) * 2 >= len(t.replace(' ', ''))]
            text = ' '.join(parts) or '永和九年，岁在癸丑 Hello 123'
        res = Resolver()
        res._cache[fid] = self.font(fid)
        el = {'id': 'sample', 'props': {'text': text, 'font_id': fid, 'size_mm': float(size_mm),
                                       'line_height': 1.3, 'seed': 1, 'missing_glyph': 'skip',
                                       'box': {'w': float(width_mm), 'h': 10000} if width_mm else None}}
        warn = {'missing': set(), 'overflow': False}
        paths = text_box_paths(el, res, {}, Settings(), warn)
        bb = bbox_of(paths) or (0, 0, size_mm, size_mm)
        return preview_svg(paths, max(bb[2], 1.0) + 1, max(bb[3], 1.0) + 1, page_rect=False,
                           stroke=max(0.15, size_mm / 40.0))

    # ------------------------------------------------------------ mutate
    def _safe_name(self, stem, ext):
        stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', stem).strip(' .') or 'font'
        stem = stem[:80]
        name = stem
        k = 2
        while os.path.exists(os.path.join(self.dir, name + ext)) or \
                os.path.exists(os.path.join(self.dir, name + ext + '.part')):
            name = '%s-%d' % (stem, k)
            k += 1
        return name

    def add_upload(self, filename, data, name=None, source='upload'):
        ext = '.psf' if filename.lower().endswith('.psf') else '.gfont'
        try:
            if ext == '.psf':
                f = read_psf(data)
                if not f.glyphs:
                    raise ValueError('no glyphs')
            else:
                g = GFont().load(bytes(data))
                if not g.inline and not len(g._zip_glyphs):
                    raise ValueError('no glyphs')
        except Exception as e:
            raise ApiError(400, 'bad_font', '字体文件无法解析：%s' % e)
        stem = self._safe_name(os.path.splitext(os.path.basename(filename))[0], ext)
        path = os.path.join(self.dir, stem + ext)
        tmp = path + '.part'
        with open(tmp, 'wb') as fh:
            fh.write(data)
        os.replace(tmp, path)
        self.scan()
        self.db.execute('UPDATE fonts SET source=?, custom_name=? WHERE id=?', (source, name, stem))
        self._load()
        return self.summary(self._row(stem))

    def convert_ttf(self, filename, data, opts):
        """Validate (header sniff only - the font is parsed in the task child),
        stage the upload, reserve the destination name and submit ttf_convert.
        Staged/partial files are removed however the task ends."""
        from ..ttffont import MODES, TtfError, charset_chars, sniff_font
        try:
            faces = sniff_font(data)
            mode = opts.get('mode') or 'skeleton'
            if mode not in MODES:
                raise TtfError('bad_input', '转换模式只能是 skeleton（单笔画）或 outline（轮廓）')
            charset_chars(opts.get('charset') or 'gb2312-1', opts.get('chars'))
            fi = int(opts.get('face_index') or 0)
            if not 0 <= fi < faces:
                raise TtfError('bad_input', '字体序号 %d 不存在：这个文件里有 %d 个字体（序号 0–%d）'
                               % (fi, faces, faces - 1), {'faces': faces})
            if not 48 <= int(160 if opts.get('size_px') is None else opts['size_px']) <= 512:
                raise TtfError('bad_input', '栅格尺寸应在 48–512 px 之间')
            if not 0 <= float(opts.get('simplify_tol') if opts.get('simplify_tol') is not None else 1.2) <= 10:
                raise TtfError('bad_input', '简化程度应在 0–10 之间')
        except TtfError as e:
            raise ApiError(400, e.code, e.message, e.detail)
        name = (opts.get('name') or '').strip()[:120] or None
        ext = os.path.splitext(filename)[1].lower()
        os.makedirs(self.cfg.upload_dir, exist_ok=True)
        src = os.path.join(self.cfg.upload_dir, 'ttf-%s%s' % (secrets.token_hex(6), ext))
        with open(src, 'wb') as fh:
            fh.write(data)
        with self._lock:
            stem = self._safe_name(name or os.path.splitext(os.path.basename(filename))[0] + '-' + mode, '.psf')
            dst = os.path.join(self.dir, stem + '.psf')
            part = dst + '.part'          # not *.psf: a scan() meanwhile must not index it
            open(part, 'wb').close()      # reserves the name against concurrent conversions
        args = dict(opts, mode=mode, name=name, face_index=fi, src=src, dst=part)

        def on_done(res):
            os.replace(part, dst)
            self.scan()
            self.db.execute('UPDATE fonts SET source=? WHERE id=?', ('ttf', stem))
            self._load()
            return {'font': self.summary(self._row(stem)), 'glyphs': res.get('glyphs'),
                    'requested': res.get('requested'), 'missing_count': res.get('missing_count', 0),
                    'missing': res.get('missing', '')}
        t = self.tasks.submit('ttf_convert', args, on_done=on_done)

        def cleanup():
            t.done_ev.wait()
            for f in (src, part):
                try:
                    os.unlink(f)
                except OSError:
                    pass
        threading.Thread(target=cleanup, daemon=True, name='ttf-cleanup-' + t.id).start()
        return t

    def convert(self, fid, to):
        p = self.path(fid)
        f = self.font(fid) if p is None else None
        from ..psf import StrokeFont
        if p is not None:
            if p.lower().endswith('.gfont'):
                f = StrokeFont.from_gfont(GFont().load(p))
            else:
                f = read_psf(p)
        elif not isinstance(f, StrokeFont):
            raise ApiError(400, 'bad_font', '无法转换')
        if to == 'gfont':
            return write_gfont_bytes(f), fid + '.gfont'
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.psf', delete=False, dir=self.cfg.cache_dir) as t:
            tp = t.name
        try:
            data = write_psf(f, tp).encode('utf-8')
        finally:
            os.unlink(tp)
        return data, fid + '.psf'

    def patch(self, fid, display_name=None, hidden=None):
        self._row(fid)
        if display_name is not None:
            self.db.execute('UPDATE fonts SET custom_name=? WHERE id=?', (display_name.strip() or None, fid))
        if hidden is not None:
            self.db.execute('UPDATE fonts SET hidden=? WHERE id=?', (1 if hidden else 0, fid))
        self._load()
        return self.summary(self._row(fid))

    def delete(self, fid):
        r = self._row(fid)
        if r['source'] in ('bundled', 'builtin'):
            raise ApiError(409, 'bundled', '自带字体不能删除，可以隐藏', {'font_id': fid})
        p = self.path(fid)
        if p and os.path.exists(p):
            os.unlink(p)
        self.db.execute('DELETE FROM fonts WHERE id=?', (fid,))
        self._load()
