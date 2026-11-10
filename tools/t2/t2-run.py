#!/usr/bin/env python3
"""T-002 Phase A: capture one era/side's opening from the running original.

Usage: sudo -n python3 t2-run.py <era 1..5> <side 1=BLUE 2=RED> <opp 1..6> <tag>

era 1..5 = 1918, 1942, 1986, 2023, ????; opp 2 = SGT. STAN STIL.
Writes PNGs to docs/captures/era-<tag>-*.png, the site table to
docs/re/era-captures/era-<tag>.sites.json, and prints a summary.

Method notes (learned the hard way):
- The Mode Bar only opens when DS:0xda2a == 0 and DS:0xdafc < 6 (FUN_2bad_034e).
  0xda2a is the zone id from FUN_2ffd_0ea8: 1 = the map body. So the *cursor*
  must leave the map, i.e. row < 6.
- The cursor (Controller) follows relative mouse motion only, and only after a
  click inside the DOSBox window locks the pointer. 5 screen px = 1 game cell.
"""
import importlib.util
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/mnt/nas/projects/OpenCHQ")
CAP = ROOT / "docs/captures"
REC = ROOT / "docs/re/era-captures"
DISPLAY = ":99"
CONF = "/mnt/nas/projects/Command HQ/dosbox_rea_linux.conf"
SITES_JSON = "/mnt/nas/projects/Command HQ/modern/extracted/data/sites.json"

for mod_name, path in (("ro", "tools/t2/read-off.py"),
                       ("nudge", "tools/t2/t2-nudge.py")):
    spec = importlib.util.spec_from_file_location(mod_name, str(ROOT / path))
    mod = importlib.util.module_from_spec(spec)          # type: ignore[arg-type]
    spec.loader.exec_module(mod)                          # type: ignore[union-attr]
    globals()[mod_name] = mod

ENV = {"DISPLAY": DISPLAY, "PATH": "/usr/bin:/bin"}


def sh(*args):
    subprocess.run(list(args), env=ENV, check=False)


def xdo(*args):
    sh("xdotool", *args)


def key(name, wait=1.0):
    xdo("key", "--clearmodifiers", name)
    time.sleep(wait)


def dosbox_pid():
    out = subprocess.run(["pgrep", "-x", "dosbox"], capture_output=True, text=True)
    pids = [int(p) for p in out.stdout.split()]
    return pids[0] if pids else None


def start_game():
    sh("pkill", "-x", "dosbox-bin")
    sh("pkill", "-x", "dosbox")
    time.sleep(1)
    if subprocess.run(["xdotool", "getdisplaygeometry"], env=ENV,
                      capture_output=True).returncode != 0:
        subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1024x768x24"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
    env = dict(os.environ, **ENV)
    subprocess.Popen(["/usr/bin/dosbox", "-conf", CONF],
                     stdout=open("/tmp/t6/dosbox-t2.log", "w"),
                     stderr=subprocess.STDOUT, env=env)
    time.sleep(16)


def win_id():
    out = subprocess.run(["xdotool", "search", "--class", "dosbox"],
                         env=ENV, capture_output=True, text=True)
    ids = out.stdout.split()
    return ids[-1] if ids else None


def shot(path):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-f", "x11grab", "-video_size", "1024x768", "-i", DISPLAY,
                    "-frames:v", "1", "-y", str(path)], env=ENV, check=False)


def img_stats(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    px = list(im.crop((192, 196, 832, 456)).getdata())
    cyan = sum(1 for p in px if p == (85, 255, 255))
    white = sum(1 for p in px if p == (255, 255, 255))
    uniq = len(set(px))
    # A setup dialog (spinner, LAYOUTS) has dark-red title text drawn over the map;
    # the war room and the ownership view have none.
    red = sum(1 for p in px if p[0] > 150 and p[1] < 60 and p[2] < 60)
    # Ownership view: land is solid white/unowned or flat blue/red, no terrain greens.
    terrain = sum(1 for p in px if p in ((0, 170, 0), (255, 255, 85), (85, 255, 85)))
    blue_own = sum(1 for p in px if p == (85, 85, 255))
    red_own = sum(1 for p in px if p == (255, 85, 85))
    return dict(cyan=cyan / len(px), white=white / len(px), uniq=uniq, red=red,
                terrain=terrain, blue=blue_own, red_own=red_own)


def read_pos(pid):
    base = ro.ds_base(pid)
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        f.seek(base + 0xDA28)
        col = struct.unpack("<H", f.read(2))[0]
        f.seek(base + 0xDAFC)
        row = struct.unpack("<H", f.read(2))[0]
        f.seek(base + 0xDA2A)
        zone = struct.unpack("<H", f.read(2))[0]
        f.seek(base + 0x19E)
        era = struct.unpack("<H", f.read(2))[0]
    return col, row, zone, era


def read_sites(pid):
    base = ro.ds_base(pid)
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        def rd(off, n):
            f.seek(base + off)
            return f.read(n)
        xs = struct.unpack("<84H", rd(0xF5E, 168))
        ys = rd(0x1006, 84)
        ty = rd(0x1102, 84)
        era = struct.unpack("<H", rd(0x19E, 2))[0]
        side = struct.unpack("<H", rd(0xDB02, 2))[0]
    return dict(era_index=era, player_side=side,
                sites=[dict(id=i, x=xs[i], y=ys[i], byte=ty[i],
                            subtype=ty[i] & 7, owner=(ty[i] >> 6) & 3)
                       for i in range(84)])


def lock_pointer():
    # Click open ocean so a stray Selector #1 cannot order anything.
    xdo("mousemove", "252", "424")
    time.sleep(0.3)
    xdo("click", "1")
    time.sleep(1.0)


def wait_war_room(pid, tag, era):
    """Wait for the war room, confirming both on screen and in memory.

    Two traps learned here:
    - The old test also required red < 200, true for a blue frame but false for a red
      one (Germany's flag plus red unit markers = 500+), so a red run never matched
      and the harness pressed Return into the war room ten extra times.
    - A modal setup dialog ("OPPONENT'S STARTING KEY", white panel over the map)
      appears on the way in, and DS:0x19e already reads correctly underneath it.
      Frame signature: cyan 0.56 / white 0.22 / uniq 10, against the war room's
      cyan 0.65 / white 0.11 / uniq 11.

    Screen: cyan map >= 0.60 with white <= 0.16 (no white dialog panel).
    Memory: DS:0x19e (era index) == era-1.  DS:0xdb02 is side-1 (0 for blue, 1 for red).
    """
    base = ro.ds_base(pid)
    ok = 0
    for i in range(24):
        time.sleep(2.0)
        tmp = REC / f"_probe-{tag}.png"
        shot(tmp)
        st = img_stats(tmp)
        era_now = None
        try:
            with open(f"/proc/{pid}/mem", "rb", 0) as f:
                f.seek(base + 0x19E)
                era_now = struct.unpack("<H", f.read(2))[0]
        except Exception:
            pass
        clean = st["cyan"] > 0.60 and st["white"] < 0.16 and era_now == era - 1
        ok = ok + 1 if clean else 0
        if ok >= 2:
            tmp.unlink(missing_ok=True)
            print(f"war room confirmed: era_index={era_now} stats={st}")
            return True
        key("Return", 1.0)
    return False


def settle_war_room(pid, tag):
    """Dismiss setup modals that appear *after* the war room is drawn.

    2023 and ???? raise a starting-money dialog a beat after the map appears, and a
    dialog swallows every Return the harness sends, which silently blanked the site
    readout and the ownership toggle in the first 2023/???? runs.  A modal over the
    map has white >= 0.18 and cyan ~0.56; a settled war room has white <= 0.11 and
    cyan >= 0.65.  Only press Return on the modal, never on a settled frame.
    """
    clean = 0
    for i in range(12):
        time.sleep(1.5)
        tmp = REC / f"_settle-{tag}.png"
        shot(tmp)
        st = img_stats(tmp)
        tmp.unlink(missing_ok=True)
        if st["white"] > 0.16:
            print(f"  modal up (white={st['white']:.2f}) -> Return")
            key("Return", 1.2)
            clean = 0
            continue
        if st["cyan"] > 0.60 and st["white"] < 0.16:
            clean += 1
            if clean >= 3:
                return True
        else:
            clean = 0
    return False


def open_menubar(pid, tag):
    """Nudge the cursor into row < 6 until DS:0xc34e turns non-zero."""
    base = ro.ds_base(pid)
    for attempt in range(6):
        # OWN is the 7th of 9 Mode Bar items: game column ~230 keeps it highlighted.
        subprocess.run(["sudo", "-n", "python3",
                        str(ROOT / "tools/t2/t2-nudge.py"), str(pid),
                        "230", "2"], env=ENV, check=False)
        for _ in range(30):
            with open(f"/proc/{pid}/mem", "rb", 0) as f:
                f.seek(base + 0xC34E)
                bar = f.read(1)[0]
            if bar:
                return True
            xdo("mousemove_relative", "--", "0", "-10")
            time.sleep(0.15)
    return False


def menu_shows(path):
    return img_stats(path)


def enable_ownership(pid, path):
    """Press Selector #1 on the Mode Bar; verify the ownership view by palette."""
    key("Return", 1.5)
    shot(path)
    st = img_stats(path)
    ok = st["terrain"] == 0 and st["white"] > 0.10 and (st["blue"] or st["red_own"])
    if not ok:
        key("Escape", 1.0)      # back out of whatever the cursor enacted
    return ok, st


def main():
    era = int(sys.argv[1])
    side = int(sys.argv[2])
    opp = int(sys.argv[3])
    tag = sys.argv[4]
    names = {1: "1918", 2: "1942", 3: "1986", 4: "2023", 5: "concealed"}
    year = names[era]
    REC.mkdir(parents=True, exist_ok=True)
    CAP.mkdir(parents=True, exist_ok=True)
    os.makedirs("/tmp/t6", exist_ok=True)

    start_game()
    wid = win_id()
    if wid:
        xdo("windowfocus", "--sync", wid)
    key("Return", 2.5)                       # START A NEW WAR
    for _ in range(opp - 1):
        key("Down", 0.45)
    key("Return", 2.5)                       # opponent
    for _ in range(era - 1):
        key("Down", 0.45)
    key("Return", 2.5)                       # crisis
    for _ in range(side - 1):
        key("Down", 0.45)
    key("Return", 3.0)                       # side

    pid = dosbox_pid()
    if not pid:
        print("NO_DOSBOX")
        return 2
    if not wait_war_room(pid, tag, era):
        print("NO_WAR_ROOM")
        return 3
    if not settle_war_room(pid, tag):
        print("NO_CLEAN_WAR_ROOM")
        return 5
    lock_pointer()

    pre = f"era-{year}-{'blue' if side == 1 else 'red'}-{tag}"
    war = CAP / f"era-{tag}-warroom.png"
    shot(war)
    sites = read_sites(pid)
    col, row, zone, era_idx = read_pos(pid)
    sites["cursor"] = dict(col=col, row=row, zone=zone)
    (REC / f"era-{tag}.sites.json").write_text(json.dumps(sites, indent=1))
    print(f"war room: era_index={era_idx} player_side={sites['player_side']} "
          f"cursor={col},{row} zone={zone} shot={war.name}")
    if era_idx != era - 1:
        print(f"ERA MISMATCH: asked for era {era - 1}, memory says {era_idx}")
        return 4

    # Hover every capital, capture the whole frame plus the name panels.
    #
    # SCREEN vs WORLD ROW: DS:0xdafc is the Controller row counted from the top of
    # the drawn map, and the map is drawn 6 rows down from world row 0.  Measured on
    # this host: hovering world (148,30) with the cursor at row 36 shows LONDON,
    # world (161,30) at row 36 shows BERLIN, world (150,34) at row 40 shows PARIS.
    # So the nudge target is (site.x, site.y + ROW_OFFSET); column offset is 0.
    from PIL import Image
    ROW_OFFSET = 6
    sites_json = json.loads(Path(SITES_JSON).read_text())
    by_id = {s["id"]: s["name"] for s in sites_json}
    caps = [s for s in sites["sites"] if s["subtype"] in (1, 2) and s["byte"]]
    print(f"capitals from the live table: "
          f"{[(c['id'], c['x'], c['y'], c['subtype'], c['owner']) for c in caps]}")
    hovers = []
    for c in caps:
        col, row = c["x"], c["y"] + ROW_OFFSET
        rc = subprocess.run(["sudo", "-n", "python3",
                             str(ROOT / "tools/t2/t2-nudge.py"), str(pid),
                             str(col), str(row)], env=ENV, check=False,
                            capture_output=True, text=True)
        arrived = rc.returncode == 0
        time.sleep(0.6)
        p = CAP / f"era-{tag}-cap-{c['id']}.png"
        shot(p)
        im = Image.open(p)
        im.crop((672, 450, 832, 584)).resize((640, 536), Image.NEAREST).save(
            CAP / f"era-{tag}-cap-{c['id']}-name.png")
        hovers.append(dict(id=c["id"], sites_json_name=by_id.get(c["id"]),
                           x=c["x"], y=c["y"], cursor=[col, row],
                           arrived=arrived, shot=p.name,
                           nudge=(rc.stdout or "").strip().splitlines()[-1:]))
        print(f"  hover id={c['id']} {by_id.get(c['id'])!r} at {col},{row} "
              f"arrived={arrived}")
    sites["hovers"] = hovers
    (REC / f"era-{tag}.sites.json").write_text(json.dumps(sites, indent=1))

    # Mode Bar -> Show Ownership.  Done after the hovers: entering the ownership
    # view re-draws the map and would invalidate the hover positions.  Hovering a
    # site raises the site's own hover menu, which swallows Return, so clear it
    # before opening the Mode Bar.
    key("Escape", 0.5)
    key("Escape", 0.5)
    bar_ok = open_menubar(pid, tag)
    bar = CAP / f"era-{tag}-menubar.png"
    shot(bar)
    own_ok = False
    own = CAP / f"era-{tag}-ownership.png"
    if bar_ok:
        own_ok, st = enable_ownership(pid, own)
        print(f"menubar={bar_ok} ownership={own_ok} stats={st}")
    else:
        print("menubar=FAILED")
    print(f"done {pre}: {len(caps)} capital hovers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
