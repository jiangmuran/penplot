from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field

from .common import Model

FontFormat = Literal['gfont', 'psf']
FontSource = Literal['bundled', 'upload', 'ttf', 'builtin']


class FontSummary(Model):
    id: str = Field(description='file name stem; stable reference used by projects')
    display_name: str
    filename: str
    format: FontFormat
    glyph_count: int
    size_bytes: int
    source: FontSource
    hidden: bool = False
    missing: Optional[list[str]] = Field(None, description='only with ?covers=: chars this font lacks')


class CoverageSummary(Model):
    total: int
    cjk: int = Field(description='CJK unified ideographs (U+4E00..9FFF)')
    latin: int = Field(description='printable ASCII + Latin-1')
    symbols: int = Field(description='punctuation, CJK symbols, full-width forms')


class FontHeader(Model):
    version: int = 0
    name: str = ''
    b: str = ''
    a: str = ''
    c: str = ''
    n: str = ''
    o: str = ''
    type_ordinal: int = 0


class FontDetail(FontSummary):
    ref_size: float
    mtime: float
    header: FontHeader
    coverage_summary: CoverageSummary


class FontCoverage(Model):
    missing: Optional[list[str]] = None
    ranges: Optional[list[list[int]]] = Field(None, description='[[lo, hi], ...] inclusive codepoint ranges')


class GlyphInfo(Model):
    cp: int
    char: str
    w: float = Field(description='advance/width in font units')
    path_d: str = Field(description='SVG path data in font units (y down, baseline 0)')


class GlyphPage(Model):
    font_id: str
    ref_size: float
    total: int
    next_from: Optional[int] = None
    glyphs: list[GlyphInfo]


class FontPatch(Model):
    display_name: Optional[str] = Field(None, max_length=120)
    hidden: Optional[bool] = None


class FontConvert(Model):
    to: Literal['psf', 'gfont']
