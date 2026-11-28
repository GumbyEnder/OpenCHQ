// pb326_save_row_pick — the Save Game list IS the Overwrite picker (manual p.36 l.1143: an existing
// title can be picked in the list to overwrite it).
//
// What breaks if this is removed:
//   - a row does not take the click       -> the only path to an overwrite is retyping the title, and
//                                            the list reads as a printed report, not a control;
//   - a row opens its own dialog          -> two confirms for one rule, and the second sentence drifts
//                                            from the one a typed duplicate reaches;
//   - a row click SAVES without asking    -> picking a title destroys the war under it, which is the
//                                            one thing the Overwrite confirm exists to prevent;
//   - the row is a styled <li>            -> no focus, no Enter/Space, no pointer cursor: the list is
//                                            reachable by mouse only (AC (c));
//   - the row or the confirm prints an id -> the player is asked to overwrite "b1f0…".
//
// Three legs, all against the shipped code:
//   1. the prompt builder (web/public/saveslots.mjs) is ONE producer: a picked row and a typed
//      duplicate produce the same sentence, and the slot id is in neither;
//   2. the page routes both paths through `promptOverwrite` and paints the row as a button — pinned
//      from the source, because the flow itself is a click (the page leg grades the pixels);
//   3. over the real HTTP surface: a duplicate name is refused unless the caller asked to overwrite,
//      and the overwrite keeps the slot's id and the list's count — which is exactly what the confirm
//      promises the player (AC (b)).

import { readFileSync } from "node:fs";
import { overwriteSentence, saveRowPick } from "../../public/saveslots.mjs";

export const name = "pb326_save_row_pick";

function fail(message) {
  throw new Error("node test pb326_save_row_pick: " + message);
}

function ok(value, message) {
  if (!value) fail(message);
}

function source(file) {
  return readFileSync(new URL("../../public/" + file, import.meta.url), "utf8");
}

// The body of a top-level function, up to the next top-level declaration. Slicing beats a regex over
// the whole 5k-line page: an assertion here should fail on THIS function's text, not on a stranger's.
function bodyOf(text, header) {
  const start = text.indexOf(header);
  if (start < 0) fail("web/public/app.js no longer defines " + header);
  const rest = text.slice(start + header.length);
  const end = rest.search(/\n(?:function |async function |const |let |document\.getElementById)/);
  return end < 0 ? rest : rest.slice(0, end);
}

async function api(base, token, pathName, body) {
  const res = await fetch(base + pathName, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie: "openchq_session=" + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitRoom(sock, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    for (const message of sock.box.slice()) {
      if (message && message.op === "room" && pred(message.room || null)) return message.room;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb326: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(-8).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, clock: m.room && m.room.clock, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

export async function run(ctx) {
  if (!ctx || typeof ctx.register !== "function") fail("no socket harness in the test context");

  // --- 1. one producer, and it carries no id ------------------------------------------------
  {
    const id = "b1f0c7a2d4e59638";
    const slot = { id, name: "Front Line", era: "1986", round: 7 };
    const meta = "1986 \u00b7 round 7 \u00b7 Ada vs Computer \u00b7 45b";
    const pick = saveRowPick(slot, meta);
    ok(pick.name === "Front Line", "a picked row does not put its title in the name field: " + JSON.stringify(pick.name));
    ok(pick.sentence === overwriteSentence("Front Line", meta),
      "a picked row and a typed duplicate do not reach the same sentence:\n  row:   " + pick.sentence
      + "\n  typed: " + overwriteSentence("Front Line", meta));
    ok(/^A saved war named "Front Line" already exists \(/.test(pick.sentence),
      "the confirm does not name the war it will replace: " + pick.sentence);
    ok(/Overwrite it with this round\?$/.test(pick.sentence), "the confirm does not ask: " + pick.sentence);
    ok(!pick.sentence.includes(id) && !pick.name.includes(id), "the prompt carries the slot id: " + pick.sentence);
    // A slot always has a name, but the builder must not print "undefined" if one ever arrives bare.
    ok(!saveRowPick({}, meta).sentence.includes("undefined"), "an unnamed row prints \"undefined\" into the confirm");
    // The row's own summary line is era/round/players/purse — never an id.
    const metaBody = bodyOf(source("app.js"), "function slotMeta(slot) {");
    ok(!/slot\.id|\.id\b/.test(metaBody), "slotMeta reads a slot id: " + metaBody.trim().slice(0, 200));
  }

  // --- 2. the page's two paths are one function, and the row is a button ---------------------
  {
    const app = source("app.js");
    const paint = bodyOf(app, "function paintSaveExisting() {");
    const prompt = bodyOf(app, "function promptOverwrite(slot) {");

    ok(/const row = document\.createElement\("button"\)/.test(paint),
      "the Save Game row is not a button, so Enter/Space and focus do not work (AC (c))");
    ok(/row\.type = "button"/.test(paint), "the row is not type=button: inside a form it would submit the save");
    ok(/row\.className = "slotrow pick"/.test(paint) && !/slotrow static/.test(paint),
      "the row still carries the static class, so its cursor is not a pointer (AC (c))");
    ok(/row\.addEventListener\("click", \(\) => promptOverwrite\(slot\)\)/.test(paint),
      "clicking a row does not open the overwrite prompt (AC (a))");
    ok(!/saveNow\(/.test(paint), "paintSaveExisting calls saveNow: a row click would write without asking (AC (b))");
    ok(!/slot\.id|\.dataset\.slot/.test(paint), "the row puts the slot id on screen or in the DOM (AC (d))");

    ok(/saveName\.value = pick\.name/.test(prompt), "the prompt does not fill the title field with the pick (AC (a))");
    ok(/saveConfirmText\.textContent = pick\.sentence/.test(prompt), "the prompt does not paint the shared sentence (AC (a))");
    ok(/saveConfirm\.classList\.remove\("hidden"\)/.test(prompt), "the prompt does not open the confirm (AC (a))");
    // PB-336: the exists branch routes through promptOverwrite too, so there is ONE writer of
    // #saveConfirmText. It used to be two (the exists branch composed its own sentence, with no
    // meta and the raw typed spelling), and a second writer is how the two drift apart again.
    // The branch arm is checked FIRST so a mutant that restores the old sentence is named as
    // PB-336's, not as a generic producer count.
    const saveNowBody = bodyOf(app, "async function saveNow(name, overwrite) {");
    ok(/promptOverwrite\(hit\)/.test(saveNowBody) && !/already exists\. Overwrite it with this round/.test(saveNowBody),
      "the exists branch writes its own sentence instead of the shared prompt (PB-336)");
    ok((app.match(/saveConfirmText\.textContent =/g) || []).length === 1,
      "a second producer writes #saveConfirmText: the paths can drift (found "
      + (app.match(/saveConfirmText\.textContent =/g) || []).length + " assignments)");
    ok(/promptOverwrite\(hit\)/.test(bodyOf(app, "saveForm?.addEventListener(\"submit\", (event) => {")),
      "a typed duplicate no longer reaches the same prompt as a picked row (AC (a))");
    ok((app.match(/function promptOverwrite\(slot\)/g) || []).length === 1,
      "promptOverwrite is not defined exactly once");

    const css = source("app.css");
    const rowRule = css.slice(css.indexOf(".slotrow {"), css.indexOf("\n}", css.indexOf(".slotrow {")));
    ok(/cursor: pointer/.test(rowRule), "the row's own class does not supply a pointer cursor (AC (c)): " + rowRule);
    ok(/\.slotrow\.pick:focus-visible/.test(css), "the pick row has no keyboard focus ring (AC (c))");
  }

  // --- 3. the confirm's promise, over HTTP ---------------------------------------------------
  {
    const player = await ctx.register("pb326_row");
    const sock = ctx.socket(player.token);
    try {
      await sock.wait((m) => m.op === "welcome", "the welcome");
      sock.send({ op: "bot", era: "1986", side: "blue" });
      const room = await waitRoom(sock, (r) => Boolean(r && r.id), "the bot room opened");
      ok(Boolean(room && room.id), "no room to save");

      const first = await api(ctx.base, player.token, "/api/slots", { name: "Front Line" });
      ok(first.status === 200 && first.data.ok, "the first save was refused: " + JSON.stringify(first.data));
      const id = first.data.slot.id;
      ok(/^[0-9a-f]{16}$/.test(String(id)), "the slot id is not the 16-hex the list carries: " + id);

      // A row click asks; the server must ask too when nobody did.
      const dup = await api(ctx.base, player.token, "/api/slots", { name: "front line" });
      ok(dup.status === 400 && dup.data.exists === true,
        "a duplicate name saved without asking: a row click could destroy a war (AC (b)): " + JSON.stringify(dup.data));
      ok(dup.data.id === id, "the refusal does not name the slot the confirm will replace: " + JSON.stringify(dup.data));

      const over = await api(ctx.base, player.token, "/api/slots", { name: "front line", overwrite: true });
      ok(over.status === 200 && over.data.ok, "Overwrite was refused: " + JSON.stringify(over.data));

      const list = await api(ctx.base, player.token, "/api/slots");
      const slots = Array.isArray(list.data.slots) ? list.data.slots : [];
      ok(slots.length === 1, "the overwrite changed the list's count (" + slots.length
        + "): the confirm promises the same war is replaced, not a second one (AC (b))");
      ok(slots[0].id === id, "the overwrite replaced the slot's id (" + slots[0].id + " vs " + id + ")");
      ok(!/b1f0|slots?\/[0-9a-f]{16}/.test(String(slots[0].name)), "the row's name carries an id: " + slots[0].name);
    } finally {
      sock.close();
    }
  }
}
