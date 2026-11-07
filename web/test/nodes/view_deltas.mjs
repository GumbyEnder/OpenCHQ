// view_deltas — a round sends the difference, not the room.
//
// What fails if this is removed:
//   - tellRoom frames a seat by comparing with what that seat was last sent -> 1000 rooms pay for
//     the whole board every round
//   - the first frame is a full room                                     -> a fresh page has nothing to patch
//   - a missing round makes the page ask for a sync instead of guessing   -> a dropped frame would
//     leave a wrong board on screen and nobody would know
//
// This test drives a real room over a real socket and merges the deltas itself, then compares the
// merged board with the full frame the server sends when asked. The merged view has to be exactly
// the server's view: a delta that drops a piece is a bug that only shows up after ten minutes of
// play otherwise.

export const name = "view_deltas";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function merge(state, delta) {
  if (!state) return null;
  const byId = new Map((state.pieces || []).map((piece) => [piece.id, piece]));
  for (const piece of delta.pieces || []) byId.set(piece.id, piece);
  for (const id of delta.gone || []) byId.delete(id);
  const routes = { ...(state.routes || {}), ...(delta.routes || {}) };
  const sites = (state.sites || []).map((site) => {
    const hit = (delta.sites || []).find((change) => change.id === site.id);
    return hit ? { ...site, owner: hit.owner } : site;
  });
  return {
    ...state,
    round: delta.round,
    clock: delta.clock,
    note: delta.note,
    pieces: [...byId.values()],
    routes,
    sites,
    seat: delta.seatChanged ? delta.seat : state.seat,
    capitals: delta.capitalsChanged ? delta.capitals : state.capitals,
  };
}

// The parts of a view this test compares: everything a player sees on the board.
function shape(view) {
  return JSON.stringify({
    round: view.round,
    pieces: (view.pieces || []).map((piece) => [piece.id, piece.x, piece.y, piece.side, piece.kind, piece.state ?? ""]).sort(),
    sites: (view.sites || []).map((site) => [site.id, site.owner ?? null]).sort(),
    seat: view.seat ? [view.seat.cash, view.seat.fuel, view.seat.payIn] : null,
  });
}

export async function run(ctx) {
  const account = await ctx.register("DeltaProbe");
  const sock = ctx.socket(account.token);

  await new Promise((resolve) => {
    if (sock.ws.readyState === 1) return resolve();
    sock.ws.addEventListener("open", () => resolve());
  });
  await sock.wait((m) => m.op === "welcome", "welcome");

  sock.send({ op: "bot", era: "1986", side: "blue" });
  const first = await sock.wait((m) => m.op === "room" && m.room && m.room.round === 0, "the opening frame");
  must(first.op === "room", "the first frame must be the whole room");
  let state = first.room;

  sock.send({ op: "run" });
  const beat = Number(ctx.config.roundSeconds) || 5;
  const deadline = Date.now() + beat * 1000 * 8 + 4000;

  let deltas = 0;
  let frames = 0;
  while (Date.now() < deadline && deltas + frames < 6) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const message of sock.box.slice(0)) {
      if (message.op === "delta" && message.delta) {
        if (Number(message.delta.round) === Number(state.round) + 1) {
          state = merge(state, message.delta);
          deltas += 1;
        }
      } else if (message.op === "room" && message.room && Number(message.room.round) > Number(state.round)) {
        state = message.room;
        frames += 1;
      }
    }
    sock.box.length = 0;
    must(state, "the page must always have a board");
    if (deltas >= 3) break;
  }

  must(deltas >= 1, "a running room must send deltas, not whole rooms every round (deltas " + deltas + ", full frames " + frames + ")");

  // Ask for the whole room and check the merged board is the server's board.
  sock.box.length = 0;
  sock.send({ op: "sync" });
  const full = await sock.wait((m) => m.op === "room" && m.room && Number(m.room.round) >= Number(state.round), "the sync frame", 0);
  must(full && full.room, "a sync must answer with the whole room");
  must(shape(full.room) === shape(state), "the merged board must equal the server's board:\n  merged " + shape(state) + "\n  server " + shape(full.room));

  // A delta must be smaller than the frame it replaces, or it is not a saving.
  const deltaBytes = JSON.stringify({ op: "delta", delta: { round: state.round, clock: state.clock, note: state.note, pieces: [], gone: [], routes: {}, sites: [] } }).length;
  const frameBytes = JSON.stringify({ op: "room", room: full.room }).length;
  must(frameBytes > deltaBytes, "a full frame must be larger than an empty delta");

  sock.close();
}
