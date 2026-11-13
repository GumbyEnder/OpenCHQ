# T-009b: combat live legs (evidence)

Live DOSBox 0.74-3, `CHQ.EXE`, 1942 board, 2026-11-13. Every leg re-pinned the pieces'
position, terrain byte and target link every 60 ms (some 30 ms) so the pass loop could not walk
the layout out of the experiment, and logged every strength delta together with the pieces whose
target link pointed at the victim. Harness: `harness/` (self-contained; run as root because
`/proc/<pid>/mem` needs it).

```
sudo python3 harness/t009b.py <dosbox-pid> flank 12 3
sudo python3 harness/t009b.py <dosbox-pid> entrench 12
sudo python3 harness/t009b.py <dosbox-pid> cover 12 2
sudo python3 harness/t009b.py <dosbox-pid> attrition lake 20
sudo python3 harness/t009b.py <dosbox-pid> militia enemy 12
sudo python3 harness/range4.py <dosbox-pid> 7 7 2,3 20      # sub
sudo python3 harness/range4.py <dosbox-pid> 8 7 3,4 20      # cruiser
sudo python3 harness/range4.py <dosbox-pid> 9 7 4,5 20      # carrier
sudo python3 harness/air.py   <dosbox-pid> land 15 2
sudo python3 harness/q38.py   <dosbox-pid> 60
```

`0x89e+i` is the strength byte, `0xbde+i` the target link, `0x836+i` the terrain byte,
`0x906+i` owner|kind, `0x6fe+i` the 4-byte move points (see `harness/cmem.py`).

## Files

| file | AC | what it shows |
| --- | --- | --- |
| `flank-2026-11-13.txt` | 1 | three-piece layout, attacker perpendicular, tank vs entrenched infantry: 30 = 20 x 1.5 on repeats 2 and 3 (repeat 1 read 20, logged as-is) |
| `entrench-2026-11-13.txt` | 2 | same tank, same cell: 26 against kind 1 (cell 2->1), 20 against kind 3 after it entrenched (cell 2->3) |
| `cover-2026-11-13.txt` | 3 | entrenched infantry holding a city terrain byte takes 13 from a tank, twice |
| `cover-open-2026-11-13.txt` | 3 | the same pairing on plain takes 20, twice. Cover is a separate modifier: 20 - (20+1)/3 = 13 |
| `attrition-lake-polar-2026-11-13.txt` | 4 | lake 3 and polar 5 per pass, no shooter |
| `attr-lake-floor-2026-11-13.txt` | 4 | lake from 22 loses 2 and stops at 20 for the rest of a 30 s window (the 20 % floor) |
| `attrition-desert-2026-11-13.txt` | 4 | **contradiction**: desert lost nothing in three runs (stationary at 100, stationary at 22, and with move points held at 16) |
| `attrition3-2026-11-13.txt` | 4 | the three desert runs above, consolidated verbatim from the workstation captures, plus the jungle run on the same `0x23` byte |
| `inbox.md` | all | raw capture inbox: every run, its script, its transcript and its reading, in capture order |
| `terrain-scan-1942-2026-11-13.txt` | 4 | full nibble scan of `data/tmap.bin`: the 1942 board has **0 wasteland cells** and 0 city terrain cells |
| `wasteland-2026-11-13.txt` | 4 | **UNMEASURED**: a piece with `0x836` forced to 14 on an isolated cell lost nothing in 25 s |
| `wasteland-control-2026-11-13.txt` | 4 | the same cell with `0x836` forced to 8 (plain): also nothing, so a forced byte alone does not drive the branch |
| `militia-2026-11-13.txt` | 7 | enemy site 100->98 (2), unowned site 100->80 (20), own site 0 |
| `range-sub-cruiser-carrier-2026-11-13.txt` | 6 | sub fires at d2=4 and not d2=9; cruiser at d2=9 (34) and not d2=16; carrier at d2=16 (25, twice) and not d2=25 |
| `air-2026-11-13.txt` | 5 | land strike: code-7 events consumed (wp/rp 0->5->10) and the target unchanged at 100 |
| `air-ship-2026-11-13.txt` | 5 | ship strike: same, target unchanged. Air strikes stay UNMEASURED |
| `q38-2026-11-13.txt` | 8 | 60 s full-board strength scan on the crowded board: 0 deltas, 0 unattributed. Q38 stays OPEN |

## Notes

- The flank repeat that read 20 is kept in the log. It is the reason the config claims "twice"
  and not "three times": the facing byte was re-pinned, the geometry was not.
- Desert: the `0x1996` byte for desert is 35 = 0x23 (amount 3, dig-in bit 0x20). Lake (3) and
  polar (5) fire per pass; desert did not fire under any of the three states tried. That is a
  live contradiction of the table-as-per-pass reading and is reported, not written into config.
  The pattern worth chasing: the two entries that DID fire (lake, polar) carry no flag bits, while
  both entries that did not (desert 0x23, wasteland 0x1F) carry 0x20/0x10. Forcing the `0x836`
  byte alone did not reproduce desert either, so the handler is not reading that byte in isolation.
- Wasteland 34: the 1942 board has no wasteland cell at all (0 of 43,520 nibbles), so there is
  nothing to stand on. Forcing `0x836`=14 on an isolated cell produced no loss in 25 s, and the
  plain control produced none either. UNMEASURED; next step is a 1986 board, a nuke to paint the
  cell, then the same leg on the painted cell.
- Air strike: the event-dispatch path is real (handler `FUN_1ac5_0dbe`, 5-byte records in the
  ring at `0xEFBC`, pointers `0xE940`/`0xE42A`) and the queue drains, but no damage lands. The
  remaining gate is upstream (an enemy aircraft within 3 cells and the random at `0x148a`).
- Q38: the 1942 board was idle for the scan (0 deltas in 60 s, including pieces left in contact
  by the earlier legs), so the crowded-board loss did not reproduce in this state. Next step is
  the experiment the question already names: the crowded trio with the pass counter and
  per-pass deltas, sampled at the turn resolution rather than after it.
