from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field

from .common import Model, OriginSpec, PrintOverrides

JobStatus = Literal['queued', 'preparing', 'running', 'paused', 'stopping',
                    'done', 'failed', 'aborted']


class JobSource(Model):
    """Exactly one of file_id / project_id / render_id."""
    file_id: Optional[str] = None
    project_id: Optional[str] = None
    rev: Optional[int] = None
    page: Optional[int] = Field(None, description='render page index (default 0)')
    render_id: Optional[str] = None
    variables: Optional[dict[str, str]] = None
    batch_row: Optional[int] = None
    retry_of: Optional[str] = Field(None, description='set on retry jobs: original job id')
    from_line: Optional[int] = Field(None, description='set on retry jobs: first original line')


class JobError(Model):
    line: Optional[int] = None
    cmd: Optional[str] = None
    reply: str
    ts: float


class Job(Model):
    id: str
    name: str
    status: JobStatus
    reason: Optional[str] = Field(None, description='e.g. user_stop, estop, alarm:3, gcode_error, serial_lost, process_crash, shutdown')
    batch_id: Optional[str] = None
    seq: int = 1
    source: JobSource
    profile_id: Optional[str] = None
    overrides: PrintOverrides = PrintOverrides()
    total_lines: int
    acked_line: int = 0
    sent_line: int = 0
    percent: float = 0.0
    est_s: float = 0.0
    elapsed_s: float = 0.0
    eta_s: Optional[float] = None
    errors: list[JobError] = []
    origin: Optional[OriginSpec] = None
    bbox: Optional[list[float]] = Field(None, description='machine bbox of the job G-code')
    out_of_work_area: bool = False
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    pause_mode: Optional[Literal['soft', 'hold']] = None
    can_retry_from: Optional[int] = Field(None, description='suggested from_line for retry (last acked line)')
    issues: list[str] = Field([], description='safety issues (travel outside the work area, Z range, G28/G53); start is refused unless an admin passes allow_out_of_bounds')


class JobCreate(Model):
    source: JobSource
    name: Optional[str] = None
    profile_id: Optional[str] = None
    overrides: Optional[PrintOverrides] = None
    start: bool = False
    allow_out_of_bounds: bool = Field(False, description='admin only, with start=true')


class JobPatch(Model):
    name: Optional[str] = None
    overrides: Optional[PrintOverrides] = None


class JobStart(Model):
    set_zero: Optional[bool] = None
    allow_out_of_bounds: bool = Field(False, description='admin only: start although the bbox exceeds the work area')
    pen_up_confirmed: bool = Field(False, description='the operator confirms the pen is raised (rest position): '
                                   'the start-time zero then includes Z')


class JobPause(Model):
    mode: Literal['soft', 'hold'] = 'soft'


class JobFrame(Model):
    z: Literal['up', 'down_light'] = 'up'
    feed: Optional[float] = None
    corners_only: bool = False


class JobRetry(Model):
    from_line: Optional[int] = Field(None, ge=1)


class LogLine(Model):
    seq: int
    t: float
    dir: Literal['>', '<', '!']
    text: str


class LogSlice(Model):
    lines: list[LogLine]
    next_seq: int


class BatchInfo(Model):
    id: str
    jobs: list[Job]
    next_job_id: Optional[str] = None


Json = dict[str, Any]
