// One deterministic generator, shared rather than copied.
//
// The original rolls rnd(100) for the nuclear rules (income 5n%, winter 100/(20-n)); a bare
// Math.random() would make a test un-repeatable and a reload disagree with the round it replays.
// capitals.mjs needed the same generator for the rolled-capital draw, so the arithmetic lives here
// once and both callers read it: mulberry32 for a stream, draw() for a single step off a state
// number that a match object can carry in JSON.

export function draw(state) {
  const next = (Number(state) + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: next, value };
}

// A stream. Same seed, same sequence: a rolled era must be reproducible in a test and in a replay.
export function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    const step = draw(state);
    state = step.state;
    return step.value;
  };
}

// A string or number as a 32-bit seed. FNV-1a, so an era name ("1986") is a stable seed too.
export function seedOf(value) {
  if (Number.isInteger(value)) return value >>> 0;
  const text = String(value === undefined || value === null ? "" : value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
