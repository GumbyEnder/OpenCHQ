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
	elif terrain.id_at(18, 18) != 15:
		_fail("the facility stand-in should paint its center as id 15")
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
			_ok("capitals and cities paint centers and neighbors; a facility paints its center only")
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
		var shot: String = game.combat_pulse()
		if not shot.contains("Damage amount unknown") or game.spoken() != Assumptions.FIGHT_VOICE or game.note != stopped:
			_fail("the fight voice replaced the contact note: %s / %s" % [game.note, game.spoken()])
		else:
			_ok("adjacent contact stops short")
		game.combat_note = ""
		game.player_note = ""
		game.fight_on = false
		game.fight_rounds = 0
		game.fight_shots = 0

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
	elif not _blank_text(StillsScript.NOTE) or not StillsScript.NOTE.contains("assumption") or not StillsScript.NOTE.contains("extracted file order"):
		_fail("the still note should name the file-order assumption")
	elif not _still_list_kept(stills, pack):
		_fail("the still catalog left the extracted file list")
	else:
		var war := stills.files_for("WAR2")
		var played := stills.advance("WAR2")
		var want := "Playing %s. Assumption: extracted file order." % war[(1) % war.size()].get_file()
		if war.is_empty() or played != want:
			_fail("the still step left the extracted file order: %s" % played)
		else:
			_ok("unit and cutscene stills, playback assumed in extracted file order")

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
			if blue_at == null or red_at == null:
				_fail("the march removed a piece before the capitals fell")
				break
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
	_check_pass(game)

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

	oil.set_era(1986)
	var oil_cells: Array = []
	for field in oil.placed:
		oil_cells.append(Vector2i(int(float(field.get("map_x", -1))), int(float(field.get("map_y", -1)))))
	game.set_oil_cells(oil_cells)
	_check_sea(pack, terrain, game)
	_check_eras(terrain, game)
	_check_blank(game)
	_check_concealed(terrain, game)

	_check_polish(terrain, game)

	var tex: Texture2D = pack.texture("pics/WORLD_MAP.png")
	if tex == null or tex.get_width() != 320 or tex.get_height() != 142:
		_fail("map image should be the 320×142 source")
	else:
		_ok("map image 320×142")


func _check_polish(terrain, game) -> void:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	var blue = game.token("blue")
	var red = game.token("red")
	var red_cell := Vector2i(blue.x + 1, blue.y)
	red.x = red_cell.x
	red.y = red_cell.y
	red.pinned = true
	blue.pinned = true
	red.path = [{"x": red.x + 4, "y": red.y, "pace": 1, "word": "open"}]
	red.debt = 1
	blue.path = [{"x": blue.x - 4, "y": blue.y, "pace": 1, "word": "open"}]
	blue.debt = 1
	var removed := false
	for _i in Assumptions.HITS * 4:
		game.tick()
		var foe = game.token("red")
		if foe == null:
			removed = true
			break
		if blue.x == foe.x and blue.y == foe.y:
			_fail("the removal fight shared a cell")
			return
	if not removed or game.spoken() != Assumptions.GONE_VOICE or (blue.x == red_cell.x and blue.y == red_cell.y):
		_fail("the stand-in fight did not remove the defender: %s" % game.spoken())
		return
	_ok("a stand-in fight removes the defender")

	game.reset()
	game.tick()
	var ship = game.sea_token("red")
	if ship == null or ship.path.is_empty():
		_fail("the enemy ship did not take a path")
		return
	var dest: Dictionary = ship.path[ship.path.size() - 1]
	var again: int = ship.path.size()
	game.tick()
	if ship.path.is_empty() or int(ship.path[ship.path.size() - 1]["x"]) != int(dest["x"]) or int(ship.path[ship.path.size() - 1]["y"]) != int(dest["y"]):
		_fail("the enemy ship repath every tick")
		return
	if ship.path.size() > again:
		_fail("the enemy ship grew a new path")
		return
	_ok("the enemy ship takes one idle path")

	game.reset()
	var home: Dictionary = game.sites.capital("red")
	var extra: String = game.place_purchase("red", "Infantry", int(home["x"]) + 2, int(home["y"]))
	if extra != "":
		var nyc := {}
		for place in game.sites.places:
			if str(place.get("title", "")) == "New York":
				nyc = place
		# Red infantry needs a red city. Use the first red city that is not the capital.
		for place in game.sites.places:
			if str(place.get("owner", "")) == "red" and str(place.get("kind", "")) == "city":
				extra = game.place_purchase("red", "Infantry", int(place["x"]), int(place["y"]))
				break
	var spare = null
	for unit in game.tokens:
		if unit.side == "red" and unit.domain != "sea" and unit != game.token("red"):
			spare = unit
			break
	if spare == null:
		_fail("the return march has no free piece: %s" % extra)
		return
	game.token("red").x = 100
	game.token("red").y = 40
	game.token("red").path = [{"x": 101, "y": 40, "pace": 1, "word": "open"}]
	game.token("red").debt = 1
	spare.path = []
	spare.pinned = false
	var hx := int(home["x"])
	var hy := int(home["y"])
	if spare.x == hx and spare.y == hy:
		spare.x = hx + 3
		spare.y = hy
	game.tick()
	if spare.path.is_empty():
		_fail("a free piece did not march back to the empty capital")
		return
	var back_to: Dictionary = spare.path[spare.path.size() - 1]
	if int(back_to["x"]) != hx or int(back_to["y"]) != hy:
		_fail("the free piece did not aim at its capital")
		return
	_ok("a free piece marches back to the empty capital")

	game.reset()
	blue = game.token("blue")
	red = game.token("red")
	red.x = blue.x + 1
	red.y = blue.y
	red.pinned = true
	red.path = [{"x": red.x + 3, "y": red.y, "pace": 1, "word": "open"}]
	red.debt = 1
	game.tick()
	red.x = blue.x + 40
	game.tick()
	if game.contacts.is_empty():
		_fail("a seen piece left no marker")
		return
	for _i in Assumptions.CONTACT_ROUNDS:
		game.tick()
	if not game.contacts.is_empty():
		_fail("the marker stayed past 8 rounds")
		return
	game.reset()
	var dock := _dock_beside(terrain, game, "red")
	if dock.x < 0 or game.place_purchase("red", "Submarine", dock.x, dock.y) != "":
		_fail("the hidden submarine could not be placed")
		return
	var sub = null
	for unit in game.tokens:
		if unit.label == "Submarine":
			sub = unit
			break
	if sub == null or sub.was_shown:
		_fail("the submarine was treated as seen")
		return
	game.tick()
	if not game.contacts.is_empty() or sub.was_shown:
		_fail("a still submarine that was never shown left a marker")
		return
	_ok("contact memory fades after 8 rounds and ignores an unseen submarine")

	game.reset()
	var pool_before: int = game.cash_billions
	var nyc2 := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc2 = place
			break
	if game.place_purchase("blue", "Infantry", int(nyc2["x"]), int(nyc2["y"]), true) != "":
		_fail("the match infantry was refused")
		return
	if game.cash_billions != pool_before - Assumptions.PRICE_INFANTRY:
		_fail("the match purchase did not lower the pool")
		return
	game.cash_billions = 0
	game.cash_blue = 0
	if game.place_purchase("blue", "Infantry", int(nyc2["x"]) + 1, int(nyc2["y"]), true) != "Not enough money.":
		_fail("a short pool accepted a buy")
		return
	_ok("a match purchase spends the stand-in pool")

	game.era_year = 2023
	game.reset()
	var mode := str(game.paint_mode)
	if mode != "full" and mode != "centers":
		_fail("2023 did not repaint")
		return
	var city_ok := false
	for place in game.sites.places:
		if str(place.get("kind", "")) != "city":
			continue
		if terrain.id_at(int(place["x"]), int(place["y"])) == 6:
			city_ok = true
			break
	if not city_ok:
		_fail("a 2023 city center was not painted")
		return
	game.era_year = 1986
	game.reset()
	var counts: Dictionary = terrain.paint_counts()
	if str(game.paint_mode) != "full" or int(counts["capitals"]) != 2 or int(counts["docks"]) != 150 or int(counts["cities"]) != 407:
		_fail("restore left the paint at %s %s" % [game.paint_mode, str(counts)])
		return
	if terrain.id_at(18, 18) != 15:
		_fail("restore cleared the facility center")
		return
	_ok("site paint follows the shuffle (%s) and the restore" % mode)

	game.reset()
	var told: String = game.use_tool("blue", "intel")
	if game.pulse != "intel" or told.contains("radius"):
		_fail("intel did not pulse: %s" % told)
		return
	var aided := {}
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == "red":
			aided = place
			break
	var aid_line: String = game.spend_aid("blue", aided)
	if game.flash_kind != "aid" or not aid_line.contains("neutral"):
		_fail("aid did not flash the city: %s" % aid_line)
		return
	var nuked: String = game.launch_nuke("blue", aided)
	if game.flash_kind != "nuke" or nuked.contains("wasteland") and false:
		_fail("nuke flash missing")
		return
	if str(aided.get("owner", "")) == "blue":
		_fail("the nuke flipped the city")
		return
	var sat: String = game.place_satellite("blue", "recon")
	game.tick()
	if game.satellites.is_empty() or sat.contains("fall on its own") and game.satellites[0]["fall"] != "":
		_fail("the satellite fell: %s" % sat)
		return
	var income_before: int = game.income_blue
	var yes: String = game.offer_cease("blue")
	yes = game.answer_cease("blue", "yes")
	if game.cease_banner != "Cease fire accepted" or game.income_blue != income_before:
		_fail("cease fire banner missing: %s" % yes)
		return
	_ok("tool feedback stays visual")

	game.reset()
	blue = game.token("blue")
	blue.x = 70
	blue.y = 40
	if game.save_match("user://openchq-save.json") != "":
		_fail("save failed")
		return
	game.reset()
	if game.token("blue").x == 70:
		_fail("reset kept the saved cell")
		return
	if game.load_match("user://openchq-save.json") != "" or game.token("blue") == null or game.token("blue").x != 70 or game.token("blue").y != 40:
		_fail("load did not restore the piece")
		return
	_ok("save and load restore the piece")
	var tones = load("res://scripts/tones.gd").new()
	tones.play("order")
	_ok("tones construct without quitting")


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
	var facility_near := {}
	for dy in range(-1, 2):
		for dx in range(-1, 2):
			if dx == 0 and dy == 0:
				continue
			oil_at[Vector2i(dx, dy)] = scratch.id_at(30 + dx, 30 + dy)
			base_at[Vector2i(dx, dy)] = scratch.id_at(50 + dx, 50 + dy)
			facility_near[Vector2i(dx, dy)] = scratch.id_at(60 + dx, 50 + dy)
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
	if scratch.id_at(60, 50) != 15:
		_fail("facility paint should mark the center only")
		return
	for step in facility_near.keys():
		var off: Vector2i = step
		if scratch.id_at(60 + off.x, 50 + off.y) != int(facility_near[off]):
			_fail("a facility painted a neighbor")
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
	_ok("oilfields and facilities paint the center only; bases paint neighbors")


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


func _check_buy(terrain, game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	var before := int(game.tokens.size())
	if game.round != 0:
		_fail("a new match should start at turn 0")
		return false
	if game.place_purchase("blue", "Nuke", 79, 44) != "Not enough money.":
		_fail("a nuke should be refused when starting money is unknown")
		return false
	if game.place_purchase("blue", "Infantry", 0, 15) != "Must be placed in city":
		_fail("infantry off a city should be refused")
		return false
	if game.place_purchase("blue", "Cruiser", 79, 44) != "Must be placed on dock":
		_fail("a cruiser on the capital should be refused")
		return false
	var dock := Vector2i(-1, -1)
	for place in game.sites.places:
		if str(place.get("owner", "")) != "blue":
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
				var x := posmod(cx + dx, TerrainScript.CELL_W)
				var y := cy + dy
				if y < 0 or y >= TerrainScript.CELL_H:
					continue
				if terrain.id_at(x, y) == 1:
					dock = Vector2i(x, y)
					break
			if dock.x >= 0:
				break
		if dock.x >= 0:
			break
	if dock.x < 0:
		_fail("Washington has no dock to buy a ship")
		return false
	if game.place_purchase("blue", "Cruiser", dock.x, dock.y) != "" or game.tokens.size() != before + 1:
		_fail("a cruiser should appear on a dock beside Washington: %s" % game.note)
		return false
	if not str(game.note).contains("Stand-in") or str(game.note).contains("$"):
		_fail("an unpriced ship should not invent a cost")
		return false
	if game.place_purchase("blue", "Infantry", 79, 44) != "Two units cannot stop on the same cell.":
		_fail("the capital should refuse a second piece")
		return false
	var seen := int(game.round)
	game.tick()
	if game.round != seen + 1:
		_fail("a tick should advance the turn counter")
		return false
	game.reset()
	if game.round != 0 or game.tokens.size() != before:
		_fail("reset should clear the purchase and the turn")
		return false
	_ok("purchases follow the city and dock strings, and the turn counter moves")
	var nyc := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc = place
			break
	if nyc.is_empty() or str(nyc.get("owner", "")) != "blue":
		_fail("New York should be a blue city for a match purchase")
		return false
	var armed := int(game.tokens.size())
	var bought: String = game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"]), true)
	if bought != "" or game.tokens.size() != armed + 1:
		_fail("a blank-price unit should appear during the match: %s" % bought)
		return false
	if not str(game.note).contains("Stand-in") or not str(game.note).contains("time was not recovered") or str(game.note).contains("$"):
		_fail("the match purchase invented a price or a time: %s" % game.note)
		return false
	if not game.city_unready(int(nyc["id"])):
		_fail("the producing city should be unready")
		return false
	if game.round != 0:
		_fail("a purchase advanced the turn")
		return false
	var again: String = game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"]), true)
	if again != "This city is unready. The time was not recovered." or game.tokens.size() != armed + 1:
		_fail("an unready city should refuse without a duration: %s" % again)
		return false
	game.reset()
	if game.city_unready(int(nyc["id"])) or game.tokens.size() != before:
		_fail("reset should clear the purchase and the unready city")
		return false
	var peace: String = game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"]))
	if peace != "" or game.city_unready(int(nyc["id"])):
		_fail("before the match a city should stay ready: %s" % game.note)
		return false
	game.reset()
	_ok("a blank price can be bought during the match, and the unready time stays unknown")
	if not _check_entrench(terrain, game):
		return false
	return true


func _check_entrench(terrain, game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	var plain: String = game.entrench("blue")
	if plain != "Only infantry can entrench." or game.token("blue").entrenched:
		_fail("the capital piece should not entrench: %s" % plain)
		return false
	var nyc := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc = place
			break
	if nyc.is_empty():
		_fail("New York is not on the map")
		return false
	var placed: String = game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"]))
	if placed != "":
		_fail("infantry for entrench was refused: %s" % placed)
		return false
	var foot = null
	for unit in game.tokens:
		if unit.side == "blue" and unit.label == "Infantry":
			foot = unit
			break
	if foot == null:
		_fail("the infantry piece is missing")
		return false
	game.focus = foot
	game.selected_side = "blue"
	game.selected_domain = "land"
	var dug: String = game.entrench("blue")
	if dug != "Infantry entrenched. The bonus was not recovered." or not foot.entrenched:
		_fail("infantry did not entrench: %s" % dug)
		return false
	if dug.contains("$") or dug.contains("%"):
		_fail("entrench named a bonus: %s" % dug)
		return false
	var dest := Vector2i(-1, -1)
	for step in TerrainScript.STEPS:
		var nx := posmod(foot.x + int(step.x), TerrainScript.CELL_W)
		var ny: int = foot.y + int(step.y)
		if ny < 0 or ny >= TerrainScript.CELL_H:
			continue
		if TerrainScript.land_pace(terrain.id_at(nx, ny)) < 0:
			continue
		var trial: Variant = terrain.route(foot.x, foot.y, nx, ny, Callable())
		if trial is Array and (trial as Array).size() == 1:
			dest = Vector2i(nx, ny)
			break
	if dest.x < 0:
		_fail("infantry has no step to leave the city")
		return false
	var moved: String = game.order("blue", dest.x, dest.y)
	if moved != "" or foot.entrenched or not str(game.note).contains("Entrench is lost."):
		_fail("a move should drop entrench with no bonus: %s" % game.note)
		return false
	if game.beat != 0:
		_fail("entrench advanced the clock")
		return false
	game.reset()
	if game.token("blue").entrenched:
		_fail("reset left the capital entrenched")
		return false
	_ok("infantry can entrench, and the bonus stays blank")
	return true


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
	if game.opponent_told != "":
		_fail("a closed tool told the opponent")
		return
	for unit in game.tokens:
		if unit.revealed:
			_fail("a closed tool revealed a unit")
			return
	for year in [1986, 2023]:
		game.era_year = year
		for tool in ["nuke", "satellite", "foreign_aid", "intel"]:
			var opened: String = game.use_tool("blue", tool)
			if opened.contains("not in this era") or opened.contains("$"):
				_fail("%s %s should stay unlabeled: %s" % [year, tool, opened])
				return
			if tool == "intel":
				if not opened.contains("reveals every unit") or not opened.contains("The opponent is told.") or opened.contains("radius"):
					_fail("%s intel should reveal every unit with no radius: %s" % [year, opened])
					return
			elif not opened.contains("unknown"):
				_fail("%s %s should stay unlabeled: %s" % [year, tool, opened])
				return
	if game.opponent_told != "red":
		_fail("intel should tell the opponent")
		return
	if game.tokens.is_empty():
		_fail("intel had no units to reveal")
		return
	for unit in game.tokens:
		if not unit.revealed:
			_fail("intel should reveal every unit")
			return
	for place in game.sites.places:
		if str(place["owner"]) != str(owners[int(place["id"])]):
			_fail("a tool changed a site owner")
			return
	if game.beat != 0:
		_fail("a tool advanced the clock")
		return
	_ok("nukes, satellites, foreign aid, and intel stay gated and unlabeled")
	if not _check_subs(terrain, game):
		return
	if not _check_air(terrain, game):
		return
	if not _check_drop(terrain, game):
		return
	if not _check_repair(terrain, game):
		return
	if not _check_aid(game):
		return
	if not _check_nuke(terrain, game):
		return
	if not _check_sats(terrain, game):
		return
	if not _check_cease(terrain, game):
		return
	if not _check_speed(terrain, game):
		return

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
	if not _check_buy(terrain, game):
		return
	blue_land = game.token("blue")
	red_land = game.token("red")
	blue_sea = game.sea_token("blue")
	red_sea = game.sea_token("red")
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
	blue_land.transporting = false
	var formed_msg: String = game.order("blue", 20, 53)
	if formed_msg != "" or not blue_land.transporting or not _same_path(blue_land.path, expect):
		_fail("a land piece on the ocean should form a transport along the sea lanes, got %s (%d cells)" % [formed_msg, blue_land.path.size()])
		return
	var rode := false
	for step in blue_land.path:
		var sx := int(step["x"])
		var sy := int(step["y"])
		for i in game.sea.count():
			var at: Vector2i = game.sea.point(i)
			if at.x == sx and at.y == sy:
				rode = true
				break
		if rode:
			break
	if not rode:
		_fail("the formed transport did not follow a sea-lane waypoint")
		return
	var walked: Variant = terrain.route(0, 10, 20, 53, Callable())
	if walked is Array and _same_path(blue_land.path, walked):
		_fail("the formed transport stayed on the land walker")
		return
	_ok("a land piece forms a transport and follows the sea lanes")

	game.reset()
	blue_land = game.token("blue")
	var red = game.token("red")
	var blocked := func(nx: int, ny: int) -> bool:
		return red.x == nx and red.y == ny
	var land_msg: String = game.order("blue", 83, 42)
	var land_expect: Variant = terrain.route(79, 44, 83, 42, blocked)
	if land_expect == null:
		_fail("New York should stay on terrain.route")
		return
	if land_msg != "" or blue_land.transporting or not _same_path(blue_land.path, land_expect):
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
	if not priced.contains("Stand-in") or not priced.contains("twice") or priced.contains("$"):
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
	if game.income_blue != 0 or game.income_red != 0 or game.cash_blue != Assumptions.CASH_EARLY or game.cash_red != Assumptions.CASH_EARLY:
		_fail("the treasury should wait for the stand-in interval (%s, %s)" % [game.income_blue, game.cash_blue])
		return
	var level_b: int = game.city_income("blue")
	var level_r: int = game.city_income("red")
	var wells_b: int = game.oil_income("blue")
	var wells_r: int = game.oil_income("red")
	if level_b < 1 or level_r < 1:
		_fail("city income should follow the cities you hold (%s, %s)" % [level_b, level_r])
		return
	var paid: String = game.income_line("blue")
	if paid != "City income is %d." % level_b or paid.contains("$") or paid.to_lower().contains("production"):
		_fail("city income should name the cities you hold: %s" % paid)
		return
	for unit in game.tokens:
		unit.path = []
		unit.debt = 0
	game.beat = Assumptions.PAY_EVERY - 1
	game.round = game.beat
	game.tick()
	if game.income_blue != level_b or game.income_red != level_r:
		_fail("the interval should add city income once (%s, %s)" % [game.income_blue, game.income_red])
		return
	if game.oil_income_blue != wells_b or game.oil_income_red != wells_r:
		_fail("the interval should add oil income once (%s, %s)" % [game.oil_income_blue, game.oil_income_red])
		return
	if game.cash_blue != Assumptions.CASH_EARLY + level_b + wells_b or game.cash_red != Assumptions.CASH_EARLY + level_r + wells_r:
		_fail("the interval should add income to resources (%s, %s)" % [game.cash_blue, game.cash_red])
		return
	if game.cash_billions != game.cash_blue:
		_fail("the player pool should follow the deposit")
		return
	for place in game.sites.places:
		if str(place["kind"]) == "city":
			place["owner"] = "neutral"
	for unit in game.tokens:
		unit.path = []
		unit.debt = 0
	var mark_b: int = game.income_blue
	var mark_r: int = game.income_red
	var held_cash_b: int = game.cash_blue
	var held_cash_r: int = game.cash_red
	game.beat = Assumptions.PAY_EVERY * 2 - 1
	game.round = game.beat
	game.tick()
	if game.income_blue != mark_b or game.income_red != mark_r or game.cash_blue != held_cash_b or game.cash_red != held_cash_r:
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
	game.beat = Assumptions.PAY_EVERY - 1
	game.round = game.beat
	game.tick()
	if game.income_blue != 0 or game.oil_income_blue != 0 or game.cash_blue != Assumptions.CASH_EARLY or game.cash_red != Assumptions.CASH_EARLY or blue.x != x or blue.y != y:
		_fail("a shortage should freeze the treasury on the income interval")
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
		if game.income_blue != 0 or game.cash_blue != Assumptions.CASH_EARLY or game.city_income("blue") < 1 or game.income_line("blue") != "City income is %d." % game.city_income("blue"):
			_fail("%s should still pay cities: %s" % [year, game.income_line("blue")])
			return
	for year in [1986, 9999]:
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
	game.era_year = 2023
	game.reset()
	if game.tokens.size() != 0 or game.token("blue") != null or game.sea_token("red") != null:
		_fail("2023 should start with no army")
		return
	if game.cash_billions != Assumptions.CASH_2023:
		_fail("2023 should use the stand-in cash pool")
		return
	var open_note := str(game.note)
	if not open_note.contains("no army") or open_note != "You are Blue. 2023 starts with no army. %s" % Assumptions.cash_note() or open_note.contains("$"):
		_fail("2023 should name the stand-in cash pool: %s" % open_note)
		return
	if not _layout_shuffled(game):
		return
	var again_cities := _city_key(game)
	var again_oil: Array = game.oil_cells.duplicate()
	game.reset()
	if _city_key(game) != again_cities or not _same_oil_order(game.oil_cells, again_oil):
		_fail("2023 shuffle should stay on the same seed")
		return
	game.oil_short = true
	if not game.planes_grounded() or game.income_line("blue") != "City income is stopped.":
		_fail("2023 shortage should ground planes and stop city income")
		return
	if game.order("blue", 83, 42) != held_line:
		_fail("2023 shortage should stop an order")
		return
	game.tick()
	if game.income_blue != 0 or game.tokens.size() != 0:
		_fail("2023 shortage still paid or raised an army")
		return
	game.era_year = 1986
	game.reset()
	if game.cash_billions != Assumptions.CASH_EARLY or not _layout_listed(game):
		_fail("leaving 2023 should restore the listed cities and the early stand-in pool")
		return
	_ok("city and oil income follow what you hold, and 2023 uses a stand-in pool and shuffle")
	if not _check_oil_trigger(game):
		return
	if not _check_oil_capture(game):
		return

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
	for year in [1918, 1942, 1986]:
		game.era_year = year
		game.reset()
		var red_land = game.token("red")
		var blue_land = game.token("blue")
		if view.piece_drawn(red_land) or view.piece_drawn(game.sea_token("red")):
			_fail("%s should hide an opponent beyond the stand-in sight" % year)
			return false
		if not view.piece_drawn(blue_land) or not view.piece_drawn(game.sea_token("blue")):
			_fail("%s should show the ordered side" % year)
			return false
		var far_x: int = red_land.x
		var far_y: int = red_land.y
		red_land.x = blue_land.x + 1
		red_land.y = blue_land.y
		if not view.piece_drawn(red_land):
			_fail("%s should show an opponent beside a friendly piece" % year)
			return false
		red_land.x = far_x
		red_land.y = far_y
		if view.piece_drawn(red_land):
			_fail("%s should hide the opponent again once they are far" % year)
			return false
	game.era_year = 2023
	game.reset()
	if game.token("blue") != null or game.token("red") != null or game.sea_token("blue") != null or game.sea_token("red") != null:
		_fail("2023 should start with no army")
		return false
	game.era_year = 9999
	game.reset()
	var york: Variant = null
	for place in game.sites.places:
		if str(place["title"]) == "New York":
			york = place
		var kind := str(place["kind"])
		if kind == "city" and str(place["owner"]) != "neutral":
			_fail("a concealed city should be a city-state")
			return false
		if kind == "capital" and str(place["owner"]) != str(place["home"]):
			_fail("a concealed capital should keep its home")
			return false
		if kind == "facility" and str(place["owner"]) != str(place["home"]):
			_fail("a concealed facility should stay as listed")
			return false
	if york == null or str(york["owner"]) != "neutral" or str(york["home"]) != "blue":
		_fail("New York should become a city-state")
		return false
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


func _dock_beside(terrain, game, side: String) -> Vector2i:
	for place in game.sites.places:
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
				var x := posmod(cx + dx, TerrainScript.CELL_W)
				var y := cy + dy
				if y < 0 or y >= TerrainScript.CELL_H:
					continue
				if terrain.id_at(x, y) == 1 and not _unit_at(game, x, y):
					return Vector2i(x, y)
	return Vector2i(-1, -1)


func _unit_at(game, x: int, y: int) -> bool:
	for unit in game.tokens:
		if posmod(unit.x, TerrainScript.CELL_W) == x and unit.y == y:
			return true
	return false


## A still submarine is hidden from the other side. A scan leaves it hidden. Intel shows it.
func _check_subs(terrain, game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	var red_dock := _dock_beside(terrain, game, "red")
	var blue_dock := _dock_beside(terrain, game, "blue")
	if red_dock.x < 0 or blue_dock.x < 0:
		_fail("a side has no dock for a submarine")
		return false
	if game.place_purchase("red", "Submarine", red_dock.x, red_dock.y) != "":
		_fail("the red submarine was not placed: %s" % game.note)
		return false
	if game.place_purchase("blue", "Submarine", blue_dock.x, blue_dock.y) != "":
		_fail("the blue submarine was not placed: %s" % game.note)
		return false
	var red_sub = null
	var blue_sub = null
	for unit in game.tokens:
		if unit.label != "Submarine":
			continue
		if unit.side == "red":
			red_sub = unit
		elif unit.side == "blue":
			blue_sub = unit
	if red_sub == null or blue_sub == null:
		_fail("a submarine is missing")
		return false
	if not game.shows_piece(blue_sub) or not game.submarine_hidden(blue_sub):
		_fail("the owner should see a still submarine, and it should stay hidden")
		return false
	if game.shows_piece(red_sub) or not game.submarine_hidden(red_sub):
		_fail("a still enemy submarine should be hidden")
		return false
	var cruiser = game.sea_token("red")
	if game.submarine_hidden(cruiser):
		_fail("a cruiser should not use the submarine hide")
		return false
	if game.shows_piece(cruiser):
		_fail("a distant cruiser should stay unseen")
		return false
	var cruise_x: int = cruiser.x
	var cruise_y: int = cruiser.y
	cruiser.x = game.token("blue").x + 1
	cruiser.y = game.token("blue").y
	if not game.shows_piece(cruiser):
		_fail("a cruiser beside a friendly piece should be visible")
		return false
	cruiser.x = cruise_x
	cruiser.y = cruise_y
	var sub_x: int = red_sub.x
	var sub_y: int = red_sub.y
	red_sub.path = [{"x": red_sub.x, "y": red_sub.y, "pace": 1, "word": "sea"}]
	if game.shows_piece(red_sub) or game.submarine_hidden(red_sub):
		_fail("a moving submarine beyond sight should stay unseen")
		return false
	red_sub.x = game.token("blue").x + 1
	red_sub.y = game.token("blue").y
	if not game.shows_piece(red_sub) or game.submarine_hidden(red_sub):
		_fail("a moving submarine beside a friendly piece should be visible")
		return false
	red_sub.path = []
	red_sub.x = sub_x
	red_sub.y = sub_y
	if game.shows_piece(red_sub):
		_fail("a submarine that stops should hide again")
		return false
	var scanned: String = game.use_tool("blue", "satellite")
	if not scanned.contains("does not reveal a still submarine") or not scanned.contains("unknown") or scanned.contains("$"):
		_fail("the scan note is wrong: %s" % scanned)
		return false
	if red_sub.revealed or blue_sub.revealed or game.shows_piece(red_sub):
		_fail("an air or satellite scan revealed a still submarine")
		return false
	var told: String = game.use_tool("blue", "intel")
	if not told.contains("reveals every unit") or not red_sub.revealed or not blue_sub.revealed:
		_fail("intel left a submarine hidden: %s" % told)
		return false
	if not game.shows_piece(red_sub) or game.submarine_hidden(red_sub):
		_fail("intel should show the still submarine")
		return false
	game.reset()
	_ok("a still submarine stays hidden from a scan until intel")
	return true


func _free_cities(game, side: String) -> Array:
	var out: Array = []
	for place in game.sites.places:
		if str(place.get("owner", "")) != side:
			continue
		if str(place.get("kind", "")) != "city":
			continue
		var x := int(place["x"])
		var y := int(place["y"])
		if _unit_at(game, x, y):
			continue
		out.append(place)
	return out


func _craft_at(game, side: String, cell: Dictionary) -> Variant:
	var placed: String = game.place_purchase(side, "Aircraft", int(cell["x"]), int(cell["y"]))
	if placed != "":
		return placed
	for unit in game.tokens:
		if unit.side == side and unit.label == "Aircraft" and unit.x == int(cell["x"]) and unit.y == int(cell["y"]):
			return unit
	return "the aircraft did not appear"


func _check_air(terrain, game) -> bool:
	game.era_year = 1918
	game.reset()
	var early: String = game.fly_strike("blue", game.token("blue"), "land", game.token("red"))
	if not early.contains("not in this era"):
		_fail("1918 should refuse an air mission: %s" % early)
		return false
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	if not game.bomb_site_kind("city") or not game.bomb_site_kind("base") or game.bomb_site_kind("capital") or game.bomb_site_kind("facility"):
		_fail("bombing should accept a city or a base only")
		return false
	var homes := _free_cities(game, "blue")
	var chicago := {}
	var usable: Array = []
	for place in homes:
		if str(place.get("title", "")) == "Chicago":
			chicago = place
		else:
			usable.append(place)
	if chicago.is_empty() or usable.size() < 5:
		_fail("not enough blue cities for an air mission")
		return false
	var reds := _free_cities(game, "red")
	if reds.is_empty():
		_fail("no red city for an enemy mission")
		return false
	var land = _craft_at(game, "blue", usable[0])
	var sea = _craft_at(game, "blue", usable[1])
	var bomber = _craft_at(game, "blue", usable[2])
	var oiler = _craft_at(game, "blue", usable[3])
	var wing = _craft_at(game, "blue", usable[4])
	if land is String or sea is String or bomber is String or oiler is String or wing is String:
		_fail("an aircraft was refused: %s" % str(land))
		return false
	var stay_x: int = land.x
	var stay_y: int = land.y
	var struck: String = game.fly_strike("blue", land, "land", game.token("red"))
	if not struck.contains("Land strike on Red land piece") or not struck.contains("damage was not recovered") or not struck.contains("range was not recovered") or not struck.contains("8 rounds"):
		_fail("the land strike note is wrong: %s" % struck)
		return false
	if struck.contains("$") or struck.to_lower().contains("half") or land.x != stay_x or land.y != stay_y or land.idle_rounds != 8:
		_fail("the land strike moved a piece or invented damage")
		return false
	if "strength" in land or "strength" in game.token("red"):
		_fail("a strike stored a strength number")
		return false
	var sailed: String = game.fly_strike("blue", sea, "sea", game.sea_token("red"))
	if not sailed.contains("Sea strike on Red sea piece") or not sailed.contains("damage was not recovered") or sea.idle_rounds != 8 or sea.x != int(usable[1]["x"]):
		_fail("the sea strike note is wrong: %s" % sailed)
		return false
	var bomb: String = game.fly_bomb("blue", bomber, "Chicago", "site:%d" % int(chicago["id"]), false)
	if not bomb.contains("Bombed Chicago") or not bomb.contains("5 rounds") or not bomb.contains("amount taken was not recovered") or not bomb.contains("range was not recovered"):
		_fail("the bomb note is wrong: %s" % bomb)
		return false
	if game.build_left("site:%d" % int(chicago["id"])) != 5 or str(chicago.get("owner", "")) != "blue":
		_fail("the empty city should lock building and keep its owner")
		return false
	var blocked: String = game.place_purchase("blue", "Infantry", int(chicago["x"]), int(chicago["y"]))
	if not blocked.contains("Building is locked") or not blocked.contains("amount taken was not recovered"):
		_fail("a locked city accepted a unit: %s" % blocked)
		return false
	var oil: String = game.fly_bomb("blue", oiler, "oil site", "oil:sample", false)
	if not oil.contains("Bombed oil site") or not oil.contains("5 rounds") or game.build_left("oil:sample") != 5:
		_fail("an empty oil site should lock building: %s" % oil)
		return false
	game.oil_short = true
	var grounded: String = game.fly_strike("blue", wing, "land", game.token("red"))
	game.oil_short = false
	if grounded != "Planes are grounded." or wing.idle_rounds != 0:
		_fail("a shortage should ground the mission: %s" % grounded)
		return false
	var quiet: String = game.scramble("blue", wing)
	if not quiet.contains("No enemy mission") or not quiet.contains("range was not recovered"):
		_fail("a scramble with no enemy mission was accepted: %s" % quiet)
		return false
	var foe = _craft_at(game, "red", reds[0])
	if foe is String:
		_fail("the enemy aircraft was refused: %s" % str(foe))
		return false
	var enemy: String = game.fly_strike("red", foe, "land", game.token("blue"))
	if not enemy.contains("Land strike") or not game.enemy_mission("blue"):
		_fail("the enemy mission did not start: %s" % enemy)
		return false
	var answered: String = game.scramble("blue", wing)
	if not answered.contains("Scramble answers the enemy mission") or not answered.contains("4 rounds") or not answered.contains("range was not recovered") or wing.idle_rounds != 4:
		_fail("the scramble note is wrong: %s" % answered)
		return false
	if answered.contains("10") or answered.to_lower().contains("spaces"):
		_fail("the scramble invented a range")
		return false
	var dock := _dock_beside(terrain, game, "blue")
	if dock.x < 0 or game.place_purchase("blue", "Carrier", dock.x, dock.y) != "":
		_fail("a carrier could not be placed for paradrop")
		return false
	var carrier = null
	for unit in game.tokens:
		if unit.label == "Carrier":
			carrier = unit
			break
	if carrier == null or game.paradrop(carrier) != "Carrier aircraft cannot paradrop.":
		_fail("a carrier aircraft should refuse a paradrop")
		return false
	if not game.fly_strike("blue", carrier, "land", game.token("red")).contains("Only an aircraft"):
		_fail("a carrier ship should not fly the mission")
		return false
	var idle_land: int = land.idle_rounds
	var lock_now: int = game.build_left("site:%d" % int(chicago["id"]))
	game.tick()
	if land.idle_rounds != idle_land - 1 or wing.idle_rounds != 3 or game.build_left("site:%d" % int(chicago["id"])) != lock_now - 1:
		_fail("a round should cool the mission and the building lock")
		return false
	var moved: String = game.order("blue", land.x + 1, land.y)
	game.focus = land
	moved = game.order("blue", int(usable[0]["x"]) + 1, int(usable[0]["y"]))
	if not moved.contains("inactive") or land.x != stay_x:
		_fail("an inactive aircraft accepted a move: %s" % moved)
		return false
	game.reset()
	if game.build_left("site:%d" % int(chicago["id"])) != 0 or game.token("blue").idle_rounds != 0:
		_fail("reset left a mission running")
		return false
	_ok("an air mission, a scramble, and an empty-site bombing stay blank")
	return true


## Infantry paradrops. Tanks cannot. A tank ordered onto infantry overruns and stops short.
func _check_drop(terrain, game) -> bool:
	game.era_year = 1918
	game.player_side = "blue"
	game.reset()
	var nyc := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc = place
			break
	if nyc.is_empty():
		_fail("New York is missing for a paradrop")
		return false
	if game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"])) != "":
		_fail("1918 could not place infantry")
		return false
	var early = null
	for unit in game.tokens:
		if unit.label == "Infantry":
			early = unit
			break
	if early == null or not str(game.paradrop(early, int(nyc["x"]) + 1, int(nyc["y"]))).contains("not in this era") or early.x != int(nyc["x"]):
		_fail("1918 accepted a paradrop")
		return false
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	if game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"])) != "":
		_fail("the paradrop could not place infantry")
		return false
	var foot = null
	for unit in game.tokens:
		if unit.side == "blue" and unit.label == "Infantry":
			foot = unit
			break
	if foot == null:
		_fail("the infantry is missing")
		return false
	var spot := _open_near(terrain, game, foot.x, foot.y)
	if spot.x < 0:
		_fail("no open cell for a paradrop")
		return false
	game.oil_short = true
	var grounded: String = game.paradrop(foot, spot.x, spot.y)
	game.oil_short = false
	if grounded != "Planes are grounded." or foot.x != int(nyc["x"]) or foot.y != int(nyc["y"]):
		_fail("a shortage should ground the paradrop: %s" % grounded)
		return false
	game.focus = foot
	if game.entrench("blue") == "" or not foot.entrenched:
		_fail("infantry should entrench before the drop")
		return false
	var dropped: String = game.paradrop(foot, spot.x, spot.y)
	if dropped != "Infantry paradropped. The strength cost was not recovered." or foot.x != spot.x or foot.y != spot.y:
		_fail("the paradrop note is wrong: %s" % dropped)
		return false
	if foot.entrenched or foot.idle_rounds != 0 or ("strength" in foot) or dropped.contains("25") or dropped.contains("%") or dropped.contains("$") or dropped.to_lower().contains("half"):
		_fail("the paradrop changed a strength number")
		return false
	var boston := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "Boston":
			boston = place
			break
	if boston.is_empty() or game.place_purchase("blue", "Tanks", int(boston["x"]), int(boston["y"])) != "":
		_fail("the overrun could not place tanks")
		return false
	var armor = null
	for unit in game.tokens:
		if unit.label == "Tanks":
			armor = unit
			break
	if armor == null or game.paradrop(armor, spot.x, spot.y) != "Tanks cannot paradrop." or armor.x != int(boston["x"]) or armor.y != int(boston["y"]):
		_fail("tanks should refuse a paradrop")
		return false
	var reds: Array = _free_cities(game, "red")
	if reds.is_empty() or game.place_purchase("red", "Infantry", int(reds[0]["x"]), int(reds[0]["y"])) != "":
		_fail("the overrun could not place red infantry")
		return false
	var foe = null
	for unit in game.tokens:
		if unit.side == "red" and unit.label == "Infantry":
			foe = unit
			break
	if foe == null:
		_fail("red infantry is missing")
		return false
	var foe_x: int = foe.x
	var foe_y: int = foe.y
	game.focus = foot
	var plain: String = game.order("blue", foe.x, foe.y)
	if plain.contains("Overrun"):
		_fail("infantry ordered onto infantry was called an overrun: %s" % plain)
		return false
	game.focus = armor
	var rushed: String = game.order("blue", foe.x, foe.y)
	if not rushed.contains("Overrun") or not rushed.contains("stopped short") or not rushed.contains("damage amounts unknown"):
		_fail("a tank ordered onto infantry should overrun: %s" % rushed)
		return false
	if (armor.x == foe.x and armor.y == foe.y) or not game.tokens.has(foe) or foe.x != foe_x or foe.y != foe_y:
		_fail("the overrun removed the infantry")
		return false
	for step in armor.path:
		if int(step["x"]) == foe.x and int(step["y"]) == foe.y:
			_fail("the overrun path stops on the infantry")
			return false
	if ("strength" in armor) or ("strength" in foe) or rushed.contains("25") or rushed.contains("%") or rushed.contains("$") or rushed.to_lower().contains("half"):
		_fail("the overrun invented a damage figure")
		return false
	var beside := _cardinal_near(terrain, game, armor.x, armor.y)
	if beside.x < 0:
		_fail("no cell beside the tanks")
		return false
	for unit in game.tokens:
		unit.path = []
		unit.debt = 0
	foe.x = beside.x
	foe.y = beside.y
	var close: String = game.order("blue", foe.x, foe.y)
	if not close.contains("Overrun") or not close.contains("stopped short") or not armor.path.is_empty():
		_fail("an adjacent overrun should stop short: %s" % close)
		return false
	if (armor.x == foe.x and armor.y == foe.y) or not game.tokens.has(foe) or foe.label != "Infantry":
		_fail("the adjacent overrun removed the infantry")
		return false
	game.tick()
	if (armor.x == foe.x and armor.y == foe.y) or not game.tokens.has(foe):
		_fail("a tick let the overrun land on the infantry")
		return false
	game.reset()
	if game.token("blue").x != 79 or game.token("blue").y != 44:
		_fail("the paradrop left the opening")
		return false
	_ok("infantry can paradrop, tanks cannot, and an overrun stops short")
	return true


func _cardinal_near(terrain, game, x: int, y: int) -> Vector2i:
	for step in TerrainScript.STEPS:
		var nx := posmod(x + int(step.x), TerrainScript.CELL_W)
		var ny := y + int(step.y)
		if ny < 0 or ny >= TerrainScript.CELL_H:
			continue
		var word := TerrainScript.pace_word(terrain.id_at(nx, ny))
		if word != "open" and word != "slow":
			continue
		if game.sites.at_cell(nx, ny) != null:
			continue
		if _unit_at(game, nx, ny):
			continue
		return Vector2i(nx, ny)
	return Vector2i(-1, -1)


func _open_near(terrain, game, x: int, y: int) -> Vector2i:
	for radius in range(1, 6):
		for dy in range(-radius, radius + 1):
			for dx in range(-radius, radius + 1):
				if absi(dx) != radius and absi(dy) != radius:
					continue
				var nx := posmod(x + dx, TerrainScript.CELL_W)
				var ny := y + dy
				if ny < 0 or ny >= TerrainScript.CELL_H:
					continue
				var word := TerrainScript.pace_word(terrain.id_at(nx, ny))
				if word != "open" and word != "slow":
					continue
				if game.sites.at_cell(nx, ny) != null:
					continue
				if _unit_at(game, nx, ny):
					continue
				return Vector2i(nx, ny)
	return Vector2i(-1, -1)


## Repair is a mark. Strength stays unnumbered, and the bar text stays empty.
func _check_repair(terrain, game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	if game.repairing(game.token("blue")):
		_fail("the capital piece should not be repairing")
		return false
	if game.repairing(game.sea_token("blue")):
		_fail("the ship at sea should not be repairing")
		return false
	var nyc := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc = place
			break
	if nyc.is_empty() or game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"])) != "":
		_fail("repair could not place infantry")
		return false
	var foot = null
	for unit in game.tokens:
		if unit.side == "blue" and unit.label == "Infantry":
			foot = unit
			break
	var noted: String = str(game.note)
	if foot == null or not game.repairing(foot) or not noted.contains("Repairing. Strength has no number."):
		_fail("a city piece should be marked repairing: %s" % noted)
		return false
	var priced := noted.replace("Stand-in price: %d billion." % Assumptions.PRICE_INFANTRY, "")
	if ("strength" in foot) or noted.contains("$") or noted.contains("%") or noted.to_lower().contains("half") or _has_digit(priced):
		_fail("repair stored a strength number")
		return false
	var boston := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "Boston":
			boston = place
			break
	if boston.is_empty():
		_fail("Boston is missing for a base repair")
		return false
	var saved_kind := str(boston.get("kind", ""))
	boston["kind"] = "base"
	foot.x = int(boston["x"])
	foot.y = int(boston["y"])
	var on_base: bool = game.repairing(foot)
	boston["kind"] = saved_kind
	if not on_base:
		_fail("a base should mark the land piece repairing")
		return false
	var reds: Array = _free_cities(game, "red")
	if reds.is_empty():
		_fail("no red city for a repair refusal")
		return false
	foot.x = int(reds[0]["x"])
	foot.y = int(reds[0]["y"])
	if game.repairing(foot):
		_fail("an enemy city should not repair")
		return false
	var field := Vector2i(-1, -1)
	for cell in game.oil_cells:
		var at: Vector2i = cell
		if game.sites.at_cell(at.x, at.y) != null:
			continue
		field = at
		break
	if field.x < 0:
		_fail("no open oilfield cell")
		return false
	foot.x = field.x
	foot.y = field.y
	if not game.repairing(foot):
		_fail("an oilfield should mark the land piece repairing")
		return false
	var plain := _plain_cell(terrain, game)
	if plain.x < 0:
		_fail("no plain cell off an oilfield")
		return false
	var was: int = terrain.id_at(plain.x, plain.y)
	terrain.set_id(plain.x, plain.y, 7)
	foot.x = plain.x
	foot.y = plain.y
	var on_ground: bool = game.repairing(foot)
	terrain.set_id(plain.x, plain.y, was)
	foot.x = plain.x
	foot.y = plain.y
	if not on_ground or game.repairing(foot):
		_fail("oilfield ground should repair, and plain ground should not")
		return false
	var dock := _city_dock(terrain, game, "blue")
	if dock.x < 0 or game.place_purchase("blue", "Cruiser", dock.x, dock.y) != "":
		_fail("repair could not place a ship on a city dock")
		return false
	var ship = null
	for unit in game.tokens:
		if unit.side == "blue" and unit.label == "Cruiser":
			ship = unit
			break
	if ship == null or not game.repairing(ship) or not str(game.note).contains("Repairing. Strength has no number."):
		_fail("a ship on the city dock should be repairing")
		return false
	if "strength" in ship:
		_fail("the ship stored a strength number")
		return false
	ship.x = plain.x
	ship.y = plain.y
	if game.repairing(ship):
		_fail("a ship off the dock should not be repairing")
		return false
	game.reset()
	if game.repairing(game.token("blue")) or game.token("blue").x != 79:
		_fail("repair left the opening")
		return false
	_ok("a piece on a friendly city, base, or oilfield is repairing, with no strength number")
	return true


func _plain_cell(terrain, game) -> Vector2i:
	for y in range(40, 50):
		for x in range(70, 80):
			if terrain.id_at(x, y) != 8:
				continue
			if game.sites.at_cell(x, y) != null:
				continue
			if game._oil_cell(x, y):
				continue
			if _unit_at(game, x, y):
				continue
			return Vector2i(x, y)
	return Vector2i(-1, -1)


func _city_dock(terrain, game, side: String) -> Vector2i:
	for place in game.sites.places:
		if str(place.get("owner", "")) != side or str(place.get("kind", "")) != "city":
			continue
		var cx := int(place["x"])
		var cy := int(place["y"])
		for dy in range(-1, 2):
			for dx in range(-1, 2):
				if dx == 0 and dy == 0:
					continue
				var x := posmod(cx + dx, TerrainScript.CELL_W)
				var y := cy + dy
				if y < 0 or y >= TerrainScript.CELL_H:
					continue
				if terrain.id_at(x, y) == 1 and not _unit_at(game, x, y):
					return Vector2i(x, y)
	return Vector2i(-1, -1)


func _has_digit(text: String) -> bool:
	for i in text.length():
		var ch := text[i]
		if ch >= "0" and ch <= "9":
			return true
	return false


## Foreign aid shifts a city neutral, then to the buyer. Nothing is charged.
func _check_aid(game) -> bool:
	var nyc := {}
	var red_city := {}
	var wash := {}
	for place in game.sites.places:
		var title := str(place.get("title", ""))
		if title == "New York":
			nyc = place
		elif title == "Washington":
			wash = place
		elif red_city.is_empty() and str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == "red":
			red_city = place
	if nyc.is_empty() or wash.is_empty() or red_city.is_empty():
		_fail("aid is missing a city")
		return false
	for year in [1918, 1942]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var kept := str(nyc.get("owner", ""))
		var refused: String = game.spend_aid("blue", nyc)
		if not refused.contains("not in this era") or str(nyc.get("owner", "")) != kept:
			_fail("%s accepted foreign aid: %s" % [year, refused])
			return false
	game.era_year = 9999
	game.player_side = "blue"
	game.reset()
	var hidden := {}
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city":
			hidden = place
			break
	if hidden.is_empty() or str(hidden.get("owner", "")) != "neutral":
		_fail("the concealed cities should be neutral before aid")
		return false
	var concealed: String = game.spend_aid("blue", hidden)
	if not concealed.contains("not in this era") or str(hidden.get("owner", "")) != "neutral":
		_fail("the concealed era accepted foreign aid: %s" % concealed)
		return false
	for year in [1986, 2023]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var paid_blue: int = game.income_blue
		var paid_red: int = game.income_red
		var others := {}
		for place in game.sites.places:
			others[int(place["id"])] = str(place["owner"])
		if str(wash.get("owner", "")) != "blue":
			_fail("aid lost the blue capital")
			return false
		var capital: String = game.spend_aid("blue", wash)
		if not capital.contains("Click a city") or str(wash.get("owner", "")) != "blue":
			_fail("aid should leave the capital: %s" % capital)
			return false
		var mine: String = game.spend_aid("blue", nyc)
		if not mine.contains("already yours") or str(nyc.get("owner", "")) != "blue":
			_fail("aid changed a friendly city: %s" % mine)
			return false
		var title := str(red_city.get("title", ""))
		var first: String = game.spend_aid("blue", red_city)
		if str(red_city.get("owner", "")) != "neutral" or not first.contains("shifted neutral") or not first.contains("cost was not recovered") or not first.contains(title):
			_fail("%s aid did not shift neutral: %s" % [year, first])
			return false
		var second: String = game.spend_aid("blue", red_city)
		if str(red_city.get("owner", "")) != "blue" or not second.contains("shifted to Blue") or not second.contains("cost was not recovered"):
			_fail("%s aid did not reach the buyer: %s" % [year, second])
			return false
		if first.contains("$") or second.contains("$") or _has_digit(first) or _has_digit(second) or first.to_lower().contains("half"):
			_fail("aid invented a cost")
			return false
		if game.income_blue != paid_blue or game.income_red != paid_red or game.beat != 0:
			_fail("aid charged money or moved the clock")
			return false
		for place in game.sites.places:
			if int(place["id"]) == int(red_city["id"]):
				continue
			if str(place["owner"]) != str(others[int(place["id"])]):
				_fail("aid changed another site")
				return false
	game.era_year = 1986
	game.reset()
	if str(red_city.get("owner", "")) != "red" or game.income_blue != 0:
		_fail("aid left a city bought or a charge in place")
		return false
	_ok("foreign aid shifts a city neutral, then to the buyer, and nothing is charged")
	return true


func _nuke_text_ok(text: String) -> bool:
	var lower := text.to_lower()
	if not _blank_text(text):
		return false
	if lower.contains("beats") or lower.contains("one extra") or lower.contains("command hq") or lower.contains("about") or text.contains("spaces"):
		return false
	return true


func _nuke_shot_ok(text: String, title: String, first: bool) -> bool:
	var lead := "Launch at %s from submarines that are not pieces on the map." % title
	if not text.contains(lead):
		return false
	if not text.contains("Damage, blast radius, city flips, wasteland paint, and nuclear winter stay off, because those need a radius or a damage figure."):
		return false
	var penalty := text.contains("The first user is penalized. The penalty amount stays blank.")
	if penalty != first:
		return false
	return _nuke_text_ok(text)


func _owner_snap(game) -> Dictionary:
	var owners := {}
	for place in game.sites.places:
		owners[int(place["id"])] = str(place["owner"])
	return owners


func _same_owners(game, owners: Dictionary) -> bool:
	for place in game.sites.places:
		if str(place["owner"]) != str(owners[int(place["id"])]):
			return false
	return true


func _count_subs(game) -> int:
	var n := 0
	for unit in game.tokens:
		if str(unit.label) == "Submarine":
			n += 1
	return n


func _count_wasteland(terrain) -> int:
	var n := 0
	for y in TerrainScript.CELL_H:
		for x in TerrainScript.CELL_W:
			if terrain.id_at(x, y) == 14:
				n += 1
	return n


## A launch is a one-shot. Damage, radius, flips, wasteland, and winter stay off.
func _check_nuke(terrain, game) -> bool:
	var wasteland_before := _count_wasteland(terrain)
	var nyc := {}
	var wash := {}
	var moscow := {}
	var red_city := {}
	var neutral_city := {}
	var facility := {}
	for place in game.sites.places:
		var title := str(place.get("title", ""))
		var kind := str(place.get("kind", ""))
		if title == "New York":
			nyc = place
		elif title == "Washington":
			wash = place
		elif title == "Moscow":
			moscow = place
		elif red_city.is_empty() and kind == "city" and str(place.get("owner", "")) == "red":
			red_city = place
		elif neutral_city.is_empty() and kind == "city" and str(place.get("owner", "")) == "neutral":
			neutral_city = place
		elif facility.is_empty() and kind == "facility":
			facility = place
	if nyc.is_empty() or wash.is_empty() or moscow.is_empty() or red_city.is_empty() or neutral_city.is_empty() or facility.is_empty():
		_fail("nuke is missing a city")
		return false
	for year in [1918, 1942]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var owners := _owner_snap(game)
		var pieces: int = game.tokens.size()
		var refused: String = game.launch_nuke("blue", red_city)
		if not refused.contains("not in this era") or refused.contains("Launch") or not _same_owners(game, owners):
			_fail("%s accepted a nuke: %s" % [year, refused])
			return false
		if int(game.nuke_fired["blue"]) != 0 or int(game.nuke_absorbed["red"]) != 0 or game.tokens.size() != pieces:
			_fail("%s nuke changed the board" % year)
			return false
	game.era_year = 9999
	game.player_side = "blue"
	game.reset()
	var hidden := {}
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city":
			hidden = place
			break
	if hidden.is_empty() or str(hidden.get("owner", "")) != "neutral":
		_fail("the concealed cities should be neutral before a nuke")
		return false
	var concealed: String = game.launch_nuke("blue", hidden)
	if not concealed.contains("not in this era") or str(hidden.get("owner", "")) != "neutral" or int(game.nuke_fired["blue"]) != 0:
		_fail("the concealed era accepted a nuke: %s" % concealed)
		return false
	for year in [1986, 2023]:
		if not _check_nuke_year(terrain, game, year, nyc, wash, moscow, red_city, neutral_city, facility):
			return false
	if _count_wasteland(terrain) != wasteland_before:
		_fail("a nuke painted wasteland")
		return false
	game.era_year = 1986
	game.reset()
	if str(red_city.get("owner", "")) != "red" or str(nyc.get("owner", "")) != "blue" or game.income_blue != 0 or game.beat != 0:
		_fail("nuke left a city flipped or a charge in place")
		return false
	if int(game.nuke_fired["blue"]) != 0 or game.nuke_first != "" or game.nuke_penalty != "":
		_fail("nuke left a launch count in place")
		return false
	_ok("a nuke refuses the home country, counts one launch, and names no damage")
	return true


func _check_nuke_year(terrain, game, year: int, nyc: Dictionary, wash: Dictionary, moscow: Dictionary, red_city: Dictionary, neutral_city: Dictionary, facility: Dictionary) -> bool:
	game.era_year = year
	game.player_side = "blue"
	game.reset()
	var pieces: int = game.tokens.size()
	if year == 2023 and pieces != 0:
		_fail("2023 nuke started with an army")
		return false
	if year == 1986 and pieces == 0:
		_fail("1986 nuke lost the army")
		return false
	var bare: String = game.use_tool("blue", "nuke")
	if bare != "Blue — nuke is available. Damage amounts are unknown." or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke tool changed: %s" % [year, bare])
		return false
	var owners := _owner_snap(game)
	var ground: int = terrain.id_at(int(red_city["x"]), int(red_city["y"]))
	var subs := _count_subs(game)
	var capital: String = game.launch_nuke("blue", wash)
	if capital != "Capitals are excluded." or str(wash["owner"]) != "blue" or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke should leave the capital: %s" % [year, capital])
		return false
	var enemy_cap: String = game.launch_nuke("blue", moscow)
	if enemy_cap != "Capitals are excluded." or str(moscow["owner"]) != "red" or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke should leave the enemy capital: %s" % [year, enemy_cap])
		return false
	var home: String = game.launch_nuke("blue", nyc)
	if home != "Crews will not target the home country." or str(nyc["owner"]) != "blue" or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke targeted home: %s" % [year, home])
		return false
	var plant: String = game.launch_nuke("blue", facility)
	if plant != "Click a city. Capitals are excluded. Crews will not target the home country." or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke accepted a facility: %s" % [year, plant])
		return false
	var empty: String = game.launch_nuke("blue", {})
	if empty != "Click a city. Capitals are excluded. Crews will not target the home country." or int(game.nuke_fired["blue"]) != 0:
		_fail("%s nuke accepted an empty cell: %s" % [year, empty])
		return false
	if not _nuke_text_ok(home) or not _nuke_text_ok(capital) or not _same_owners(game, owners) or game.tokens.size() != pieces or _count_subs(game) != subs:
		_fail("%s nuke refusal changed the board" % year)
		return false
	var title := str(red_city.get("title", ""))
	var first: String = game.launch_nuke("blue", red_city)
	if not _nuke_shot_ok(first, title, true) or game.note != first:
		_fail("%s first launch note: %s" % [year, first])
		return false
	if int(game.nuke_fired["blue"]) != 1 or int(game.nuke_absorbed["red"]) != 1 or int(game.nuke_fired["red"]) != 0 or int(game.nuke_absorbed["blue"]) != 0:
		_fail("%s first launch counted wrong" % year)
		return false
	if game.nuke_first != "blue" or game.nuke_penalty != "":
		_fail("%s penalty was not blank" % year)
		return false
	if str(red_city["owner"]) != "red" or terrain.id_at(int(red_city["x"]), int(red_city["y"])) != ground:
		_fail("%s first launch flipped or painted the city" % year)
		return false
	var reply: String = game.launch_nuke("red", nyc)
	if not _nuke_shot_ok(reply, str(nyc.get("title", "")), false):
		_fail("%s reply note: %s" % [year, reply])
		return false
	if int(game.nuke_fired["red"]) != 1 or int(game.nuke_absorbed["blue"]) != 0 or int(game.nuke_fired["blue"]) != 1 or int(game.nuke_absorbed["red"]) != 1:
		_fail("%s reply changed the absorbed count" % year)
		return false
	if str(nyc["owner"]) != "blue" or game.nuke_first != "blue" or game.nuke_penalty != "":
		_fail("%s reply flipped home or the first user" % year)
		return false
	var again: String = game.launch_nuke("blue", red_city)
	if not _nuke_shot_ok(again, title, false):
		_fail("%s second launch note: %s" % [year, again])
		return false
	if int(game.nuke_fired["blue"]) != 2 or int(game.nuke_absorbed["red"]) != 1 or game.nukes_stopped():
		_fail("%s a reply should freeze further absorption" % year)
		return false
	if not _same_owners(game, owners) or game.income_blue != 0 or game.income_red != 0 or game.beat != 0 or game.oil_short:
		_fail("%s launch charged or flipped" % year)
		return false
	if game.tokens.size() != pieces or _count_subs(game) != subs:
		_fail("%s launch added a submarine" % year)
		return false
	for unit in game.tokens:
		if "strength" in unit:
			_fail("%s launch stored a strength" % year)
			return false
	game.reset()
	owners = _owner_snap(game)
	pieces = game.tokens.size()
	subs = _count_subs(game)
	var neutral_title := str(neutral_city.get("title", ""))
	var neutral_ground: int = terrain.id_at(int(neutral_city["x"]), int(neutral_city["y"]))
	for n in 3:
		var shot: String = game.launch_nuke("blue", neutral_city)
		if not _nuke_shot_ok(shot, neutral_title, n == 0) or int(game.nuke_fired["blue"]) != n + 1:
			_fail("%s neutral launch: %s" % [year, shot])
			return false
	if int(game.nuke_absorbed["red"]) != 0 or int(game.nuke_absorbed["blue"]) != 0 or not game.nukes_stopped():
		_fail("%s neutral launches absorbed a side" % year)
		return false
	var fourth: String = game.launch_nuke("blue", neutral_city)
	if fourth != "Further launches are stopped." or int(game.nuke_fired["blue"]) != 3 or not _nuke_text_ok(fourth):
		_fail("%s fourth neutral launch: %s" % [year, fourth])
		return false
	if str(neutral_city["owner"]) != "neutral" or terrain.id_at(int(neutral_city["x"]), int(neutral_city["y"])) != neutral_ground or not _same_owners(game, owners):
		_fail("%s neutral launch flipped a city" % year)
		return false
	if game.tokens.size() != pieces or _count_subs(game) != subs or game.income_blue != 0 or game.beat != 0:
		_fail("%s neutral launch changed the army or the clock" % year)
		return false
	game.reset()
	game.nuke_absorbed["red"] = 3
	var absorbed: String = game.launch_nuke("blue", red_city)
	if absorbed != "Further launches are stopped." or int(game.nuke_fired["blue"]) != 0 or int(game.nuke_absorbed["red"]) != 3 or str(red_city["owner"]) != "red":
		_fail("%s absorbed launches should stop: %s" % [year, absorbed])
		return false
	game.reset()
	owners = _owner_snap(game)
	pieces = game.tokens.size()
	subs = _count_subs(game)
	ground = terrain.id_at(int(red_city["x"]), int(red_city["y"]))
	for n in 3:
		var shot_red: String = game.launch_nuke("blue", red_city)
		if not _nuke_shot_ok(shot_red, title, n == 0):
			_fail("%s counted launch: %s" % [year, shot_red])
			return false
		if int(game.nuke_fired["blue"]) != n + 1 or int(game.nuke_absorbed["red"]) != n + 1:
			_fail("%s counted launch totals" % year)
			return false
	var stopped: String = game.launch_nuke("blue", red_city)
	if stopped != "Further launches are stopped." or int(game.nuke_fired["blue"]) != 3 or int(game.nuke_absorbed["red"]) != 3:
		_fail("%s third launch did not stop the next: %s" % [year, stopped])
		return false
	var other: String = game.launch_nuke("red", nyc)
	if other != "Further launches are stopped." or int(game.nuke_fired["red"]) != 0 or str(nyc["owner"]) != "blue":
		_fail("%s stop should block the other side: %s" % [year, other])
		return false
	var still: String = game.use_tool("blue", "nuke")
	if still != "Blue — nuke is available. Damage amounts are unknown." or int(game.nuke_fired["blue"]) != 3:
		_fail("%s nuke tool picked up the launch: %s" % [year, still])
		return false
	if not _same_owners(game, owners) or terrain.id_at(int(red_city["x"]), int(red_city["y"])) != ground or ground == 14:
		_fail("%s launch painted wasteland or flipped a city" % year)
		return false
	if game.tokens.size() != pieces or _count_subs(game) != subs or game.income_blue != 0 or game.income_red != 0 or game.beat != 0 or game.oil_short:
		_fail("%s launch changed money, time, or the army" % year)
		return false
	if game.nuke_first != "blue" or game.nuke_penalty != "":
		_fail("%s left a penalty amount" % year)
		return false
	for unit in game.tokens:
		if "strength" in unit:
			_fail("%s launch stored a strength" % year)
			return false
	return true


func _sat_text_ok(text: String) -> bool:
	var lower := text.to_lower()
	if not _blank_text(text):
		return false
	if lower.contains("beats") or lower.contains("one extra") or lower.contains("command hq") or lower.contains("about") or text.contains("spaces"):
		return false
	return true


func _sat_kind(game, kind: String) -> int:
	var n := 0
	for sat in game.satellites:
		if str(sat.get("kind", "")) == kind and str(sat.get("fall", "x")) == "":
			n += 1
	return n


## Recon and killer satellites can be placed. Radius, range, and fall time stay blank.
func _check_sats(terrain, game) -> bool:
	for year in [1918, 1942]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var owners := _owner_snap(game)
		var refused: String = game.place_satellite("blue", "recon")
		if not refused.contains("not in this era") or not game.satellites.is_empty() or not _same_owners(game, owners):
			_fail("%s accepted a satellite: %s" % [year, refused])
			return false
	game.era_year = 9999
	game.player_side = "blue"
	game.reset()
	var hidden := {}
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city":
			hidden = place
			break
	if hidden.is_empty() or str(hidden.get("owner", "")) != "neutral":
		_fail("the concealed cities should be neutral before a satellite")
		return false
	var concealed: String = game.place_satellite("blue", "killer")
	if not concealed.contains("not in this era") or str(hidden.get("owner", "")) != "neutral" or not game.satellites.is_empty():
		_fail("the concealed era accepted a satellite: %s" % concealed)
		return false
	for year in [1986, 2023]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var dock := _dock_beside(terrain, game, "red")
		if dock.x < 0:
			_fail("%s has no dock for a satellite check" % year)
			return false
		if game.place_purchase("red", "Submarine", dock.x, dock.y) != "":
			_fail("%s could not place a submarine" % year)
			return false
		var red_sub = null
		for unit in game.tokens:
			if unit.side == "red" and unit.label == "Submarine":
				red_sub = unit
				break
		if red_sub == null or red_sub.revealed:
			_fail("%s submarine was not still" % year)
			return false
		var pieces: int = game.tokens.size()
		var owners := _owner_snap(game)
		var recon: String = game.place_satellite("blue", "recon")
		if not _sat_text_ok(recon) or game.note != recon or _sat_kind(game, "recon") != 1 or _sat_kind(game, "killer") != 0:
			_fail("%s recon note: %s" % [year, recon])
			return false
		if not recon.contains("does not reveal by distance") or not recon.contains("The radius was not recovered.") or not recon.contains("does not reveal a still submarine") or not recon.contains("Fall time stays blank") or not recon.contains("does not fall on its own."):
			_fail("%s recon refusal is missing: %s" % [year, recon])
			return false
		if red_sub.revealed or game.shows_piece(red_sub) or game.tokens.size() != pieces or not _same_owners(game, owners):
			_fail("%s recon revealed a submarine or flipped a city" % year)
			return false
		var killer: String = game.place_satellite("blue", "killer")
		if not _sat_text_ok(killer) or game.note != killer or _sat_kind(game, "recon") != 1 or _sat_kind(game, "killer") != 1:
			_fail("%s killer note: %s" % [year, killer])
			return false
		if not killer.contains("does not pick targets by distance") or not killer.contains("The range was not recovered.") or not killer.contains("Fall time stays blank") or not killer.contains("does not fall on its own."):
			_fail("%s killer refusal is missing: %s" % [year, killer])
			return false
		if red_sub.revealed or game.tokens.size() != pieces or game.income_blue != 0 or game.income_red != 0 or game.beat != 0:
			_fail("%s killer picked a target or charged a cost" % year)
			return false
		var scan: String = game.use_tool("blue", "satellite")
		if scan != "Blue — an air or satellite scan does not reveal a still submarine. The scan radius is unknown." or red_sub.revealed:
			_fail("%s scan changed: %s" % [year, scan])
			return false
		if _sat_kind(game, "recon") != 1 or _sat_kind(game, "killer") != 1:
			_fail("%s scan removed a satellite" % year)
			return false
		for _i in 4:
			game.tick()
		if _sat_kind(game, "recon") != 1 or _sat_kind(game, "killer") != 1 or game.satellites.size() != 2:
			_fail("%s a satellite fell on its own" % year)
			return false
		for sat in game.satellites:
			if str(sat.get("fall", "x")) != "":
				_fail("%s stored a fall time" % year)
				return false
		if red_sub.revealed:
			_fail("%s a tick revealed the still submarine" % year)
			return false
		game.reset()
		if not game.satellites.is_empty() or game.income_blue != 0 or game.beat != 0:
			_fail("%s left a satellite or a charge in place" % year)
			return false
		if year == 2023 and not game.tokens.is_empty():
			_fail("2023 reset grew an army")
			return false
	game.era_year = 1986
	game.reset()
	_ok("recon and killer satellites place with no radius, range, or fall")
	return true


func _cease_text_ok(text: String) -> bool:
	var lower := text.to_lower()
	if not _blank_text(text):
		return false
	if lower.contains("beats") or lower.contains("one extra") or lower.contains("command hq") or lower.contains("about") or lower.contains("half") or text.contains("spaces"):
		return false
	return true


func _land_steps(terrain, game, x: int, y: int) -> Array:
	var out: Array = []
	for step in TerrainScript.STEPS:
		var nx := posmod(x + int(step.x), TerrainScript.CELL_W)
		var ny := y + int(step.y)
		if ny < 0 or ny >= TerrainScript.CELL_H:
			continue
		var word := TerrainScript.pace_word(terrain.id_at(nx, ny))
		if word != "open" and word != "slow":
			continue
		if game.sites.at_cell(nx, ny) != null:
			continue
		if _unit_at(game, nx, ny):
			continue
		out.append(Vector2i(nx, ny))
	return out


## The question is offered and the answer is stored. Yes leaves movement and income alone.
func _check_cease(terrain, game) -> bool:
	for year in [1918, 1942]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var owners := _owner_snap(game)
		var refused: String = game.offer_cease("blue")
		if not refused.contains("not in this era") or game.cease_open or game.cease_answer != "" or not _same_owners(game, owners):
			_fail("%s accepted a cease fire: %s" % [year, refused])
			return false
		var answered: String = game.answer_cease("blue", "yes")
		if not answered.contains("not in this era") or game.cease_answer != "":
			_fail("%s recorded a cease fire: %s" % [year, answered])
			return false
	game.era_year = 9999
	game.player_side = "blue"
	game.reset()
	var hidden := {}
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city":
			hidden = place
			break
	if hidden.is_empty() or str(hidden.get("owner", "")) != "neutral":
		_fail("the concealed cities should be neutral before a cease fire")
		return false
	var concealed: String = game.offer_cease("blue")
	if not concealed.contains("not in this era") or str(hidden.get("owner", "")) != "neutral" or game.cease_open or game.cease_answer != "":
		_fail("the concealed era accepted a cease fire: %s" % concealed)
		return false
	for year in [1986, 2023]:
		game.era_year = year
		game.player_side = "blue"
		game.reset()
		var owners := _owner_snap(game)
		var pieces: int = game.tokens.size()
		var early: String = game.answer_cease("blue", "yes")
		if early != "Do you want a cease fire?" or game.cease_answer != "" or game.cease_open:
			_fail("%s recorded an answer before the question: %s" % [year, early])
			return false
		var asked: String = game.offer_cease("blue")
		if asked != "Do you want a cease fire?" or game.note != asked or not game.cease_open or game.cease_answer != "":
			_fail("%s did not ask the question: %s" % [year, asked])
			return false
		if not _cease_text_ok(asked):
			_fail("%s question invented a figure: %s" % [year, asked])
			return false
		var blue = game.token("blue")
		var saved: Array = []
		var home := Vector2i(-1, -1)
		if year == 1986:
			if blue == null:
				_fail("1986 cease fire lost the land piece")
				return false
			home = Vector2i(blue.x, blue.y)
			var steps: Array = _land_steps(terrain, game, blue.x, blue.y)
			if steps.is_empty():
				_fail("1986 cease fire has no land step")
				return false
			var marched: String = game.order("blue", int(steps[0].x), int(steps[0].y))
			if marched != "" or blue.path.is_empty() or blue.x != home.x or blue.y != home.y:
				_fail("the order before the cease fire was refused: %s" % marched)
				return false
			saved = blue.path.duplicate(true)
		elif not game.tokens.is_empty():
			_fail("2023 cease fire started with an army")
			return false
		var yes: String = game.answer_cease("blue", "yes")
		if yes != "Yes. The combat effect was not recovered." or game.note != yes or game.cease_answer != "yes" or game.cease_open:
			_fail("%s yes was not recorded: %s" % [year, yes])
			return false
		if not _cease_text_ok(yes) or game.income_blue != 0 or game.income_red != 0 or game.beat != 0 or game.oil_short:
			_fail("%s yes changed income or time: %s" % [year, yes])
			return false
		if game.tokens.size() != pieces or not _same_owners(game, owners):
			_fail("%s yes changed the board" % year)
			return false
		if year == 1986:
			if blue.x != home.x or blue.y != home.y or not _same_path(blue.path, saved):
				_fail("yes changed the march")
				return false
			if "strength" in blue or game.fight_on:
				_fail("yes stored a damage figure")
				return false
		var again: String = game.offer_cease("blue")
		if again != "Do you want a cease fire?" or not game.cease_open or game.cease_answer != "yes":
			_fail("%s hid the recorded yes: %s" % [year, again])
			return false
		var no: String = game.answer_cease("blue", "no")
		if no != "No. The combat effect was not recovered." or game.cease_answer != "no" or game.cease_open:
			_fail("%s no was not recorded: %s" % [year, no])
			return false
		if not _cease_text_ok(no) or game.income_blue != 0 or game.income_red != 0 or game.beat != 0:
			_fail("%s no changed income or time: %s" % [year, no])
			return false
		if year == 1986:
			if blue.x != home.x or blue.y != home.y or not _same_path(blue.path, saved):
				_fail("no changed the march")
				return false
			var steps_after: Array = _land_steps(terrain, game, blue.x, blue.y)
			if steps_after.size() >= 2:
				var next: String = game.order("blue", int(steps_after[1].x), int(steps_after[1].y))
				if next != "" or blue.path.is_empty() or _same_path(blue.path, saved):
					_fail("a cease fire blocked the next order: %s" % next)
					return false
			else:
				var cleared: String = game.order("blue", blue.x, blue.y)
				if cleared != "" or not blue.path.is_empty():
					_fail("a cease fire blocked a new order: %s" % cleared)
					return false
			if blue.x != home.x or blue.y != home.y or game.income_blue != 0 or game.beat != 0:
				_fail("the order after the cease fire moved the clock")
				return false
		game.reset()
		if game.cease_answer != "" or game.cease_open or game.income_blue != 0 or game.beat != 0:
			_fail("%s left a cease fire in place" % year)
			return false
		if year == 2023 and not game.tokens.is_empty():
			_fail("2023 reset grew an army")
			return false
	game.era_year = 1986
	game.reset()
	_ok("a cease fire asks the question and records yes or no without changing movement or income")
	return true


func _speed_text_ok(text: String, index: int) -> bool:
	var lower := text.to_lower()
	if text.contains("$") or lower.contains("beats") or lower.contains("one extra") or lower.contains("command hq") or lower.contains("production") or lower.contains("half") or lower.contains("about") or text.contains("spaces"):
		return false
	return not _has_digit(text.replace(str(index), ""))


## Speeds 0 through 6. Only 0 holds the clock, and none of them store an interval.
func _check_speed(terrain, game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	if game.speed_index != 0 or game.speed_run != 1:
		_fail("the opening speed should hold")
		return false
	var blue = game.token("blue")
	if blue == null:
		_fail("speed lost the land piece")
		return false
	var steps: Array = _land_steps(terrain, game, blue.x, blue.y)
	if steps.is_empty():
		_fail("speed has no land step")
		return false
	var home := Vector2i(blue.x, blue.y)
	var marched: String = game.order("blue", int(steps[0].x), int(steps[0].y))
	if marched != "" or blue.path.is_empty() or blue.x != home.x or blue.y != home.y or game.beat != 0 or game.speed_index != 0:
		_fail("speed 0 refused an order: %s" % marched)
		return false
	var saved: Array = blue.path.duplicate(true)
	for n in range(1, 7):
		var line: String = game.set_speed(n)
		if game.speed_index != n or game.speed_run != n or game.beat != 0 or game.income_blue != 0:
			_fail("speed %d changed the clock" % n)
			return false
		if not line.contains("running") or not line.contains("ratio was not recovered") or not _speed_text_ok(line, n):
			_fail("speed %d note: %s" % [n, line])
			return false
		if blue.x != home.x or blue.y != home.y or not _same_path(blue.path, saved):
			_fail("speed %d changed the march" % n)
			return false
	var held: String = game.set_speed(0)
	if held != "Speed 0 holds time. Orders are still accepted. The ratio was not recovered." or game.speed_index != 0 or game.speed_run != 6:
		_fail("speed 0 did not hold: %s" % held)
		return false
	if not _speed_text_ok(held, 0) or not _same_path(blue.path, saved) or game.beat != 0 or game.income_blue != 0:
		_fail("holding cleared the order")
		return false
	var resumed: String = game.toggle_speed()
	if game.speed_index != 6 or game.speed_run != 6 or not resumed.contains("running") or not _same_path(blue.path, saved):
		_fail("the running index did not return: %s" % resumed)
		return false
	var paused: String = game.toggle_speed()
	if game.speed_index != 0 or game.speed_run != 6 or not paused.contains("holds time") or not _same_path(blue.path, saved):
		_fail("the held index did not return: %s" % paused)
		return false
	if steps.size() >= 2:
		var next: String = game.order("blue", int(steps[1].x), int(steps[1].y))
		if next != "" or blue.path.is_empty() or _same_path(blue.path, saved) or game.speed_index != 0 or game.beat != 0:
			_fail("speed 0 refused the next order: %s" % next)
			return false
	else:
		var cleared: String = game.order("blue", blue.x, blue.y)
		if cleared != "" or not blue.path.is_empty() or game.speed_index != 0:
			_fail("speed 0 refused a new order: %s" % cleared)
			return false
	if game.set_speed(7) != "" or game.speed_index != 0:
		_fail("an index outside 0 through 6 was stored")
		return false
	game.era_year = 2023
	game.reset()
	if game.speed_index != 0 or game.speed_run != 1 or not game.tokens.is_empty():
		_fail("2023 opened with a speed or an army")
		return false
	if not game.set_speed(2).contains("running") or game.speed_index != 2 or not game.tokens.is_empty():
		_fail("2023 speed raised an army")
		return false
	game.era_year = 1986
	game.reset()
	if game.speed_index != 0 or game.speed_run != 1 or game.beat != 0:
		_fail("reset left a running speed")
		return false
	_ok("speeds 0 through 6 share one tick, and speed 0 still accepts orders")
	return true


## Two friendly pieces cross one cell. Neither is allowed to end on the other.
func _check_pass(game) -> void:
	game.reset()
	var nyc := {}
	for place in game.sites.places:
		if str(place.get("title", "")) == "New York":
			nyc = place
			break
	if nyc.is_empty():
		_fail("New York is missing for a pass")
		return
	if game.place_purchase("blue", "Infantry", int(nyc["x"]), int(nyc["y"])) != "":
		_fail("the pass could not place a second piece")
		return
	var capital = game.token("blue")
	var other = null
	for unit in game.tokens:
		if unit.side == "blue" and unit.domain != "sea" and unit != capital:
			other = unit
			break
	if other == null:
		_fail("the second piece is missing")
		return
	capital.x = 76
	capital.y = 44
	capital.path = []
	capital.debt = 0
	other.x = 80
	other.y = 44
	other.path = []
	other.debt = 0
	game.focus = capital
	var refused: String = game.order("blue", 80, 44)
	if refused != "Two units cannot stop on the same cell." or not capital.path.is_empty():
		_fail("a stop on a friendly cell should be refused: %s" % refused)
		return
	var onward: String = game.order("blue", 81, 44)
	if onward != "" or capital.path.is_empty():
		_fail("a cross past a friendly cell was refused: %s" % onward)
		return
	var through := false
	for step in capital.path:
		if int(step["x"]) == 80 and int(step["y"]) == 44:
			through = true
	if not through:
		_fail("the cross did not use the occupied cell")
		return
	game.focus = other
	var back: String = game.order("blue", 75, 44)
	if back != "" or other.path.is_empty():
		_fail("the second cross was refused: %s" % back)
		return
	var shared := false
	var stopped := false
	for _i in 8:
		game.tick()
		if capital.x == other.x and capital.y == other.y:
			if capital.path.is_empty() and other.path.is_empty():
				stopped = true
			else:
				shared = true
		if capital.x == 81 and capital.y == 44 and other.x == 75 and other.y == 44:
			break
	if stopped or not shared or capital.x != 81 or capital.y != 44 or other.x != 75 or other.y != 44:
		_fail("the pieces should cross and not stop together (shared %s stopped %s at %d,%d and %d,%d)" % [shared, stopped, capital.x, capital.y, other.x, other.y])
		return
	game.reset()
	if game.winner() != "" or game.token("blue").x != 79 or game.token("blue").y != 44:
		_fail("the pass left the ungarrisoned opening")
		return
	_ok("two pieces may cross a cell and cannot stop on it")


func _layout_shuffled(game) -> bool:
	var moved := false
	for place in game.sites.places:
		if str(place.get("owner", "")) != str(place.get("home", "")):
			_fail("2023 shuffle changed an owner")
			return false
		var kind := str(place.get("kind", ""))
		var x := int(place["x"])
		var y := int(place["y"])
		var listed_x := int(place["listed_x"])
		var listed_y := int(place["listed_y"])
		if kind == "capital":
			if x != listed_x or y != listed_y:
				_fail("2023 shuffle moved a capital")
				return false
			if str(place["title"]) == "Washington" and (x != 79 or y != 44):
				_fail("Washington left its listed cell")
				return false
			if str(place["title"]) == "Moscow" and (x != 183 or y != 25):
				_fail("Moscow left its listed cell")
				return false
		elif kind == "city" and (x != listed_x or y != listed_y):
			moved = true
		elif x != listed_x or y != listed_y:
			_fail("2023 shuffle moved a %s" % kind)
			return false
	if not moved:
		_fail("2023 shuffle left every city in place")
		return false
	if game.oil_cells.is_empty() or game.oil_cells.size() != game.oil_listed.size() or _same_oil_order(game.oil_cells, game.oil_listed):
		_fail("2023 shuffle left the oil cells in listed order")
		return false
	return true


func _layout_listed(game) -> bool:
	for place in game.sites.places:
		if int(place["x"]) != int(place["listed_x"]) or int(place["y"]) != int(place["listed_y"]):
			return false
	return _same_oil_order(game.oil_cells, game.oil_listed)


func _city_key(game) -> String:
	var bits := PackedStringArray()
	for place in game.sites.places:
		if str(place.get("kind", "")) != "city":
			continue
		bits.append("%s:%d,%d" % [str(place.get("title", "")), int(place["x"]), int(place["y"])])
	bits.sort()
	return "\n".join(bits)


func _same_oil_order(got: Array, expect: Array) -> bool:
	if got.size() != expect.size():
		return false
	for i in got.size():
		if not got[i] is Vector2i or not expect[i] is Vector2i:
			return false
		if (got[i] as Vector2i) != (expect[i] as Vector2i):
			return false
	return true


func _check_oil_trigger(game) -> bool:
	var held_line := "Oil shortage. Movement is stopped. Planes are grounded. City income is stopped."
	game.era_year = 1986
	game.reset()
	if game.oil_short or game.oil_reserve != Assumptions.OIL_RESERVE:
		_fail("reset should restore the stand-in oil reserve")
		return false
	var land = game.token("blue")
	if _token_on_oil(game, land):
		_fail("the opening piece is already on oil")
		return false
	game.oil_reserve = 1
	game.tick()
	if game.oil_reserve != 0 or not game.oil_short or game.note != held_line or game.spoken() != Assumptions.SHORTAGE_VOICE:
		_fail("one tick should spend the last reserve: %s" % game.note)
		return false
	var x: int = land.x
	var y: int = land.y
	if game.order("blue", 83, 42) != held_line or land.x != x or land.y != y or not land.path.is_empty():
		_fail("the stand-in shortage should stop the next order")
		return false
	var spot := _open_oil(game)
	if spot.x < 0:
		_fail("no open oil cell for the refill")
		return false
	land.path = []
	land.debt = 0
	land.x = spot.x
	land.y = spot.y
	game.tick()
	if game.oil_short or game.oil_reserve != Assumptions.OIL_RESERVE:
		_fail("standing on oil should refill the stand-in reserve")
		return false
	game.reset()
	if game.oil_short or game.oil_reserve != Assumptions.OIL_RESERVE or not _layout_listed(game):
		_fail("reset should clear a stand-in shortage")
		return false
	_ok("the stand-in oil reserve trips the shortage, and an oilfield refills it")
	return true


func _check_oil_capture(game) -> bool:
	game.era_year = 1986
	game.player_side = "blue"
	game.reset()
	var spot := _open_oil(game)
	if spot.x < 0:
		_fail("no open oil well to capture")
		return false
	var red = game.token("red")
	var approach_y := spot.y + 1 if spot.y + 1 < TerrainScript.CELL_H else spot.y - 1
	red.x = spot.x
	red.y = approach_y
	red.pinned = false
	red.path = [{"x": spot.x, "y": spot.y, "pace": 1, "word": "open"}]
	red.debt = 1
	game.tick()
	if game.oil_owner_at(spot.x, spot.y) != "red" or not game.toasts.has("Oil taken"):
		_fail("a unit on an oil well did not capture it")
		return false
	var saved: Array = game.oil_listed.duplicate()
	game.country_names = ["USA", "USSR"]
	game.set_oil_cells([
		{"x": 4, "y": 4, "name": "Permian Basin", "region": "USA"},
		{"x": 6, "y": 6, "name": "West Siberia", "region": "Russia"},
		{"x": 8, "y": 8, "name": "North Sea", "region": "UK/Norway"},
	])
	if game.oil_owner_at(4, 4) != "blue" or game.oil_owner_at(6, 6) != "red" or game.oil_owner_at(8, 8) != "UK/Norway":
		_fail("oil wells did not start with the country they are in")
		return false
	var blue = game.token("blue")
	blue.x = 6
	blue.y = 5
	blue.pinned = false
	blue.path = [{"x": 6, "y": 6, "pace": 1, "word": "open"}]
	blue.debt = 1
	game.tick()
	if game.oil_owner_at(6, 6) != "blue" or not str(game.note).contains("captured") or not str(game.note).contains("West Siberia"):
		_fail("blue did not capture the red oil well: %s" % game.note)
		return false
	if str(game.note).to_lower().contains("production"):
		_fail("oil capture named production")
		return false
	game.country_names = []
	game.set_oil_cells(saved)
	game.reset()
	_ok("an oil well starts with its country and a unit can capture it")
	return true


func _token_on_oil(game, unit) -> bool:
	for cell in game.oil_cells:
		if cell is Vector2i and (cell as Vector2i).x == unit.x and (cell as Vector2i).y == unit.y:
			return true
	return false


func _open_oil(game) -> Vector2i:
	for cell in game.oil_cells:
		if not cell is Vector2i:
			continue
		var spot: Vector2i = cell
		if spot.y < 0 or spot.y >= TerrainScript.CELL_H:
			continue
		var busy := false
		for unit in game.tokens:
			if unit.x == spot.x and unit.y == spot.y:
				busy = true
		if not busy:
			return spot
	return Vector2i(-1, -1)


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


func _still_list_kept(stills, pack) -> bool:
	var stem := "WAR2"
	var got: PackedStringArray = stills.files_for(stem)
	var manifest: Variant = pack.json_any("anims/%s/manifest.json" % stem)
	if not manifest is Dictionary or got.size() < 2:
		return false
	var listed := PackedStringArray()
	for image in (manifest as Dictionary).get("embedded_images", []):
		if not image is Dictionary:
			continue
		var file := str((image as Dictionary).get("file", ""))
		if file == "":
			continue
		listed.append("anims/%s/%s" % [stem, file])
	if got.size() != listed.size():
		return false
	var forward := true
	var backward := true
	for i in got.size():
		if got[i] != listed[i]:
			forward = false
		if got[i] != listed[listed.size() - 1 - i]:
			backward = false
	return forward and not backward


func _ok(message: String) -> void:
	print("OK %s" % message)


func _fail(message: String) -> void:
	_failures.append(message)
	print("FAIL %s" % message)
