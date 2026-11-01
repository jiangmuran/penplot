# -*- coding: utf-8 -*-
"""TEA-based cipher used by the PenPlot software (port of the original cipher module.a.a).

Block cipher: TEA with 16 rounds, delta 0x9E3779B9, words packed big-endian.
Mode: custom CBC with ciphertext- and plaintext feedback:
    header [0x20|pad][pad x random][2 x random], trailer 7 x zero
    C_i = TEA(P_i ^ O_{i-1}) ^ Z_{i-1};  Z_i = P_i ^ O_{i-1}
"""
import random
import struct

DELTA = 0x9E3779B9
MASK = 0xFFFFFFFF


def _u32(x: int) -> int:
    return x & MASK


def _tea_encrypt_block(block: bytes, key: bytes) -> bytes:
    """Inverse of _tea_decrypt_block (verified against real gfont data)."""
    v0, v1 = struct.unpack('>II', block[:8])
    k0, k1, k2, k3 = struct.unpack('>IIII', key[:16])
    for i in range(1, 17):
        s = _u32(i * DELTA)
        a = _u32(_u32(v1 << 4) + k0)
        b = _u32(v1 + s)
        c = _u32(_u32(v1 >> 5) + k1)
        v0 = _u32(v0 + (a ^ b ^ c))
        a = _u32(_u32(v0 << 4) + k2)
        b = _u32(v0 + s)
        c = _u32(_u32(v0 >> 5) + k3)
        v1 = _u32(v1 + (a ^ b ^ c))
    return struct.pack('>II', v0, v1)


def _tea_decrypt_block(block: bytes, key: bytes) -> bytes:
    v0, v1 = struct.unpack('>II', block[:8])
    k0, k1, k2, k3 = struct.unpack('>IIII', key[:16])
    s = _u32(DELTA * 16)
    for _ in range(16):
        a = _u32(_u32(v0 << 4) + k2)
        b = _u32(v0 + s)
        c = _u32(_u32(v0 >> 5) + k3)
        v1 = _u32(v1 - (a ^ b ^ c))
        a = _u32(_u32(v1 << 4) + k0)
        b = _u32(v1 + s)
        c = _u32(_u32(v1 >> 5) + k1)
        v0 = _u32(v0 - (a ^ b ^ c))
        s = _u32(s - DELTA)
    return struct.pack('>II', v0, v1)


_PAD_RANDOMS = 2   # 'b' in the original
_TAIL_ZEROS = 7    # 'c' in the original


def decrypt(data: bytes, key: bytes) -> bytes:
    """Port of a.a.a(int[] data, int[] key) - the 2-arg decrypt."""
    if len(key) < 16:
        key = key + b'\x00' * (16 - len(key))
    n = len(data)
    if n == 0 or n % 8:
        raise ValueError('ciphertext length must be a positive multiple of 8')

    e = bytearray(_tea_decrypt_block(data[0:8], key))
    pad = e[0] & 7
    remaining = n - 1 - pad - _PAD_RANDOMS - _TAIL_ZEROS
    blk = bytearray(8)          # nArray2: previous output cipher block
    cur = bytearray(data[0:8])  # nArray3: current cipher block (for next crossing)
    pos = 8                     # n2: consumed length
    idx = pad + 1               # n6: index inside current plaintext block
    out = bytearray()

    def _skip_loop(count: int) -> None:
        nonlocal idx, pos, cur, blk, e
        c = 1
        while c <= count:
            if idx < 8:
                idx += 1
                c += 1
                continue
            if idx != 8:
                continue
            _crossing()

    def _crossing() -> None:
        nonlocal idx, pos, cur, blk, e
        blk = bytearray(cur)
        cur = bytearray(data[pos:pos + 8])
        for i in range(8):
            e[i] ^= cur[i]
        e = bytearray(_tea_decrypt_block(bytes(e), key))
        pos += 8
        idx = 0

    _skip_loop(_PAD_RANDOMS)
    left = remaining
    while left > 0:
        if idx < 8:
            out.append(e[idx] ^ blk[idx])
            idx += 1
            left -= 1
            continue
        if idx != 8:
            continue
        _crossing()
    _skip_loop(_TAIL_ZEROS)
    return bytes(out)


def encrypt(data: bytes, key: bytes, rng=random) -> bytes:
    """Port of a.a.a(int[] data, int[] key, boolean) - the 3-arg encrypt."""
    if len(key) < 16:
        key = key + b'\x00' * (16 - len(key))
    ln = len(data)
    pad = (ln + 10) % 8
    if pad != 0:
        pad = 8 - pad

    def rnd() -> int:
        return int(50 + rng.random() * 78)

    blk = [0] * 8
    blk[0] = 0x20 | pad
    bi = 1
    p = pad
    while p > 0:
        blk[bi] = rnd()
        bi += 1
        p -= 1
    z = [0] * 8          # previous plaintext block Z_{i-1}
    prev_out = [0] * 8   # previous output block O_{i-1}
    out = bytearray()

    def _process() -> None:
        nonlocal blk, bi, z, prev_out
        for i in range(8):
            blk[i] ^= prev_out[i]
        enc = _tea_encrypt_block(bytes(blk), key)
        chunk = bytearray(enc)
        for i in range(8):
            chunk[i] ^= z[i]
        out.extend(chunk)
        z = blk[:]                     # Z_i = P_i ^ O_{i-1}
        prev_out = list(chunk)         # O_i
        bi = 0

    # 2 random bytes (may spill into the next block)
    c = 1
    while c <= _PAD_RANDOMS:
        if bi < 8:
            blk[bi] = rnd()
            bi += 1
            c += 1
        if bi == 8:
            _process()
    # payload
    di = 0
    left = ln
    while left > 0:
        if bi < 8:
            blk[bi] = data[di]
            bi += 1
            di += 1
            left -= 1
        if bi == 8:
            _process()
    # 7 trailing zeros
    c = 1
    while c <= _TAIL_ZEROS:
        if bi < 8:
            blk[bi] = 0
            bi += 1
            c += 1
        if bi == 8:
            _process()
    return bytes(out)


GFONT_KEY = bytes([1, 9, 8, 9, 0, 8, 2, 6, 1, 9, 9, 2, 0, 8, 2, 8])
