import sys,time
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from t009b import H, BLUE, RED, pick, terr, d2
h=H(int(sys.argv[1])); ak=int(sys.argv[2]); bk=int(sys.argv[3]); dxs=[int(v) for v in sys.argv[4].split(',')]; secs=float(sys.argv[5])
A=pick(h,BLUE,ak); B=pick(h,RED,bk,exclude=(A,))
pts=[(h.r16(0x1b6,i),h.g.u8(0x286+i)) for i in h.live() if i not in (A,B)]
best=None
for y in range(4,130):
    for x in range(4,310):
        if terr(h.buf,x,y) not in (0,2) or h.site_at(x,y): continue
        if not all(terr(h.buf,x+d,y) in (0,2) and not h.site_at(x+d,y) for d in range(1,7)): continue
        iso=min(min(abs(x-px),320-abs(x-px))+abs(y-py) for px,py in pts)
        if best is None or iso>best[0]: best=(iso,x,y)
iso,x,y=best
print(f"A={A} blue k{ak} B={B} red k{bk} lane ({x},{y}) isolation {iso}")
for dx in dxs:
    h.place(A,x,y,tb=0,strength=100,target=B,flags=0x20)
    h.place(B,x+dx,y,tb=0,strength=100,target=A,flags=0x20)
    t0=time.time(); prev={i:h.S(i) for i in h.live()}
    print(f"-- dx={dx} d2={dx*dx}")
    while time.time()-t0<secs:
        time.sleep(0.03)
        h.hold(A,x,y,target=B,tb=0); h.hold(B,x+dx,y,target=A,tb=0)
        h.w8(0xD16,A,0); h.w8(0xD16,B,0)
        cur={i:h.S(i) for i in h.live()}
        for i,s in cur.items():
            if i in prev and prev[i]!=s:
                who=[j for j in cur if j!=i and h.g.u8(0xbde+j)==i]
                wh=[f"{j}(k{h.g.u8(0x906+j)&0xf},d2={d2(h.r16(0x1b6,j),h.g.u8(0x286+j),h.r16(0x1b6,i),h.g.u8(0x286+i))})" for j in who]
                tag="*" if i in (A,B) else " "
                print(f"  {tag} piece {i} k{h.g.u8(0x906+i)&0xf} {prev[i]}->{s} dmg {prev[i]-s} hit-by {' '.join(wh) or '-'}")
        prev=cur
