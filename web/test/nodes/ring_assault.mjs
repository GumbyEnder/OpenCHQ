// Node ring_assault: what the bot does when the capital's ring is full.
//
// Units do not stack, so a capital whose eight neighbours are all occupied leaves a marcher with
// nowhere to stand. A 400-round run logged 26,834 "no approach cell beside the capital" skips —
// the army had stopped thinking, not settled into a siege. (That run predates this change and its
// harness is not in local/, so the count below is not a re-measurement.) The engine already treats a move onto an
// enemy cell as an attack, so the bot now picks the weakest point of the ring and hits it.
import { assaultCells, marchOne, ordersFor } from "../../server/bot.mjs";
import { openMatch } from "../../server/match.mjs";

export const name = "ring_assault";

const WIDTH = 320;

function wrap(x) {
  return ((Number(x) % WIDTH) + WIDTH) % WIDTH;
}

function ring(cell) {
  const out = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const y = Number(cell.y) + oy;
      if (y < 0 || y > 135) continue;
      out.push({ x: wrap(Number(cell.x) + ox), y });
    }
  }
  return out;
}

function room(era = "1986") {
  const match = openMatch(era);
  match.seats = {
    blue: { username: "Bot", kind: "bot" },
    red: { username: "Ada", kind: "human" },
  };
  return match;
}

function addPiece(match, id, side, x, y) {
  match.pieces.push({ id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1, transport: false, entrenched: false });
  return match.pieces[match.pieces.length - 1];
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- the weakest point of the ring is chosen, not the first one found ---------------------
  {
    const match = room();
    const capital = match.capitals.red[0];
    const army = match.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
    if (!army) fail("a 1986 room has no blue land piece");
    // Only this army and the garrison: the opening sea piece would otherwise become the focus.
    match.pieces = [army];
    // The capital is held and so is every cell around it: whatever the bot fixes on, there is no
    // free cell to stand on, which is the exact endgame state that used to log 26,834 skips.
    addPiece(match, "capital-holder", "red", capital.x, capital.y);
    const cells = ring(capital);
    cells.forEach((cell, index) => {
      addPiece(match, "def" + index, "red", cell.x, cell.y);
    });
    const strong = cells[3];
    addPiece(match, "strong1", "red", strong.x + 1, strong.y);
    addPiece(match, "strong2", "red", strong.x - 1, strong.y);

    const targets = assaultCells(match, army, capital);
    if (targets.length < 6) fail("the ring should offer every held cell, got " + targets.length);
    if (targets.some((cell) => cell.defenders === undefined)) fail("a target does not carry its defender count");
    for (let i = 1; i < targets.length; i++) {
      if (targets[i - 1].defenders > targets[i].defenders) {
        fail("targets are not sorted weakest first: " + JSON.stringify(targets.slice(0, 3)));
      }
    }
    // Every ring cell has neighbours on the ring, so every one carries support. What matters is
    // that the pick is the weakest of them, and not the cell that was reinforced.
    const minDefenders = Math.min(...targets.map((cell) => cell.defenders));
    if (targets[0].defenders !== minDefenders) fail("the weakest point was not offered first");
    const strongDefenders = targets.find((cell) => cell.x === strong.x && cell.y === strong.y);
    if (!strongDefenders) fail("the reinforced cell is missing from the targets");
    if (strongDefenders.defenders <= minDefenders) fail("the reinforcement was not counted");
    if (targets[0].x === strong.x && targets[0].y === strong.y) fail("the reinforced cell was picked first");
    if (targets.some((cell) => cell.x === army.x && cell.y === army.y)) fail("a target sits on the army's own cell");

    // The order is actually given, and it is flagged as an assault rather than a march. marchOne is
    // driven directly because the endgame state is not reachable through ordersFor's own focus.
    const events = [];
    marchOne(match, "blue", army, capital, events);
    const order = events.find((event) => event.type === "bot_order" && event.pieceId === army.id);
    if (!order) fail("the ringed capital produced no order: " + JSON.stringify(events.filter((e) => e.pieceId === army.id)));
    // What this fixes is the silence: a fully held ring used to produce "no approach cell" and
    // nothing else, round after round. The army must be given an order instead.
    if (!order.to || !Number.isInteger(order.to.x) || !Number.isInteger(order.to.y)) {
      fail("the order has no destination: " + JSON.stringify(order));
    }
    if (typeof order.assault !== "boolean") fail("the order does not say whether it is an assault");

    const skips = events.filter((event) => event.type === "bot_skip" && /no approach cell/.test(String(event.reason)));
    if (skips.length) fail("the bot still reports no approach cell when the ring is attackable");
  }

  // --- a free ring cell is still preferred over an attack -----------------------------------
  {
    const match = room();
    const capital = match.capitals.red[0];
    const army = match.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
    match.pieces = [army];
    const cells = ring(capital);
    // Leave one cell empty and hold the rest.
    cells.slice(1).forEach((cell, index) => addPiece(match, "hold" + index, "red", cell.x, cell.y));
    const events = ordersFor(match, "blue");
    const order = events.find((event) => event.type === "bot_order" && event.pieceId === army.id);
    if (!order) {
      const skip = events.find((event) => event.type === "bot_skip" && event.pieceId === army.id);
      // A refused terrain cell is a legitimate refusal; an assault would not be.
      if (skip && /ringed/.test(String(skip.reason))) fail("an empty ring cell was not used: " + skip.reason);
      return;
    }
    if (order.assault) fail("the bot attacked although a ring cell was free");
  }
}
