# -*- coding: utf-8 -*-
"""Minimal vector PDF writer (no dependencies): one page per drawing,
moveto/lineto streams, mm page size. Paths are page mm, y down."""
import zlib

MM = 72.0 / 25.4


def _stream(paths, h_mm, width_pt=0.5):
    out = ['%.2f w 1 J 1 j 0 G' % width_pt]
    for p in paths:
        c = p.coords
        for i, op in enumerate(p.ops):
            x, y = c[2 * i] * MM, (h_mm - c[2 * i + 1]) * MM
            out.append('%.2f %.2f %s' % (x, y, 'm' if op == 0 else 'l'))
        if p.ops:
            out.append('S')
    return '\n'.join(out).encode('ascii')


def pdf_bytes(pages, title='penplot'):
    """pages: [(paths, w_mm, h_mm)] -> bytes."""
    objs = []

    def add(b):
        objs.append(b)
        return len(objs)
    catalog = add(None)
    pages_id = add(None)
    kids = []
    for paths, w, h in pages:
        data = zlib.compress(_stream(paths, h))
        cid = add(b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(data) + data + b'\nendstream')
        pid = add(('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Contents %d 0 R '
                   '/Resources << >> >>' % (pages_id, w * MM, h * MM, cid)).encode())
        kids.append(pid)
    objs[catalog - 1] = ('<< /Type /Catalog /Pages %d 0 R >>' % pages_id).encode()
    objs[pages_id - 1] = ('<< /Type /Pages /Kids [%s] /Count %d >>' % (
        ' '.join('%d 0 R' % k for k in kids), len(kids))).encode()
    info = add(('<< /Producer (penplot) /Title (%s) >>' % title).encode('latin-1', 'replace'))
    buf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(buf))
        buf += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    xref = len(buf)
    buf += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for o in offs:
        buf += b'%010d 00000 n \n' % o
    buf += (b'trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n'
            % (len(objs) + 1, catalog, info, xref))
    return bytes(buf)


def write_pdf(path, pages, title='penplot'):
    with open(path, 'wb') as f:
        f.write(pdf_bytes(pages, title))
    return path
