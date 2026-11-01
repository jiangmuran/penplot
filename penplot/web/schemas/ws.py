"""WebSocket message models (/api/v1/ws). Not used for validation of the hot
path; they document the protocol and end up in openapi.json components so
the frontend gets TS types (GET /api/v1/ws/types)."""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import Field

from .common import Model, Task
from .jobs import Job
from .machine import MachineStatus
from .auth import ElementLock, LeaseInfo, PresenceEntry, UserRef

Topic = Literal['status', 'progress', 'job', 'log', 'alarm', 'task', 'system', 'error', 'notice',
                'presence', 'lease', 'project', 'locks', 'teletype', 'attention']


class WsEnvelope(Model):
    seq: int = Field(description='per-connection sequence number')
    ts: float


class Snapshot(Model):
    machine: MachineStatus
    job: Optional[Job] = None
    tasks: list[Task] = []
    batch: Optional[dict[str, Any]] = None
    lease: Optional[LeaseInfo] = None
    presence: list[PresenceEntry] = []
    teletype: Optional[dict[str, Any]] = Field(None, description='TeletypeState when a session is active')


class WsHello(WsEnvelope):
    type: Literal['hello'] = 'hello'
    server_version: str
    conn_id: str
    snapshot: Snapshot


class WsStatus(WsEnvelope):
    type: Literal['status'] = 'status'
    data: MachineStatus


class ProgressData(Model):
    job_id: str
    line_acked: int
    line_sent: int
    total: int
    percent: float
    elapsed_s: float
    eta_s: Optional[float] = None
    wpos: Optional[list[float]] = None
    page: Optional[int] = None
    batch_seq: Optional[int] = None


class WsProgress(WsEnvelope):
    type: Literal['progress'] = 'progress'
    data: ProgressData


class JobEventData(Model):
    job_id: str
    from_: Optional[str] = Field(None, alias='from')
    to: Optional[str] = Field(None, description="new status, or 'deleted'")
    reason: Optional[str] = None
    job: Optional[Job] = None


class WsJob(WsEnvelope):
    type: Literal['job'] = 'job'
    data: JobEventData


class AlarmData(Model):
    code: Optional[int] = None
    text: str
    hint: str = ''
    during_job_id: Optional[str] = None


class WsAlarm(WsEnvelope):
    type: Literal['alarm'] = 'alarm'
    data: AlarmData


class GcodeErrorData(Model):
    job_id: Optional[str] = None
    line: Optional[int] = None
    cmd: Optional[str] = None
    reply: str


class WsError(WsEnvelope):
    type: Literal['error'] = 'error'
    data: GcodeErrorData


class WsLogLine(Model):
    t: float
    dir: Literal['>', '<', '!']
    text: str


class LogData(Model):
    lines: list[WsLogLine]
    dropped: int = 0


class WsLog(WsEnvelope):
    type: Literal['log'] = 'log'
    data: LogData


class TaskData(Model):
    task_id: str
    kind: str
    state: str
    progress: float = 0.0
    message: str = ''
    result: Optional[dict[str, Any]] = None
    error: Optional[dict[str, Any]] = None


class WsTask(WsEnvelope):
    type: Literal['task'] = 'task'
    data: TaskData


class SystemData(Model):
    cpu: float
    temp_c: Optional[float] = None
    mem_avail: int
    mem_total: int
    wifi_dbm: Optional[float] = None


class WsSystem(WsEnvelope):
    type: Literal['system'] = 'system'
    data: SystemData


class NoticeData(Model):
    level: Literal['info', 'warning', 'error'] = 'info'
    code: str = Field(description='shutdown | restart | origin_invalid | port_busy | connected | disconnected | ...')
    message: str


class WsNotice(WsEnvelope):
    type: Literal['notice'] = 'notice'
    data: NoticeData


class WsGap(WsEnvelope):
    type: Literal['gap'] = 'gap'
    dropped: int


class WsAck(WsEnvelope):
    type: Literal['ack'] = 'ack'
    id: str
    ok: bool
    error: Optional[dict[str, Any]] = None
    result: Optional[dict[str, Any]] = None


class WsPong(WsEnvelope):
    type: Literal['pong'] = 'pong'
    t: float


class AttentionData(Model):
    code: str = Field(description='job_done | paper_change | job_failed | estop | alarm | gcode_error | serial_lost | '
                                  'client_loss_pause | lease_taken | lease_released')
    level: Literal['info', 'warning', 'error']
    message: str = Field(description='zh-CN, ready to show')
    sound: Literal['done', 'paper', 'error', 'info']
    job_id: Optional[str] = None
    batch_id: Optional[str] = None
    next_job_id: Optional[str] = None
    session_id: Optional[str] = None
    reason: Optional[str] = None


class WsAttention(WsEnvelope):
    """Needs a human now: play a sound / notify / vibrate / flash the title."""
    type: Literal['attention'] = 'attention'
    data: AttentionData


class PresenceData(Model):
    online: list[PresenceEntry]


class WsPresence(WsEnvelope):
    type: Literal['presence'] = 'presence'
    data: PresenceData


class WsLease(WsEnvelope):
    type: Literal['lease'] = 'lease'
    data: LeaseInfo


class ProjectChange(Model):
    project_id: str
    rev: int
    kind: Literal['doc', 'element'] = Field(description="doc: refetch the project; element: apply patch.element")
    by: Optional[UserRef] = None
    conn_id: Optional[str] = Field(None, description='X-Conn-Id of the writer (ignore your own echo)')
    patch: Optional[dict[str, Any]] = Field(None, description='{page_id, element_id, element}')


class WsProject(WsEnvelope):
    """Only to sockets whose presence.project_id is this project."""
    type: Literal['project'] = 'project'
    data: ProjectChange


class LocksData(Model):
    project_id: str
    locks: list[ElementLock]


class WsLocks(WsEnvelope):
    type: Literal['locks'] = 'locks'
    data: LocksData


class TeletypeEvent(Model):
    kind: str = Field(description='snapshot{state} | snapshot{paper} (new sheet) | chars{list:[[id,ch,row,col,"q",w,gk]], glyphs{gk:d}} | '
                                  'ack{ids,id,queued} (batched ~50 ms) | dropped{ids} | cursor{row,col,queued} | '
                                  'need_paper{on,page,message} | typed{data} | mode{mode} | missing{chars,font} | '
                                  'pen{pos,pending,queued,state,paused,connected} | state{state} | cols{cols} | error{cmd,reply} | '
                                  'halted{reason,origin_ok} | closed{reason?}')
    session_id: Optional[str] = None

    model_config = {'extra': 'allow'}


class WsTeletype(WsEnvelope):
    type: Literal['teletype'] = 'teletype'
    data: TeletypeEvent


WsServerMessage = Union[WsHello, WsStatus, WsProgress, WsJob, WsAlarm, WsError,
                        WsLog, WsTask, WsSystem, WsNotice, WsGap, WsAck, WsPong, WsAttention,
                        WsPresence, WsLease, WsProject, WsLocks, WsTeletype]


# ---------------------------------------------------------------- client
class WsSubscribe(Model):
    type: Literal['subscribe'] = 'subscribe'
    topics: list[Topic]


class WsCmd(Model):
    type: Literal['cmd'] = 'cmd'
    id: str
    op: Literal['estop', 'pause', 'resume', 'stop', 'jog', 'jog_cancel', 'pen', 'realtime']
    args: dict[str, Any] = {}


class WsPing(Model):
    type: Literal['ping'] = 'ping'
    t: float


class WsPresenceUpdate(Model):
    """Which page/project/element this tab shows (coalesced to 1/s)."""
    type: Literal['presence'] = 'presence'
    page: Optional[str] = None
    project_id: Optional[str] = None
    element_id: Optional[str] = None
    client: Optional[str] = None


class WsLockMsg(Model):
    """Soft element lock (expires after 120 s; refresh by sending again; released on disconnect)."""
    type: Literal['lock', 'unlock']
    id: Optional[str] = Field(None, description='ack id')
    project_id: str
    element_id: str


class WsTtKeys(Model):
    """Teletype keystrokes (control scope + lease; terminal mode: admin + terminal_enabled)."""
    type: Literal['tt_keys'] = 'tt_keys'
    id: Optional[str] = None
    data: str


WsClientMessage = Union[WsSubscribe, WsCmd, WsPing, WsPresenceUpdate, WsLockMsg, WsTtKeys]


class WsTypes(Model):
    """Dummy container so all WS models appear in openapi components."""
    server: WsServerMessage
    client: WsClientMessage
