"""penplot web workbench backend (FastAPI). Entry: `python -m penplot.web serve`."""


def create_app(*a, **kw):
    from .app import create_app as _c
    return _c(*a, **kw)
