# -*- coding: utf-8 -*-
"""penplot - stroke-font writing / engraving toolkit for pen plotters and
laser engravers (GRBL / Marlin / EBB / auto-feed writer boards).

Features: gfont + plaintext .psf stroke fonts (with converters), ruled-page
text layout, G-code generation, image-to-path (edge / skeleton / halftone),
preview, and serial machine control on Linux.
"""

__version__ = '0.3.0'

from .settings import (Settings, GrblSettings, MarlinSettings, EbbSettings,
                       KatSettings, AdvancedSettings, AxesSettings, MachineConfig)
from .gfont import GFont, Glyph
from .psf import (StrokeFont, StrokeGlyph, read_psf, write_psf,
                  write_gfont_bytes, convert_font, load_font, load_dir)
from .builtin_font import load_builtin
from . import geometry, layout, gcode, preview


def __getattr__(name):
    # ttffont needs numpy/pillow/fonttools; import it only when used so that
    # layout + G-code + serial control keep working with the stdlib + pyserial
    if name in ('convert_ttf', 'default_charset'):
        from . import ttffont
        return getattr(ttffont, name)
    if name == 'image':
        import importlib
        return importlib.import_module('.image', __name__)
    raise AttributeError('module %r has no attribute %r' % (__name__, name))



__all__ = ['Settings', 'GrblSettings', 'MarlinSettings', 'EbbSettings',
           'KatSettings', 'AdvancedSettings', 'AxesSettings', 'MachineConfig',
           'GFont', 'Glyph', 'StrokeFont', 'StrokeGlyph', 'read_psf', 'write_psf',
           'write_gfont_bytes', 'convert_font', 'load_font', 'load_dir',
           'load_builtin', 'convert_ttf', 'default_charset',
           'geometry', 'layout', 'gcode', 'preview', 'image']
