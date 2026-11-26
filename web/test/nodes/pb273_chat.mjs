// PB-273 ON THE WIRE: chat is one `chat` op, and the claim the card makes is about the two things the
// server sends — the live message (a `chat` frame the page puts on its message strip) and the durable
// record (a `log` frame, so a reload replays the sentence from the room, not from the page).
//
// What this arm is built to fail on:
//   - chat riding `match` instead of the seat branch: a spectator payload (forSeat(match, null)) would
//     then carry it, which the card forbids (frodo 9648 §3, PM 9650 §5);
//   - a cap or an escape done in the page: the raw text here is 500 chars and carries `<img onerror>`,
//     and the frame the server sends must already be capped and already have the HTML-safe form;
//   - a bot room opening a chat surface: the bot has no chat surface, so the op refuses AND
//     room.chatOpen is false;
//   - a delta that re-sends the same message every round (or never sends it at all).
//
// It drives createLobby() through a real invite/accept, the same fixture pb224_satellite_room uses, so
// the assertions read frames the server actually sent rather than a hand-built view.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { forSeat } from "../../server/view.mjs";
import { makeAsserts, lastRoom, openRoom } from "../pb224_helpers.mjs";

export const name = "pb273_chat";

export async function run() {
  const t = makeAsserts(name);
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb273-chat-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    // Dynamic import so db.mjs and rooms.mjs see the isolated data directory.
    const { createLobby, CHAT_CAP, cleanChat, escapeChat, deltaBetween } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    // --- the cap and the escape are pure functions, so they are pinned directly -----------------
    t.eq("the cap is the card's 200 characters", CHAT_CAP, 200);
    t.eq("a 500-character message keeps exactly the first 200", cleanChat("x".repeat(500)).length, 200);
    t.eq("a newline, a tab and a run of spaces collapse to one space", cleanChat("a\nb\tc   d"), "a b c d");
    t.eq("the HTML-safe form encodes every markup character",
      escapeChat('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");

    // --- two humans: the message, and the log line ----------------------------------------------
    const pair = openRoom(gate, "1986", "pb273_chat", name);
    const blueUnsent = pair.blue.box.length;
    const redUnsent = pair.red.box.length;
    const sent = gate.handle("pb273_chat_blue", { op: "chat", text: "  hello, red  " });
    t.eq("the blue seat's chat is accepted", Boolean(sent && sent.ok), true);
    t.eq("the sentence is stored trimmed", sent.chat.text, "hello, red");
    t.eq("the entry names the side that sent it", sent.chat.side, "blue");
    t.eq("the entry carries the round it was sent in", sent.chat.round, 0);

    const chatFrames = (peer) => peer.box.slice(0).filter((m) => m && m.op === "chat").map((m) => m.chat);
    const logFrames = (peer) => peer.box.slice(0).filter((m) => m && m.op === "log");
    t.eq("red receives the message (live half)", chatFrames(pair.red).map((c) => c.text), ["hello, red"]);
    t.eq("blue receives its own message echoed", chatFrames(pair.blue).map((c) => c.text), ["hello, red"]);
    t.eq("red's Log receives exactly one chat line", logFrames(pair.red).map((f) => f.lines.length), [1]);
    t.eq("the Log line is the same sentence", logFrames(pair.red)[0].lines[0].text.includes("hello, red"), true);
    t.eq("the Log line carries the round", logFrames(pair.red)[0].lines[0].round, 0);
    t.ok("both seats got new frames after the message", pair.blue.box.length > blueUnsent && pair.red.box.length > redUnsent);

    // --- the reply, the other way ----------------------------------------------------------------
    const reply = gate.handle("pb273_chat_red", { op: "chat", text: "hello back" });
    t.eq("the red seat's reply is accepted", Boolean(reply && reply.ok), true);
    t.eq("the reply reaches blue", chatFrames(pair.blue).map((c) => c.text), ["hello, red", "hello back"]);
    t.eq("the reply names the red side", chatFrames(pair.blue).map((c) => c.side), ["blue", "red"]);
    t.eq("blue's Log now holds both lines", logFrames(pair.blue).slice(-1)[0].lines.length, 1);
    // A sync is the reconnect path: the frame it sends is built fresh from the room, so the last
    // message has to survive a page that was not there when it was written.
    gate.handle("pb273_chat_blue", { op: "sync" });
    t.eq("a freshly built seat frame carries the last message and the surface flag",
      [lastRoom(pair.blue).chat && lastRoom(pair.blue).chat.text, lastRoom(pair.blue).chatOpen], ["hello back", true]);

    // --- cap and escape on the wire, not in the page --------------------------------------------
    const hostile = gate.handle("pb273_chat_blue", { op: "chat", text: "<img src=x onerror=alert(1)>".repeat(20) });
    t.eq("the hostile message is capped on the frame", hostile.chat.text.length, 200);
    t.eq("the frame's text form is raw (a textContent sink parses nothing)", hostile.chat.text.includes("<img"), true);
    t.eq("the frame's html form has no raw markup character left",
      [hostile.chat.html.includes("<"), hostile.chat.html.includes(">"), hostile.chat.html.includes("&lt;img")],
      [false, false, true]);
    const empty = gate.handle("pb273_chat_blue", { op: "chat", text: "   \n\t " });
    t.eq("an empty message is refused, not stored", Boolean(empty && empty.error), true);

    // --- the bot room has no chat surface -------------------------------------------------------
    const solo = gate.handle("pb273_bot_blue", { op: "bot", era: "1986", side: "blue", handicap: 0, level: 1 });
    t.eq("the bot room starts", Boolean(solo && solo.ok), true);
    const refused = gate.handle("pb273_bot_blue", { op: "chat", text: "anyone there" });
    t.eq("a bot room refuses chat", Boolean(refused && refused.error), true);
    t.ok("the refusal says why (the bot has no chat surface)", /bot/i.test(refused.error));

    // --- never to a spectator -------------------------------------------------------------------
    const match = { pieces: [], routes: {}, sites: [], capitals: { blue: null, red: null }, round: 3 };
    const seatView = forSeat(match, "blue", Date.now(), { side: "red", text: "secret", html: "secret" });
    const spectatorView = forSeat(match, null, Date.now(), { side: "red", text: "secret", html: "secret" });
    t.eq("a seat view carries the message", seatView.chat && seatView.chat.text, "secret");
    t.eq("a spectator's payload has no chat field at all", "chat" in spectatorView, false);

    // --- a delta carries a new message once, and not again ---------------------------------------
    const shadow = { round: 3, clock: "running", note: "", seat: null, capitals: null, capitalList: null, ownership: null, pieces: {}, routes: {}, sites: {}, chat: JSON.stringify(null) };
    const viewWith = { round: 4, pieces: [], routes: {}, sites: [], chat: { side: "red", text: "first" } };
    const firstDelta = deltaBetween(shadow, viewWith);
    t.eq("a delta carries a message that is new to the seat", firstDelta.chat && firstDelta.chat.text, "first");
    shadow.chat = JSON.stringify(viewWith.chat);
    shadow.round = 4;
    const second = deltaBetween(shadow, { ...viewWith, round: 5 });
    t.eq("the same message is not re-sent on the next delta", "chat" in second, false);

    console.log(t.line());
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
