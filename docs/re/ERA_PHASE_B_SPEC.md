# ERA PHASE B — spec

Date: 2026-11-10. Owner: openchq-pm. Implementer: game. Basis: `docs/re/ERA_SETUP.md`
(post-f4ccfda; absent lists and §6 counts are script output, re-verified 2026-11-10).
Branch: `web`. Nothing here overrides a number in ERA_SETUP.md — where this document and
that one disagree, ERA_SETUP.md wins and the spec is the thing that is wrong.

Phase B is four tasks, ordered. This document specifies **B-1 and B-2 in full**. B-3 and B-4
are outlined only so the shape is visible; each gets its own spec after the one before it
lands, because each one changes behaviour that the suite currently asserts.

The B-2 outline said "26 affected test nodes". That number was an estimate and it was wrong.
Measured on the implementation: 2 nodes changed expectations, 56 still green. The estimate
was mine, not the implementer's, and nothing was dropped to make it come out.

| Task | What it is | Size |
|---|---|---|
| B-1 | Era site table: bake + pure function + its own test node. No gameplay wiring. | one turn |
| B-2 | Wire the table into `matchSites`/`openMatch`; move the 26 affected test nodes. | one turn, broad |
| B-3 | 2023 roll rule (two capitals ≥ `0x271` apart, bloc ownership, unowned 32–52). | one turn |
| B-4 | Probe: read `FUN_23aa_054c` (???? placement + the `0x1102 = 4/5` vs live 1/2 contradiction). No port until it is read. | one probe |

Not in Phase B at all: ???? as a playable fixture, the 1986 four-neutral *cause* (§4 stays
UNVERIFIED; the four ship neutral), subtype 1 vs 2 semantics, any LATE/OIL roster change.

---

## B-1 — the era site table, data and pure function only

### Why it is separate

The web game today has no per-era site table. `matchSites(era)` (`web/server/board.mjs:177`)
uses the same 84 base sites for every era and only filters oil wells by `era_min`; owners are
derived from `country_id` by `seedOwners` (`web/server/economy.mjs:104`). ERA_SETUP says the
opening differs per era in three ways the game does not model: which sites exist (§2), the
type byte (§1), and the owner bits (§1, §4, §6). B-1 lands the data and the pure function and
changes nothing the game plays, so it can be verified instead of blamed.

### Files

| Path | New/edited | What |
|---|---|---|
| `tools/bake_eras.mjs` | new | reads the extract, writes `web/data/eras.json` |
| `web/data/eras.json` | new, committed | the baked table |
| `web/server/era.mjs` | new | `eraTable(era)`, `applyEra(sites, era)` |
| `web/test/nodes/era_table.mjs` | new | the acceptance test (auto-discovered, no harness edit) |

Do not edit `web/server/board.mjs`, `web/server/match.mjs`, `web/server/economy.mjs`, or any
existing file under `web/test/nodes/`. That boundary is criterion A5.

### The bake

Follow `tools/bake_world.mjs` exactly: `resolveDataRoot()` from `web/server/board.mjs`,
`BAKE_FAILED:` + exit 1 when there is no extract, `web/data/` as the output dir, `_meta`
block naming what the file is and what it is not, and `sha256_16` of every source file it
read. Source: `<root>/data/cbr_type_by_era.json` (84 entries per era row). Reuse the
SHA-16 approach at `tools/bake_world.mjs:58` so the drift guard can compare.

`eras.json` shape:

```json
{
  "_meta": { "what": "...", "not": "...", "generated": "...", "extract": "...",
             "sha256_16": { "data/cbr_type_by_era.json": "..." } },
  "eras": {
    "1918": { "fileEra": 0, "ownerSource": "file", "sites": [ { "id": 0, "type": 0, "owner": null }, ... ] },
    "1942": { "fileEra": 1, "ownerSource": "file", "sites": [ ... ] },
    "1986": { "fileEra": 2, "ownerSource": "file", "sites": [ ... ] },
    "2023": { "fileEra": 3, "ownerSource": "rolled", "sites": [ ... ] }
  }
}
```

Every entry keeps all 84 ids, including the absent ones (`type: 0`), so the raw file stays
visible and the absent set is derivable rather than stored twice.

### Rules the function must implement

**R1 — absent (§2).** `type = byte & 7`, and `type === 0` means the site is absent:
it "can never be hovered, owned or counted". `applyEra` drops those ids from the base list.
Only the absent ids are dropped — do not clear `x`/`y` on any site, and do not drop docks or
wells (they are not in the 84-entry table).

**R2 — the type byte is carried as `type`, and is NOT mapped onto `kind`.** This is a
ruling, not a preference: the file's subtype and `web/data/world.json`'s `kind` disagree on
**14 of the 84 sites** under the only mapping that exists (`1/2` = capital, `4` = city,
`5` = facility): the 12 sites whose 1986 row is `type 3` (0, 1, 2, 4, 21, 22, 51, 52, 54,
55, 57, 58) that `world.json` calls `city`, and ids 10 (London) and 35 (Tokyo) where the
file says `type 1` and `world.json` says `city`. Ids 62/63 agree (`type 1/2`, `kind`
capital) and 64..83 agree (`type 5`, `kind` facility). Writing
the subtype into `kind` would silently reclassify cities, income and the 20 facilities in one
keystroke. `kind` stays the asset list's word; the file's subtype travels beside it.

**R3 — owner (§1).** `0x40` = `"blue"`, `0x80` = `"red"`, neither = `null`, straight out of
the file for eras 0/1/2. Then the §4 override: for 1986 force ids **43, 46, 50, 53** to
`null` ("Phase B must leave them neutral"), because the original clears them after the loader
and the file still carries `0x54`/`0x94` there.

**R4 — no fixture for 2023 or ????.**
2023 (`fileEra 3`) ships its subtype row but **no owners**: the file row carries zero owner
bits, and ERA_SETUP §6 shows both runs roll ownership and even subtype differently, so
`ownerSource: "rolled"` and every owner `null` in the bake. `applyEra` must leave 2023 owners
exactly as it found them.
???? has **no entry in `eras.json` at all**: `eraTable("9999")` returns `null` and `applyEra`
is the identity. ERA_SETUP §6 forbids modelling ???? from the captures, and its file row
(`type 3/4` everywhere) contradicts the live `1/2`, so baking it would be a fixture invented
from a contradiction.

**R5 — unknown era.** Any era with no entry (`"9999"`, junk) → `eraTable` returns `null`,
`applyEra` returns the input array unchanged. Never throw, never guess `1986`.

### Acceptance criteria — each one is a command and a number

**A1 — the bake reproduces itself.**
`node tools/bake_eras.mjs` exits 0, and running it twice leaves `git status --porcelain
web/data/eras.json` empty (only `_meta.generated` may move; if it does, pin it to the source
hash instead of a clock, as `_meta.sha256_16` already does).

**A2 — the suite is green and the new node ran.**
`npm test` exit 0, with a line `node test ok: era_table`. Baseline before this work: record
the exit code you start from in the commit message, so a red suite cannot be blamed on B-1.

**A3 — the table matches the captures, by exact count.** `era_table.mjs` asserts:

| era | base sites live | absent | type histogram | blue | red | neutral |
|---|---|---|---|---|---|---|
| 1918 | 25 | 59 | `{1:2, 2:1, 4:22}` | 14 | 9 | 2 (ids 35, 53) |
| 1942 | 64 | 20 | `{1:4, 2:2, 3:12, 4:46}` | 40 | 23 | 1 (id 29) |
| 1986 | 84 | 0 | `{1:3, 2:1, 3:12, 4:48, 5:20}` | 49 | 25 | 10 (31, 43, 46, 47, 50, 53, 56, 59, 60, 78) |
| 2023 | 84 | 0 | `{3:12, 4:52, 5:20}` | 0 | 0 | 84 — `ownerSource: "rolled"` |

The 1986 neutral count is 6 from the file plus the §4 four; if the four are not forced, the
test must fail on `blue 52 / red 26 / neutral 6`.

Every cell above was re-derived on 2026-11-10 from `data/cbr_type_by_era.json` rows 0–3
against `docs/re/era-captures/*.sites.json` (`owner` = `0x40` → blue, `0x80` → red, neither
→ neutral) — 1918 25 live of 84 / 1942 64 / 1986 84 / 2023 84, and the same figures come out
of both the file and the captures except the four §4 owner bits, which is what A3 is
asserting. The earlier draft said "34 of 84" for the R2 disagreement; the reproducible count
is 14, corrected here. If any cell here disagrees with a fresh run of the derivation,
ERA_SETUP.md and the script win, and this table is wrong.

**A4 — drift guard.** When `boardPayload().source === "extract"`, `era_table.mjs` re-reads
`data/cbr_type_by_era.json` through `resolveDataRoot()` and fails naming the first differing
id if `eras.json` disagrees; when there is no extract it throws `SkipError` with the reason,
the way `bundled_board.mjs` does. A stale bake must not ship quietly.

**A5 — no gameplay change.** `git show --stat` on the B-1 commit lists only the four files
above. `applyEra(matchSites("1986"), "1986")` may be called from the test; the running game
does not call it yet.

### Out of scope for B-1 — do not do these

- Any call site: `matchSites`, `openMatch`, `seedOwners` stay untouched (B-2).
- Changing `seedOwners` to respect `type`/owner, or the win condition to admit `type 1/2`
  as capitals. Subtype 1 vs 2 is UNVERIFIED and stays unread until someone proves it.
- 2023's roll (B-3), ???? (B-4), `config/game.json`, `web/data/world.json`.
- Filling the doc table with the new numbers. ERA_SETUP.md keeps pointing at
  `tools/t2/t2-absent.py`; B-1 does not edit that document.

---

## B-2 — wire it in (specified 2026-11-10, on evidence from `6b1b657`)

B-2 does one thing: the opening the game plays at round 0 is the opening ERA_SETUP.md
measured, not one world map for every year. Three call sites move — `board.matchSites`,
`match.openMatch`, `economy.seedOwners` — and the subtype rides along as `type` **beside**
`kind`, per R2. No new gameplay rule. Where a change looks like a rule (R6, below) it is a
ruling about how to read a byte the file already carries, not a mechanic added on top.

### Files

| Path | New/edited | What |
|---|---|---|
| `web/server/board.mjs` | edited | `applyEra` inside `matchSites`; carries `type` and the file owner, and clears a capital's owner (R6) |
| `web/server/match.mjs` | edited | `openMatch` copies `type` and the file's owner onto the match's sites |
| `web/server/economy.mjs` | edited | file years: the table's owner wins, no country fallback for table rows |
| `web/server/era.mjs` | comment only | header names the R2 disagreement count and era; no behaviour change |
| `web/test/nodes/era_table.mjs`, `web/test/nodes/ownership.mjs`, `web/test/nodes/capital_open.mjs` | edited/new | changed expectations and the R6 seat test, each named in the commit message |
| `DESIGN.md` | edited | the per-era opening, one bullet |

Forbidden in B-2: `web/data/world.json`, `web/data/eras.json`, `tools/`, `config/game.json`,
any owner roll (B-3), and **any edit to `tick.mjs`**, `rules.mjs` or `placement.mjs`. The win
condition is not B-2's to change: R6 (final, below) keeps the seats unheld so the existing
`checkWin` is already correct. That boundary is A7.

### The ruling — R6 (FINAL, 2026-11-11): the seats open unheld — a deliberate interim deviation

The PM of record (openchq-pm) has now ruled this three times. Final, room post 2949:

> R6 stands for B-2 as written. Seats open null, and eras.json keeps the bytes as labels. Record it
> in ERA_PHASE_B_SPEC.md as a DELIBERATE INTERIM DEVIATION, pending B-3.

The sequence matters because the reason survives the reversal. Version one read the owner byte as a
scenario label and cleared it; version two (2949's predecessor, 2934) read it as a holder byte and
fixed the win instead. What killed version two is **data, not wording**: the extract marks capitals
by name only, and 1942's row hands **both** capital-kind seats (62/63) to blue (`0x41`, `0x41`;
subtype 1, owner `0x40`), so a held opening with a garrison that steps off ends the scenario on the
opening bell. The manual says each side has its own capital and may have "other friendly capitals"
(manual p.5), and the win is capturing every enemy capital — so 1942 is almost certainly missing
red's capitals from the extract, which leaves no honest way to seed a held opening there. That is
UNVERIFIED and it is B-3's job.

So, as merged and shipped by B-2:

- `matchSites(era)` clears `owner` on every site it returns with `kind === "capital"`, for every
  era **including** the ones with no table row. The seats open unheld.
- `eras.json` keeps every byte unchanged — the file's bytes are the measurement and B-2 does not get
  to edit the measurement away. They are read as **labels** until B-3 settles what the original
  win-check tests.
- `tick.mjs` is untouched: `holderOf` (land troops on the cell, else the site's owner) and
  `checkWin` (both seats held) are the pre-B-2 engine. A match cannot be decided at round 0 because
  no seat starts held.
- `economy.seedOwners` still never invents a capital owner: `ownable()` is city/dock/well.
- **This is an interim deviation from the original, not a claim about it.** B-3 replaces it with the
  original's real capital set and holder per era, from DOSBox turn-0 reads plus the win-check
  routine in Ghidra. Anything that treats the current opening as fidelity is wrong.

Historical note, kept because B-3 needs it: `tick.mjs` `holderOf`, `capital.mjs` (a ship in the
harbour does not hold a capital) and the bake's `NEUTRAL_1986` override (the original clears four
1986 owner bits after the loader, so the loader post-processes holder bytes) all read the byte as a
holder — the opposite of the interim reading. That mismatch is exactly what B-3 is for.

### Acceptance criteria — each one a command and a number, run at the head commit

Environment: `OPENCHQ_DATA=<extract>`; on this host the extract is
`/mnt/nas/projects/Command HQ/modern/extracted`. `<head>` is the commit under test
(`6b1b657` as written, or its docs-only rebase; the criteria are tree-based, so a rebase that
changes no code file needs no rerun).

**A1 — suite green, count unchanged, no node lost.**
`OPENCHQ_DATA=… npm test` → exit 0, with `node tests: 57 passed, 0 failed, 0 skipped` and
`WEB_OK`. `git diff --name-only 1042997..<head> -- web/test/nodes` names exactly three files:
`era_table.mjs`, `ownership.mjs` and the new `capital_open.mjs`. With no extract
(`env -u OPENCHQ_DATA node web/test/run.mjs`) exit 0, `node tests: 49 passed, 0 failed,
8 skipped`, and the eight skipped nodes are exactly `server`, `disasm`, `era_table`, `fonts`,
`lanes`, `board_paint`, `ship_routes`, `site_assets` — every one of them an extract-gated node.

The 8-vs-5 skip gap, explained: 49 + 8 = 57, so the skipped set *is* the whole difference between
the two runs and no node is being silently dropped. The earlier "five skips" figure in this spec
was short by three — `server`, `disasm` and `era_table` also gate on the extract and were simply
not counted when that number was written. A run that reports five has a partial data root
(`data/` present without `exe/` or `COMMAND/FONTS.CHQ`), not a different suite.

**A2 — opened site count, exact.** Per era, `matchSites(era).length` and its split:

| era | sites | 84-row table live | docks + wells |
|---|---|---|---|
| 1918 | 184 | 25 | 159 |
| 1942 | 228 | 64 | 164 |
| 1986 | 269 | 84 | 185 |
| 2023 | 271 | 84 | 187 |
| 9999 | 271 | 84 | 187 |

**A3 — type histogram, exact.** 1918 `{1:2, 2:1, 4:22}`, 1942 `{1:4, 2:2, 3:12, 4:46}`,
1986 `{1:3, 2:1, 3:12, 4:48, 5:20}`, 2023 `{3:12, 4:52, 5:20}` — the A3 table's four rows,
unchanged. 9999 carries **no `type` key** on any site.

**A4 — owner bytes from the file, tallied seam-visible.** On the 84 table rows of the opened,
seeded match: 1918 **13 blue / 8 red / 4 neutral**, 1942 **38 / 23 / 3**, 1986 **48 / 24 / 12**.
`eras.json` still holds the file's own counts on its *live* rows — 1918 14/9/2 of 25, 1942
40/23/1 of 64, 1986 49/25/10 of 84 — and the difference is exactly the two seats, which R6 clears.
This must not be tally-only: `ownership.mjs` also walks every live table site id-by-id against
`eras.json`, comparing the seats as `null` against a file row that says otherwise, so a
mis-seeded map cannot pass behind a right-sized count.

**A5 — R6 as behaviour, all five eras.** For each era, every `kind === "capital"` site in
`openMatch(era, matchSites(era))` after `seedOwners` has `owner === null`, and `checkWin(match)`
is `null` at round 0 — **no seat starts the match having already won or lost**. 1942's two file
bytes stay `"blue"`/`"blue"` in `eras.json` — cleared at the call site, not in the data. Two
further behaviours are pinned by `capital_open.mjs`: taking the enemy seat in 1986 (or either
seat in 1942, where both open unheld) flips exactly that one site's `id:owner` entry and nothing
else, and a side that then holds both seats wins.

**A6 — nothing outside the 84 moves.** For each of the five eras, the non-integer-id sites'
`id:owner` set after `seedOwners` is **identical** to the same set at `1042997` (159/164/185/
187 rows, all five eras). This is the load-bearing guard that B-2 changed the 84 and nothing
else.

**A7 — boundary.** Empty output from
`git diff --name-only 1042997..<head> -- web/data tools config web/server/tick.mjs web/server/rules.mjs web/server/placement.mjs`;
`git grep -c "rollEra\|Math.random" <head> -- web/server` → 0; `eras.json` keys are exactly
`1918, 1942, 1986, 2023` (no `9999`). `tick.mjs` is back inside the boundary for good: `head` must
be byte-identical to `1042997` on that path, because the final R6 needs no win-condition change.

**A8 — changed expectations named, none relaxed.** This revision's **code** commit lists six
files: `board.mjs`, `match.mjs`, `tick.mjs` and `ownership.mjs` restored to their pre-2934
behaviour (the strike), `era.mjs` comment only (F1), and the new `capital_open.mjs`. The **docs**
commit lists one: `docs/re/ERA_PHASE_B_SPEC.md`. No expectation is relaxed: `ownership.mjs` is
byte-identical to `fe88ead` again (13/8/4, 38/23/3, 48/24/12, seats compared to null), and the
merged B-2 code tree is `fe88ead` plus one trailing test file.

**A9 — branch hygiene.** Clean worktree at `<head>`; `git rev-list --count 1042997..<head>` = 6,
and history is linear, not rewritten: `057f2fc` (the spec commit), `fe88ead` (B-2 as first
written), `db30368` + `22d0fbb` (the held-opening implementation of the struck 2934 ruling, kept on
the branch as history with its spec), `35cf147` (this strike: R6 as finally ruled, F1, the seat
test) and this docs commit. No B-2 **code** file reached `web` before acceptance; nothing in B-2
was force-pushed over. The code commit message records the baseline it started from (1042997:
56/0/0 with the extract, 49/8/0 without).

### Evidence already in hand (openchq-pm, 2026-11-10, at `6b1b657`) — numbers still valid

Independent run in my own worktree, not game's: `npm test` → `node tests: 56 passed, 0 failed,
0 skipped`, `WEB_OK`, exit 0; no-extract run → exit 0, five skips as A1; the A2/A3/A4/A5 numbers
and the A6 "all five eras identical" comparison come from a probe run against both `6b1b657` and
`1042997`. Game's report agrees on every number I checked. Acceptance of the *revised* branch is
not thereby closed — `pippin` runs A1–A9 cold before `web` moves.

One correction to that list, already applied to A1: the no-extract run skips **eight** nodes, not
five (`server`, `disasm`, `era_table`, `fonts`, `lanes`, `board_paint`, `ship_routes`,
`site_assets`), and 49 + 8 = 57. The "five" was a partial data root, not a smaller suite.

### Out of scope for B-2 — do not do these

- 2023's roll (B-3) or any seeded randomness; ???? as a playable fixture (B-4).
- Subtype 1 vs 2 semantics, or painting the subtype in the client.
- Any income, price, placement-mask or routing change.
- Any win-condition change. `tick.mjs` does not move in B-2; the interim R6 is expressed entirely
  by clearing the seats at the call site.
- `web/data/world.json`, `config/game.json`, `tools/bake_eras.mjs`, ERA_SETUP's tables.

## B-3 — the 2023 rule (outline only, spec to follow)

**Numbering note (openchq-pm, room 2949).** The PM's "NEXT, B-3" is not this section: he asked for
the **per-era capital set and each capital's starting holder in the original** — (a) DOSBox turn-0
reads of the capital markers and flags on Monitor Two/Three for 1918, 1942 and 1986, both seats;
(b) the win-check routine in Ghidra, naming the byte or field it tests — with no engine change, and
the engine change written by the PM from the findings. That work is queued ahead of the 2023 roll
under the label **B-3a** below. Two tasks now claim "B-3"; the PM settles which keeps the number.

### B-3a — the original's capital set and holder per era (PM's NEXT, no engine change)

Deliverable: a per-era capital table, one row per capital with a source for each row, plus the
win-check routine's address and the byte it tests. This is the task that replaces the interim R6
deviation. Do not touch `tick.mjs` or `ownership.mjs` while gathering it.

### B-3 (original scope) — the 2023 rule

Two capitals at least `0x271` apart (both in X and Y), bloc ownership from
`FUN_23aa_0e1c @ 23aa:0e1c`, unowned count rolled in 32–52. Seeded, so a test can replay one
map; no owner or subtype byte copied from either capture. Acceptance must include the
invariant bounds and a fixed seed, not an eyeballed map.

## B-4 — the ???? probe (outline only, spec to follow)

Read `FUN_23aa_054c` far enough to explain `0x1102 = 4/5` in the decompiled body against
`subtype 1/2` on the live hovered capitals, and to state the placement rule. Output is a
finding appended to ERA_SETUP.md §6, not a port. ???? stays unplayable as a fixture until
that finding exists.
