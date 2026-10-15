extends RefCounted
class_name MatchState

var terrain: TerrainMap
var sea: SeaLanes
var sites: SiteBook
var beat := 0
var note := ""
var era_year := 1986
## The side that takes orders. The other side marches on this side's capital.
var player_side := "blue"
var selected_side := ""
var selected_domain := ""
var tokens: Array = []
var _red_key := ""
## A shortage flag, not a stockpile. No rate is stored.
var oil_short := false
## Rounds in which cities paid. Not a sum of money.
var income_blue := 0
var income_red := 0
var _income_said := ""
var _combat_said := ""
var support_blue := 0
var support_red := 0
var fight_on := false
var fight_rounds := 0
var combat_note := ""
## Who the enemy shot at. A second friendly is never this.
var shot_takes := ""
var aim_blue := Vector2i(-999, -999)
var aim_red := Vector2i(-999, -999)
var extra_blue_on := false
var extra_red_on := false
var extra_blue := Vector2i(-999, -999)
var extra_red := Vector2i(-999, -999)
## Latched when the ordered side finds the other capital. Era 9999 reads it.
var _capital_found := false

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
	if selected_side == side and selected_domain == "sea":
		var ship := sea_token(side)
		if ship != null:
			return ship
	return token(side)


func reset() -> void:
	sites.reset_owners()
	beat = 0
	note = "You are %s. Your land piece and your ship are marked." % _label(player_side)
	selected_side = ""
	selected_domain = ""
	_red_key = ""
	_capital_found = false
	oil_short = false
	income_blue = 0
	income_red = 0
	_income_said = ""
	_combat_said = ""
	support_blue = 0
	support_red = 0
	extra_blue_on = false
	extra_red_on = false
	_clear_fight()
	var blue_cap: Dictionary = sites.capital("blue")
	var red_cap: Dictionary = sites.capital("red")
	tokens = [
		_make("blue", int(blue_cap["x"]), int(blue_cap["y"])),
		_make("red", int(red_cap["x"]), int(red_cap["y"])),
		_make_sea("blue", SEA_BLUE.x, SEA_BLUE.y),
		_make_sea("red", SEA_RED.x, SEA_RED.y),
	]


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
			return "%s — satellites are available. The scan radius is unknown." % _label(side)
		"foreign_aid":
			return "%s — foreign aid is available. The cost is unknown." % _label(side)
		"intel":
			return "%s — intel is available. The scan radius is unknown. The opponent is told." % _label(side)
		_:
			return ""


## Empty string when the order is kept. A message when it is refused.
## A sea piece calls ship_route. The land piece keeps terrain.route.
## A step onto the other piece is contact. Damage amounts are unknown, so the piece stops short.
func order(side: String, x: int, y: int) -> String:
	var chosen := ordered_unit(side)
	if chosen != null and chosen.domain == "sea":
		return _order_sea(chosen, x, y)
	if winner() != "":
		return ""
	if shortage():
		return _held_line()
	var unit := token(side)
	var other := token("red" if side == "blue" else "blue")
	if unit.x == x and unit.y == y:
		unit.path = []
		unit.debt = 0
		unit.pinned = false
		return ""
	# A hidden opponent is not a known blocker. Contact still stops the step.
	var conceal := side == player_side and opponent_hidden()
	var blocked := func(nx: int, ny: int) -> bool:
		if conceal:
			return false
		return other.x == nx and other.y == ny
	var path: Variant = terrain.route(unit.x, unit.y, x, y, blocked)
	var contact := false
	if not conceal and path is Array and not (path as Array).is_empty() and _on_other((path as Array)[0], other):
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
		var stopped := "%s stopped short — damage amounts unknown" % _label(side)
		unit.path = []
		unit.debt = 0
		if unit.domain != "sea":
			unit.pinned = true
		if side == player_side:
			note = stopped
		return stopped
	if path == null or not path is Array or (path as Array).is_empty():
		return "No route. Ocean is crossed as a transport; wasteland is refused."
	var steps: Array = path
	unit.path = steps
	unit.debt = int(steps[0]["pace"])
	unit.pinned = false
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
		var stopped_note := "%s stopped short — damage amounts unknown" % _label(side)
		if side == player_side:
			note = stopped_note
		return stopped_note
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
		return []
	beat += 1
	var lines: Array = []
	_pay_cities()
	_say_income(lines)
	if shortage():
		_say_combat(lines)
		return lines
	for unit in tokens:
		var line := _advance(unit)
		if line != "":
			lines.append(line)
	var won := winner()
	if won != "":
		note = "%s holds every capital" % _label(won)
		lines.append(note)
		for unit in tokens:
			unit.path = []
			unit.debt = 0
		return lines
	var opponent := "red" if player_side == "blue" else "blue"
	var mine := token(player_side)
	var opp := token(opponent)
	if opp.path.is_empty():
		var cap: Dictionary = sites.capital(player_side)
		var key := "%d,%d,%s" % [mine.x, mine.y, str(cap["owner"])]
		if _red_key != key:
			var refused := order(opponent, int(cap["x"]), int(cap["y"]))
			_red_key = key if refused != "" else ""
			if refused != "" and not lines.has(refused) and not opponent_hidden():
				lines.append(refused)
	_say_combat(lines)
	return lines


## The opponent draws three steps. The ordered side draws the whole path.
static func visible_steps(path: Array, side: String, player: String = "blue") -> Array:
	if path.is_empty():
		return []
	if side != player:
		return path.slice(0, mini(3, path.size()))
	return path


## Era 9999 draws the ordered side only, until their opponent's capital is found.
func shows_piece(unit: Token) -> bool:
	if unit == null:
		return false
	if unit.side == player_side:
		return true
	return not opponent_hidden()


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
	return line


func _advance(unit: Token) -> String:
	if unit.path.is_empty():
		return ""
	if held(unit):
		return ""
	var other := token("red" if unit.side == "blue" else "blue")
	var next: Dictionary = unit.path[0]
	if other.x == int(next["x"]) and other.y == int(next["y"]):
		unit.path = []
		unit.debt = 0
		if unit.domain != "sea":
			unit.pinned = true
		return _public_line(unit.side, "%s stopped short — damage amounts unknown" % _label(unit.side))
	unit.debt -= 1
	if unit.debt > 0:
		return ""
	var nx := int(next["x"])
	var ny := int(next["y"])
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


func _on_other(step: Dictionary, other: Token) -> bool:
	return int(step["x"]) == other.x and int(step["y"]) == other.y


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
	return "City income. Amount unknown."


## The tank relation is a ratio. The price column itself stays empty.
func price_line() -> String:
	return "A tank costs twice an infantry unit. Other prices are unknown."


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
	combat_note = ""
	_combat_said = ""
	shot_takes = ""
	aim_blue = Vector2i(-999, -999)
	aim_red = Vector2i(-999, -999)
	for unit in tokens:
		if unit.domain != "sea":
			unit.pinned = false


func _pay_cities() -> void:
	if shortage():
		return
	if _owned_cities("blue") > 0:
		income_blue += 1
	if _owned_cities("red") > 0:
		income_red += 1


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
