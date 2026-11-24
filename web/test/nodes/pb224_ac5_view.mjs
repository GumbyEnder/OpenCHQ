// PB-224 AC5: the opponent's satellite is visible - on the seat's payload AND on the Show
// Satellites layer the page draws.
// One file per AC (PM 8918 §2 / 8919 §3): this label carries AC5 and nothing else.
//
// Manual p.12 L326-328: you see your satellite (in blue) over the Atlantic AND the red one over
// Europe; p.29 L924: Show Satellites draws the insert box. Both sides' orbits are public, which is
// why view.satelliteView is not filtered by seat.
//
// The lobby ROOM frame is a separate arm (pb224_satellite_room): this one is green under a roomView
// that drops `satellites`, and that is exactly the defect the room arm exists for.
//
// What fails if this is removed: a frame that hides the opponent's orbit, a ring drawn per pixel
// radius instead of per satellite, or an insert box with no heading or fuel stops being caught.

import { forSeat } from "../../server/view.mjs";
import { buySatellite, orderSatellite, tickSatellites } from "../../server/satellite.mjs";
import { paintSatelliteInset, paintSatelliteRings } from "../../public/render.mjs";
import { VIEW, fresh, makeAsserts, recordingCtx } from "../pb224_helpers.mjs";

export const name = "pb224_ac5_view";

export async function run() {
  const t = makeAsserts(name);
  const match = fresh();
  const blue = buySatellite(match, "blue", 60, 30);
  const red = buySatellite(match, "red", 260, 100);
  if (blue.error || red.error) t.fail("a satellite was refused: " + (blue.error || red.error));

  const blueSees = forSeat(match, "blue").satellites.map((sat) => sat.id).sort();
  const redSees = forSeat(match, "red").satellites.map((sat) => sat.id).sort();
  t.eq("blue sees both satellites (manual p.12: the blue one and the red one)", blueSees,
    [blue.satellite.id, red.satellite.id].sort());
  t.eq("red sees both satellites", redSees, [blue.satellite.id, red.satellite.id].sort());
  t.ok("no satellite id is missing", !blueSees.some((id) => String(id).includes("undefined")));

  // The Show Satellites layer: one ring per satellite, and the insert box names each one's fuel.
  const painter = recordingCtx();
  const rings = paintSatelliteRings(painter, forSeat(match, "blue").satellites, VIEW, {});
  t.eq("one ring per satellite", rings, 2);
  t.eq("each ring is one arc", painter.calls.arcs, 2);
  const box = recordingCtx();
  const rows = paintSatelliteInset(box, forSeat(match, "blue").satellites, VIEW, {});
  t.eq("the insert box lists every satellite", rows, 2);
  t.ok("the insert box has a heading", box.calls.text.includes("SATELLITES"));
  const joined = box.calls.text.join(" ");
  t.ok("the insert box names both sides", joined.includes("blue") && joined.includes("red"));
  t.ok("the insert box carries fuel", /fuel \d+\/\d+/.test(joined));

  // A satellite that moved is at its new cell in the frame, and the ring follows the payload.
  const movedOrder = orderSatellite(match, "blue", blue.satellite.id, 80, 30);
  if (movedOrder.error) t.fail("the Show Satellites move was refused: " + movedOrder.error);
  tickSatellites(match);
  const moved = forSeat(match, "blue").satellites.find((sat) => sat.id === blue.satellite.id);
  t.eq("the frame carries the satellite's new cell", [moved.x, moved.y], [blue.satellite.x, blue.satellite.y]);

  console.log(t.line());
}
