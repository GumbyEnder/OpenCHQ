#!/usr/bin/env python3
"""T-029 air-predicate mutants (in-repo copy; owns the RED/GREEN table).

The T-029 change is a dedupe of combat's four inlined air checks onto placement.layerOf, plus the
widening of air.isAircraft to the same rule. A game-state mutant cannot pin either one (the combat
arm is behaviour-identical by construction; the isAircraft widening is latent while no kind maps to
domain "air"). So the pin is web/test/nodes/t029_air_predicate.mjs and it is pinned HERE.

Two kinds of RED, and the difference is the point of the whole ticket:

  BEHAVIOURAL RED - the mutant changes what the engine does, and the test's meaning assertions
      (sections 1-4) catch it. air.isAircraft, rangeOf, candidatesFor, chooseTarget.
  IDENTITY RED - the mutant changes nothing observable and the test's structural guard (section 6)
      catches it anyway. computeTargets' `armed[i]` is gated behind `ranges[i] <= 0` and rangeOf
      already answers 0 for air, so that site is unreachable for air pieces: a re-narrowed copy of
      it still runs the whole suite green. Writing the pre-T-029 expression back out is the same
      story. Those two mutants are expected RED on the predicate test and GREEN on the full suite -
      behaviour identical, identity lost - and that pair is the argument for importing the predicate
      instead of copying it.

Line citations in `why` are DERIVED from the worktree at run time (see at()), never written down:
a hard-coded :NN in a harness rots the first time the file above it grows, and the next reader takes
the stale number for the live site. The PREDICATE_RED lines the node prints are computed by the
node's own section-6 scan, so those are always the real ones too.

Usage:  OPENCHQ_DATA=<extract> python3 web/test/mutants/t029_predicate_mutants.py <worktree>
The tree must be clean before and after; any mutant that leaves it dirty aborts the run.
"""
import os
import subprocess
import sys
import pathlib

args = [a for a in sys.argv[1:] if not a.startswith("--")]
WT = pathlib.Path(args[0] if args else ".").resolve()

AIR = WT / "web/server/air.mjs"
COMBAT = WT / "web/server/combat.mjs"
MOVE = WT / "web/server/move.mjs"


def at(path, block, index=-1):
    """`combat.mjs:96` for the worktree as it stands - derived from the source, never recorded.

    `block` is one or more consecutive lines; the number returned is that of block's `index` line,
    so a two-line anchor can point at its second line. An ambiguous or missing block prints ??;
    main() aborts on the same ambiguity for the mutation anchors before any row is printed.
    """
    lines = path.read_text().split("\n")
    want = [l for l in block.split("\n")]
    hits = [i for i in range(len(lines) - len(want) + 1) if lines[i : i + len(want)] == want]
    if len(hits) != 1:
        return "%s:??" % path.name
    off = index if index >= 0 else len(want) + index
    return "%s:%d" % (path.name, hits[0] + 1 + off)


NODE = (
    "import('./web/test/nodes/t029_air_predicate.mjs')"
    ".then(m => m.run({ fail: (msg) => { throw new Error(msg); } }))"
    ".then(() => console.log('PREDICATE_OK'))"
    ".catch(e => { console.log('PREDICATE_RED: ' + e.message); process.exit(1); })"
)

REACH = "  if (onAirLayer(piece)) return 0;"
REACH_IN_RANGE = "export function rangeOf(piece, combat = null) {\n  if (!piece) return 0;\n" + REACH
CANDIDATES = "    if (onAirLayer(other)) continue;"
CANDIDATES_IN_SCAN = (
    "export function candidatesFor(piece, pieces) {\n"
    "  if (!piece) return [];\n"
    "  const range = rangeOf(piece);\n"
    "  if (range <= 0) return [];\n"
    "  const out = [];\n"
    "  for (const other of pieces || []) {\n"
    "    if (!other || other.id === piece.id) continue;\n"
    "    if (other.side === piece.side) continue;\n"
    + CANDIDATES
)
ARMED = "    armed[i] = onAirLayer(piece) ? 0 : 1;"
REPAIR = "    if (isAircraft(piece)) continue; // a plane away on a mission is not on the ground"
AIR_BODY = '  return layerOf(piece) === "air";'

# name, file, old, new, expect_predicate, expect_suite ("-" = do not run the suite), kind, why
MUTANTS = [
    (
        "air-narrow",
        AIR,
        AIR_BODY,
        '  return Boolean(piece) && piece.kind === "aircraft";',
        "RED",
        "-",
        "behavioural",
        "isAircraft re-narrowed to the kind alone, the pre-T-029 body (%s)" % at(AIR, AIR_BODY),
    ),
    (
        "combat-reach-rangeOf",
        COMBAT,
        REACH,
        '  if (piece.kind === "aircraft") return 0;',
        "RED",
        "-",
        "behavioural",
        "rangeOf's air check re-narrowed to the kind alone (%s)" % at(COMBAT, REACH_IN_RANGE),
    ),
    (
        "combat-target-arm",
        COMBAT,
        CANDIDATES + "\n    if (distance(piece, other) <= range) out.push(other);",
        '    if (other.kind === "aircraft") continue;\n    if (distance(piece, other) <= range) out.push(other);',
        "RED",
        "-",
        "behavioural",
        "candidatesFor's air check re-narrowed to the kind alone (%s)" % at(COMBAT, CANDIDATES_IN_SCAN),
    ),
    (
        "combat-armed-computeTargets",
        COMBAT,
        ARMED,
        '    armed[i] = piece.kind === "aircraft" ? 0 : 1;',
        "RED",
        "GREEN",
        "identity",
        "the mass-selection pass re-narrowed (%s) - unreachable behind rangeOf, so only identity sees it"
        % at(COMBAT, ARMED),
    ),
    (
        "combat-reinlined-full-expression",
        COMBAT,
        REACH,
        '  if (piece.kind === "aircraft" || piece.domain === "air") return 0;',
        "RED",
        "GREEN",
        "identity",
        "the pre-T-029 expression written back out at %s - same meaning, so the suite must stay green"
        % at(COMBAT, REACH_IN_RANGE),
    ),
    (
        "move-repair-narrow",
        MOVE,
        REPAIR,
        '    if (piece.kind === "aircraft") continue; // a plane away on a mission is not on the ground',
        "RED",
        "GREEN",
        "identity",
        "the walker's repair pass re-narrowed at %s - PM's one-rule scope folded it in" % at(MOVE, REPAIR),
    ),
]


def git(*a):
    return subprocess.run(["git", "-C", str(WT)] + list(a), capture_output=True, text=True)


def clean_check(stage):
    out = git("status", "--porcelain").stdout.strip()
    if out:
        print("ABORT: tree not clean %s:\n%s" % (stage, out))
        sys.exit(2)


def main():
    clean_check("before the run")
    if "OPENCHQ_DATA" not in os.environ:
        print("note: OPENCHQ_DATA is unset - the suite will report 8 skips, not 0")
    head = git("rev-parse", "--short", "HEAD").stdout.strip()
    print("worktree %s at %s" % (WT, head))
    rows = []
    for name, path, old, new, expect, expect_suite, kind, why in MUTANTS:
        src = path.read_text()
        if src.count(old) != 1:
            print("ABORT: %s: anchor occurs %d times in %s" % (name, src.count(old), path.name))
            sys.exit(2)
        path.write_text(src.replace(old, new))
        ok = True
        try:
            run = subprocess.run(["node", "-e", NODE], cwd=str(WT), capture_output=True, text=True, env=os.environ.copy())
            verdict = "RED" if run.returncode != 0 else "GREEN"
            detail = (run.stdout + run.stderr).strip().splitlines()
            detail = detail[0] if detail else "(no output)"
            ok = verdict == expect
            print("%-38s %-5s expected %-5s %-2s %-11s %s" % (name, verdict, expect, "OK" if ok else "!!", kind, why))
            print("    %s" % detail[:300])
            if expect_suite != "-":
                # The predicate node is itself in the suite, so it has to step out for a suite run to
                # measure anything else: the runner skips files whose name starts with "_". What is
                # left is the pre-T-029 suite (77 nodes) - green on an identity mutant means the
                # engine's behaviour did not move, which is the claim being made.
                node_test = WT / "web/test/nodes/t029_air_predicate.mjs"
                hidden = WT / "web/test/nodes/_t029_air_predicate.mjs"
                node_test.rename(hidden)
                try:
                    suite = subprocess.run(
                        ["node", "web/test/run.mjs"], cwd=str(WT), capture_output=True, text=True, env=os.environ.copy()
                    )
                finally:
                    hidden.rename(node_test)
                sv = "GREEN" if suite.returncode == 0 else "RED"
                last = [l for l in suite.stdout.splitlines() if "node tests:" in l]
                print(
                    "    suite(without this node) %-5s expected %-5s %-2s %s"
                    % (sv, expect_suite, "OK" if sv == expect_suite else "!!", last[-1] if last else "")
                )
                if sv != expect_suite:
                    ok = False
            rows.append((name, verdict, expect, ok))
        finally:
            path.write_text(src)
        clean_check("after mutant " + name)

    bad = [r for r in rows if not r[3]]
    print()
    print("%d mutants, %d as expected, %d mismatched" % (len(rows), len(rows) - len(bad), len(bad)))
    if bad:
        for r in bad:
            print("  MISMATCH %s: got %s, expected %s" % r[:3])
        sys.exit(1)
    print("MUTANTS_OK")


if __name__ == "__main__":
    main()
