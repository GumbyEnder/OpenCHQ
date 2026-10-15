extends SceneTree

const DataPackScript = preload("res://scripts/data_pack.gd")
const TerrainScript = preload("res://scripts/terrain_map.gd")
const SiteScript = preload("res://scripts/site_book.gd")
const OilScript = preload("res://scripts/oil_layer.gd")
const MatchScript = preload("res://scripts/match_state.gd")
const RosterScript = preload("res://scripts/roster.gd")
const StillsScript = preload("res://scripts/stills.gd")
const SeaScript = preload("res://scripts/sea_lanes.gd")
const MapScript = preload("res://scripts/map_view.gd")

var _failures: PackedStringArray = []


func _init() -> void:
	call_deferred("_run")


func _run() -> void:
	_check()
	if _failures.is_empty():
		print("CHECK_OK")
		quit(0)
	else:
		print("CHECK_FAIL %d" % _failures.size())
		quit(1)


func _check() -> void:
	var width := int(ProjectSettings.get_setting("display/window/size/viewport_width"))
	var height := int(ProjectSettings.get_setting("display/window/size/viewport_height"))
	if width != 2000 or height != 1000:
		_fail("startup window should be 2000x1000, got %dx%d" % [width, height])
	else:
		_ok("startup window 2000x1000")

	var pack = DataPackScript.new()
	var err: String = pack.open()
	if err != "":
		_fail(err)
		return
	_ok("data root %s" % pack.root)

	var terrain = TerrainScript.new()
	err = terrain.load_bytes(pack.bytes("data/tmap.bin"))
	if err != "":
		_fail(err)
		return
	if terrain.id_at(79, 44) != 8:
		_fail("Washington cell is %s, expected plain" % TerrainScript.terrain_name(terrain.id_at(79, 44)))
	else:
		_ok("Washington plain · open")
	if terrain.id_at(78, 37) != 3 or TerrainScript.pace_word(3) != "transport":
		_fail("Toronto cell is not a lake transport")
	else:
		_ok("Toronto cell lake · transport")
	if TerrainScript.land_pace(14) >= 0 or TerrainScript.pace_word(14) != "blocked":
		_fail("wasteland should be refused")
	if TerrainScript.pace_word(0) != "transport" or TerrainScript.land_pace(0) != 2:
		_fail("ocean should be a 2-beat transport stand-in")
	if TerrainScript.pace_word(2) != "slow" or TerrainScript.terrain_name(2) != "shallows":
		_fail("id 2 should be shallows · slow")
	if TerrainScript.land_pace(1) != 1 or TerrainScript.pace_word(8) != "open":
		_fail("docks and plain should be open")
	var saw_shallows := false
	for y in TerrainScript.CELL_H:
		for x in TerrainScript.CELL_W:
			if terrain.id_at(x, y) == 2:
				saw_shallows = true
				break
		if saw_shallows:
			break
	if not saw_shallows:
		_fail("tmap has no shallows cell")
	else:
		_ok("shallows exist and stay slow, not a transport")

	var countries: Array = pack.json_dict("data/game_meta.json").get("countries", [])
	var sites = SiteScript.new()
	err = sites.load_sites(pack.json_array("data/sites.json"), countries, 96.0)
	if err != "":
		_fail(err)
		return
	if sites.count() != 84:
		_fail("expected 84 sites, got %d" % sites.count())
	else:
		_ok("84 sites")
	var blue_cap: Dictionary = sites.capital("blue")
	var red_cap: Dictionary = sites.capital("red")
	if int(blue_cap["x"]) != 79 or int(blue_cap["y"]) != 44 or str(blue_cap["title"]) != "Washington":
		_fail("blue capital is %s (%s,%s)" % [blue_cap["title"], blue_cap["x"], blue_cap["y"]])
	else:
		_ok("blue capital Washington (79, 44)")
	if int(red_cap["x"]) != 183 or int(red_cap["y"]) != 25 or str(red_cap["title"]) != "Moscow":
		_fail("red capital is %s (%s,%s)" % [red_cap["title"], red_cap["x"], red_cap["y"]])
	else:
		_ok("red capital Moscow (183, 25)")

	terrain.paint_sites(sites.places)
	if terrain.id_at(79, 44) != 4 or terrain.id_at(183, 25) != 4:
		_fail("capitals should paint their centers")
	elif terrain.id_at(78, 37) != 6:
		_fail("Toronto center should paint as city")
	elif terrain.id_at(182, 13) != 6 or terrain.id_at(181, 12) != 1 or terrain.id_at(181, 13) != 6:
		_fail("Archangel should paint city, a water neighbor as docks, and a land neighbor as city")
	elif terrain.id_at(18, 18) != 8:
		_fail("a facility center was painted; that kind is not a disposition subtype")
	else:
		var docks := 0
		var cities := 0
		var capitals := 0
		for y in TerrainScript.CELL_H:
			for x in TerrainScript.CELL_W:
				var painted := terrain.id_at(x, y)
				if painted == 1:
					docks += 1
				elif painted == 4:
					capitals += 1
				elif painted == 6:
					cities += 1
		if capitals != 2 or docks != 150 or cities != 407:
			_fail("painted map has %d capitals, %d docks, %d city cells" % [capitals, docks, cities])
		else:
			_ok("capitals and cities paint centers and neighbors; facilities do not")
	_check_paint_kinds(pack)
	_check_picture(terrain)

	var same: Variant = terrain.route(79, 44, 79, 44, Callable())
	if not same is Array or not (same as Array).is_empty():
		_fail("route onto the same cell should be an empty path")
	else:
		_ok("same-cell route is empty")

	var nyc: Variant = terrain.route(79, 44, 83, 42, Callable())
	if not nyc is Array or _cost(nyc) != 6:
		_fail("Washington to (83, 42) cost %s, expected 6" % _cost_text(nyc))
	else:
		_ok("Washington to New York cell is 6 beats")

	var moscow: Variant = terrain.route(79, 44, 183, 25, Callable())
	if not moscow is Array or _cost(moscow) != 168:
		_fail("Washington to Moscow cost %s, expected 168" % _cost_text(moscow))
	else:
		_ok("Washington to Moscow is 168 beats on the painted map (%d cells)" % (moscow as Array).size())

	var land := _land_reach(terrain, 79, 44)
	if bool(land["moscow"]):
		_fail("land-only walk reached Moscow")
	else:
		_ok("land-only walk from Washington misses Moscow (%d cells)" % int(land["count"]))

	var game = MatchScript.new()
	game.terrain = terrain
	game.sites = sites
	game.reset()
	var bad := game.order("blue", 79, -1)
	if not bad.contains("No route"):
		_fail("off-map order should refuse, got: %s" % bad)
	var kept_order := game.order("blue", 83, 42)
	var kept := game.token("blue").path.size()
	if kept_order != "" or kept <= 0:
		_fail("order to the New York cell was refused")
	var refused_again := game.order("blue", 79, -1)
	if not refused_again.contains("No route") or game.token("blue").path.size() != kept:
		_fail("a refused order cleared the existing path")
	else:
		_ok("a refused order leaves the current path")

	game.reset()
	var toronto: Variant = null
	for place in sites.places:
		if str(place["title"]) == "Toronto":
			toronto = place
			break
	if toronto == null:
		_fail("Toronto is missing")
	else:
		var ordered := game.order("blue", int(toronto["x"]), int(toronto["y"]))
		if ordered != "":
			_fail("Toronto order refused: %s" % ordered)
		else:
			var guard := 0
			while str(toronto["owner"]) != "blue" and guard < 40:
				game.tick()
				guard += 1
			if str(toronto["owner"]) != "blue" or game.winner() != "":
				_fail("Toronto capture failed at beat %d" % game.beat)
			elif not str(game.note).contains("took"):
				_fail("capture note missing: %s" % game.note)
			else:
				_ok("Blue took Toronto in %d beats, capitals still split" % game.beat)

	game.reset()
	var blue = game.token("blue")
	var red = game.token("red")
	red.x = blue.x + 1
	red.y = blue.y
	var stopped := game.order("blue", red.x, red.y)
	if not stopped.contains("damage amounts unknown") or not blue.path.is_empty():
		_fail("adjacent contact should stop with an empty path, got: %s" % stopped)
	elif game.note != stopped:
		_fail("contact should set the blue note")
	else:
		_ok("adjacent contact stops short")

	var sample := [{"x": 1}, {"x": 2}, {"x": 3}, {"x": 4}, {"x": 5}]
	if MatchScript.visible_steps(sample, "blue").size() != 5 or MatchScript.visible_steps(sample, "red").size() != 3:
		_fail("enemy routes should draw only the first three steps")
	elif not MatchScript.visible_steps([], "red").is_empty():
		_fail("empty routes should stay empty")
	else:
		_ok("enemy route draws three steps")

	if RosterScript.token_kind(1918, "open") != "" or RosterScript.token_kind(1918, "transport") != "transport":
		_fail("1918 land should stay a disc, transport should use the transport frame")
	elif RosterScript.token_kind(1942, "slow") != "land" or RosterScript.token_kind(9999, "open") != "land":
		_fail("1942 and the concealed era should use the land frame on open ground")
	else:
		_ok("token frames follow the era")
	var early_notes := RosterScript.notes_for(1918)
	var late_notes := RosterScript.notes_for(9999)
	if early_notes.is_empty() or not str(early_notes[0]).contains("Infantry"):
		_fail("1918 roster should say the infantry frame is missing")
	elif late_notes.is_empty() or not str(late_notes[late_notes.size() - 1]).contains("hides the opponent") or not str(late_notes[late_notes.size() - 1]).contains("capital"):
		_fail("concealed era should hide the opponent until their capital is found")
	else:
		_ok("roster notes")

	var stills = StillsScript.new()
	stills.load_pack(pack)
	var roster_files: Array = [RosterScript.ART_LAND, RosterScript.ART_TRANSPORT, RosterScript.ART_SEA]
	for row in RosterScript.ROWS:
		var rel := str(row["file"])
		if not roster_files.has(rel):
			roster_files.append(rel)
	var missing_roster := false
	for rel in roster_files:
		if not stills.has_file(rel) or not FileAccess.file_exists(pack.root.path_join(rel)):
			missing_roster = true
	var missing_png := false
	if stills.names.size() == 26 and stills.image_count() == 278:
		for stem in stills.names:
			for rel in stills.files_for(stem):
				if not FileAccess.file_exists(pack.root.path_join(rel)):
					missing_png = true
	if StillsScript.PLAYBACK_KNOWN:
		_fail("stills claimed a playback order")
	elif stills.names.size() != 26 or stills.image_count() != 278 or missing_png:
		_fail("expected the extracted still set, got %d animations and %d files" % [stills.names.size(), stills.image_count()])
	elif missing_roster or stills.files_for("BOMBCITY").is_empty() or stills.files_for("WAR2").is_empty():
		_fail("a unit or cutscene still is missing from the extract")
	elif not stills.files_for("NOPE").is_empty():
		_fail("an unknown animation should stay empty")
	elif not _blank_text(StillsScript.NOTE) or not StillsScript.NOTE.contains("unknown"):
		_fail("the still note should leave playback order unknown")
	else:
		_ok("unit and cutscene stills, no playback order")

	game.reset()
	for place in sites.places:
		if str(place["kind"]) == "capital":
			place["owner"] = "blue"
	if game.winner() != "blue":
		_fail("owning both capitals should win")
	else:
		_ok("both capitals win")
	game.reset()
	if game.winner() != "" or game.beat != 0:
		_fail("reset should clear the winner and the clock")

	game.reset()
	var raced := game.order("blue", 183, 25)
	var shared := false
	var won := ""
	var met := false
	if raced != "":
		_fail("the moscow order was refused: %s" % raced)
	else:
		for _i in 220:
			game.tick()
			var blue_at = game.token("blue")
			var red_at = game.token("red")
			if blue_at.x == red_at.x and blue_at.y == red_at.y:
				shared = true
			if str(game.note).contains("damage amounts unknown"):
				met = true
			won = game.winner()
			if won != "":
				break
		if shared or not met or won != "red":
			_fail("painted routes should meet short of a shared cell, then red holds both capitals (won %s)" % won)
		else:
			_ok("painted routes meet short of a shared cell, then red holds both capitals")
	game.reset()
	var stepped := ""
	for _i in 220:
		game.tick()
		if str(game.note).contains("damage amounts unknown"):
			stepped = game.note
			break
	var held_blue = game.token("blue")
	var held_red = game.token("red")
	if stepped == "" or (held_blue.x == held_red.x and held_blue.y == held_red.y):
		_fail("red should stop short of the occupied capital")
	else:
		var onto: String = game.order("blue", held_red.x, held_red.y)
		if not onto.contains("damage amounts unknown") or not game.token("blue").path.is_empty():
			_fail("ordering onto the adjacent piece should stop short, got: %s" % onto)
		else:
			_ok("stepping onto the capital and ordering onto that piece both stop short")
	game.reset()
	if game.winner() != "" or game.beat != 0:
		_fail("reset after a played match should clear the winner")

	game.player_side = "red"
	game.reset()
	var played_red = game.token("red")
	var marched_blue = game.token("blue")
	var took_red: String = game.order("red", 79, 44)
	if took_red != "" or played_red.path.is_empty() or not str(game.note).begins_with("Red"):
		_fail("red should take the order when it is the side you play: %s" % took_red)
	else:
		game.tick()
		if marched_blue.path.is_empty() or played_red.path.is_empty():
			_fail("blue should march on its own and leave the red order in place")
		elif str(game.note).begins_with("Blue"):
			_fail("blue's march should not take the note from red")
		else:
			_ok("red takes orders and blue marches on its own")
	game.player_side = "blue"
	game.reset()

	var oil = OilScript.new()
	oil.load_doc(pack.json_any("data/resources_oil.json"), 30720.0, 13632.0)
	var later := false
	for field in oil.all:
		if int(field.get("era_min", 0)) > 1918:
			later = true
			break
	oil.set_era(1918)
	var n1918 := oil.count()
	for field in oil.placed:
		if int(field.get("era_min", 0)) > 1918:
			_fail("1918 oil list includes a later field")
			break
	oil.set_era(1986)
	var n1986 := oil.count()
	oil.set_era(9999)
	if later and not (n1918 < n1986 and n1986 <= oil.count()):
		_fail("oil era filter did not grow from 1918 to 1986")
	else:
		_ok("oil fields follow the era and have no rate")
	if oil.placed.is_empty():
		_fail("oil pack produced no fields")
	else:
		var blurb: String = oil.blurb(oil.placed[0])
		if not blurb.contains("Rate unknown") or blurb.to_lower().contains("production"):
			_fail("oil card should say the rate is unknown")

	_check_sea(pack, terrain, game)
	_check_eras(terrain, game)
	_check_blank(game)
	_check_concealed(terrain, game)

	var tex: Texture2D = pack.texture("pics/WORLD_MAP.png")
	if tex == null or tex.get_width() != 320 or tex.get_height() != 142:
		_fail("map image should be the 320×142 source")
	else:
		_ok("map image 320×142")


func _check_paint_kinds(pack) -> void:
	var scratch = TerrainScript.new()
	var err: String = scratch.load_bytes(pack.bytes("data/tmap.bin"))
	if err != "":
		_fail(err)
		return
	var oil_at := {}
	var base_at := {}
	var plain_at := scratch.id_at(35, 30)
	var forest_at := scratch.id_at(39, 30)
	var facility_at := scratch.id_at(60, 50)
	for dy in range(-1, 2):
		for dx in range(-1, 2):
			if dx == 0 and dy == 0:
				continue
			oil_at[Vector2i(dx, dy)] = scratch.id_at(30 + dx, 30 + dy)
			base_at[Vector2i(dx, dy)] = scratch.id_at(50 + dx, 50 + dy)
	scratch.paint_sites([
		{"id": 0, "kind": "oilfield", "x": 30, "y": 30},
		{"id": 1, "kind": "plain", "x": 34, "y": 30},
		{"id": 2, "kind": "forest", "x": 38, "y": 30},
		{"id": 3, "kind": "base", "x": 50, "y": 50},
		{"id": 4, "kind": "facility", "x": 60, "y": 50},
	])
	if scratch.id_at(30, 30) != 7 or scratch.id_at(34, 30) != 8 or scratch.id_at(38, 30) != 9:
		_fail("oilfield, plain, and forest should paint the center only")
		return
	if scratch.id_at(35, 30) != plain_at or scratch.id_at(39, 30) != forest_at:
		_fail("plain and forest painted a neighbor")
		return
	if scratch.id_at(60, 50) != facility_at:
		_fail("facility paint should leave the center alone")
		return
	for step in oil_at.keys():
		var off: Vector2i = step
		if scratch.id_at(30 + off.x, 30 + off.y) != int(oil_at[off]):
			_fail("an oilfield painted a neighbor")
			return
	if scratch.id_at(50, 50) != 5:
		_fail("a base should paint its center")
		return
	for step in base_at.keys():
		var off: Vector2i = step
		var was := int(base_at[off])
		var want := 1 if was <= 2 else 6
		if scratch.id_at(50 + off.x, 50 + off.y) != want:
			_fail("base neighbor (%d,%d) is %d, expected %d" % [off.x, off.y, scratch.id_at(50 + off.x, 50 + off.y), want])
			return
	_ok("oilfields paint the center only; bases paint neighbors")


func _check_picture(terrain) -> void:
	var cells: Array = terrain.picture_cells()
	var docks := 0
	var cities := 0
	var capitals := 0
	var facility := false
	var washington := false
	var toronto := false
	var archangel_dock := false
	for cell in cells:
		var id := int(cell["id"])
		var x := int(cell["x"])
		var y := int(cell["y"])
		if x == 18 and y == 18:
			facility = true
		if id == 1:
			docks += 1
		elif id == 4:
			capitals += 1
		elif id == 6:
			cities += 1
		else:
			_fail("picture cell is %s" % TerrainScript.terrain_name(id))
			return
		if x == 79 and y == 44 and id == 4:
			washington = true
		if x == 78 and y == 37 and id == 6:
			toronto = true
		if x == 181 and y == 12 and id == 1:
			archangel_dock = true
	if facility:
		_fail("a facility cell was drawn on the picture")
		return
	if not washington or not toronto or not archangel_dock:
		_fail("picture is missing a capital, a city, or a dock")
		return
	if capitals != 2 or docks != 150 or cities != 407:
		_fail("picture has %d capitals, %d docks, %d city cells" % [capitals, docks, cities])
		return
	var view = MapScript.new()
	view.terrain = terrain
	view.rebuild_paint()
	if view.paint_count() != cells.size():
		_fail("the map does not draw every painted dock, city, and capital")
		return
	if not view.draws_paint_id(1) or not view.draws_paint_id(4) or not view.draws_paint_id(6):
		_fail("docks, cities, or capitals have no picture color")
		return
	if view.draws_paint_id(5) or view.draws_paint_id(7) or view.draws_paint_id(8) or view.draws_paint_id(9):
		_fail("the picture should leave file terrain and facilities alone")
		return
	view.free()
	_ok("picture draws docks, cities, and capitals; facilities stay")


func _check_owned_frame(game) -> bool:
	var view = MapScript.new()
	view.size = Vector2(1660, 1000)
	view.game = game
	var blue_land = game.token("blue")
	var blue_sea = game.sea_token("blue")
	var red_land = game.token("red")
	var red_sea = game.sea_token("red")
	if not view.marked_piece(blue_land) or not view.marked_piece(blue_sea):
		view.free()
		_fail("the player's land piece and ship should be marked")
		return false
	if view.marked_piece(red_land) or view.marked_piece(red_sea):
		view.free()
		_fail("the opponent's pieces should stay unmarked")
		return false
	var land_at: Vector2 = view.cell_center(blue_land.x, blue_land.y)
	var ship_at: Vector2 = view.cell_center(blue_sea.x, blue_sea.y)
	view.frame_points([land_at, ship_at])
	if view.is_near_fit() or not view.sees(land_at) or not view.sees(ship_at):
		view.free()
		_fail("the opening should frame the player's land piece and ship")
		return false
	game.player_side = "red"
	var red_land_at: Vector2 = view.cell_center(red_land.x, red_land.y)
	var red_ship_at: Vector2 = view.cell_center(red_sea.x, red_sea.y)
	if not view.marked_piece(red_land) or not view.marked_piece(red_sea) or view.marked_piece(blue_land):
		game.player_side = "blue"
		view.free()
		_fail("marks should follow the ordered side")
		return false
	view.frame_points([red_land_at, red_ship_at])
	if view.is_near_fit() or not view.sees(red_land_at) or not view.sees(red_ship_at):
		game.player_side = "blue"
		view.free()
		_fail("the opening should frame the red land piece and ship")
		return false
	game.player_side = "blue"
	view.free()
	_ok("the ordered land piece and ship are marked and framed")
	return true


func _check_sea(pack, terrain, game) -> void:
	var lanes = SeaScript.new()
	var err: String = lanes.load_bytes(pack.bytes("exe/CHQ_unpacked.EXE"))
	if err != "":
		_fail(err)
		return
	if lanes.count() != 151:
		_fail("expected 151 sea-lane waypoints, got %d" % lanes.count())
		return
	var raw = TerrainScript.new()
	err = raw.load_bytes(pack.bytes("data/tmap.bin"))
	if err != "":
		_fail(err)
		return
	var first: Vector2i = lanes.point(0)
	var last: Vector2i = lanes.point(150)
	if first != Vector2i(0, 15) or raw.id_at(first.x, first.y) != 0:
		_fail("sea-lane 0 should be ocean at (0, 15)")
		return
	if last != Vector2i(318, 10) or raw.id_at(last.x, last.y) != 13:
		_fail("sea-lane 150 should be polar at (318, 10)")
		return
	var water := 0
	var marks := {}
	for i in lanes.count():
		var at: Vector2i = lanes.point(i)
		marks["%d,%d" % [at.x, at.y]] = true
		var id: int = raw.id_at(at.x, at.y)
		if id <= 2:
			water += 1
	if water != 124:
		_fail("sea lanes on the file map: %d water, expected 124" % water)
		return
	_ok("151 sea-lane waypoints, 124 on water")

	if terrain.id_at(155, 16) != 2 or terrain.id_at(155, 15) != 0 or terrain.id_at(155, 17) != 0:
		_fail("the shallows sample at (155, 16) moved")
		return
	var through: Variant = terrain.straight_walk(155, 15, 155, 17, 0)
	var refused: Variant = terrain.straight_walk(155, 15, 155, 17, 1)
	if not through is Array or (through as Array).size() != 2:
		_fail("class 0 should cross the shallows cell")
		return
	var slow: Dictionary = (through as Array)[0]
	if int(slow["x"]) != 155 or int(slow["y"]) != 16 or int(slow["pace"]) != 2 or str(slow["word"]) != "slow":
		_fail("shallows step should be slow, got %s" % str(slow))
		return
	if refused != null:
		_fail("class 1 should refuse shallows")
		return
	if terrain.id_at(182, 12) != 1:
		_fail("dock sample (182, 12) is %s" % TerrainScript.terrain_name(terrain.id_at(182, 12)))
		return
	var dock0: Variant = terrain.straight_walk(181, 12, 183, 12, 0)
	var dock1: Variant = terrain.straight_walk(181, 12, 183, 12, 1)
	if not dock0 is Array or not dock1 is Array or (dock0 as Array).is_empty() or (dock1 as Array).is_empty():
		_fail("both ship classes should enter docks")
		return
	if str((dock1 as Array)[0]["word"]) != "sea" or int((dock1 as Array)[0]["pace"]) != 1:
		_fail("a dock step should be sea pace 1")
		return
	if terrain.straight_walk(79, 44, 83, 42, 0) != null or terrain.straight_walk(10, 10, 10, 10, 0) == null:
		_fail("a land line should fail and a same cell should be empty")
		return
	if not (terrain.straight_walk(10, 10, 10, 10, 0) as Array).is_empty():
		_fail("same-cell straight walk should be empty")
		return
	_ok("class 0 crosses shallows; class 1 refuses them; both enter docks")

	if terrain.straight_walk(0, 10, 20, 53, 0) != null or terrain.straight_walk(0, 10, 20, 53, 1) != null:
		_fail("the Atlantic sample should not be a straight walk")
		return
	game.sea = lanes
	var sailed: Variant = game.ship_route(0, 10, 20, 53, 0)
	var sailed1: Variant = game.ship_route(0, 10, 20, 53, 1)
	if not sailed is Array or not sailed1 is Array:
		_fail("sea-lane graph should route the Atlantic sample")
		return
	var path0: Array = sailed
	var path1: Array = sailed1
	if path0.size() != 87 or path1.size() != 87:
		_fail("Atlantic graph route is %d and %d cells, expected 87" % [path0.size(), path1.size()])
		return
	var end0: Dictionary = path0[path0.size() - 1]
	var end1: Dictionary = path1[path1.size() - 1]
	if int(path0[0]["x"]) != 0 or int(path0[0]["y"]) != 11 or int(end0["x"]) != 20 or int(end0["y"]) != 53:
		_fail("class 0 graph route does not run (0, 11) to (20, 53)")
		return
	if int(end1["x"]) != 20 or int(end1["y"]) != 53:
		_fail("class 1 graph route misses (20, 53)")
		return
	var saw := false
	for step in path0:
		var id: int = terrain.id_at(int(step["x"]), int(step["y"]))
		if not TerrainScript.sea_accepts(0, id):
			_fail("class 0 route entered %s" % TerrainScript.terrain_name(id))
			return
		if marks.has("%d,%d" % [int(step["x"]), int(step["y"])]):
			saw = true
	if not saw:
		_fail("class 0 route did not touch a sea-lane waypoint")
		return
	for step in path1:
		var id1: int = terrain.id_at(int(step["x"]), int(step["y"]))
		if not TerrainScript.sea_accepts(1, id1):
			_fail("class 1 route entered %s" % TerrainScript.terrain_name(id1))
			return
	if game.ship_route(0, 10, 0, -1, 0) != null:
		_fail("an off-map ship order should fail")
		return
	_ok("ships use the sea-lane graph when the straight walk fails")


func _check_eras(terrain, game) -> void:
	for year in [1918, 1942]:
		for tool in ["oil", "nuke", "satellite", "foreign_aid", "intel"]:
			if RosterScript.tool_open(year, tool):
				_fail("%s should not open %s" % [year, tool])
				return
	for year in [1986, 2023]:
		for tool in ["oil", "nuke", "satellite", "foreign_aid", "intel"]:
			if not RosterScript.tool_open(year, tool):
				_fail("%s should open %s" % [year, tool])
				return
	if not RosterScript.tool_open(9999, "oil"):
		_fail("the concealed start should keep oil")
		return
	for tool in ["nuke", "satellite", "foreign_aid", "intel"]:
		if RosterScript.tool_open(9999, tool):
			_fail("the concealed start should not open %s" % tool)
			return
	var n1918 := _row_names(1918)
	var n1942 := _row_names(1942)
	var n1986 := _row_names(1986)
	var n2023 := _row_names(2023)
	var n9999 := _row_names(9999)
	if not n1918.has("Cruiser") or not n1918.has("Submarine") or not n1918.has("Transport"):
		_fail("1918 roster is missing a ship: %s" % ", ".join(n1918))
		return
	if n1918.has("Tanks") or n1918.has("Nuke"):
		_fail("1918 roster includes a later row: %s" % ", ".join(n1918))
		return
	if not n1942.has("Tanks") or not n1942.has("Aircraft") or not n1942.has("Carrier") or n1942.has("Nuke"):
		_fail("1942 roster is %s" % ", ".join(n1942))
		return
	if not n1986.has("Nuke") or not n1986.has("Recon sat") or not n1986.has("Killer sat") or not n2023.has("Nuke"):
		_fail("1986 and 2023 should list nukes and satellites")
		return
	if n9999.has("Nuke") or n9999.has("Recon sat") or n9999.has("Killer sat") or not n9999.has("Carrier"):
		_fail("concealed roster is %s" % ", ".join(n9999))
		return
	_ok("roster and tools follow the five eras")

	game.reset()
	var owners := {}
	for place in game.sites.places:
		owners[int(place["id"])] = str(place["owner"])
	game.era_year = 1918
	for tool in ["nuke", "satellite", "foreign_aid", "intel"]:
		var refused: String = game.use_tool("blue", tool)
		if not refused.contains("not in this era"):
			_fail("1918 %s was not refused: %s" % [tool, refused])
			return
	game.era_year = 9999
	if not game.use_tool("blue", "intel").contains("not in this era"):
		_fail("concealed intel was not refused")
		return
	for year in [1986, 2023]:
		game.era_year = year
		for tool in ["nuke", "satellite", "foreign_aid", "intel"]:
			var opened: String = game.use_tool("blue", tool)
			if not opened.contains("unknown") or opened.contains("not in this era") or opened.contains("$"):
				_fail("%s %s should stay unlabeled: %s" % [year, tool, opened])
				return
	for place in game.sites.places:
		if str(place["owner"]) != str(owners[int(place["id"])]):
			_fail("a tool changed a site owner")
			return
	if game.beat != 0:
		_fail("a tool advanced the clock")
		return
	_ok("nukes, satellites, foreign aid, and intel stay gated and unlabeled")

	game.era_year = 1986
	game.reset()
	var blue_land = game.token("blue")
	var red_land = game.token("red")
	var blue_sea = game.sea_token("blue")
	var red_sea = game.sea_token("red")
	if blue_sea == null or red_sea == null or blue_land == null or red_land == null:
		_fail("each side should have a land piece and a sea piece")
		return
	if blue_land.x != 79 or blue_land.y != 44 or red_land.x != 183 or red_land.y != 25:
		_fail("land pieces left their capitals")
		return
	if blue_sea.ship_class != 0 or not TerrainScript.sea_accepts(0, terrain.id_at(blue_sea.x, blue_sea.y)):
		_fail("the blue sea piece should start on water at walker class 0")
		return
	if not TerrainScript.sea_accepts(0, terrain.id_at(red_sea.x, red_sea.y)):
		_fail("the red sea piece should start on water")
		return
	if not _check_owned_frame(game):
		return
	var corridor: Variant = terrain.route(79, 44, 183, 25, Callable())
	if corridor is Array:
		for step in corridor:
			var sx := int(step["x"])
			var sy := int(step["y"])
			if (sx == blue_sea.x and sy == blue_sea.y) or (sx == red_sea.x and sy == red_sea.y):
				_fail("a sea piece sits on the capital route at (%d, %d)" % [sx, sy])
				return
	game.selected_side = "blue"
	game.selected_domain = "sea"
	blue_sea.x = 0
	blue_sea.y = 10
	var kept_x: int = blue_land.x
	var kept_y: int = blue_land.y
	var sailed: String = game.order("blue", 20, 53)
	var expect: Variant = game.ship_route(0, 10, 20, 53, 0)
	if sailed != "" or not _same_path(blue_sea.path, expect) or blue_sea.path.size() != 87:
		_fail("sea order should follow ship_route, got %s (%d cells)" % [sailed, blue_sea.path.size()])
		return
	if blue_land.x != kept_x or blue_land.y != kept_y or not blue_land.path.is_empty():
		_fail("the sea order moved the land piece")
		return
	blue_sea.x = 155
	blue_sea.y = 15
	blue_sea.ship_class = 0
	var across: String = game.order("blue", 155, 17)
	var across_expect: Variant = game.ship_route(155, 15, 155, 17, 0)
	var saw_shallows := false
	if across != "" or not _same_path(blue_sea.path, across_expect):
		_fail("class 0 sea order should match ship_route across shallows")
		return
	for step in blue_sea.path:
		if int(step["x"]) == 155 and int(step["y"]) == 16 and int(step["pace"]) == 2:
			saw_shallows = true
	if not saw_shallows:
		_fail("class 0 sea order missed the shallows cell")
		return
	blue_sea.x = 155
	blue_sea.y = 15
	blue_sea.ship_class = 1
	blue_sea.path = []
	var class1: Variant = game.ship_route(155, 15, 155, 17, 1)
	var class1_msg: String = game.order("blue", 155, 17)
	if class1 == null:
		if class1_msg != "No route." or not blue_sea.path.is_empty():
			_fail("class 1 sea order should refuse with ship_route, got %s" % class1_msg)
			return
	elif not _same_path(blue_sea.path, class1) or _same_path(blue_sea.path, across_expect):
		_fail("class 1 sea order did not follow ship_route")
		return
	_ok("a sea order calls ship_route")

	game.selected_side = ""
	game.selected_domain = ""
	blue_land.x = 0
	blue_land.y = 10
	blue_land.path = []
	var red = game.token("red")
	var blocked := func(nx: int, ny: int) -> bool:
		return red.x == nx and red.y == ny
	var land_msg: String = game.order("blue", 20, 53)
	var land_expect: Variant = terrain.route(0, 10, 20, 53, blocked)
	if land_expect == null:
		if not land_msg.contains("No route") or not blue_land.path.is_empty():
			_fail("land order should refuse with terrain.route, got %s" % land_msg)
			return
	elif land_msg != "" or not _same_path(blue_land.path, land_expect):
		_fail("land order left terrain.route")
		return
	if expect is Array and _same_path(blue_land.path, expect):
		_fail("land order used the sea-lane path")
		return
	_ok("the land piece keeps terrain.route")
	game.reset()


func _check_blank(game) -> void:
	var held_line := "Oil shortage. Movement is stopped. Planes are grounded. City income is stopped."
	game.era_year = 1986
	game.reset()
	if game.income_blue != 0 or game.income_red != 0 or game.oil_short:
		_fail("reset should clear income and the shortage flag")
		return
	var priced: String = game.price_line()
	if not priced.contains("twice") or not _blank_text(priced):
		_fail("the price line should name the tank ratio and no figure: %s" % priced)
		return
	var tank_named := false
	for row in game.price_rows():
		if str(row.get("cost", "x")) != "" or not _blank_text(str(row.get("relation", ""))):
			_fail("a price cell was filled: %s" % str(row))
			return
		if str(row.get("name", "")) == "Tank" and str(row.get("relation", "")).contains("twice"):
			tank_named = true
		if str(row.get("name", "")) == "Nuke" and str(row.get("cost", "x")) != "":
			_fail("the nuke price should stay blank")
			return
	if not tank_named:
		_fail("the tank row should keep the twice relation and an empty cost")
		return
	game.tick()
	if game.income_blue != 1 or game.income_red != 1:
		_fail("one round of city income should be one mark, not a rate (%s, %s)" % [game.income_blue, game.income_red])
		return
	var paid: String = game.income_line("blue")
	if paid != "City income. Amount unknown." or not _blank_text(paid):
		_fail("city income should stay unlabeled: %s" % paid)
		return
	for place in game.sites.places:
		if str(place["kind"]) == "city":
			place["owner"] = "neutral"
	var mark_b: int = game.income_blue
	var mark_r: int = game.income_red
	game.tick()
	if game.income_blue != mark_b or game.income_red != mark_r:
		_fail("cities that are not held should not pay")
		return
	if game.income_line("blue") != "No city income.":
		_fail("a side with no city should not show an amount")
		return
	game.reset()
	var blue = game.token("blue")
	var queued: String = game.order("blue", 83, 42)
	var kept: Array = blue.path.duplicate()
	var debt: int = blue.debt
	var x: int = blue.x
	var y: int = blue.y
	if queued != "" or kept.is_empty():
		_fail("the income setup could not queue a land move")
		return
	game.oil_short = true
	var stopped: String = game.order("blue", 80, 44)
	if stopped != held_line or not _blank_text(stopped):
		_fail("shortage should stop movement without a rate: %s" % stopped)
		return
	if blue.x != x or blue.y != y or blue.debt != debt or not _same_path(blue.path, kept):
		_fail("a shortage should leave the land path alone")
		return
	game.tick()
	if blue.x != x or blue.y != y or blue.debt != debt or game.income_blue != 0:
		_fail("a shortage should freeze movement and city income")
		return
	if not game.planes_grounded() or game.income_line("red") != "City income is stopped.":
		_fail("a shortage should ground planes and stop city income")
		return
	game.selected_side = "blue"
	game.selected_domain = "sea"
	var ship = game.sea_token("blue")
	ship.x = 0
	ship.y = 10
	game.oil_short = false
	var sailed: String = game.order("blue", 20, 53)
	var sea_kept: int = ship.path.size()
	if sailed != "" or sea_kept != 87:
		_fail("sea setup before the shortage failed: %s" % sailed)
		return
	game.oil_short = true
	var sea_held: String = game.order("blue", 0, 12)
	if sea_held != held_line or ship.path.size() != sea_kept:
		_fail("a shortage should stop a ship without rewriting its path")
		return
	game.selected_side = ""
	game.selected_domain = ""
	for year in [1918, 1942]:
		game.era_year = year
		game.reset()
		game.oil_short = true
		if game.planes_grounded() or game.shortage():
			_fail("%s should ignore an oil shortage" % year)
			return
		var moved: String = game.order("blue", 83, 42)
		if moved != "":
			_fail("%s movement was stopped: %s" % [year, moved])
			return
		game.tick()
		if game.income_blue != 1 or game.income_line("blue") != "City income. Amount unknown.":
			_fail("%s should still pay cities: %s" % [year, game.income_line("blue")])
			return
	for year in [1986, 2023, 9999]:
		game.era_year = year
		game.reset()
		var land = game.token("blue")
		var red = game.token("red")
		if land.x != 79 or land.y != 44 or red.x != 183 or red.y != 25:
			_fail("%s changed the starting pieces" % year)
			return
		if game.sea_token("blue") == null or game.sea_token("red") == null:
			_fail("%s dropped a sea piece" % year)
			return
		game.oil_short = true
		if not game.planes_grounded() or game.order("blue", 83, 42) != held_line:
			_fail("%s shortage did not stop movement and planes" % year)
			return
		game.tick()
		if game.income_blue != 0 or land.x != 79:
			_fail("%s shortage still paid or moved" % year)
			return
	_ok("city income and oil shortage stay blank")

	game.era_year = 1986
	game.reset()
	blue = game.token("blue")
	var red_land = game.token("red")
	blue.facing = Vector2i(0, -1)
	red_land.facing = Vector2i(0, -1)
	red_land.x = 80
	red_land.y = 44
	if game.approach_word(blue, red_land) != "flank":
		_fail("a side approach should be a flank")
		return
	red_land.x = 79
	red_land.y = 43
	if game.approach_word(blue, red_land) != "front":
		_fail("an approach along the facing should be the front")
		return
	red_land.y = 45
	if game.approach_word(blue, red_land) != "rear":
		_fail("an approach behind the facing should be the rear")
		return
	if game.approach_word(game.sea_token("blue"), red_land) != "not flanked":
		_fail("a sea piece should not be flanked")
		return
	game.sea_token("blue").pinned = true
	if game.held(game.sea_token("blue")):
		_fail("a pin flag should not hold a sea piece")
		return
	var sea = game.sea_token("blue")
	var sea_x: int = sea.x
	var sea_y: int = sea.y
	sea.path = [{"x": sea_x + 1, "y": sea_y, "pace": 1, "word": "sea"}]
	sea.debt = 1
	game.tick()
	if sea.x != sea_x + 1 or sea.y != sea_y:
		_fail("a sea piece was held as if it were pinned")
		return
	game.reset()
	blue = game.token("blue")
	red_land = game.token("red")
	blue.facing = Vector2i(0, -1)
	red_land.facing = Vector2i(0, -1)
	red_land.x = 80
	red_land.y = 44
	blue.pinned = true
	blue.path = [{"x": 78, "y": 44, "pace": 1, "word": "open"}]
	blue.debt = 1
	var stay_x: int = blue.x
	var stay_y: int = blue.y
	game.support_blue = 1
	var shot: String = game.combat_pulse()
	if game.fight_rounds != 1 or game.shot_takes != "piece" or not shot.contains("Flank hurts more") or not shot.contains("takes none") or not shot.contains("unknown") or not _blank_text(shot):
		_fail("the first round should shoot without a damage figure: %s" % shot)
		return
	var quiet: String = game.combat_pulse()
	if quiet != "No shot this round." or game.shot_takes != "" or not _blank_text(quiet):
		_fail("the next round should hold fire: %s" % quiet)
		return
	game.tick()
	if blue.x != stay_x or blue.y != stay_y or not blue.pinned or not game.held(blue):
		_fail("a pinned land piece should stay until the fight ends or a new order")
		return
	var released: String = game.order("blue", 83, 42)
	if released != "" or blue.pinned or blue.path.is_empty():
		_fail("a new move order should release the pin, got: %s" % released)
		return
	game.reset()
	blue = game.token("blue")
	red_land = game.token("red")
	red_land.x = 80
	red_land.y = 44
	game.combat_pulse()
	game.extra_blue = Vector2i(blue.x, blue.y)
	game.extra_blue_on = true
	var shifted: String = game.combat_pulse()
	if not shifted.contains("Retargeted") or not _blank_text(shifted):
		_fail("a closer enemy should retarget without a distance: %s" % shifted)
		return
	blue.pinned = true
	red_land.x = 200
	red_land.y = 20
	var ended: String = game.combat_pulse()
	if ended != "" or blue.pinned or game.fight_on:
		_fail("leaving the fight should release the pin")
		return
	_ok("combat keeps the booklet shape and prints no damage figure")
	game.reset()


func _check_concealed(terrain, game) -> void:
	var saved_era: int = game.era_year
	var saved_side: String = game.player_side
	var view = MapScript.new()
	view.game = game
	var ok := _concealed_cases(terrain, game, view)
	view.free()
	game.player_side = saved_side
	game.era_year = saved_era
	game.reset()
	if ok:
		_ok("concealed start hides the opponent until their capital is found")


func _concealed_cases(terrain, game, view) -> bool:
	game.player_side = "blue"
	for year in [1918, 1942, 1986, 2023]:
		game.era_year = year
		game.reset()
		if not view.piece_drawn(game.token("red")) or not view.piece_drawn(game.sea_token("red")):
			_fail("%s should show the opponent" % year)
			return false
		if not view.piece_drawn(game.token("blue")) or not view.piece_drawn(game.sea_token("blue")):
			_fail("%s should show the ordered side" % year)
			return false
	game.era_year = 9999
	game.reset()
	var red = game.token("red")
	var blue = game.token("blue")
	if view.piece_drawn(red) or view.piece_drawn(game.sea_token("red")):
		_fail("the concealed start should hide the opponent")
		return false
	if not view.piece_drawn(blue) or not view.piece_drawn(game.sea_token("blue")):
		_fail("the concealed start should keep the ordered pieces")
		return false
	var nx := -1
	var ny := -1
	for step in TerrainScript.STEPS:
		var tx := 183 + int(step.x)
		var ty := 25 + int(step.y)
		if ty < 0 or ty >= TerrainScript.CELL_H:
			continue
		if TerrainScript.land_pace(terrain.id_at(tx, ty)) < 0:
			continue
		nx = tx
		ny = ty
		break
	if nx < 0:
		_fail("Moscow has no walkable neighbor")
		return false
	blue.x = nx
	blue.y = ny
	if view.piece_drawn(red):
		_fail("standing beside the enemy capital should not reveal the opponent")
		return false
	var toronto: Variant = null
	for place in game.sites.places:
		if str(place["title"]) == "Toronto":
			toronto = place
			break
	if toronto == null or str(toronto["owner"]) == "red":
		_fail("Toronto should start unowned by Red")
		return false
	var said: String = game.note
	red.x = int(toronto["x"]) + 1
	red.y = int(toronto["y"])
	red.path = [{"x": int(toronto["x"]), "y": int(toronto["y"]), "pace": 1, "word": "open"}]
	red.debt = 1
	game.tick()
	if str(toronto["owner"]) != "red" or game.note != said or view.piece_drawn(red) or view.piece_drawn(game.sea_token("red")):
		_fail("a hidden opponent should stay hidden, including a capture")
		return false
	game.reset()
	red = game.token("red")
	blue = game.token("blue")
	red.x = 10
	red.y = 10
	blue.x = nx
	blue.y = ny
	blue.path = [{"x": 183, "y": 25, "pace": 1, "word": "open"}]
	blue.debt = 1
	game.sites.capital("blue")["owner"] = "neutral"
	if view.piece_drawn(red):
		_fail("the opponent should stay hidden until the capital is entered")
		return false
	game.tick()
	if game.winner() != "" or str(game.sites.capital("red")["owner"]) != "blue" or not view.piece_drawn(red) or not view.piece_drawn(game.sea_token("red")):
		_fail("entering the enemy capital should show the opponent")
		return false
	game.sites.capital("red")["owner"] = "red"
	blue.x = nx
	blue.y = ny
	if not view.piece_drawn(red):
		_fail("leaving the capital should keep the opponent visible")
		return false
	var sample := [{"x": 1}, {"x": 2}, {"x": 3}, {"x": 4}, {"x": 5}]
	if MatchScript.visible_steps(sample, "red", "blue").size() != 3:
		_fail("a found opponent should still draw only three steps")
		return false
	game.player_side = "red"
	game.reset()
	if view.piece_drawn(game.token("blue")) or view.piece_drawn(game.sea_token("blue")) or not view.piece_drawn(game.token("red")):
		_fail("a red order should hide Blue until Washington is found")
		return false
	game.sites.capital("blue")["owner"] = "red"
	if not view.piece_drawn(game.token("blue")) or not view.piece_drawn(game.sea_token("blue")):
		_fail("owning the enemy capital should reveal the opponent")
		return false
	game.player_side = "blue"
	game.reset()
	for place in game.sites.places:
		if str(place["kind"]) == "capital":
			place["owner"] = "red"
	if game.winner() != "red" or not view.piece_drawn(game.token("red")) or not view.piece_drawn(game.sea_token("red")):
		_fail("a finished concealed match should show the opponent")
		return false
	return true


func _blank_text(text: String) -> bool:
	var lower := text.to_lower()
	if lower.contains("production") or lower.contains("billion") or lower.contains("million") or lower.contains("half") or text.contains("$"):
		return false
	for i in text.length():
		var ch := text[i]
		if ch >= "0" and ch <= "9":
			return false
	return true


func _row_names(era_year: int) -> Array:
	var names: Array = []
	for row in RosterScript.rows_for(era_year):
		names.append(str(row["name"]))
	return names


func _same_path(got: Variant, expect: Variant) -> bool:
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


func _land_reach(terrain, x0: int, y0: int) -> Dictionary:
	var w: int = TerrainScript.CELL_W
	var h: int = TerrainScript.CELL_H
	var seen := PackedByteArray()
	seen.resize(w * h)
	var queue: Array = []
	var start := y0 * w + posmod(x0, w)
	queue.append(start)
	seen[start] = 1
	var head := 0
	var count := 0
	while head < queue.size():
		var i: int = queue[head]
		head += 1
		count += 1
		var x := i % w
		var y := int(float(i) / float(w))
		for step in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
			var ny := y + int(step.y)
			if ny < 0 or ny >= h:
				continue
			var nx := posmod(x + int(step.x), w)
			var ni := ny * w + nx
			if seen[ni] != 0:
				continue
			seen[ni] = 1
			var id: int = terrain.id_at(nx, ny)
			if id == 0 or id == 2 or id == 3 or TerrainScript.land_pace(id) < 0:
				continue
			queue.append(ni)
	return {"count": count, "moscow": seen[25 * w + 183] != 0 and _step_allowed(terrain, 183, 25)}


func _step_allowed(terrain, x: int, y: int) -> bool:
	var id: int = terrain.id_at(x, y)
	return not (id == 0 or id == 2 or id == 3 or TerrainScript.land_pace(id) < 0)


func _cost(path: Variant) -> int:
	if not path is Array:
		return -1
	var total := 0
	for step in path:
		total += int(step["pace"])
	return total


func _cost_text(path: Variant) -> String:
	if not path is Array:
		return "no route"
	return str(_cost(path))


func _ok(message: String) -> void:
	print("OK %s" % message)


func _fail(message: String) -> void:
	_failures.append(message)
	print("FAIL %s" % message)
