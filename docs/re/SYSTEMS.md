# SYSTEMS.md — Master Subsystem Map


> **Confidence: LOW (names re-checked 2026-11-09).** The function names in this document came
> from a 2026-10-03 Ghidra pass that resolved addresses with `(segment << 4) | offset`. Above
> offset 15 that OR puts the name on a different function. The rename table has been re-applied
> with `(segment << 4) + offset`, so `docs/ghidra/export/functions.txt` is now right, but every
> claim below that depends on a name (what a function does, what calls what) is low confidence
> until it is re-read against the corrected export.

> **Tracked copy, T-032 Part B (2026-11-25).** This is the first version-controlled copy of
> SYSTEMS.md in the OpenCHQ repo. Every `0x19e` row below is corrected: `0x19e` is the ERA index
> (1918/1942/1986/2023/????), and `0x1a0` is the opponent level 1..5, with 0 = ANOTHER HUMAN
> (docs/re/AI.md section A0, Part A at 40c93cc; PM ruling room 7706). The source copy at
> /mnt/nas/Projects/Command HQ/modern/docs/re/SYSTEMS.md is deliberately NOT edited in place.
> Everything else is a byte copy of that file.

**Source:** `docs/ghidra/export/decompiled.c` (879 functions across 53 segments)
**Last analyzed:** 2026-10-02

---

## 1. Startup / Initialization

**What it does:** Allocates memory, loads overlays, initializes graphics, sound, keyboard, and data files. Enters the main game loop.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_0000` @ `1000:0000` | 473 | Main game loop — reads game state, calls all subsystems |
| `FUN_1000_xxxx` | — | Memory allocation (`Allocated 1Mb of space` string) |
| `FUN_1000_xxxx` | — | Error handlers (`MS Run-Time Library`, `FAR allocation` strings) |

**Evidence:**
- `0x19e` = era index (1918/1942/1986/2023), `0x1476` = current_year, `0x157e` = money, `0x1a0` = opponent level 1..5 — all read at startup. Corrected by T-032 Part A: `0x19e` is the era, not a player count.
- `0xe42e` = game_state — state machine for game phases
- `0xc4ec` = frame_counter — incremented each frame
- `0x3e87` = turn_timer — countdown for each turn
- Memory allocation: `Allocated 1Mb of space`, `FAR allocation for mapbufr failed`, `FAR allocation for solo failed`
- Runtime errors: `MS Run-Time Library - Copyright (c) 1988, Microsoft Corp`, `MS-DOS lied to us about how much memory was available`
- Graphics init: `Error doing graphic init... can't go on`, `ERROR BUILDING SPRITE`
- Data files: `Can't open CBR_DIST.DAT!`, `Can't open TMAP.DAT!`, `Can't open CBR-REGN.DAT!`, `Can't open CBR-SET.DAT!`, `Can't open CBR-TYPE.DT!`, `Can't open C_HQ.REP!`, `Can't open layout!`, `Can't open 'HQ.MAC'!`

**Confidence:** HIGH — `FUN_1000_0000` is clearly the main loop, and the startup sequence is evident from string references and global variable initialization patterns.

---

## 2. Main Game Loop

**What it does:** The central loop that processes each turn: reads input, updates units, runs AI, renders the screen, manages the turn timer, and handles film replay.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_0000` @ `1000:0000` | 473 | Main loop with state machine |

**Evidence:**
- Reads `0xe42e` (game_state), `0xc350` (current_side), `0x157e` (money), `0x3e87` (turn_timer)
- Calls into overlay/graphics, unit management, city/site logic, AI
- `0x1478` = film_mode — when non-zero, enters replay mode
- `0x6df4` = mission_queue_size, `0x6df6` = mission_queue_count — queue for pending actions
- `0x1476` = current_year — incremented each game turn
- `0xe438` — checked before AI turn processing
- `0xe488` — checked during AI turn

**Confidence:** HIGH — this function is the clear central hub.

---

## 3. Input Handling

**What it does:** Processes keyboard, mouse, and joystick input. Maps keys to game actions. Manages sensitivity settings.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_xxxx` | — | Keyboard input (keyboard sensitivity string) |
| `FUN_1000_xxxx` | — | Mouse input (mouse sensitivity string) |
| `FUN_1000_xxxx` | — | Joystick input (joystick sensitivity string, "No joystick found" string) |

**Evidence:**
- `KEYBOARD SENSITIVITY` string
- `MOUSE SENSITIVITY` string
- `JOYSTICK SENSITIVITY` string
- `No joystick found` string
- `Joystick re-centered` string
- `Press key to assign to button` string
- `ASDFGHJKL:`, `ASDFGHJKL;`, `QWERTYUIOP[]`, `^_ZY[`, `^_ZY[]`, `]_^ZY[X` — key binding strings
- `MOVE CURSOR` string
- `Press any key or button to continue.` string

**Confidence:** MEDIUM — input strings are present but specific function addresses need dynamic tracing in DOSBox to confirm.

---

## 4. Map / World Rendering

**What it does:** Renders the Mercator-projected world map. Draws terrain, cities, units, overlays. Manages zoom levels and screen regions.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1eb5_00d8` @ `1eb5:00d8` | — | Sprite rendering — called with (sprite_type, x, y, type) |
| `FUN_1000_xxxx` | — | Map rendering |

**Evidence:**
- `FUN_1eb5_00d8` called with sprite type, x/y coordinates, and type — clearly a sprite blitter
- `OMAP.PIC`, `WORLD.PIC`, `SATLLOB.PIC`, `SHIELDS.PIC`, `UNITS.PIC` — map and overlay images
- `0xc394` = distance_matrix (54×100) — used for terrain checks during rendering
- `0xe814` = site_flags — per-site visibility
- `0xea6e` = site_hostility — per-site hostility for rendering
- `0x130a` + region coords, `0x1346` + region type, `0x1382` + region controller — region rendering
- `0xf5e` + site coords — per-site position
- `0x1006` + site_type — per-site terrain type
- `0x1b6` + unit coords — per-unit position
- `0x286` + unit_type — per-unit type for sprite selection
- `0x906` + unit_status — per-unit status for rendering

**Confidence:** HIGH — `FUN_1eb5_00d8` is clearly a sprite blitter, and the coordinate/data structures are well-defined.

---

## 5. Unit Movement

**What it does:** Handles unit movement across the map. Manages pathfinding, movement costs, terrain restrictions, and movement state flags.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_2da0` @ `107e:2da0` | — | Unit movement — sets destination |
| `FUN_107e_2bac` @ `107e:2bac` | — | Unit movement execution |
| `FUN_107e_2ff4` @ `107e:2ff4` | — | Cancel unit movement |
| `FUN_188b_09d8` @ `188b:09d8` | — | Movement cost calculation |
| `FUN_188b_0018` @ `188b:0018` | — | Terrain check during movement |
| `FUN_188b_00d2` @ `188b:00d2` | — | Terrain type lookup |

**Evidence:**
- `0x1b6` + `i*2` = unit_coords — current position
- `0x426` + `i*2` = unit_dest_x, `0x4f6` + `i` = unit_dest_y — destination
- `0x3650` + `i*2` = unit_flags — bit 10 = moving, bit 9 = at sea, bit 8 = at site
- `0x3588` + `i*2` = unit_current_site — current site index (0xff = at sea)
- `0x906` + `i` = unit_status — bit 7 = active, bits 6:5 = owner, bits 4:0 = subtype
- `0x89e` + `i` = unit_strength — health/strength
- `0xc46` + `i` = unit_misc2 — bit 6 checked for command eligibility
- `0xcae` + `i` = unit_misc_flags — bit 2 = moving
- `0x62e` + `i*2` = unit_target_x, `0x96e` + `i` = unit_target_y — attack target
- `0x55e` + `i*2` = unit_misc1, `0xa3e` + `i` = unit_misc2 — used in terrain checks
- `FUN_188b_09d8` called with (x, y, movement_cost, flag, side) — returns non-zero if path is blocked
- `FUN_188b_0018` called with (x, y) — returns terrain type
- `FUN_188b_00d2` called with (x, y) — returns terrain type (alternative)
- `FUN_107e_0044` called with (x1, y1, x2, y2) — distance calculation
- `FUN_107e_0006` — called after movement, likely updates state

**Confidence:** HIGH — movement logic is well-defined in `FUN_107e_2da0`, `FUN_107e_2bac`, and `FUN_188b_09d8`.

---

## 6. Combat Resolution

**What it does:** Resolves combat between units and sites. Calculates damage based on unit strength, terrain, distance, and odds. Handles air strikes, naval bombardment, coastal defense, and nuclear attacks.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_336a` @ `107e:336a` | 1179 | Combat resolution — main combat function |
| `FUN_107e_380e` @ `107e:380e` | 557 | Combat execution |
| `FUN_107e_4266` @ `107e:4266` | 702 | Combat calculation |
| `FUN_107e_4b94` @ `107e:4b94` | 136 | Combat damage calculation |
| `FUN_107e_4c1c` @ `107e:4c1c` | 396 | Combat targeting |
| `FUN_107e_4dac` @ `107e:4dac` | 733 | Combat path generation |

**Evidence:**
- `FUN_107e_336a` (1179 bytes) — the largest function in segment 0x107e, processes combat missions
- `FUN_107e_380e` (557 bytes) — executes combat actions
- `FUN_107e_4266` (702 bytes) — calculates combat outcomes
- `FUN_107e_4b94` (136 bytes) — calculates damage based on distance and strength
- `FUN_107e_4c1c` (396 bytes) — selects targets for combat
- `FUN_107e_4dac` (733 bytes) — generates combat paths
- `0x89e` + `i` = unit_strength — compared to 0x50, 0x3d for combat eligibility
- `0xe2ae` — left-shifted, used in combat modifier
- `0xe7fa` — set to 0, used as combat modifier
- `0xe6da` and `0xe78c` — compared in combat calculation
- `0xe2bc` — compared against `e78c` in combat
- Combat strings: `Air strike`, `Enemy plane shot down`, `Our plane shot down`, `Enemy carrier spotted`, `Our carrier engaged`, `Enemy sub spotted`, `Our sub engaged`, `Enemy city bombed`, `Our city bombed`, `Enemy oil site bombed`, `Our oil site bombed`, `Enemy provocation forced us to fight!`, `Our warmonger enemy has broken the peace!`, `Enemy doing intel scan`, `Conducting intelligence scan`, `Intel Scan`, `Satellite killer just launched!`, `Killer satellite exploded`, `Recon satellite killed`, `A recon satellite fell from orbit`, `The enemy got a crony`, `The enemy took`, `We gained an ally`, `We liberated`, `We repelled an air mission`, `Our missile crews won't fire`, `Paratroops dropped`, `Not a parachute site`, `Friendly waters only`, `Ships must stay at sea.`, `Must be on mainland`, `Must be placed in city`, `Must be placed on dock`, `Not on a dock`, `Can't air transport`, `air missions during war only`, `Only during war`, `Capital protected by abm system`, `hit by coastal`, `pinned`, `short of fuel`, `no fuel`, `Not enough money.`, `Too far`, `Too near enemy`, `Path not found`, `Unit Path`, `Units' Destinations`, `No target selected`, `Unknown unit`, `Not our unit.`, `Done with transfer of`, `Transfering unit`, `Previous command discarded`, `Not available`, `Unknown command`, `Unknown media type`

**Confidence:** HIGH — combat logic is clearly in `FUN_107e_336a` and related functions.

---

## 7. Economy / Money

**What it does:** Manages player money, income, costs of units, foreign aid, and economic modifiers.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_3bd0` @ `107e:3bd0` | 1230 | Economy and AI turn management |
| `FUN_107e_xxxx` | — | Cost calculation |

**Evidence:**
- `0x157e` = money — player's current funds
- `Money -` string, `Money` string — UI strings
- `Balance:` string — balance display
- `Income:` string — income display
- `Foreign Aid` string, `Foreign aid blocked` string — foreign aid mechanics
- `Designating foreign aid recipient` string
- `Placing New Purchase` string, `Purchase New Units` string — purchase UI
- `Not enough money.` string
- `STARTING MONEY` string
- `(billion)` string — money unit
- `(bil$)` string — money abbreviation
- `0x148e` — divided by 40 for turn pacing, likely income-related
- `0xc3b6`, `0xc3b7`, `0xc3b8`, `0xc3ba` — percentage calculations for economy
- `0x2e16` = turn_budget_table — 10 entries, controls turn pacing

**Confidence:** MEDIUM — economy is clearly present but specific cost formulas need more analysis.

---

## 8. Production / Build

**What it does:** Allows players to purchase new units. Manages unit types, costs, and placement restrictions.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_3bd0` @ `107e:3bd0` | 1230 | Production and purchase logic |
| `FUN_107e_4140` @ `107e:4140` | 177 | Unit placement validation |
| `FUN_107e_41f2` @ `107e:41f2` | 114 | Unit type matching |

**Evidence:**
- `Placing New Purchase` string
- `Purchase New Units` string
- `Not enough money.` string
- `Must be placed in city` string
- `Must be placed on dock` string
- `Must be on mainland` string
- `Friendly waters only` string
- `Ships must stay at sea.` string
- `Can't air transport` string
- `air missions during war only` string
- `Only during war` string
- `Not a parachute site` string
- Unit type codes (0-17) with associated sprites
- `0x286` + `i` = unit_type — unit type for purchased units
- `0x836` + `i` = unit_owner — owner of purchased units

**Confidence:** MEDIUM — production logic is present but intertwined with economy.

---

## 9. AI Opponent

**What it does:** Controls AI opponent behavior. Manages AI decision-making, turn pacing, and difficulty levels.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_336a` @ `107e:336a` | 1179 | AI turn processing |
| `FUN_107e_380e` @ `107e:380e` | 557 | AI combat execution |
| `FUN_107e_3bd0` @ `107e:3bd0` | 1230 | AI economy and turn management |
| `FUN_107e_4266` @ `107e:4266` | 702 | AI target selection |
| `FUN_107e_4b94` @ `107e:4b94` | 136 | AI combat damage |
| `FUN_107e_4c1c` @ `107e:4c1c` | 396 | AI targeting |
| `FUN_107e_4dac` @ `107e:4dac` | 733 | AI path generation |
| `FUN_107e_3b5e` @ `107e:3b5e` | 112 | AI scoring |
| `FUN_107e_3a40` @ `107e:3a40` | 282 | AI unit selection |
| `FUN_107e_03e8` @ `107e:03e8` | — | AI decision making |
| `FUN_107e_0044` @ `107e:0044` | — | AI distance calculation |
| `FUN_107e_0006` @ `107e:0006` | — | AI state update |
| `FUN_107e_2da0` @ `107e:2da0` | — | AI movement |
| `FUN_107e_2bac` @ `107e:2bac` | — | AI execution |
| `FUN_107e_452a` @ `107e:452a` | 124 | AI site search |
| `FUN_107e_45a8` @ `107e:45a8` | 109 | AI site selection |
| `FUN_107e_4616` @ `107e:4616` | 1401 | AI command processing |
| `FUN_107e_543a` @ `107e:543a` | — | AI validation |
| `FUN_107e_54b0` @ `107e:54b0` | — | AI scoring |

**Evidence:**
- `SGT. STAN STIL` — AI personality name
- `GEN. WIN MOORE` — AI personality name
- `COL. BUCK ZEAL` — AI personality name
- `MARS GOD OF WAR` — AI difficulty/personality
- `Cold War` string — game scenario
- `OPPONENT OPTIONS:` string — AI settings
- `OPPONENT'S` string — AI reference
- `AI` string — AI reference
- `Opponent picking game` string
- `Opponent picking side` string
- `Opponent ready...` string
- `Waiting for opponent...` string
- `Opponent disconnecting...` string
- `Opponent resigned` string
- `We resigned` string
- `Do you want to resign? (y/n)` string
- `Abort without saving? y/n` string
- `Ready at` string — AI readiness
- `Speed set by opponent` string
- `0xdb02` — multiplayer flag, affects AI timing
- `0x19e` — era index (1918/1942/1986/2023), not player count; `0x1a0` — opponent level 1..5 (0 = ANOTHER HUMAN), affects AI behavior. Corrected by T-032 Part A.
- `0xe438` — checked before AI turn

**Confidence:** HIGH — AI logic is well-defined in `FUN_107e_336a`, `FUN_107e_3bd0`, and `FUN_107e_4616`.

---

## 10. Save / Load

**What it does:** Saves and loads game state, layouts, and film replays. Handles BLO/REP/RLO file formats.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | Save/load logic |

**Evidence:**
- `SAVE GAME` string, `LOAD GAME` string
- `SAVE BLUE LAYOUT` string, `LOAD BLUE LAYOUT` string
- `SAVE RED LAYOUT` string, `LOAD RED LAYOUT` string
- `SAVE FILM` string, `LOAD FILM` string, `LOAD A FILM` string, `SAVE A FILM` string
- `WATCH A FILM` string
- `WAR FILM` string
- `Film changed to game` string
- `Film paused...` string
- `Replay ended` string
- `NO FILM IN MEMORY` string
- `NO ROOM FOR FILM` string
- `ABORTED SAVE` string
- `Save not possible. Sorry.` string
- `Saved.` string, `Saved ` string
- `Loaded ` string
- `C_HQ.REP` — save file format
- `xxCHQ-12.rep` — save file format
- `c_hq.rep` — save file format (lowercase)
- `HQLAYOUT.` — layout file format
- `LAYOUT ARMIES` string
- `new layout (F2 when done)` string
- `DELETE` string
- `Press 'Delete' to delete file` string
- `FILE NOT FOUND` string
- `FILENAME NOT FOUND` string
- `CAN'T OPEN SOURCE FILE` string
- `CAN'T OPEN DESTINATION FILE` string
- `FILE TRANSFER UTILITY` string
- `FILE UTILITY` string
- `Transferring file:` string
- `files found.` string, `No files found` string
- `DISK ERROR:` string
- `CRITICAL DISK ERROR` string
- `Bad FAT` string
- `Read fault` string
- `Write fault` string
- `FSEEK ERROR` string
- `ERROR FINDING POSITION IN FILE` string
- `ERROR GETTING SOURCE FILE SIZE` string
- `OVERLAY LOAD FAILED` string
- `OVERLAY HAS OVERRUN ALLOCATED MEMORY` string
- `OVERLAY MEMORY BLOCK ADDRESS INVALID` string
- `OVERLAY CANNOT SHRINK OVERLAY MEMORY ALLOCATION` string
- `OVERLAY UNABLE TO SHRINK OVERLAY MEMORY ALLOCATION` string
- `OVERLAY RELEASING OVERLAY MEMORY` string
- `OVERLAY ERROR` string
- `OVERLAY REASON` string
- `OVERLAY REASON` string

**Confidence:** MEDIUM — save/load strings are clear but specific function addresses need more analysis.

---

## 11. Modem / Serial Multiplayer

**What it does:** Handles serial modem and LAN multiplayer connections. Manages packet sync, host/client selection, and turn synchronization.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_3bd0` @ `107e:3bd0` | 1230 | Multiplayer turn management |
| `FUN_107e_xxxx` | — | Serial communication |
| `FUN_107e_xxxx` | — | LAN communication |

**Evidence:**
- `COMMUNICATION MODE` string
- `CONNECT OPTIONS:` string
- `NETWORK/LAN` string
- `MODEM/PHONE` string
- `DIRECT SERIAL` string
- `AT&T5&T0` string — modem init
- `ATE0V1Q0X0` — modem init
- `ATS0=0S2=43S12=50` — modem init
- `ATS7=30S9=6S10=50` — modem init
- `MODEM.INI` — modem configuration file
- `NETWORK.OVL` — network overlay
- `SERIAL.OVL` — serial overlay
- `packet error` string
- `OUT of SYNCH` string
- `RE-SYNCH` string, `Sending RE-SYNCH...` string, `Receiving RE-SYNCH...` string
- `Testing Sync` string
- `Connected` string
- `connection failed` string
- `Disconnecting...` string
- `Opponent disconnecting...` string
- `Opponent picked: ` string
- `Opponent picking game` string
- `Opponent picking side` string
- `Opponent ready...` string
- `Waiting for opponent...` string
- `Telling opponent...` string
- `Opponent saving game` string
- `Changed to 2 player game` string
- `ANOTHER HUMAN` string
- `0xdb02` — multiplayer flag
- `0x19e` — era index (T-032 Part A corrected the old "player count (up to 4)" label). The player-count address for this section is UNVERIFIED.

**Confidence:** HIGH — multiplayer protocol is well-defined from string evidence.

---

## 12. Graphics / EGA Blitting

**What it does:** Handles EGA graphics rendering. Loads and displays sprites, manages overlays, and handles screen updates.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1eb5_00d8` @ `1eb5:00d8` | — | Sprite rendering (called with type, x, y, subtype) |
| `FUN_1eb5_xxxx` | — | Graphics system (43 functions in segment 0x1eb5) |

**Evidence:**
- `FUN_1eb5_00d8` called with (sprite_type, x, y, subtype) — clearly a sprite blitter
- `ERROR BUILDING SPRITE` string
- `SPRITE BOTTOM - %4x` string
- `SPRITE NUMBER - %4x` string
- `SPRITE TOP - %4x` string
- `ERROR doing graphic init... can't go on.` string
- `Unknown media type` string
- `HQLAYOUT.` — layout files
- `HQANIMS` — animation directory
- `HQFLAGS` — flags directory
- `HQGRAPHICS` — graphics directory
- `HQSOUND` — sound directory
- `*.PAN` — sprite files (50+ sprite files)
- `*.PIC` — map/overlay images (5+ image files)
- `0xc4ec` = frame_counter — frame timing
- `0xc4ea`, `0xc6f0`, `0xc704`, `0xc706`, `0xc7ac`, `0xc7ae` — graphics state

**Confidence:** HIGH — graphics system is clearly in segment 0x1eb5 with `FUN_1eb5_00d8` as the core blitter.

---

## 13. Sound / AdLib-Roland-Tandy

**What it does:** Handles sound output via AdLib, Roland MT-32, Tandy, and IBM PC speaker. Manages music and sound effects.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_xxxx` | — | Sound initialization |
| `FUN_1000_xxxx` | — | Sound playback |

**Evidence:**
- `SOUND.DRV` — sound driver
- `ADLIB.DRV` — AdLib driver
- `ROLAND.DRV` — Roland driver
- `TANDY.DRV` — Tandy driver
- `IBM.DRV` — IBM PC Speaker driver
- `THEMEIBM.SNG` — IBM theme song
- `can't open music file` string
- `not enough memory for music` string
- `sound is turned off` string
- `VOLUME` string
- `Unknown media type` string
- `HQSOUND` — sound directory

**Confidence:** MEDIUM — sound driver strings are present but specific function addresses need more analysis.

---

## 14. Diplomacy

**What it does:** Manages cease-fire agreements, alliances, and diplomatic relations between players.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | Diplomacy logic |

**Evidence:**
- `Cease fire` string
- `Do you want a cease fire? (y/n)` string
- `No cease fire` string
- `changed alignment` string
- `We gained an ally` string
- `We liberated` string
- `We repelled an air mission` string
- `We triumphed over villainy!` string
- `Our noble quest was lost!` string
- `Enemy threatening` string
- `Enemy provocation forced us to fight!` string
- `Our warmonger enemy has broken the peace!` string
- `Only during war` string
- `air missions during war only` string

**Confidence:** MEDIUM — diplomacy strings are present but specific function addresses need more analysis.

---

## 15. Satellite System

**What it does:** Manages spy satellites, killer satellites, and ABM (anti-ballistic missile) defense.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | Satellite logic |

**Evidence:**
- `KILLSAT.PAN` — killer satellite sprite
- `SPYSAT.PAN` — spy satellite sprite
- `BLOWSAT.PAN` — blow satellite sprite
- `NUKE.PAN` — nuclear sprite
- `Satellite killer just launched!` string
- `Killer satellite exploded` string
- `Recon satellite killed` string
- `A recon satellite fell from orbit` string
- `They launched a new recon satellite` string
- `Satellites` string
- `Satl Killer` string
- `Setting Satellite Destination` string
- `Targeting satellite killer` string
- `Capital protected by abm system` string
- `Nuclear winter` string
- Unit types: killsat (8), spysat (9), blowsat (10), nuke (11)

**Confidence:** HIGH — satellite system is well-defined from unit types and string evidence.

---

## 16. Film / Replay System

**What it does:** Records and replays game events. Manages film storage and playback.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | Film recording/playback |

**Evidence:**
- `SAVE FILM` string, `LOAD FILM` string
- `WATCH A FILM` string
- `WAR FILM` string
- `Film changed to game` string
- `Film paused...` string
- `Replay ended` string
- `NO FILM IN MEMORY` string
- `NO ROOM FOR FILM` string
- `0x1478` = film_mode — non-zero during replay
- `C_HQ.REP` — replay file format
- `xxCHQ-12.rep` — replay file format
- `Game Paused...(Alt-P to resume)` string
- `Game resumes` string
- `Game resumes without film` string
- `Game ended` string

**Confidence:** HIGH — film system is well-defined from strings and `0x1478` flag.

---

## 17. Pathfinding

**What it does:** Calculates movement paths between locations. Handles terrain restrictions and movement costs.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_188b_09d8` @ `188b:09d8` | — | Path cost calculation |
| `FUN_188b_0018` @ `188b:0018` | — | Terrain check |
| `FUN_188b_00d2` @ `188b:00d2` | — | Terrain lookup |
| `FUN_188b_0472` @ `188b:0472` | — | Satellite targeting |
| `FUN_188b_xxxx` | — | Pathfinding (23 functions in segment 0x188b) |

**Evidence:**
- `Path not found` string
- `Unit Path` string
- `Units' Destinations` string
- `Too far` string
- `Too near enemy` string
- `No target selected` string
- `0xc394` = distance_matrix (54×100) — used for terrain checks
- `FUN_188b_09d8` called with (x, y, movement_cost, flag, side) — returns non-zero if blocked
- `FUN_188b_0018` called with (x, y) — returns terrain type
- `FUN_188b_00d2` called with (x, y) — returns terrain type (alternative)
- `FUN_188b_0472` called with (site_index, cost, flag) — satellite targeting
- `TMAP.DAT` — terrain map data (movement rules)

**Confidence:** HIGH — pathfinding is clearly in segment 0x188b with `FUN_188b_09d8` as the core function.

---

## 18. Timer / Turn Management

**What it does:** Manages turn timers, game speed, and pause/resume functionality.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_0000` @ `1000:0000` | 473 | Main loop with timer |
| `FUN_107e_xxxx` | — | Turn management |

**Evidence:**
- `0x3e87` = turn_timer — countdown for each turn
- `0xc4ec` = frame_counter — frame timing
- `0x1476` = current_year — game year counter
- `0x1478` = film_mode — film replay mode
- `Game Paused...(Alt-P to resume)` string
- `Game resumes` string
- `Game resumes without film` string
- `Game ended` string
- `speed set by opponent` string
- `PAUSE` string
- `> RESUME` string
- `Speed` string
- `Time left` string

**Confidence:** HIGH — timer system is well-defined from global variables and strings.

---

## 19. Menu / Options

**What it does:** Manages game menus, options dialogs, and configuration screens.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_xxxx` | — | Menu system |

**Evidence:**
- `MAIN OPTIONS:` string
- `SIDE OPTIONS:` string
- `CONNECT OPTIONS:` string
- `OPPONENT OPTIONS:` string
- `CRISIS OPTIONS:` string
- `layouts` string
- `VOLUME` string
- `KEYBOARD SENSITIVITY` string
- `MOUSE SENSITIVITY` string
- `JOYSTICK SENSITIVITY` string
- `Press key to assign to button` string
- `ASDFGHJKL:`, `ASDFGHJKL;`, `QWERTYUIOP[]` — key binding strings
- `^_ZY[`, `^_ZY[]`, `]_^ZY[X` — key binding strings
- `MOVE CURSOR` string

**Confidence:** MEDIUM — menu strings are present but specific function addresses need more analysis.

---

## 20. Pre-game Setup

**What it does:** Manages the initial game setup screen where players select side, difficulty, and game parameters.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1000_xxxx` | — | Setup logic |

**Evidence:**
- `Pre-game Setup` string
- `START A NEW WAR` string
- `RESUME SAVED WAR` string
- `STARTING MONEY` string
- `Balance:` string
- `Income:` string
- `Money` string
- `Money -` string
- `0x157e` = money — starting money
- `0x19e` = era index — 1918/1942/1986/2023, not player count (T-032 Part A); `0x1a0` = opponent level 1..5
- `0x1476` = current_year — starting year
- `0xc350` = current_side — selected side
- `BLUE` string, `RED` string — side selection
- `1918`, `1942`, `1986`, `2023`, `????` — era selection
- `CUSTOM` string — custom setup
- `STANDARD` string — standard setup
- `RESTART` string, `RESTART PROGRAM? Y/N` string
- `QUIT TO DOS? Y/N` string
- `EXIT TO DOS` string

**Confidence:** HIGH — pre-game setup is well-defined from strings and global variables.

---

## 21. Message System

**What it does:** Manages the in-game message log. Displays combat results, diplomatic events, and other notifications.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | Message system |

**Evidence:**
- `MSG` string
- `<<NMSG>>` string
- `message level` string
- `Enemy carrier spotted in the` string
- `Enemy city bombed` string
- `Enemy oil site bombed` string
- `Enemy plane shot down` string
- `Enemy sub spotted in the` string
- `Enemy threatening` string
- `Enemy provocation forced us to fight!` string
- `Our city bombed` string
- `Our oil site bombed` string
- `Our plane shot down` string
- `Our sub engaged in the` string
- `Our carrier engaged in the` string
- `Our ship hit by coastal fire` string
- `Our warmonger enemy has broken the peace!` string
- `We gained an ally` string
- `We liberated` string
- `We repelled an air mission` string
- `We triumphed over villainy!` string
- `We resigned` string
- `Our noble quest was lost!` string
- `Our missile crews won't fire` string
- `Our air mission failed` string
- `Satellite killer just launched!` string
- `Killer satellite exploded` string
- `Recon satellite killed` string
- `A recon satellite fell from orbit` string
- `They launched a new recon satellite` string
- `The enemy got a crony` string
- `The enemy took` string
- `We discovered` string
- `Foreign Aid` string
- `Foreign aid blocked` string
- `Foreign territory.` string
- `Intel Scan` string
- `Conducting intelligence scan` string
- `Enemy doing intel scan` string
- `paratroops dropped` string
- `Not a parachute site` string
- `Friendly waters only` string
- `Ships must stay at sea.` string
- `Must be on mainland` string
- `Must be placed in city` string
- `Must be placed on dock` string
- `Not on a dock` string
- `Can't air transport` string
- `air missions during war only` string
- `Only during war` string
- `Capital protected by abm system` string
- `hit by coastal` string
- `pinned` string
- `short of fuel` string
- `no fuel` string
- `Not enough money.` string
- `Too far` string
- `Too near enemy` string
- `Path not found` string
- `Unit Path` string
- `Units' Destinations` string
- `No target selected` string
- `Unknown unit` string
- `Not our unit.` string
- `Done with transfer of` string
- `Transfering unit` string
- `Previous command discarded` string
- `Not available` string
- `Unknown command` string
- `Unknown media type` string

**Confidence:** HIGH — message system is well-defined from extensive string evidence.

---

## 22. Unit Management

**What it does:** Manages unit creation, deletion, status, and type assignment.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_2dfc_xxxx` | — | Unit management (48 functions in segment 0x2dfc) |

**Evidence:**
- `0x1b6` + `i*2` = unit_coords — current position
- `0x286` + `i` = unit_type — unit type code
- `0x906` + `i` = unit_status — active/owner/subtype
- `0x89e` + `i` = unit_strength — health/strength
- `0x836` + `i` = unit_owner — owner index
- `0x426` + `i*2` = unit_dest_x — destination X
- `0x4f6` + `i` = unit_dest_y — destination Y
- `0x62e` + `i*2` = unit_target_x — attack target X
- `0x96e` + `i` = unit_target_y — attack target Y
- `0x55e` + `i*2` = unit_misc1 — terrain check
- `0xa3e` + `i` = unit_misc2 — terrain check
- `0x3588` + `i*2` = unit_current_site — current site
- `0x3650` + `i*2` = unit_flags — movement flags
- `0xc46` + `i` = unit_misc2 — command eligibility
- `0xcae` + `i` = unit_misc_flags — moving flag
- `Too many units` string
- `Unknown unit` string
- `Not our unit.` string
- `Unit Path` string
- `Units' Destinations` string

**Confidence:** HIGH — unit management is clearly in segment 0x2dfc with 48 functions.

---

## 23. City / Site Management

**What it does:** Manages cities, sites, and their properties. Handles city bombing, oilfield destruction, and site status.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_107e_xxxx` | — | City/site logic (53 functions in segment 0x107e) |

**Evidence:**
- `0xf5e` + `i*2` = site_coords — position
- `0x1006` + `i` = site_type — terrain type
- `0x1102` + `i` = site_active — active/owner/subtype
- `0x10ae` + `i` = site_readiness_countdown — `0` -> `15` on capture, decays 1 a round (PB-155 DOSBox read; 9178 writes 15, 4856-4862 decrements over 64 slots). Not a name index: the old `site_name_offset` label is retired, and `FUN_1000_0000` has no `0x10ae` read (see `AI.md` §9.1); **where a site's name is stored in the record is UNVERIFIED**
- `0xcae` + `i` = site_misc_flags — moving flag
- `0xcb46` + `i` = site_region — region index
- `0xc46` + `i` = site_misc2 — command eligibility
- `0xe814` + `i` = site_flags — visibility/selection/hostility
- `0xea6e` + `i` = site_hostility — hostility value
- `0xe8de` + `i` = site_misc — combat value
- `0xe6da` + `i` = site_misc — combat modifier
- `0xe78c` + `i` = site_misc — combat modifier
- `0xe2bc` + `i` = site_misc — combat modifier
- `0x130a` + `i*2` = region_coords — region position
- `0x1346` + `i` = region_type — region terrain type
- `0x1382` + `i` = region_controller — region owner
- `0x13a0` + `i` = region_flags — region flags
- `0x1364` + `i` = region_active — region active flag
- City names: Washington, Moscow, London, Paris, Berlin, Tokyo, Beijing, Cairo, New York, Los Angeles, Chicago, Houston, Denver, Boston, Atlanta, Detroit, Seattle, St Louis, Toronto, Mexico City, Caracas, Rio de Janeiro, Havana, Buenos Aires, Madrid, Lisbon, Rome, Warsaw, Prague, Budapest, Vienna, Stockholm, Oslo, Copenhagen, Helsinki, Leningrad, Gorkiy, Novosibirsk, Kharkov, Smolensk, Sevastopol, Archangel, Istanbul, Jerusalem, Tehran, Baghdad, Riyadh, Khartoum, Johannesburg, Lagos, Nairobi, Dakar, Algiers, Casablanca, Bamako, Timbuktu, Mogadishu, Addis Ababa, Mombasa, Dar es Salaam, Kinshasa, Brazzaville, Luanda, Windhoek, Maputo, Beira, Lourenco Marques, Durban, Port Elizabeth, Cape Town, Bloemfontein, Pretoria, Salisbury, Lusaka, Ndola, Kitwe, Zanzibar, Mombasa, Nairobi, Kampala, Dodoma, Arusha, Mogadishu, Hargeisa, Berbera, Bosaso, Kismayo, Merca, Brava, Barawa, Marka, Afgooye, Beledweyne, Jowhar, Baidoa, Bardera, Kismayo, Luanda, Benguela, Lobito, Namibe, Moçâmedes, Huambo, Kuito, Cabinda, Soyo, N'zeto, M'banza-Kongo, Malanje, Uíge, Luena, Lichinga, Nampula, Quelimane, Tete, Chimoio, Manica, Beira, Inhambane, Xai-Xai, Matola, Marracuene, Boane, Manhiça, Moamba, Namaacha, Matutuíne, Chókwè, Govuro, Machanga, Pebane, Chókwè
- Region names: USA, USSR, W Germany, E Germany, Poland, Czechoslovakia, Hungary, Romania, Bulgaria, Yugoslavia, Albania, Greece, Turkey, Iran, Iraq, Saudi Arabia, Libya, Egypt, Syria, Israel, Jordan, Lebanon, Yemen, Oman, UAE, Qatar, Bahrain, Kuwait, Pakistan, India, Bangladesh, Burma, Thailand, Vietnam, Laos, Cambodia, Malaysia, Indonesia, Philippines, Japan, South Korea, North Korea, China, Mongolia, Afghanistan, Nepal, Bhutan, Sri Lanka, Maldives, Myanmar, Papua New Guinea, Australia, New Zealand, Canada, Mexico, Cuba, Haiti, Dominican Republic, Jamaica, Trinidad, Barbados, Guyana, Suriname, French Guiana, Ecuador, Peru, Bolivia, Paraguay, Uruguay, Chile, Argentina, Brazil, Venezuela, Colombia, Panama, Costa Rica, Nicaragua, Honduras, El Salvador, Guatemala, Belize, Honduras, El Salvador, Guatemala, Belize
- `capital` string, `city` string, `oilfield` string, `docks` string, `base` string, `ocean` string, `plain` string, `forest` string, `mountain` string, `desert` string, `jungle` string, `polar` string, `wasteland` string
- `Enemy city bombed` string, `Our city bombed` string
- `Enemy oil site bombed` string, `Our oil site bombed` string
- `An oilfield in` string
- `a capital` string, `a city` string, `a base` string
- `Occupied!` string
- `Foreign territory.` string
- `Capital protected by abm system` string

**Confidence:** HIGH — city/site management is clearly in segment 0x107e with 53 functions.

---

## 24. Overlay System

**What it does:** Manages overlay loading/unloading. Handles memory allocation for overlays and sprite rendering.

**Candidate functions:**
| Address | Size | Evidence |
|---------|------|----------|
| `FUN_1eb5_xxxx` | — | Overlay/graphics system (43 functions in segment 0x1eb5) |
| `FUN_259b_xxxx` | — | Overlay management (29 functions in segment 0x259b) |
| `FUN_2541_xxxx` | — | Overlay memory (21 functions in segment 0x2541) |

**Evidence:**
- `OVERLAY LOAD FAILED` string
- `OVERLAY HAS OVERRUN ALLOCATED MEMORY` string
- `OVERLAY MEMORY BLOCK ADDRESS INVALID` string
- `OVERLAY CANNOT SHRINK OVERLAY MEMORY ALLOCATION` string
- `OVERLAY UNABLE TO SHRINK OVERLAY MEMORY ALLOCATION` string
- `OVERLAY RELEASING OVERLAY MEMORY` string
- `OVERLAY ERROR` string
- `OVERLAY REASON` string
- `FAR allocation for mapbufr failed` string
- `FAR allocation for solo failed` string
- `cannot shrink overlay memory allocation` string
- `Unable to shrink overlay memory allocation` string
- `Error releasing overlay memory` string
- `Overlay has overrun allocated memory` string
- `Overlay load failed for some reason` string
- `not enough memory for music` string
- `not enough memory was available` string
- `INSUFFICIENT MEMORY` string
- `Out of memory.` string
- `Not enough core` string
- `Not enough memory to load file` string
- `Not enough memory for music` string
- `program loaded at %8lx` string

**Confidence:** HIGH — overlay system is clearly in segments 0x1eb5, 0x259b, and 0x2541.

---

## Summary Table

| Subsystem | Primary Segment(s) | Functions | Confidence |
|-----------|-------------------|-----------|------------|
| Startup/Initialization | 0x1000 | 10 | HIGH |
| Main Game Loop | 0x1000 | 10 | HIGH |
| Input Handling | 0x1000 | — | MEDIUM |
| Map/World Rendering | 0x1eb5 | 43 | HIGH |
| Unit Movement | 0x107e, 0x188b | 23+ | HIGH |
| Combat Resolution | 0x107e | 53 | HIGH |
| Economy/Money | 0x107e | 53 | MEDIUM |
| Production/Build | 0x107e | 53 | MEDIUM |
| AI Opponent | 0x107e | 53 | HIGH |
| Save/Load | 0x107e | 53 | MEDIUM |
| Modem/Serial Multiplayer | 0x107e | 53 | HIGH |
| Graphics/EGA Blitting | 0x1eb5 | 43 | HIGH |
| Sound/AdLib-Roland-Tandy | 0x1000 | — | MEDIUM |
| Diplomacy | 0x107e | 53 | MEDIUM |
| Satellite System | 0x107e | 53 | HIGH |
| Film/Replay System | 0x107e | 53 | HIGH |
| Pathfinding | 0x188b | 23 | HIGH |
| Timer/Turn Management | 0x1000 | 10 | HIGH |
| Menu/Options | 0x1000 | — | MEDIUM |
| Pre-game Setup | 0x1000 | 10 | HIGH |
| Message System | 0x107e | 53 | HIGH |
| Unit Management | 0x2dfc | 48 | HIGH |
| City/Site Management | 0x107e | 53 | HIGH |
| Overlay System | 0x1eb5, 0x259b, 0x2541 | 93 | HIGH |
