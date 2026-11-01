"""Shared pydantic models: errors, task refs, geometry primitives, print settings."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Model(BaseModel):
    """Base for request/response models (strict about unknown request keys is
    not wanted: the UI may send extra fields, they are ignored)."""
    model_config = ConfigDict(extra='ignore', populate_by_name=True)


class OpenModel(BaseModel):
    """Model that keeps unknown keys (profile docs, settings, element props)."""
    model_config = ConfigDict(extra='allow', populate_by_name=True)


# ---------------------------------------------------------------- errors
class ErrorInfo(Model):
    code: str = Field(description='machine readable code, e.g. machine_busy, rev_conflict')
    message: str = Field(description='human readable message (zh-CN)')
    detail: Any = None


class ErrorBody(Model):
    error: ErrorInfo


class Ok(Model):
    ok: bool = True


# ---------------------------------------------------------------- tasks
TaskState = Literal['queued', 'running', 'done', 'failed', 'cancelled']


class TaskRef(Model):
    """Returned with HTTP 202 when work continues in the background."""
    task_id: str
    kind: str
    state: TaskState = 'queued'


class Task(Model):
    id: str
    kind: str
    state: TaskState
    progress: float = Field(0.0, description='0..1')
    message: str = ''
    result: Optional[dict[str, Any]] = None
    error: Optional[ErrorInfo] = None
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    slot: Optional[str] = None


# ---------------------------------------------------------------- geometry
class Margins(Model):
    l: float = 0.0
    r: float = 0.0
    t: float = 0.0
    b: float = 0.0


class OriginSpec(Model):
    """Where the machine origin (pen position at job start) sits on the page.

    corner: 0 LeftUp, 1 RightUp, 2 LeftDown, 3 RightDown (AxesSettings.pos).
    offset_x_mm / offset_y_mm: distance of the origin from that corner,
    measured inward along the page edges (page mm); with anchor='content'
    the corner is that of the drawing's bounding box instead of the paper.
    revxy / x_rev / y_rev: machine axis mapping (AxesSettings).
    rotation: page rotation onto the machine (0/90/180/270).
    set_zero_at_start: None = profile default (settings.autoSetZero).
    """
    corner: Literal[0, 1, 2, 3] = 0
    revxy: bool = False
    x_rev: bool = False
    y_rev: bool = False
    offset_x_mm: float = 0.0
    offset_y_mm: float = 0.0
    rotation: Literal[0, 90, 180, 270] = 0
    set_zero_at_start: Optional[bool] = None
    # 'paper': origin = the chosen corner of the PAPER (+offset).
    # 'content': origin = the chosen corner of the DRAWING's bounding box (+offset):
    #   the operator parks the pen at the top-left of the area to be written
    #   (paper clips usually make the paper corner unreachable).
    #   None = inherit (profile print_defaults, else 'paper').
    anchor: Optional[Literal['paper', 'content']] = None


CopyMode = Literal['repeat_same', 'tile_x', 'tile_y']
MultiPage = Literal['separate_jobs', 'one_job_pause_between', 'first_only']


class PrintOverrides(Model):
    """Every field optional; resolution order
    profile.print_defaults < profile.settings/grbl < project.print < job.overrides."""
    feed_rate: Optional[float] = Field(None, ge=1, le=100000, description='mm/min (settings.feedRate)')
    jog_speed: Optional[float] = Field(None, ge=1, le=100000, description='mm/min (settings.jogSpeed)')
    pen_down_z: Optional[float] = Field(None, ge=0, le=20, description='mm (grbl.zOn)')
    pen_up_z: Optional[float] = Field(None, ge=0, le=20, description='mm (grbl.zOff)')
    z_speed: Optional[float] = Field(None, ge=1, le=100000, description='mm/min (grbl.zSpeed)')
    tool_on_delay: Optional[float] = Field(None, ge=0, le=10, description='s, G4 after pen down')
    tool_off_delay: Optional[float] = Field(None, ge=0, le=10, description='s, G4 before pen up')
    optimize: Optional[bool] = Field(None, description='greedy path ordering')
    near_dst: Optional[float] = Field(None, ge=0, le=10, description='mm merge distance')
    simplify: Optional[float] = Field(None, ge=0, le=5, description='RDP tolerance mm, 0=off')
    copies: Optional[int] = Field(None, ge=1, le=100)
    copy_gap_mm: Optional[float] = Field(None, ge=0, le=1000)
    copy_mode: Optional[CopyMode] = None
    start_gcode: Optional[str] = None
    end_gcode: Optional[str] = None
    multi_page: Optional[MultiPage] = None
    stop_on_error: Optional[bool] = None
    origin: Optional[OriginSpec] = None
    placement: Optional['Placement'] = Field(None, description='move the drawing on the paper (page mm) without editing the project')
    pause_between_pages_s: Optional[float] = Field(None, ge=0, le=3600)

    @field_validator('start_gcode', 'end_gcode')
    @classmethod
    def _safe_gcode(cls, v):
        if v:
            check_gcode_template(v)
        return v


class Placement(Model):
    dx_mm: float = Field(0.0, ge=-2000, le=2000, description='shift right (page mm)')
    dy_mm: float = Field(0.0, ge=-2000, le=2000, description='shift down (page mm)')


def check_gcode_template(text):
    """start/end G-code and macros: no realtime/non-ASCII bytes, no $ commands (P1/P18).
    {{var}} placeholders must be substituted by values matching [A-Za-z0-9 .-]."""
    from ...machine.base import UnsafeGcode, sanitize_line
    for k, ln in enumerate(text.split('\n'), 1):
        if '{{' in ln:
            ln = ln.replace('{{', '').replace('}}', '')
        try:
            sanitize_line(ln, k, allow_dollar=False)
        except UnsafeGcode as e:
            raise ValueError('第 %s 行：%s' % (e.line_no, e.reason))
    return text


class Size(Model):
    w: float
    h: float


BBox = list[float]   # [minx, miny, maxx, maxy]


PrintOverrides.model_rebuild()
