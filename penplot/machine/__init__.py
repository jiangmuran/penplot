# -*- coding: utf-8 -*-
"""Serial machine control for Linux (pyserial), port of the machine package."""
from .base import MachineController, Sender            # noqa
from .grbl import GrblController                      # noqa
from .marlin import MarlinController                  # noqa
from .ebb import EbbController                        # noqa
from .kat import KatController, KatBatchQueue         # noqa


def make_controller(machine_config, **kw):
    t = machine_config.type
    cls = {'Grbl': GrblController, 'Marlin': MarlinController,
           'Ebb': EbbController, 'K_AT': KatController}.get(t)
    if cls is None:
        raise ValueError('unknown machine type %r' % t)
    return cls(machine_config, **kw)
