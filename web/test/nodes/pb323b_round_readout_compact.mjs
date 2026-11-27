// pb323b_round_readout_compact — the strip's painted form and the safety ladder.
//
// Why: PB-323 fixed the 1942 line and its page leg launched 1942 only, so the 3-wide 1986 line was
// never sampled. Measured on 30a4275 (frodo 10324 §1, game's probes): "1986 · blue · round 0 · held ·
// cold war, war may resume" is 318.88 px of text in a 269 px box at 1024x768, so the last clause is
// cut mid-word. PB-323b implements the PM's card rule (10334 §2) and a suffix-only safety ladder.
//
// This test pins the RULE, not a pixel width: the browser leg (tests/e2e/pb323-round-readout.mjs)
// pins the fit. What must never move here:
//   1. the default call (no opts) is the full sentence, byte for byte - the title is built from it,
//      and every node pin that predates this change reads it;
//   2. era, side ("blue", never "B"), "round N" and the clock word are painted at every width and
//      every tier - the head is mandatory (10334 §2);
//   3. cold war paints short at every width; the full suffix is in the title;
//   4. cease-fire paints the count over 1100 px and the condition only at 1100 and below, where the
//      count lives in the title (PB-245's counter moved, not dropped);
//   5. the ladder only shortens the suffix, and an out-of-range tier clamps.

import { STRIP_CEASEFIRE_WIDTH, STRIP_TIER_MAX, stripInfo, stripInfoParts } from "../../public/shell.mjs";

export const name = "pb323b_round_readout_compact";

function fail(message) {
  throw new Error("node test pb323b_round_readout_compact: " + message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) fail(label);
}

const TIERS = Array.from({ length: STRIP_TIER_MAX + 1 }, (_, i) => i);
const WIDTHS = [1440, 1280, 1024, 800];
const texts = (room, opts = {}) => stripInfoParts(room, opts).map((part) => part.text);
const painted = (room, width, tier = 0) => stripInfo(room, { width, tier });

function war1986(extra = {}) {
  return {
    mode: "bot",
    era: "1986",
    you: "blue",
    round: 0,
    clock: "held",
    speed: 1,
    peace: { active: true, remaining: 0, coldWar: true },
    ...extra,
  };
}

function ceaseFire(extra = {}) {
  return war1986({ round: 12, clock: "running", peace: { active: true, remaining: 3, coldWar: false }, ...extra });
}

function over1986() {
  return {
    mode: "bot",
    era: "1986",
    you: "blue",
    round: 12,
    clock: "running",
    speed: 1,
    over: true,
    winner: "blue",
    result: { lastCapital: { name: "Moscow", round: 12 } },
  };
}

export async function run() {
  // ---- 1. the default is the full sentence, byte for byte --------------------------------
  {
    eq(stripInfo(war1986()), "1986 · blue · round 0 · held · cold war, war may resume", "the full 1986 line");
    eq(stripInfo(ceaseFire()), "1986 · blue · round 12 · running · cease-fire, 3 rounds left", "the full cease-fire line");
    eq(stripInfo(over1986()), "1986 · blue · round 12 · running · blue won (Moscow, round 12)", "the full win line");
    eq(stripInfo({ mode: "layout", era: "1986", you: "blue", round: 0, clock: "held", peace: war1986().peace }),
      "1986 · blue · layout · round 0 · held", "the layout line");
  }

  // ---- 2. the head is painted in full at every width and every tier -----------------------
  for (const [label, room] of [["war", war1986()], ["cease-fire", ceaseFire()], ["win-over", over1986()],
    ["Concealed", war1986({ era: "9999", round: 12, clock: "running", peace: null })],
  ]) {
    for (const width of WIDTHS) {
      for (const tier of TIERS) {
        const parts = texts(room, { width, tier });
        const head = label === "Concealed" ? "Concealed" : "1986";
        eq(parts[0], head, label + " @" + width + " t" + tier + ": era");
        eq(parts[1], "blue", label + " @" + width + " t" + tier + ": side is painted in full");
        ok(parts.includes("round " + room.round), label + " @" + width + " t" + tier + ": round number");
        ok(parts.includes(room.clock), label + " @" + width + " t" + tier + ": clock word");
        ok(parts.findIndex((p) => /^round /.test(p)) < parts.indexOf(room.clock),
          label + " @" + width + " t" + tier + ": round precedes the clock word");
      }
    }
  }

  // ---- 3. cold war: painted short at every width, full suffix in the title ----------------
  for (const width of WIDTHS) {
    eq(painted(war1986(), width), "1986 · blue · round 0 · held · cold war", "cold war @" + width);
    ok(/cold war, war may resume/.test(stripInfo(war1986())), "the title keeps the cold-war suffix @" + width);
  }

  // ---- 4. cease-fire: count over 1100, condition only at 1100 and below -------------------
  ok(STRIP_CEASEFIRE_WIDTH === 1100, "the ruled width is 1100");
  eq(painted(ceaseFire(), 1440), "1986 · blue · round 12 · running · cease-fire, 3 rounds left", "cease-fire @1440");
  eq(painted(ceaseFire(), 1280), "1986 · blue · round 12 · running · cease-fire, 3 rounds left", "cease-fire @1280");
  eq(painted(ceaseFire(), 1100), "1986 · blue · round 12 · running · cease-fire", "cease-fire @1100");
  eq(painted(ceaseFire(), 1024), "1986 · blue · round 12 · running · cease-fire", "cease-fire @1024");
  ok(/cease-fire, 3 rounds left/.test(stripInfo(ceaseFire())), "the title keeps the counter at 1024");
  eq(painted(ceaseFire({ peace: { active: true, remaining: 1, coldWar: false } }), 1024),
    "1986 · blue · round 12 · running · cease-fire", "a singular counter is title-only at 1024");
  ok(/cease-fire, 1 round left/.test(stripInfo(ceaseFire({ peace: { active: true, remaining: 1, coldWar: false } }))),
    "the title keeps a singular counter");
  eq(painted(ceaseFire({ peace: { active: true, remaining: 0, coldWar: false } }), 1280),
    "1986 · blue · round 12 · running · cease-fire", "a zero counter paints no number");
  ok(/cease-fire, war may resume/.test(stripInfo(ceaseFire({ peace: { active: true, remaining: 0, coldWar: false } }))),
    "a zero counter keeps war-may-resume in the title");

  // ---- 5. the ladder shortens the suffix only, in the ruled order ------------------------
  {
    eq(texts(ceaseFire(), { width: 1280, tier: 1 }).at(-1), "cease-fire, 3", "tier 1 drops the unit");
    eq(texts(ceaseFire(), { width: 1280, tier: 2 }).at(-1), "cease-fire", "tier 2 drops the count");
    eq(texts(ceaseFire(), { width: 1280, tier: 4 }).at(-1), "running", "tier 4 drops the peace copy");
    eq(texts(war1986(), { width: 1280, tier: 3 }).at(-1), "cold war", "a cold war is already at the floor (t3)");
    eq(texts(war1986(), { width: 1280, tier: 4 }).at(-1), "held", "tier 4 drops a cold-war copy");
    eq(texts(over1986(), { width: 1280, tier: 2 }).at(-1), "blue won (Moscow, round 12)", "tier 2 keeps the win detail");
    eq(texts(over1986(), { width: 1280, tier: 3 }).at(-1), "blue won", "tier 3 drops the win detail");
    let previous = Infinity;
    for (const tier of TIERS) {
      const current = painted(ceaseFire(), 1280, tier).length;
      ok(current <= previous, "tier " + tier + " grew the line: " + previous + " -> " + current);
      previous = current;
    }
  }

  // ---- 6. a layout never prints war copy, at any width or tier ---------------------------
  {
    const layout = { mode: "layout", era: "1986", you: "blue", round: 0, clock: "held", peace: war1986().peace };
    for (const width of WIDTHS) {
      for (const tier of TIERS) {
        ok(!/cold war|cease-fire|war may resume|rounds? left/i.test(painted(layout, width, tier)),
          "a layout describes a war @" + width + " t" + tier);
      }
    }
  }

  // ---- 7. out-of-range tiers clamp to the ends of the ladder ------------------------------
  {
    eq(texts(war1986(), { width: 1280, tier: 99 }), texts(war1986(), { width: 1280, tier: STRIP_TIER_MAX }), "tier 99");
    eq(texts(war1986(), { width: 1280, tier: -4 }), texts(war1986(), { width: 1280, tier: 0 }), "tier -4");
    eq(texts(war1986(), { width: 1280, tier: 2.9 }), texts(war1986(), { width: 1280, tier: 2 }), "tier 2.9");
    eq(texts(null, { width: 1280 }), [], "no room, no parts");
  }
}
