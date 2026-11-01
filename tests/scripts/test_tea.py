# -*- coding: utf-8 -*-
import sys, os, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FONT_DIR, TTF_DIR, require  # noqa: E402
from penplot import tea

key = tea.GFONT_KEY

# 1. block roundtrip
for i in range(3):
    blk = bytes(random.randrange(256) for _ in range(8))
    e = tea._tea_encrypt_block(blk, key)
    d = tea._tea_decrypt_block(e, key)
    print('block rt', i, blk.hex(), '->', e.hex(), '->', d.hex(), 'OK' if d == blk else 'FAIL')

# 2. mode roundtrip
rng = random.Random(42)
ok = fail = 0
for ln in range(0, 64):
    data = bytes(rng.randrange(256) for _ in range(ln))
    try:
        enc = tea.encrypt(data, key, rng)
        dec = tea.decrypt(enc, key)
        if dec == data:
            ok += 1
        else:
            fail += 1
            print('len %d FAIL: %r -> %r' % (ln, data, dec))
    except Exception as ex:
        fail += 1
        print('len %d EXC %s' % (ln, ex))
print('roundtrip ok=%d fail=%d' % (ok, fail))
