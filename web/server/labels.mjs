// PB-300: one place that turns a piece into the name a player reads.
//
// A piece id is a wire key ("blue:tank:2", or "blue:sea" for a scenario's opening unit), not a
// name. PB-299 stopped the Air panel printing it; the refusals in move.mjs and air.mjs still did,
// so a player was told "Another piece holds that cell (blue:tank:2)." - a key he cannot use.
//
// The rule is PB-299's, kept identical so the two surfaces cannot disagree:
//   - the noun comes from the piece's KIND (its own `kind` field when a piece is passed, else the
//     id's second segment, which is the kind for every piece bought in play);
//   - the number is the id's own trailing numeric segment, so "blue:aircraft:1" reads "Aircraft 1"
//     - the same string the Air panel prints;
//   - an id with no number ("blue:land", "blue:sea") reads as the bare noun ("Infantry",
//     "Submarine"). Nothing here ever hands back the wire key: a caller with nothing to show gets
//     an empty string and says its own sentence without a name.
//
// The id itself is not lost by this: it stays on the element's data-piece and title where the page
// needs it (PB-299), and it is still what the wire carries in both directions.

const NOUNS = Object.freeze({
  infantry: "Infantry",
  armor: "Armor",
  tank: "Tank",
  artillery: "Artillery",
  aircraft: "Aircraft",
  carrier: "Carrier",
  transport: "Transport",
  ship: "Ship",
  submarine: "Submarine",
  destroyer: "Destroyer",
  cruiser: "Cruiser",
  battleship: "Battleship",
  reconSat: "ReconSat",
  killerSat: "KillerSat",
});

function nounOf(kind) {
  const key = String(kind || "");
  if (!key) return "";
  return NOUNS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

// Accepts a piece (preferred: it carries its own kind) or a bare id string. A bare id's second
// segment is only read as a kind when it IS one: "blue:tank:2" carries "tank", but "blue:sea" and
// "blue:land" carry a ROLE (those are a scenario's opening units, whose kind is infantry and
// submarine), so an id alone cannot name them - a caller holding the piece hands the piece over.
export function pieceLabel(pieceOrId) {
  const isPiece = Boolean(pieceOrId) && typeof pieceOrId === "object";
  const id = String(isPiece ? (pieceOrId.id ?? "") : (pieceOrId ?? ""));
  const parts = id.split(":");
  const idSegment = parts.length >= 2 ? parts[1] : "";
  const noun = nounOf(isPiece ? pieceOrId.kind : (Object.hasOwn(NOUNS, idSegment) ? idSegment : ""));
  if (!noun) return "";
  let number = "";
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (/^\d+$/.test(parts[i])) {
      number = parts[i];
      break;
    }
  }
  return number ? noun + " " + number : noun;
}

// For a refusal that must always name the thing it is talking about: a real piece always has a
// kind, so this is the same string as pieceLabel, with a last-resort noun instead of an empty one.
export function pieceRef(piece) {
  return pieceLabel(piece) || "that piece";
}

// A sentence that echoes an id the caller was GIVEN (a refused order naming a piece that does not
// exist). Same name when the id carries a kind, and no parenthetical at all when it does not - the
// wire key never reaches the player either way.
export function pieceEcho(id) {
  const name = pieceLabel(id);
  return name ? " (" + name + ")" : "";
}
