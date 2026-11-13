# PLACEMENT.md — where a bought unit may stand, and what readiness costs

T-011 / D-019. The original's placement rule. Manual references are to the Command HQ manual;
the decompile references are to `modern/docs/ghidra/export/decompiled.c` in the game-archive
repo (the export is not shipped in this repo).

## The rule the build now follows

Manual p.27, "General Placement Rules":

> In Placing New Units mode every city and base you own is highlighted. Land units and aircraft
> may be placed in any friendly city or base. Ships may be placed only on docks, so if all your
> ports are conquered you can't build ships.

So the legal cells are site cells, not a radius:

- land and aircraft: the cell of a site this side owns whose kind is `city`, `capital`, `base` or
  `facility`;
- ships: the cell of a site this side owns whose kind is `dock` or `docks`.

D-003's stand-in (land and air within 8 cells of a held site, hulls in coastal water within 4
cells of land) is superseded. `config/game.json` no longer carries `homeZoneCells`/`coastCells`.

## What a dock is (DERIVED, not recovered as a rule)

`web/server/board.mjs` `matchSites()` builds one `kind: "dock"` site on every terrain cell whose
id is 1, and gives it the `country_id` of an adjacent asset-list site (`neighbourSite`). The
board's own counts report 150 docks for exactly those 150 paint cells, so "a dock is a terrain
cell with id 1" and "a friendly dock is the dock next to a friendly site" are properties of
`world.json`, derived here, NOT a measured rule of the original. The code comment says so.

## Readiness (Manual p.27 "Readiness")

> Each production makes that city and several surrounding cities unready. The unready time is
> proportional to the unit's cost and to the number of friendly cities (especially capitals)
> nearby. Placing in an unready city shows a mode-bar message giving the round it will be ready.
> Ready and unready cities are highlighted differently.

State is `site.readyRound`: the first round a site may produce again. The server refuses a
purchase on an unready cell with `That city is not ready: it will be ready at round N.` The
placement mask marks a ready legal cell `1` and an unready legal cell `2`, and the page paints
them in two colours.

Every constant is an **UNMEASURED stand-in** in `config/game.json` `readiness`:

| key | value | meaning |
|---|---|---|
| `radiusCells` | 5 | Chebyshev radius (X wraps on the 320-wide board) of friendly cities a production tires |
| `roundsPerBillion` | 1 | rounds per billion of unit price |
| `cityWeight` | 0.25 | extra weight per friendly city in the radius |
| `capitalWeight` | 0.5 | extra weight per friendly capital in the radius |
| `minRounds` | 1 | floor |

`rounds = ceil(roundsPerBillion * priceInBillions * (1 + cityWeight*cities + capitalWeight*capitals))`,
over the producing site plus the friendly cities/capitals/bases inside the radius. A hull is built
on a dock; the producing site is then the nearest friendly city, base or capital, so a dock never
goes unready. Peacetime is **N/A**: this build has no peace state, so every production tires its
city. Rooms persist `siteReadyRounds` per site; a pre-T-011 row whose `sitesUnready` boolean has no
duration comes back on the next round.

## The Ghidra correction (AC5)

`modern/docs/re/ECONOMY.md` had a summary block headed "FUN_107e_4140 — Unit Placement
Validation" with an invented signature and the five strings ("Must be placed in city", "Must be
placed on dock", "Must be on mainland", "Friendly waters only", "Ships must stay at sea") listed
as its branches. **That block was a paraphrase, and the signature and branch list are wrong.**
The function body in the export (lines 3453-3487) is:

```
FUN_107e_4140 @ 107e:4140 (size 177)
undefined2 __cdecl16far FUN_107e_4140(uint param_1, undefined2 *param_2, undefined2 *param_3)
  local_4 = 0
  do {
    if (4 < local_4) return 0;                       // five rings: distance 0..4
    uVar1 = FUN_34ca_000c(*param_2, local_4 + 1, 0x140, 1);   // x + (ring+1), wrap at 0x140
    uVar2 = FUN_34ca_000c(*param_3, local_4 + 1, 0x88, 0);    // y + (ring+1), clamp at 0x88
    uVar3 = get_terrain_type(uVar1, uVar2);
    if (param_1 < 7) { if (2 < uVar3) goto LAB_107e_41b7; }   // land class needs terrain > 2
    else if (uVar3 < 3) {                                     // air class needs terrain < 3
LAB_107e_41b7:
      if ((*(byte *)(uVar3 + 0x1996) & 0x1f) == 0) {
        iVar4 = lookup_terrain_type(uVar1, uVar2);
        if (iVar4 == 0xff) { *param_2 = uVar1; *param_3 = uVar2; return 1; }
      }
    }
    local_4++
  } while (true);
}
```

It is an **arrival / berth search**, not a validator: given a unit kind (`param_1`) and a
cell, it scans outward ring by ring and returns the first nearby cell whose terrain class fits
the unit (land kinds want terrain > 2, air kinds want terrain < 3), whose terrain byte at
`DS:0x1996 + kind` has a zero low five bits, and where `lookup_terrain_type` finds no site.
It mutates `*param_2`/`*param_3` to the cell it found. Callers:

- `execute_movement` @ `107e:2bac` (export line 2502, 2504) — an air unit's move lands on the
  found cell; two calls are the retry.
- `FUN_107e_3bd0` @ `107e:3bd0` (line 3736) — an air mission's arrival.
- `FUN_107e_50xx`-family mission loop (line 4109) — mission target arrival.

The build's placement rule therefore does **not** cite FUN_107e_4140 as its evidence. The manual
p.27 text is the rule's source. The five restriction strings do exist in the extract
(`modern/extracted/data/exe_strings.txt` lines 284, 395, 396, 561), so the validator exists in
the binary somewhere; the current Ghidra export carries no string cross-references, so its
address is **not identified** and this document does not guess one. That is **Q39** in the
vault's `Open RE Questions.md` (open; next probe is a walk of references *into* segment `3f2b`,
i.e. the message-table entries) and it does not gate T-011: the shipped rule cites Manual p.27
and the readiness constants are labelled UNMEASURED.
