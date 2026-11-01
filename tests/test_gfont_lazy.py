# -*- coding: utf-8 -*-
"""Lazy ZIP glyph loading must return exactly what eager loading returns."""
import os
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from penplot.gfont import GFont  # noqa: E402

FONT = os.path.join(os.environ.get('PENPLOT_FONT_DIR') or os.path.join(REPO, 'fonts'),
                    'zy01.gfont')


@pytest.mark.skipif(not os.path.exists(FONT), reason='fonts/zy01.gfont not present')
def test_lazy_equals_eager():
    lazy = GFont().load(FONT)
    eager = GFont().load(FONT, lazy=False)
    assert set(lazy._zip_glyphs) == set(eager._zip_glyphs)
    assert len(lazy._zip_glyphs) == len(eager._zip_glyphs) > 2000
    for ch in '中国你好写字机ABC123，。':
        a, b = lazy.glyph(ch), eager.glyph(ch)
        assert (a is None) == (b is None)
        if a is not None:
            assert list(a.coords) == list(b.coords) and list(a.ops) == list(b.ops)
    assert lazy.has_glyph('中') and not lazy.has_glyph('\U0001F600')
    assert lazy.zip_skipped == 0


@pytest.mark.skipif(not os.path.exists(FONT), reason='fonts/zy01.gfont not present')
def test_header_only_load():
    f = GFont().load(FONT, load_zip=False)
    assert f.size > 0 and f.glyph_count > 0 and len(f._zip_glyphs) == 0
