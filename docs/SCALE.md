# Scale: what one box does, and when it stops

Measured on this machine (DellT2, 2x Arc Pro B70 box, Node 25), against the code as it stands.
Anything here without a measurement beside it is a plan, not a fact.

## The numbers

| What | 1,000 live rooms | Source |
| --- | --- | --- |
| One round pass (tick every room) | 9.79 ms | `node tools/bench-rooms.mjs 1000` |
| Tick alone (no store) | 9.15 ms | same |
| Store slice, 1/15 of rooms per round | 0.6 ms | same |
| Full snapshot of all 1,000 rooms (pause/drain path, not a round) | 9.97 ms | same |
| Heap per room, 8 pieces | 44 KB | `node --expose-gc local/scale-numbers.mjs 1000` |
| Heap per room, 40 pieces a side (a real 1986 board) | 114 KB | `... 1000 5.7 40` |
| Heap for 1,000 rooms at 40 pieces a side | 111 MB | same |
| Whole frame per seat, 8 pieces / 40 pieces | 32.8 KB / 60.2 KB | same |
| Egress, 1,000 rooms x 2 seats, whole frames every 5 s | 12.5 / 23.0 MB/s | same |
| Egress, same, with deltas | 2.2 / 4.0 MB/s | same (5.7x measured in `local/delta-cost.mjs`) |

A round is 5 s (`config/game.json`). A 9.8 ms pass every 5,000 ms is 0.2% of one core, so the CPU
ceiling is not the thing that stops this box. Memory is not either: 1,000 rooms at 40 pieces a side is 111 MB of heap beside a SQLite file. The
first real ceiling is egress: 4.0 MB/s with deltas at 1,000 full 1986 boards, 23 MB/s without
them. That is the number to watch on a bill.

The practical limit of one instance today is therefore **not** computing a round. It is the single
SQLite writer: one process owns `/data/openchq.sqlite`, so a second instance pointed at the same
volume would fight it, and a second instance on a different volume would not see the same rooms.

## Decision: one instance, until a measured reason says otherwise

The requirement is 1,000 concurrent games. One instance carries that with headroom on every
resource measured. A second instance now would buy nothing and would cost correctness: rooms are
authoritative rows in one file, and two writers over one file is a bug factory.

The edge cases one instance must survive are already built:

- **A deploy** no longer drops a match: SIGTERM drains, writes every room, marks the running ones
  to resume, tells the seats, and the page reconnects by itself.
- **A disconnect** pauses rather than destroys (`holdRoom`); the seat stays reserved for the account.
- **An unwatched room** costs nothing: a held pass over 1,000 rooms is 0.009 ms and zero writes.
- **A crash** loses at most the rounds since the last store slice (a room is written within 15
  rounds, measured).

## When to go multi-instance, and how

Triggers, in order of likelihood:

1. **Egress, not CPU.** If bandwidth billing or a provider cap becomes the constraint, deltas
   already cut it 5.7x; the next lever is sending rate (`FULL_EVERY`, and skipping rounds a seat
   cannot see).
2. **Heap or round latency** above 50% of a round's budget at the target room count.
3. **A second region** for latency, which is a different problem from capacity.

The path, with the parts that exist marked:

- Move rooms from SQLite to a shared store (Postgres, or SQLite per shard with a router). The
  store's interface is already narrow: `saveRoom`, `loadRooms`, `pruneRooms`, and a room is one
  row of JSON state. That is the whole migration surface. (exists: the interface)
- Give each room an owner instance and a lease, so exactly one process ticks it. A room's tick is
  already a pure function of `match`; the lease is the new part.
- Route a player's socket to the room's owner (sticky by room id at the edge). `{op:"sync"}` already
  lets a page rebuild its board from a full frame, so a re-route costs one frame, not a match.
- Keep the drain we built: it is the same operation that makes a rolling deploy safe.

## What is deliberately not measured yet

- Real players. The rooms above are synthetic: the site table is the real 1986 board (269 sites),
  but the pieces are 40 per side in a straight line, not a fought-out match with routes, transports
  and aircraft. Re-run `local/scale-numbers.mjs` against a room taken from a played game before
  quoting these numbers to anyone.
- The database under a burst of simultaneous writes (1,000 rooms all pausing at once). The bench's
  snapshot path measures the operation, not the contention.
