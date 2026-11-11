# STRUCTS.md — Inferred Global Data Structures

> **This repo copy is the record (openchq-pm 2975, item 4).** Copied into `docs/re/` by B-3b so the
> site-byte fix carries a commit and a sha instead of living in one NAS working tree. The copy is
> byte-identical to `/mnt/nas/projects/Command HQ/modern/docs/re/STRUCTS.md` at the 2026-11-11 fix,
> whose backup is `STRUCTS.md.bak-20261111`; the extract side keeps a dated pointer to this file.
>
> The `0x1102` row below is the **measured** one: owner = bits 7:6 (mask `0xC0`), subtype = `&7`,
> evidence `1c0d:000c` plus the turn-0 RAM captures (`B3_CAPITALS.md`). The `0x906` unit-status row
> still reads bits 6:5 and is **UNVERIFIED** — no routine backs it, and the site-byte fix must not be
> copy-pasted onto the unit tables.


> **Confidence: LOW (names re-checked 2026-11-09).** The function names in this document came
> from a 2026-10-03 Ghidra pass that resolved addresses with `(segment << 4) | offset`. Above
> offset 15 that OR puts the name on a different function. The rename table has been re-applied
> with `(segment << 4) + offset`, so `docs/ghidra/export/functions.txt` is now right, but every
> claim below that depends on a name (what a function does, what calls what) is low confidence
> until it is re-read against the corrected export.

**Source:** `docs/ghidra/export/decompiled.c` (879 functions, 53 segments)
**Last analyzed:** 2026-10-02

---

## 1. Game State / Meta

| Offset | Size | Type | Name | Evidence |
|--------|------|------|------|----------|
| `0x19e` | 2 | `uint` | `player_count` | FUN_1000_0000 — read in startup; FUN_107e_3bd0 — checks `== 4` for 4-player |
| `0x1a0` | 2 | `uint` | `player_flags` | FUN_1000_0000 — adjacent to player_count |
| `0x1476` | 2 | `uint` | `current_year` | FUN_107e_3bd0 — checked against `0x1e` (30 turns = 1986→2023 era?) |
| `0x1478` | 2 | `int` | `film_mode` | FUN_107e_4616 — if non-zero, blocks normal unit commands; set during film replay |
| `0xe42e` | 2 | `uint` | `game_state` | FUN_1000_0000 — main loop state machine |
| `0xe476` | 2 | `uint` | `?` | FUN_1000_0000 — game state accessor |
| `0xe47e` | 2 | `uint` | `selected_site` | FUN_1000_0000 — currently selected city/site |
| `0xe488` | 1 | `char` | `?` | FUN_107e_3bd0 — checked for `'\0'` during AI turn |
| `0xe4bc` | 2 | `uint` | `?` | FUN_1000_0000 — game state |
| `0xe31a` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe3e4` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe7e6` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe814` | 100 | `byte[]` | `site_flags` | FUN_1000_0000 — per-site flags (bit 0 = visible, bit 1 = selected, bit 2 = hostile) |
| `0xe934` | 1 | `byte` | `?` | FUN_107e_3bd0 — compared against percentage |
| `0xe942` | 2 | `uint` | `inverted_side` | FUN_1000_0000 — `c350 ^ 0xc0`; Blue=0x50→0x90, Red=0xc0→0x30 |
| `0xe94c` | 1 | `char` | `?` | FUN_107e_3bd0 — decremented counter, compared to `'\0'` |
| `0xea6e` | 100 | `char[]` | `site_hostility` | FUN_1000_0000 — per-site hostility/intensity value |
| `0xeff2` | 2 | `int` | `?` | FUN_107e_4616 — early return if non-zero |
| `0xeaf2` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe298` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe2ae` | 2 | `int` | `?` | FUN_107e_336a — left-shifted, used in combat modifier |
| `0xe7fb` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xe7fa` | 1 | `char` | `?` | FUN_107e_336a — set to 0, used as combat modifier |
| `0xe438` | 1 | `char` | `?` | FUN_107e_336a — checked for `'\0'` before AI turn |
| `0xe439` | ? | `byte[]` | `mission_list` | FUN_107e_314e — part of mission queue |
| `0xe2bc` | ? | `byte[]` | `?` | FUN_107e_4616 — compared against `e78c` |
| `0xe6da` | ? | `byte[]` | `?` | FUN_107e_4266 — used in combat calculation |
| `0xe78c` | ? | `byte[]` | `?` | FUN_107e_4266 — compared against `e2bc` |
| `0xe8de` | 100 | `byte[]` | `?` | FUN_107e_336a — per-site value, compared to 5 |

---

## 2. Side / Player

| Offset | Size | Type | Name | Evidence |
|--------|------|------|------|----------|
| `0xc350` | 2 | `uint` | `current_side` | FUN_1000_0000 — BLUE=0x50, RED=0xc0; flipped by `c350 ^ 0xc0` |
| `0xc345` | 1 | `byte` | `?` | FUN_1000_0000 |
| `0xc3b4` | 2 | `uint` | `?` | FUN_107e_4266 — compared against `0xf` |
| `0xc3b6` | 1 | `byte` | `?` | FUN_107e_3bd0 — part of percentage calculation |
| `0xc3b7` | 1 | `byte` | `?` | FUN_107e_3bd0 — part of percentage calculation |
| `0xc3b8` | 1 | `byte` | `?` | FUN_107e_3bd0 — compared against `c3b6+c3b7 / 5` |
| `0xc3ba` | 1 | `byte` | `?` | FUN_107e_3bd0 — compared against `c3b7*2/3` |
| `0xc3f0` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xdb02` | 2 | `int` | `?` | FUN_107e_3bd0 — checked `== 0` for multiplayer decision timing |
| `0xdb02` | 2 | `int` | `multiplayer_flag` | FUN_107e_3bd0 — if zero, AI decisions use different timing |
| `0x1446` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0x144a` | 2 | `uint` | `?` | FUN_107e_3b5e — used in multi-player AI scoring |
| `0x1452` | 2 | `uint` | `?` | FUN_107e_3b5e — used in multi-player AI scoring |
| `0x148e` | 2 | `uint` | `?` | FUN_107e_3bd0 — divided by `0x28` (40) for turn pacing |
| `0x1550` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0x157e` | 2 | `int` | `money` | FUN_1000_0000 — player money; strings reference "Money", "Balance", "Income" |
| `0x1986` | 2 | `uint` | `?` | FUN_107e_4616 — used as offset into site array |
| `0x1996` | 2 | `uint` | `?` | FUN_107e_4140 — used as offset into site array |
| `0x1156` | 2 | `uint` | `?` | FUN_107e_336a — multiplied by 2, capped at 0x41 |
| `0x2370` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0x2e16` | 10 | `byte[]` | `turn_budget_table` | FUN_107e_3bd0 — indexed by `local_6`; values compared against `uVar2 / 40` |
| `0x2bad` | ? | `uint` | `?` | FUN_1000_0000 |

---

## 3. World Map — Sites (Cities)

100 sites total. Each site is a 4-byte record accessed via index 0..99.

| Offset (base + index) | Size | Type | Name | Evidence |
|-----------------------|------|------|------|----------|
| `0xf5e` + `i*2` | 2 | `uint` | `site_coords` | FUN_1000_0000 — stored as `x*256+y` format |
| `0x1006` + `i` | 1 | `byte` | `site_type` | FUN_1000_0000 — terrain type (ocean, city, capital, oilfield, etc.) |
| `0x1102` + `i` | 1 | `byte` | `site_active` | FUN_1000_0000 — **bits 7:6 = owner** (`0x40` BLUE / `0x80` RED / `0x00` neutral), **bits 2:0 = subtype** (1 and 2 are the two capital subtypes), bits 4:3 set on every active site at load (`|0x18`) |
| `0x10ae` + `i` | 1 | `char` | `site_name_offset` | FUN_1000_0000 — string table index; `'\0'` = no name |
| `0xcae` + `i` | 1 | `byte` | `site_misc_flags` | FUN_107e_2ff4 — bit 2 = moving; FUN_107e_4616 — bit 2 set on move |
| `0xcb46` + `i` | 1 | `byte` | `site_region` | FUN_1000_0000 — which of 84 regions this site belongs to |
| `0xc46` + `i` | 1 | `byte` | `site_misc2` | FUN_107e_4616 — bit 6 checked for command eligibility |
| `0xe814` + `i` | 1 | `byte` | `site_flags` | FUN_107e_2ff4 — bit 0 = visible, bit 1 = selected, bit 2 = hostile |
| `0xea6e` + `i` | 1 | `char` | `site_hostility` | FUN_1000_0000 — hostility value for site |
| `0xe8de` + `i` | 1 | `byte` | `?` | FUN_107e_336a — per-site value, compared to 5 |
| `0xe6da` + `i` | 1 | `byte` | `?` | FUN_107e_4266 — used in combat calculation |
| `0xe78c` + `i` | 1 | `byte` | `?` | FUN_107e_4266 — compared against `e2bc[i]` |
| `0xe2bc` + `i` | 1 | `byte` | `?` | FUN_107e_4266 — compared against `e78c[i]` |

**Correction, 2026-11-11 (`0x1102` owner field).** This row previously read "bit 7 = active, bits 6:5 = owner". Both halves were wrong, and the fix is measured, not inferred:
- The win check at `1c0d:000c` (71 bytes, file offset `0xF6DC`, called from the capture handler `1c0d:02ce` at `0x0564`/`0x05c2`) masks `0xc0` for owner and `&7` for subtype; a zero byte means "no site". It never tests bit 7.
- Masking `0x60` (bits 6:5) reads every red site as ownerless: red bytes are `0x81`/`0x82`/`0x9a`, and `0x82 & 0x60 == 0`. Under the old row, 5 of the 13 capital sites in the three fixed eras (all five red ones) read as neutral.
- Bit 7 is part of the owner pair, not an active flag: a blue capital is `0x41` (bit 7 clear) and a red one is `0x81`/`0x82` (bit 7 set). "Active" is "byte != 0" plus subtype `< 3`.
- Capital sites per era, read from `extracted/data/cbr_type_by_era.json` (`(byte&7) in {1,2}`, owner `byte&0xc0`): 1918 → 3, 1942 → 6, 1986 → 4, 2023 and ???? → 0 in the file (rolled at launch). Owners agree with the original's turn-0 RAM; see `B3_CAPITALS.md` and `ERA_PHASE_B_SPEC.md` R6/B-3.
- `0x906` (`unit_status`, row below) and the unit tables in `SYSTEMS.md`/`MOVEMENT.md`/`COMBAT.md` still say bits 6:5. That is **unverified, not corrected** — this note covers the site byte only.

**Known site types** (from strings): `capital`, `city`, `oilfield`, `docks`, `base`, `ocean`, `plain`, `forest`, `mountain`, `desert`, `jungle`, `polar`, `wasteland`.

**Known cities** (from strings): Washington, Moscow, London, Paris, Berlin, Tokyo, Beijing, Cairo, New York, Los Angeles, Chicago, Houston, Denver, Boston, Atlanta, Detroit, Seattle, St Louis, Toronto, Mexico City, Caracas, Rio de Janeiro, Havana, Buenos Aires, Madrid, Lisbon, Rome, Warsaw, Prague, Budapest, Vienna, Stockholm, Oslo, Copenhagen, Helsinki, Leningrad, Gorkiy, Novosibirsk, Kharkov, Smolensk, Sevastopol, Archangel, Istanbul, Jerusalem, Tehran, Baghdad, Riyadh, Cairo, Khartoum, Johannesburg, Lagos, Nairobi, Dakar, Algiers, Casablanca, Bamako, Timbuktu, Mogadishu, Addis Ababa, Mombasa, Dar es Salaam, Dar es Salaam, Kinshasa, Brazzaville, Luanda, Windhoek, Maputo, Beira, Lourenco Marques, Durban, Port Elizabeth, Cape Town, Bloemfontein, Pretoria, Salisbury, Lusaka, Ndola, Kitwe, Dar es Salaam, Zanzibar, Mombasa, Nairobi, Kampala, Dodoma, Arusha, Mogadishu, Hargeisa, Berbera, Bosaso, Kismayo, Merca, Brava, Barawa, Marka, Afgooye, Beledweyne, Jowhar, Baidoa, Bardera, Kismayo, Luanda, Benguela, Lobito, Namibe, Moçâmedes, Huambo, Kuito, Cabinda, Soyo, N'zeto, M'banza-Kongo, Malanje, Uíge, Luena, Lichinga, Nampula, Quelimane, Tete, Chimoio, Manica, Beira, Inhambane, Xai-Xai, Maputo, Matola, Marracuene, Boane, Manhiça, Moamba, Namaacha, Matutuíne, Chókwè, Govuro, Machanga, Pebane, Chókwè, Xai-Xai, Inhambane, Vilankulo, Chandungua, Massangana, Govuro, Machanga, Pebane, Chókwè.

**Regions** (84 total, from strings): USA, USSR, W Germany, E Germany, Poland, Czechoslovakia, Hungary, Romania, Bulgaria, Yugoslavia, Albania, Greece, Turkey, Iran, Iraq, Saudi Arabia, Libya, Egypt, Syria, Israel, Jordan, Lebanon, Yemen, Oman, UAE, Qatar, Bahrain, Kuwait, Pakistan, India, Bangladesh, Burma, Thailand, Vietnam, Laos, Cambodia, Malaysia, Indonesia, Philippines, Japan, South Korea, North Korea, China, Mongolia, Afghanistan, Nepal, Bhutan, Sri Lanka, Maldives, Myanmar, Papua New Guinea, Australia, New Zealand, Canada, Mexico, Cuba, Haiti, Dominican Republic, Jamaica, Trinidad, Barbados, Guyana, Suriname, French Guiana, Ecuador, Peru, Bolivia, Paraguay, Uruguay, Chile, Argentina, Brazil, Venezuela, Colombia, Panama, Costa Rica, Nicaragua, Honduras, El Salvador, Guatemala, Belize, Honduras, El Salvador, Guatemala, Belize.

---

## 4. World Map — Regions

84 regions. Each region is a ~10-byte record accessed via index 0..83.

| Offset (base + index) | Size | Type | Name | Evidence |
|-----------------------|------|------|------|----------|
| `0x130a` + `i*2` | 2 | `uint` | `region_coords` | FUN_1000_0000 — stored as `x*256+y` |
| `0x1346` + `i` | 1 | `byte` | `region_type` | FUN_1000_0000 — terrain type for region |
| `0x1382` + `i` | 1 | `byte` | `region_controller` | FUN_1000_0000 — owner of region |
| `0x13a0` + `i` | 1 | `byte` | `region_flags` | FUN_1000_0000 — flags for region |
| `0x1364` + `i` | 1 | `byte` | `region_active` | FUN_1000_0000 — bit 7 = active |

---

## 5. World Map — Distance Matrix

| Offset | Size | Type | Name | Evidence |
|--------|------|------|------|----------|
| `0xc394` | 54×100 | `byte[5400]` | `distance_matrix` | FUN_1000_0000 — 100 sites × 54 regions; `FUN_188b_0018` uses this for terrain checks |
| `0xc4a8` | 50 | `byte[50]` | `mission_sites` | FUN_107e_336a — up to 50 site indices for current mission |

---

## 6. Units

100 units total. Each unit is a ~16-byte record accessed via index 0..99.

| Offset (base + index) | Size | Type | Name | Evidence |
|-----------------------|------|------|------|----------|
| `0x1b6` + `i*2` | 2 | `uint` | `unit_coords` | FUN_1000_0000 — stored as `x*256+y` |
| `0x286` + `i` | 1 | `byte` | `unit_type` | FUN_1000_0000 — unit type code (carrier, cruiser, sub, etc.) |
| `0x906` + `i` | 1 | `byte` | `unit_status` | FUN_1000_0000 — bit 7 = active, bits 6:5 = owner, bits 4:0 = subtype. **UNVERIFIED (2026-11-11):** no routine has been read for this byte; the bits 6:5 wording is inherited, not measured. Do not correct it from the site byte. |
| `0x89e` + `i` | 1 | `byte` | `unit_strength` | FUN_1000_0000 — health/strength value; compared to 0x50, 0x3d |
| `0x836` + `i` | 1 | `byte` | `unit_owner` | FUN_1000_0000 — owner index (0=player, 1=AI, etc.) |
| `0x426` + `i*2` | 2 | `uint` | `unit_dest_x` | FUN_107e_41f2 — destination X coordinate |
| `0x4f6` + `i` | 1 | `byte` | `unit_dest_y` | FUN_107e_41f2 — destination Y coordinate |
| `0x62e` + `i*2` | 2 | `uint` | `unit_target_x` | FUN_107e_4616 — target X coordinate for attack |
| `0x96e` + `i` | 1 | `byte` | `unit_target_y` | FUN_107e_4616 — target Y coordinate for attack |
| `0x55e` + `i*2` | 2 | `uint` | `unit_misc1` | FUN_107e_4616 — used in terrain check |
| `0xa3e` + `i` | 1 | `byte` | `unit_misc2` | FUN_107e_4616 — used in terrain check |
| `0x4f6` + `i` | 1 | `byte` | `?` | FUN_107e_41f2 — compared against other unit's `4f6` |
| `0x3588` + `i*2` | 2 | `uint` | `unit_current_site` | FUN_107e_336a — current site index; 0xff = at sea |
| `0x3650` + `i*2` | 2 | `uint` | `unit_flags` | FUN_107e_2ff4 — bit 10 = moving, bit 9 = at sea, bit 8 = at site |

**Unit types** (from strings): carrier, cruiser, submarine, aircraft, paratroop, transport, tank, infantry, coastgn (coastal gun), airship, airdrop, airtank, killsat (killer satellite), spysat (spy satellite), blowsat (blow satellite), nuke (nuclear), ksub (killer submarine).

---

## 7. Overlay System

| Offset | Size | Type | Name | Evidence |
|--------|------|------|------|----------|
| `0xc4ec` | 2 | `uint` | `frame_counter` | FUN_1000_0000 — incremented each frame |
| `0xc4ea` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xc6f0` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xc704` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xc706` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xc7ae` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0xc7ac` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0x3e7b` | 2 | `uint` | `?` | FUN_1000_0000 |
| `0x3e87` | 2 | `uint` | `turn_timer` | FUN_1000_0000 — countdown for turn |
| `0x2541` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2724` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2757` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x27a1` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2bad` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2c85` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2a78` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x298d` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x2ffd` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x3cdc` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x3480` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x34d5` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x3edb` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x38df` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x336f` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x3572` | ? | `uint` | `?` | FUN_1000_0000 — overlay/graphics |
| `0x3bd6` | 18 | `char[18]` | `?` | FUN_107e_3bd0 — 9×2 byte array, compared against calculated coordinates |
| `0xc814` | 30 | `char[30]` | `?` | FUN_107e_4dac — 10×3 byte array, used for path generation |
| `0x6df4` | 2 | `uint` | `mission_queue_size` | FUN_107e_336a — queue size, set to `param_1 << 1` (min 4) |
| `0x6df6` | 2 | `uint` | `mission_queue_count` | FUN_107e_314e — number of entries in queue |
| `0x1bc7` | ? | `byte[]` | `mission_queue` | FUN_107e_314e — queue entries, size = `6df4` |

---

## 8. File System / Overlay Files

| File | Purpose | Evidence |
|------|---------|----------|
| `CHQ.EXE` | Main executable | String reference |
| `CHQ-??.REP` | Replay/film file | String reference, `xxCHQ-12.rep` |
| `C_HQ.REP` | Replay file | String reference |
| `c_hq.rep` | Replay file (lowercase) | String reference |
| `OMAP.PIC` | Overworld map image | String reference |
| `WORLD.PIC` | World map image | String reference |
| `SATLLOB.PIC` | Satellite globe image | String reference |
| `SHIELDS.PIC` | Shield/overlay image | String reference |
| `UNITS.PIC` | Unit sprites image | String reference |
| `FCITY.PAN` | City sprite | String reference |
| `LCITY.PAN` | City sprite (variant) | String reference |
| `CARRIER.PAN` | Carrier sprite | String reference |
| `CRUISER.PAN` | Cruiser sprite | String reference |
| `SUB.PAN` | Submarine sprite | String reference |
| `KSUB.PAN` | Killer submarine sprite | String reference |
| `AIRSHIP.PAN` | Airship sprite | String reference |
| `AIRTANK.PAN` | Airtank sprite | String reference |
| `AIRDROP.PAN` | Airdrop sprite | String reference |
| `BOMBCITY.PAN` | City bombing sprite | String reference |
| `BOMBMEN.PAN` | Bombing men sprite | String reference |
| `BOMBOIL.PAN` | Oilfield bombing sprite | String reference |
| `BLOWSAT.PAN` | Blow satellite sprite | String reference |
| `KILLSAT.PAN` | Killer satellite sprite | String reference |
| `SPYSAT.PAN` | Spy satellite sprite | String reference |
| `NUKE.PAN` | Nuclear sprite | String reference |
| `COASTGN.PAN` | Coastal gun sprite | String reference |
| `DOGFIGT.PAN` | Dogfight sprite | String reference |
| `TANKS.PAN` | Tank sprite | String reference |
| `TRNSPRT.PAN` | Transport sprite | String reference |
| `WAR2.PAN` | War sprite | String reference |
| `LBASE.PAN` | Base sprite | String reference |
| `LOIL.PAN` | Oilfield sprite | String reference |
| `SUBTRGT.PAN` | Sub target sprite | String reference |
| `XXX.PAN` | Generic sprite | String reference |
| `CBR_DIST.DAT` | CBR (chemical/biological/radiological?) distance data | String reference |
| `CBR_REGN.DT` | CBR region data | String reference |
| `CBR_SET.DAT` | CBR set data | String reference |
| `CBR_TYPE.DT` | CBR type data | String reference |
| `TMAP.DAT` | Terrain map data (movement rules) | String reference |
| `REGIONS.DAT` | Region data | String reference |
| `CITY.DAT` | City data | String reference |
| `FLAGS.CAT` | Flags catalog | String reference |
| `HQANIMS` | Animation directory | String reference |
| `HQFLAGS` | Flags directory | String reference |
| `HQGRAPHICS` | Graphics directory | String reference |
| `HQSOUND` | Sound directory | String reference |
| `HQLAYOUT.` | Layout files | String reference |
| `CMPCRLD.DAT` | World comparison data | String reference |
| `SOUND.DRV` | Sound driver | String reference |
| `ADLIB.DRV` | AdLib sound driver | String reference |
| `ROLAND.DRV` | Roland sound driver | String reference |
| `TANDY.DRV` | Tandy sound driver | String reference |
| `IBM.DRV` | IBM sound driver | String reference |
| `THEMEIBM.SNG` | IBM theme song | String reference |
| `NETWORK.OVL` | Network overlay | String reference |
| `SERIAL.OVL` | Serial overlay | String reference |
| `EGRAPHIC.EXE` | Graphics executable | String reference |
| `HQ.MAC` | Macro file | String reference |
| `COMMAND H.Q. MANUAL.` | Manual reference | String reference |
| `MODEM.INI` | Modem configuration | String reference |
| `FONTS.CHQ` | Font data | String reference |
| `ANIMS\` | Animation directory | String reference |
| `SAVE\` | Save directory | String reference |

---

## 9. Sound Drivers

| Driver | Purpose | Evidence |
|--------|---------|----------|
| `adlib.drv` | Yamaha OPL3 AdLib | String reference |
| `roland.drv` | Roland MT-32 / CM-32L | String reference |
| `tandy.drv` | Tandy 1000 sound | String reference |
| `ibm.drv` | IBM PC Speaker | String reference |
| `THEMEIBM.SNG` | IBM theme song | String reference |

---

## 10. Input Devices

| Device | Evidence |
|--------|----------|
| Keyboard | `KEYBOARD SENSITIVITY` string |
| Mouse | `MOUSE SENSITIVITY` string |
| Joystick | `JOYSTICK SENSITIVITY` string, `No joystick found` string |

---

## 11. Communication Protocols

| Protocol | Evidence |
|----------|----------|
| Serial modem | `MODEM/PHONE`, `DIRECT SERIAL`, `AT&T5&T0`, `ATS0=0S2=43S12=50`, `ATS7=30S9=6S10=50` |
| LAN | `NETWORK/LAN` string |
| Packet sync | `RE-SYNCH`, `OUT of SYNCH`, `packet error`, `Testing Sync` |

---

## 12. Game Eras / Years

| Year | Evidence |
|------|----------|
| 1918 | String reference — starting era |
| 1942 | String reference — second era |
| 1986 | String reference — third era |
| 2023 | String reference — final era |
| ???? | String reference — unknown era |

---

## 13. Unit Type Codes (Inferred)

From string evidence and function analysis:

| Code | Type | Evidence |
|------|------|----------|
| 0 | Unknown | — |
| 1 | Carrier | `CARRIER.PAN` |
| 2 | Cruiser | `CRUISER.PAN` |
| 3 | Submarine | `SUB.PAN` |
| 4 | Killer Sub | `KSUB.PAN` |
| 5 | Aircraft | `AIRSHIP.PAN` |
| 6 | Airtank | `AIRTANK.PAN` |
| 7 | Airdrop | `AIRDROP.PAN` |
| 8 | Killsat | `KILLSAT.PAN` |
| 9 | Spysat | `SPYSAT.PAN` |
| 10 | Blowsat | `BLOWSAT.PAN` |
| 11 | Nuke | `NUKE.PAN` |
| 12 | Coastal Gun | `COASTGN.PAN` |
| 13 | Dogfighter | `DOGFIGT.PAN` |
| 14 | Tank | `TANKS.PAN` |
| 15 | Transport | `TRNSPRT.PAN` |
| 16 | Infantry | — |
| 17 | Paratroop | — |

---

## 14. Site Type Codes (Inferred)

| Code | Type | Evidence |
|------|------|----------|
| 0 | Ocean | `ocean` string |
| 1 | City | `city` string |
| 2 | Capital | `capital` string |
| 3 | Oilfield | `oilfield` string |
| 4 | Docks | `docks` string |
| 5 | Base | `base` string |
| 6 | Plain | `plain` string |
| 7 | Forest | `forest` string |
| 8 | Mountain | `mountain` string |
| 9 | Desert | `desert` string |
| 10 | Jungle | `jungle` string |
| 11 | Polar | `polar` string |
| 12 | Wasteland | `wasteland` string |

---

## 15. Side Codes

| Code | Side | Evidence |
|------|------|----------|
| 0x50 | BLUE | String reference; `c350` = 0x50 for Blue |
| 0xc0 | RED | String reference; `c350` = 0xc0 for Red |
| 0x90 | BLUE (inverted) | `c350 ^ 0xc0` — Blue becomes 0x90 |
| 0x30 | RED (inverted) | `c350 ^ 0xc0` — Red becomes 0x30 |

---

## 16. Overlay Memory Layout

| Segment | Functions | Purpose |
|---------|-----------|---------|
| 0x1eb5 | 43 | Overlay/graphics system — sprite loading, rendering |
| 0x259b | 29 | Overlay management — load/unload |
| 0x2541 | 21 | Overlay management — memory allocation |
| 0x2724 | ? | Overlay management — random number / timer |
| 0x2757 | ? | Overlay management |
| 0x27a1 | ? | Overlay management |

---

## 17. Mission Queue Format

The mission queue (at `0x1bc7`) is a circular buffer of up to 50 entries. Each entry is 1 byte (site index). The queue is managed by:

- `FUN_107e_314e(max_entries, fill_value, empty_value)` — initialize queue
- `FUN_107e_319a(entry, value, site_index)` — add entry
- `FUN_107e_322a()` — get next entry (weighted random selection)

Queue entries are site indices (0-99) that represent targets for current missions.

---

## 18. Turn Budget Table

The `turn_budget_table` at `0x2e16` has 10 entries. These control how many turns each side gets per game turn, based on the `local_6` value (which appears to be a "priority" or "action type" code):

| Index | Purpose |
|-------|---------|
| 0 | ? |
| 1 | ? |
| 2 | ? |
| 3 | ? |
| 4 | ? |
| 5 | ? |
| 6 | ? |
| 7 | ? |
| 8 | ? |
| 9 | ? |

---

## 19. Open Questions

The following offsets are referenced but their purpose is unclear:

- `0x3b4`, `0x385` — referenced in FUN_1000_0000
- `0xc42a` — referenced in FUN_1000_0000
- `0xc4b0` — referenced in FUN_1000_0000
- `0xe439` — mission queue, but exact format unclear
- `0xe2bc`, `0xe6da`, `0xe78c`, `0xe8de` — per-site values, purpose unclear
- `0xc3b4`, `0xc3b6`, `0xc3b7`, `0xc3b8`, `0xc3ba` — percentage/progress values
- `0x1bc7` — mission queue base, but exact entry format unclear
- `0xc814` — path generation buffer, 30 bytes
