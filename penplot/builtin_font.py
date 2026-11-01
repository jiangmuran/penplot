# -*- coding: utf-8 -*-
"""Built-in single-stroke vector font ("penplot-sans", original work).

Single-stroke LCD-style letterforms for ASCII. Coordinates: y-down,
baseline y=0, cap height 62 units, font reference size 100. Lowercase
letters are mapped to the uppercase shapes (small-caps fallback) so no
glyph is ever missing. Distributed in the .psf plaintext format.
"""
from .psf import StrokeFont, read_psf, write_psf

_PSF = r"""#psf 1
name penplot-sans
family builtin
author penplot
size 100
type 0

glyph 0x0041 A
m 10 0
l 29 -62
l 48 0
m 19 -24
l 39 -24

glyph 0x0042 B
m 12 -62
l 12 0
m 12 -62
l 36 -62
l 43 -55
l 43 -43
l 36 -36
l 12 -36
m 36 -36
l 44 -28
l 44 -8
l 36 0
l 12 0

glyph 0x0043 C
m 44 -53
l 34 -62
l 20 -62
l 10 -52
l 10 -10
l 20 0
l 34 0
l 44 -9

glyph 0x0044 D
m 12 -62
l 12 0
m 12 -62
l 32 -62
l 44 -50
l 44 -12
l 32 0
l 12 0

glyph 0x0045 E
m 44 -62
l 12 -62
l 12 0
l 44 0
m 12 -34
l 36 -34

glyph 0x0046 F
m 44 -62
l 12 -62
l 12 0
m 12 -34
l 36 -34

glyph 0x0047 G
m 44 -53
l 34 -62
l 20 -62
l 10 -52
l 10 -10
l 20 0
l 36 0
l 44 -8
l 44 -24
l 30 -24

glyph 0x0048 H
m 12 -62
l 12 0
m 44 -62
l 44 0
m 12 -32
l 44 -32

glyph 0x0049 I
m 28 -62
l 28 0
m 16 -62
l 40 -62
m 16 0
l 40 0

glyph 0x004A J
m 40 -62
l 40 -12
l 32 0
l 20 0
l 12 -8

glyph 0x004B K
m 12 -62
l 12 0
m 44 -62
l 14 -26
m 26 -38
l 46 0

glyph 0x004C L
m 12 -62
l 12 0
l 44 0

glyph 0x004D M
m 10 0
l 10 -62
l 28 -26
l 46 -62
l 46 0

glyph 0x004E N
m 12 0
l 12 -62
l 44 0
l 44 -62

glyph 0x004F O
m 20 -62
l 10 -52
l 10 -10
l 20 0
l 36 0
l 46 -10
l 46 -52
l 36 -62
l 20 -62

glyph 0x0050 P
m 12 0
l 12 -62
m 12 -62
l 36 -62
l 44 -54
l 44 -44
l 36 -36
l 12 -36

glyph 0x0051 Q
m 20 -62
l 10 -52
l 10 -10
l 20 0
l 36 0
l 46 -10
l 46 -52
l 36 -62
l 20 -62
m 32 -14
l 46 2

glyph 0x0052 R
m 12 0
l 12 -62
m 12 -62
l 36 -62
l 44 -54
l 44 -44
l 36 -36
l 12 -36
m 30 -36
l 46 0

glyph 0x0053 S
m 42 -53
l 32 -62
l 20 -62
l 11 -53
l 11 -45
l 18 -38
l 36 -31
l 43 -24
l 43 -10
l 33 0
l 20 0
l 10 -9

glyph 0x0054 T
m 10 -62
l 46 -62
m 28 -62
l 28 0

glyph 0x0055 U
m 12 -62
l 12 -12
l 20 0
l 36 0
l 44 -12
l 44 -62

glyph 0x0056 V
m 10 -62
l 28 0
l 46 -62

glyph 0x0057 W
m 8 -62
l 16 0
l 28 -40
l 40 0
l 48 -62

glyph 0x0058 X
m 12 -62
l 44 0
m 44 -62
l 12 0

glyph 0x0059 Y
m 10 -62
l 28 -28
l 46 -62
m 28 -28
l 28 0

glyph 0x005A Z
m 12 -62
l 44 -62
l 12 0
l 44 0

glyph 0x0030 0
m 20 -62
l 10 -53
l 10 -9
l 20 0
l 36 0
l 46 -9
l 46 -53
l 36 -62
l 20 -62
m 16 -6
l 40 -62

glyph 0x0031 1
m 16 -52
l 30 -62
l 30 0
m 16 0
l 44 0

glyph 0x0032 2
m 11 -52
l 19 -62
l 35 -62
l 44 -53
l 44 -44
l 12 0
l 45 0

glyph 0x0033 3
m 12 -62
l 42 -62
l 25 -36
l 38 -36
l 45 -28
l 45 -10
l 36 0
l 20 0
l 11 -8

glyph 0x0034 4
m 36 0
l 36 -62
l 10 -24
l 46 -24

glyph 0x0035 5
m 42 -62
l 16 -62
l 14 -38
l 34 -42
l 44 -32
l 42 -12
l 32 0
l 18 0
l 11 -7

glyph 0x0036 6
m 38 -59
l 22 -48
l 12 -28
l 16 -9
l 30 0
l 42 -9
l 43 -24
l 33 -33
l 19 -31
l 13 -24

glyph 0x0037 7
m 11 -62
l 44 -62
l 24 0

glyph 0x0038 8
m 28 -62
l 18 -56
l 18 -45
l 38 -37
l 44 -25
l 44 -10
l 34 0
l 22 0
l 12 -10
l 12 -25
l 18 -37
l 38 -45
l 38 -56
l 28 -62

glyph 0x0039 9
m 22 -62
l 38 -62
l 44 -53
l 43 -37
l 33 -28
l 22 -29
l 14 -38
l 16 -53
l 22 -62
m 32 -28
l 20 0

glyph 0x002E .
m 24 0
l 27 0

glyph 0x002C ,
m 26 0
l 21 10

glyph 0x003A :
m 26 -30
l 29 -30
m 26 0
l 29 0

glyph 0x003B ;
m 28 -30
l 31 -30
m 27 0
l 21 11

glyph 0x0021 !
m 28 -62
l 28 -20
m 28 -4
l 28 0

glyph 0x003F ?
m 14 -52
l 22 -62
l 36 -62
l 42 -52
l 42 -44
l 28 -32
l 28 -20
m 28 -4
l 28 0

glyph 0x0027 '
m 27 -62
l 24 -50

glyph 0x0022 "
m 21 -62
l 18 -50
m 33 -62
l 30 -50

glyph 0x002D -
m 16 -32
l 40 -32

glyph 0x002B +
m 28 -46
l 28 -18
m 14 -32
l 42 -32

glyph 0x002F /
m 44 -62
l 12 2

glyph 0x0028 (
m 34 -62
l 22 -44
l 22 -18
l 34 0

glyph 0x0029 )
m 16 -62
l 28 -44
l 28 -18
l 16 0

glyph 0x003D =
m 14 -38
l 42 -38
m 14 -26
l 42 -26

glyph 0x005F _
m 10 4
l 46 4

glyph 0x0025 %
m 10 -62
l 44 0
m 14 -50
l 20 -50
m 17 -53
l 17 -47
m 34 -12
l 40 -12
m 37 -15
l 37 -9

glyph 0x0026 &
m 44 -26
l 24 -6
l 12 -6
l 8 -16
l 18 -30
l 30 -40
l 24 -58
l 34 -62
l 38 -54
l 24 -44
l 40 -24
l 44 -26

glyph 0x002A *
m 22 -50
l 34 -34
m 34 -50
l 22 -34
m 28 -56
l 28 -28
"""


def load_builtin() -> StrokeFont:
    f = read_psf(_PSF)
    # small-caps fallback: map lowercase to uppercase shapes
    for code in list(f.glyphs.keys()):
        if 0x41 <= code <= 0x5A:
            g = f.glyphs[code]
            lc = g.__class__(code + 0x20, list(g.coords), list(g.ops))
            f.glyphs[lc.char] = lc
    return f


def export_builtin(path):
    f = load_builtin()
    write_psf(f, path)
    return path
