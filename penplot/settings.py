# -*- coding: utf-8 -*-
"""Settings models mirroring the original software (Settings / *Settings / *Data)."""
import json
import os

MM2INCH = 0.03937008
INCH2MM = 25.4


class Settings:
    """the original app.model.Settings (settings.json)."""

    def __init__(self, **kw):
        self.dpi = kw.get('dpi', 96)
        self.useSysDpi = kw.get('useSysDpi', True)
        self.feedRate = kw.get('feedRate', 1500)          # mm/min drawing speed
        self.jogSpeed = kw.get('jogSpeed', 2500)          # mm/min rapid speed
        self.toolOnDelay = kw.get('toolOnDelay', 0.2)     # seconds after pen down
        self.toolOffDelay = kw.get('toolOffDelay', 0.2)   # seconds before pen up
        self.nearDst = kw.get('nearDst', 0.3)             # mm merge threshold
        self.offsetX = kw.get('offsetX', 0.0)
        self.offsetY = kw.get('offsetY', 0.0)
        self.rotate = kw.get('rotate', 0.0)               # deg, export rotation
        self.singleStep = kw.get('singleStep', False)
        self.autoSetZero = kw.get('autoSetZero', True)
        self.autoConnect = kw.get('autoConnect', True)
        self.autoSleep = kw.get('autoSleep', False)
        self.updateStatus = kw.get('updateStatus', False)
        self.maxImageSize = kw.get('maxImageSize', 4000)
        self.sheetAutoAlignScale = kw.get('sheetAutoAlignScale', 60)
        self.alertFileComplete = kw.get('alertFileComplete', True)

    # ---- px/mm ----
    def mm2px(self, mm: float) -> float:
        return mm * MM2INCH * self.dpi

    def px2mm(self, px: float) -> float:
        return px / self.dpi * INCH2MM

    @staticmethod
    def load(path=None) -> 'Settings':
        if path and os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                return Settings(**json.load(f))
        return Settings()

    def save(self, path):
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.__dict__, f, ensure_ascii=False, indent=2)


class GrblSettings:
    def __init__(self, **kw):
        self.type = kw.get('type', 'Servo')          # Servo | Stepper | Laser | Servo_bachin
        self.penUpPos = kw.get('penUpPos', 50)       # $30 spindle max (laser S)
        self.penDownPos = kw.get('penDownPos', 0)    # $31
        self.ecoServo = kw.get('ecoServo', False)    # $6
        self.zOn = kw.get('zOn', 2.0)                # mm pen-down Z (Stepper)
        self.zOff = kw.get('zOff', 0.0)              # mm pen-up Z
        self.zSpeed = kw.get('zSpeed', 3000)
        self.laserS = kw.get('laserS', 1000)         # laser power (laser_power)


class MarlinSettings:
    def __init__(self, **kw):
        self.type = kw.get('type', 'Servo')          # Servo | Stepper | EStepper | Fan
        self.penUpPos = kw.get('penUpPos', 50)       # servo angle up
        self.penDownPos = kw.get('penDownPos', 0)    # servo angle down
        self.penUpMM = kw.get('penUpMM', 0.0)
        self.penDownMM = kw.get('penDownMM', 2.0)
        self.zSpeed = kw.get('zSpeed', 3000)
        self.fanSpeed = kw.get('fanSpeed', 255)


class EbbSettings:
    def __init__(self, **kw):
        self.mmToSteps = kw.get('mmToSteps', 100)
        self.penUpPos = kw.get('penUpPos', 12000)    # SC,4
        self.penDownPos = kw.get('penDownPos', 18000)  # SC,5
        self.penUpSpeed = kw.get('penUpSpeed', 750)  # SC,11
        self.penDownSpeed = kw.get('penDownSpeed', 750)  # SC,12


class KatSettings:
    def __init__(self, **kw):
        self.penUpE = kw.get('penUpE', 0.2)
        self.penDownE = kw.get('penDownE', 6.0)
        self.penSpeed = kw.get('penSpeed', 4000)
        self.feedOutY = kw.get('feedOutY', 420)      # G0 Y420 F8000 paper out
        self.parkX = kw.get('parkX', 290)            # G0 X290 F3000


class AdvancedSettings:
    """AdvancedViewData."""
    def __init__(self, **kw):
        self.startGcode = kw.get('startGcode', '')
        self.endGcode = kw.get('endGcode', '')
        self.macro1 = kw.get('macro1', '')
        self.macro2 = kw.get('macro2', '')
        self.macro3 = kw.get('macro3', '')
        self.zJogStep = kw.get('zJogStep', 1.0)


class AxesSettings:
    """AxesData - machine coordinate mapping."""
    def __init__(self, **kw):
        self.revxy = kw.get('revxy', False)
        self.xAxeRev = kw.get('xAxeRev', False)
        self.yAxeRev = kw.get('yAxeRev', False)
        # 0=LeftUp 1=RightUp 2=LeftDown 3=RightDown
        self.pos = kw.get('pos', 0)


class MachineConfig:
    """Everything needed to generate G-code for one machine."""

    def __init__(self, machine_type='Grbl', settings=None, grbl=None, marlin=None,
                 ebb=None, kat=None, advanced=None, axes=None):
        self.type = machine_type               # Grbl | Marlin | Ebb | K_AT
        self.settings = settings or Settings()
        self.grbl = grbl or GrblSettings()
        self.marlin = marlin or MarlinSettings()
        self.ebb = ebb or EbbSettings()
        self.kat = kat or KatSettings()
        self.advanced = advanced or AdvancedSettings()
        self.axes = axes or AxesSettings()

    @staticmethod
    def load(path) -> 'MachineConfig':
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        return MachineConfig(
            machine_type=d.get('type', 'Grbl'),
            settings=Settings(**d.get('settings', {})),
            grbl=GrblSettings(**d.get('grbl', {})),
            marlin=MarlinSettings(**d.get('marlin', {})),
            ebb=EbbSettings(**d.get('ebb', {})),
            kat=KatSettings(**d.get('kat', {})),
            advanced=AdvancedSettings(**d.get('advanced', {})),
            axes=AxesSettings(**d.get('axes', {})),
        )

    def save(self, path):
        d = {'type': self.type, 'settings': self.settings.__dict__,
             'grbl': self.grbl.__dict__, 'marlin': self.marlin.__dict__,
             'ebb': self.ebb.__dict__, 'kat': self.kat.__dict__,
             'advanced': self.advanced.__dict__, 'axes': self.axes.__dict__}
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)


def machine_config_from_dict(d) -> 'MachineConfig':
    """MachineConfig from a profile doc dict (unknown keys ignored)."""
    d = d or {}

    def sub(cls, key):
        v = d.get(key) or {}
        obj = cls()
        for k, val in v.items():
            if hasattr(obj, k):
                setattr(obj, k, val)
        return obj
    return MachineConfig(
        machine_type=d.get('type', 'Grbl'),
        settings=sub(Settings, 'settings'), grbl=sub(GrblSettings, 'grbl'),
        marlin=sub(MarlinSettings, 'marlin'), ebb=sub(EbbSettings, 'ebb'),
        kat=sub(KatSettings, 'kat'), advanced=sub(AdvancedSettings, 'advanced'),
        axes=sub(AxesSettings, 'axes'))


def machine_config_to_dict(mc) -> dict:
    return {'type': mc.type, 'settings': dict(mc.settings.__dict__),
            'grbl': dict(mc.grbl.__dict__), 'marlin': dict(mc.marlin.__dict__),
            'ebb': dict(mc.ebb.__dict__), 'kat': dict(mc.kat.__dict__),
            'advanced': dict(mc.advanced.__dict__), 'axes': dict(mc.axes.__dict__)}
