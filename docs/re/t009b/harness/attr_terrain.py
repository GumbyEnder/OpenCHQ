import sys, time
sys.path.insert(0, '/home/gumbyender/agents/game/notes/t009')
from t009b import H, BLUE, pick, terr, row

pid = int(sys.argv[1]); x, y = int(sys.argv[2]), int(sys.argv[3])
tb = int(sys.argv[4]); start = int(sys.argv[5]); secs = float(sys.argv[6])
h = H(pid); P = pick(h, BLUE, 3)
print(f"P={P} at ({x},{y}) map terrain={terr(h.buf,x,y)} forced 0x836={tb} start={start} secs={secs}")
h.place(P, x, y, tb=tb, strength=start, target=0xFF, flags=0x20)

def hold():
    h.hold(P, x, y, target=0xFF, tb=tb)
h.watch([P], secs, hold=hold, tag="  ")
print(row(h.g.piece(P)))
