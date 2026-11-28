// PB-326: the Save Game list is also the Overwrite picker (manual p.36 l.1143 - "you may pick an
// existing title in this list to overwrite it").
//
// The page has ONE producer for the overwrite prompt. A row click and a typed duplicate title both
// route through `saveRowPick`, so the two paths cannot drift into different sentences or into a
// second dialog. The page fills #saveName and #saveConfirmText from this module;
// web/test/nodes/pb326_save_row_pick.mjs imports the same functions, so the sentence the node test
// pins is the sentence the browser paints.
//
// A row is a NAME and a prompt. The slot id is not in either: the list is player-facing, and an
// overwrite that shows a raw id in the confirm tells the player nothing about their war.

// The sentence a duplicate title reaches, whether it was typed or picked. `meta` is the row's own
// summary line (era, round, players, purse), so the confirm names the war the player is looking at.
export function overwriteSentence(name, meta) {
  return "A saved war named \"" + String(name) + "\" already exists (" + String(meta) + "). Overwrite it with this round?";
}

// What picking a row does: the title goes into the name field, the same sentence goes into the
// confirm. `slot` only needs a name; `meta` is captured at paint time so the prompt quotes the row
// the player clicked even if the list is re-read behind the panel.
export function saveRowPick(slot, meta) {
  const name = String(slot && slot.name !== undefined ? slot.name : "");
  return { name, sentence: overwriteSentence(name, meta) };
}
