# -*- coding: utf-8 -*-
"""PNG raster preview via Pillow (optional `image` extra)."""


def png_image(paths, w_mm, h_mm, dpi=150, line_mm=0.3):
    from PIL import Image, ImageDraw
    k = dpi / 25.4
    W, H = max(1, int(round(w_mm * k))), max(1, int(round(h_mm * k)))
    if W * H > 40e6:
        raise ValueError('image too large: %dx%d' % (W, H))
    img = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(img)
    lw = max(1, int(round(line_mm * k)))
    for p in paths:
        c = p.coords
        cur = []
        for i, op in enumerate(p.ops):
            pt = (c[2 * i] * k, c[2 * i + 1] * k)
            if op == 0 and cur:
                if len(cur) > 1:
                    d.line(cur, fill=0, width=lw, joint='curve')
                cur = []
            cur.append(pt)
        if len(cur) > 1:
            d.line(cur, fill=0, width=lw, joint='curve')
    return img


def write_png(path, paths, w_mm, h_mm, dpi=150):
    png_image(paths, w_mm, h_mm, dpi).save(path, 'PNG', optimize=True)
    return path
