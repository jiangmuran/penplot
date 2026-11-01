# -*- coding: utf-8 -*-
"""Shared test paths (replaces the hard-coded Windows install paths).

PENPLOT_FONT_DIR  stroke font directory (default: <repo>/fonts)
PENPLOT_TTF_DIR   directory with simsun.ttc / msyh.ttc / arial.ttf for the
                  TTF pipeline tests (default: C:\\Windows\\Fonts or
                  ~/.fonts/windows); tests needing them exit with SKIP_CODE
                  when they are absent.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

FONT_DIR = os.environ.get('PENPLOT_FONT_DIR') or os.path.join(REPO, 'fonts')
SKIP_CODE = 77


def _ttf_dir():
    for d in (os.environ.get('PENPLOT_TTF_DIR'), r'C:\Windows\Fonts',
              os.path.expanduser('~/.fonts/windows')):
        if d and os.path.isdir(d):
            return d
    return None


TTF_DIR = _ttf_dir()


def require(*paths):
    """Exit with SKIP_CODE (pytest wrapper reports a skip) if any path is missing."""
    if TTF_DIR is None:
        print('SKIP: set PENPLOT_TTF_DIR to a folder with simsun.ttc/msyh.ttc/arial.ttf')
        sys.exit(SKIP_CODE)
    missing = [p for p in paths if not p or not os.path.exists(p)]
    if missing:
        print('SKIP: missing %s' % ', '.join(str(m) for m in missing))
        sys.exit(SKIP_CODE)


def require_fonts(*names):
    """Skip (SKIP_CODE) when vendor fonts these legacy checks were written
    against are not installed (open-source checkouts / CI ship only the open
    fonts). Put them into fonts/ or PENPLOT_FONT_DIR to run the checks."""
    missing = [n for n in names if not os.path.exists(os.path.join(FONT_DIR, n))]
    if missing:
        print('SKIP: vendor font(s) not installed: %s' % ', '.join(missing))
        sys.exit(SKIP_CODE)
