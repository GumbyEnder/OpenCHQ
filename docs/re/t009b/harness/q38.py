import sys,time
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from t009b import H, terr, d2
from t009_probe import TNAMES
h=H(int(sys.argv[1])); secs=float(sys.argv[2])
g=h.g
prev={i:g.u8(0x89e+i) for i in h.live()}
t0=time.time(); rows=[]
while time.time()-t0<secs:
    time.sleep(0.03)
    cur={i:g.u8(0x89e+i) for i in h.live()}
    for i,s in cur.items():
        if i in prev and prev[i]!=s:
            who=[j for j in cur if j!=i and g.u8(0xbde+j)==i]
            x,y=h.r16(0x1b6,i),g.u8(0x286+i)
            site=h.site_at(x,y)
            rows.append((prev[i]-s, i, len(who), terr(h.buf,x,y), site[1] if site else None,
                         g.u8(0xbde+i), g.u8(0x836+i)))
    prev=cur
print(f"{len(rows)} strength changes in {secs}s on the crowded 1942 board")
un=[r for r in rows if r[2]==0]
print(f"unattributed (no piece links to the victim): {len(un)}")
from collections import Counter
print("unattributed delta histogram:", dict(sorted(Counter(r[0] for r in un).items())))
print("unattributed by terrain:", {TNAMES[r[3]]:0 for r in un})
c=Counter((TNAMES[r[3]], (r[4]&0xc0) if r[4] is not None else None, r[0]) for r in un)
for k,v in sorted(c.items(), key=lambda kv:-kv[1]):
    print(f"  terrain={k[0]:9s} siteowner={('0x%02x'%k[1]) if k[1] is not None else 'none':5s} dmg={k[2]:2d}  x{v}")
