#!/usr/bin/env python3
"""Generate the AUTOBOT app icon (1024x1024 RGBA PNG) with pure stdlib (zlib/struct)."""
import zlib, struct, os

SIZE = 1024
R = 180  # corner radius

# lightning bolt polygon (normalized to a 1024 canvas)
BOLT = [
    (562, 118),
    (348, 566),
    (502, 566),
    (462, 906),
    (676, 458),
    (522, 458),
    (562, 118),
]

def in_poly(x, y, poly):
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside

def rounded_rect_alpha(x, y):
    """1.0 inside rounded rect, 0 outside, smooth at corners."""
    # corner circle centers
    corners = [(R, R), (SIZE - R, R), (R, SIZE - R), (SIZE - R, SIZE - R)]
    # quick interior test
    if R <= x <= SIZE - R:
        return 1.0
    if R <= y <= SIZE - R:
        return 1.0
    # corner zones
    cx = R if x < R else SIZE - R
    cy = R if y < R else SIZE - R
    dx = x - cx
    dy = y - cy
    d = (dx * dx + dy * dy) ** 0.5
    if d <= R:
        return 1.0
    # one-pixel AA
    if d <= R + 1.0:
        return max(0.0, 1.0 - (d - R))
    return 0.0

def lerp(a, b, t):
    return a + (b - a) * t

def bolt_color(t):
    """t in [0,1] top->bottom of bolt bbox; amber->orange gradient."""
    return (lerp(255, 255, t), lerp(190, 118, t), lerp(72, 32, t))

rows = []
for y in range(SIZE):
    row = bytearray()
    row.append(0)  # filter type 0 (None)
    for x in range(SIZE):
        a = rounded_rect_alpha(x, y)
        if a <= 0.0:
            row += bytes((0, 0, 0, 0))
            continue
        # background gradient (top #1a2434 -> bottom #0b0f17)
        t = y / SIZE
        br = int(lerp(26, 11, t))
        bg = int(lerp(36, 15, t))
        bb = int(lerp(52, 23, t))
        # radial glow behind bolt (center ~ (562, 512))
        gdx = (x - 562) / SIZE
        gdy = (y - 512) / SIZE
        gd = (gdx * gdx + gdy * gdy) ** 0.5
        glow = max(0.0, 0.55 - gd * 1.4)
        r = br + glow * 40
        g = bg + glow * 30
        b = bb + glow * 60
        # bolt
        if in_poly(x, y, BOLT):
            bt = (y - 118) / (906 - 118)
            cr, cg, cb = bolt_color(max(0.0, min(1.0, bt)))
            # edge glow: blend bolt color over bg
            r, g, b = cr, cg, cb
        r = max(0, min(255, int(r)))
        g = max(0, min(255, int(g)))
        b = max(0, min(255, int(b)))
        row += bytes((r, g, b, int(a * 255)))
    rows.append(bytes(row))

raw = b''.join(rows)

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    c += struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return c

sig = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.png')
with open(out, 'wb') as f:
    f.write(png)
print('wrote', out, len(png), 'bytes')
