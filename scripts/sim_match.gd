extends SceneTree

## Headless match. One tick is one round.
##   godot --headless --path . --script res://scripts/sim_match.gd
##   SIM_ROUNDS=10 godot --headless --path . --script res://scripts/sim_match.gd

const DataPackScript = preload("res://scripts/data_pack.gd")
const TerrainScript = preload("res://scripts/terrain_map.gd")
const SiteScript = preload("res://scripts/site_book.gd")
const OilScript = preload("res://scripts/oil_layer.gd")
const MatchScript = preload("res://scripts/match_state.gd")
const SeaScript = preload("res://scripts/sea_lanes.gd")

const ERA := 1986
const PLAYER := "blue"


func _init() -> void:
	call_deferred("_run")


func _run() -> void:
	var rounds := 10
	var asked := OS.get_environment("SIM_ROUNDS")
	if asked.is_valid_int():
		rounds = maxi(1, int(asked))
	var game = _boot()
	if game == null:
		quit(1)
		return
	_open(game)
	print("OpenCHQ sim — %d — %s — %d rounds" % [ERA, MatchScript._label(PLAYER), rounds])
	print("Oil reserve %d. One burn per round while %s is off an oil cell." % [game.oil_reserve, MatchScript._label(PLAYER)])
	_order_opening(game)
	print("Oil at the start: %s" % _oil_tally(game))
	var trace := OS.get_environment("SIM_TRACE") == "1" or rounds <= 20
	var cities_taken := 0
	var wells_taken := 0
	var decided := 0
	for n in rounds:
		if game.winner() == "":
			_keep_land_order(game)
		var before := _places(game)
		var toast_n: int = game.toasts.size()
		var lines: Array = game.tick()
		var n1 := n + 1
		for line in lines:
			var text := str(line)
			if text.contains("took "):
				cities_taken += 1
			if text.contains("captured "):
				wells_taken += 1
		if decided == 0 and game.winner() != "":
			decided = n1
		var show: bool = trace or decided == n1 or (decided == 0 and (not lines.is_empty() or game.toasts.size() != toast_n or _lost_piece(game, before) != "" or n1 % 100 == 0))
		if show and n1 % 100 != 0:
			if trace:
				_print_round(game, n1, before, lines, toast_n)
			else:
				_print_brief(game, n1, before, lines, toast_n)
		if n1 % 100 == 0:
			_print_eco(game, n1)
	if decided != 0 and decided < rounds:
		print("Rounds %d–%d hold the result." % [decided + 1, rounds])
	_print_end(game, cities_taken, wells_taken)
	print("SIM_OK")
	quit(0)


func _boot():
	var pack = DataPackScript.new()
	var err: String = pack.open()
	if err != "":
		push_error(err)
		return null
	var terrain = TerrainScript.new()
	err = terrain.load_bytes(pack.bytes("data/tmap.bin"))
	if err != "":
		push_error(err)
		return null
	var countries: Array = pack.json_dict("data/game_meta.json").get("countries", [])
	var sites = SiteScript.new()
	err = sites.load_sites(pack.json_array("data/sites.json"), countries, 96.0)
	if err != "":
		push_error(err)
		return null
	var game = MatchScript.new()
	game.terrain = terrain
	game.sites = sites
	game.country_names = countries
	game.era_year = ERA
	game.player_side = PLAYER
	var oil = OilScript.new()
	oil.load_doc(pack.json_any("data/resources_oil.json"), 30720.0, 13632.0)
	oil.set_era(ERA)
	var oil_cells: Array = []
	for field in oil.placed:
		oil_cells.append({
			"x": int(float(field.get("map_x", -1))),
			"y": int(float(field.get("map_y", -1))),
			"name": str(field.get("name", "Oil well")),
			"region": str(field.get("region", "")),
		})
	game.set_oil_cells(oil_cells)
	var lanes = SeaScript.new()
	err = lanes.load_bytes(pack.bytes("exe/CHQ_unpacked.EXE"))
	if err != "":
		push_error(err)
		return null
	game.sea = lanes
	return game


func _open(game) -> void:
	game.reset()


func _order_opening(game) -> void:
	var red_cap: Dictionary = game.sites.capital("red")
	var blue_cap: Dictionary = game.sites.capital("blue")
	var land = game.token(PLAYER)
	var refused: String = game.order(PLAYER, int(red_cap["x"]), int(red_cap["y"]))
	print("Order: %s land %s → %s (%d, %d). %s Path %d." % [
		MatchScript._label(PLAYER),
		_at(game, land),
		str(red_cap["title"]),
		int(red_cap["x"]),
		int(red_cap["y"]),
		refused if refused != "" else "Accepted.",
		land.path.size(),
	])
	var ship = game.sea_token(PLAYER)
	var dock: Vector2i = game._dock_beside_capital("red", ship)
	if dock.x < 0:
		print("Order: %s ship stays at %s. No reachable dock near %s." % [MatchScript._label(PLAYER), _at(game, ship), str(red_cap["title"])])
	else:
		game.focus = ship
		game.selected_side = PLAYER
		game.selected_domain = "sea"
		var sailed: String = game.order(PLAYER, dock.x, dock.y)
		game.focus = null
		game.selected_side = ""
		game.selected_domain = ""
		print("Order: %s ship %s → dock (%d, %d) near %s. %s Path %d." % [
			MatchScript._label(PLAYER),
			_at(game, ship),
			dock.x,
			dock.y,
			str(red_cap["title"]),
			sailed if sailed != "" else "Accepted.",
			ship.path.size(),
		])
	print("The other side marches on %s. Its ship sails once when idle." % str(blue_cap["title"]))
	print("")


func _keep_land_order(game) -> void:
	var land = game.token(PLAYER)
	if land == null or land.pinned or not land.path.is_empty():
		return
	var red_cap: Dictionary = game.sites.capital("red")
	if land.x == int(red_cap["x"]) and land.y == int(red_cap["y"]):
		return
	game.focus = null
	game.selected_side = ""
	game.selected_domain = ""
	game.order(PLAYER, int(red_cap["x"]), int(red_cap["y"]))


func _print_eco(game, n: int) -> void:
	var blue_cash: int = game.cash_blue
	var red_cash: int = game.cash_red
	var blue_level: int = game.city_income("blue")
	var red_level: int = game.city_income("red")
	var blue_oil: int = game.oil_income("blue")
	var red_oil: int = game.oil_income("red")
	print("Tick %d" % n)
	print("  armies      Blue %d   Red %d" % [_armies(game, "blue"), _armies(game, "red")])
	print("  income      Blue %d   Red %d   total %d. Paid Blue %d Red %d total %d." % [blue_level, red_level, blue_level + red_level, game.income_blue, game.income_red, game.income_blue + game.income_red])
	print("  $           Blue %d billion   Red %d billion   total %d billion" % [blue_cash, red_cash, blue_cash + red_cash])
	print("  oil income  Blue %d   Red %d   total %d. Paid Blue %d Red %d total %d." % [blue_oil, red_oil, blue_oil + red_oil, game.oil_income_blue, game.oil_income_red, game.oil_income_blue + game.oil_income_red])
	print("  cities      Blue %d   Red %d" % [_cities(game, "blue"), _cities(game, "red")])


func _armies(game, side: String) -> int:
	var n := 0
	for unit in game.tokens:
		if unit.side == side and unit.domain != "sea":
			n += 1
	return n


func _cities(game, side: String) -> int:
	var n := 0
	for place in game.sites.places:
		if str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == side:
			n += 1
	return n


func _wells(game, side: String) -> int:
	var n := 0
	for key in game.oil_owner.keys():
		if str(game.oil_owner[key]) == side:
			n += 1
	return n


func _print_brief(game, n: int, before: Dictionary, lines: Array, toast_n: int) -> void:
	var bits := PackedStringArray()
	for unit in game.tokens:
		var key := "%s:%s" % [unit.side, unit.domain]
		var was: Vector2i = before.get(key, Vector2i(unit.x, unit.y))
		var moved: bool = was.x != unit.x or was.y != unit.y
		var where := _at(game, unit) if moved else "held"
		bits.append("%s %s %s" % [MatchScript._label(unit.side), _kind(unit), where])
	var gone := _lost_piece(game, before)
	if gone != "":
		bits.append("removed " + gone)
	print("Round %d  %s" % [n, " | ".join(bits)])
	for line in lines:
		print("  %s" % str(line))
	for i in range(toast_n, game.toasts.size()):
		print("  toast: %s" % str(game.toasts[i]))
	if game.winner() != "":
		print("  winner: %s" % MatchScript._label(game.winner()))


func _print_end(game, cities_taken: int, wells_taken: int) -> void:
	print("")
	if game.winner() != "":
		print("Winner after %d rounds: %s. %s" % [game.round, MatchScript._label(game.winner()), game.note])
	else:
		print("No winner after %d rounds." % game.round)
	for place in game.sites.places:
		if str(place.get("kind", "")) != "capital":
			continue
		print("  %s owner %s" % [str(place.get("title", "")), str(place.get("owner", ""))])
	for unit in game.tokens:
		print("  %s %s %s, %d steps" % [MatchScript._label(unit.side), _kind(unit), _at(game, unit), unit.path.size()])
	print("Cities taken %d. Oil wells captured %d." % [cities_taken, wells_taken])
	print("Oil at the end: %s. Reserve %d%s." % [_oil_tally(game), game.oil_reserve, " short" if game.oil_short else ""])


func _oil_tally(game) -> String:
	var counts := {}
	for key in game.oil_owner.keys():
		var who := str(game.oil_owner[key])
		counts[who] = int(counts.get(who, 0)) + 1
	var names: Array = counts.keys()
	names.sort()
	var bits := PackedStringArray()
	for who in names:
		bits.append("%s %d" % [str(who), int(counts[who])])
	return ", ".join(bits)


func _lost_piece(game, before: Dictionary) -> String:
	var now := {}
	for unit in game.tokens:
		now["%s:%s" % [unit.side, unit.domain]] = true
	var gone := PackedStringArray()
	for key in before.keys():
		if not now.has(key):
			gone.append(str(key))
	return ", ".join(gone)


func _print_round(game, n: int, before: Dictionary, lines: Array, toast_n: int) -> void:
	print("Round %d" % n)
	for unit in game.tokens:
		var key := "%s:%s" % [unit.side, unit.domain]
		var was: Vector2i = before.get(key, Vector2i(unit.x, unit.y))
		var moved: bool = was.x != unit.x or was.y != unit.y
		var step := "moved" if moved else "held"
		print("  %s %s %s from (%d, %d) to %s, %d steps left" % [
			MatchScript._label(unit.side),
			_kind(unit),
			step,
			was.x,
			was.y,
			_at(game, unit),
			unit.path.size(),
		])
	if not lines.is_empty():
		for line in lines:
			print("  event: %s" % str(line))
	for i in range(toast_n, game.toasts.size()):
		print("  toast: %s" % str(game.toasts[i]))
	var voice := str(game.spoken())
	if voice != "":
		print("  note: %s" % voice)
	print("  oil %d%s" % [game.oil_reserve, " short" if game.oil_short else ""])
	if game.winner() != "":
		print("  winner: %s" % MatchScript._label(game.winner()))
	print("")


func _places(game) -> Dictionary:
	var out := {}
	for unit in game.tokens:
		out["%s:%s" % [unit.side, unit.domain]] = Vector2i(unit.x, unit.y)
	return out


func _at(game, unit) -> String:
	var id := int(game.terrain.id_at(unit.x, unit.y))
	return "(%d, %d) %s" % [unit.x, unit.y, TerrainMap.terrain_name(id)]


func _kind(unit) -> String:
	if str(unit.label) != "":
		return str(unit.label)
	return "ship" if unit.domain == "sea" else "army"
