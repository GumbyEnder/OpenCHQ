#!/usr/bin/env python3
"""T-030 selection-feedback mutants - owns the AC2 (and AC1/AC5) red/green table.

Each mutant writes one of the defects PB-051/PB-052/PB-053 was, or the regression the
neighbouring ticket pinned, back into the tree and runs the whole node suite. The claim the
table makes is narrow and checkable: for every defect named here, the suite is RED, and the
failing test is the one the ticket says owns it. A mutant that stays green is a test that
does not exist, whatever its name suggests.

  M1  AC2  a click on another own piece while one is selected falls through the selection
           branch and reaches the order branch - the PM's 81/90/118-round orders (PB-052).
           Owner: selection_hit (the AC2 legs the e9a8bfa commit added at scales 2/4/8).
  M2  AC2  the selected piece's own badge is a candidate over its neighbour cells again, so a
           selected unit has no one-cell move - the T-028 AC8 regression.
           Owner: selection_hit AC8 leg.
  M3  AC1  the dark casing under the accent ring is dropped, leaving the bright ring on the
           badge's own pale face - the exact PB-051 defect T-030 replaced.
           Owner: selection_feedback (casing + accent strokes at three pulse phases).
  M4  AC1  selectionMarkFor answers null: the selected piece looks like every other piece.
           Owner: selection_feedback mark geometry.
  M5  AC5  routePolyline wraps each point on its own instead of unwrapping the run, so a
           319 -> 0 step draws across the whole map - PB-053.
           Owner: selection_feedback seam unwrap + routeSpan.

Usage:  OPENCHQ_DATA=<extract> python3 t030_selection_mutants.py <worktree>
The tree must be clean before and after; any mutant that leaves it dirty aborts the run.
"""
import os
import re
import subprocess
import sys
import pathlib

args = [a for a in sys.argv[1:] if not a.startswith("--")]
WT = pathlib.Path(args[0] if args else ".").resolve()
COMMAND = WT / "web/public/command.mjs"
RENDER = WT / "web/public/render.mjs"

PICK = '  if (picked) return { kind: "piece", piece: picked };'
HIT_FILTER = (
    "    hits = hits.filter((hit) => String(hit.piece.id) !== String(selectedId)\n"
    "      || (wrapX(Number(hit.piece.x), boardW) === cell.x && Number(hit.piece.y) === cell.y));"
)
CASING = "  ctx.strokeStyle = mark.casing;\n  ctx.lineWidth = 4;"
MARK_HEAD = "export function selectionMarkFor(groups, view, opts = {}) {\n  const selectedId = opts.selectedId;"
UNWRAP = "    else x += wrapDelta(raw, cell.x, boardW);"


def at(path, block):
    """`command.mjs:267` for the worktree as it stands - derived, never recorded."""
    text = path.read_text()
    i = text.find(block)
    if i < 0:
        return "%s:??" % path.name
    return "%s:%d" % (path.name, text.count("\n", 0, i) + 1)


# name, file, old, new, owner (the test that must be the one that fails), why
MUTANTS = [
    ("M1-reselect-to-move", COMMAND, PICK,
     '  if (picked && !hasSelection) return { kind: "piece", piece: picked };',
     "selection_hit",
     "a click on another own piece while one is selected reaches the order branch (%s)" % at(COMMAND, PICK)),
    ("M2-selected-badge-covers-neighbours", COMMAND, HIT_FILTER,
     "    void hits; // mutant: the selected badge is a candidate over its neighbours again",
     "selection_hit",
     "the selected-piece hit filter is gone, so a one-cell move is a re-selection (%s)" % at(COMMAND, HIT_FILTER)),
    ("M3-no-casing", RENDER, CASING,
     "  ctx.strokeStyle = mark.ink;\n  ctx.lineWidth = 4;",
     "selection_feedback",
     "the dark casing under the accent ring is dropped (%s)" % at(RENDER, CASING)),
    ("M4-no-mark", RENDER, MARK_HEAD,
     "export function selectionMarkFor(groups, view, opts = {}) {\n  return null;\n  const selectedId = opts.selectedId;",
     "selection_feedback",
     "selectionMarkFor answers null: the selected piece is unmarked (%s)" % at(RENDER, MARK_HEAD)),
    ("M5-per-point-wrap", RENDER, UNWRAP,
     '    else x = wrapX(cell.x, boardW);',
     "selection_feedback",
     "the route is wrapped per point instead of unwrapped as a run (%s)" % at(RENDER, UNWRAP)),
]

FAILED = re.compile(r"node test failed: ([A-Za-z0-9_]+):")


def git(*a):
    return subprocess.run(["git", "-C", str(WT)] + list(a), capture_output=True, text=True)


def clean_check(stage):
    out = git("status", "--porcelain").stdout.strip()
    if out:
        print("ABORT: tree not clean %s:\n%s" % (stage, out))
        sys.exit(2)


def main():
    clean_check("before the run")
    head = git("rev-parse", "--short", "HEAD").stdout.strip()
    print("worktree %s at %s" % (WT, head))
    if "OPENCHQ_DATA" not in os.environ:
        print("ABORT: OPENCHQ_DATA is unset; the suite would report 8 skips and the table would be measured on a different suite")
        sys.exit(2)

    base = subprocess.run(["node", "web/test/run.mjs"], cwd=str(WT), capture_output=True, text=True, env=os.environ.copy())
    base_last = [l for l in base.stdout.splitlines() if "node tests:" in l]
    base_verdict = "GREEN" if base.returncode == 0 else "RED"
    print("control (no mutant): %s :: %s" % (base_verdict, base_last[-1] if base_last else "(no summary)"))
    if base_verdict != "GREEN":
        print("ABORT: the control run is not green; nothing below would mean anything")
        sys.exit(2)

    rows = []
    for name, path, old, new, owner, why in MUTANTS:
        src = path.read_text()
        if src.count(old) != 1:
            print("ABORT: %s: anchor occurs %d times in %s" % (name, src.count(old), path.name))
            sys.exit(2)
        path.write_text(src.replace(old, new))
        try:
            run = subprocess.run(["node", "web/test/run.mjs"], cwd=str(WT), capture_output=True, text=True, env=os.environ.copy())
            verdict = "RED" if run.returncode != 0 else "GREEN"
            failed = sorted(set(FAILED.findall(run.stdout + run.stderr)))
            summary = [l for l in run.stdout.splitlines() if l.startswith("node tests:")]
            got_owner = owner in failed
            ok = verdict == "RED" and got_owner
            print("%-38s %-5s owner %-18s %-8s %s" % (name, verdict, owner, "OK" if ok else "!!", why))
            print("    %s" % (summary[-1] if summary else "(no summary)"))
            print("    failing: %s" % (", ".join(failed) if failed else "(none)"))
            rows.append((name, verdict, owner, ", ".join(failed) or "-", ok))
        finally:
            path.write_text(src)
        clean_check("after mutant " + name)

    bad = [r for r in rows if not r[4]]
    print()
    print("| mutant | suite | owner test | failing tests | as expected |")
    print("|---|---|---|---|---|")
    for name, verdict, owner, failed, ok in rows:
        print("| %s | %s | %s | %s | %s |" % (name, verdict, owner, failed, "yes" if ok else "NO"))
    print()
    print("%d mutants, %d as expected, %d mismatched" % (len(rows), len(rows) - len(bad), len(bad)))
    if bad:
        sys.exit(1)
    print("MUTANTS_OK")


if __name__ == "__main__":
    main()
