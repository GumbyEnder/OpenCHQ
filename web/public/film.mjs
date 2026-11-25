// War Films: the replay view model (T-031 step 3).
//
// The original (manual p.35, p.38) let a player watch a saved film and choose Show Red, Show Blue,
// Show Common or Show Both while it played. This module is the PURE half of that: it turns a film's
// start state plus one recorded frame into the room-shaped object the board painter already takes,
// and it clamps the transport. No DOM, no fetch, no server import - the node tests drive it directly
// and the page calls the same functions, so the four toggles cannot mean two different things.
//
// What a frame carries (history.mjs `appendFrame`): `round`, `clock`, the tick's `events` verbatim,
// `strengths` (piece id -> strength-after) and `owners` ([[siteId, owner], ...]). It does NOT carry
// unit positions: a film shows the war's ground and its strength, not a second, invented march.
// Round 0 comes from the film's recorded `start` state (`packMatch`), which is why a replay can paint
// before the first frame exists.

export const FILM_SHOWS = Object.freeze(["both", "blue", "red", "common"]);

export const FILM_SHOW_LABELS = Object.freeze({
  both: "Show Both",
  blue: "Show Blue",
  red: "Show Red",
  common: "Show Common",
});

// The transport's speed labels, so the buttons say what they do.
export const FILM_SPEED_LABELS = Object.freeze({ 0.5: "0.5x", 1: "1x", 2: "2x", 4: "4x" });

export function emptyFilm() {
  return { meta: null, start: null, frames: [], at: 0, playing: false, speed: 1, show: "both" };
}

// Show Both is the fog-off view: every side's units and every side's ground. Show Blue / Show Red are
// one side's units plus the ground that side holds (other ground reads neutral, never the enemy's
// colour - a "Show Blue" frame painted with red's cities would be a lie about what the toggle did).
// Show Common is the ground alone: the terrain and the sites, with no side's units and no ownership.
export function showKeepsPiece(show, side) {
  if (show === "both") return true;
  if (show === "blue") return side === "blue";
  if (show === "red") return side === "red";
  return false;
}

export function showPaintsOwner(show, owner) {
  if (show === "both") return owner ?? null;
  if (show === "common") return null;
  return owner === show ? show : null;
}

export function clampFrame(film, index) {
  const count = Array.isArray(film && film.frames) ? film.frames.length : 0;
  if (!count) return 0;
  const at = Number(index);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.min(count - 1, Math.trunc(at)));
}

export function frameCount(film) {
  return Array.isArray(film && film.frames) ? film.frames.length : 0;
}

export function filmFrame(film, index = film && film.at) {
  const frames = Array.isArray(film && film.frames) ? film.frames : [];
  return frames[clampFrame(film, index)] || null;
}

// The room-shaped object the painter takes. `you` is null on purpose: a film is fog-off, and the
// painter's fog rule keys on a seat. `result` is only present on the closing frame, so the end screen
// of a film is the same sentence a live seat read.
export function filmRoomAt(film, index = film && film.at, show = film && film.show) {
  const start = (film && film.start) || {};
  const frame = filmFrame(film, index) || { round: start.round || 0, strengths: {}, owners: [], events: [] };
  const look = FILM_SHOWS.includes(show) ? show : "both";
  const owners = new Map();
  for (const row of Array.isArray(frame.owners) ? frame.owners : []) {
    if (Array.isArray(row) && row.length >= 2) owners.set(String(row[0]), row[1] ?? null);
  }
  const strengths = frame.strengths && typeof frame.strengths === "object" ? frame.strengths : {};
  const pieces = (Array.isArray(start.pieces) ? start.pieces : [])
    .filter((piece) => piece && showKeepsPiece(look, piece.side))
    .map((piece) => {
      const raw = strengths[String(piece.id)];
      return raw === undefined || raw === null ? piece : { ...piece, strength: raw };
    });
  const sites = (Array.isArray(start.sites) ? start.sites : []).map((site) => {
    const held = owners.has(String(site.id)) ? owners.get(String(site.id)) : site.owner ?? null;
    return { ...site, owner: showPaintsOwner(look, held) };
  });
  const state = frame.state && typeof frame.state === "object" ? frame.state : null;
  const result = state && state.over
    ? {
      winner: state.winner ?? null,
      reason: state.winReason && state.winReason.kind === "ceasefire"
        ? "ceasefire"
        : state.winReason && state.winReason.kind === "capitals"
          ? "capitals"
          : state.winner ? "resignation" : "over",
      ceasefire: state.winReason && state.winReason.kind === "ceasefire"
        ? { by: state.winReason.by ?? null, round: state.winReason.round ?? null }
        : null,
      lastCapital: null,
      capitals: Array.isArray(state.capitalList) ? state.capitalList : [],
      round: Number(state.round) || null,
    }
    : null;
  return {
    id: (film && film.meta && film.meta.id) || null,
    era: start.era ?? null,
    mode: start.mode ?? null,
    // No seat, no fog: the film view is the one place both sides are drawn (room 7683 condition 3).
    you: null,
    seat: null,
    round: Number(frame.round) || 0,
    clock: frame.clock ?? "held",
    pieces,
    sites,
    capitals: start.capitals || {},
    capitalList: start.capitalList || null,
    satellites: [],
    over: Boolean(state && state.over),
    winner: state ? state.winner ?? null : null,
    result,
    tools: [],
    shop: [],
    ownership: null,
    note: filmNote(film, frame, look),
  };
}

export function filmNote(film, frame, show = "both") {
  const count = frameCount(film);
  const at = clampFrame(film, frame ? film.frames.indexOf(frame) : 0);
  const label = FILM_SHOW_LABELS[show] || FILM_SHOW_LABELS.both;
  const end = frame && frame.state && frame.state.over ? " — the film's last round" : "";
  return "Film round " + (frame ? Number(frame.round) || 0 : 0) + " of " + count +
    " (" + (at + 1) + "/" + count + " frames) · " + label + end;
}

// The replay's own line list: the events AS RECORDED, in the order they were recorded. This is the
// same array AC2 pins byte-identical to the live Log's source events, so the film's log cannot be a
// re-description: it is the stored objects, rendered.
export function filmEventRows(frame) {
  const events = frame && Array.isArray(frame.events) ? frame.events : [];
  return events.map((event) => ({
    type: String(event && event.type ? event.type : "event"),
    round: Number(event && event.round !== undefined ? event.round : frame && frame.round) || 0,
    text: String((event && (event.note || event.type)) || "event"),
  }));
}

// Transport: one step either way, clamped; speed cycles over a fixed table so the page cannot invent a
// playback rate the tests did not pin.
export const FILM_SPEEDS = Object.freeze([0.5, 1, 2, 4]);

export function nextSpeed(speed) {
  const at = FILM_SPEEDS.indexOf(Number(speed));
  return FILM_SPEEDS[(at + 1 + FILM_SPEEDS.length) % FILM_SPEEDS.length] || 1;
}

export function stepFilm(film, delta) {
  if (!film) return film;
  film.at = clampFrame(film, (Number(film.at) || 0) + (Number(delta) || 0));
  film.playing = false;
  return film;
}

export function toggleShow(film, show) {
  if (!film || !FILM_SHOWS.includes(show)) return film;
  film.show = show;
  return film;
}

// The milliseconds between frames at a speed. 1x is one frame per second: a 400-round war is a
// 6-7 minute watch at 1x and under two at 4x, which is what the original's speed control was for.
export function frameDelayMs(speed) {
  const value = Number(speed);
  const safe = FILM_SPEEDS.includes(value) ? value : 1;
  return Math.round(1000 / safe);
}

// ---- §4 (i): the digest the player can check -----------------------------------------------
//
// The server records `final_digest` = sha256 over the canonical final state, and the closing frame
// carries that same state. A replay is honest only if the frame the player lands on still hashes to
// the digest the header recorded - otherwise the film and the header disagree and nobody would ever
// see it. The page therefore recomputes the digest from the LAST frame in the browser and shows the
// result. Canonical JSON here is the server's own rule (object keys sorted at every depth), written
// out again because the page cannot import the server module.
export function canonicalJson(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      const out = {};
      for (const key of Object.keys(item).sort()) out[key] = sort(item[key]);
      return out;
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export async function digestOf(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// What the last frame says against what the header recorded. `ok` is only true when a digest was
// expected AND a closing state exists AND the two agree; every other shape is a sentence, never a
// silent pass - a replay with no closing frame must not read as "verified".
export async function digestCheck(film) {
  const meta = (film && film.meta) || {};
  const expected = meta.finalDigest || meta.final_digest || null;
  const frames = Array.isArray(film && film.frames) ? film.frames : [];
  const last = frames.length ? frames[frames.length - 1] : null;
  if (!expected) {
    return { ok: false, expected: null, actual: null, reason: "this film recorded no end digest" };
  }
  if (!last || !last.state) {
    return { ok: false, expected, actual: null, reason: "the last frame carries no closing state" };
  }
  const actual = await digestOf(last.state);
  return {
    ok: actual === expected,
    expected,
    actual,
    reason: actual === expected ? "the last frame matches the recorded digest"
      : "the last frame does not hash to the recorded digest",
  };
}

export function digestText(check) {
  if (!check) return "digest unread";
  if (check.ok) return "digest verified";
  if (check.actual) return "DIGEST MISMATCH";
  return "digest unverified";
}

// ---- §4 (ii): save a film to a file, and load one back -------------------------------------
//
// The file is the whole film: the recorded start state, every frame (including the closing one with
// its state), the header's identity and its final digest. Load re-derives the digest from the last
// frame, so a film that was edited on disk cannot pass as the war it claims to be. The format string
// and version are checked before anything is trusted.
export const FILM_FILE_FORMAT = "openchq.film";
export const FILM_FILE_VERSION = 1;

export function filmFileName(film) {
  const id = String((film && film.meta && film.meta.id) || "war");
  const era = String((film && film.meta && film.meta.era) || "").replace(/[^0-9A-Za-z_-]/g, "");
  return "openchq-" + (era ? era + "-" : "") + id.slice(0, 24) + ".film";
}

export function filmEnvelope(film) {
  if (!film || !film.meta) return null;
  const meta = film.meta;
  return {
    format: FILM_FILE_FORMAT,
    version: FILM_FILE_VERSION,
    savedAt: new Date().toISOString(),
    film: {
      meta: {
        id: meta.id ?? null,
        era: meta.era ?? null,
        mode: meta.mode ?? null,
        blueUser: meta.blue_user ?? meta.blueUser ?? null,
        redUser: meta.red_user ?? meta.redUser ?? null,
        startedAt: meta.started_at ?? meta.startedAt ?? null,
        endedAt: meta.ended_at ?? meta.endedAt ?? null,
        winner: meta.winner ?? null,
        rounds: meta.rounds ?? null,
        finalDigest: meta.finalDigest ?? meta.final_digest ?? null,
      },
      start: film.start || null,
      frames: Array.isArray(film.frames) ? film.frames : [],
    },
  };
}

// A loaded film, or the sentence that says why the file was refused. Every refusal names the thing
// that is wrong with the FILE, because "could not open film" teaches the player nothing.
export function filmFromEnvelope(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return { error: "That file is not JSON, so it is not a film." };
  }
  if (!parsed || typeof parsed !== "object" || parsed.format !== FILM_FILE_FORMAT) {
    return { error: "That file is not an OpenCHQ film (no " + FILM_FILE_FORMAT + " marker)." };
  }
  if (Number(parsed.version) !== FILM_FILE_VERSION) {
    return { error: "That film is version " + String(parsed.version) + "; this build reads version " + FILM_FILE_VERSION + "." };
  }
  const body = parsed.film;
  if (!body || typeof body !== "object") return { error: "That film file has no film inside it." };
  const frames = Array.isArray(body.frames) ? body.frames : null;
  if (!frames || !frames.length) return { error: "That film has no frames." };
  const film = {
    meta: body.meta && typeof body.meta === "object" ? { ...body.meta } : {},
    start: body.start && typeof body.start === "object" ? body.start : {},
    frames,
    at: 0,
    playing: false,
    speed: 1,
    show: "both",
    file: true,
  };
  return { film };
}
