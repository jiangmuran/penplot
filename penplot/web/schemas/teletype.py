"""Teletype (paper terminal) API models."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field

from .common import Model
from .projects import PaperRef


class TeletypeSessionCreate(Model):
    char_h: float = Field(3.0, ge=1.0, le=30.0, description='cap height mm (A4 + 3 mm = 80×58 cells)')
    feed: int = Field(4000, ge=100, le=20000, description='writing feed mm/min (GRBL caps at $110/$111)')
    z_up: Optional[float] = Field(None, ge=0, le=20, description='travel Z between strokes (default profile zOff)')
    z_down: Optional[float] = Field(None, ge=0, le=20, description='pen-down Z (default profile zOn)')
    z_speed: Optional[int] = Field(None, ge=100, le=20000)
    paper: Optional[PaperRef] = Field(None, description='paper by id or inline spec (default 210×297)')
    paper_w_mm: Optional[float] = Field(None, gt=10, le=2000)
    paper_h_mm: Optional[float] = Field(None, gt=10, le=2000)
    margin: float = Field(8.0, ge=0, le=100)
    max_backlog: int = Field(1500, ge=50, le=100000, description='terminal: skip output while more chars are waiting')
    mode: Literal['type', 'term'] = 'type'
    font_id: Optional[str] = Field(None, max_length=200, description="stroke font for typing mode: a font library id "
                                   "(.gfont/.psf) or 'mono' (default: built-in monospace ASCII; terminal mode always uses it)")
    letter_spacing: Optional[float] = Field(None, ge=-5, le=20, description='gap per half-width cell, mm (None = auto ≈ 0.13 × char_h)')
    line_spacing: Optional[float] = Field(None, ge=0.8, le=5, description='line pitch as a multiple of char_h (None = font default: mono 1.6, library 1.45)')
    set_zero: Optional[bool] = Field(None, description='current pen position becomes the paper top-left (default true)')


class TeletypeType(Model):
    text: str = Field(max_length=20000, description='typing-mode input: \\n newline, \\b back one cell, \\t tab')


class TeletypeAction(Model):
    action: Literal['pause', 'resume', 'stop', 'change_paper', 'set_origin', 'home', 'pen_up', 'mode',
                    'interrupt', 'settings']
    args: dict[str, Any] = Field({}, description="mode: {mode:'type'|'term'}; settings: {feed,z_up,z_down,max_backlog,char_h,margin,"
                                                 "paper_w,paper_h,font_id,letter_spacing,line_spacing} (size/paper/font: on an empty page or the next sheet)")


class TeletypeTypeResult(Model):
    ok: bool = True
    echo: str = ''


class TeletypeState(Model):
    active: bool
    terminal_enabled: bool = False
    session_id: Optional[str] = None
    mode: Optional[Literal['type', 'term']] = None
    owner: Optional[dict[str, Any]] = None
    started_at: Optional[float] = None
    cfg: Optional[dict[str, Any]] = Field(None, description='char_h, cell_w, line_h, paper_w, paper_h, margin, feed, z_down, z_up, z_speed, max_backlog')
    cols: Optional[int] = None
    rows: Optional[int] = None
    pty_rows: Optional[int] = None
    pending: int = Field(0, description='G-code lines queued or in flight')
    paused: bool = False
    need_paper: bool = False
    origin_ok: bool = True
    pty_running: bool = False
    page: Optional[int] = None
    paper: Optional[dict[str, Any]] = Field(None, description='{page, geo{h,cw,lh,cols,rows,margin,paper_w,paper_h}, row, col, chars:[[id,ch,row,col,"q"|"ok",w,gk]], glyphs{gk:d}, need_paper, overflow, queued, skipped, written, font, missing}')
    typed_log: Optional[str] = None
    queued: int = Field(0, description='chars sent to the controller queue and not yet acknowledged')
    written: int = Field(0, description='chars acknowledged by the controller, whole session')
    row: Optional[int] = None
    col: Optional[int] = None
    font: Optional[dict[str, Any]] = Field(None, description='font of the current page {id, name, cjk}')
    next_font: Optional[dict[str, Any]] = Field(None, description='font chosen for the next page, if it differs')
    missing: list[str] = Field([], description='chars drawn as a box because no font has the glyph')
    pen: Optional[dict[str, Any]] = Field(None, description='{pos:[x,y,z] work mm, pending, queued, state, paused, connected} == WS pen event')


class TeletypePreview(Model):
    text: Optional[str] = Field(None, max_length=400, description='sample text (default: a CJK or Latin pangram)')
    font_id: Optional[str] = Field(None, max_length=200)
    char_h: Optional[float] = Field(None, ge=1.0, le=30.0)
    letter_spacing: Optional[float] = Field(None, ge=-5, le=20)
    line_spacing: Optional[float] = Field(None, ge=0.8, le=5)
    paper_w: Optional[float] = Field(None, gt=10, le=2000)
    paper_h: Optional[float] = Field(None, gt=10, le=2000)
    margin: Optional[float] = Field(None, ge=0, le=100)


class TeletypePreviewResult(Model):
    geo: dict[str, Any] = Field(description='{h,cw,lh,cols,rows,margin,paper_w,paper_h}')
    chars: list[list[Any]] = Field(description='[[id,ch,row,col,"q",w,gk]]')
    glyphs: dict[str, str] = Field(description='gk -> SVG path d, cell-local mm (x right, y down from the row top)')
    missing: list[str] = []
    font: dict[str, Any]
    mono: dict[str, Any] = {}


class TeletypeFont(Model):
    glyphs: dict[str, list[list[list[float]]]]
    fallback: list[list[list[float]]]
