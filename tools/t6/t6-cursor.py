#!/usr/bin/env python3
"""Locate the game's selection cursor (black rectangle outline) inside the bottom monitor strip.

The strip is screen y 474..572, x 192..908 (game 320x200 scaled into a 1024x768 Xvfb frame).
Returns the game-x of the cursor centre, so a caller can steer it with the arrow keys.
"""
import sys
from PIL import Image

BAR = (192, 474, 908, 572)

def dark(px, x, y, t=70):
    r, g, b = px[x, y][:3]
    return r < t and g < t and b < t

def find(path):
    im = Image.open(path).convert('RGB')
    px = im.load()
    x0, y0, x1, y1 = BAR
    runs = {}   # (xstart, length) -> list of y
    for y in range(y0 + 6, y1 - 6):
        x = x0 + 6
        while x < x1 - 6:
            if dark(px, x, y):
                s = x
                while x < x1 - 6 and dark(px, x, y):
                    x += 1
                n = x - s
                if 6 <= n <= 60:
                    runs.setdefault((s, n), []).append(y)
            else:
                x += 1
    # a cursor outline has a top run and a bottom run at the same x, ~20px apart
    out = []
    for (s, n), ys in runs.items():
        for ya in ys:
            for yb in ys:
                if 14 <= yb - ya <= 26:
                    out.append((s, n, ya, yb))
                    break
    if not out:
        return None
    # cluster by x, take the densest
    out.sort()
    best = out[0]
    cx = best[0] + best[1] // 2
    gx = int((cx - 192) / 716 * 320)
    gy = int(((best[2] + best[3]) // 2 - 184) / 406 * 200)
    return dict(screen_x=cx, game_x=gx, game_y=gy,
                left=best[0], right=best[0] + best[1], top=best[2], bottom=best[3],
                candidates=len(out))

if __name__ == '__main__':
    for f in sys.argv[1:]:
        print(f, find(f))
