# ERA_SETUP — what each era's opening actually contains

Date: 2026-11-10. Task: T-002 Phase A (openchq #2780).
Method: the running original, not the manual. DOSBox 0.74-3 on Xvfb `:99`,
`dosbox_rea_linux.conf`, `CHQ.EXE` out of `/mnt/nas/Projects/Command HQ/COMMAND`, image
`modern/extracted/exe/CHQ_unpacked.EXE`, sha256
`e8f1fac5a88ffc1a1875fc3b73f8446168f6fb33e9f692c0615520c4aef1e2da`.
Harness: `tools/t2/t2-run.py` (one era/side/tag per run), `tools/t2/t2-nudge.py`
(cursor), `tools/t2/t2-names.py` (contact sheet per run), `tools/t2/t2-sites.py` /
`tools/t2/read-off.py` (memory reads), `tools/t2/t2-absent.py` (§2 absent-id lists,
generated from the captures) and `tools/t2/t2-era-diff.py` (§6 run-a vs run-b counts,
generated from the captures). Batch driver: `tools/t2/t2-all.sh`.
Every number below came out of a capture in this document; nothing here is from the
manual.

## 1. The site table in memory

The site arrays are indexed by site id, not struct fields (loader `FUN_20b1_1290 @ 20b1:1290`
parses the ASCII `CBR-SET.DAT` / `CBR-TYPE.DTn`):

| Address | Width | Meaning |
|---|---|---|
| `DS:0x0f5e` | word × 84 | X per site (map column, 0..0x13f) |
| `DS:0x1006` | byte × 84 | Y per site (map row, 0..0x87) |
| `DS:0x1102` | byte × 84 | type + owner |
| `DS:0x105a` | byte × 84 | country id (low 6 bits); high 2 bits mirror the owner bits |

`type = byte & 7`: 0 = absent, 1/2 = capital, 3 = base, 4 = city, 5 = oilfield.
Owner: `0x40` = blue, `0x80` = red (colour confirmed from the ownership-view captures
`docs/captures/era-1918-blue-ownership.png` / `-red-`). Bits `0x08` and `0x10` are set on
live sites but their meaning is **UNVERIFIED**.

The loader writes the era's type byte at `20b1:15af` (`mov [bx+0x1102], al`) after masking
it with `and word [bp-0xc], 0xcf` at `20b1:15a4` — that clears bits `0x10`/`0x20` and
**keeps** the `0x40`/`0x80` owner bits straight out of the file.

## 2. RULE — absent site: X word 0, Y and type byte untouched

A site that does not exist in an era is marked absent by zeroing **only its X word**. In
`FUN_20b1_1290 @ 20b1:1290`:

- `20b1:15af` writes the era file's type byte into `0x1102` (0 for an absent site);
- `20b1:15b3` tests it, and the zero branch runs
  `20b1:15ca` `shl bx,1` / `20b1:15cf` `mov word [bx+0xf5e], 0`;
- nothing on that branch touches `0x1006` (Y) or the byte it just wrote.

Consequences, and they matter for Phase B:

- the absent site keeps its real Y and its type byte from the file (which is 0), so
  `type = 0` and it can never be hovered, owned or counted;
- the `| 0x18` pass (§3) skips `byte == 0`, so an absent site stays `0x00`;
- a port must not copy an absent site to X = file X, and must not invent X = 0 by clearing
  the whole row.

Evidence (live table vs `modern/extracted/data/cbr_type_by_era.json`, 84 entries):

| Run | Absent sites | Ids | Y mismatches against `sites.json` |
|---|---|---|---|
| 1918 blue / red | 59 | 0,1,2,4,5,6,8,13,16,18,20,21,22,24,29,31,33,34,36,37,38,39,40,41,42,43,44,45,46,49,51,52,54,55,56,57,58,59,60,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83 | 0 of 59 |
| 1942 blue / red | 20 | 64..83 | 0 of 20 |
| 1986 blue | 0 | — | — |
| 2023 blue a / b | 0 | — | — |
| ???? blue a / b | 0 | — | — |

The 1918 list is **not typed**, and neither is any other row above. It is the output of
`tools/t2/t2-absent.py`, which reads the run's `*.sites.json` and derives `absent = (x == 0)`
from the capture:

```
python3 tools/t2/t2-absent.py docs/re/era-captures/era-1918-blue.sites.json \
    --type-file "/mnt/nas/Projects/Command HQ/modern/extracted/data/cbr_type_by_era.json" --era 0
```

It exits non-zero unless the `x == 0` set is also the capture's `subtype == 0` set and also
the era-0 file's zero-byte set — 59 ids, 59 zero bytes, all three sets equal. The 1942 row
(20 ids, 64..83), and the zero-absent rows for 1986 / 2023 / ????, come from the same script
against their own captures, and all pass both checks. Re-run it rather than editing the table.

## 3. RULE — `| 0x18` on every live site

`FUN_20b1_01b6 @ 20b1:01b6` (new-game setup), after the loader returns:

- eras 1918 / 1942 / 1986: loop at `20b1:0c09`, gate `20b1:0c21` (`cmp [0x19e],2`),
  `or byte [bx+0x1102], 0x18` at **`20b1:0c13`**, 84 iterations (`cmp [bp-0xe],0x54` at
  `20b1:0c1b`), applied only where the byte is non-zero;
- 2023: `call 23aa:0e1c` at `20b1:0c50` (world overlay first), then the same loop again at
  `20b1:0c5a` with `or ... 0x18` at **`20b1:0c64`**;
- ????: `call 23aa:054c` at `20b1:0c43` — **no** `| 0x18` pass.

Match against the era file with `(live | 0x18) == (file | 0x18)`:
**84/84 for 1918 blue and red, 84/84 for 1942 blue and red.** That is the hard match; the
remaining bits in a live byte are exactly the file's owner bits plus `0x18`.

1986 scores 80/84 and 2023 scores 52/84 and 32/84 for reasons that are real content, not
harness error — §4 and §6.

## 4. FINDING — 1986 starts four cities unowned

| id | Site | Era-2 file byte | Live byte | Live meaning |
|---|---|---|---|---|
| 43 | Hong Kong | `0x54` | `0x1c` | city, no owner |
| 46 | Shanghai | `0x54` | `0x1c` | city, no owner |
| 50 | Bombay | `0x94` | `0x1c` | city, no owner |
| 53 | Mexico City | `0x54` | `0x1c` | city, no owner |

So in 1986 these four **start unowned**. They are not a transcription slip, not blue and
not red: Phase B must leave them neutral.

Cause: **UNVERIFIED.** Ruled out so far, with addresses:

- the loader keeps the owner bits (`and …,0xcf` at `20b1:15a4` keeps `0x40`/`0x80`);
- the era<3 `| 0x18` pass only ORs (`20b1:0c09`–`20b1:0c22`) and never masks `0xc0`;
- the only 1986-gated code in the setup is the starting-money dialog —
  `cmp [0x19e],2` / `je` at `20b1:0c89`, dialog opened at `20b1:0c93` (`STARTING MONEY`,
  result into `DS:0xe33c`);
- `FUN_20b1_16c8 @ 20b1:16c8` (called at `20b1:0c77`) reads `0x1102`/`0x105a` but never
  writes them.

Cheapest next probe: watch writes to `DS:0x1102+43` during a 1986 new game (DOSBox debugger
or a `/proc/<pid>/mem` poll at 1 kHz between the loader and the war room).

## 5. RULE — hover offset: world row = cursor row − 6

`FUN_2bad_0032 @ 2bad:0032` is the controller→map converter. In the map zone
(`DS:0xcb42 == 1`):

```
2bad:0040  mov ax, [0xda28]      ; controller column
2bad:0043  mov [0xe418], ax      ; world column = column, offset 0
2bad:0046  mov si, [0xdafc]      ; controller row
2bad:004a  sub si, 6             ; world row = row - 6
2bad:004d  cmp si, 0x88
2bad:0053  mov [0xe434], si
```

The `+6` is the map's vertical origin: the marker for a site at world Y is drawn at
`(y + 6)`, `FUN_2a78_09ee @ 2a78:09ee`. Rows 0..5 belong to the Mode Bar
(`cmp [0x19e]`-independent test at `2bad:0062`, `DS:0xdafc < 6`), so a site can only be
hovered by parking the cursor at `x`, `y + 6`, and `x` can be 0..0x13f with no offset.

Measured with the harness on this host: world (148,30) hovered at cursor row 36 shows
LONDON; (161,30) at row 36 shows BERLIN; (150,34) at row 40 shows PARIS. All hover rows in
`sites.json` use exactly this +6.

## 6. Era rows — what matched, and what did not

| Era | `DS:0x19e` | Runs | Absent | Capitals (live subtype 1/2) | `\|0x18` vs file | Notes |
|---|---|---|---|---|---|---|
| 1918 | 0 | blue, red | 59 | 10, 11, 17 | 84/84 both | file is the source of truth for owner |
| 1942 | 1 | blue, red | 20 | 10, 11, 17, 35, 62, 63 | 84/84 both | file is the source of truth for owner |
| 1986 | 2 | blue, red | 0 | 10, 35, 62, 63 | 80/84 | 4 owner bits cleared, §4 |
| 2023 | 3 | blue ×2 | 0 | a: 29, 43 / b: 33, 34 | 52/84, 32/84 | positions identical between the two runs; **ownership is not** |
| ???? | 4 | blue ×2 | 0 | a: 38, 49 / b: 10, 49 | n/a | positions differ run to run; a different site is a capital each time |

2023, detail: the two runs share every X/Y pair byte for byte (0 of 84 differ) and their
bytes differ at 52 sites. Of those, **subtype differs at 4 sites** —
(29: 2→4), (33: 4→2), (34: 4→1), (43: 1→4) — and **owner bits differ at 52 sites**. Both
runs promote two bases to capitals, but never the same two and never with the same subtype,
and the owner field of most of the map is re-rolled. The two runs' *unowned* counts (run a
52, run b 32) are a different number from the 52 owner diffs; only one of them is a diff
count. All four figures are printed by
`python3 tools/t2/t2-era-diff.py era-2023-blue-a era-2023-blue-b` — do not retype them.

The overlay behind it is `FUN_23aa_0e1c @ 23aa:0e1c`, which picks two sites at least `0x271`
apart and then assigns each site's owner from the two power blocs — i.e. **the 2023 alliance
map is rolled per game**, so a single run cannot be used as a fixture. Record the rule (two
random capitals, distance floor, bloc assignment), not one run's bytes.

????, detail: the two runs share no position at all (all 84 X/Y pairs differ), and the
hover prints only the type word (`CAPITAL` / `CITY`) instead of a site name — see §7. The
era-4 setup call is `20b1:0c43 → FUN_23aa_054c @ 23aa:054c`; the internal placement rule is
**UNVERIFIED**, because the decompiled body writes `0x1102 = 4/5` (then `3` for its
capitals) while the live table shows subtypes 1/2 on the hovered capitals. Someone must
read that function properly in Phase B; do not model ????'s site table from this document.

## 7. Name verification

`VERIFIED` = the game's own hover panel (white pixel text, read off the contact sheet)
spells the name that `modern/extracted/data/sites.json` gives for that id. Sheets are
`docs/re/era-captures/era-<tag>-names.png`, built by `tools/t2/t2-names.py` from the
individual captures listed in §8.

| Run | id | Name | Verdict | Evidence |
|---|---|---|---|---|
| 1918 blue | 10 | London | VERIFIED | `era-1918-blue-cap-10.png`, sheet `era-1918-blue-names.png` |
| 1918 blue | 11 | Berlin | VERIFIED | `era-1918-blue-cap-11.png` |
| 1918 blue | 17 | Paris | VERIFIED | `era-1918-blue-cap-17.png` |
| 1918 red | 10 | London | VERIFIED | `era-1918-red-cap-10.png`, sheet `era-1918-red-names.png` |
| 1918 red | 11 | Berlin | VERIFIED | `era-1918-red-cap-11.png` |
| 1918 red | 17 | Paris | VERIFIED | `era-1918-red-cap-17.png` |
| 1942 blue | 10 | London | VERIFIED | `era-1942-blue-cap-10.png`, sheet `era-1942-blue-names.png` |
| 1942 blue | 11 | Berlin | VERIFIED | `era-1942-blue-cap-11.png` |
| 1942 blue | 17 | Paris | VERIFIED | `era-1942-blue-cap-17.png` |
| 1942 blue | 35 | Tokyo | VERIFIED | `era-1942-blue-cap-35.png` |
| 1942 blue | 62 | Washington | VERIFIED | `era-1942-blue-cap-62.png` |
| 1942 blue | 63 | Moscow | VERIFIED | `era-1942-blue-cap-63.png` |
| 1942 red | 10 | London | VERIFIED | `era-1942-red-cap-10.png`, sheet `era-1942-red-names.png` |
| 1942 red | 11 | Berlin | VERIFIED | `era-1942-red-cap-11.png` |
| 1942 red | 17 | Paris | VERIFIED | `era-1942-red-cap-17.png` |
| 1942 red | 35 | Tokyo | VERIFIED | `era-1942-red-cap-35.png` |
| 1942 red | 62 | Washington | VERIFIED | `era-1942-red-cap-62.png` |
| 1942 red | 63 | Moscow | VERIFIED | `era-1942-red-cap-63.png` |
| 1986 blue | 10 | London | VERIFIED | `era-1986-blue-cap-10.png`, sheet `era-1986-blue-names.png` |
| 1986 blue | 35 | Tokyo | VERIFIED | `era-1986-blue-cap-35.png` |
| 1986 blue | 62 | Washington | VERIFIED | `era-1986-blue-cap-62.png` |
| 1986 blue | 63 | Moscow | VERIFIED | `era-1986-blue-cap-63.png` |
| 1986 red | 10 | London | VERIFIED | `era-1986-red-cap-10.png` |
| 1986 red | 35 | Tokyo | VERIFIED | `era-1986-red-cap-35.png` |
| 1986 red | 62 | Washington | VERIFIED | `era-1986-red-cap-62.png` |
| 1986 red | 63 | Moscow | VERIFIED | `era-1986-red-cap-63.png` |
| 2023 blue a | 29 | Madrid | VERIFIED | `era-2023-blue-a-cap-29.png`, sheet `era-2023-blue-a-names.png` |
| 2023 blue a | 43 | Hong Kong | VERIFIED | `era-2023-blue-a-cap-43.png` |
| 2023 blue b | 33 | Denver | VERIFIED | `era-2023-blue-b-cap-33.png`, sheet `era-2023-blue-b-names.png` |
| 2023 blue b | 34 | Seoul | VERIFIED | `era-2023-blue-b-cap-34.png` |
| ???? blue a | 38 | St Louis | **UNVERIFIED** | `era-concealed-blue-a-cap-38.png` prints `CAPITAL`, no name |
| ???? blue a | 49 | Houston | **UNVERIFIED** | `era-concealed-blue-a-cap-49.png` prints `CITY`, no name |
| ???? blue b | 10 | London | **UNVERIFIED** | `era-concealed-blue-b-cap-10.png` prints `CAPITAL`, no name |
| ???? blue b | 49 | Houston | **UNVERIFIED** | `era-concealed-blue-b-cap-49.png` prints `CITY`, no name |

The ???? rows are not a harness failure: in that era the hover panel replaces the name with
the site type (`CAPITAL` / `CITY`, icon in the right-hand panel), i.e. the start is
concealed. Either the port conceals names for ???? too, or the whole ???? era stays out of
scope until someone plays it far enough to reveal a name.

## 8. Captures

**Path deviation.** The spec asks for `docs/captures/era-<year>-<side>-<what>.png`. This
pass writes `docs/captures/era-<year>-<side>[-a|-b]-<what>.png` — the `a`/`b` suffix exists
because 2023 and ???? were run twice (their setups are not deterministic), and the tag is
the run identifier used everywhere in `tools/t2`. Everything else is the spec name. The
machine-readable tables and the contact sheets live in `docs/re/era-captures/` (also a
deviation) and every file there is listed by name below.

`<what>` values: `warroom` (opening frame), `cap-<id>` (full frame after the nudge),
`cap-<id>-name` (2× crop of the name panel), `menubar` (Mode Bar open), `ownership`
(Show Ownership view). Monitor crops are no longer stored per capital: cut them from the full
frame with `python3 tools/t2/t2-panels.py docs/captures/era-<tag>-cap-<id>.png /tmp/panel`,
which writes `-m1`..`-m4`. The old `era-1918-blue-cap-*-m2/-m4.png` files are removed because
they were one pre-hover frame reused for three different sites (the three `-m2` files were
byte-identical and every `-m4` showed the same ocean tile); they never were per-site evidence.

Monitor Two is **not** a per-site capital marker: on the same 1986 red run, hovering Moscow
(the player's own capital) shows the USSR flag, while hovering Washington (an enemy capital)
and Leningrad (a city) show the identical blue-vs-red bloc banner (both crops hash to
`973b81d2…`). Monitor Three is the regional minimap and does not distinguish capitals either.
The capital set comes from the turn-0 RAM table and the name/flag on Monitor Four —
see `docs/re/B3_CAPITALS.md`.

### docs/re/era-captures/ — every file by name

```
era-1918-blue-names.png
era-1918-blue.sites.json
era-1918-red-names.png
era-1918-red.sites.json
era-1942-blue-names.png
era-1942-blue.sites.json
era-1942-red-names.png
era-1942-red.sites.json
era-1986-blue-names.png
era-1986-blue.sites.json
era-2023-blue-a-names.png
era-2023-blue-a.sites.json
era-2023-blue-b-names.png
era-2023-blue-b.sites.json
era-concealed-blue-a-names.png
era-concealed-blue-a.sites.json
era-concealed-blue-b-names.png
era-concealed-blue-b.sites.json
```

### docs/captures/ — every era-* file by name

    era-1918-blue-cap-10-name.png
    era-1918-blue-cap-10.png
    era-1918-blue-cap-11-name.png
    era-1918-blue-cap-11.png
    era-1918-blue-cap-17-name.png
    era-1918-blue-cap-17.png
    era-1918-blue-menubar.png
    era-1918-blue-ownership.png
    era-1918-blue-warroom.png
    era-1918-red-cap-10-name.png
    era-1918-red-cap-10.png
    era-1918-red-cap-11-name.png
    era-1918-red-cap-11.png
    era-1918-red-cap-17-name.png
    era-1918-red-cap-17.png
    era-1918-red-menubar.png
    era-1918-red-ownership.png
    era-1918-red-warroom.png
    era-1942-blue-cap-10-name.png
    era-1942-blue-cap-10.png
    era-1942-blue-cap-11-name.png
    era-1942-blue-cap-11.png
    era-1942-blue-cap-17-name.png
    era-1942-blue-cap-17.png
    era-1942-blue-cap-35-name.png
    era-1942-blue-cap-35.png
    era-1942-blue-cap-62-name.png
    era-1942-blue-cap-62.png
    era-1942-blue-cap-63-name.png
    era-1942-blue-cap-63.png
    era-1942-blue-menubar.png
    era-1942-blue-ownership.png
    era-1942-blue-warroom.png
    era-1942-red-cap-10-name.png
    era-1942-red-cap-10.png
    era-1942-red-cap-11-name.png
    era-1942-red-cap-11.png
    era-1942-red-cap-17-name.png
    era-1942-red-cap-17.png
    era-1942-red-cap-35-name.png
    era-1942-red-cap-35.png
    era-1942-red-cap-62-name.png
    era-1942-red-cap-62.png
    era-1942-red-cap-63-name.png
    era-1942-red-cap-63.png
    era-1942-red-menubar.png
    era-1942-red-ownership.png
    era-1942-red-warroom.png
    era-1986-blue-cap-10-name.png
    era-1986-blue-cap-10.png
    era-1986-blue-cap-35-name.png
    era-1986-blue-cap-35.png
    era-1986-blue-cap-62-name.png
    era-1986-blue-cap-62.png
    era-1986-blue-cap-63-name.png
    era-1986-blue-cap-63.png
    era-1986-blue-menubar.png
    era-1986-blue-ownership.png
    era-1986-blue-warroom.png
    era-1986-red-cap-10-name.png
    era-1986-red-cap-10.png
    era-1986-red-cap-35-name.png
    era-1986-red-cap-35.png
    era-1986-red-cap-62-name.png
    era-1986-red-cap-62.png
    era-1986-red-cap-63-name.png
    era-1986-red-cap-63.png
    era-1986-red-menubar.png
    era-1986-red-ownership.png
    era-1986-red-warroom.png
    era-2023-blue-a-cap-26-name.png
    era-2023-blue-a-cap-26.png
    era-2023-blue-a-cap-29-name.png
    era-2023-blue-a-cap-29.png
    era-2023-blue-a-cap-35-name.png
    era-2023-blue-a-cap-35.png
    era-2023-blue-a-cap-43-name.png
    era-2023-blue-a-cap-43.png
    era-2023-blue-a-menubar.png
    era-2023-blue-a-ownership.png
    era-2023-blue-a-warroom.png
    era-2023-blue-b-cap-33-name.png
    era-2023-blue-b-cap-33.png
    era-2023-blue-b-cap-34-name.png
    era-2023-blue-b-cap-34.png
    era-2023-blue-b-cap-41-name.png
    era-2023-blue-b-cap-41.png
    era-2023-blue-b-cap-7-name.png
    era-2023-blue-b-cap-7.png
    era-2023-blue-b-menubar.png
    era-2023-blue-b-ownership.png
    era-2023-blue-b-warroom.png
    era-concealed-blue-a-cap-30-name.png
    era-concealed-blue-a-cap-30.png
    era-concealed-blue-a-cap-36-name.png
    era-concealed-blue-a-cap-36.png
    era-concealed-blue-a-cap-38-name.png
    era-concealed-blue-a-cap-38.png
    era-concealed-blue-a-cap-49-name.png
    era-concealed-blue-a-cap-49.png
    era-concealed-blue-a-menubar.png
    era-concealed-blue-a-ownership.png
    era-concealed-blue-a-warroom.png
    era-concealed-blue-b-cap-10-name.png
    era-concealed-blue-b-cap-10.png
    era-concealed-blue-b-cap-49-name.png
    era-concealed-blue-b-cap-49.png
    era-concealed-blue-b-cap-51-name.png
    era-concealed-blue-b-cap-51.png
    era-concealed-blue-b-cap-52-name.png
    era-concealed-blue-b-cap-52.png
    era-concealed-blue-b-menubar.png
    era-concealed-blue-b-ownership.png
    era-concealed-blue-b-warroom.png

114 files, one per line.
