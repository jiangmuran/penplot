# -*- coding: utf-8 -*-
"""Run the original standalone check scripts (tests/scripts/*.py).

Each script prints its own PASS/FAIL lines and exits non-zero on failure;
exit code 77 means "required external data missing" and becomes a skip.
Scripts run in a temporary working directory so their output files never
land in the repository.
"""
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPTS = os.path.join(HERE, 'scripts')
SKIP_CODE = 77

NAMES = sorted(f for f in os.listdir(SCRIPTS)
               if f.endswith('.py') and not f.startswith('_'))


@pytest.mark.parametrize('name', NAMES)
def test_script(name, tmp_path):
    env = dict(os.environ, PYTHONPATH=REPO + os.pathsep + SCRIPTS,
               MPLBACKEND='Agg')
    r = subprocess.run([sys.executable, os.path.join(SCRIPTS, name)],
                       cwd=tmp_path, env=env, capture_output=True, text=True,
                       timeout=900)
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == SKIP_CODE:
        pytest.skip(out.strip().splitlines()[-1] if out.strip() else 'skipped')
    assert r.returncode == 0, out[-4000:]
