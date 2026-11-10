# ERA PHASE B — spec

Date: 2026-11-10. Owner: openchq-pm. Implementer: game. Basis: `docs/re/ERA_SETUP.md`
(post-f4ccfda; absent lists and §6 counts are script output, re-verified 2026-11-10).
Branch: `web`. Nothing here overrides a number in ERA_SETUP.md — where this document and
that one disagree, ERA_SETUP.md wins and the spec is the thing that is wrong.

Phase B is four tasks, ordered. This document specifies **B-1 in full**. B-2..B-4 are
outlined only so the shape is visible; each gets its own spec after the one before it lands,
because each one changes behaviour that 26 test nodes currently assert.

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
34 of the 84 sites — e.g. 1986 file `type 1` on ids 10 (London), 35 (Tokyo), 62 (Washington)
where `world.json` says `city`; `type 5` on 64..83 where `world.json` says `facility`. Writing
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

## B-2 — wire it in (outline only, spec to follow)

`matchSites(era)` filters base sites through `applyEra` and carries `type` on every site;
owners seed from the table for eras 0–2 instead of from `regionOf`/`country_id`. The hard
part is not the code, it is the 26 test nodes that open a match and assert counts, routes
and ownership — each changed expectation must be named in the commit message with the reason,
not silently relaxed. No new gameplay rule is introduced in B-2; only the opening is
corrected to what ERA_SETUP.md measured.

## B-3 — the 2023 rule (outline only, spec to follow)

Two capitals at least `0x271` apart (both in X and Y), bloc ownership from
`FUN_23aa_0e1c @ 23aa:0e1c`, unowned count rolled in 32–52. Seeded, so a test can replay one
map; no owner or subtype byte copied from either capture. Acceptance must include the
invariant bounds and a fixed seed, not an eyeballed map.

## B-4 — the ???? probe (outline only, spec to follow)

Read `FUN_23aa_054c` far enough to explain `0x1102 = 4/5` in the decompiled body against
`subtype 1/2` on the live hovered capitals, and to state the placement rule. Output is a
finding appended to ERA_SETUP.md §6, not a port. ???? stays unplayable as a fixture until
that finding exists.
