"""Print settings resolution (03 §3.4):
effective = profile.print_defaults ⊕ profile.settings/grbl ⊕ project.print ⊕ job.overrides."""
import copy

from ..settings import machine_config_from_dict

GCODE_FIELDS = ('feed_rate', 'jog_speed', 'pen_down_z', 'pen_up_z', 'z_speed', 'tool_on_delay',
                'tool_off_delay', 'optimize', 'near_dst', 'simplify', 'copies', 'copy_gap_mm',
                'copy_mode', 'start_gcode', 'end_gcode', 'origin', 'multi_page')


def merge_print(*layers):
    out = {}
    for layer in layers:
        for k, v in (layer or {}).items():
            if v is None:
                continue
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                # field-wise for nested specs (origin, placement): a layer that sets
                # only origin.corner must not wipe the profile's origin.anchor
                merged = dict(out[k])
                merged.update({kk: copy.deepcopy(vv) for kk, vv in v.items() if vv is not None})
                out[k] = merged
            else:
                out[k] = copy.deepcopy(v)
    return out


def effective(profile_doc, project_print=None, overrides=None):
    """-> (MachineConfig, opts dict, origin dict)."""
    doc = profile_doc or {}
    eff = merge_print(doc.get('print_defaults'), project_print, overrides)
    mc = machine_config_from_dict(doc)
    s, g, mk, adv = mc.settings, mc.grbl, mc.marlin, mc.advanced
    if 'feed_rate' in eff:
        s.feedRate = eff['feed_rate']
    if 'jog_speed' in eff:
        s.jogSpeed = eff['jog_speed']
    if 'pen_down_z' in eff:
        g.zOn = eff['pen_down_z']
        mk.penDownMM = eff['pen_down_z']
    if 'pen_up_z' in eff:
        g.zOff = eff['pen_up_z']
        mk.penUpMM = eff['pen_up_z']
    if 'z_speed' in eff:
        g.zSpeed = eff['z_speed']
        mk.zSpeed = eff['z_speed']
    if 'tool_on_delay' in eff:
        s.toolOnDelay = eff['tool_on_delay']
    if 'tool_off_delay' in eff:
        s.toolOffDelay = eff['tool_off_delay']
    if 'near_dst' in eff:
        s.nearDst = eff['near_dst']
    if 'start_gcode' in eff:
        adv.startGcode = eff['start_gcode']
    if 'end_gcode' in eff:
        adv.endGcode = eff['end_gcode']
    s.updateStatus = False
    ax = mc.axes
    origin = {'corner': ax.pos or 0, 'revxy': bool(ax.revxy), 'x_rev': bool(ax.xAxeRev),
              'y_rev': bool(ax.yAxeRev), 'offset_x_mm': 0.0, 'offset_y_mm': 0.0, 'rotation': 0,
              'set_zero_at_start': None, 'anchor': 'paper'}
    for k, v in (eff.get('origin') or {}).items():
        if v is not None:
            origin[k] = v
    opts = {'optimize': eff.get('optimize', True), 'simplify': eff.get('simplify', 0.0),
            'copies': eff.get('copies', 1), 'copy_mode': eff.get('copy_mode', 'repeat_same'),
            'copy_gap_mm': eff.get('copy_gap_mm', 10.0),
            'multi_page': eff.get('multi_page', 'separate_jobs'),
            'stop_on_error': eff.get('stop_on_error', True), 'placement': eff.get('placement')}
    return mc, opts, origin
