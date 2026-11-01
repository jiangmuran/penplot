# -*- coding: utf-8 -*-
"""penplot command line interface.

Commands:
  font list [-d DIR]                       list fonts (.gfont and .psf)
  font convert SRC DST                     gfont <-> psf interchange
  font builtin [OUT.psf]                   export the built-in stroke font
  write "text" [...]                       layout text -> gcode
  img edge IMG [...]                       image -> contour gcode
  img skeleton IMG [...]                   image -> centerline gcode
  img dots IMG [...]                       image -> laser halftone gcode
  gcode2svg IN.gcode OUT.svg               import gcode back to preview
  print FILE -p PORT [...]                 stream gcode to the machine
  tool -p PORT [...]                       interactive machine console
"""
import argparse
import os
import sys

from .settings import MachineConfig, Settings
from .psf import load_font, load_dir, font_index, write_psf, convert_font
from .gfont import GFont
from .builtin_font import load_builtin
from .layout import (PageInfo, TextDocument, FontsSet, LineAlign,
                     page_presets, export_transform)
from .gcode import generate_gcode, laser_dots_gcode, parse_gcode
from .geometry import bbox_of
from . import preview as pv


class _LazyImage:
    """penplot.image needs numpy; import it only for the `img` commands."""

    def __getattr__(self, name):
        from . import image
        return getattr(image, name)


imgmod = _LazyImage()


def _font_dir_default():
    """$PENPLOT_FONT_DIR, ./fonts, <repo>/fonts, ~/.penplot/fonts
    (the legacy name gcodeFonts/ is still accepted in each place)."""
    env = os.environ.get('PENPLOT_FONT_DIR')
    if env:
        return env
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for d in ('fonts', 'gcodeFonts', os.path.join(here, 'fonts'),
              os.path.join(here, 'gcodeFonts'),
              os.path.expanduser('~/.penplot/fonts')):
        if os.path.isdir(d):
            return d
    return 'fonts'


def _warn_bounds(paths, work=None, mc=None):
    """Bounds check on machine-coordinate paths via the core check (B11):
    honours the origin corner and axis mapping of the config."""
    from .layout import OriginSpec, check_bounds
    bb = bbox_of(paths)
    if bb is None:
        return
    print('content bbox mm: x[%.1f..%.1f] y[%.1f..%.1f]' % (bb[0], bb[2], bb[1], bb[3]))
    if work:
        w, h = work
        origin = OriginSpec.from_axes(mc.axes) if mc is not None else None
        bad = check_bounds(bb, w, h, origin)
        if bad:
            print('WARNING: content outside work area (%gx%g mm): %s'
                  % (w, h, ', '.join(bad)))
        else:
            print('bounds OK for %gx%g mm work area' % (w, h))


SERIAL_LOCK = '/run/lock/penplot-serial.lock'


def _serial_lock():
    """Advisory flock shared with the web service; fail fast if held."""
    import fcntl
    path = os.environ.get('PENPLOT_SERIAL_LOCK', SERIAL_LOCK)
    try:
        fh = open(path, 'a+')
    except OSError:
        return None                    # no /run/lock (e.g. macOS): skip
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        raise SystemExit('serial port is in use by another penplot process '
                         '(web service?) - lock %s is held' % path)
    return fh


def _finish_gcode(args, g, mc, ents=None):
    out = args.out or 'out.gcode'
    with open(out, 'w', encoding='utf-8', newline='') as f:
        f.write(g)
    print('gcode written: %s (%d lines, %s)' % (out, g.count('\n'), mc.type))
    if args.svg and ents is not None:
        bb = bbox_of(ents) or (0, 0, 100, 100)
        svg = pv.paths_to_svg(ents, bb[2], bb[3], flip_y=False)
        open(args.svg, 'w', encoding='utf-8').write(svg)
        print('svg preview: %s' % args.svg)
    if args.stats:
        from .gcode import toolpath_stats
        print('stats: %s' % toolpath_stats(g, mc))


# ---------------------------------------------------------------- commands
def cmd_font(args):
    if args.font_cmd == 'list':
        fonts = load_dir(args.fontdir)
        if not fonts:
            print('no fonts in %s' % args.fontdir)
            return 1
        for k, f in sorted(fonts.items()):
            kind = 'psf' if hasattr(f, 'glyphs') else 'gfont'
            print('%-46s %-5s glyphs=%-6d size=%d' % (k, kind, f.glyph_count, f.size))
        return 0
    if args.font_cmd == 'convert':
        print(convert_font(args.src, args.dst))
        return 0
    if args.font_cmd == 'builtin':
        f = load_builtin()
        dst = args.dst or 'penplot-sans.psf'
        write_psf(f, dst)
        print('builtin font: %d glyphs -> %s' % (f.glyph_count, dst))
        return 0
    if args.font_cmd == 'mmah':
        from .mmah import convert_mmah
        f = convert_mmah(args.src, args.dst)
        print('mmah -> %s: %d glyphs (real stroke medians, real pen order)'
              % (args.dst, f.glyph_count))
        return 0
    if args.font_cmd == 'ttf':
        from .ttffont import convert_ttf, default_charset
        chars = None
        if args.chars_file:
            chars = open(args.chars_file, encoding='utf-8-sig').read()
        elif args.chars:
            chars = args.chars
        elif not args.all:
            # quick default: ASCII + first 500 common hanzi
            cs = default_charset(level2=False, latin=True)
            chars = cs[:95] + cs[95:595]
        f = convert_ttf(args.src, args.dst, chars=chars, mode=args.mode,
                        size_px=args.size_px, face_index=args.face,
                        level2=args.all, simplify_tol=args.simplify)
        print('ttf -> %s: %d glyphs (mode=%s) -> %s'
              % (args.mode, f.glyph_count, args.mode, args.dst))
        return 0
    return 1


def _resolve_font(name, fontdir):
    """Resolve a font reference: file path, dir key/prefix, cwd file, builtin."""
    if not name:
        return None
    if os.path.isfile(name):
        return load_font(name)
    # match by file name first: only the chosen font is ever loaded
    index = font_index(fontdir)
    if name in index:
        return load_font(index[name])
    for k, p in index.items():
        if k.startswith(name):
            return load_font(p)
    # fall back to the internal font name (header-only read for .gfont)
    for k, p in index.items():
        try:
            head = GFont().load(p, load_zip=False) if p.lower().endswith('.gfont') \
                else load_font(p)
        except Exception:
            continue
        if head.name == name:
            return load_font(p)
    for ext in ('.psf', '.gfont'):
        if os.path.isfile(name + ext):
            return load_font(name + ext)
    if name in ('penplot-sans', 'builtin', 'built-in'):
        return load_builtin()
    return None


def cmd_write(args):
    font = _resolve_font(args.font, args.fontdir)
    if font is None:
        index = font_index(args.fontdir)
        if args.font:
            print('warning: font %r not found in %s' % (args.font, args.fontdir))
        if 'penplot-sans' in index:
            font = load_font(index['penplot-sans'])
        elif index and not args.font:
            font = load_font(next(iter(index.values())))
        else:
            font = load_builtin()
    print('font: %s (%d glyphs)' % (font.filename, font.glyph_count))

    presets = page_presets()
    if args.page is None:
        page_kw = presets[0]
    elif args.page.isdigit() and int(args.page) < len(presets):
        page_kw = presets[int(args.page)]
    else:
        page_kw = next((p for p in presets if args.page in p['name']), presets[0])
    page = PageInfo(**page_kw)

    if args.config:
        mc = MachineConfig.load(args.config)
    else:
        mc = MachineConfig(machine_type='Grbl', settings=Settings())
    if args.type:
        mc.type = args.type
    s = mc.settings

    import random as _r
    rng = _r.Random(args.seed) if args.seed is not None else _r.Random()

    align = {'L': LineAlign.LEFT, 'C': LineAlign.CENTER,
             'R': LineAlign.RIGHT, 'D': LineAlign.DISPERSE}[args.align]
    fs = FontsSet(simple=args.simple or 0.0)
    font_mix = None
    if args.font_mix:
        # "name1:weight,name2" - weighted random per-char font mixing
        mix = []
        for part in args.font_mix.split(','):
            name, _, w = part.strip().partition(':')
            f = _resolve_font(name, args.fontdir)
            if f is None:
                print('warning: font-mix entry %r not found, ignored' % name)
            if f is not None:
                mix.append((f, float(w) if w else 1.0))
        if mix:
            font_mix = mix
            print('font mix: %s' % ', '.join('%s x%g' % (f.filename, w)
                                             for f, w in mix))
    doc = TextDocument(page, font, fs, settings=s, rng=rng,
                       text_size=args.text_size, char_space=args.char_space,
                       font_mix=font_mix)
    # the writing tab exports unsorted (original k.java: optimize=false);
    # --optimize re-enables the greedy path ordering
    optimize = args.optimize and not args.no_optimize
    pages = doc.layout(args.text)
    n_pages = len(pages)
    if n_pages > 1:
        base_out = args.out or 'out.gcode'
        stem, ext = os.path.splitext(base_out)
        for pi in range(n_pages):
            ents = doc.entities(args.text, align=align, page_index=pi)
            export_transform(ents, page, s, machine_type=mc.type, axes=mc.axes)
            out_i = base_out if pi == 0 else '%s_p%d%s' % (stem, pi + 1, ext)
            g = generate_gcode(ents, mc, optimize=optimize)
            with open(out_i, 'w', encoding='utf-8', newline='') as f:
                f.write(g)
            print('page %d/%d -> %s (%d lines)' % (pi + 1, n_pages, out_i,
                                                   g.count('\n')))
            if args.work:
                _warn_bounds(ents, tuple(args.work), mc)
        if args.svg:
            ents0 = doc.entities(args.text, align=align, page_index=0)
            export_transform(ents0, page, s, machine_type=mc.type, axes=mc.axes)
            bb = bbox_of(ents0) or (0, 0, 100, 100)
            open(args.svg, 'w', encoding='utf-8').write(
                pv.paths_to_svg(ents0, bb[2], bb[3], flip_y=False))
            print('svg preview (page 1): %s' % args.svg)
        print('pages: %d (one file per page, like the original)' % n_pages)
        return 0

    ents = doc.entities(args.text, align=align)
    print('entities: %d' % len(ents))
    export_transform(ents, page, s, machine_type=mc.type, axes=mc.axes)
    _warn_bounds(ents, tuple(args.work) if args.work else None, mc)
    g = generate_gcode(ents, mc, optimize=optimize)
    _finish_gcode(args, g, mc, ents)
    return 0


def _img_common(args):
    ink = imgmod.load_gray(args.img, invert=args.invert, max_px=args.max_px)
    print('image: %dx%d px' % (ink.shape[1], ink.shape[0]))
    if args.config:
        mc = MachineConfig.load(args.config)
    else:
        mc = MachineConfig(machine_type='Grbl', settings=Settings())
    if args.type:
        mc.type = args.type
    return ink, mc


def _img_paths_finish(args, paths, mc, img_w):
    if args.simplify:
        for p in paths:
            p.rdp_simplify(args.simplify)
    imgmod.paths_to_mm(paths, args.width_mm, img_w)
    _warn_bounds(paths, tuple(args.work) if args.work else None, mc)
    g = generate_gcode(paths, mc, optimize=not args.no_optimize)
    _finish_gcode(args, g, mc, paths)


def cmd_img(args):
    ink, mc = _img_common(args)
    img_w = ink.shape[1]
    if args.img_cmd == 'edge':
        edges = imgmod.canny(ink, low=args.th_low, high=args.th_high,
                             sigma=args.blur)
        paths = imgmod.mask_to_paths(edges, min_points=args.min_len)
        print('contours: %d' % len(paths))
        if not paths:
            print('no edges found (try --th-low/--th-high/--invert)')
            return 1
        _img_paths_finish(args, paths, mc, img_w)
        return 0
    if args.img_cmd == 'skeleton':
        skel = imgmod.zhang_suen(ink > (args.binarize or 0.5))
        paths = imgmod.skeleton_to_paths(skel, min_points=args.min_len)
        print('skeleton strokes: %d' % len(paths))
        if not paths:
            print('skeleton empty (try --invert or --binarize)')
            return 1
        _img_paths_finish(args, paths, mc, img_w)
        return 0
    if args.img_cmd == 'dots':
        spacing_px = max(1, int(round(args.spacing_mm / args.width_mm * img_w)))
        xs, ys, vals = imgmod.halftone_dots(ink, spacing_px, gamma=args.gamma)
        print('dots: %d (spacing %d px)' % (len(xs), spacing_px))
        if not xs:
            print('image looks blank (try --invert)')
            return 1
        xs, ys, vals = imgmod.dots_to_mm(xs, ys, vals, args.width_mm, img_w)
        flat = [c for pt in zip(xs, ys) for c in pt]
        dwell = None
        if args.dwell_max and args.dwell_max > 0:
            dwell = [v * args.dwell_max for v in vals]
        powers = vals if args.power_modulate else None
        g = laser_dots_gcode(flat, mc, powers=powers, dwell_s=dwell)
        _finish_gcode(args, g, mc, None)
        if args.svg:
            from .geometry import Path
            dots = []
            r = args.spacing_mm * 0.35
            for x, y, v in zip(xs, ys, vals):
                d = Path()
                d.ellipse(x, y, r * (0.3 + 0.7 * v), r * (0.3 + 0.7 * v), 0.5235987)
                dots.append(d)
            svg = pv.paths_to_svg(dots, max(xs), -min(ys), flip_y=False)
            open(args.svg, 'w', encoding='utf-8').write(svg)
            print('svg preview: %s' % args.svg)
        return 0
    return 1


def cmd_gcode2svg(args):
    text = open(args.file, encoding='utf-8', errors='replace').read()
    paths = parse_gcode(text)
    if not paths:
        print('no drawable moves found')
        return 1
    print('paths: %d' % len(paths))
    svg = pv.paths_to_svg(paths, 100, 100, flip_y=True)
    open(args.out, 'w', encoding='utf-8').write(svg)
    print('svg: %s' % args.out)
    print('stats: %s' % pv.stats(paths))
    return 0


def _machine_config(args):
    if getattr(args, 'config', None):
        mc = MachineConfig.load(args.config)
    else:
        mc = MachineConfig(machine_type='Grbl')
    if args.type:
        mc.type = args.type
    return mc


def _connect(args, mc, verbose=False):
    import time
    from .machine import make_controller
    log = (lambda m: print(m)) if verbose else (lambda m: None)
    c = make_controller(mc, on_log=log)
    print('connecting %s @ %d ...' % (args.port, args.baud))
    c.open(args.port, args.baud)
    # boards with DTR auto-reset need ~2 s for the bootloader + banner
    end = time.time() + 2.5
    while time.time() < end and not c.firmware_version:
        time.sleep(0.05)
    print('firmware: %s' % (c.firmware_version or '(no banner received)'))
    return c


def cmd_print(args):
    import threading
    from .machine import Sender
    mc = _machine_config(args)
    with open(args.file, encoding='utf-8', errors='replace') as fh:
        text = fh.read()
    import signal

    def _term(signum, frame):              # systemctl stop / kill -> same as Ctrl-C
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)

    lock = _serial_lock()  # noqa: F841 (held until exit)
    c = _connect(args, mc, verbose=args.verbose)
    if hasattr(c, 'query_status'):
        st = c.query_status()
        print('machine state: %s  position: %s' % (st, c.position))
        if st and st.startswith('Alarm'):
            print('machine is in ALARM - check it, then unlock ($X) with `penplot tool`')
            c.close()
            return 2
    if mc.settings.autoSetZero and not args.no_zero:
        # original software: the current pen position becomes the origin
        c.set_zero()        # XYZ: at job start the pen rests up (Z0 = up)
        print('origin set at current pen position')
    s = Sender(c, stop_on_error=not args.continue_on_error)
    done = threading.Event()
    s.on_complete = done.set
    last = {'pct': -1}

    def progress(p):
        pct = int(p * 100)
        if pct != last['pct']:
            last['pct'] = pct
            print('\rprogress %3d%%' % pct, end='', flush=True)
    s.on_progress = progress
    s.on_error = lambda cmd, reply: print('\n%s  <- %s' % (reply, cmd or '(alarm)'))
    from .machine.base import UnsafeGcode
    try:
        s.load_gcode_text(text)
    except UnsafeGcode as e:
        print('refusing to stream: %s' % e)
        c.close()
        return 2
    print('start printing %s (%d lines)' % (args.file, len(s.queue)))
    s.start()
    try:
        while not done.wait(0.5):
            pass
        print()
        # the last 'ok' only means "accepted into the planner": wait for the
        # moves to finish before closing the port
        if not s.alarm and not c.wait_idle(timeout=args.idle_timeout):
            print('warning: machine did not report idle')
    except KeyboardInterrupt:
        print('\ninterrupted - lifting pen and returning home')
        done.clear()
        s.stop()
        try:
            done.wait(30)
            c.wait_idle(timeout=60)
        except KeyboardInterrupt:
            pass
    c.close()
    if s.alarm:
        print('ALARM: %s' % s.alarm)
        return 2
    if s.errors:
        print('%d error(s); %s' % (len(s.errors),
              'job stopped at the first one' if not args.continue_on_error else 'continued'))
        return 1
    if s.stopped:
        return 130
    print('done')
    return 0


def cmd_tool(args):
    mc = _machine_config(args)
    lock = _serial_lock()  # noqa: F841
    c = _connect(args, mc, verbose=True)
    print('commands: penup pendown zero home homing unlock sleep '
          'jog DX DY  status  quit  (anything else is sent raw)')
    while True:
        try:
            line = input('pp> ').strip()
        except EOFError:
            break
        if not line:
            continue
        if line in ('quit', 'exit', 'q'):
            break
        try:
            if line == 'penup':
                c.set_pen(True)
            elif line == 'pendown':
                c.set_pen(False)
            elif line == 'zero':
                c.set_zero()
            elif line == 'zeroxy':
                c.set_zero('xy')
            elif line == 'home':
                c.go_home()
            elif line == 'homing':
                c.home_axes()
            elif line == 'unlock':
                c.unlock()
            elif line == 'sleep':
                c.sleep()
            elif line == 'status' and hasattr(c, 'query_status'):
                print(c.query_status(), c.position)
            elif line.startswith('jog '):
                parts = line.split()
                c.jog(float(parts[1]), float(parts[2]))
            else:
                if not c.send(line, True):
                    print('(no ok)')
        except Exception as e:
            print('error: %s' % e)
    c.close()
    return 0


# ---------------------------------------------------------------- parser
def main(argv=None):
    import penplot as _pkg
    ap = argparse.ArgumentParser(prog='penplot',
                                 description='pen plotter / laser engraver toolkit')
    ap.add_argument('--version', action='version', version='penplot ' + _pkg.__version__)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('font')
    fsub = p.add_subparsers(dest='font_cmd', required=True)
    pf = fsub.add_parser('list')
    pf.add_argument('-d', '--fontdir', default=_font_dir_default())
    pf = fsub.add_parser('convert')
    pf.add_argument('src')
    pf.add_argument('dst')
    pf = fsub.add_parser('builtin')
    pf.add_argument('dst', nargs='?')
    pf = fsub.add_parser('mmah', help='Make Me a Hanzi graphics.txt -> psf '
                                      '(real strokes, order and direction)')
    pf.add_argument('src', help='graphics.txt (github.com/skishore/makemeahanzi)')
    pf.add_argument('dst', nargs='?', default='makemeahanzi.psf')
    pf = fsub.add_parser('ttf', help='system font -> psf (handwriting skeleton or outline)')
    pf.add_argument('src', help='font file (.ttf/.ttc/.otf)')
    pf.add_argument('dst', nargs='?', default=None, help='output .psf')
    pf.add_argument('--mode', default='skeleton', choices=['skeleton', 'outline'])
    pf.add_argument('--size-px', type=int, default=160)
    pf.add_argument('--face', type=int, default=0, help='face index for .ttc')
    pf.add_argument('--simplify', type=float, default=1.2, help='RDP tolerance px')
    pf.add_argument('--chars', help='characters to include (string)')
    pf.add_argument('--chars-file', help='file with characters to include')
    pf.add_argument('--all', action='store_true', help='full GB2312 level1+2 set')
    p.set_defaults(fn=cmd_font)

    p = sub.add_parser('write')
    p.add_argument('text')
    p.add_argument('-f', '--font', help='font name or font file (.psf/.gfont)')
    p.add_argument('-d', '--fontdir', default=_font_dir_default())
    p.add_argument('-t', '--type', default=None,
                   choices=['Grbl', 'Marlin', 'Ebb', 'K_AT'])
    p.add_argument('-o', '--out', default='out.gcode')
    p.add_argument('--svg')
    p.add_argument('--page')
    p.add_argument('--text-size', type=float, default=1.0)
    p.add_argument('--char-space', type=float, default=0.0)
    p.add_argument('--simple', type=float, default=0.0,
                   help='RDP simplify tolerance in px (0=off)')
    p.add_argument('--align', default='L', choices=['L', 'C', 'R', 'D'])
    p.add_argument('--seed', type=int)
    p.add_argument('--font-mix', metavar='N1:W1,N2',
                   help='weighted random per-char font mixing')
    p.add_argument('--optimize', action='store_true',
                   help='greedy path ordering (writing tab default: OFF, '
                        'matching the original)')
    p.add_argument('--no-optimize', action='store_true',
                   help='(kept for compatibility; ordering is off by default)')
    p.add_argument('--stats', action='store_true')
    p.add_argument('--config')
    p.add_argument('--work', nargs=2, type=float, metavar=('W', 'H'),
                   help='work area mm for out-of-bounds warning')
    p.set_defaults(fn=cmd_write)

    p = sub.add_parser('img')
    isub = p.add_subparsers(dest='img_cmd', required=True)
    for name, help_ in (('edge', 'contour tracing (Canny)'),
                        ('skeleton', 'centerline (Zhang-Suen)'),
                        ('dots', 'laser halftone with power modulation')):
        pi = isub.add_parser(name, help=help_)
        pi.add_argument('img')
        pi.add_argument('-t', '--type', default=None,
                        choices=['Grbl', 'Marlin', 'Ebb', 'K_AT'])
        pi.add_argument('-o', '--out', default=None)
        pi.add_argument('--svg')
        pi.add_argument('--stats', action='store_true')
        pi.add_argument('--config')
        pi.add_argument('--width-mm', type=float, required=True,
                        help='physical width of the engraved image')
        pi.add_argument('--invert', action='store_true')
        pi.add_argument('--max-px', type=int, default=2000)
        pi.add_argument('--work', nargs=2, type=float, metavar=('W', 'H'))
        pi.add_argument('--no-optimize', action='store_true')
        if name in ('edge', 'skeleton'):
            pi.add_argument('--simplify', type=float, default=0.6,
                            help='RDP tolerance px (0=off)')
            pi.add_argument('--min-len', type=int, default=6)
        if name == 'edge':
            pi.add_argument('--blur', type=float, default=1.4)
            pi.add_argument('--th-low', type=float, default=0.10)
            pi.add_argument('--th-high', type=float, default=0.25)
        if name == 'skeleton':
            pi.add_argument('--binarize', type=float, default=0.5)
        if name == 'dots':
            pi.add_argument('--spacing-mm', type=float, default=1.2)
            pi.add_argument('--gamma', type=float, default=1.0)
            pi.add_argument('--power-modulate', action='store_true',
                            help='per-dot S power from darkness')
            pi.add_argument('--dwell-max', type=float, default=0.0,
                            help='per-dot G4 dwell seconds at full darkness')
        pi.set_defaults(fn=cmd_img)

    p = sub.add_parser('gcode2svg')
    p.add_argument('file')
    p.add_argument('out', nargs='?', default='imported.svg')
    p.set_defaults(fn=cmd_gcode2svg)

    def machine_args(p):
        p.add_argument('-p', '--port', required=True)
        p.add_argument('-b', '--baud', type=int, default=115200)
        p.add_argument('-t', '--type', default=None,
                       choices=['Grbl', 'Marlin', 'Ebb', 'K_AT'],
                       help='overrides the type in --config (default Grbl)')
        p.add_argument('--config', help='machine config json (MachineConfig.save format)')

    p = sub.add_parser('print')
    p.add_argument('file')
    machine_args(p)
    p.add_argument('--continue-on-error', action='store_true',
                   help='keep streaming after a firmware error (default: stop, pen up, home)')
    p.add_argument('--idle-timeout', type=float, default=600.0,
                   help='seconds to wait for the last moves to finish')
    p.add_argument('--no-zero', action='store_true',
                   help='do not make the current pen position the origin before printing')
    p.add_argument('-v', '--verbose', action='store_true', help='log every line sent/received')
    p.set_defaults(fn=cmd_print)

    p = sub.add_parser('tool')
    machine_args(p)
    p.set_defaults(fn=cmd_tool)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except FileNotFoundError as e:
        print('error: %s' % e, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
