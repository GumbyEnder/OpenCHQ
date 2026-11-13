# T-009b capture inbox (2026-11-13)

The raw capture log from the live DOSBox session. One line per run, in capture order; the
transcript column is the file inside `docs/re/t009b/` that holds that run's verbatim stdout, and
the reading column is what the run actually returned. Nothing here is edited into a nicer number:
the repeat that read 20 instead of 30, and the run that read 0 instead of 3, are both in the table.

Session: DOSBox 0.74-3, `CHQ.EXE`, 1942 board, speed 2, `film_mode` at `0x1478`/`0xc8cc` zeroed.
Pieces were re-pinned every 60 ms (some legs 30 ms): position, terrain byte `0x836+i`, target link
`0xbde+i`. Strength is `0x89e+i`. Every delta is logged with the pieces whose target link points at
the victim, which is how the unattributed losses in Q38 get separated from exchanges.

| time (ET) | script (harness/) | transcript | reading |
| --- | --- | --- | --- |
| 04:41:54 | `t009b.py duel` | `sanity-duel-2v3.txt` (notes/t009b) | harness sanity: 2v3 duel resolves, strength bytes move as expected |
| 04:48:44 | `t009b.py flank` | `flank-2026-11-13.txt` | repeat 1 **20** (facing re-pinned, logged as-is), repeats 2 and 3 **30** = 20 x 1.5 |
| 04:49:50 | `t009b.py entrench` | `entrench-2026-11-13.txt` | **26** vs kind 1 (cell 2->1); defender entrenches to kind 3, then **20** (cell 2->3) |
| 04:50:40 | `cover_pieces.py` | `cover-2026-11-13.txt` | **13** on a city terrain byte, twice, against the 20 cell |
| 04:51:24 | `cover_open.py` | `cover-open-2026-11-13.txt` | **20** on open plain, twice; cover is a separate modifier |
| 04:52:28 | `t009b.py attrition` | `attrition-lake-polar-2026-11-13.txt` | lake **3**, polar **5**, no shooter; the desert block in the same file shows **no delta** |
| 04:54:09 | `attrition2.py` | `attrition2-2026-11-13.txt` | desert and jungle, both isolated, both **100 flat** (`0xc478` = 255 before and after) |
| 04:56:57 | `t009b.py militia` | `militia-2026-11-13.txt` | enemy site **2**, unowned site **20**, own site **0** |
| 05:18:47 | `range4.py` | `range-sub-2026-11-13.txt` | sub fires at d2=4 (25), nothing at d2=9 |
| 05:19:34 | `range4.py` | `range-cruiser-2026-11-13.txt` | cruiser fires at d2=9 (34), nothing at d2=16 |
| 05:20:45 | `range4.py` | `range-sub-b-2026-11-13.txt` | sub repeat: both directions at d2=4, nothing at d2=9 |
| 05:21:52 | `range4.py` | `range-carrier-2026-11-13.txt` | carrier fires at d2=16 (25, twice), nothing at d2=25 |
| 05:22:24 | `attrition3.py` | `attr-desert-a-2026-11-13.txt` | desert, 100, stationary, 15 s: **100 flat** |
| 05:22:39 | `attrition3.py` | `attr-desert-floor-2026-11-13.txt` | desert, 22, stationary, 15 s: **22 flat** (the floor should stop it at 20, not 22) |
| 05:23:10 | `attrition3.py` | `attr-desert-moving-2026-11-13.txt` | desert, 100, move points held at 16, 20 s: **100 flat** |
| 05:23:51 | `t009b.py attrition` | `attr-lake-floor-2026-11-13.txt` | lake from 22 loses 2 and stops at 20 for the rest of the 30 s window |
| 05:24:27 | `air_burst.py` | `air-land-2026-11-13.txt` | 200 injected code-7 events, `hits=[]` |
| 05:25:31 | `q38.py` | `q38-2026-11-13.txt` | 60 s full-board scan: **0 deltas, 0 unattributed** |
| 05:27:41 | `air.py` | `air-2026-11-13.txt` | land strike: events consumed (wp/rp 0->5->10), target **unchanged at 100** |
| 05:28:19 | `air.py` | `air-ship-2026-11-13.txt` | ship strike: events consumed (wp/rp 10->15->20), hull **unchanged at 100** |
| 05:36:59 | `attr_terrain.py` | `wasteland-2026-11-13.txt` | `0x836` forced to 14 (wasteland) on an isolated cell: **no loss in 25 s** |
| 05:37:14 | `attr_terrain.py` | `wasteland-control-2026-11-13.txt` | same cell forced to 8 (plain): **also no loss**, so the forced byte alone does not drive the branch |
| 05:37:46 | `terrain_scan.py` | `terrain-scan-1942-2026-11-13.txt` | 1942 `tmap.bin`: **0 wasteland cells**, 0 city terrain cells (sites are records) |

Times are the capture times of the workstation files under `notes/t009b/`; the copies in this
directory are the frozen set (`freeze_harness.py`, 05:28:41-42 for the earlier legs, 05:37:20-46 for
the wasteland pair and the terrain scan).

## What the inbox is telling us

1. **The three runs cited as `attrition3` are A/B/C above**, consolidated verbatim in
   `attrition3-2026-11-13.txt`. Desert did not fire in any of them. That is a live contradiction of
   the `0x1996` table read as per-pass, and it is reported, not written into config.
2. **The two entries that fired (lake `0x03`, polar `0x05`) carry no flag bits**; both that did not
   (desert `0x23`, wasteland `0x1F`) carry `0x20`/`0x10`. Forcing `0x836` alone did not reproduce
   either, so the handler is not reading that byte in isolation.
3. **Wasteland 34 is UNMEASURED, not measured.** The 1942 board has no wasteland cell at all, and a
   forced byte produced nothing while the plain control produced nothing either. Next step: a 1986
   board, a nuke to paint the cell, then the same leg on the painted cell.
4. **Air strike is UNMEASURED** under AC10: the dispatch path (`FUN_1ac5_0dbe`, ring at `DS:0xEFBC`,
   `0xE940`/`0xE42A`) is located and drains, but no damage lands because the gate sits upstream
   (`FUN_1ac5_1206` needs an enemy aircraft within 3 cells). Method and next step are recorded.

Scripts run from the workstation copy; the self-contained copies that reproduce every row are in
`docs/re/t009b/harness/` and the commands are in `README.md`.
