import sys, time
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from t009b import H, BLUE, pick, terr, row

pid = int(sys.argv[1]); x, y = int(sys.argv[2]), int(sys.argv[3])
start = int(sys.argv[4]); secs = float(sys.argv[5])
pts = int(sys.argv[6]) if len(sys.argv) > 6 else 0
h = H(pid); P = pick(h, BLUE, 3)
h.place(P, x, y, tb=terr(h.buf, x, y), strength=start, target=0xFF, flags=0x20)
print(f"P={P} at ({x},{y}) tmap={terr(h.buf,x,y)} start={start} pts={pts} secs={secs}")

def hold():
    h.hold(P, x, y, target=0xFF, tb=terr(h.buf, x, y), zero_pts=False)
    if pts:
        h.w32(0x6FE, P, pts)
h.watch([P], secs, hold=hold, tag="  ")
print(row(h.g.piece(P)))
