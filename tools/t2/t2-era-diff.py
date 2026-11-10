#!/usr/bin/env python3
"""T-002: diff two era-opening captures of the same era (run a vs run b).

Prints the three numbers ERA_SETUP.md §6 quotes for 2023 — X/Y drift, subtype
diffs, owner-bit diffs — straight from the `*.sites.json` captures, plus the
unowned-site counts, because those two numbers are easy to confuse with the
owner-diff count (32 and 52 unowned were once written down as "owner diffs at 32
and 52 sites"; only one of them is a diff count).

Usage:
  t2-era-diff.py era-2023-blue-a era-2023-blue-b [--dir docs/re/era-captures]
"""
import argparse
import json
import os


def load(directory, tag):
    with open(os.path.join(directory, tag + ".sites.json")) as fh:
        return {s["id"]: s for s in json.load(fh)["sites"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--dir", default="docs/re/era-captures")
    args = ap.parse_args()

    A = load(args.dir, args.a)
    B = load(args.dir, args.b)
    if set(A) != set(B):
        print(f"id sets differ: {sorted(set(A) ^ set(B))}")
        return 2

    xy = [i for i in A if (A[i]["x"], A[i]["y"]) != (B[i]["x"], B[i]["y"])]
    sub = [(i, A[i]["subtype"], B[i]["subtype"])
           for i in A if A[i]["subtype"] != B[i]["subtype"]]
    own = [i for i in A if A[i]["owner"] != B[i]["owner"]]
    un_a = sum(1 for s in A.values() if s["owner"] == 0)
    un_b = sum(1 for s in B.values() if s["owner"] == 0)

    print(f"{args.a} vs {args.b}")
    print(f"X/Y differ: {len(xy)}/{len(A)}")
    print(f"subtype differs: {len(sub)} sites " +
          " ".join(f"({i}:{x}->{y})" for i, x, y in sub))
    print(f"owner bits differ: {len(own)} sites")
    print(f"unowned (owner 0): {args.a}={un_a}  {args.b}={un_b}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
