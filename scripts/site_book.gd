extends RefCounted
class_name SiteBook

var source_scale := 96.0
var places: Array = []
var by_cell := {}
var hover_id := -1
var selected_id := -1


func load_sites(raw_sites: Array, countries: Array, scale: float) -> String:
	if raw_sites.is_empty():
		return "sites.json is missing or empty."
	source_scale = scale
	places = []
	by_cell = {}
	for raw in raw_sites:
		if not raw is Dictionary:
			continue
		var place := _from_raw(raw, countries)
		places.append(place)
		by_cell[int(place["y"]) * TerrainMap.CELL_W + int(place["x"])] = place
	if places.is_empty():
		return "sites.json has no sites."
	return ""


func count() -> int:
	return places.size()


func at_cell(x: int, y: int) -> Variant:
	return by_cell.get(y * TerrainMap.CELL_W + posmod(x, TerrainMap.CELL_W), null)


func by_id(id: int) -> Variant:
	for place in places:
		if int(place["id"]) == id:
			return place
	return null


func capital(side: String) -> Variant:
	for place in places:
		if str(place["kind"]) == "capital" and str(place["home"]) == side:
			return place
	return null


func reset_owners() -> void:
	for place in places:
		place["owner"] = place["home"]


## Concealed start only. Cities already on the map become city-states.
## Capitals and facilities keep the owner the file gave them.
func apply_city_states() -> void:
	for place in places:
		if str(place.get("kind", "")) == "city":
			place["owner"] = "neutral"


func pick(lx: float, ly: float, hit_logic: float) -> Variant:
	var best: Variant = null
	var best_d := hit_logic * 1.25
	for place in places:
		var d := Vector2(float(place["logic_x"]), float(place["logic_y"])).distance_to(Vector2(lx, ly))
		var limit := hit_logic * 1.25 if str(place["kind"]) == "capital" else hit_logic
		if d < limit and d < best_d:
			best_d = d
			best = place
	return best


func _from_raw(raw: Dictionary, countries: Array) -> Dictionary:
	var site_name := str(raw.get("name", ""))
	var title := "Facility" if site_name == "" or site_name.begins_with("site_") else site_name
	var country_id := int(raw.get("country_id", -1))
	var home := "neutral"
	if country_id == 0:
		home = "blue"
	elif country_id == 1:
		home = "red"
	var country := ""
	if country_id >= 0 and country_id < countries.size():
		country = str(countries[country_id])
	var x := int(raw.get("x", 0))
	var y := int(raw.get("y", 0))
	return {
		"id": int(raw.get("id", -1)),
		"name": site_name,
		"title": title,
		"x": x,
		"y": y,
		"kind": str(raw.get("kind", "city")),
		"country": country,
		"home": home,
		"owner": home,
		"logic_x": (x + 0.5) * source_scale,
		"logic_y": (y + 0.5) * source_scale,
		"listed_x": x,
		"listed_y": y,
	}


func restore_listed() -> void:
	for place in places:
		place["x"] = int(place["listed_x"])
		place["y"] = int(place["listed_y"])
	_reindex()


## Stand-in. Non-capital cities trade listed cells. Capitals and facilities stay.
func shuffle_cities(seed: int) -> bool:
	restore_listed()
	var cities: Array = []
	for place in places:
		if str(place.get("kind", "")) == "city":
			cities.append(place)
	var coords: Array = []
	for place in cities:
		coords.append([int(place["x"]), int(place["y"])])
	coords = Assumptions.shuffle_points(coords, seed)
	var moved := false
	for i in cities.size():
		var spot: Array = coords[i]
		var place: Dictionary = cities[i]
		if int(place["x"]) != int(spot[0]) or int(place["y"]) != int(spot[1]):
			moved = true
		place["x"] = int(spot[0])
		place["y"] = int(spot[1])
	_reindex()
	return moved


func _reindex() -> void:
	by_cell = {}
	for place in places:
		var x := int(place["x"])
		var y := int(place["y"])
		place["logic_x"] = (x + 0.5) * source_scale
		place["logic_y"] = (y + 0.5) * source_scale
		by_cell[y * TerrainMap.CELL_W + posmod(x, TerrainMap.CELL_W)] = place
