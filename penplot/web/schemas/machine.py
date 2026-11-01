from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import Field

from .common import Model


class AlarmInfo(Model):
    code: Optional[int] = None
    text: str
    hint: str = ''
    ts: float
    during_job_id: Optional[str] = None


class BufferState(Model):
    planner: Optional[int] = Field(None, description='free planner blocks (Bf)')
    rx: Optional[int] = Field(None, description='free RX bytes (Bf)')


class MachineStatus(Model):
    connected: bool
    connecting: bool = False
    port: Optional[str] = None
    baud: int = 115200
    fake: bool = Field(False, description='FakeGrbl simulator (dev/test)')
    firmware: str = ''
    machine_type: Optional[str] = Field(None, description='Grbl | Marlin | Ebb | K_AT (active profile)')
    profile_id: Optional[str] = None
    profile_name: Optional[str] = Field(None, description='display name of the active machine profile')
    grbl_state: str = Field('', description='raw GRBL state: Idle, Run, Hold:0, Jog, Alarm, Door:0, Sleep, ...')
    state_text: str = Field('', description='zh-CN label')
    wpos: Optional[list[float]] = Field(None, description='[x,y,z] work position (MPos - WCO)')
    mpos: Optional[list[float]] = None
    wco: Optional[list[float]] = None
    feed: Optional[float] = None
    spindle: Optional[float] = None
    buf: BufferState = BufferState()
    ov: Optional[list[int]] = Field(None, description='[feed%, rapid%, spindle%]')
    pins: str = ''
    pen: Literal['up', 'down', 'unknown'] = 'unknown'
    origin_valid: bool = False
    last_alarm: Optional[AlarmInfo] = None
    job_id: Optional[str] = None
    teletype: bool = Field(False, description='a teletype session holds the machine')
    busy: bool = Field(False, description='manual commands rejected now (machine_busy)')
    error: Optional[str] = Field(None, description='last connection error (port_busy, not found, ...)')
    updated_at: float = 0.0


class PortInfo(Model):
    path: str
    by_id: Optional[str] = None
    description: str = ''
    vid: Optional[str] = None
    pid: Optional[str] = None
    busy_pid: Optional[int] = None


class ConnectRequest(Model):
    port: Optional[str] = Field(None, description="default: profile connection.port; 'fake' = simulator (dev)")
    baud: Optional[int] = None
    reset: bool = Field(False, description='send soft-reset (0x18) after opening')


class JogRequest(Model):
    dx: float = Field(0.0, ge=-50, le=50)
    dy: float = Field(0.0, ge=-50, le=50)
    dz: float = Field(0.0, ge=-20, le=20)
    feed: Optional[float] = Field(None, ge=1, le=20000)
    seq: Optional[int] = Field(None, description='client sequence number for dedupe')


class ZeroRequest(Model):
    axes: Literal['xyz', 'xy', 'z'] = 'xy'


class PenRequest(Model):
    state: Literal['up', 'down']


class FrameRequest(Model):
    bbox_mm: list[float] = Field(min_length=4, max_length=4, description='machine coords [minx,miny,maxx,maxy]')
    feed: Optional[float] = None
    z: Literal['up', 'down_light'] = 'up'
    corners_only: bool = False


class CommandRequest(Model):
    line: str = Field(min_length=1, max_length=200)
    timeout_s: float = Field(10.0, gt=0, le=120)


class CommandResult(Model):
    ok: bool
    reply_lines: list[str]


class RealtimeRequest(Model):
    byte: str = Field(description="'?', '!', '~', '0x18', '0x85', '0x90'..'0x9D'")


class GrblSetting(Model):
    n: int
    value: str
    desc: str = ''
    unit: str = ''


GrblSettingsUpdate = dict[str, Union[float, int, str]]
