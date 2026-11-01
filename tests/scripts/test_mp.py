# -*- coding: utf-8 -*-
import glob
import os
import subprocess
import sys

import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(tempfile.mkdtemp(prefix='penplot-mp-'))
env = dict(os.environ, PYTHONPATH=REPO)
text = '\n'.join('LINE%02d' % i for i in range(25))
r = subprocess.run([sys.executable, '-m', 'penplot.cli', 'write', text,
                    '-f', 'penplot-sans', '-o', 'mp.gcode'],
                   capture_output=True, text=True, env=env)
print(r.stdout.strip())
print(r.stderr.strip()[:300] if r.stderr else '')
files = sorted(glob.glob('mp*.gcode'))
print('files:', files)
for f in files:
    print(' ', f, sum(1 for _ in open(f)), 'lines')
for f in files:
    os.remove(f)
assert len(files) == 2, 'expected 2 page files, got %d' % len(files)
print('MULTIPAGE OK')
