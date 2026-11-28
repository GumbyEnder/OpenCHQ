// PB-338: what a mission button SAYS.
//
// The Air dialog's own footer promises "the rounds shown", and the rounds were not shown: the
// number lived in the button's hover title only, and on a touch screen a title is nothing at all.
// Paradrop was worse than the rest - its title carries the rule's sentence ("the aircraft stays
// home and goes unready for N rounds"), so its button printed a label with no duration anywhere in
// sight (PM 10488 §2).
//
// The number is ALWAYS the briefing's `missions[].rounds` - the field the server charges the order
// against - so the page cannot print a duration the mission does not cost. It is never a literal
// typed into the page: the config's 8 and 4 reach here through the seat payload and nowhere else.
//
// ONE producer for both doors. The Air dialog and the Kit panel's mission row are two views of the
// same missions[] rows; before this they agreed on the mission name and disagreed on the price
// ("Strike" versus "Strike (8r)"), which is how the Air door ended up with no figure at all.
export const MISSION_ROUNDS_MARK = " \u00b7 ";

export function missionButtonLabel(mission) {
  const label = String((mission && mission.label) || "").trim();
  const rounds = Number(mission && mission.rounds);
  if (!label) return "";
  // A transfer priced at 0 is a free rebase, which is what the file says (config air.transferRounds
  // is a stand-in, UNVERIFIED). Printing "\u00b7 0" would read as a cost of zero rounds rather than
  // as "this file prices it at nothing", so the mark only appears when there is a duration to show.
  return Number.isFinite(rounds) && rounds > 0 ? label + MISSION_ROUNDS_MARK + rounds : label;
}
