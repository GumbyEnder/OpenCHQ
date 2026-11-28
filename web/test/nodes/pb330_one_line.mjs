// pb330_one_line — one order, one Log row: the mover's OWN echo and the server's delivered line
// name the SAME act, so they carry the same key and the page keeps the first of the two.
//
// What breaks if this is removed: the ack path writes the echo into the round Log, and
// `transferOp`/`destinationOp` deliver the same act again through the shared seat-log helper, so a
// player who just transferred a unit, or set a starting destination, reads two near-identical rows
// for one order (PM 10410 §4; measured on live 1743651 by tests/e2e/pb330-log-dupe.mjs).
//
// Arms:
//   (a)  transfer door: one `op:"transfer"` -> the mover's stored log gains exactly ONE row, it is
//        "a unit transferred", and it carries the act's key (kind + piece + cell);
//   (a2) the key is the ACT, not the round: 241 transfers of one piece inside round 0 store 241
//        rows and never collapse - the merge must not eat repeated acts;
//   (b)  destination door: one `op:"destination"` -> exactly ONE row, the destination sentence,
//        carrying the same act key the page's echo uses;
//   (c)  the other seat's delta stays 0 on both doors;
//   (d)  the page is wired to that key: app.js passes `key: actKey(...)` in BOTH acks, from the same
//        module the server imports. A key the page never sends merges nothing.
//
// The lobby writes rooms to SQLite, so OPENCHQ_WEB_DATA points at a throwaway directory BEFORE
// lobby.mjs is imported: a test must never read or write the operator's real store.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actKey } from "../../public/acts.mjs";

export const name = "pb330_one_line";

const here = path.dirname(fileURLToPath(import.meta.url));
const TRANSFER_LINE = "a unit transferred";
const DESTINATION_LINE = "a destination is set; it moves when the war begins";

function fakePeer() {
  const box = [];
  return {
    box,
    closed: false,
    send(message) { box.push(message); },
    close() { this.closed = true; },
    onclose: null,
  };
}

function lastRoom(peer) {
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function storedLog(peer) {
  const room = lastRoom(peer);
  return room && Array.isArray(room.log) ? room.log : [];
}

export async function run(ctx) {
  const { fail } = ctx;
  const same = (label, got, want) => {
    if (String(got) !== String(want)) fail(label + " — got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
  };

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb330-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    const alice = fakePeer(); // blue, the mover
    const bob = fakePeer();   // red, stays blind
    gate.join("pb330_alice", alice);
    gate.join("pb330_bob", bob);
    const inv = gate.handle("pb330_alice", { op: "invite", user: "pb330_bob", era: "1986", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb330_bob", { op: "answer", id: invite.invite.id, accept: true });
    if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
    const opening = lastRoom(alice);
    if (!opening) fail("alice got no room frame after the accept");
    if (!opening.peace || opening.peace.active !== true) {
      fail("1986 did not open in the peace both doors need: " + JSON.stringify(opening.peace));
    }
    const roomId = opening.id;

    const lands = () => (gate.debugRoom(roomId).pieces || []).filter((p) => p.side === "blue"
      && String(p.domain || "land") === "land" && p.kind !== "aircraft" && p.transport !== true);

    // ---- (a) transfer door -----------------------------------------------------------------
    const mover = lands()[0];
    if (!mover) fail("1986 blue holds no land unit");
    const home = { x: Number(mover.x), y: Number(mover.y) };
    const redBefore = bob.box.length;
    let there = null;
    for (let r = 1; r <= 6 && !there; r++) {
      for (let dy = -r; dy <= r && !there; dy++) {
        for (let dx = -r; dx <= r && !there; dx++) {
          if (!dx && !dy) continue;
          const cell = { x: home.x + dx, y: home.y + dy };
          const res = gate.handle("pb330_alice", { op: "transfer", piece: mover.id, to: cell, id: "pb330-t1" });
          if (res && !res.error) { there = cell; break; }
        }
      }
    }
    if (!there) fail("no friendly neighbouring cell accepted the transfer of " + mover.id);
    gate.handle("pb330_alice", { op: "sync" });
    const afterTransfer = storedLog(alice);
    if (afterTransfer.length !== 1) {
      fail("(a) one transfer stored " + afterTransfer.length + " rows, not one: " +
        JSON.stringify(afterTransfer.map((row) => row.text)));
    } else {
      same("(a) the stored row is the delivered sentence", afterTransfer[0].text, TRANSFER_LINE);
      same("(a) the row carries the act's key", String(afterTransfer[0].key || ""), actKey("transfer", mover.id, there));
      if (/\b\d{1,3},\d{1,3}\b/.test(String(afterTransfer[0].text)) || String(afterTransfer[0].text).includes(mover.id)) {
        fail("(a) the row leaks a raw cell or a piece id: " + JSON.stringify(afterTransfer[0].text));
      }
    }

    // ---- (a2) the key is the act, not the round --------------------------------------------
    const delivered = 241;
    for (let i = 1; i < delivered; i++) {
      const target = i % 2 === 1 ? home : there;
      const back = gate.handle("pb330_alice", { op: "transfer", piece: mover.id, to: target, id: "pb330-a2-" + i });
      if (!back || back.error) fail("(a2) transfer " + i + " was refused: " + JSON.stringify(back));
    }
    gate.handle("pb330_alice", { op: "sync" });
    // Delivered rows are the count of ACTS (nothing is collapsed server-side); the stored log is the
    // count the clamp allows. Both are quoted so a merge that ate acts could not hide behind the 240.
    const pushed = alice.box.filter((m) => m && m.op === "log")
      .flatMap((m) => (Array.isArray(m.lines) ? m.lines : []))
      .filter((row) => String(row && row.text) === TRANSFER_LINE);
    if (pushed.length !== delivered) {
      fail("(a2) the server delivered " + pushed.length + " transfer rows for " + delivered +
        " acts - the merge belongs to the page and may not eat repeated acts");
    }
    const keySet = new Set(pushed.map((row) => String(row.key || "")));
    if (keySet.size !== 2) {
      fail("(a2) 241 transfers out and back produced " + keySet.size + " distinct act keys, expected 2: " +
        JSON.stringify([...keySet]));
    }
    const clamped = storedLog(alice);
    if (clamped.length !== 240) fail("(a2) the 240-row clamp moved: " + clamped.length);

    // ---- (b) destination door ---------------------------------------------------------------
    const walker = lands().find((p) => p.id !== mover.id) || lands()[0];
    const from = { x: Number(walker.x), y: Number(walker.y) };
    let dest = null;
    for (let r = 1; r <= 6 && !dest; r++) {
      for (let dy = -r; dy <= r && !dest; dy++) {
        for (let dx = -r; dx <= r && !dest; dx++) {
          if (!dx && !dy) continue;
          const cell = { x: from.x + dx, y: from.y + dy };
          const res = gate.handle("pb330_alice", { op: "destination", piece: walker.id, to: cell, id: "pb330-d1" });
          if (res && !res.error) { dest = cell; break; }
        }
      }
    }
    if (!dest) fail("no cell accepted a starting destination for " + walker.id);
    gate.handle("pb330_alice", { op: "sync" });
    const destRows = storedLog(alice).filter((row) => row.text === DESTINATION_LINE);
    if (destRows.length !== 1) {
      fail("(b) one destination stored " + destRows.length + " destination rows, not one");
    } else {
      same("(b) the destination row carries the act's key", String(destRows[0].key || ""), actKey("destination", walker.id, dest));
      same("(b) the key names the kind the page echoes with", String(destRows[0].key || "").slice(0, 16), "act:destination:");
    }

    // ---- (c) the other seat's delta stays 0 -------------------------------------------------
    if (bob.box.slice(redBefore).some((m) => m && m.op === "log")) {
      fail("(c) red was handed a log frame for blue's own orders: " +
        JSON.stringify(bob.box.slice(redBefore).filter((m) => m.op === "log")));
    }
    gate.handle("pb330_bob", { op: "sync" });
    if (storedLog(bob).length !== 0) fail("(c) red's stored log is not empty: " + JSON.stringify(storedLog(bob)));

    // ---- (d) the page sends that key -------------------------------------------------------
    const app = readFileSync(path.join(here, "..", "..", "public", "app.js"), "utf8");
    if (!/key:\s*actKey\("transfer",\s*message\.piece,\s*message\.to\)/.test(app)) {
      fail("(d) the transfer ack no longer tags its echo with the act key - the merge cannot happen");
    }
    if (!/key:\s*actKey\("destination",\s*message\.piece,\s*message\.to\)/.test(app)) {
      fail("(d) the destination ack no longer tags its echo with the act key");
    }
    if (!/import \{ actKey \} from "\.\/acts\.mjs";/.test(app)) fail("(d) app.js does not import the shared act key");
    const acts = readFileSync(path.join(here, "..", "..", "public", "acts.mjs"), "utf8");
    if (!/export function actKey\(/.test(acts)) fail("(d) public/acts.mjs lost the act key builder");
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
