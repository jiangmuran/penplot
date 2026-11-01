# -*- coding: utf-8 -*-
"""DXF -> polylines in mm (y down) via ezdxf (optional dep `vector`)."""
from ..geometry import Path, bbox_of

UNITS_MM = {0: 1.0, 1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 8: 0.0000254, 9: 0.0254, 10: 914.4}
UNIT_NAMES = {'mm': 1.0, 'cm': 10.0, 'm': 1000.0, 'in': 25.4, 'ft': 304.8}


def load_dxf(path, tol_mm=0.1, layers=None, units='auto'):
    """units: 'auto' = header $INSUNITS (0/unitless -> mm); or force mm/cm/m/in/ft."""
    try:
        import ezdxf
        from ezdxf import path as ezpath
    except ImportError:
        raise ImportError('ezdxf not installed')
    doc = ezdxf.readfile(path)
    code = doc.header.get('$INSUNITS', 0)
    k = UNIT_NAMES.get(units) if units in UNIT_NAMES else UNITS_MM.get(code, 1.0)
    msp = doc.modelspace()
    out = []
    names = sorted({e.dxf.layer for e in msp if e.dxf.hasattr('layer')})
    for e in msp:
        if layers and e.dxf.layer not in layers:
            continue
        try:
            p = ezpath.make_path(e)
        except Exception:
            continue
        for sub in p.sub_paths() if hasattr(p, 'sub_paths') else [p]:
            pts = list(sub.flattening(distance=max(0.001, tol_mm / k)))
            if len(pts) < 2:
                continue
            q = Path()
            q.move_to(pts[0].x * k, -pts[0].y * k)
            for v in pts[1:]:
                q.line_to(v.x * k, -v.y * k)
            out.append(q)
    bb = bbox_of(out)
    info = {'bbox_mm': [round(v, 3) for v in bb] if bb else None,
            'width_mm': round(bb[2] - bb[0], 3) if bb else 0.0,
            'height_mm': round(bb[3] - bb[1], 3) if bb else 0.0,
            'paths': len(out), 'layers': names, 'units_mm': k, 'insunits': code}
    return out, info
