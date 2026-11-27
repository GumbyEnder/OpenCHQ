// pb311_layout_strip — a layout sandbox must not describe a cold war.
//
// What breaks if the fix is removed (PB-311, PM 10093 item 2, measured on live 50758d6 in a layout
// at 1280x800 and 1024x768): the header strip reads
//     1986 · blue · round 0 · held · cold war, war may resume
// which is peace/war copy in a sandbox that has no war, and an invitation to resume one.
//
// The line has exactly one producer: shell.mjs stripInfoParts(). This arm reads it as a pure
// function, so the red is the copy and not a paint path. The positive control is the real 1986 war
// at round 0, which must keep today's line BYTE FOR BYTE - the layout arm is the only one allowed
// to change.

import { stripInfo, stripInfoParts } from "../../public/shell.mjs";

export const name = "pb311_layout_strip";

function fail(message) {
  throw new Error("node test pb311_layout_strip: " + message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

const FORBIDDEN = /cold war|cease-fire|war may resume|rounds? left/i;

// The room frame a layout carries, read off the live page (PB-308 card 5.1): mode layout, clock
// held, round 0, and the era's peace still active because the sandbox is opened as a 1986 room.
function layoutRoom(extra = {}) {
  return {
    mode: "layout",
    era: "1986",
    you: "blue",
    round: 0,
    clock: "held",
    peace: { active: true, canResume: true, coldWar: true },
    ...extra,
  };
}

function warRoom(extra = {}) {
  return {
    mode: "bot",
    era: "1986",
    you: "blue",
    round: 0,
    clock: "held",
    peace: { active: true, remaining: 0, coldWar: true },
    ...extra,
  };
}

export async function run() {
  // ---- 1. a layout names itself and carries no war copy --------------------------------
  {
    const room = layoutRoom();
    const parts = stripInfoParts(room).map((part) => part.text);
    eq(parts, ["1986", "blue", "layout", "round 0", "held"], "a layout's parts");
    eq(stripInfo(room), "1986 · blue · layout · round 0 · held", "a layout's line");
    const line = stripInfo(room);
    if (FORBIDDEN.test(line)) fail("a layout's line still describes a war: " + line);
    for (const part of parts) {
      if (FORBIDDEN.test(part)) fail("a layout's part still describes a war: " + part);
    }
    if (/(blue|red):[a-z]+:/.test(line)) fail("a layout's line carries a raw piece id: " + line);
    // The exact string the PM read on live 50758d6 must not survive the fix.
    if (line === "1986 · blue · round 0 · held · cold war, war may resume") {
      fail("the pre-fix live line is unchanged");
    }
  }

  // ---- 2. the peace block is skipped, not merely zeroed --------------------------------
  // A layout whose peace row carries live-looking numbers must still say nothing about peace: the
  // fix is the layout branch, not the `remaining > 0` sub-branch.
  {
    const withCounter = layoutRoom({ peace: { active: true, remaining: 5, coldWar: false } });
    const line = stripInfo(withCounter);
    if (FORBIDDEN.test(line)) fail("a layout with a live counter still prints it: " + line);
    if (!/\blayout\b/.test(line)) fail("a layout does not name itself: " + line);
    const noPeace = layoutRoom({ peace: null });
    eq(stripInfo(noPeace), "1986 · blue · layout · round 0 · held", "a layout with no peace row");
    const noMode = layoutRoom({ mode: undefined });
    if (!FORBIDDEN.test(stripInfo(noMode))) {
      fail("a room with no mode lost the war copy - the fix is not keyed on layout: " + stripInfo(noMode));
    }
  }

  // ---- 3. POSITIVE CONTROL: the real 1986 war at round 0, byte for byte -----------------
  {
    const line = stripInfo(warRoom());
    eq(line, "1986 · blue · round 0 · held · cold war, war may resume", "the war round-0 control");
  }

  // ---- 4. the counter still rides a war ------------------------------------------------
  {
    const war = warRoom({ round: 3, clock: "running", peace: { active: true, remaining: 0, coldWar: false } });
    eq(stripInfo(war), "1986 · blue · round 3 · running · cease-fire, war may resume", "a war's elapsed cease-fire");
    const counter = warRoom({ peace: { active: true, remaining: 2, coldWar: false } });
    if (!stripInfo(counter).includes("cease-fire, 2 rounds left")) {
      fail("a war's counter is gone: " + stripInfo(counter));
    }
    const oneLeft = warRoom({ peace: { active: true, remaining: 1, coldWar: true } });
    if (!stripInfo(oneLeft).includes("cold war, 1 round left")) {
      fail("a war's singular counter is gone: " + stripInfo(oneLeft));
    }
    const atWar = warRoom({ peace: null });
    if (FORBIDDEN.test(stripInfo(atWar))) fail("a war with no peace row prints peace copy: " + stripInfo(atWar));
  }

  // ---- 5. the concealed era's name and the empty case are untouched -------------------
  {
    eq(stripInfo(layoutRoom({ era: "9999" })), "Concealed · blue · layout · round 0 · held", "a concealed layout");
    eq(stripInfoParts(null), [], "no room at all");
    eq(stripInfo(undefined), "", "an undefined room");
  }
}
