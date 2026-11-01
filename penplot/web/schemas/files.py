from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field

from .common import Model

FileKind = Literal['gcode', 'svg', 'dxf', 'image', 'text', 'table', 'asset', 'export']


class FileInfo(Model):
    id: str
    kind: FileKind
    name: str
    sha256: str
    size: int
    mime: str
    meta: dict[str, Any] = {}
    tags: list[str] = []
    created_at: float


class FilePatch(Model):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    tags: Optional[list[str]] = None


class GcodeAnalysis(Model):
    lines: int
    motion_lines: int
    bbox: Optional[list[float]] = Field(None, description='machine coords of pen-down moves')
    draw_mm: float
    travel_mm: float
    pen_lifts: int
    est_s: float
    warnings: list[str] = []


class GcodeImportResult(Model):
    file: FileInfo
    analysis: GcodeAnalysis


class SheetInfo(Model):
    name: str
    columns: list[str]
    row_count: int
    sample_rows: list[list[Any]]


class TableImportResult(Model):
    file: FileInfo
    sheets: list[SheetInfo]


class TextImportResult(Model):
    text: str
    encoding: str
    chars: int


class SvgTextRun(Model):
    """A run of SVG <text> characters sharing font-family and font-size."""
    text_index: int = Field(description='index of the <text> element (document order)')
    content: str = Field(description='characters after white-space processing (first 200)')
    font_family: str = Field(description='font-family as written in the SVG (may be a list)')
    families: list[str] = Field([], description='font-family split into names (quotes removed)')
    font_size: float = Field(description='font-size in SVG user units (px)')
    size_mm: float = Field(description='em size in mm at native scale (before width_mm scaling)')
    chars: int = Field(description='non-space characters')


class VectorImportResult(Model):
    file: FileInfo
    bbox_mm: Optional[list[float]] = Field(None, description='SVG: includes a font-independent estimate of the text')
    width_mm: float = 0.0
    height_mm: float = 0.0
    paths: int = 0
    layers: list[str] = []
    text_runs: list[SvgTextRun] = Field([], description='SVG <text> runs (also stored in file.meta.text_runs); '
                                                        'empty for DXF')
    text_families: list[str] = Field([], description='distinct font-family values of the SVG text')


class ImageImportResult(Model):
    file: FileInfo
    px_w: int
    px_h: int


class TraceRequest(Model):
    mode: Literal['edge', 'skeleton', 'dots'] = 'edge'
    width_mm: float = 80.0
    invert: bool = False
    th_low: float = 0.10
    th_high: float = 0.25
    blur: float = 1.4
    binarize: float = 0.5
    min_len: int = 6
    simplify: float = 0.6
    spacing_mm: float = 1.2
    gamma: float = 1.0
    max_px: int = 1200


class TraceResult(Model):
    file_id: str
    paths: int
    width_mm: float
    height_mm: float
    draw_mm: float
    svg: str = Field(description='preview SVG (mm viewBox)')


class BackgroundImportResult(Model):
    """POST /import/background: an image (EXIF rotation baked in, downscaled) or one PDF page
    rasterised server-side, ready to use as Page.background (never printed)."""
    file: FileInfo = Field(description='the raster to display (kind image)')
    source: Optional[FileInfo] = Field(None, description='the uploaded PDF (kind asset), for picking other pages')
    page: int = 0
    page_count: int = 1
    px_w: int
    px_h: int
    dpi: Optional[float] = Field(None, description='raster dpi (PDF) / embedded dpi (image), if meaningful')
    natural_mm: Optional[list[float]] = Field(None, description='[w, h] physical size if known')


class BackgroundPageRequest(Model):
    page: int = Field(0, ge=0, le=9999, description='0-based page of the PDF')
    dpi: float = Field(150, ge=50, le=300)
