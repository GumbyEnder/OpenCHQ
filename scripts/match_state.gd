extends RefCounted
class_name MatchState

var terrain: TerrainMap
var sea: SeaLanes
var sites: SiteBook
var beat := 0
## The booklet's round and the binary turn heartbeat. One tick is one turn here.
## The recovered turn length (0x3e87, 0x2e16) was not a separate step count.
var round := 0
var note := ""
## Shown in place of note when a stand-in line applies. Empty uses note.
var player_note := ""
var era_year := 1986
## The side that takes orders. The other side marches on this side's capital.
var player_side := "blue"
var selected_side := ""
var selected_domain := ""
## The piece the last click selected. Empty means the first land piece.
var focus = null
var tokens: Array = []
var _red_key := ""
## A shortage flag. The reserve is a stand-in, not a recovered rate.
var oil_short := false
var oil_reserve := Assumptions.OIL_RESERVE
## City income already added to the pool, in billions. The level is city_income().
var income_blue := 0
var income_red := 0
## Oil income already added to the pool, in billions. The level is oil_income().
var oil_income_blue := 0
var oil_income_red := 0
var _income_said := ""
var _combat_said := ""
var support_blue := 0
var support_red := 0
var fight_on := false
var fight_rounds := 0
var fight_shots := 0
var fight_peak := 0
## Sticky player line after a stand-in removal. note stays the older sentence.
var fight_gone := false
var combat_note := ""
## Last-seen cells. Each entry is {x, y, life}.
var contacts: Array = []
## Short lines that do not replace player_note. The log is separate.
var toasts: Array = []
var _threat_said := false
var _ship_idle := {"blue": false, "red": false}
## One-shot intel pulse. Empty when there is nothing to draw.
var pulse := ""
var flash_cell := Vector2i(-999, -999)
var flash_kind := ""
## Yes banner. The cease-fire note stays the older sentence.
var cease_banner := ""
var cash_blue := -1
var cash_red := -1
## "full" or "centers" after the last site repaint.
var paint_mode := ""
## Who the enemy shot at. A second friendly is never this.
var shot_takes := ""
var aim_blue := Vector2i(-999, -999)
var aim_red := Vector2i(-999, -999)
var extra_blue_on := false
var extra_red_on := false
var extra_blue := Vector2i(-999, -999)
var extra_red := Vector2i(-999, -999)
## The side an intel scan told. Empty until that scan runs.
var opponent_told := ""
## Producing cities tired by a match purchase. No duration is stored.
var unready_ids := {}
## Rounds a bombed city, base, or oil site cannot build. The amount taken is not stored.
var build_lock := {}
## Latched when the ordered side finds the other capital. Era 9999 reads it.
var _capital_found := false
## Oilfield cells for the era. No rate is stored.
## Owner is blue, red, or neutral. Home is the country the well starts in.
var oil_cells: Array = []
var oil_listed: Array = []
## Site country names. Index 0 is blue, index 1 is red, and the rest are neither side.
var country_names: Array = []
var _oil_home: Dictionary = {}
var _oil_name: Dictionary = {}
var oil_owner: Dictionary = {}
## 2023 stand-in pool, in billions. -1 means the pool was not set.
var cash_billions := -1
## Stand-in sight. See Assumptions.SIGHT_CELLS.
var sight_cells := Assumptions.SIGHT_CELLS
## Launch counts. Not damage, money, or a radius. The penalty amount stays blank.
var nuke_fired := {"blue": 0, "red": 0}
var nuke_absorbed := {"blue": 0, "red": 0}
var nuke_first := ""
var nuke_penalty := ""
## Recon and killer satellites. Fall time is blank, so a tick does not remove one.
var satellites: Array = []
## Empty until the player answers the cease-fire question. Yes changes no combat figure.
var cease_answer := ""
var cease_open := false
## Speed 0 holds the clock. Speeds 1 through 6 share the one existing tick.
var speed_index := 0
var speed_run := 1

## Ocean cells off the capital-to-capital corridor. Walker class stays 0.
const SEA_BLUE := Vector2i(0, 15)
const SEA_RED := Vector2i(300, 70)


class Token extends RefCounted:
	var side := ""
	var domain := "land"
	## Walker class passed to the sea route. Not a booklet type id.
	var ship_class := 0
	var x := 0
	var y := 0
	var path: Array = []
	var debt := 0
	## Step the piece last took. Flank and rear are words, not multipliers.
	var facing := Vector2i(0, -1)
	var pinned := false
	## Set when a land piece on the water takes a sea-lane order.
	var transporting := false
	## Set when an intel scan has revealed this piece. No radius is stored.
	var revealed := false
	## Infantry only. The bonus amount was not recovered.
	var entrenched := false
	var label := ""
	## Rounds left inactive after a mission or a scramble. Not a distance.
	var idle_rounds := 0
	## land, sea, bomb, or scramble. Empty when the aircraft is free.
	var mission_kind := ""
	## Set once an enemy piece has been shown. A still submarine that was never shown stays false.
	var was_shown := false
	var seen_x := 0
	var seen_y := 0


func token(side: String) -> Token:
	for unit in tokens:
		if unit.side == side and unit.domain != "sea":
			return unit
	return null


func sea_token(side: String) -> Token:
	for unit in tokens:
		if unit.side == side and unit.domain == "sea":
			return unit
	return null


## Land piece, unless that side's sea piece is the one selected.
func ordered_unit(side: String) -> Token:
	if focus != null and focus.side == side and tokens.has(focus):
		return focus
	if selected_side == side and selected_domain == "sea":
		var ship := sea_token(side)
		if ship != null:
			return ship
	return token(side)


func reset() -> void:
	sites.reset_owners()
	if era_year >= 9999:
		sites.apply_city_states()
	beat = 0
	round = 0
	focus = null
	note = "You are %s. Your land piece and your ship are marked." % _label(player_side)
	player_note = ""
	combat_note = ""
	selected_side = ""
	selected_domain = ""
	_red_key = ""
	_capital_found = false
	oil_short = false
	oil_reserve = Assumptions.OIL_RESERVE
	sight_cells = Assumptions.SIGHT_CELLS
	var pool := Assumptions.CASH_2023 if era_year == 2023 else Assumptions.CASH_EARLY
	cash_blue = pool
	cash_red = pool
	cash_billions = pool
	contacts = []
	toasts = []
	_threat_said = false
	_ship_idle = {"blue": false, "red": false}
	pulse = ""
	flash_cell = Vector2i(-999, -999)
	flash_kind = ""
	cease_banner = ""
	fight_gone = false
	fight_peak = 0
	income_blue = 0
	income_red = 0
	oil_income_blue = 0
	oil_income_red = 0
	_income_said = ""
	_combat_said = ""
	support_blue = 0
	support_red = 0
	extra_blue_on = false
	extra_red_on = false
	opponent_told = ""
	unready_ids.clear()
	build_lock.clear()
	nuke_fired = {"blue": 0, "red": 0}
	nuke_absorbed = {"blue": 0, "red": 0}
	nuke_first = ""
	nuke_penalty = ""
	satellites = []
	cease_answer = ""
	cease_open = false
	speed_index = 0
	speed_run = 1
	_clear_fight()
	fight_gone = false
	if sites != null:
		sites.restore_listed()
	_place_oil()
	# 2023 has no starting army. Cash and the city/oil layout are stand-ins.
	if era_year == 2023:
		tokens = []
		if sites != null:
			sites.shuffle_cities(Assumptions.SHUFFLE_SEED)
		_place_oil()
		_repaint_sites()
		note = "You are %s. 2023 starts with no army. %s" % [_label(player_side), Assumptions.cash_note()]
		return
	_repaint_sites()
	var blue_cap: Dictionary = sites.capital("blue")
	var red_cap: Dictionary = sites.capital("red")
	tokens = [
		_make("blue", int(blue_cap["x"]), int(blue_cap["y"])),
		_make("red", int(red_cap["x"]), int(red_cap["y"])),
		_make_sea("blue", SEA_BLUE.x, SEA_BLUE.y),
		_make_sea("red", SEA_RED.x, SEA_RED.y),
	]


## The HUD line. A stand-in voice replaces the lab sentence and leaves note unchanged.
func spoken() -> String:
	if winner() != "":
		fight_gone = false
		player_note = ""
		return note
	if note.contains("Oil shortage"):
		fight_gone = false
		player_note = Assumptions.SHORTAGE_VOICE
		return player_note
	if fight_gone:
		player_note = Assumptions.GONE_VOICE
		return player_note
	if note.contains("Damage amount unknown") or combat_note.contains("Damage amount unknown"):
		player_note = Assumptions.FIGHT_VOICE
	else:
		player_note = ""
	if player_note != "":
		return player_note
	return note


func winner() -> String:
	var owner := ""
	var n := 0
	for place in sites.places:
		if str(place["kind"]) != "capital":
			continue
		n += 1
		var who := str(place["owner"])
		if who == "neutral":
			return ""
		if owner == "":
			owner = who
		elif owner != who:
			return ""
	if n < 2:
		return ""
	return owner


## Ship path. Class 0 may enter shallows. Class 1 refuses them.
## The straight walk is used when it passes. Otherwise the sea-lane graph.
func ship_route(x0: int, y0: int, x1: int, y1: int, cls: int) -> Variant:
	if sea == null or terrain == null:
		return null
	return sea.route(terrain, x0, y0, x1, y1, cls)


## A land piece already on water, ordered to water, forms a transport.
## The path is the existing sea-lane route. null when this order stays on land.
func formed_transport_route(unit: Token, x: int, y: int) -> Variant:
	if unit == null or unit.domain == "sea" or terrain == null:
		return null
	if not TerrainMap.sea_accepts(unit.ship_class, terrain.id_at(unit.x, unit.y)):
		return null
	if not TerrainMap.sea_accepts(unit.ship_class, terrain.id_at(x, y)):
		return null
	var sailed: Variant = ship_route(unit.x, unit.y, x, y, unit.ship_class)
	if sailed is Array and not (sailed as Array).is_empty():
		return sailed
	return null


## Blank magnitudes. The tool is refused outside the eras that add it.
func use_tool(side: String, tool: String) -> String:
	var label := _tool_name(tool)
	if label == "":
		return ""
	if not Roster.tool_open(era_year, tool):
		return "%s — %s is not in this era" % [_label(side), label]
	match tool:
		"nuke":
			return "%s — nuke is available. Damage amounts are unknown." % _label(side)
		"satellite":
			# No radius is stored, so the scan reveals nothing. A still submarine stays hidden.
			return "%s — an air or satellite scan does not reveal a still submarine. The scan radius is unknown." % _label(side)
		"foreign_aid":
			return "%s — foreign aid is available. The cost is unknown." % _label(side)
		"intel":
			for unit in tokens:
				unit.revealed = true
			opponent_told = "red" if side == "blue" else "blue"
			pulse = "intel"
			return "%s — intel reveals every unit. The opponent is told." % _label(side)
		_:
			return ""


## 1986 and 2023. One click shifts a city neutral. The next gives it to the buyer.
## The cost was not recovered, so nothing is charged.
func spend_aid(side: String, site: Dictionary) -> String:
	if not Roster.tool_open(era_year, "foreign_aid"):
		return _air_note(side, use_tool(side, "foreign_aid"))
	if site.is_empty() or str(site.get("kind", "")) != "city":
		return _air_note(side, "Click a city. The cost was not recovered.")
	var owner := str(site.get("owner", ""))
	var title := str(site.get("title", "city"))
	if owner == side:
		return _air_note(side, "%s is already yours. The cost was not recovered." % title)
	if owner == "neutral":
		site["owner"] = side
		_flash_at(int(site.get("x", -999)), int(site.get("y", -999)), "aid")
		return _air_note(side, "Foreign aid. %s shifted to %s. The cost was not recovered." % [title, _label(side)])
	site["owner"] = "neutral"
	_flash_at(int(site.get("x", -999)), int(site.get("y", -999)), "aid")
	return _air_note(side, "Foreign aid. %s shifted neutral. The cost was not recovered." % title)


## Further launches stop after three fired, or three absorbed without a reply.
func nukes_stopped() -> bool:
	for who in ["blue", "red"]:
		if int(nuke_fired.get(who, 0)) >= 3 or int(nuke_absorbed.get(who, 0)) >= 3:
			return true
	return false


## One-shot from submarines that are not pieces. No damage, radius, flip, or winter.
func launch_nuke(side: String, site: Dictionary) -> String:
	if not Roster.tool_open(era_year, "nuke"):
		return _air_note(side, use_tool(side, "nuke"))
	if nukes_stopped():
		return _air_note(side, "Further launches are stopped.")
	var kind := str(site.get("kind", ""))
	if kind == "capital":
		return _air_note(side, "Capitals are excluded.")
	if site.is_empty() or kind != "city":
		return _air_note(side, "Click a city. Capitals are excluded. Crews will not target the home country.")
	var owner := str(site.get("owner", ""))
	if owner == side:
		return _air_note(side, "Crews will not target the home country.")
	nuke_fired[side] = int(nuke_fired.get(side, 0)) + 1
	if (owner == "blue" or owner == "red") and int(nuke_fired.get(owner, 0)) == 0:
		nuke_absorbed[owner] = int(nuke_absorbed.get(owner, 0)) + 1
	var first_time := nuke_first == ""
	if first_time:
		nuke_first = side
		nuke_penalty = ""
	var title := str(site.get("title", "city"))
	_flash_at(int(site.get("x", -999)), int(site.get("y", -999)), "nuke")
	var line := "Launch at %s from submarines that are not pieces on the map. Damage, blast radius, city flips, wasteland paint, and nuclear winter stay off, because those need a radius or a damage figure." % title
	if first_time:
		line += " The first user is penalized. The penalty amount stays blank."
	return _air_note(side, line)


## 1986 and 2023. Placement does not reveal by distance and does not pick a target by distance.
## Fall time is blank, so the satellite stays up.
func place_satellite(side: String, kind: String) -> String:
	if not Roster.tool_open(era_year, "satellite"):
		return _air_note(side, use_tool(side, "satellite"))
	if kind != "recon" and kind != "killer":
		return _air_note(side, "Click Recon sat or Killer sat.")
	satellites.append({"side": side, "kind": kind, "fall": ""})
	if kind == "recon":
		return _air_note(side, "Recon satellite placed. It does not reveal by distance. The radius was not recovered. It does not reveal a still submarine. Fall time stays blank, so it does not fall on its own.")
	return _air_note(side, "Killer satellite placed. It does not pick targets by distance. The range was not recovered. Fall time stays blank, so it does not fall on its own.")


func _hold_satellites() -> void:
	for sat in satellites:
		if sat is Dictionary:
			sat["fall"] = ""


## 1986 and 2023. The question is recorded. Yes does not change movement or income.
func offer_cease(side: String) -> String:
	if not Roster.tool_open(era_year, "cease"):
		cease_open = false
		return _air_note(side, "%s — a cease fire is not in this era" % _label(side))
	cease_open = true
	return _air_note(side, "Do you want a cease fire?")


func answer_cease(side: String, answer: String) -> String:
	if not Roster.tool_open(era_year, "cease"):
		cease_open = false
		return _air_note(side, "%s — a cease fire is not in this era" % _label(side))
	if not cease_open or (answer != "yes" and answer != "no"):
		return _air_note(side, "Do you want a cease fire?")
	cease_open = false
	cease_answer = answer
	if answer == "yes":
		cease_banner = "Cease fire accepted"
		return _air_note(side, "Yes. The combat effect was not recovered.")
	cease_banner = ""
	return _air_note(side, "No. The combat effect was not recovered.")


## The index selects held or running. It does not choose a separate interval.
func set_speed(index: int) -> String:
	if index < 0 or index > 6:
		return ""
	speed_index = index
	if index == 0:
		return "Speed 0 holds time. Orders are still accepted. The ratio was not recovered."
	speed_run = index
	return "Speed %d is running. The ratio was not recovered." % index


func toggle_speed() -> String:
	if speed_index == 0:
		var run := speed_run
		if run < 1 or run > 6:
			run = 1
		return set_speed(run)
	return set_speed(0)


## Infantry digs in. Harder to kill, and lost when ordered to move. The bonus stays blank.
func entrench(side: String) -> String:
	if winner() != "":
		return ""
	var unit: Token = ordered_unit(side)
	if unit == null or unit.domain != "land" or unit.label != "Infantry":
		return "Only infantry can entrench."
	unit.entrenched = true
	var line := "Infantry entrenched. The bonus was not recovered."
	if side == player_side:
		note = line
	return line


## Aircraft missions. The 8, 4, and 5 are round counts. Range and damage stay blank.
func air_open() -> bool:
	var year := 1942 if era_year >= 9999 else era_year
	return year >= 1942


func bomb_site_kind(kind: String) -> bool:
	return kind == "city" or kind == "base"


func build_left(key: String) -> int:
	return int(build_lock.get(key, 0))


func enemy_mission(side: String) -> bool:
	var other := "red" if side == "blue" else "blue"
	for unit in tokens:
		if unit.side != other:
			continue
		if unit.idle_rounds <= 0:
			continue
		if unit.mission_kind == "land" or unit.mission_kind == "sea" or unit.mission_kind == "bomb":
			return true
	return false


func fly_strike(side: String, craft: Token, kind: String, target: Token) -> String:
	var ready := _craft_ready(side, craft)
	if ready != "":
		return _air_note(side, ready)
	if target == null:
		return _air_note(side, "Click a target. The range was not recovered.")
	if kind == "sea":
		if target.domain != "sea":
			return _air_note(side, "Click a sea piece. The range was not recovered.")
	elif target.domain == "sea":
		return _air_note(side, "Click a land piece. The range was not recovered.")
	_start_mission(craft, kind, 8)
	var named := _piece_name(target)
	var title := "Sea strike" if kind == "sea" else "Land strike"
	return _air_note(side, "%s on %s. The damage was not recovered. The range was not recovered. Inactive for 8 rounds." % [title, named])


func fly_bomb(side: String, craft: Token, title: String, lock_key: String, occupied: bool) -> String:
	var ready := _craft_ready(side, craft)
	if ready != "":
		return _air_note(side, ready)
	if lock_key == "":
		return _air_note(side, "Not a city, base, or oil site.")
	if occupied:
		return _air_note(side, "That site is not empty.")
	_start_mission(craft, "bomb", 8)
	build_lock[lock_key] = 5
	return _air_note(side, "Bombed %s. Building is locked for 5 rounds. The amount taken was not recovered. The range was not recovered. Inactive for 8 rounds." % title)


func scramble(side: String, craft: Token) -> String:
	var ready := _craft_ready(side, craft)
	if ready != "":
		return _air_note(side, ready)
	if not enemy_mission(side):
		return _air_note(side, "No enemy mission. The range was not recovered.")
	_start_mission(craft, "scramble", 4)
	return _air_note(side, "Scramble answers the enemy mission. Inactive for 4 rounds. The range was not recovered.")


## Infantry can paradrop. Tanks cannot. The strength cost was not recovered.
## No range is applied. A carrier's aircraft are refused.
func paradrop(unit: Token, x: int = -1, y: int = -1) -> String:
	if unit != null and unit.label == "Carrier":
		return "Carrier aircraft cannot paradrop."
	if unit != null and unit.label == "Tanks":
		return "Tanks cannot paradrop."
	if unit == null or unit.label != "Infantry" or unit.domain != "land":
		return "Only infantry can paradrop."
	if winner() != "":
		return "The match is over."
	if not air_open():
		return "Paradrop is not in this era."
	if planes_grounded():
		return "Planes are grounded."
	if x < 0 or y < 0 or not _drop_land(x, y):
		return _air_note(unit.side, "Click a land cell. The strength cost was not recovered.")
	x = posmod(x, TerrainMap.CELL_W)
	if posmod(unit.x, TerrainMap.CELL_W) == x and unit.y == y:
		return _air_note(unit.side, "Click a land cell. The strength cost was not recovered.")
	if _land_at(x, y, unit) != null:
		return _air_note(unit.side, "Two units cannot stop on the same cell.")
	unit.x = x
	unit.y = y
	unit.path = []
	unit.debt = 0
	unit.pinned = false
	unit.transporting = false
	unit.entrenched = false
	var site: Variant = sites.at_cell(unit.x, unit.y) if sites != null else null
	if site is Dictionary and str(site.get("owner", "")) != unit.side:
		site["owner"] = unit.side
	return _air_note(unit.side, "Infantry paradropped. The strength cost was not recovered.")


func _drop_land(x: int, y: int) -> bool:
	if terrain == null or y < 0 or y >= TerrainMap.CELL_H:
		return false
	var word := TerrainMap.pace_word(terrain.id_at(posmod(x, TerrainMap.CELL_W), y))
	return word == "open" or word == "slow"


func _craft_ready(side: String, craft: Token) -> String:
	if winner() != "":
		return "The match is over."
	if not air_open():
		return "Aircraft are not in this era."
	if planes_grounded():
		return "Planes are grounded."
	if craft == null or craft.side != side or craft.label != "Aircraft":
		return "Only an aircraft can fly a mission."
	if craft.idle_rounds > 0:
		return "Aircraft is inactive for %d rounds." % craft.idle_rounds
	return ""


func _start_mission(craft: Token, kind: String, rounds: int) -> void:
	craft.path = []
	craft.debt = 0
	craft.pinned = false
	craft.mission_kind = kind
	craft.idle_rounds = rounds


func _air_note(side: String, line: String) -> String:
	if line != "" and side == player_side:
		note = line
	return line


func _piece_name(unit: Token) -> String:
	if unit.label != "":
		return "%s %s" % [_label(unit.side), unit.label]
	var kind := "sea piece" if unit.domain == "sea" else "land piece"
	return "%s %s" % [_label(unit.side), kind]


func _idle_block(unit: Token) -> String:
	if unit != null and unit.label == "Aircraft" and unit.idle_rounds > 0:
		return "Aircraft is inactive for %d rounds." % unit.idle_rounds
	return ""


func _cool_missions() -> void:
	for unit in tokens:
		if unit.idle_rounds <= 0:
			continue
		unit.idle_rounds -= 1
		if unit.idle_rounds <= 0:
			unit.mission_kind = ""
	var drop: Array = []
	for key in build_lock.keys():
		build_lock[key] = int(build_lock[key]) - 1
		if int(build_lock[key]) <= 0:
			drop.append(key)
	for key in drop:
		build_lock.erase(key)


## Empty string when the order is kept. A message when it is refused.
## A sea piece calls ship_route. A land piece on the water forms a transport and calls it too.
## Any other land order keeps terrain.route.
## A step onto an enemy land piece is contact. Damage amounts are unknown, so the piece stops short.
func order(side: String, x: int, y: int) -> String:
	var chosen := ordered_unit(side)
	var idle := _idle_block(chosen)
	if idle != "":
		return idle
	if chosen != null and chosen.domain == "sea":
		return _order_sea(chosen, x, y)
	if winner() != "":
		return ""
	if shortage():
		return _held_line()
	var unit: Token = chosen if chosen != null and chosen.domain == "land" else token(side)
	if unit == null:
		return ""
	if unit.x == x and unit.y == y:
		unit.path = []
		unit.debt = 0
		unit.pinned = false
		unit.transporting = false
		return ""
	var sailed: Variant = formed_transport_route(unit, x, y)
	if sailed is Array:
		var aboard: Array = sailed
		unit.path = aboard
		unit.debt = int(aboard[0]["pace"])
		unit.pinned = false
		unit.transporting = true
		var lost_sea := unit.entrenched
		unit.entrenched = false
		if side == player_side:
			note = "%s formed a transport (%d cells)" % [_label(side), aboard.size()]
			if lost_sea:
				note += " Entrench is lost."
		return ""
	# A hidden opponent is not a known blocker. Contact still stops the step.
	var conceal := side == player_side and opponent_hidden()
	var blocked := func(nx: int, ny: int) -> bool:
		if conceal:
			return false
		return _enemy_land(side, nx, ny) != null
	var path: Variant = terrain.route(unit.x, unit.y, x, y, blocked)
	var contact := false
	if not conceal and path is Array and not (path as Array).is_empty() and _enemy_land(side, int((path as Array)[0]["x"]), int((path as Array)[0]["y"])) != null:
		path = null
		contact = true
	# A tank ordered onto infantry is an overrun. The step still stops short of the cell.
	if not conceal and unit.label == "Tanks":
		var stood := _enemy_land(side, x, y)
		if stood != null and stood.label == "Infantry":
			path = null
			contact = true
	if (path == null or (path is Array and (path as Array).is_empty())) and blocked.call(x, y):
		contact = true
		var best: Variant = null
		var ax := posmod(unit.x, TerrainMap.CELL_W)
		for step in TerrainMap.STEPS:
			var nx := posmod(x + int(step.x), TerrainMap.CELL_W)
			var ny := y + int(step.y)
			if ny < 0 or ny >= TerrainMap.CELL_H:
				continue
			if nx == ax and ny == unit.y:
				best = []
				break
			if blocked.call(nx, ny):
				continue
			if TerrainMap.land_pace(terrain.id_at(nx, ny)) < 0:
				continue
			var trial: Variant = terrain.route(unit.x, unit.y, nx, ny, blocked)
			if trial is Array and not (trial as Array).is_empty():
				if best == null or (trial as Array).size() < (best as Array).size():
					best = trial
		path = best
	if contact and (path == null or (path is Array and (path as Array).is_empty())):
		var stopped := _stop_line(unit, x, y)
		unit.path = []
		unit.debt = 0
		unit.transporting = false
		if unit.domain != "sea":
			unit.pinned = true
		if side == player_side:
			note = stopped
		return stopped
	if path == null or not path is Array or (path as Array).is_empty():
		return "No route. Ocean is crossed as a transport; wasteland is refused."
	var steps: Array = path
	# The clicked cell is the end of the path. A friendly already there is a stop.
	if not contact and _same_side_land(unit, x, y):
		var refused := "Two units cannot stop on the same cell."
		if side == player_side:
			note = refused
		return refused
	unit.path = steps
	unit.debt = int(steps[0]["pace"])
	unit.pinned = false
	unit.transporting = false
	var lost_entrench := unit.entrenched
	unit.entrenched = false
	var seen := {}
	var via := PackedStringArray()
	for step in steps:
		var word := str(step["word"])
		if word == "open" or seen.has(word):
			continue
		seen[word] = true
		via.append(word)
	var moving := "%s moving (%d cells)" % [_label(side), steps.size()]
	if via.size() > 0:
		moving = "%s moving (%d cells, %s)" % [_label(side), steps.size(), ", ".join(via)]
	if contact:
		var stopped_note := _stop_line(unit, x, y)
		if side == player_side:
			note = stopped_note
		return stopped_note
	if lost_entrench:
		moving += " Entrench is lost."
	if side == player_side:
		note = moving
	return ""


func _order_sea(unit: Token, x: int, y: int) -> String:
	if winner() != "":
		return ""
	if shortage():
		return _held_line()
	if unit.x == x and unit.y == y:
		unit.path = []
		unit.debt = 0
		unit.pinned = false
		return ""
	var path: Variant = ship_route(unit.x, unit.y, x, y, unit.ship_class)
	if path == null or not path is Array or (path as Array).is_empty():
		return "No route."
	var steps: Array = path
	unit.path = steps
	unit.debt = int(steps[0]["pace"])
	unit.pinned = false
	if unit.side == player_side:
		note = "%s sailing (%d cells)" % [_label(unit.side), steps.size()]
	return ""


func tick() -> Array:
	if winner() != "":
		_watch_contacts()
		return []
	_apply_oil_stand_in()
	_hold_satellites()
	beat += 1
	round += 1
	_cool_missions()
	var lines: Array = []
	_pay_cities()
	_say_income(lines)
	if shortage():
		_claim_oil(lines)
		_say_combat(lines)
		_watch_contacts()
		return lines
	for unit in tokens:
		var line := _advance(unit)
		if line != "":
			lines.append(line)
	_claim_oil(lines)
	var won := winner()
	if won != "":
		note = "%s holds every capital" % _label(won)
		lines.append(note)
		_toast("%s wins" % _label(won))
		for unit in tokens:
			unit.path = []
			unit.debt = 0
		_watch_contacts()
		return lines
	var opponent := "red" if player_side == "blue" else "blue"
	var mine := token(player_side)
	var opp := token(opponent)
	if opp != null and mine != null and opp.path.is_empty():
		var cap: Dictionary = sites.capital(player_side)
		var key := "%d,%d,%s" % [mine.x, mine.y, str(cap["owner"])]
		if _red_key != key:
			var refused := order(opponent, int(cap["x"]), int(cap["y"]))
			_red_key = key if refused != "" else ""
			if refused != "" and not lines.has(refused) and not opponent_hidden():
				lines.append(refused)
	_order_idle_ship(opponent)
	_order_capital_return(opponent)
	_say_threat()
	_say_combat(lines)
	_watch_contacts()
	return lines


## The opponent draws three steps. The ordered side draws the whole path.
static func visible_steps(path: Array, side: String, player: String = "blue") -> Array:
	if path.is_empty():
		return []
	if side != player:
		return path.slice(0, mini(3, path.size()))
	return path


## A submarine with no path is still. Intel clears the hide. A scan does not.
func submarine_still(unit: Token) -> bool:
	return unit != null and unit.label == "Submarine" and unit.path.is_empty()


func submarine_hidden(unit: Token) -> bool:
	return submarine_still(unit) and not unit.revealed


## Era 9999 draws the ordered side only, until their opponent's capital is found.
## An enemy submarine that is still stays hidden until intel.
func shows_piece(unit: Token) -> bool:
	if unit == null:
		return false
	if unit.side != player_side and submarine_hidden(unit):
		return false
	if unit.side == player_side:
		return true
	if opponent_hidden():
		return false
	if unit.revealed:
		return true
	# Finding the concealed capital lifts that fog. Ordinary eras use the stand-in range.
	if era_year >= 9999:
		return true
	return _near_friend(unit)


func _near_friend(unit: Token) -> bool:
	for friend in tokens:
		if friend.side != player_side:
			continue
		var dx := absi(_wrap_delta(friend.x, unit.x))
		var dy := absi(friend.y - unit.y)
		if maxi(dx, dy) <= sight_cells:
			return true
	return false


func opponent_hidden() -> bool:
	if era_year < 9999 or winner() != "":
		return false
	_mark_capital_found()
	return not _capital_found


func _mark_capital_found() -> void:
	if _capital_found or sites == null:
		return
	var opp := "red" if player_side == "blue" else "blue"
	var cap: Variant = sites.capital(opp)
	if not cap is Dictionary:
		return
	if str(cap["owner"]) == player_side:
		_capital_found = true
		return
	var cx := int(cap["x"])
	var cy := int(cap["y"])
	for unit in tokens:
		if unit.side != player_side:
			continue
		if posmod(unit.x, TerrainMap.CELL_W) == posmod(cx, TerrainMap.CELL_W) and unit.y == cy:
			_capital_found = true
			return


func _public_line(side: String, line: String) -> String:
	if line == "" or (side != player_side and opponent_hidden()):
		return ""
	note = line
	if line.contains("took "):
		_toast("City taken")
	elif line.contains("stopped short"):
		_toast("Contact")
	return line


func _advance(unit: Token) -> String:
	if unit.path.is_empty():
		return ""
	if unit.idle_rounds > 0:
		return ""
	if held(unit):
		return ""
	var next: Dictionary = unit.path[0]
	var nx := int(next["x"])
	var ny := int(next["y"])
	if unit.domain == "sea":
		var other := token("red" if unit.side == "blue" else "blue")
		if other != null and other.x == nx and other.y == ny:
			unit.path = []
			unit.debt = 0
			return _public_line(unit.side, "%s stopped short — damage amounts unknown" % _label(unit.side))
	else:
		var occ := _land_at(nx, ny, unit)
		if occ != null and occ.side != unit.side:
			# An enemy is contact. Damage amounts are unknown, so the piece stops short.
			unit.path = []
			unit.debt = 0
			unit.pinned = true
			return _public_line(unit.side, _stop_line(unit, nx, ny))
		# A friendly cell can be crossed. The last step would stop on it, so it is refused.
		if occ != null and unit.path.size() <= 1:
			unit.path = []
			unit.debt = 0
			return _public_line(unit.side, "Two units cannot stop on the same cell.")
	unit.debt -= 1
	if unit.debt > 0:
		return ""
	if unit.domain != "sea":
		unit.facing = Vector2i(_wrap_delta(unit.x, nx), ny - unit.y)
	unit.x = nx
	unit.y = ny
	unit.path.pop_front()
	unit.debt = int(unit.path[0]["pace"]) if not unit.path.is_empty() else 0
	var site: Variant = sites.at_cell(unit.x, unit.y)
	if site is Dictionary and str(site["owner"]) != unit.side:
		site["owner"] = unit.side
		var line := "%s took %s" % [_label(unit.side), str(site["title"])]
		if winner() != "":
			line = "%s and holds every capital" % line
		return _public_line(unit.side, line)
	return ""


func _land_at(x: int, y: int, skip: Token = null) -> Token:
	var wx := posmod(x, TerrainMap.CELL_W)
	for unit in tokens:
		if unit == skip or unit.domain == "sea":
			continue
		if posmod(unit.x, TerrainMap.CELL_W) == wx and unit.y == y:
			return unit
	return null


## A tank meeting infantry is an overrun. The wording stays blank of any damage figure.
func _stop_line(unit: Token, x: int, y: int) -> String:
	var foe := _enemy_land(unit.side, x, y)
	if unit != null and unit.label == "Tanks" and foe != null and foe.label == "Infantry":
		return "Overrun. %s stopped short — damage amounts unknown" % _label(unit.side)
	return "%s stopped short — damage amounts unknown" % _label(unit.side)


func _enemy_land(side: String, x: int, y: int) -> Token:
	var found := _land_at(x, y)
	if found != null and found.side != side:
		return found
	return null


func _same_side_land(unit: Token, x: int, y: int) -> bool:
	var found := _land_at(x, y, unit)
	return found != null and found.side == unit.side


## Oil binds in 1986, 2023, and the concealed start. 1918 and 1942 ignore the flag.
func shortage() -> bool:
	return oil_short and Roster.tool_open(era_year, "oil")


func planes_grounded() -> bool:
	return shortage()


func income_line(side: String) -> String:
	if shortage():
		return "City income is stopped."
	if _owned_cities(side) <= 0:
		return "No city income."
	return "City income is %d." % city_income(side)


## The tank relation is a ratio. The price column itself stays empty.
func price_line() -> String:
	return "Stand-in prices. A tank costs twice an infantry unit. A nuke is %d billion." % Assumptions.PRICE_NUKE


func price_rows() -> Array:
	return [
		{"name": "Infantry", "cost": ""},
		{"name": "Tank", "cost": "", "relation": "twice an infantry unit"},
		{"name": "Nuke", "cost": ""},
	]


## Sea units are never held. A land pin lasts until the fight ends or a new move order.
func held(unit: Token) -> bool:
	if unit == null or unit.domain == "sea":
		return false
	return unit.pinned


## Front, flank, or rear. No damage figure. Sea is not flanked.
func approach_word(defender: Token, attacker: Token) -> String:
	if defender == null or attacker == null or defender.domain == "sea":
		return "not flanked"
	var dx := _wrap_delta(defender.x, attacker.x)
	var dy := attacker.y - defender.y
	if dx == 0 and dy == 0:
		return "front"
	var fx := defender.facing.x
	var fy := defender.facing.y
	if dx == fx and dy == fy:
		return "front"
	if dx == -fx and dy == -fy:
		return "rear"
	return "flank"


## One enemy every other round. The amount stays unknown.
func combat_pulse() -> String:
	var blue := token("blue")
	var red := token("red")
	if blue == null or red == null or not _land_overlap(blue, red):
		_clear_fight()
		return ""
	if not fight_on:
		fight_shots = 0
	fight_on = true
	fight_rounds += 1
	var quiet := fight_rounds % 2 == 0
	var bits := PackedStringArray()
	if _take_aim("blue") or _take_aim("red"):
		bits.append("Retargeted.")
	if quiet:
		shot_takes = ""
		combat_note = "Retargeted. No shot this round." if bits.size() > 0 else "No shot this round."
		return combat_note
	shot_takes = "piece"
	var hit := _hit_word(blue, red)
	if hit != "":
		bits.append(hit)
	if support_blue > 0 or support_red > 0:
		bits.append("A second friendly deals damage and takes none.")
	bits.append("Damage amount unknown.")
	combat_note = " ".join(bits)
	fight_shots += 1
	if fight_shots > fight_peak:
		fight_peak = fight_shots
	if fight_shots >= Assumptions.HITS:
		var defender: Token = red if player_side == "blue" else blue
		if defender != null and tokens.has(defender):
			tokens.erase(defender)
			fight_gone = true
			_toast("Defender removed")
			_clear_fight()
			combat_note = "Damage amount unknown."
	return combat_note


func _hit_word(a: Token, b: Token) -> String:
	var left := approach_word(b, a)
	var right := approach_word(a, b)
	if left == "rear" or right == "rear":
		return "Rear hurts more."
	if left == "flank" or right == "flank":
		return "Flank hurts more."
	if left == "not flanked" or right == "not flanked":
		return "Not flanked. Not pinned."
	return "Front."


func _take_aim(side: String) -> bool:
	var unit := token(side)
	var other := token("red" if side == "blue" else "blue")
	if unit == null or other == null:
		return false
	var best := Vector2i(other.x, other.y)
	var best_d := _dist2(unit.x, unit.y, best.x, best.y)
	var extra_on := extra_blue_on if side == "blue" else extra_red_on
	var extra: Vector2i = extra_blue if side == "blue" else extra_red
	if extra_on:
		var d := _dist2(unit.x, unit.y, extra.x, extra.y)
		if d < best_d:
			best = extra
	var prev := aim_blue if side == "blue" else aim_red
	var changed := prev.x != -999 and prev != best
	if side == "blue":
		aim_blue = best
	else:
		aim_red = best
	return changed


func _clear_fight() -> void:
	fight_on = false
	fight_rounds = 0
	fight_shots = 0
	combat_note = ""
	_combat_said = ""
	shot_takes = ""
	aim_blue = Vector2i(-999, -999)
	aim_red = Vector2i(-999, -999)
	for unit in tokens:
		if unit.domain != "sea":
			unit.pinned = false


func city_income(side: String) -> int:
	return _owned_cities(side) * Assumptions.CITY_PAY


func oil_income(side: String) -> int:
	return _owned_wells(side) * Assumptions.WELL_PAY


## Every PAY_EVERY tick, the current city level and well level join the pool.
## A shortage pays neither. The winning tick still pays. Later ticks do not.
func _pay_cities() -> void:
	if shortage():
		return
	if beat % Assumptions.PAY_EVERY != 0:
		return
	_deposit("blue")
	_deposit("red")


func _deposit(side: String) -> void:
	var cities := city_income(side)
	var wells := oil_income(side)
	if side == "blue":
		income_blue += cities
		oil_income_blue += wells
		cash_blue += cities + wells
	else:
		income_red += cities
		oil_income_red += wells
		cash_red += cities + wells
	if side == player_side:
		cash_billions = _pool_of(side)


func _owned_wells(side: String) -> int:
	var n := 0
	for key in oil_owner.keys():
		if str(oil_owner[key]) == side:
			n += 1
	return n


func _owned_cities(side: String) -> int:
	if sites == null:
		return 0
	var n := 0
	for place in sites.places:
		if str(place.get("kind", "")) == "city" and str(place.get("owner", "")) == side:
			n += 1
	return n


func _say_income(lines: Array) -> void:
	var said := income_line("blue")
	if said == _income_said:
		return
	_income_said = said
	lines.append(said)


func _say_combat(lines: Array) -> void:
	var said := combat_pulse()
	if said == "" or said == _combat_said or opponent_hidden():
		return
	_combat_said = said
	lines.append(said)


func _held_line() -> String:
	return "Oil shortage. Movement is stopped. Planes are grounded. City income is stopped."


func _land_overlap(a: Token, b: Token) -> bool:
	var dx := absi(_wrap_delta(a.x, b.x))
	var dy := absi(a.y - b.y)
	return dx <= 1 and dy <= 1


func _wrap_delta(from: int, to: int) -> int:
	var d := to - from
	var w := TerrainMap.CELL_W
	if d > w / 2:
		d -= w
	elif d < -(w / 2):
		d += w
	return d


func _dist2(x0: int, y0: int, x1: int, y1: int) -> int:
	var dx := _wrap_delta(x0, x1)
	var dy := y1 - y0
	return dx * dx + dy * dy


## Binary strings: "Must be placed in city", "Must be placed on dock", "Not enough money."
## RULES.md: land and aircraft at a friendly city or base, ships at a dock.
## A nuke is 10 billion. Starting money was not recovered, so the nuke is refused.
## Other prices stay unknown and are not charged.
## During the match a blank price still places the unit. The city becomes unready.
## How long it stays unready was not recovered, so no duration is stored.
func place_purchase(side: String, kind: String, x: int, y: int, in_match: bool = false) -> String:
	var row: Dictionary = {}
	for item in Roster.buy_rows(era_year):
		if str(item["name"]) == kind:
			row = item
			break
	if row.is_empty():
		return "%s is not in this era" % kind
	if str(row["domain"]) == "tool" or _pool_of(side) < _kind_price(kind):
		return "Not enough money."
	x = posmod(x, TerrainMap.CELL_W)
	if str(row["domain"]) == "sea":
		if terrain == null or terrain.id_at(x, y) != 1 or not _dock_of(side, x, y):
			return "Must be placed on dock"
	elif not _city_of(side, x, y):
		return "Must be placed in city"
	var producer := _producer(side, x, y, str(row["domain"]))
	if in_match and not producer.is_empty() and unready_ids.has(int(producer["id"])):
		return "This city is unready. The time was not recovered."
	if not producer.is_empty():
		var locked := build_left("site:%d" % int(producer["id"]))
		if locked > 0:
			return "Building is locked for %d rounds. The amount taken was not recovered." % locked
	if _occupied(x, y):
		return "Two units cannot stop on the same cell."
	var unit := _make_sea(side, x, y) if str(row["domain"]) == "sea" else _make(side, x, y)
	unit.label = kind
	tokens.append(unit)
	var cost := _kind_price(kind)
	if in_match:
		_take_pool(side, cost)
	if in_match and not producer.is_empty():
		unready_ids[int(producer["id"])] = true
	note = "Placed. Stand-in price: %d billion." % cost
	if kind == "Tanks":
		note += " A tank costs twice an infantry."
	if in_match:
		note += " This city is unready. The time was not recovered."
	if kind == "Submarine":
		note += " A still submarine stays hidden."
	if repairing(unit):
		note += " Repairing. Strength has no number."
	return ""


## A Vector2i has no country, so it starts unowned.
## A dictionary may carry name, region, x, and y. Region is matched to the site country list.
func set_oil_cells(cells: Array) -> void:
	oil_listed = []
	_oil_home = {}
	_oil_name = {}
	for item in cells:
		var x := -1
		var y := -1
		var well_name := "Oil well"
		var region := ""
		if item is Vector2i:
			var at: Vector2i = item
			x = at.x
			y = at.y
		elif item is Dictionary:
			var field: Dictionary = item
			x = int(field.get("x", field.get("map_x", -1)))
			y = int(field.get("y", field.get("map_y", -1)))
			well_name = str(field.get("name", "Oil well"))
			region = str(field.get("region", ""))
		else:
			continue
		if well_name == "":
			well_name = "Oil well"
		var key := _oil_key(x, y)
		oil_listed.append(Vector2i(x, y))
		_oil_home[key] = _home_for_region(region)
		_oil_name[key] = well_name
	_place_oil()


func oil_owner_at(x: int, y: int) -> String:
	return str(oil_owner.get(_oil_key(x, y), ""))


func _oil_owner_rows() -> Array:
	var rows: Array = []
	for key in oil_owner.keys():
		var parts := str(key).split(",")
		if parts.size() != 2:
			continue
		rows.append({"x": int(parts[0]), "y": int(parts[1]), "owner": str(oil_owner[key])})
	return rows


func _place_oil() -> void:
	if era_year == 2023:
		oil_cells = Assumptions.shuffle_points(oil_listed, Assumptions.SHUFFLE_SEED + 1)
	else:
		oil_cells = oil_listed.duplicate()
	oil_owner = _oil_home.duplicate()


## The oil file says Russia. The site list calls that side USSR.
## Any other country keeps its name until a side lands a unit.
func _home_for_region(region: String) -> String:
	var region_name := region.strip_edges()
	if region_name == "Russia":
		region_name = "USSR"
	if region_name == "":
		return "neutral"
	if country_names.is_empty():
		return region_name
	for i in country_names.size():
		if str(country_names[i]) != region_name:
			continue
		if i == 0:
			return "blue"
		if i == 1:
			return "red"
		return region_name
	return region_name


func _oil_key(x: int, y: int) -> String:
	return "%d,%d" % [posmod(x, TerrainMap.CELL_W), y]


## A unit standing on a well takes it. The rate stays unknown.
func _claim_oil(lines: Array) -> void:
	for unit in tokens:
		var key := _oil_key(unit.x, unit.y)
		if not oil_owner.has(key) or str(oil_owner[key]) == unit.side:
			continue
		oil_owner[key] = unit.side
		if unit.side != player_side and opponent_hidden():
			continue
		var line := "%s captured %s." % [_label(unit.side), str(_oil_name.get(key, "Oil well"))]
		if unit.side == player_side:
			note = line
		_toast("Oil taken")
		lines.append(line)


func _apply_oil_stand_in() -> void:
	if not Roster.tool_open(era_year, "oil"):
		return
	if _side_on_oil(player_side):
		oil_reserve = Assumptions.OIL_RESERVE
		oil_short = false
		return
	if oil_reserve > 0:
		oil_reserve -= Assumptions.OIL_BURN
	if oil_reserve <= 0:
		var began := not oil_short
		oil_short = true
		if began:
			note = _held_line()
			_toast("Oil short")


func _side_on_oil(side: String) -> bool:
	for unit in tokens:
		if unit.side == side and _oil_cell(unit.x, unit.y):
			return true
	return false


## A land piece on a friendly city, base, or oilfield, and a ship on that dock.
## Strength is not stored, so the mark carries no amount.
func repairing(unit: Token) -> bool:
	if unit == null:
		return false
	if unit.domain == "sea":
		return _ship_repairs(unit)
	return _land_repairs(unit)


func _land_repairs(unit: Token) -> bool:
	var site := _site_at(unit.x, unit.y)
	if not site.is_empty():
		var kind := str(site.get("kind", ""))
		var owner := str(site.get("owner", ""))
		if (kind == "city" or kind == "base") and owner == unit.side:
			return true
		if owner != "" and owner != unit.side and owner != "neutral":
			return false
	if terrain != null:
		var tid := terrain.id_at(unit.x, unit.y)
		if tid == 5 or tid == 7:
			return true
	return _oil_cell(unit.x, unit.y)


func _ship_repairs(unit: Token) -> bool:
	if terrain == null or terrain.id_at(unit.x, unit.y) != 1:
		return false
	return _beside_repair_ground(unit.side, unit.x, unit.y)


func _beside_repair_ground(side: String, x: int, y: int) -> bool:
	for dy in range(-1, 2):
		for dx in range(-1, 2):
			if dx == 0 and dy == 0:
				continue
			var ny := y + dy
			if ny < 0 or ny >= TerrainMap.CELL_H:
				continue
			var nx := posmod(x + dx, TerrainMap.CELL_W)
			var site := _site_at(nx, ny)
			if not site.is_empty():
				var kind := str(site.get("kind", ""))
				if (kind == "city" or kind == "base") and str(site.get("owner", "")) == side:
					return true
				continue
			if terrain != null:
				var tid := terrain.id_at(nx, ny)
				if tid == 5 or tid == 7:
					return true
			if _oil_cell(nx, ny):
				return true
	return false


func _oil_cell(x: int, y: int) -> bool:
	var wx := posmod(x, TerrainMap.CELL_W)
	for cell in oil_cells:
		if cell is Vector2i and (cell as Vector2i).x == wx and (cell as Vector2i).y == y:
			return true
	return false


func _site_at(x: int, y: int) -> Dictionary:
	if sites == null:
		return {}
	var site: Variant = sites.at_cell(x, y)
	if site is Dictionary:
		return site
	return {}


func city_unready(site_id: int) -> bool:
	return unready_ids.has(site_id)


func _producer(side: String, x: int, y: int, domain: String) -> Dictionary:
	if domain == "sea":
		for dy in range(-1, 2):
			for dx in range(-1, 2):
				if dx == 0 and dy == 0:
					continue
				var ny := y + dy
				if ny < 0 or ny >= TerrainMap.CELL_H:
					continue
				var beside := _owned_city(side, posmod(x + dx, TerrainMap.CELL_W), ny)
				if not beside.is_empty():
					return beside
		return {}
	return _owned_city(side, x, y)


func _owned_city(side: String, x: int, y: int) -> Dictionary:
	if sites == null:
		return {}
	var site: Variant = sites.at_cell(x, y)
	if not site is Dictionary:
		return {}
	if str(site.get("owner", "")) != side:
		return {}
	var kind := str(site.get("kind", ""))
	if kind != "city" and kind != "capital" and kind != "base":
		return {}
	return site


func _city_of(side: String, x: int, y: int) -> bool:
	if sites == null:
		return false
	var site: Variant = sites.at_cell(x, y)
	if not site is Dictionary:
		return false
	if str(site.get("owner", "")) != side:
		return false
	var kind := str(site.get("kind", ""))
	return kind == "city" or kind == "capital" or kind == "base"


func _dock_of(side: String, x: int, y: int) -> bool:
	for dy in range(-1, 2):
		for dx in range(-1, 2):
			if dx == 0 and dy == 0:
				continue
			var ny := y + dy
			if ny < 0 or ny >= TerrainMap.CELL_H:
				continue
			if _city_of(side, posmod(x + dx, TerrainMap.CELL_W), ny):
				return true
	return false


func _occupied(x: int, y: int) -> bool:
	for unit in tokens:
		if posmod(unit.x, TerrainMap.CELL_W) == x and unit.y == y:
			return true
	return false


func _make(side: String, x: int, y: int) -> Token:
	var unit := Token.new()
	unit.side = side
	unit.x = x
	unit.y = y
	unit.domain = "land"
	return unit


func _make_sea(side: String, x: int, y: int) -> Token:
	var unit := _make(side, x, y)
	unit.domain = "sea"
	unit.ship_class = 0
	return unit


func piece_state(unit: Token) -> String:
	if unit == null:
		return "idle"
	if unit.idle_rounds > 0:
		return "inactive"
	if unit.entrenched:
		return "digging"
	if repairing(unit):
		return "repairing"
	if not unit.path.is_empty():
		return "moving"
	return "idle"


func _kind_price(kind: String) -> int:
	match kind:
		"Infantry":
			return Assumptions.PRICE_INFANTRY
		"Tanks":
			return Assumptions.PRICE_TANK
		"Cruiser", "Transport", "Carrier":
			return Assumptions.PRICE_SHIP
		"Submarine":
			return Assumptions.PRICE_SUB
		"Aircraft":
			return Assumptions.PRICE_AIR
		"Nuke":
			return Assumptions.PRICE_NUKE
		_:
			return 0


func _pool_of(side: String) -> int:
	return cash_blue if side == "blue" else cash_red


func _take_pool(side: String, cost: int) -> void:
	if side == "blue":
		cash_blue -= cost
	else:
		cash_red -= cost
	if side == player_side:
		cash_billions = _pool_of(side)


func _toast(text: String) -> void:
	if text == "":
		return
	toasts.append(text)
	if toasts.size() > 6:
		toasts.pop_front()


func _flash_at(x: int, y: int, kind: String) -> void:
	flash_cell = Vector2i(x, y)
	flash_kind = kind


func _repaint_sites() -> void:
	if terrain == null or sites == null:
		paint_mode = ""
		return
	paint_mode = terrain.paint_matched(sites.places)


func _order_idle_ship(side: String) -> void:
	var ship := sea_token(side)
	if ship == null:
		return
	if not ship.path.is_empty():
		_ship_idle[side] = false
		return
	if bool(_ship_idle.get(side, false)):
		return
	# One try per idle spell. A failed search must not run again every tick.
	_ship_idle[side] = true
	var dock := _dock_beside_capital(player_side, ship)
	if dock.x < 0:
		return
	var saved_focus = focus
	var saved_side := selected_side
	var saved_domain := selected_domain
	focus = ship
	selected_side = side
	selected_domain = "sea"
	_order_sea(ship, dock.x, dock.y)
	focus = saved_focus
	selected_side = saved_side
	selected_domain = saved_domain


func _order_capital_return(side: String) -> void:
	if sites == null:
		return
	var cap: Dictionary = sites.capital(side)
	var home := _land_at(int(cap["x"]), int(cap["y"]))
	if home != null:
		return
	var primary := token(side)
	for unit in tokens:
		if unit.side != side or unit.domain == "sea" or unit == primary:
			continue
		if not unit.path.is_empty() or held(unit):
			continue
		var saved_focus = focus
		var saved_side := selected_side
		var saved_domain := selected_domain
		focus = unit
		selected_side = side
		selected_domain = "land"
		order(side, int(cap["x"]), int(cap["y"]))
		focus = saved_focus
		selected_side = saved_side
		selected_domain = saved_domain
		return


## A dock next to the capital when the ship can sail there.
## Capitals sit inland, so the fallback is the nearest dock the ship can reach.
func _dock_beside_capital(side: String, ship: Token) -> Vector2i:
	if sites == null or terrain == null or ship == null:
		return Vector2i(-1, -1)
	var cap: Dictionary = sites.capital(side)
	var cx := int(cap["x"])
	var cy := int(cap["y"])
	var adjacent := Vector2i(-1, -1)
	var docks: Array[Vector2i] = []
	for y in TerrainMap.CELL_H:
		for x in TerrainMap.CELL_W:
			if terrain.id_at(x, y) != 1 or _occupied(x, y):
				continue
			var at := Vector2i(x, y)
			docks.append(at)
			if adjacent.x < 0 and maxi(absi(_wrap_delta(cx, x)), absi(cy - y)) <= 1:
				adjacent = at
	if adjacent.x >= 0 and _ship_can_reach(ship, adjacent):
		return adjacent
	docks.sort_custom(func(a: Vector2i, b: Vector2i) -> bool:
		var da := maxi(absi(_wrap_delta(cx, a.x)), absi(cy - a.y))
		var db := maxi(absi(_wrap_delta(cx, b.x)), absi(cy - b.y))
		if da == db:
			return a.y < b.y or (a.y == b.y and a.x < b.x)
		return da < db
	)
	for at in docks:
		if _ship_can_reach(ship, at):
			return at
	return Vector2i(-1, -1)


func _ship_can_reach(ship: Token, at: Vector2i) -> bool:
	var path: Variant = ship_route(ship.x, ship.y, at.x, at.y, ship.ship_class)
	return path is Array and not (path as Array).is_empty()


func _say_threat() -> void:
	if sites == null or _threat_said:
		return
	var cap: Dictionary = sites.capital(player_side)
	if str(cap.get("owner", "")) != player_side:
		return
	var cx := int(cap["x"])
	var cy := int(cap["y"])
	for unit in tokens:
		if unit.side == player_side or unit.domain == "sea":
			continue
		var dx := absi(_wrap_delta(unit.x, cx))
		var dy := absi(unit.y - cy)
		if maxi(dx, dy) <= 1:
			_threat_said = true
			_toast("Capital threatened")
			return


func _watch_contacts() -> void:
	var live: Array = []
	for mark in contacts:
		var life := int(mark.get("life", 0)) - 1
		if life > 0:
			mark["life"] = life
			live.append(mark)
	contacts = live
	for unit in tokens:
		if unit.side == player_side:
			continue
		if shows_piece(unit):
			unit.was_shown = true
			unit.seen_x = unit.x
			unit.seen_y = unit.y
			continue
		if not unit.was_shown:
			continue
		contacts.append({"x": unit.seen_x, "y": unit.seen_y, "life": Assumptions.CONTACT_ROUNDS})
		unit.was_shown = false


func save_match(path: String) -> String:
	var pieces: Array = []
	for unit in tokens:
		pieces.append({
			"side": unit.side,
			"domain": unit.domain,
			"x": unit.x,
			"y": unit.y,
			"label": unit.label,
			"ship_class": unit.ship_class,
			"pinned": unit.pinned,
			"revealed": unit.revealed,
			"entrenched": unit.entrenched,
			"idle_rounds": unit.idle_rounds,
		})
	var owners: Array = []
	if sites != null:
		for place in sites.places:
			owners.append({"id": int(place["id"]), "owner": str(place["owner"])})
	var payload := {
		"era": era_year,
		"side": player_side,
		"turn": round,
		"pieces": pieces,
		"owners": owners,
		"cash_blue": cash_blue,
		"cash_red": cash_red,
		"cash_billions": cash_billions,
		"income_blue": income_blue,
		"income_red": income_red,
		"oil_income_blue": oil_income_blue,
		"oil_income_red": oil_income_red,
		"oil_reserve": oil_reserve,
		"oil_short": oil_short,
		"oil_owners": _oil_owner_rows(),
	}
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return "Could not save."
	file.store_string(JSON.stringify(payload))
	file.close()
	return ""


func load_match(path: String) -> String:
	if not FileAccess.file_exists(path):
		return "No save."
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return "Could not load."
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if not parsed is Dictionary:
		return "Could not load."
	var data: Dictionary = parsed
	era_year = int(data.get("era", era_year))
	player_side = str(data.get("side", player_side))
	round = int(data.get("turn", 0))
	beat = round
	cash_blue = int(data.get("cash_blue", cash_blue))
	cash_red = int(data.get("cash_red", cash_red))
	cash_billions = int(data.get("cash_billions", cash_billions))
	income_blue = int(data.get("income_blue", income_blue))
	income_red = int(data.get("income_red", income_red))
	oil_income_blue = int(data.get("oil_income_blue", oil_income_blue))
	oil_income_red = int(data.get("oil_income_red", oil_income_red))
	oil_reserve = int(data.get("oil_reserve", oil_reserve))
	oil_short = bool(data.get("oil_short", false))
	for row in data.get("oil_owners", []):
		if not row is Dictionary:
			continue
		var key := _oil_key(int(row.get("x", -1)), int(row.get("y", -1)))
		if oil_owner.has(key):
			oil_owner[key] = str(row.get("owner", oil_owner[key]))
	if sites != null:
		var by_id := {}
		for row in data.get("owners", []):
			if row is Dictionary:
				by_id[int(row.get("id", -1))] = str(row.get("owner", ""))
		for place in sites.places:
			var id := int(place["id"])
			if by_id.has(id):
				place["owner"] = str(by_id[id])
	tokens = []
	for row in data.get("pieces", []):
		if not row is Dictionary:
			continue
		var unit := _make(str(row.get("side", "")), int(row.get("x", 0)), int(row.get("y", 0)))
		unit.domain = str(row.get("domain", "land"))
		unit.label = str(row.get("label", ""))
		unit.ship_class = int(row.get("ship_class", 0))
		unit.pinned = bool(row.get("pinned", false))
		unit.revealed = bool(row.get("revealed", false))
		unit.entrenched = bool(row.get("entrenched", false))
		unit.idle_rounds = int(row.get("idle_rounds", 0))
		tokens.append(unit)
	note = "Loaded the saved match."
	player_note = ""
	fight_gone = false
	return ""


static func _tool_name(tool: String) -> String:
	match tool:
		"nuke":
			return "nuke"
		"satellite":
			return "satellites"
		"foreign_aid":
			return "foreign aid"
		"intel":
			return "intel"
		_:
			return ""


static func _label(side: String) -> String:
	return "Blue" if side == "blue" else "Red"
