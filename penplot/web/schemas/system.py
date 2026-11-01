"""Profiles, app settings, system info."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field

from .common import Model, OpenModel, PrintOverrides


class Connection(Model):
    port: str = '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'
    baud: int = 115200
    auto_connect: bool = True
    reset_on_connect: bool = False


class WorkArea(Model):
    # 0 = not configured: the plotter has no homing and powers on wherever the
    # head is, so absolute travel is unknown; travel checks are skipped.
    w_mm: float = Field(0.0, ge=0)
    h_mm: float = Field(0.0, ge=0)


class ProfileDoc(OpenModel):
    """MachineConfig JSON (configs/grbl-zpen.json) + web fields.
    Sub-objects mirror penplot.settings classes; unknown keys are kept."""
    type: Literal['Grbl', 'Marlin', 'Ebb', 'K_AT'] = 'Grbl'
    settings: dict[str, Any] = {}
    grbl: dict[str, Any] = {}
    marlin: dict[str, Any] = {}
    ebb: dict[str, Any] = {}
    kat: dict[str, Any] = {}
    advanced: dict[str, Any] = {}
    axes: dict[str, Any] = {}
    connection: Connection = Connection()
    work_area: WorkArea = WorkArea()
    print_defaults: PrintOverrides = PrintOverrides()


class Profile(Model):
    id: str
    name: str
    is_active: bool
    doc: ProfileDoc
    updated_at: float


class ProfileCreate(Model):
    name: str = Field(min_length=1, max_length=80)
    doc: Optional[ProfileDoc] = None
    copy_from: Optional[str] = None


class ProfileUpdate(Model):
    name: Optional[str] = None
    doc: ProfileDoc


class ProfilePatch(Model):
    name: Optional[str] = None
    doc: Optional[dict[str, Any]] = Field(None, description='deep-merged into doc')


class AppSettings(OpenModel):
    default_font: Optional[str] = None
    batch_auto_advance: bool = False
    pause_on_client_loss_s: Optional[float] = Field(120.0, description='auto soft-pause a running job when all web clients that watched it are gone this long; null/0 = off')
    poll_hz: float = 4.0
    session_ttl_h: float = 720.0
    eta_factor: float = 1.0
    default_paper: str = 'a4-normal'
    lease_release_s: float = Field(60.0, description='machine control lease auto-release after N s without the holder online')
    teletype: dict[str, Any] = Field({'terminal_enabled': False, 'terminal_user': None, 'terminal_shell': None},
                                     description='terminal_enabled: allow the PTY shell (admin only, audited); terminal_user: run the shell as this user when the service is root')
    ui: dict[str, Any] = {}


class Health(Model):
    status: Literal['ok', 'degraded'] = 'ok'
    version: str
    uptime_s: float
    machine_connected: bool
    job_active: bool
    setup_required: bool = False


class Features(Model):
    image: bool
    vector: bool
    dxf: bool
    office: bool
    ttf: bool
    png: bool
    pdf: bool = Field(False, description='PDF backgrounds (pypdfium2)')


class SystemInfo(Model):
    version: str
    git_sha: Optional[str] = None
    built_at: Optional[str] = None
    python: str
    os: str
    hostname: str
    ips: list[str]
    features: Features
    data_dir: str
    font_dir: str
    dev: bool = False
    static_present: bool = False


class MemInfo(Model):
    total: int
    avail: int
    proc_rss: int


class DiskInfo(Model):
    data_free: int
    total: int


class Metrics(Model):
    cpu_pct: list[float]
    load: list[float]
    temp_c: Optional[float] = None
    mem: MemInfo
    disk: DiskInfo
    sd_writes_mb: Optional[float] = None
    tasks_running: int
    uptime_s: float


class WifiInfo(Model):
    iface: Optional[str] = None
    ssid: Optional[str] = None
    signal_dbm: Optional[float] = None
    quality: Optional[float] = Field(None, description='0..100')
    bitrate: Optional[str] = None
    ip: Optional[str] = None


class LogEntry(Model):
    ts: float
    priority: int
    message: str
    unit: Optional[str] = None


class RestartRequest(Model):
    force: bool = False


class AuditEntry(Model):
    ts: float
    actor: str
    action: str
    detail: Any = None


# ---------------------------------------------------------------- diagnostics / recovery
class DiagnosticsRequest(Model):
    pen_test: bool = Field(False, description='also lower and raise the pen once')
    confirm: bool = Field(False, description='required with pen_test (the pen WILL touch the paper)')


class DiagnosticCheck(Model):
    id: str
    name: str
    status: Literal['ok', 'warn', 'fail', 'skip']
    detail: str = ''
    message: str = Field('', description='same as detail')
    hint: str = Field('', description='what to do (zh-CN)')


class DiagnosticsResult(Model):
    status: Literal['ok', 'warn', 'fail']
    ran_at: float
    elapsed_ms: float
    checks: list[DiagnosticCheck]
    counts: dict[str, int]


class RecoveryAction(Model):
    method: str
    path: str
    body: dict[str, Any] = {}


class RecoveryStep(Model):
    id: str
    title: str
    detail: str = ''
    action: Optional[RecoveryAction] = None
    done: bool = False


class RecoveryInfo(Model):
    ok: bool
    situation: str = Field(description='ok | disconnected | alarm | origin_invalid | job_failed | job_aborted | job_paused')
    reasons: list[str]
    machine: dict[str, Any]
    last_job: Optional[dict[str, Any]] = None
    steps: list[RecoveryStep]


class FakeFault(Model):
    kind: Literal['unplug', 'alarm', 'reset', 'reset_in_motion', 'garbage', 'slow_acks', 'error_every',
                  'error_next', 'clear']
    value: Optional[float] = None
