#!/usr/bin/env python3
"""T-002: generate the absent-site id list for one era run from its capture.

The absent rule (ERA_SETUP.md §2) marks a site absent by zeroing **only** its X
word at DS:0x0f5e; the Y byte and the type byte stay as the era file wrote them.
So in a capture taken after setup:

    absent  <=>  x == 0

This script derives that set from a `*.sites.json` capture instead of a hand
typed list, and cross-checks it two ways so a drift shows up immediately:

  1. `subtype == 0` (type = byte & 7) must be the same set -- an absent site can
     never be hovered, owned or counted;
  2. with `--type-file`, the zero bytes of that era's CBR-TYPE row must be the
     same set -- that is the "59 zero bytes in era 0" check from the doc.

Usage:
  t2-absent.py docs/re/era-captures/era-1918-blue.sites.json
  t2-absent.py docs/re/era-captures/era-1942-blue.sites.json \
      --type-file "/mnt/nas/Projects/Command HQ/modern/extracted/data/cbr_type_by_era.json" --era 1

Exit status is non-zero if any cross-check disagrees, so it can gate CI.
"""
import argparse
import json
import sys


def absent_ids(path):
    with open(path) as fh:
        cap = json.load(fh)
    sites = cap["sites"]
    by_x = [s["id"] for s in sites if s["x"] == 0]
    return cap, by_x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sites_json")
    ap.add_argument("--type-file")
    ap.add_argument("--era", type=int)
    ap.add_argument("--quiet", action="store_true", help="ids only, no checks")
    args = ap.parse_args()

    cap, by_x = absent_ids(args.sites_json)
    sites = cap["sites"]
    by_sub = [s["id"] for s in sites if s["subtype"] == 0]
    ids = ",".join(str(i) for i in by_x)

    if args.quiet:
        print(ids)
        return 0

    tag = args.sites_json.rsplit("/", 1)[-1].removesuffix(".sites.json")
    print(f"run: {tag}  era_index={cap['era_index']}  player_side={cap['player_side']}")
    print(f"absent: {len(by_x)}")
    print(ids)
    print(f"subtype==0: {len(by_sub)}  same set: {sorted(by_sub) == sorted(by_x)}")

    ok = sorted(by_sub) == sorted(by_x)
    if args.type_file:
        era = cap["era_index"] if args.era is None else args.era
        with open(args.type_file) as fh:
            row = json.load(fh)[str(era)]
        zeros = [i for i, b in enumerate(row) if b == 0]
        print(f"type file era {era}: {len(row)} entries, {len(zeros)} zero bytes")
        print(f"type-file zeros == absent: {sorted(zeros) == sorted(by_x)}")
        if sorted(zeros) != sorted(by_x):
            print(f"  only in table: {sorted(set(by_x) - set(zeros))}")
            print(f"  only in file : {sorted(set(zeros) - set(by_x))}")
            ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
