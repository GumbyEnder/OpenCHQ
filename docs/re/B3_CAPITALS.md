# B-3 — capitals and starting holders in the original

Date: 2026-11-11. Task: T-002 B-3 as briefed in room 2949 (openchq-pm, Grok, PM of record).
Scope: research only. `web/server/tick.mjs` and `web/test/nodes/ownership.mjs` were not touched,
and no engine change is made here — the PM writes that from these findings.

## 1. Method and sources

Three independent sources, each named per row:

- **RAM** — the original's own turn-0 site table, from the T-006 capture rig
  (`tools/t2/t2-run.py`). Every run reads `DS:0x1102+id` (type + owner) at the first clean war-room
  frame, before any order is issued. Files: `docs/re/era-captures/era-<tag>.sites.json`.
  Blue and red seat runs are byte-identical for 1918, 1942 and 1986 (84/84 bytes compared).
- **FILE** — `modern/extracted/data/cbr_type_by_era.json`, the era type bytes the loader copies
  into `DS:0x1102` (`FUN_20b1_1290`, write at `20b1:15af`).
- **CODE** — `CHQ_unpacked.EXE`, disassembled with
  `objdump -D -b binary -m i8086 CHQ_unpacked.EXE`; the win check is `0xF6DC` (see §4).

Byte semantics: `subtype = byte & 7`; `0` absent, `1`/`2` capital, `3` base, `4` city,
`5` oilfield. `owner = byte & 0xC0`; `0x40` blue, `0x80` red, `0x00` neutral. The legacy doc
note "bit 7 = active, bits 6:5 = owner" is wrong: the win code masks `0xC0` for owner and `7` for
subtype, and `0x82` (red capital in the file) would read ownerless under a `0x60` mask.

## 2. Per-era capital table

`byte` is the RAM byte at turn 0 (`| 0x18` already applied by setup). Holder is `byte & 0xC0`.

| Era | id | Site | subtype | turn-0 byte | holder | source |
|---|---|---|---|---|---|---|
| 1918 | 10 | London | 1 | `0x59` | blue | RAM `era-1918-blue/red.sites.json`; FILE era 0 |
| 1918 | 11 | Berlin | 2 | `0x9A` | red | RAM; FILE era 0 |
| 1918 | 17 | Paris | 1 | `0x59` | blue | RAM; FILE era 0 |
| 1942 | 10 | London | 1 | `0x59` | blue | RAM `era-1942-blue/red.sites.json`; FILE era 1 |
| 1942 | 11 | Berlin | 2 | `0x9A` | red | RAM; FILE era 1 |
| 1942 | 17 | Paris | 1 | `0x99` | red | RAM; FILE era 1 |
| 1942 | 35 | Tokyo | 2 | `0x9A` | red | RAM; FILE era 1 |
| 1942 | 62 | Washington | 1 | `0x59` | blue | RAM; FILE era 1 |
| 1942 | 63 | Moscow | 1 | `0x59` | blue | RAM; FILE era 1 |
| 1986 | 10 | London | 1 | `0x59` | blue | RAM `era-1986-blue/red.sites.json`; FILE era 2 |
| 1986 | 35 | Tokyo | 1 | `0x59` | blue | RAM; FILE era 2 |
| 1986 | 62 | Washington | 1 | `0x59` | blue | RAM; FILE era 2 |
| 1986 | 63 | Moscow | 2 | `0x9A` | red | RAM; FILE era 2 |

Totals: **1918 3 capitals (2 blue / 1 red), 1942 6 (3 blue / 3 red), 1986 4 (3 blue / 1 red).**

The demand that each side "has its own capital and may have other friendly capitals" (manual p.5)
is therefore satisfied by the data: no era hands every capital to one side except when red's
capitals are absent from the *engine*, not from the data.

Cross-check, every active site in 1918/1942/1986: `RAM byte == FILE byte | 0x18` on 84/84 active
sites, with one real exception — 1986 ids 43, 46, 50, 53, where RAM is `0x1C` and the file says
`0x54/0x94`. Those four owner bits are cleared by the loader, independently confirming the
`NEUTRAL_1986` override in `tools/bake_eras.mjs`. Reproduce:

```
python3 - <<'PY'
import json
E=json.load(open('web/data/eras.json'))['eras']
r=json.load(open('docs/re/era-captures/era-1986-blue.sites.json'))
raw=json.load(open('/mnt/nas/projects/Command HQ/modern/extracted/data/cbr_type_by_era.json'))
print([(i,hex(raw['2'][i]),hex(r['sites'][i]['byte'])) for i in (43,46,50,53)])
PY
```

Rolled eras, for completeness (do not fixture a single run):

| Era | run | capitals (id, name, holder, byte) |
|---|---|---|
| 2023 | a | 29 Madrid red `0x9A`, 43 Hong Kong blue `0x59` |
| 2023 | b | 33 Denver blue `0x5A`, 34 Seoul red `0x99` |
| ???? | a | 38 St Louis blue `0x49`, 49 Houston red `0x92` |
| ???? | b | 10 London blue `0x49`, 49 Houston red `0x92` |

???? repeats Houston red in both runs and carries `0x08/0x10` where the fixed eras carry `0x18`;
that era remains out of scope (see ERA_SETUP §6-7).

Screen evidence: every capital above was hovered in its run's capture
(`docs/captures/era-<tag>-cap-<id>.png`, name crop `-name.png`); Monitor Four prints the site name
and draws the holder's flag in the holder's colour (blue on London/Washington/Paris-blue, red on
Berlin/Paris-red/Tokyo/Moscow). The crop helper is `tools/t2/t2-panels.py`.

### Correction to the brief's Monitor Two/Three premise

Monitor Two is **not** a per-site capital marker, so it must not be used as one:

- The 1986 red run, playing USSR: hovering **Moscow** (own capital) put the USSR flag and `USSR`
  in panel 2; hovering **Washington** (enemy capital) put the blue-vs-red bloc banner there.
  Pixel signature of the Washington crop equals the Leningrad crop exactly
  (blue .24 / red .29 over the same pixels), so an enemy capital is rendered like a city.
- Control, same run: hovering **Leningrad** (id 3, city, red) gave the same bloc banner.
  Reproduce with `bash tools/t2/t2-b3-control.sh` (hovers Leningrad then Moscow in the live
  1986 game and cuts Monitor Two/Four for both).
- Panel 3 is the regional minimap and does not distinguish capitals.

What the monitors do give is the *name and holder flag* on Monitor Four, which is the screen
evidence used above. The authoritative turn-0 record is the RAM byte table, not the panels.
`docs/captures/era-1918-blue-cap-*-m2.png` / `-m4.png` were **not** per-site: the three `-m2`
files are byte-identical and all three `-m4` files show the same ocean tile, i.e. one pre-hover
frame copied three times. They are removed; use `tools/t2/t2-panels.py` on the full frame instead.

## 3. What this means for the engine (for the PM, not implemented here)

The engine's capital model is two fixed cells (`web/server/match.mjs SEATS`) and
`held === 2` in `web/server/tick.mjs checkWin`. The original's set is 3 / 6 / 4 by era, and the
win code counts every site with `subtype < 3` on the map, so:

- 1918's capital set is London/Berlin/Paris: ids 62 and 63 do not exist that year (absent, byte 0).
  A fixed 62/63 seat pair cannot win or lose 1918 at all.
- 1942 has six capitals, three red. Blue does not win by taking both of the engine's seats; it must
  take Berlin, Paris and Tokyo as well. Blue already holds Washington and Moscow at turn 0.
- 1986's four capitals are London/Tokyo/Washington (blue) and Moscow (red), matching the current
  seat pair 62/63 by luck of id choice, not by rule.
- A neutral capital (owner bits 0) fails the test for *both* sides, so it must be captured.

## 4. The win check: `1c0d:000c`, file offset `0xF6DC`

Segment base `0xF6D0`; `1c0d:000c` is file `0xF6DC`. Called by near calls from the capture handler
at `0xFC34` (`1c0d:0564`) and `0xFC92` (`1c0d:05C2`), each after
`cmpw $3,-0x2(%bp)` at `0xFC2A` / `0xFC88` — i.e. only when the captured site's subtype is `< 3`
(a capital capture triggers it, a city capture never does). The pushed argument is the capturing
side's owner bits (`-0xa(%bp)`, compared with `DS:0xc350`).

```
f6dc: 55              push %bp
f6dd: 8bec            mov %sp,%bp
f6df: 83ec04          sub $4,%sp
f6e2: c746fc0000      movw $0,-4(%bp)        ; i = 0
f6ed: 837efc54        cmpw $0x54,-4(%bp)     ; i < 84
f6f1: 732b            jae f71e               ; success
f6f3: 8b5efc          mov -4(%bp),%bx
f6f6: 8a870211        mov 0x1102(%bx),%al    ; site byte + i
f6fa: 2ae4            sub %ah,%ah
f6ff: 0bc0            or %ax,%ax
f701: 74e7            je f6ea                ; absent -> skip
f703: 8a46fe          mov -2(%bp),%al
f706: 2407            and $7,%al
f708: 3c03            cmp $3,%al
f70a: 73de            jae f6ea               ; subtype >= 3 -> skip (not a capital)
f70c: 8b46fe          mov -2(%bp),%ax
f70f: 25c000          and $0xc0,%ax          ; owner bits
f712: 3b4606          cmp 6(%bp),%ax         ; vs the pushed side
f715: 74d3            je f6ea                ; this capital is held by side -> next
f717: 2bc0            sub %ax,%ax
f71c: cb              lret                   ; return 0 (not all capitals held)
f71e: b80100          mov $1,%ax
f724: cb              lret                   ; return 1 (every capital held)
```

Semantics: returns 1 only when **every active site with subtype < 3** has owner bits equal to the
side passed in; returns 0 on the first capital held by anyone else, including a neutral one.
Subtypes 1 and 2 are treated identically. There is no separate "capital captured" control field.
Code span `0xF6DC`-`0xF724`; the next function starts at `0xF726` (74 bytes including alignment
NOPs), so the "71 bytes" figure quoted in room 2955 is close but not exact.

Reproduce:

```
objdump -D -b binary -m i8086 --start-address=0xF6DC --stop-address=0xF726 \
  "/mnt/nas/projects/Command HQ/modern/extracted/exe/CHQ_unpacked.EXE"
```

## 5. Open items

- Whether the engine should model the full capital set (subtype < 3 per era) or keep two seats and
  scope the rule per era. That is a PM call; this document only establishes the original's data
  and code.
- ???? era placement and its `0x08/0x10` bits remain unexplained (ERA_SETUP §6).
- Monitor Two's per-site content is site-sensitive but not a capital oracle; its exact rule is not
  needed for the win model and is left unmodelled.
