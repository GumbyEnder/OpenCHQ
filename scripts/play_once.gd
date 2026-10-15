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
	if not await _capture_toronto(main):
		_finish()
		return
	await _press(main, KEY_R)
	await process_frame
	if not await _opening(main, ""):
		_fail("reset did not restore the opening")
	else:
		_ok("R restored the opening view")
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
	await _press(main, KEY_R)
	await process_frame
	if not await _win(main):
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
	_find_button(screen, "Start").pressed.emit()
	await process_frame
	if screen.visible or not main.map.visible or not main.hud.visible:
		_fail("Start did not reveal the map")
		return false
	if main.era_year != 1986 or main.player_side != "blue" or main.time_on or main.game.beat != 0:
		_fail("Start changed the opening (era %s side %s time %s beat %s)" % [main.era_year, main.player_side, main.time_on, main.game.beat])
		return false
	_ok("start screen hid the map until Start")
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
	_ok("Blue took Toronto on the live clock, capitals still split")
	_ok("Red is marching and only three steps are drawn")
	await _hover_world(main, main.map.cell_center(int(toronto["x"]), int(toronto["y"])))
	if str(main.map._chip_labels["terrain"].text) != "lake · transport":
		_fail("hover did not name the lake transport")
		return false
	_ok("hover reads lake · transport")
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
	if oil_button == null or not oil_button.disabled:
		_fail("the oil control should be disabled before 1986")
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
	if blue.path.size() != 0 or not str(main.hud._note.text).contains("damage amounts unknown"):
		_fail("ordering onto the other piece did not stop short: %s" % main.game.note)
		return false
	if blue.x == red.x and blue.y == red.y:
		_fail("the pieces occupied one cell")
		return false
	_ok("ordering onto the other piece stops short")
	return true


func _win(main: Variant) -> bool:
	# The opening frames the player's pieces, so Moscow is off that view.
	await _press(main, KEY_F)
	await process_frame
	var wash := _site(main, "Washington")
	var moscow := _site(main, "Moscow")
	await _click_world(main, main.map.cell_center(int(wash["x"]), int(wash["y"])))
	await _click_world(main, main.map.cell_center(int(moscow["x"]), int(moscow["y"])))
	var blue = main.game.token("blue")
	if main.game.selected_side != "blue" or blue.path.is_empty() or main.time_on or main.game.beat != 0:
		_fail("the moscow order was not queued from the opening: %s" % main.game.note)
		return false
	await _press(main, KEY_T)
	var won := ""
	for _i in 260:
		await create_timer(0.14).timeout
		var red = main.game.token("red")
		blue = main.game.token("blue")
		if blue.x == red.x and blue.y == red.y:
			_fail("the pieces occupied one cell on the way to moscow")
			return false
		won = main.game.winner()
		if won != "":
			break
	if won != "blue" or str(main.hud._note.text).find("holds every capital") < 0:
		_fail("the match did not end with Blue holding both capitals: %s" % main.game.note)
		return false
	if str(_site(main, "Washington")["owner"]) != "blue" or str(_site(main, "Moscow")["owner"]) != "blue":
		_fail("the capital owners do not match the winner")
		return false
	_ok("Blue holds both capitals")
	await _save(main, "winner.png")
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


func _find_button(node: Node, text: String) -> Button:
	if node is Button and (node as Button).text == text:
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
