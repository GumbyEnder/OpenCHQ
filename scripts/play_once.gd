extends SceneTree

var _failures: PackedStringArray = []
var _shot_dir := ""


func _init() -> void:
	call_deferred("_play")


func _play() -> void:
	_shot_dir = OS.get_environment("OPENCHQ_EVIDENCE")
	if _shot_dir == "":
		_shot_dir = OS.get_user_data_dir().path_join("play")
	DirAccess.make_dir_recursive_absolute(_shot_dir)
	var packed: PackedScene = load("res://scenes/main.tscn")
	var main: Variant = packed.instantiate()
	root.add_child(main)
	if not await _wait_ready(main):
		_finish()
		return
	if not await _pass_start(main):
		_finish()
		return
	if not await _opening(main, "opening.png"):
		_finish()
		return
	if not await _win(main):
		_finish()
		return
	if not await _city_states(main):
		_finish()
		return
	if not await _year_2023(main):
		_finish()
		return
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the garrison win did not restore the opening")
		_finish()
		return
	_ok("R restored the opening after the garrison win")
	if not await _capture_toronto(main):
		_finish()
		return
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset did not restore the opening")
	else:
		_ok("R restored the opening view")
	if not await _transport(main):
		_finish()
		return
	if not await _intel(main):
		_finish()
		return
	if not await _match_buy(main):
		_finish()
		return
	if not await _entrench(main):
		_finish()
		return
	if not await _stills(main):
		_finish()
		return
	if not await _menu_keys(main):
		_finish()
		return
	if not await _camera(main):
		_finish()
		return
	if not await _board(main):
		_finish()
		return
	await _press(main, KEY_R)
	await process_frame
	if not await _contact(main):
		_finish()
		return
	if not await _pass_through(main):
		_finish()
		return
	if not await _still_sub(main):
		_finish()
		return
	if not await _air_mission(main):
		_finish()
		return
	if not await _drop_overrun(main):
		_finish()
		return
	if not await _repair(main):
		_finish()
		return
	if not await _foreign_aid(main):
		_finish()
		return
	if not await _nuke(main):
		_finish()
		return
	if not await _satellites(main):
		_finish()
		return
	if not await _cease_fire(main):
		_finish()
		return
	if not await _speed_index(main):
		_finish()
		return
	if not await _stand_ins(main):
		_finish()
		return
	if not await _polish(main):
		_finish()
		return
	await _press(main, KEY_R)
	await process_frame
	await _phone(main)
	_finish()


func _wait_ready(main: Variant) -> bool:
	for _i in 40:
		await process_frame
		if main.get("map") != null and main.map.view_scale > 0.0 and main.game != null and main.game.beat == 0:
			return true
	_fail("game never reached the opening view")
	return false


func _pass_start(main: Variant) -> bool:
	var screen: Control = main.start_screen
	if screen == null or not screen.visible or main.map.visible or main.hud.visible:
		_fail("start screen should cover the map until Start")
		return false
	var era := _find_option(screen, 1986)
	var side := _find_option(screen, 1)
	if era == null or side == null or _find_button(screen, "Start") == null:
		_fail("start screen is missing the era, the side, or Start")
		return false
	var names := PackedStringArray()
	for i in side.item_count:
		names.append(side.get_item_text(i))
	if side != _find_option(screen, 2) or not names.has("Blue") or not names.has("Red"):
		_fail("start screen should offer Blue and Red")
		return false
	if era.get_item_id(era.selected) != 1986 or side.get_item_id(side.selected) != 1:
		_fail("start screen should open on 1986 and Blue")
		return false
	var era_text := _node_text(screen)
	if not era_text.contains("1986 adds oil, nukes, satellites, aid, and intel."):
		_fail("the 1986 era card is missing: %s" % era_text)
		return false
	for i in era.item_count:
		if era.get_item_id(i) == 9999:
			era.select(i)
			era.item_selected.emit(i)
			break
	await process_frame
	if not _node_text(screen).contains("The concealed start hides the opponent until their capital is found."):
		_fail("the concealed era card is missing")
		return false
	for i in era.item_count:
		if era.get_item_id(i) == 1986:
			era.select(i)
			era.item_selected.emit(i)
			break
	await process_frame
	_find_button(screen, "Start").pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	if screen.visible or not main.buying or buy == null or not buy.visible or not main.map.visible or main.hud.visible:
		_fail("Start should open Purchase New Units on the map")
		return false
	if _find_button(buy, "Begin") == null or _find_label(buy, "Purchase New Units") == null:
		_fail("the buy screen is missing Purchase New Units or Begin")
		return false
	var infantry := _find_button(buy, "Infantry")
	if infantry == null:
		_fail("the buy screen is missing Infantry")
		return false
	infantry.pressed.emit()
	await process_frame
	var norfolk := _site(main, "Norfolk")
	if norfolk.is_empty():
		_fail("Norfolk is not on the map")
		return false
	var hold_at: Vector2 = main.map.cell_center(int(norfolk["x"]), int(norfolk["y"]))
	if not main.map.sees(hold_at):
		_fail("Norfolk is off the buy view")
		return false
	await _click_world(main, hold_at)
	var bought := false
	for unit in main.game.tokens:
		if unit == main.game.token("blue") or unit.domain == "sea" or unit.side != "blue":
			continue
		if unit.x == int(norfolk["x"]) and unit.y == int(norfolk["y"]):
			bought = true
	if not bought or not str(main.game.note).contains("Stand-in price") or str(main.game.note).contains("$"):
		_fail("the second land piece was not placed at Norfolk: %s" % main.game.note)
		return false
	_ok("bought a second land piece at Norfolk to hold the capital")
	_find_button(buy, "Begin").pressed.emit()
	await process_frame
	if buy.visible or not main.started or not main.map.visible or not main.hud.visible:
		_fail("Begin did not start the match")
		return false
	if main.era_year != 1986 or main.player_side != "blue" or main.time_on or main.game.beat != 0:
		_fail("Start changed the opening (era %s side %s time %s beat %s)" % [main.era_year, main.player_side, main.time_on, main.game.beat])
		return false
	_ok("start screen hid the map until Start")
	var coach_text := _board_text(main)
	if not coach_text.contains("Select your piece.") or not coach_text.contains("Click a destination.") or not coach_text.contains("Press Run."):
		_fail("the coach lines are missing")
		return false
	var dismiss := _find_button(main, "Dismiss")
	if dismiss == null:
		_fail("the coach is missing Dismiss")
		return false
	dismiss.pressed.emit()
	await process_frame
	if main.coach.visible:
		_fail("Dismiss left the coach up")
		return false
	_ok("the coach reads three lines and dismisses")
	return true


func _opening(main: Variant, shot: String) -> bool:
	var wash := _site(main, "Washington")
	var moscow := _site(main, "Moscow")
	var blue = main.game.token("blue")
	var red = main.game.token("red")
	var chip: String = main.map._chip_labels["terrain"].text
	var bad := false
	if main.time_on or main.era_year != 1986 or main.atlas.visible or not main.oil.visible:
		bad = true
	if main.labels_on or not main.pixel_filter or main.game.beat != 0 or main.game.winner() != "":
		bad = true
	if main.game.selected_side != "" or chip != "—":
		bad = true
	var mine_land = main.game.token(main.player_side)
	var mine_ship = main.game.sea_token(main.player_side)
	var other := "red" if main.player_side == "blue" else "blue"
	if mine_land == null or mine_ship == null:
		bad = true
	elif not main.map.marked_piece(mine_land) or not main.map.marked_piece(mine_ship):
		bad = true
	elif main.map.marked_piece(main.game.token(other)) or main.map.marked_piece(main.game.sea_token(other)):
		bad = true
	elif main.map.is_near_fit():
		bad = true
	elif not main.map.sees(main.map.cell_center(mine_land.x, mine_land.y)):
		bad = true
	elif not main.map.sees(main.map.cell_center(mine_ship.x, mine_ship.y)):
		bad = true
	if wash.is_empty() or moscow.is_empty() or blue == null or red == null:
		bad = true
	elif blue.x != int(wash["x"]) or blue.y != int(wash["y"]) or red.x != int(moscow["x"]) or red.y != int(moscow["y"]):
		bad = true
	elif str(wash["owner"]) != "blue" or str(moscow["owner"]) != "red":
		bad = true
	if main.sites.count() != 84:
		bad = true
	if main.map.texture_filter != CanvasItem.TEXTURE_FILTER_NEAREST:
		bad = true
	if main.hud.texture_filter != CanvasItem.TEXTURE_FILTER_LINEAR:
		bad = true
	var board := _board_text(main)
	if board.contains("Command HQ") or board.to_lower().contains("production") or board.contains("$"):
		bad = true
	if bad:
		_fail("opening view drifted (era %s atlas %s oil %s labels %s pixel %s chip %s zoom %s beat %s)" % [
			main.era_year, main.atlas.visible, main.oil.visible, main.labels_on, main.pixel_filter, chip, main.map.zoom_text(), main.game.beat,
		])
		return false
	_ok("opening view fitted, beat 0, time held, 84 sites, oil on, no prices or rates")
	if shot != "":
		await _save(main, shot)
	return _failures.is_empty()


func _capture_toronto(main: Variant) -> bool:
	var wash := _site(main, "Washington")
	var toronto := _site(main, "Toronto")
	await _click_world(main, main.map.cell_center(int(wash["x"]), int(wash["y"])))
	if main.game.selected_side != "blue":
		_fail("click on Washington did not select Blue")
		return false
	_ok("click selected Blue")
	await _click_world(main, main.map.cell_center(int(toronto["x"]), int(toronto["y"])))
	var blue = main.game.token("blue")
	if blue.path.is_empty() or not str(main.game.note).contains("moving") or main.game.beat != 0 or blue.x != int(wash["x"]):
		_fail("Toronto order did not queue while time was held: %s" % main.game.note)
		return false
	_ok("order toward Toronto while time is held")
	await _press(main, KEY_T)
	if not main.time_on:
		_fail("T did not start the clock")
		return false
	_ok("T started the one running speed")
	var captured := false
	for _i in 40:
		await create_timer(0.14).timeout
		if str(toronto["owner"]) == "blue":
			captured = true
			break
	var red = main.game.token("red")
	var shown: int = MatchState.visible_steps(red.path, "red").size()
	if not captured or main.game.winner() != "" or not str(main.hud._note.text).contains("took"):
		_fail("Toronto capture resolved wrong: %s" % main.game.note)
		return false
	if red.path.size() <= 3 or shown != 3:
		_fail("Red's route should keep marching and draw three steps")
		return false
	if str(main.hud._toast.text) != "City taken" and not main.game.toasts.has("City taken"):
		_fail("the city toast was missing: %s" % str(main.hud._toast.text))
		return false
	_ok("Blue took Toronto on the live clock, capitals still split")
	_ok("Red is marching and only three steps are drawn")
	await _hover_world(main, main.map.cell_center(int(toronto["x"]), int(toronto["y"])))
	if str(main.map._chip_labels["terrain"].text) != "city · open":
		_fail("hover did not name the painted city: %s" % str(main.map._chip_labels["terrain"].text))
		return false
	_ok("hover reads the painted city")
	_press_button(main, "Zoom to selection")
	await process_frame
	await RenderingServer.frame_post_draw
	if main.map.zoom_text() != "10% of width":
		_fail("zoom to selection landed on %s" % main.map.zoom_text())
		return false
	if not str(main.hud._card_title.text).contains("Toronto"):
		_fail("the site card did not name Toronto")
		return false
	_ok("zoomed to the selection (10% of width)")
	await _save(main, "capture.png")
	await _press(main, KEY_F)
	await process_frame
	if main.map.zoom_text() != "100% of width":
		_fail("fit returned %s" % main.map.zoom_text())
		return false
	_ok("F fits the whole map")
	return true


func _camera(main: Variant) -> bool:
	await _press(main, KEY_F)
	await process_frame
	var center := _viewport_of(main, main.map.size * 0.5)
	var before_zoom: String = main.map.zoom_text()
	for _i in 6:
		await _wheel(center, true)
	if main.map.zoom_text() == before_zoom or main.map.zoom_text() == "100% of width":
		_fail("wheel zoom did not leave the fitted view")
		return false
	var guard := 0
	while guard < 12:
		var raw: Vector2 = main.map.screen_to_world_raw(main.map.size * 0.5)
		if raw.x > main.map.logic_w or raw.x < 0.0:
			break
		var from := _viewport_of(main, Vector2(main.map.size.x - 40.0, main.map.size.y * 0.5))
		var to := _viewport_of(main, Vector2(40.0, main.map.size.y * 0.5))
		await _drag(from, to)
		guard += 1
	var seam: Vector2 = main.map.screen_to_world_raw(main.map.size * 0.5)
	if seam.x >= 0.0 and seam.x < main.map.logic_w:
		_fail("drag never crossed onto a wrapped copy")
		return false
	await _wheel(center, true)
	var after: Vector2 = main.map.screen_to_world_raw(main.map.size * 0.5)
	if absf(after.x - seam.x) > 1.0 or absf(after.y - seam.y) > 1.0:
		_fail("wheel zoom jumped the wrapped cell (%.1f, %.1f) -> (%.1f, %.1f)" % [seam.x, seam.y, after.x, after.y])
		return false
	var zoom_now: String = main.map.zoom_text()
	if zoom_now == "100% of width" or str(main.map._chip_labels["zoom"].text) != zoom_now:
		_fail("zoom label did not follow the wheel (%s vs %s)" % [str(main.map._chip_labels["zoom"].text), zoom_now])
		return false
	_ok("seam wheel kept the unwrapped cell under the cursor")
	await _save(main, "seam.png")
	var picked: Dictionary = _site_on_screen(main)
	if picked.is_empty():
		_fail("no original site was visible on the wrapped copy")
		return false
	await _click_world(main, picked["world"])
	var place: Dictionary = picked["place"]
	if int(main.sites.selected_id) != int(place["id"]) or str(main.hud._card_title.text) != str(place["title"]):
		_fail("wrapped click did not pick %s" % str(place["title"]))
		return false
	_ok("drag across the wrap still picks the site")
	return true


func _board(main: Variant) -> bool:
	await _press(main, KEY_F)
	await process_frame
	if not await _terrain_words(main):
		return false
	var oil_now: int = main.oil.count()
	_choose(main, 1918)
	await process_frame
	if main.era_year != 1918 or main.oil.visible or main.oil.count() >= oil_now:
		_fail("1918 should hide the later oil fields")
		return false
	var oil_button := _find_button(main.hud, "Oil")
	if oil_button != null and oil_button.visible:
		_fail("the oil control should be hidden before 1986")
		return false
	var intel := _find_button(main.hud, "Intel")
	if intel != null and intel.visible:
		_fail("Intel should be absent in 1918")
		return false
	await _press(main, KEY_O)
	if main.oil.visible:
		_fail("oil responded before 1986")
		return false
	if not _board_text(main).contains("Infantry"):
		_fail("1918 should say the infantry frame is missing")
		return false
	_ok("era 1918 hides oil and the control does nothing")
	_choose(main, 1986)
	await process_frame
	if main.era_year != 1986 or not main.oil.visible or main.oil.count() < oil_now:
		_fail("1986 should show the oil fields again")
		return false
	var field := _oil_world(main)
	if field.x < 0.0:
		_fail("no oil field could be picked")
		return false
	await _click_world(main, field)
	var card := str(main.hud._card_body.text)
	if not card.contains("Rate unknown") or card.to_lower().contains("production"):
		_fail("oil card should say the rate is unknown: %s" % card)
		return false
	_ok("era 1986 shows oil and the rate is unknown")
	if main.hud._atlas_row.visible or main.atlas.visible:
		_fail("atlas should stay off until asked")
		return false
	var tier_one: int = main.atlas.count()
	await _press(main, KEY_A)
	await process_frame
	if not main.atlas.visible or not main.hud._atlas_row.visible:
		_fail("atlas did not open its tier control")
		return false
	_choose(main, 3)
	await process_frame
	if main.atlas.max_tier != 3 or main.atlas.count() < tier_one:
		_fail("atlas tier did not apply while atlas was on")
		return false
	var higher := false
	for city in main.atlas.all:
		if city is Dictionary and int(city.get("tier", 1)) > 1 and not bool(city.get("skip", false)):
			higher = true
			break
	if higher and main.atlas.count() <= tier_one:
		_fail("a wider atlas tier showed no more capitals")
		return false
	await _press(main, KEY_A)
	await process_frame
	if main.atlas.visible or main.hud._atlas_row.visible:
		_fail("atlas tier row should hide when atlas is off")
		return false
	_ok("atlas tier applies only while atlas is on")
	await _press(main, KEY_F)
	await process_frame
	if main.map._show_name(false, false):
		_fail("labels were already forced at the fitted view")
		return false
	await _press(main, KEY_L)
	await process_frame
	if not main.labels_on or not main.map.labels_on or not main.map._show_name(false, false):
		_fail("labels did not name sites, atlas, and oil together")
		return false
	_ok("labels name sites, atlas, and oil together")
	await _press(main, KEY_L)
	_choose(main, 1)
	await process_frame
	if main.map.texture_filter != CanvasItem.TEXTURE_FILTER_LINEAR:
		_fail("smooth did not change the map filter")
		return false
	if main.hud.texture_filter != CanvasItem.TEXTURE_FILTER_LINEAR or main.map._note.texture_filter != CanvasItem.TEXTURE_FILTER_LINEAR:
		_fail("smooth changed the UI text filter")
		return false
	_ok("smooth filter is linear and the hud stays linear")
	_choose(main, 0)
	await process_frame
	if main.map.texture_filter != CanvasItem.TEXTURE_FILTER_NEAREST:
		_fail("pixel did not restore the map filter")
		return false
	if main.hud.texture_filter != CanvasItem.TEXTURE_FILTER_LINEAR:
		_fail("pixel changed the hud filter")
		return false
	_ok("pixel filter is nearest and the hud stays linear")
	return true


func _terrain_words(main: Variant) -> bool:
	var want := {"forest": "slow", "mountain": "slow", "jungle": "slow", "shallows": "slow", "ocean": "transport", "lake": "transport"}
	var found := {}
	for y in TerrainMap.CELL_H:
		for x in TerrainMap.CELL_W:
			var tid := int(main.terrain.id_at(x, y))
			var name := TerrainMap.terrain_name(tid)
			if want.has(name) and not found.has(name):
				found[name] = Vector2i(x, y)
		if found.size() == want.size():
			break
	for name in want.keys():
		if not found.has(name):
			_fail("the map has no %s cell" % name)
			return false
		var cell: Vector2i = found[name]
		await _hover_world(main, main.map.cell_center(cell.x, cell.y))
		var chip: String = main.map._chip_labels["terrain"].text
		var expected := "%s · %s" % [name, str(want[name])]
		if chip != expected or _has_digit(chip):
			_fail("terrain chip '%s' should be '%s' with no ratio" % [chip, expected])
			return false
	var help := _board_text(main)
	if not help.contains("shallows are slower") or not help.contains("ratio was not recovered"):
		_fail("the board should name the slower ground without a ratio")
		return false
	if help.contains("one extra") or help.contains("beats"):
		_fail("the board states a numeric pace")
		return false
	_ok("terrain chips name the manual paces and give no ratio")
	return true


func _contact(main: Variant) -> bool:
	await _press(main, KEY_T)
	if not main.time_on:
		_fail("T did not start the contact watch")
		return false
	var stepped := ""
	for _i in 260:
		await create_timer(0.14).timeout
		var blue = main.game.token("blue")
		var red = main.game.token("red")
		if blue.x == red.x and blue.y == red.y:
			_fail("the pieces occupied one cell")
			return false
		if str(main.game.note).contains("damage amounts unknown"):
			stepped = str(main.game.note)
			break
	if main.time_on:
		await _press(main, KEY_T)
	if stepped == "" or main.time_on:
		_fail("red never stopped short of Blue: %s" % main.game.note)
		return false
	_ok("stepping onto the other piece stops short")
	var red = main.game.token("red")
	var wash := _site(main, "Washington")
	await _click_world(main, main.map.cell_center(int(wash["x"]), int(wash["y"])))
	# At the fitted view one cell is a few pixels, so Blue's hit target also covers Red.
	# A human zooms in before clicking the adjacent piece.
	_press_button(main, "Zoom to selection")
	await process_frame
	await RenderingServer.frame_post_draw
	await _click_world(main, main.map.cell_center(red.x, red.y))
	var blue = main.game.token("blue")
	var said := str(main.hud._note.text)
	var stopped_note := str(main.game.note).contains("damage amounts unknown")
	var voice_ok := said.contains("damage amounts unknown") or said == Assumptions.FIGHT_VOICE
	if blue.path.size() != 0 or not stopped_note or not voice_ok:
		_fail("ordering onto the other piece did not stop short: %s / %s" % [main.game.note, said])
		return false
	if blue.x == red.x and blue.y == red.y:
		_fail("the pieces occupied one cell")
		return false
	_ok("ordering onto the other piece stops short")
	return true


func _pass_through(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the cross did not restore the opening")
		return false
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null:
		_fail("Buy is missing before the cross")
		return false
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	var infantry := _find_button(buy, "Infantry")
	if infantry == null:
		_fail("the catalog is missing Infantry for the cross")
		return false
	infantry.pressed.emit()
	await process_frame
	var nyc := _site(main, "New York")
	if nyc.is_empty():
		_fail("New York is not on the map")
		return false
	var nyc_at: Vector2 = main.map.cell_center(int(nyc["x"]), int(nyc["y"]))
	if not await _aim(main, nyc_at):
		_fail("New York is off the map")
		return false
	await _click_world(main, nyc_at)
	var foot = null
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.label == "Infantry":
			foot = unit
			break
	if foot == null:
		_fail("the cross did not buy a second piece: %s" % main.game.note)
		return false
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("Close is missing after the cross purchase")
		return false
	close.pressed.emit()
	await process_frame
	var capital = main.game.token("blue")
	if not await _select_land(main, capital):
		_fail("could not select the capital piece for the cross")
		return false
	var west: Vector2 = main.map.cell_center(76, 44)
	if not await _aim(main, west):
		_fail("the west cell is off the map")
		return false
	await _click_world(main, west)
	if capital.path.is_empty():
		_fail("the capital piece was not ordered west: %s" % main.game.note)
		return false
	if not await _until(main, func() -> bool: return capital.x == 76 and capital.y == 44, 30):
		_fail("the capital piece did not reach the west cell")
		return false
	if not await _select_land(main, foot):
		_fail("could not select the second piece")
		return false
	var stand: Vector2 = main.map.cell_center(80, 44)
	if not await _aim(main, stand):
		_fail("the stand cell is off the map")
		return false
	await _click_world(main, stand)
	if foot.path.is_empty():
		_fail("the second piece was not ordered to the stand: %s" % main.game.note)
		return false
	if not await _until(main, func() -> bool: return foot.x == 80 and foot.y == 44, 40):
		_fail("the second piece did not reach the stand")
		return false
	if not await _select_land(main, capital):
		_fail("could not reselect the capital piece")
		return false
	if not await _click_aside(main, 80, 44):
		return false
	if capital.x != 76 or capital.y != 44 or not capital.path.is_empty() or foot.x != 80 or foot.y != 44:
		_fail("the refused stop moved a piece")
		return false
	if not str(main.hud._note.text).contains("Two units cannot stop on the same cell."):
		_fail("the stop was not refused: %s" % main.hud._note.text)
		return false
	var east: Vector2 = main.map.cell_center(81, 44)
	if not await _aim(main, east):
		_fail("the east cell is off the map")
		return false
	await _click_world(main, east)
	if capital.path.is_empty():
		_fail("the cross order was refused: %s" % main.game.note)
		return false
	if not await _select_land(main, foot):
		_fail("could not reselect the second piece for the cross")
		return false
	var far: Vector2 = main.map.cell_center(75, 44)
	if not await _aim(main, far):
		_fail("the far cell is off the map")
		return false
	await _click_world(main, far)
	if foot.path.is_empty():
		_fail("the second cross order was refused: %s" % main.game.note)
		return false
	var seen_capital := {}
	var seen_foot := {}
	var stacked := false
	var arrived := false
	if not main.time_on:
		await _press(main, KEY_T)
	for _i in 80:
		await create_timer(0.05).timeout
		seen_capital["%d,%d" % [capital.x, capital.y]] = true
		seen_foot["%d,%d" % [foot.x, foot.y]] = true
		if capital.x == foot.x and capital.y == foot.y and capital.path.is_empty() and foot.path.is_empty():
			stacked = true
			break
		if capital.x == 81 and capital.y == 44 and foot.x == 75 and foot.y == 44:
			arrived = true
			break
	if main.time_on:
		await _press(main, KEY_T)
	var shared := false
	for key in seen_capital.keys():
		if seen_foot.has(key):
			shared = true
			break
	if stacked or not arrived or not shared or main.time_on:
		_fail("the pieces did not cross (shared %s arrived %s stacked %s at %d,%d and %d,%d)" % [shared, arrived, stacked, capital.x, capital.y, foot.x, foot.y])
		return false
	if capital.x == foot.x and capital.y == foot.y:
		_fail("the pieces stopped on one cell")
		return false
	_ok("two pieces crossed a cell, and a stop on the other was refused")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the cross did not restore the opening")
		return false
	return true


func _until(main: Variant, done: Callable, limit: int) -> bool:
	if not main.time_on:
		await _press(main, KEY_T)
	var ready := false
	for _i in limit:
		if done.call():
			ready = true
			break
		await create_timer(0.14).timeout
	if main.time_on:
		await _press(main, KEY_T)
	return ready and not main.time_on


func _click_aside(main: Variant, x: int, y: int) -> bool:
	var center: Vector2 = main.map.cell_center(x, y)
	var at: Vector2 = center + Vector2(36, 36)
	if not await _aim(main, at):
		_fail("the occupied cell is off the map")
		return false
	var guard := 0
	while main.map.marker_hit() * 1.35 >= 48.0 and guard < 8:
		var local := Vector2(main.map.pan_x + at.x * main.map.view_scale, main.map.pan_y + at.y * main.map.view_scale)
		await _wheel(main.map.position + local, true)
		await process_frame
		guard += 1
	if main.map.cell_of(at) != Vector2i(x, y) or at.distance_to(center) <= main.map.marker_hit() * 1.35:
		_fail("the stop click would hit the piece instead of the cell")
		return false
	await _click_world(main, at)
	return true


func _still_sub(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the submarine did not restore the opening")
		return false
	var red_dock := _dock_beside(main, "red")
	var blue_dock := _dock_beside(main, "blue")
	if red_dock.x < 0 or blue_dock.x < 0:
		_fail("a side has no dock for a submarine")
		return false
	var placed: String = main.game.place_purchase("red", "Submarine", red_dock.x, red_dock.y)
	if placed != "":
		_fail("the enemy submarine was not placed: %s" % placed)
		return false
	var red_sub = null
	for unit in main.game.tokens:
		if unit.side == "red" and unit.label == "Submarine":
			red_sub = unit
			break
	if red_sub == null or main.map.piece_drawn(red_sub):
		_fail("the still enemy submarine was not hidden")
		return false
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null:
		_fail("Buy is missing before the submarine")
		return false
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	var choice := _find_button(buy, "Submarine")
	if choice == null:
		_fail("the catalog is missing Submarine")
		return false
	choice.pressed.emit()
	await process_frame
	var dock_at: Vector2 = main.map.cell_center(blue_dock.x, blue_dock.y)
	if not await _aim(main, dock_at):
		_fail("the dock is off the map")
		return false
	await _click_world(main, dock_at)
	var sub = null
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.label == "Submarine":
			sub = unit
			break
	var note := str(main.game.note)
	if sub == null or sub.x != blue_dock.x or sub.y != blue_dock.y or not note.contains("stays hidden") or note.contains("$"):
		_fail("the submarine was not bought still: %s" % note)
		return false
	if not main.map.piece_drawn(sub) or not main.game.submarine_hidden(sub):
		_fail("the owner's still submarine should be marked hidden and stay on the map")
		return false
	if main.map.piece_drawn(red_sub):
		_fail("buying a submarine revealed the enemy one")
		return false
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("Close is missing after the submarine purchase")
		return false
	close.pressed.emit()
	await process_frame
	if not await _select_land(main, sub):
		_fail("could not select the submarine")
		return false
	var card := str(main.hud._card_body.text)
	if not card.contains("stays hidden") or card.contains("$") or _has_digit(card):
		_fail("the submarine card did not say it stays hidden: %s" % card)
		return false
	_ok("a still submarine is hidden")
	var scan := _find_button(main.hud, "Satellites")
	if scan == null or scan.disabled:
		_fail("Satellites should be a live scan in this era")
		return false
	var beat_before: int = main.game.beat
	scan.pressed.emit()
	await process_frame
	var scanned := str(main.game.note)
	if not scanned.contains("does not reveal a still submarine") or not scanned.contains("unknown") or scanned.contains("$") or _has_digit(scanned):
		_fail("the scan note is wrong: %s" % scanned)
		return false
	if red_sub.revealed or sub.revealed or main.map.piece_drawn(red_sub) or main.game.beat != beat_before:
		_fail("the scan revealed a still submarine")
		return false
	_ok("an air or satellite scan leaves a still submarine hidden")
	var intel := _find_button(main.hud, "Intel")
	if intel == null or intel.disabled:
		_fail("Intel should reveal the submarine")
		return false
	intel.pressed.emit()
	await process_frame
	var told := str(main.game.note)
	if told.find("reveals every unit") < 0 or told.contains("radius") or told.contains("$"):
		_fail("intel did not reveal the submarine: %s" % told)
		return false
	if not red_sub.revealed or not sub.revealed or not main.map.piece_drawn(red_sub) or not main.map.piece_drawn(sub):
		_fail("intel left a submarine hidden")
		return false
	if not await _select_land(main, sub):
		_fail("could not reselect the revealed submarine")
		return false
	var after := str(main.hud._card_body.text)
	if not after.contains("Revealed") or after.contains("stays hidden"):
		_fail("the submarine card did not show the reveal: %s" % after)
		return false
	_ok("intel reveals the still submarine")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the submarine did not restore the opening")
		return false
	for unit in main.game.tokens:
		if unit.label == "Submarine":
			_fail("reset left a submarine on the map")
			return false
	return true


func _dock_beside(main: Variant, side: String) -> Vector2i:
	for place in main.sites.places:
		if str(place.get("owner", "")) != side:
			continue
		var kind := str(place.get("kind", ""))
		if kind != "city" and kind != "capital" and kind != "base":
			continue
		var cx := int(place["x"])
		var cy := int(place["y"])
		for dy in range(-1, 2):
			for dx in range(-1, 2):
				if dx == 0 and dy == 0:
					continue
				var x := posmod(cx + dx, TerrainMap.CELL_W)
				var y := cy + dy
				if y < 0 or y >= TerrainMap.CELL_H:
					continue
				if int(main.terrain.id_at(x, y)) != 1:
					continue
				var taken := false
				for unit in main.game.tokens:
					if unit.x == x and unit.y == y:
						taken = true
						break
				if not taken:
					return Vector2i(x, y)
	return Vector2i(-1, -1)


func _air_mission(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the air mission did not restore the opening")
		return false
	var first = await _buy_craft(main, "New York")
	if first == null:
		return false
	if not await _select_land(main, first):
		_fail("could not select the first aircraft")
		return false
	var strike := _find_button(main.hud, "Land strike")
	if strike == null:
		_fail("Land strike is missing")
		return false
	strike.pressed.emit()
	await process_frame
	var red = main.game.token("red")
	var blue_land = main.game.token("blue")
	red.x = blue_land.x + 1
	red.y = blue_land.y
	var red_at: Vector2 = main.map.cell_center(red.x, red.y)
	if not await _aim(main, red_at):
		_fail("the land target is off the map")
		return false
	var home_x: int = first.x
	var home_y: int = first.y
	await _click_world(main, red_at)
	var flown := str(main.game.note)
	if not flown.contains("Land strike on Red land piece") or not flown.contains("damage was not recovered") or not flown.contains("range was not recovered") or not flown.contains("8 rounds"):
		_fail("the mission note is wrong: %s" % flown)
		return false
	if flown.contains("$") or flown.to_lower().contains("half") or flown.to_lower().contains("spaces") or first.idle_rounds != 8 or first.x != home_x or first.y != home_y:
		_fail("the mission invented damage or a range")
		return false
	var badge := str(main.map._badge.text)
	if not badge.contains("Inactive") or not badge.contains("8"):
		_fail("the aircraft badge missed the inactive rounds: %s" % badge)
		return false
	_ok("an aircraft mission goes inactive for 8 rounds")
	var reds: Array = _free_cities_play(main, "red")
	if reds.is_empty():
		_fail("no red city for the enemy mission")
		return false
	var foe = _craft_at_play(main, "red", reds[0])
	if foe == null:
		return false
	var enemy: String = main.game.fly_strike("red", foe, "land", main.game.token("blue"))
	if not enemy.contains("Land strike") or not main.game.enemy_mission("blue"):
		_fail("the enemy mission did not start: %s" % enemy)
		return false
	var second = await _buy_craft(main, "Boston")
	if second == null:
		return false
	if not await _select_land(main, second):
		_fail("could not select the scramble aircraft")
		return false
	var scramble := _find_button(main.hud, "Scramble")
	if scramble == null:
		_fail("Scramble is missing")
		return false
	scramble.pressed.emit()
	await process_frame
	var answered := str(main.game.note)
	if not answered.contains("Scramble answers the enemy mission") or not answered.contains("4 rounds") or not answered.contains("range was not recovered") or second.idle_rounds != 4:
		_fail("the scramble note is wrong: %s" % answered)
		return false
	if answered.contains("$") or answered.to_lower().contains("spaces"):
		_fail("the scramble invented a range")
		return false
	_ok("a scramble answers the enemy mission for 4 rounds")
	var third = await _buy_craft(main, "Chicago")
	if third == null:
		return false
	if not await _select_land(main, third):
		_fail("could not select the bomber")
		return false
	var bomb := _find_button(main.hud, "Bomb")
	if bomb == null:
		_fail("Bomb is missing")
		return false
	bomb.pressed.emit()
	await process_frame
	var toronto := _site(main, "Toronto")
	if toronto.is_empty():
		_fail("Toronto is not on the map")
		return false
	var at: Vector2 = main.map.cell_center(int(toronto["x"]), int(toronto["y"]))
	if not await _aim(main, at):
		_fail("Toronto is off the map")
		return false
	await _click_world(main, at)
	var bombed := str(main.game.note)
	var lock_key := "site:%d" % int(toronto["id"])
	if not bombed.contains("Bombed Toronto") or not bombed.contains("5 rounds") or not bombed.contains("amount taken was not recovered") or not bombed.contains("range was not recovered"):
		_fail("the bomb note is wrong: %s" % bombed)
		return false
	if main.game.build_left(lock_key) != 5 or str(toronto.get("owner", "")) == "" or third.idle_rounds != 8:
		_fail("the empty city did not lock building")
		return false
	if bombed.contains("$") or bombed.to_lower().contains("half"):
		_fail("the bomb invented an amount")
		return false
	_ok("bombing an empty city locks building for 5 rounds")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the air mission did not restore the opening")
		return false
	if main.game.build_left(lock_key) != 0:
		_fail("reset left the building lock")
		return false
	return true


func _drop_overrun(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the paradrop did not restore the opening")
		return false
	var foot = await _buy_unit(main, "Infantry", "New York")
	if foot == null:
		return false
	if not await _select_land(main, foot):
		_fail("could not select the infantry")
		return false
	var drop := _find_button(main.hud, "Paradrop")
	if drop == null:
		_fail("Paradrop is missing")
		return false
	drop.pressed.emit()
	await process_frame
	var spot := _open_near_play(main, foot.x, foot.y)
	if spot.x < 0:
		_fail("no open cell for a paradrop")
		return false
	var at: Vector2 = main.map.cell_center(spot.x, spot.y)
	if not await _aim(main, at):
		_fail("the paradrop cell is off the map")
		return false
	await _click_world(main, at)
	var landed := str(main.game.note)
	if landed != "Infantry paradropped. The strength cost was not recovered." or foot.x != spot.x or foot.y != spot.y:
		_fail("the paradrop did not land: %s" % landed)
		return false
	if ("strength" in foot) or landed.contains("25") or landed.contains("%") or landed.contains("$") or landed.to_lower().contains("half"):
		_fail("the paradrop invented a strength cost")
		return false
	_ok("infantry paradropped, and the strength cost stays blank")
	var armor = await _buy_unit(main, "Tanks", "Boston")
	if armor == null:
		return false
	if not await _select_land(main, armor):
		_fail("could not select the tanks")
		return false
	var home_x: int = armor.x
	var home_y: int = armor.y
	var again := _find_button(main.hud, "Paradrop")
	if again == null:
		_fail("Paradrop left the panel")
		return false
	again.pressed.emit()
	await process_frame
	var refused := str(main.game.note)
	if refused != "Tanks cannot paradrop." or armor.x != home_x or armor.y != home_y:
		_fail("tanks accepted a paradrop: %s" % refused)
		return false
	_ok("tanks cannot paradrop")
	var reds: Array = _free_cities_play(main, "red")
	if reds.is_empty():
		_fail("no red city for the overrun")
		return false
	var placed: String = main.game.place_purchase("red", "Infantry", int(reds[0]["x"]), int(reds[0]["y"]))
	if placed != "":
		_fail("red infantry was refused: %s" % placed)
		return false
	var foe = null
	for unit in main.game.tokens:
		if unit.side == "red" and unit.label == "Infantry":
			foe = unit
			break
	if foe == null:
		_fail("red infantry did not appear")
		return false
	if main.game.focus != armor and not await _select_land(main, armor):
		_fail("could not reselect the tanks")
		return false
	var onto: Vector2 = main.map.cell_center(foe.x, foe.y)
	if not await _aim(main, onto):
		_fail("the infantry is off the map")
		return false
	await _click_world(main, onto)
	var rushed := str(main.game.note)
	if not rushed.contains("Overrun") or not rushed.contains("stopped short") or not rushed.contains("damage amounts unknown"):
		_fail("the overrun note is wrong: %s" % rushed)
		return false
	var shares := false
	for step in armor.path:
		if int(step["x"]) == foe.x and int(step["y"]) == foe.y:
			shares = true
	if shares or (armor.x == foe.x and armor.y == foe.y) or foe.label != "Infantry":
		_fail("the overrun removed the infantry")
		return false
	if ("strength" in armor) or ("strength" in foe) or rushed.contains("25") or rushed.contains("%") or rushed.contains("$") or rushed.to_lower().contains("half"):
		_fail("the overrun invented a damage figure")
		return false
	_ok("a tank ordered onto infantry overruns and stops short")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the overrun did not restore the opening")
		return false
	return true


func _foreign_aid(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before foreign aid did not restore the opening")
		return false
	var city := {}
	for place in main.sites.places:
		if str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == "red":
			city = place
			break
	if city.is_empty():
		_fail("no red city for foreign aid")
		return false
	var title := str(city.get("title", ""))
	var button := _find_button(main.hud, "Foreign aid")
	if button == null or button.disabled:
		_fail("Foreign aid should be a live control in this era")
		return false
	button.pressed.emit()
	await process_frame
	var at: Vector2 = main.map.cell_center(int(city["x"]), int(city["y"]))
	if not await _aim(main, at):
		_fail("the aid city is off the map")
		return false
	await _click_world(main, at)
	var first := str(main.game.note)
	if str(city.get("owner", "")) != "neutral" or not first.contains("shifted neutral") or not first.contains("cost was not recovered") or not first.contains(title):
		_fail("the city did not shift neutral: %s" % first)
		return false
	if first.contains("$") or _has_digit(first) or main.game.income_blue != 0 or main.game.income_red != 0:
		_fail("foreign aid charged a cost: %s" % first)
		return false
	button = _find_button(main.hud, "Foreign aid")
	if button == null:
		_fail("Foreign aid left the panel")
		return false
	button.pressed.emit()
	await process_frame
	if not await _aim(main, at):
		_fail("the aid city left the map")
		return false
	await _click_world(main, at)
	var second := str(main.game.note)
	if str(city.get("owner", "")) != "blue" or not second.contains("shifted to Blue") or not second.contains("cost was not recovered"):
		_fail("the city did not shift to the buyer: %s" % second)
		return false
	if second.contains("$") or _has_digit(second) or main.game.income_blue != 0 or main.game.income_red != 0 or main.game.beat != 0:
		_fail("the second aid click charged a cost: %s" % second)
		return false
	var moscow := _site(main, "Moscow")
	if str(moscow.get("owner", "")) != "red":
		_fail("foreign aid took a capital")
		return false
	_ok("foreign aid shifts a city neutral, then to the buyer, and nothing is charged")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after foreign aid did not restore the opening")
		return false
	if str(city.get("owner", "")) != "red":
		_fail("reset left the aided city with the buyer")
		return false
	return true


func _nuke(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the nuke did not restore the opening")
		return false
	var home := _site(main, "New York")
	var city := {}
	for place in main.sites.places:
		if str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == "red":
			city = place
			break
	if home.is_empty() or city.is_empty():
		_fail("nuke is missing a city")
		return false
	var title := str(city.get("title", ""))
	var kept := str(city.get("owner", ""))
	var pieces: int = main.game.tokens.size()
	var subs := 0
	for unit in main.game.tokens:
		if str(unit.label) == "Submarine":
			subs += 1
	var ground: int = main.terrain.id_at(int(city["x"]), int(city["y"]))
	var button := _find_button(main.hud, "Nuke")
	if button == null or button.disabled:
		_fail("Nuke should be a live control in this era")
		return false
	button.pressed.emit()
	await process_frame
	var at_home: Vector2 = main.map.cell_center(int(home["x"]), int(home["y"]))
	if not await _aim(main, at_home):
		_fail("New York is off the map")
		return false
	await _click_world(main, at_home)
	var refused := str(main.game.note)
	if refused != "Crews will not target the home country." or str(home.get("owner", "")) != "blue":
		_fail("the home target was not refused: %s" % refused)
		return false
	if int(main.game.nuke_fired["blue"]) != 0 or main.game.income_blue != 0 or refused.contains("$") or _has_digit(refused):
		_fail("the home refusal counted a launch: %s" % refused)
		return false
	button = _find_button(main.hud, "Nuke")
	if button == null or button.disabled:
		_fail("Nuke left the panel")
		return false
	button.pressed.emit()
	await process_frame
	var at: Vector2 = main.map.cell_center(int(city["x"]), int(city["y"]))
	if not await _aim(main, at):
		_fail("the nuke city is off the map")
		return false
	await _click_world(main, at)
	var noted := str(main.game.note)
	if str(city.get("owner", "")) != kept or main.terrain.id_at(int(city["x"]), int(city["y"])) != ground:
		_fail("the launch flipped or painted the city: %s" % noted)
		return false
	if main.game.tokens.size() != pieces:
		_fail("the launch added a piece")
		return false
	var subs_after := 0
	for unit in main.game.tokens:
		if str(unit.label) == "Submarine":
			subs_after += 1
		if "strength" in unit:
			_fail("the launch stored a strength")
			return false
	if subs_after != subs:
		_fail("the launch added a submarine")
		return false
	if int(main.game.nuke_fired["blue"]) != 1 or int(main.game.nuke_absorbed["red"]) != 1:
		_fail("the launch did not count")
		return false
	if str(main.game.nuke_first) != "blue" or str(main.game.nuke_penalty) != "":
		_fail("the penalty amount was not blank")
		return false
	if not noted.contains(title) or not noted.contains("from submarines that are not pieces on the map"):
		_fail("the launch did not name the submarines: %s" % noted)
		return false
	if not noted.contains("Damage, blast radius, city flips, wasteland paint, and nuclear winter stay off"):
		_fail("the launch applied a blast effect: %s" % noted)
		return false
	if not noted.contains("because those need a radius or a damage figure"):
		_fail("the launch dropped the blank-damage note: %s" % noted)
		return false
	if not noted.contains("The first user is penalized. The penalty amount stays blank."):
		_fail("the penalty note is missing: %s" % noted)
		return false
	if noted.contains("$") or _has_digit(noted) or noted.to_lower().contains("half") or noted.to_lower().contains("beats") or noted.to_lower().contains("one extra") or noted.to_lower().contains("production") or noted.contains("Command HQ") or noted.contains("spaces") or main.game.income_blue != 0 or main.game.income_red != 0 or main.game.beat != 0:
		_fail("the launch invented a figure: %s" % noted)
		return false
	var moscow := _site(main, "Moscow")
	if str(moscow.get("owner", "")) != "red" or str(home.get("owner", "")) != "blue":
		_fail("the launch took a capital")
		return false
	_ok("a nuke refuses the home country, counts one launch, and names no damage")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the nuke did not restore the opening")
		return false
	if str(city.get("owner", "")) != "red" or int(main.game.nuke_fired["blue"]) != 0:
		_fail("reset left the launch in place")
		return false
	return true


func _satellites(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the satellites did not restore the opening")
		return false
	var red_dock := _dock_beside(main, "red")
	if red_dock.x < 0:
		_fail("no dock for the satellite submarine")
		return false
	var placed: String = main.game.place_purchase("red", "Submarine", red_dock.x, red_dock.y)
	if placed != "":
		_fail("the enemy submarine was not placed: %s" % placed)
		return false
	var red_sub = null
	for unit in main.game.tokens:
		if unit.side == "red" and unit.label == "Submarine":
			red_sub = unit
			break
	if red_sub == null or main.map.piece_drawn(red_sub):
		_fail("the still submarine was not hidden before the satellite")
		return false
	var pieces: int = main.game.tokens.size()
	var recon_button := _find_button(main.hud, "Recon sat")
	if recon_button == null or recon_button.disabled:
		_fail("Recon sat should be a live control in this era")
		return false
	recon_button.pressed.emit()
	await process_frame
	var recon := str(main.game.note)
	if not recon.contains("Recon satellite placed.") or not recon.contains("does not reveal by distance") or not recon.contains("The radius was not recovered.") or not recon.contains("does not reveal a still submarine") or not recon.contains("Fall time stays blank") or not recon.contains("does not fall on its own."):
		_fail("the recon refusal is wrong: %s" % recon)
		return false
	if recon.contains("$") or _has_digit(recon) or recon.contains("spaces") or recon.to_lower().contains("about") or recon.to_lower().contains("beats"):
		_fail("the recon note invented a radius: %s" % recon)
		return false
	if red_sub.revealed or main.map.piece_drawn(red_sub) or main.game.tokens.size() != pieces or main.game.satellites.size() != 1:
		_fail("the recon satellite revealed a submarine")
		return false
	if str(main.game.satellites[0].get("kind", "")) != "recon" or str(main.game.satellites[0].get("fall", "x")) != "":
		_fail("the recon satellite stored a fall time")
		return false
	var killer_button := _find_button(main.hud, "Killer sat")
	if killer_button == null or killer_button.disabled:
		_fail("Killer sat should be a live control in this era")
		return false
	killer_button.pressed.emit()
	await process_frame
	var killer := str(main.game.note)
	if not killer.contains("Killer satellite placed.") or not killer.contains("does not pick targets by distance") or not killer.contains("The range was not recovered.") or not killer.contains("Fall time stays blank") or not killer.contains("does not fall on its own."):
		_fail("the killer refusal is wrong: %s" % killer)
		return false
	if killer.contains("$") or _has_digit(killer) or killer.contains("spaces") or killer.to_lower().contains("about") or killer.to_lower().contains("beats"):
		_fail("the killer note invented a range: %s" % killer)
		return false
	if main.game.satellites.size() != 2 or str(main.game.satellites[0].get("kind", "")) != "recon" or str(main.game.satellites[1].get("kind", "")) != "killer":
		_fail("the killer satellite picked a target")
		return false
	if str(main.game.satellites[0].get("fall", "x")) != "" or str(main.game.satellites[1].get("fall", "x")) != "":
		_fail("a satellite stored a fall time")
		return false
	if red_sub.revealed or main.map.piece_drawn(red_sub) or main.game.tokens.size() != pieces or main.game.income_blue != 0 or main.game.income_red != 0 or main.game.beat != 0:
		_fail("the killer satellite changed the board")
		return false
	_ok("recon and killer satellites place with no radius, range, or fall")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the satellites did not restore the opening")
		return false
	if not main.game.satellites.is_empty():
		_fail("reset left a satellite up")
		return false
	for unit in main.game.tokens:
		if unit.label == "Submarine":
			_fail("reset left a submarine on the map")
			return false
	return true


func _cease_fire(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the cease fire did not restore the opening")
		return false
	var blue = main.game.token("blue")
	if blue == null:
		_fail("the cease fire lost the land piece")
		return false
	var home_x: int = blue.x
	var home_y: int = blue.y
	var ask := _find_button(main.hud, "Cease fire")
	var yes := _find_button(main.hud, "Yes")
	var no := _find_button(main.hud, "No")
	if ask == null or ask.disabled or yes == null or no == null or not yes.disabled or not no.disabled:
		_fail("Cease fire should be live, and the answers should wait")
		return false
	ask.pressed.emit()
	await process_frame
	var question := str(main.game.note)
	if question != "Do you want a cease fire?" or not main.game.cease_open:
		_fail("the cease fire question is wrong: %s" % question)
		return false
	yes = _find_button(main.hud, "Yes")
	if yes == null or yes.disabled:
		_fail("Yes stayed closed after the question")
		return false
	yes.pressed.emit()
	await process_frame
	var agreed := str(main.game.note)
	if agreed != "Yes. The combat effect was not recovered." or str(main.game.cease_answer) != "yes" or main.game.cease_open:
		_fail("yes was not recorded: %s" % agreed)
		return false
	if agreed.contains("$") or _has_digit(agreed) or agreed.to_lower().contains("beats") or agreed.to_lower().contains("half") or blue.x != home_x or blue.y != home_y or not blue.path.is_empty() or main.game.income_blue != 0 or main.game.income_red != 0 or main.game.beat != 0:
		_fail("yes changed movement or income: %s" % agreed)
		return false
	if "strength" in blue:
		_fail("yes stored a damage figure")
		return false
	await _click_world(main, main.map.cell_center(home_x, home_y))
	if main.game.selected_side != "blue":
		_fail("the piece could not be selected after yes")
		return false
	var dest := Vector2i(-1, -1)
	for step in TerrainMap.STEPS:
		var nx := posmod(home_x + int(step.x), TerrainMap.CELL_W)
		var ny := home_y + int(step.y)
		if ny < 0 or ny >= TerrainMap.CELL_H:
			continue
		var word := TerrainMap.pace_word(int(main.terrain.id_at(nx, ny)))
		if word != "open" and word != "slow":
			continue
		if main.sites.at_cell(nx, ny) != null:
			continue
		dest = Vector2i(nx, ny)
		break
	if dest.x < 0:
		_fail("no land step beside the piece")
		return false
	var at: Vector2 = main.map.cell_center(dest.x, dest.y)
	if not await _aim(main, at):
		_fail("the cease-fire step is off the map")
		return false
	await _click_world(main, at)
	if blue.path.is_empty() or blue.x != home_x or blue.y != home_y or main.game.income_blue != 0 or main.game.beat != 0:
		_fail("yes blocked the next order: %s" % main.game.note)
		return false
	var kept: int = blue.path.size()
	ask = _find_button(main.hud, "Cease fire")
	if ask == null or ask.disabled:
		_fail("Cease fire left the panel")
		return false
	ask.pressed.emit()
	await process_frame
	if str(main.game.note) != "Do you want a cease fire?" or str(main.game.cease_answer) != "yes":
		_fail("the second question dropped the recorded yes")
		return false
	no = _find_button(main.hud, "No")
	if no == null or no.disabled:
		_fail("No stayed closed after the question")
		return false
	no.pressed.emit()
	await process_frame
	var declined := str(main.game.note)
	if declined != "No. The combat effect was not recovered." or str(main.game.cease_answer) != "no":
		_fail("no was not recorded: %s" % declined)
		return false
	if declined.contains("$") or _has_digit(declined) or blue.path.size() != kept or blue.x != home_x or blue.y != home_y or main.game.income_blue != 0 or main.game.income_red != 0 or main.game.beat != 0:
		_fail("no changed movement or income: %s" % declined)
		return false
	_ok("a cease fire asks the question and records yes or no without changing movement or income")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the cease fire did not restore the opening")
		return false
	if str(main.game.cease_answer) != "" or main.game.cease_open or not main.game.token("blue").path.is_empty():
		_fail("reset left the cease fire in place")
		return false
	return true


func _speed_index(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the speed index did not restore the opening")
		return false
	if main.time_on or main.game.speed_index != 0 or main.game.beat != 0 or main.game.round != 0:
		_fail("the opening speed was already running")
		return false
	var pick: OptionButton = main.hud._speed
	var words := ["Held", "Slow", "Normal", "Fast"]
	if pick == null or pick.item_count != 4 or pick.selected != 0:
		_fail("Held, Slow, Normal, and Fast are not on the menu")
		return false
	for i in 4:
		if pick.get_item_text(i) != words[i]:
			_fail("the speed menu skipped a word")
			return false
	var wait: float = main._clock.wait_time
	pick.select(3)
	pick.item_selected.emit(3)
	await process_frame
	var running := str(main.game.note)
	if not main.time_on or main.game.speed_index != 6 or not running.contains("Speed 6 is running") or not running.contains("ratio was not recovered"):
		_fail("Fast did not start: %s" % running)
		return false
	if running.contains("$") or running.contains("beats") or running.to_lower().contains("half") or not is_equal_approx(main._clock.wait_time, wait):
		_fail("the running index changed the tick: %s" % running)
		return false
	var moved: int = main.game.round
	await create_timer(0.45).timeout
	if not main.time_on or main.game.round <= moved or main.game.speed_index != 6 or not is_equal_approx(main._clock.wait_time, wait):
		_fail("Fast did not use the existing tick")
		return false
	pick.select(0)
	pick.item_selected.emit(0)
	await process_frame
	var held := str(main.game.note)
	if main.time_on or main.game.speed_index != 0 or held != "Speed 0 holds time. Orders are still accepted. The ratio was not recovered.":
		_fail("speed 0 did not hold: %s" % held)
		return false
	if not is_equal_approx(main._clock.wait_time, wait):
		_fail("speed 0 changed the tick")
		return false
	var frozen: int = main.game.round
	await create_timer(0.45).timeout
	if main.time_on or main.game.round != frozen or main.game.speed_index != 0:
		_fail("speed 0 advanced time")
		return false
	var blue = main.game.token("blue")
	if blue == null:
		_fail("speed 0 lost the land piece")
		return false
	var home_x: int = blue.x
	var home_y: int = blue.y
	await _click_world(main, main.map.cell_center(home_x, home_y))
	if main.game.selected_side != "blue":
		_fail("speed 0 could not select the piece")
		return false
	var dest := Vector2i(-1, -1)
	for step in TerrainMap.STEPS:
		var nx := posmod(home_x + int(step.x), TerrainMap.CELL_W)
		var ny := home_y + int(step.y)
		if ny < 0 or ny >= TerrainMap.CELL_H:
			continue
		var word := TerrainMap.pace_word(int(main.terrain.id_at(nx, ny)))
		if word != "open" and word != "slow":
			continue
		if main.sites.at_cell(nx, ny) != null:
			continue
		dest = Vector2i(nx, ny)
		break
	if dest.x < 0:
		_fail("speed 0 has no land step")
		return false
	var at: Vector2 = main.map.cell_center(dest.x, dest.y)
	if not await _aim(main, at):
		_fail("the held-speed step is off the map")
		return false
	await _click_world(main, at)
	if blue.path.is_empty() or blue.x != home_x or blue.y != home_y or main.time_on or main.game.round != frozen or main.game.speed_index != 0:
		_fail("speed 0 refused the order: %s" % main.game.note)
		return false
	var board := _board_text(main)
	if not board.contains("shallows are slower") or not board.contains("ratio was not recovered"):
		_fail("the speed board dropped the pace lines")
		return false
	if board.contains("Command HQ") or board.contains("$") or board.to_lower().contains("production") or board.contains("beats") or board.contains("one extra"):
		_fail("the speed board picked up a forbidden phrase")
		return false
	_ok("Held, Slow, Normal, and Fast share one tick, and Held still accepts orders")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the speed index did not restore the opening")
		return false
	if main.time_on or main.game.speed_index != 0 or main.game.speed_run != 1:
		_fail("reset left a running speed")
		return false
	return true


func _repair(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the repair did not restore the opening")
		return false
	var foot = await _buy_unit(main, "Infantry", "New York")
	if foot == null:
		return false
	var noted := str(main.game.note)
	if not noted.contains("Repairing. Strength has no number.") or not main.game.repairing(foot):
		_fail("the city piece was not marked repairing: %s" % noted)
		return false
	var priced := noted.replace("Stand-in price: %d billion." % Assumptions.PRICE_INFANTRY, "")
	if ("strength" in foot) or noted.contains("$") or noted.contains("%") or noted.to_lower().contains("half") or _has_digit(priced):
		_fail("the repair invented a strength number")
		return false
	main.map.queue_redraw()
	await RenderingServer.frame_post_draw
	if str(main.map.repair_caption) != "Repairing" or str(main.map.repair_bar_text) != "":
		_fail("the repair bar was labeled: %s / %s" % [main.map.repair_caption, main.map.repair_bar_text])
		return false
	if _has_digit(str(main.map.repair_caption)):
		_fail("the repair mark drew a number")
		return false
	_ok("a land piece on a friendly city is repairing, and the bar stays unlabeled")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the repair did not restore the opening")
		return false
	return true


func _buy_unit(main: Variant, label: String, city_name: String):
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null:
		_fail("Buy is missing before %s" % label)
		return null
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	var choice := _find_button_prefix(buy, label)
	if choice == null:
		_fail("the catalog is missing %s" % label)
		return null
	choice.pressed.emit()
	await process_frame
	var city := _site(main, city_name)
	if city.is_empty():
		_fail("%s is not on the map" % city_name)
		return null
	var at: Vector2 = main.map.cell_center(int(city["x"]), int(city["y"]))
	if not await _aim(main, at):
		_fail("%s is off the map" % city_name)
		return null
	await _click_world(main, at)
	var piece = null
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.label == label and unit.x == int(city["x"]) and unit.y == int(city["y"]):
			piece = unit
			break
	if piece == null:
		_fail("%s was not placed at %s: %s" % [label, city_name, main.game.note])
		return null
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("Close is missing after the purchase")
		return null
	close.pressed.emit()
	await process_frame
	return piece


func _open_near_play(main: Variant, x: int, y: int) -> Vector2i:
	for radius in range(1, 6):
		for dy in range(-radius, radius + 1):
			for dx in range(-radius, radius + 1):
				if absi(dx) != radius and absi(dy) != radius:
					continue
				var nx := posmod(x + dx, TerrainMap.CELL_W)
				var ny := y + dy
				if ny < 0 or ny >= TerrainMap.CELL_H:
					continue
				var word := TerrainMap.pace_word(int(main.terrain.id_at(nx, ny)))
				if word != "open" and word != "slow":
					continue
				if main.sites.at_cell(nx, ny) != null:
					continue
				var taken := false
				for unit in main.game.tokens:
					if posmod(unit.x, TerrainMap.CELL_W) == nx and unit.y == ny:
						taken = true
						break
				if taken:
					continue
				return Vector2i(nx, ny)
	return Vector2i(-1, -1)


func _find_button_prefix(node: Node, prefix: String) -> Button:
	if node is Button and str((node as Button).text).begins_with(prefix):
		return node
	for child in node.get_children():
		var found := _find_button_prefix(child, prefix)
		if found != null:
			return found
	return null


func _buy_craft(main: Variant, city_name: String):
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null:
		_fail("Buy is missing before the aircraft")
		return null
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	var choice := _find_button(buy, "Aircraft")
	if choice == null:
		_fail("the catalog is missing Aircraft")
		return null
	choice.pressed.emit()
	await process_frame
	var city := _site(main, city_name)
	if city.is_empty():
		_fail("%s is not on the map" % city_name)
		return null
	var at: Vector2 = main.map.cell_center(int(city["x"]), int(city["y"]))
	if not await _aim(main, at):
		_fail("%s is off the map" % city_name)
		return null
	await _click_world(main, at)
	var craft = null
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.label == "Aircraft" and unit.x == int(city["x"]) and unit.y == int(city["y"]):
			craft = unit
			break
	if craft == null:
		_fail("the aircraft was not placed at %s: %s" % [city_name, main.game.note])
		return null
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("Close is missing after the aircraft purchase")
		return null
	close.pressed.emit()
	await process_frame
	return craft


func _craft_at_play(main: Variant, side: String, cell: Dictionary):
	var placed: String = main.game.place_purchase(side, "Aircraft", int(cell["x"]), int(cell["y"]))
	if placed != "":
		_fail("the enemy aircraft was refused: %s" % placed)
		return null
	for unit in main.game.tokens:
		if unit.side == side and unit.label == "Aircraft" and unit.x == int(cell["x"]) and unit.y == int(cell["y"]):
			return unit
	_fail("the enemy aircraft did not appear")
	return null


func _free_cities_play(main: Variant, side: String) -> Array:
	var out: Array = []
	for place in main.sites.places:
		if str(place.get("owner", "")) != side or str(place.get("kind", "")) != "city":
			continue
		var x := int(place["x"])
		var y := int(place["y"])
		var taken := false
		for unit in main.game.tokens:
			if unit.x == x and unit.y == y:
				taken = true
				break
		if not taken:
			out.append(place)
	return out


func _city_states(main: Variant) -> bool:
	var again := _find_button(main.hud, "Start")
	if again == null:
		_fail("the win card is missing Start")
		return false
	again.pressed.emit()
	await process_frame
	var screen: Control = main.start_screen
	if main.started or screen == null or not screen.visible:
		_fail("Start did not return to the era screen")
		return false
	var era := _find_option(screen, 9999)
	if era == null:
		_fail("the era screen is missing the concealed start")
		return false
	for i in era.item_count:
		if era.get_item_id(i) == 9999:
			era.select(i)
			break
	if era.get_item_id(era.selected) != 9999:
		_fail("the concealed start was not selected")
		return false
	var start := _find_button(screen, "Start")
	if start == null:
		_fail("the era screen is missing Start")
		return false
	start.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	if not main.buying or buy == null or not buy.visible:
		_fail("the concealed start did not open the buy screen")
		return false
	var buy_text := _node_text(buy)
	if not buy_text.contains("city-states") or not buy_text.contains("hidden until their capital is found"):
		_fail("the concealed buy screen did not name city-states")
		return false
	if buy_text.contains("Command HQ") or buy_text.contains("$") or buy_text.to_lower().contains("production"):
		_fail("the concealed buy screen picked up a forbidden phrase")
		return false
	var york := _site(main, "New York")
	var wash := _site(main, "Washington")
	var moscow := _site(main, "Moscow")
	if york.is_empty() or str(york["owner"]) != "neutral" or str(york["home"]) != "blue":
		_fail("New York did not become a city-state")
		return false
	if str(wash["owner"]) != "blue" or str(wash["kind"]) != "capital" or str(moscow["owner"]) != "red":
		_fail("the concealed capitals did not keep their homes")
		return false
	var red = main.game.token("red")
	var blue = main.game.token("blue")
	if red == null or blue == null or main.map.piece_drawn(red) or main.map.piece_drawn(main.game.sea_token("red")):
		_fail("the concealed opponent was drawn")
		return false
	if not main.map.piece_drawn(blue) or not main.map.piece_drawn(main.game.sea_token("blue")):
		_fail("the concealed start hid the ordered pieces")
		return false
	var at: Vector2 = main.map.cell_center(int(york["x"]), int(york["y"]))
	if not main.map.sees(at):
		_fail("New York is off the buy view")
		return false
	await _click_world(main, at)
	var status := _node_text(buy)
	if not status.contains("New York") or not status.contains("city-state") or not status.contains("neutral"):
		_fail("clicking New York did not call it a city-state: %s" % status)
		return false
	var back := _find_button(buy, "Back")
	if back == null:
		_fail("the buy screen is missing Back")
		return false
	back.pressed.emit()
	await process_frame
	if main.buying or main.started or not screen.visible:
		_fail("Back did not return to the era screen")
		return false
	if str(_site(main, "New York")["owner"]) != "blue" or main.era_year != 1986:
		_fail("Back left the concealed city-states in place")
		return false
	_ok("concealed cities on the map are city-states, and the opponent stays hidden")
	return true


func _year_2023(main: Variant) -> bool:
	var again := _find_button(main.hud, "Start")
	if again == null:
		_fail("the win card is missing Start")
		return false
	again.pressed.emit()
	await process_frame
	var screen: Control = main.start_screen
	if main.started or screen == null or not screen.visible:
		_fail("Start did not return to the era screen")
		return false
	var era := _find_option(screen, 2023)
	if era == null:
		_fail("the era screen is missing 2023")
		return false
	for i in era.item_count:
		if era.get_item_id(i) == 2023:
			era.select(i)
			break
	if era.get_item_id(era.selected) != 2023:
		_fail("2023 was not selected")
		return false
	var start := _find_button(screen, "Start")
	if start == null:
		_fail("the era screen is missing Start")
		return false
	start.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	if not main.buying or buy == null or not buy.visible or main.started:
		_fail("2023 Start did not open the buy screen")
		return false
	if main.era_year != 2023 or main.game.tokens.size() != 0:
		_fail("2023 opened with an army (%s pieces)" % main.game.tokens.size())
		return false
	var buy_text := _node_text(buy)
	if not buy_text.contains("No army is on the map") or buy_text.contains("already placed") or buy_text.contains("$"):
		_fail("the 2023 buy screen still describes a starting army")
		return false
	if not buy_text.contains("Stand-in cash pool") or not buy_text.contains("stand-in shuffle") or buy_text.contains("$"):
		_fail("the 2023 buy screen left out the stand-in cash pool")
		return false
	var wash := _site(main, "Washington")
	var moscow := _site(main, "Moscow")
	var toronto := _site(main, "Toronto")
	if str(wash["owner"]) != "blue" or str(moscow["owner"]) != "red" or str(toronto["owner"]) == "blue" or str(toronto["owner"]) == "red":
		_fail("2023 changed a capital or Toronto's owner")
		return false
	if int(wash["x"]) != int(wash["listed_x"]) or int(wash["y"]) != int(wash["listed_y"]) or int(moscow["x"]) != int(moscow["listed_x"]) or int(moscow["y"]) != int(moscow["listed_y"]):
		_fail("2023 moved a capital")
		return false
	var moved_city := false
	for place in main.sites.places:
		var kind := str(place.get("kind", ""))
		var shifted := int(place["x"]) != int(place["listed_x"]) or int(place["y"]) != int(place["listed_y"])
		if kind == "capital" and shifted:
			_fail("2023 moved a capital")
			return false
		if kind != "city" and kind != "capital" and shifted:
			_fail("2023 moved a %s" % kind)
			return false
		if kind == "city" and shifted:
			moved_city = true
		if str(place.get("owner", "")) != str(place.get("home", "")):
			_fail("2023 changed an owner")
			return false
	if not moved_city or main.game.cash_billions != 40 or _same_oil_order(main.game.oil_cells, main.game.oil_listed):
		_fail("2023 left the cities, the oil, or the cash pool as listed")
		return false
	_find_button(buy, "Begin").pressed.emit()
	await process_frame
	if main.buying or not main.started or main.game.tokens.size() != 0:
		_fail("Begin gave 2023 an army")
		return false
	var shuffled := {}
	for place in main.sites.places:
		if str(place.get("kind", "")) != "city":
			continue
		if int(place["x"]) != int(place["listed_x"]) or int(place["y"]) != int(place["listed_y"]):
			shuffled = place
			break
	if shuffled.is_empty():
		_fail("2023 did not move a city")
		return false
	var city_at: Vector2 = main.map.cell_center(int(shuffled["x"]), int(shuffled["y"]))
	if not await _aim(main, city_at):
		_fail("the shuffled city is off the map")
		return false
	await _hover_world(main, city_at)
	if not str(main.map._chip_labels["terrain"].text).contains("city"):
		_fail("the shuffled city chip was not city: %s" % str(main.map._chip_labels["terrain"].text))
		return false
	var note := str(main.game.note)
	if main.era_year != 2023 or main.time_on or main.game.beat != 0:
		_fail("2023 begin changed the clock")
		return false
	if not note.contains("no army") or not note.contains("Stand-in cash pool: 40 billion") or not note.contains("stand-in shuffle") or note.contains("$"):
		_fail("2023 begin left out the stand-in cash pool: %s" % note)
		return false
	await _press(main, KEY_T)
	await create_timer(0.2).timeout
	if not main.time_on or main.game.tokens.size() != 0:
		_fail("2023 raised an army when time ran")
		return false
	await _press(main, KEY_T)
	if main.time_on:
		_fail("2023 did not pause")
		return false
	var board := _board_text(main)
	if not board.contains("shallows are slower") or not board.contains("ratio was not recovered"):
		_fail("the 2023 board dropped the pace lines")
		return false
	if board.contains("Command HQ") or board.to_lower().contains("production") or board.contains("$") or board.contains("beats") or board.contains("one extra"):
		_fail("the 2023 board picked up a forbidden phrase")
		return false
	if not main.oil.visible:
		_fail("2023 should keep oil on")
		return false
	_ok("2023 starts with no army, a stand-in cash pool, and a stand-in shuffle")
	return true


func _win(main: Variant) -> bool:
	var wash := _site(main, "Washington")
	var moscow := _site(main, "Moscow")
	var norfolk := _site(main, "Norfolk")
	var marcher = main.game.token("blue")
	var garrison = _other_land(main, marcher)
	if garrison == null or garrison.x != int(norfolk["x"]) or garrison.y != int(norfolk["y"]):
		_fail("the second land piece is not waiting at Norfolk")
		return false
	var march_at: Vector2 = main.map.cell_center(marcher.x, marcher.y)
	if not main.map.sees(march_at):
		_fail("the capital piece is off the opening view")
		return false
	await _click_world(main, march_at)
	if main.game.focus != marcher:
		_fail("click did not select the capital piece")
		return false
	# Moscow is off the opening frame.
	await _press(main, KEY_F)
	await process_frame
	await _click_world(main, main.map.cell_center(int(moscow["x"]), int(moscow["y"])))
	if marcher.path.is_empty() or main.time_on or main.game.beat != 0:
		_fail("the moscow order was not queued from the opening: %s" % main.game.note)
		return false
	await _press(main, KEY_T)
	if not main.time_on:
		_fail("T did not start the garrison march")
		return false
	var left := false
	for _i in 40:
		await create_timer(0.14).timeout
		if marcher.x != int(wash["x"]) or marcher.y != int(wash["y"]):
			left = true
			break
	if not left:
		_fail("the capital piece never left Washington")
		return false
	await _press(main, KEY_T)
	if main.time_on:
		_fail("T did not pause so the second piece could take the capital")
		return false
	if not await _select_land(main, garrison):
		_fail("could not select the Norfolk piece")
		return false
	var capital_at: Vector2 = main.map.cell_center(int(wash["x"]), int(wash["y"]))
	if not main.map.sees(capital_at):
		await _press(main, KEY_F)
		await process_frame
	await _click_world(main, capital_at)
	if garrison.path.is_empty():
		_fail("the second piece was not ordered onto the capital: %s" % main.game.note)
		return false
	_ok("the second land piece is ordered to hold the capital")
	await _press(main, KEY_T)
	var won := ""
	var reorders := 0
	for _i in 420:
		await create_timer(0.14).timeout
		var red = main.game.token("red")
		if marcher.x == red.x and marcher.y == red.y:
			_fail("the pieces occupied one cell on the way to moscow")
			return false
		if garrison.x == red.x and garrison.y == red.y:
			_fail("red reached the piece holding the capital")
			return false
		won = main.game.winner()
		if won != "":
			break
		if marcher.path.is_empty() and not (marcher.x == int(moscow["x"]) and marcher.y == int(moscow["y"])):
			if reorders >= 4:
				_fail("the capital piece stopped and would not resume: %s" % main.game.note)
				return false
			reorders += 1
			if main.time_on:
				await _press(main, KEY_T)
			if not await _select_land(main, marcher):
				_fail("could not reselect the marching piece")
				return false
			await _press(main, KEY_F)
			await process_frame
			await _click_world(main, main.map.cell_center(int(moscow["x"]), int(moscow["y"])))
			if marcher.path.is_empty():
				_fail("reorder toward moscow was refused: %s" % main.game.note)
				return false
			if not main.time_on:
				await _press(main, KEY_T)
	if won != "blue" or str(main.hud._note.text).find("holds every capital") < 0:
		_fail("the match did not end with Blue holding both capitals: %s" % main.game.note)
		return false
	if str(wash["owner"]) != "blue" or str(moscow["owner"]) != "blue":
		_fail("the capital owners do not match the winner")
		return false
	if garrison.x != int(wash["x"]) or garrison.y != int(wash["y"]):
		_fail("the second piece left the capital")
		return false
	_ok("Blue holds both capitals")
	await _save(main, "winner.png")
	var card := _node_text(main.hud)
	if not card.contains("Blue wins") or not card.contains("Turn") or not card.contains("Washington") or not card.contains("Moscow"):
		_fail("the end screen missed the side, the turn, or a capital: %s" % card)
		return false
	var rematch := _find_button(main.hud, "Rematch")
	if rematch == null:
		_fail("the end screen is missing Rematch")
		return false
	rematch.pressed.emit()
	await process_frame
	var again: Control = main.buy_screen
	if not main.buying or again == null or not again.visible or main.era_year != 1986 or main.player_side != "blue":
		_fail("Rematch did not open buy for the same era and side")
		return false
	var back := _find_button(again, "Back")
	if back == null:
		_fail("Rematch buy is missing Back")
		return false
	back.pressed.emit()
	await process_frame
	if main.started or main.buying or not main.start_screen.visible:
		_fail("Back from Rematch did not return to the era screen")
		return false
	_ok("Rematch opens buy for the same era and side")
	return true


func _other_land(main: Variant, marcher) -> Variant:
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.domain != "sea" and unit != marcher:
			return unit
	return null


func _select_land(main: Variant, unit) -> bool:
	var world: Vector2 = main.map.cell_center(unit.x, unit.y)
	if not await _aim(main, world):
		return false
	await _click_world(main, world)
	return main.game.focus == unit


func _aim(main: Variant, world: Vector2) -> bool:
	for _i in 16:
		if main.map.sees(world) and main.map.marker_hit() < 40.0:
			return true
		var local := Vector2(main.map.pan_x + world.x * main.map.view_scale, main.map.pan_y + world.y * main.map.view_scale)
		var at: Vector2 = main.map.position + local
		var on_map: bool = at.x >= main.map.position.x and at.x <= main.map.position.x + main.map.size.x and at.y >= main.map.position.y and at.y <= main.map.position.y + main.map.size.y
		if not on_map:
			await _press(main, KEY_F)
			await process_frame
			local = Vector2(main.map.pan_x + world.x * main.map.view_scale, main.map.pan_y + world.y * main.map.view_scale)
			at = main.map.position + local
		await _wheel(at, true)
		await process_frame
	return main.map.sees(world) and main.map.marker_hit() < 40.0


func _transport(main: Variant) -> bool:
	var land = main.game.token("blue")
	var gate: Vector2i = _ocean_gate(main, land.x, land.y)
	if gate.x < 0:
		_fail("no ocean cell beside the capital for a transport")
		return false
	if not await _select_land(main, land):
		_fail("could not select the land piece for the transport")
		return false
	var gate_world: Vector2 = main.map.cell_center(gate.x, gate.y)
	if not await _aim(main, gate_world):
		_fail("the ocean cell is off the map")
		return false
	await _click_world(main, gate_world)
	var ashore: Variant = main.terrain.route(int(land.x), int(land.y), gate.x, gate.y, Callable())
	if land.transporting or not _path_same(land.path, ashore):
		_fail("the march to the ocean did not stay on the land route: %s" % main.game.note)
		return false
	await _press(main, KEY_T)
	var arrived := false
	for _i in 40:
		await create_timer(0.14).timeout
		if land.x == gate.x and land.y == gate.y and land.path.is_empty():
			arrived = true
			break
	if not arrived:
		_fail("the land piece did not reach the ocean (%d, %d)" % [land.x, land.y])
		return false
	if TerrainMap.pace_word(int(main.terrain.id_at(land.x, land.y))) != "transport":
		_fail("standing on the ocean should show a transport")
		return false
	await _press(main, KEY_T)
	if main.time_on:
		_fail("the clock stayed running after the piece reached the ocean")
		return false
	if not await _select_land(main, land):
		_fail("could not select the piece on the ocean")
		return false
	var far := Vector2i(20, 53)
	var far_world: Vector2 = main.map.cell_center(far.x, far.y)
	if not await _aim(main, far_world):
		_fail("the sea-lane destination is off the map")
		return false
	if main.terrain.straight_walk(land.x, land.y, far.x, far.y, land.ship_class) != null:
		_fail("this ocean crossing should use the sea-lane graph")
		return false
	await _hover_world(main, far_world)
	var sailed: Variant = main.game.ship_route(land.x, land.y, far.x, far.y, land.ship_class)
	if not _path_same(main.map.preview, sailed) or not _touches_lane(main, sailed):
		_fail("the preview did not follow the sea lanes")
		return false
	await _click_world(main, far_world)
	var note := str(main.game.note)
	if not land.transporting or note.find("formed a transport") < 0 or not _path_same(land.path, sailed):
		_fail("the land piece did not form a transport: %s" % note)
		return false
	if note.contains("$") or note.contains("Command HQ") or note.contains("beats"):
		_fail("the transport note picked up a forbidden word: %s" % note)
		return false
	var route: Array[Vector2i] = []
	for step in land.path:
		route.append(Vector2i(int(step["x"]), int(step["y"])))
	var began := Vector2i(land.x, land.y)
	await _press(main, KEY_T)
	if not main.time_on:
		_fail("T did not start the transport")
		return false
	var moved := false
	for _i in 40:
		await create_timer(0.14).timeout
		if not land.transporting:
			break
		var at := Vector2i(land.x, land.y)
		if at == began:
			continue
		if route.has(at):
			moved = true
			break
	if not moved or not land.transporting:
		_fail("the transport did not follow the lane (%d, %d)" % [land.x, land.y])
		return false
	if not TerrainMap.sea_accepts(int(land.ship_class), int(main.terrain.id_at(land.x, land.y))):
		_fail("the transport left the water")
		return false
	_ok("a land piece formed a transport and followed the sea lanes")
	if main.time_on:
		await _press(main, KEY_T)
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the transport did not restore the opening")
		return false
	return true


func _intel(main: Variant) -> bool:
	var button := _find_button(main.hud, "Intel")
	if button == null or button.disabled:
		_fail("Intel should be a live control in this era")
		return false
	var beat_before: int = main.game.beat
	var red = main.game.token("red")
	var red_x: int = red.x
	var red_y: int = red.y
	button.pressed.emit()
	await process_frame
	var note := str(main.game.note)
	if note.find("reveals every unit") < 0 or note.find("The opponent is told.") < 0:
		_fail("intel did not act: %s" % note)
		return false
	if note.contains("$") or note.contains("radius") or note.contains("beats") or note.contains("Command HQ"):
		_fail("intel note picked up a forbidden word: %s" % note)
		return false
	if str(main.game.opponent_told) != "red":
		_fail("the opponent was not told")
		return false
	for unit in main.game.tokens:
		if not unit.revealed:
			_fail("intel left a unit hidden")
			return false
	if main.game.beat != beat_before or red.x != red_x or red.y != red_y:
		_fail("intel moved the clock or the opponent")
		return false
	if not main.map.piece_drawn(red):
		_fail("intel hid the revealed piece")
		return false
	if str(main.map._pulse.text) != "Pulse":
		_fail("intel did not show the pulse")
		return false
	_ok("intel reveals every unit and tells the opponent")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after intel did not restore the opening")
		return false
	if str(main.game.opponent_told) != "":
		_fail("reset left the intel tell in place")
		return false
	return true


func _match_buy(main: Variant) -> bool:
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null or buy_button.disabled:
		_fail("Buy should be a live control during the match")
		return false
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	if not main.buying or not main.started or buy == null or not buy.visible:
		_fail("Buy did not open the catalog during the match")
		return false
	var intro := _find_label(buy, "The match is running. Stand-in prices are charged. The city becomes unready. The time was not recovered.")
	if intro == null or str(intro.text).contains("$") or str(intro.text).to_lower().contains("production"):
		_fail("the match catalog invented a price or a duration")
		return false
	var infantry := _find_button(buy, "Infantry")
	if infantry == null:
		_fail("the match catalog is missing Infantry")
		return false
	infantry.pressed.emit()
	await process_frame
	var nyc := _site(main, "New York")
	if nyc.is_empty():
		_fail("New York is not on the map")
		return false
	var at: Vector2 = main.map.cell_center(int(nyc["x"]), int(nyc["y"]))
	if not await _aim(main, at):
		_fail("New York is off the map")
		return false
	var before := 0
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.domain != "sea":
			before += 1
	await _click_world(main, at)
	var placed := false
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.domain != "sea" and unit.x == int(nyc["x"]) and unit.y == int(nyc["y"]):
			placed = true
	var note := str(main.game.note)
	if not placed or note.find("Stand-in price") < 0 or note.find("time was not recovered") < 0 or note.contains("$"):
		_fail("the stand-in unit was not bought: %s" % note)
		return false
	if int(main.game.cash_billions) != Assumptions.CASH_EARLY - Assumptions.PRICE_INFANTRY:
		_fail("the match purchase did not lower the pool (%s)" % str(main.game.cash_billions))
		return false
	if not main.game.city_unready(int(nyc["id"])) or main.game.beat != 0:
		_fail("the city did not become unready without moving the clock")
		return false
	await _click_world(main, at)
	var status := str(main.buy_screen.status_text())
	var still := 0
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.domain != "sea":
			still += 1
	if status != "This city is unready. The time was not recovered." or still != before + 1:
		_fail("the unready city did not refuse the second buy: %s" % status)
		return false
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("the match catalog is missing Close")
		return false
	close.pressed.emit()
	await process_frame
	if main.buying or not main.hud.visible:
		_fail("Close did not return to the match")
		return false
	_ok("a blank price was bought during the match, and the unready time stays unknown")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the match purchase did not restore the opening")
		return false
	if main.game.city_unready(int(nyc["id"])):
		_fail("reset left the city unready")
		return false
	return true


func _entrench(main: Variant) -> bool:
	var capital = main.game.token("blue")
	if not await _select_land(main, capital):
		_fail("could not select the capital piece")
		return false
	var refused_button := _find_button(main.hud, "Entrench")
	if refused_button == null:
		_fail("Entrench should be on the panel")
		return false
	refused_button.pressed.emit()
	await process_frame
	if str(main.game.note) != "Only infantry can entrench." or capital.entrenched:
		_fail("the capital piece entrenched: %s" % main.game.note)
		return false
	var buy_button := _find_button(main.hud, "Buy")
	if buy_button == null:
		_fail("Buy is missing before entrench")
		return false
	buy_button.pressed.emit()
	await process_frame
	var buy: Control = main.buy_screen
	var infantry := _find_button(buy, "Infantry")
	if infantry == null:
		_fail("the catalog is missing Infantry")
		return false
	infantry.pressed.emit()
	await process_frame
	var nyc := _site(main, "New York")
	if nyc.is_empty():
		_fail("New York is not on the map")
		return false
	var at: Vector2 = main.map.cell_center(int(nyc["x"]), int(nyc["y"]))
	if not await _aim(main, at):
		_fail("New York is off the map")
		return false
	await _click_world(main, at)
	var foot = null
	for unit in main.game.tokens:
		if unit.side == "blue" and unit.label == "Infantry":
			foot = unit
			break
	if foot == null:
		_fail("the infantry purchase did not appear")
		return false
	var close := _find_button(buy, "Close")
	if close == null:
		_fail("Close is missing after the infantry purchase")
		return false
	close.pressed.emit()
	await process_frame
	if not await _select_land(main, foot):
		_fail("could not select the infantry")
		return false
	var dig := _find_button(main.hud, "Entrench")
	if dig == null:
		_fail("Entrench left the panel")
		return false
	dig.pressed.emit()
	await process_frame
	var dug := str(main.game.note)
	if not foot.entrenched or dug != "Infantry entrenched. The bonus was not recovered.":
		_fail("infantry did not entrench: %s" % dug)
		return false
	if dug.contains("$") or dug.contains("%") or dug.contains("beats"):
		_fail("entrench named a bonus: %s" % dug)
		return false
	var dest := Vector2i(-1, -1)
	for step in TerrainMap.STEPS:
		var nx := posmod(foot.x + int(step.x), TerrainMap.CELL_W)
		var ny: int = foot.y + int(step.y)
		if ny < 0 or ny >= TerrainMap.CELL_H:
			continue
		if TerrainMap.land_pace(int(main.terrain.id_at(nx, ny))) < 0:
			continue
		var trial: Variant = main.terrain.route(foot.x, foot.y, nx, ny, Callable())
		if trial is Array and (trial as Array).size() == 1:
			dest = Vector2i(nx, ny)
			break
	if dest.x < 0:
		_fail("infantry has no step off the city")
		return false
	var away: Vector2 = main.map.cell_center(dest.x, dest.y)
	if not await _aim(main, away):
		_fail("the step off the city is off the map")
		return false
	await _click_world(main, away)
	if foot.entrenched or str(main.game.note).find("Entrench is lost.") < 0:
		_fail("the move kept the entrench: %s" % main.game.note)
		return false
	_ok("infantry entrenched, and a move dropped it with no bonus")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after entrench did not restore the opening")
		return false
	if main.game.token("blue").entrenched:
		_fail("reset left the capital entrenched")
		return false
	return true


func _stills(main: Variant) -> bool:
	if main.hud._still_scroll.visible or main.hud._still_row.visible:
		_fail("the still catalog was already open")
		return false
	var button := _find_button(main, "Stills")
	if button == null:
		_fail("Stills should be on the panel")
		return false
	button.pressed.emit()
	await process_frame
	var note := str(main.hud._still_note.text)
	if not main.stills_open or not main.hud._still_note.visible or not main.hud._still_scroll.visible:
		_fail("Stills did not open the catalog")
		return false
	if note != str(main.stills.NOTE) or main.stills.PLAYBACK_KNOWN or not note.contains("assumption"):
		_fail("the still catalog invented a recovered frame order: %s" % note)
		return false
	var pick: OptionButton = main.hud._still_pick
	var index := -1
	for i in pick.item_count:
		if pick.get_item_text(i) == "WAR2":
			index = i
			break
	if index < 0:
		_fail("the catalog is missing WAR2")
		return false
	pick.select(index)
	pick.item_selected.emit(index)
	await process_frame
	var files: PackedStringArray = main.stills.files_for("WAR2")
	var captions := PackedStringArray()
	for child in main.hud._still_grid.get_children():
		if not child is VBoxContainer:
			continue
		for sub in child.get_children():
			if sub is Label:
				captions.append((sub as Label).text)
	if files.is_empty() or captions.size() != files.size():
		_fail("WAR2 did not list its stills")
		return false
	for i in files.size():
		if captions[i] != files[i].get_file():
			_fail("the catalog reordered WAR2")
			return false
	var next_frame := _find_button(main.hud, "Next frame")
	if next_frame == null or not next_frame.visible:
		_fail("Next frame should be on the open catalog")
		return false
	next_frame.pressed.emit()
	await process_frame
	var played := str(main.hud._still_note.text)
	var want := "Playing %s. Assumption: extracted file order." % files[(1) % files.size()].get_file()
	if played != want:
		_fail("Next frame left the extracted file order: %s" % played)
		return false
	if main.time_on or main.game.beat != 0:
		_fail("opening the catalog started a playback")
		return false
	var facility := {}
	for place in main.sites.places:
		if int(place["x"]) == 18 and int(place["y"]) == 18 and str(place["kind"]) == "facility":
			facility = place
			break
	if facility.is_empty():
		_fail("the facility at (18, 18) is missing")
		return false
	var at: Vector2 = main.map.cell_center(18, 18)
	if not await _aim(main, at):
		_fail("the facility is off the map")
		return false
	await _hover_world(main, at)
	await _click_world(main, at)
	var chip := str(main.map._chip_labels["terrain"].text)
	if str(main.hud._card_title.text) != "Facility" or int(main.sites.selected_id) != int(facility["id"]):
		_fail("the facility card was not shown: %s" % str(main.hud._card_title.text))
		return false
	if chip != "facility · open" or int(main.terrain.id_at(18, 18)) != 15:
		_fail("the facility stand-in was not painted: %s id %s" % [chip, str(main.terrain.id_at(18, 18))])
		return false
	button.pressed.emit()
	await process_frame
	if main.stills_open or main.hud._still_scroll.visible:
		_fail("Stills did not close the catalog")
		return false
	_ok("stills step in extracted file order, and the facility center is painted")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the still catalog did not restore the opening")
		return false
	if int(main.terrain.id_at(18, 18)) != 15:
		_fail("reset cleared the facility stand-in")
		return false
	return true


func _menu_keys(main: Variant) -> bool:
	await _press(main, KEY_ESCAPE)
	await process_frame
	var era := _find_option(main.pause_layer, 1942)
	if era == null:
		_fail("the era menu is missing")
		return false
	era.grab_focus()
	await process_frame
	if not (main.get_viewport().gui_get_focus_owner() is OptionButton):
		_fail("the era menu did not take focus")
		return false
	_choose(main, 1942)
	await process_frame
	if main.era_year != 1942:
		_fail("the era menu did not apply")
		return false
	if main.get_viewport().gui_get_focus_owner() is OptionButton:
		_fail("the era menu kept the keys")
		return false
	await _press(main, KEY_ESCAPE)
	await process_frame
	if main.pause_open:
		_fail("the pause menu stayed open")
		return false
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("R after the era menu did not restore the opening")
		return false
	_ok("a menu pick gives the keys back")
	return true


func _ocean_gate(main: Variant, x0: int, y0: int) -> Vector2i:
	var best := Vector2i(-1, -1)
	var best_n := 1000000
	var terrain = main.terrain
	for y in range(y0 - 12, y0 + 13):
		if y < 0 or y >= TerrainMap.CELL_H:
			continue
		for x in range(x0 - 12, x0 + 13):
			var cx := posmod(x, TerrainMap.CELL_W)
			if int(terrain.id_at(cx, y)) != 0:
				continue
			var path: Variant = terrain.route(x0, y0, cx, y, Callable())
			if not path is Array:
				continue
			var steps: Array = path
			if steps.is_empty():
				continue
			var oceans := 0
			for step in steps:
				if str(step["word"]) == "transport":
					oceans += 1
			if oceans != 1:
				continue
			if steps.size() < best_n:
				best_n = steps.size()
				best = Vector2i(cx, y)
	return best


func _touches_lane(main: Variant, path: Variant) -> bool:
	if not path is Array:
		return false
	for step in path:
		var sx := int(step["x"])
		var sy := int(step["y"])
		for i in main.game.sea.count():
			var at: Vector2i = main.game.sea.point(i)
			if at.x == sx and at.y == sy:
				return true
	return false


func _path_same(got: Variant, expect: Variant) -> bool:
	if not got is Array or not expect is Array:
		return false
	var left: Array = got
	var right: Array = expect
	if left.size() != right.size():
		return false
	for i in left.size():
		if int(left[i]["x"]) != int(right[i]["x"]) or int(left[i]["y"]) != int(right[i]["y"]):
			return false
		if int(left[i]["pace"]) != int(right[i]["pace"]):
			return false
	return true


func _stand_ins(main: Variant) -> bool:
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the stand-ins did not restore the opening")
		return false
	var blue = main.game.token("blue")
	var red = main.game.token("red")
	if main.map.piece_drawn(red) or main.map.piece_drawn(main.game.sea_token("red")):
		_fail("the opening opponent should stay beyond the stand-in sight")
		return false
	if not main.map.piece_drawn(blue) or not main.map.piece_drawn(main.game.sea_token("blue")):
		_fail("the stand-in sight hid the ordered pieces")
		return false
	var far_x: int = red.x
	var far_y: int = red.y
	red.x = blue.x + 1
	red.y = blue.y
	main.map.queue_redraw()
	await process_frame
	if not main.map.piece_drawn(red):
		_fail("an opponent beside the friendly piece stayed hidden")
		return false
	red.x = far_x
	red.y = far_y
	main.map.queue_redraw()
	await process_frame
	if main.map.piece_drawn(red):
		_fail("the opponent stayed visible after moving away")
		return false
	_ok("an opponent beyond the stand-in sight stays unseen until they are close")
	main.game.oil_reserve = 1
	var home_x: int = blue.x
	var home_y: int = blue.y
	await _click_world(main, main.map.cell_center(home_x, home_y))
	if main.game.selected_side != "blue":
		_fail("could not select the piece before the oil tick")
		return false
	await _press(main, KEY_T)
	await create_timer(0.35).timeout
	var voice := str(main.hud._note.text)
	if not main.game.oil_short or not str(main.game.note).contains("Oil shortage") or blue.x != home_x or blue.y != home_y:
		_fail("the stand-in reserve did not trip: %s" % main.game.note)
		return false
	if voice != Assumptions.SHORTAGE_VOICE or str(main.map._note.text) != Assumptions.SHORTAGE_VOICE:
		_fail("the shortage voice was not on the HUD: %s" % voice)
		return false
	if not str(main.hud._gauge.text).contains("Short"):
		_fail("the oil gauge did not read Short: %s" % str(main.hud._gauge.text))
		return false
	var dest := Vector2i(-1, -1)
	for step in TerrainMap.STEPS:
		var nx := posmod(home_x + int(step.x), TerrainMap.CELL_W)
		var ny: int = home_y + int(step.y)
		if ny < 0 or ny >= TerrainMap.CELL_H:
			continue
		var word := TerrainMap.pace_word(int(main.terrain.id_at(nx, ny)))
		if word != "open" and word != "slow":
			continue
		dest = Vector2i(nx, ny)
		break
	if dest.x < 0:
		_fail("the oil check has no step off the capital")
		return false
	var away: Vector2 = main.map.cell_center(dest.x, dest.y)
	if not await _aim(main, away):
		_fail("the oil step is off the map")
		return false
	await _click_world(main, away)
	if not blue.path.is_empty() or blue.x != home_x or blue.y != home_y or not str(main.hud._log.text).contains("Oil shortage"):
		_fail("the shortage did not stop the click: %s" % main.game.note)
		return false
	if main.time_on:
		await _press(main, KEY_T)
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset after the stand-ins did not restore the opening")
		return false
	if main.game.oil_short or main.game.oil_reserve != Assumptions.OIL_RESERVE:
		_fail("reset left the stand-in shortage in place")
		return false
	_ok("the stand-in oil reserve trips from a click, and reset clears it")
	return true


func _same_oil_order(got: Array, expect: Array) -> bool:
	if got.size() != expect.size():
		return false
	for i in got.size():
		if not got[i] is Vector2i or not expect[i] is Vector2i:
			return false
		if (got[i] as Vector2i) != (expect[i] as Vector2i):
			return false
	return true


func _polish(main: Variant) -> bool:
	if str(main.map._stamp.text) != "Held" or _find_button(main.hud, "Run") == null:
		_fail("a held clock should show Held and Run")
		return false
	var blue = main.game.token("blue")
	var home_x: int = blue.x
	var home_y: int = blue.y
	if not await _select_land(main, blue):
		_fail("could not select the piece for the quote")
		return false
	var dest := _open_near_play(main, home_x, home_y)
	if dest.x < 0:
		_fail("the quote has no step")
		return false
	var dest_at: Vector2 = main.map.cell_center(dest.x, dest.y)
	if not await _aim(main, dest_at):
		_fail("the quote step is off the map")
		return false
	await _hover_world(main, dest_at)
	var quote := str(main.map._quote.text)
	if not quote.contains("steps") or quote.contains("ratio") or quote.contains("$"):
		_fail("the route quote is wrong: %s" % quote)
		return false
	var count := int(quote.split(" ")[0])
	await _click_world(main, dest_at)
	if blue.path.size() != count:
		_fail("the quote did not match the path (%s vs %d)" % [quote, blue.path.size()])
		return false
	var cancel := _find_button(main.hud, "Cancel")
	if cancel == null:
		_fail("Cancel is missing")
		return false
	cancel.pressed.emit()
	await process_frame
	if not blue.path.is_empty():
		_fail("Cancel left the path")
		return false
	_ok("the route quote names the steps, and Cancel clears the path")
	if not await _select_land(main, blue):
		_fail("could not select the piece to follow")
		return false
	await _click_world(main, dest_at)
	if blue.path.is_empty():
		_fail("the follow order was refused: %s" % main.game.note)
		return false
	var follow := _find_button(main.hud, "Follow")
	if follow == null:
		_fail("Follow is missing")
		return false
	follow.pressed.emit()
	await process_frame
	await _press(main, KEY_T)
	if str(main.map._stamp.text) != "Running":
		_fail("Run did not stamp Running")
		return false
	var moved := false
	for _i in 8:
		await create_timer(0.14).timeout
		if blue.x != home_x or blue.y != home_y:
			moved = true
			break
	if not moved or not main.map.sees(main.map.cell_center(blue.x, blue.y)):
		_fail("Follow lost the piece")
		return false
	var ship = main.game.sea_token("red")
	if ship == null or ship.path.is_empty():
		_fail("the enemy ship did not take a path")
		return false
	_ok("Follow keeps the piece in view, and the enemy ship takes a path")
	await _press(main, KEY_T)
	await _press(main, KEY_F)
	await process_frame
	if main.follow_on or str(main.map._stamp.text) != "Held":
		_fail("Fit did not clear Follow or the Held stamp")
		return false
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before the removal fight did not restore the opening")
		return false
	blue = main.game.token("blue")
	var red = main.game.token("red")
	red.x = blue.x + 1
	red.y = blue.y
	if not await _select_land(main, blue):
		_fail("could not select the piece for the fight")
		return false
	var foe_at: Vector2 = main.map.cell_center(red.x, red.y)
	if not await _aim(main, foe_at):
		_fail("the fight is off the map")
		return false
	await _click_world(main, foe_at)
	for _i in 16:
		main.game.tick()
	main._sync()
	await process_frame
	if main.game.token("red") != null or str(main.hud._note.text) != Assumptions.GONE_VOICE:
		_fail("the defender was not removed: %s" % str(main.hud._note.text))
		return false
	_ok("the stand-in fight removes the defender")
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset before contact memory did not restore the opening")
		return false
	blue = main.game.token("blue")
	red = main.game.token("red")
	red.x = blue.x + 1
	red.y = blue.y
	main.game.tick()
	red.x = blue.x + 40
	main.game.tick()
	main._sync()
	if str(main.map._contact.text) != "Last seen":
		_fail("the contact marker was missing")
		return false
	for _i in Assumptions.CONTACT_ROUNDS:
		main.game.tick()
	main._sync()
	if str(main.map._contact.text) != "":
		_fail("the contact marker stayed up")
		return false
	_ok("a contact marker fades after 8 rounds")
	var foot = await _buy_unit(main, "Infantry", "New York")
	if foot == null:
		return false
	var row := _find_button_prefix(main.hud, "Infantry")
	if row == null:
		_fail("the unit list is missing the infantry")
		return false
	row.pressed.emit()
	await process_frame
	if main.game.focus != foot or not main.map.sees(main.map.cell_center(foot.x, foot.y)):
		_fail("the unit list did not select the infantry")
		return false
	if not str(main.hud._piece_card.text).contains("Infantry") or not str(main.hud._piece_card.text).contains("steps left"):
		_fail("the piece card is missing the name or the steps: %s" % str(main.hud._piece_card.text))
		return false
	_ok("the unit list selects the second land piece")
	var enemy := _find_button(main.minimap, "Enemy capital")
	if enemy == null:
		_fail("the minimap is missing the enemy capital")
		return false
	enemy.pressed.emit()
	await process_frame
	var moscow := _site(main, "Moscow")
	if not main.map.sees(main.map.cell_center(int(moscow["x"]), int(moscow["y"]))):
		_fail("the minimap click did not show Moscow")
		return false
	_ok("the minimap centers on the enemy capital")
	await _press(main, KEY_F)
	await process_frame
	var saved_x: int = foot.x
	var saved_y: int = foot.y
	await _press(main, KEY_ESCAPE)
	await process_frame
	if not main.pause_open or _find_button(main.pause_layer, "Resume") == null or _find_button(main.pause_layer, "Quit") == null:
		_fail("Esc did not open Resume and Quit")
		return false
	var restart := _find_button(main.pause_layer, "Restart")
	if restart == null:
		_fail("Restart is missing")
		return false
	restart.pressed.emit()
	await process_frame
	var confirm := _find_button(main.pause_layer, "Confirm")
	if confirm == null or not confirm.is_visible_in_tree():
		_fail("Restart did not ask")
		return false
	var save := _find_button(main.pause_layer, "Save")
	if save == null:
		_fail("Save is missing")
		return false
	save.pressed.emit()
	await process_frame
	if not str(main.game.note).contains("Saved the match."):
		_fail("Save did not record the match: %s" % main.game.note)
		return false
	var resume := _find_button(main.pause_layer, "Resume")
	resume.pressed.emit()
	await process_frame
	await _press(main, KEY_R)
	await process_frame
	var kept := false
	for unit in main.game.tokens:
		if unit.label == "Infantry" and unit.x == saved_x and unit.y == saved_y:
			kept = true
	if kept:
		_fail("R loaded the saved piece")
		return false
	await _press(main, KEY_ESCAPE)
	await process_frame
	var load_button := _find_button(main.pause_layer, "Load")
	if load_button == null:
		_fail("Load is missing")
		return false
	load_button.pressed.emit()
	await process_frame
	var restored := false
	for unit in main.game.tokens:
		if unit.label == "Infantry" and unit.x == saved_x and unit.y == saved_y:
			restored = true
	if not restored:
		_fail("Load did not restore the saved piece")
		return false
	_ok("save and load restore the piece, and R does not load")
	var quit := _find_button(main.pause_layer, "Quit")
	quit.pressed.emit()
	await process_frame
	if main.started or not main.start_screen.visible:
		_fail("Quit did not return to the era screen")
		return false
	if not FileAccess.file_exists("user://openchq-save.json"):
		_fail("Quit deleted the save")
		return false
	_ok("Quit leaves the save in place")
	_find_button(main.start_screen, "Start").pressed.emit()
	await process_frame
	_find_button(main.buy_screen, "Begin").pressed.emit()
	await process_frame
	if not main.started:
		_fail("Begin after Quit did not start a match")
		return false
	return true


func _phone(main: Variant) -> void:
	await _press(main, KEY_F)
	await process_frame
	var win: Window = main.get_window()
	win.min_size = Vector2i(0, 0)
	win.size = Vector2i(390, 844)
	for _i in 5:
		await process_frame
	if main.size.x >= 760.0 or not main.drawer_button.visible or main.hud.position.y < main.size.y - 2.0:
		_fail("narrow window did not hide the panel (button %s, panel y %.0f, size %s)" % [main.drawer_button.visible, main.hud.position.y, main.size])
		return
	_ok("390-wide window keeps the panel in the drawer")
	await _save(main, "phone-closed.png")
	main.drawer_button.pressed.emit()
	await process_frame
	var panel_top: float = main.hud.position.y
	if main.size.x >= 760.0 or panel_top < 1.0 or panel_top > main.size.y - 40.0:
		_fail("Controls did not open the drawer (panel y %.0f, size %s)" % [panel_top, main.size])
		return
	if main.map.size.y < 80.0 or absf(main.hud.position.y - main.map.size.y) > 2.0:
		_fail("the open drawer covered the map (map h %.0f panel y %.0f)" % [main.map.size.y, main.hud.position.y])
		return
	_ok("Controls opens the drawer and the map stays above it")
	await _save(main, "phone-open.png")


func _site_on_screen(main: Variant) -> Dictionary:
	var scale: float = main.map.view_scale
	var x0: float = (0.0 - main.map.pan_x) / scale
	var x1: float = (main.map.size.x - main.map.pan_x) / scale
	var y0: float = (0.0 - main.map.pan_y) / scale
	var y1: float = (main.map.size.y - main.map.pan_y) / scale
	var blue = main.game.token("blue")
	var red = main.game.token("red")
	for place in main.sites.places:
		var x := float(place["logic_x"])
		var y := float(place["logic_y"])
		if y < y0 or y > y1:
			continue
		if int(place["x"]) == blue.x and int(place["y"]) == blue.y:
			continue
		if int(place["x"]) == red.x and int(place["y"]) == red.y:
			continue
		var k := int(round(((x0 + x1) * 0.5 - x) / main.map.logic_w))
		if k == 0:
			continue
		var wx: float = x + float(k) * main.map.logic_w
		if wx < x0 or wx > x1:
			continue
		return {"place": place, "world": Vector2(wx, y)}
	return {}


func _oil_world(main: Variant) -> Vector2:
	var hit: float = main.map.marker_hit()
	var blue = main.game.token("blue")
	var red = main.game.token("red")
	for field in main.oil.placed:
		if not field is Dictionary:
			continue
		var world := Vector2(float(field["lx"]), float(field["ly"]))
		if main.sites.pick(world.x, world.y, hit) != null:
			continue
		if main.map.cell_center(blue.x, blue.y).distance_to(world) <= hit * 1.35:
			continue
		if main.map.cell_center(red.x, red.y).distance_to(world) <= hit * 1.35:
			continue
		return world
	return Vector2(-1, -1)


func _viewport_of(main: Variant, local: Vector2) -> Vector2:
	return main.map.position + local


func _click_world(main: Variant, world: Vector2) -> void:
	var local := Vector2(main.map.pan_x + world.x * main.map.view_scale, main.map.pan_y + world.y * main.map.view_scale)
	var at: Vector2 = main.map.position + local
	_mouse(at, true)
	await process_frame
	_mouse(at, false)
	await process_frame


func _hover_world(main: Variant, world: Vector2) -> void:
	var local := Vector2(main.map.pan_x + world.x * main.map.view_scale, main.map.pan_y + world.y * main.map.view_scale)
	var motion := InputEventMouseMotion.new()
	motion.position = main.map.position + local
	motion.global_position = motion.position
	main.get_viewport().push_input(motion)
	await process_frame


func _wheel(at: Vector2, up: bool) -> void:
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_WHEEL_UP if up else MOUSE_BUTTON_WHEEL_DOWN
	event.pressed = true
	event.position = at
	event.global_position = at
	root.push_input(event)
	await process_frame


func _drag(from: Vector2, to: Vector2) -> void:
	_mouse(from, true)
	await process_frame
	var motion := InputEventMouseMotion.new()
	motion.position = to
	motion.global_position = to
	motion.relative = to - from
	motion.button_mask = MOUSE_BUTTON_MASK_LEFT
	root.push_input(motion)
	await process_frame
	_mouse(to, false)
	await process_frame


func _mouse(at: Vector2, pressed: bool) -> void:
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = pressed
	event.position = at
	event.global_position = at
	event.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
	root.push_input(event)


func _press(main: Variant, keycode: Key) -> void:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.pressed = true
	event.echo = false
	main._unhandled_input(event)
	await process_frame


func _press_button(main: Variant, text: String) -> void:
	var button := _find_button(main.hud, text)
	if button == null:
		_fail("missing button %s" % text)
		return
	button.pressed.emit()


func _choose(main: Variant, item_id: int) -> void:
	var option := _find_option(main.hud, item_id)
	if option == null and main.get("pause_layer") != null:
		option = _find_option(main.pause_layer, item_id)
	if option == null:
		_fail("missing option %d" % item_id)
		return
	for i in option.item_count:
		if option.get_item_id(i) == item_id:
			option.select(i)
			option.item_selected.emit(i)
			return


func _find_option(node: Node, item_id: int) -> OptionButton:
	if node is OptionButton:
		var option := node as OptionButton
		for i in option.item_count:
			if option.get_item_id(i) == item_id:
				return option
	for child in node.get_children():
		var found := _find_option(child, item_id)
		if found != null:
			return found
	return null


func _find_label(node: Node, text: String) -> Label:
	if node is Label and (node as Label).text == text:
		return node
	for child in node.get_children():
		var found := _find_label(child, text)
		if found != null:
			return found
	return null


func _find_button(node: Node, text: String) -> Button:
	if node is Button:
		var got := str((node as Button).text)
		if got == text or got.begins_with(text + " —"):
			return node
	for child in node.get_children():
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


func _site(main: Variant, title: String) -> Dictionary:
	for place in main.sites.places:
		if str(place["title"]) == title:
			return place
	return {}


func _board_text(main: Variant) -> String:
	return _node_text(main)


func _node_text(node: Node) -> String:
	var bits := ""
	if node is Label or node is Button:
		bits = (node as Control).text if node is Button else (node as Label).text
	elif node is OptionButton:
		bits = (node as OptionButton).text
	for child in node.get_children():
		bits += "\n" + _node_text(child)
	return bits


func _has_digit(text: String) -> bool:
	for i in text.length():
		if text[i] >= "0" and text[i] <= "9":
			return true
	return false


func _save(main: Variant, name: String) -> void:
	await RenderingServer.frame_post_draw
	var image: Image = main.get_viewport().get_texture().get_image()
	var path := _shot_dir.path_join(name)
	var err := image.save_png(path)
	print("SHOT %s %s" % [name, error_string(err)])
	if err != OK or image.get_width() < 300 or image.get_height() < 300:
		_fail("screenshot %s was not saved" % name)
		return
	if absi(image.get_width() - int(round(main.size.x))) > 4 or absi(image.get_height() - int(round(main.size.y))) > 4:
		_fail("screenshot %s is %dx%d but the window is %s" % [name, image.get_width(), image.get_height(), main.size])
		return
	var mid := image.get_pixel(image.get_width() >> 1, image.get_height() >> 1)
	var corner := image.get_pixel(8, 8)
	var other := image.get_pixel(image.get_width() - 8, image.get_height() >> 1)
	if mid.is_equal_approx(corner) and mid.is_equal_approx(other):
		_fail("screenshot %s looks blank" % name)


func _ok(message: String) -> void:
	print("OK %s" % message)


func _fail(message: String) -> void:
	_failures.append(message)
	print("FAIL %s" % message)


func _finish() -> void:
	if _failures.is_empty():
		print("PLAY_OK")
		quit(0)
	else:
		print("PLAY_FAIL %d" % _failures.size())
		quit(1)
