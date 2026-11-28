// One act, one Log row (PB-330).
//
// The page echoes the mover's own order into the round Log when the ack lands ("Transferred. The
// unit is in its new location this round", "Starting destination set: 2 rounds of walking. It moves
// the moment war begins"), and the server delivers the same act as its own line ("a unit
// transferred", "a destination is set; it moves when the war begins"). Both are true and both were
// shown, so one order read as two near-identical rows in the mover's Log.
//
// The two producers now agree on a key: whichever line lands first owns the row, and noteLog's
// existing key dedupe (the one the sight lines use) drops the other. The key names the ACT - its
// kind, the piece and the cell the order was sent to. Never a message id: the server never sees one.
// Never the round alone: the 240-line clamp arm moves one piece 241 times inside one round, and
// those are 241 separate acts.
export function actKey(kind, pieceId, to) {
  const id = pieceId === undefined || pieceId === null ? "" : String(pieceId);
  const hasTo = to && Number.isFinite(Number(to.x)) && Number.isFinite(Number(to.y));
  const cell = hasTo ? Number(to.x) + "," + Number(to.y) : "";
  return "act:" + String(kind || "") + ":" + id + ":" + cell;
}
