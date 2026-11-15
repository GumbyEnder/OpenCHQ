#!/usr/bin/env python3
"""T-030 AC8 fix-round mutant harness.

One mutant per AC8 item, plus M6 for AC1's own rule (the Escape that must not order), applied
to the fix tree in place, the served tree re-read by the e2e (the server reads web/public from
disk per request), then reverted. A mutant is GOOD when the pin(s) that own that item go RED
and the rest stays green: that is what makes a pin a probe rather than a caption.
Pins are matched by prefix, because the check names carry their evidence suffix.

usage: ac8-mutants.py [--url http://127.0.0.1:8097] [--tree /path/to/worktree]
"""
import argparse
import pathlib
import re
import subprocess
import sys

# name, file, [(old, new), ...], pin prefixes
MUTANTS = [
    ("M1 item1 reselect radius", "web/public/command.mjs",
     [("if (own && others.length === 0 && own.distance < reserved - 1e-9) {", "if (false) {")],
     ["item 1 a re-click on the badge", "item 1 a badge click immediately followed by Escape"]),
    ("M2 item2 pending path painted", "web/public/render.mjs",
     [("  const pending = paintPendingOrders(ctx, room, view, opts);", "  const pending = 0;")],
     ["item 2 the pending path is drawn at the world fit", "item 2 the pending path is drawn when zoomed"]),
    # Base order restored: the mark is painted right after the pieces, so the capital marker and the
    # city labels paint over it — the exact order shipped at e9a8bfa (measured: top edge 10%).
    ("M3 item3 mark above capital marker and labels", "web/public/render.mjs",
     [("  const groups = paintPieces(ctx, room && room.pieces, view, opts);\n  const pieces",
       "  const groups = paintPieces(ctx, room && room.pieces, view, opts);\n"
       "  const selection = paintSelectionMark(ctx, groups, view, opts);\n  const pieces"),
      ("  const pending = paintPendingOrders(ctx, room, view, opts);\n"
       "  const selection = paintSelectionMark(ctx, groups, view, opts);",
       "  const pending = paintPendingOrders(ctx, room, view, opts);")],
     ["item 3 the ring is drawn above the capital marker"]),
    ("M4 item4 note keeps naming selection", "web/public/app.js",
     [("boardNote.textContent = previewLine(preview) || selectionLine || politicalNote || escortNote ||",
       "boardNote.textContent = politicalNote || escortNote || previewLine(preview) || selectionLine ||")],
     ["item 4 the note names the selection in the political view"]),
    ("M5 item5 ack says the selection cleared", "web/public/app.js",
     [('say(ackText(message) + (hadSelection ? " Selection cleared." : ""));', "say(ackText(message));")],
     ["item 5 an accepted order says the selection it cleared"]),
    # M6 owns AC1 itself: Escape clears the selection but also walks the selected piece one cell,
    # so an `ordered` frame comes back and its ack repaints the "Selection cleared." toast. This is
    # the shape of the defect the PM hit at e9a8bfa, and the only mutant that can bite the two
    # AC1 rule pins (M1 makes the click an order; M6 makes the Escape an order).
    ("M6 item1 escape is an order", "web/public/app.js",
     [("  if (event.key === \"Escape\" && selected) {\n    clearCommand();\n    say(\"Selection cleared.\");",
       "  if (event.key === \"Escape\" && selected) {\n"
       "    const escapeOrder = orderMessage(selected, { x: selected.x + 1, y: selected.y });\n"
       "    if (escapeOrder) sendOrder(escapeOrder);\n    clearCommand();\n    say(\"Selection cleared.\");")],
     ["item 1 a badge click immediately followed by Escape",
      "item 1 the clear still reads as a clear a second later",
      "item 1 Escape clears the selection with no order on the wire"]),
]


def run(url, tree, shots):
    p = subprocess.run(["node", "tests/e2e/t030-ac8-fix.mjs", f"--url={url}", f"--out={shots}"],
                       cwd=tree, capture_output=True, text=True, timeout=600)
    out = p.stdout + p.stderr
    rows = {}
    for line in out.splitlines():
        m = re.match(r"^(PASS|FAIL) (.+?) ::", line)
        if m:
            rows[m.group(2).strip()] = m.group(1)
    tail = [l for l in out.splitlines() if l.startswith("t030 ac8 fix summary")]
    return rows, (tail[-1] if tail else out[-300:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8097")
    ap.add_argument("--tree", default="/home/gumbyender/agents/game/worktrees/t030")
    ap.add_argument("--shots", default="/mnt/nas/projects/OpenCHQ/local/t030-fix-mutants")
    a = ap.parse_args()
    tree = pathlib.Path(a.tree)
    bad = 0

    control, summary = run(a.url, tree, a.shots + "/control")
    fails = [k for k, v in control.items() if v == "FAIL"]
    print(f"CONTROL {summary} fails={fails}")
    if fails:
        print("ABORT: control is not GREEN on the fix tree")
        return 2

    for name, rel, edits, pins in MUTANTS:
        path = tree / rel
        original = path.read_text()
        src = original
        ok = True
        for old, new in edits:
            if src.count(old) != 1:
                print(f"{name}: ABORT anchor count={src.count(old)} :: {old[:60]!r}")
                ok = False
                break
            src = src.replace(old, new)
        if not ok:
            bad += 1
            continue
        path.write_text(src)
        try:
            rows, summary = run(a.url, tree, a.shots + "/" + name.split()[0])
        finally:
            path.write_text(original)
        reds = [k for k, v in rows.items() if v == "FAIL"]
        missed = [p for p in pins if not any(k.startswith(p) and v == "FAIL" for k, v in rows.items())]
        verdict = "RED-AS-EXPECTED" if not missed else "SURVIVED"
        print(f"{name}: {verdict} | {summary}")
        print(f"   red: {reds}")
        if missed:
            print(f"   MISSED: {missed}")
            bad += 1
        print(f"   file restored identical: {path.read_text() == original}")
    print("MUTANTS_OK" if bad == 0 else f"MUTANTS_FAIL {bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
