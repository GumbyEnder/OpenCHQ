extends RefCounted
class_name AtlasLayer

var all: Array = []
var placed: Array = []
var base_w := 320.0
var base_h := 142.0
var logic_w := 30720.0
var logic_h := 13632.0
var max_tier := 1
var visible := false
var hover_id := ""
var selected_id := ""


func load_doc(doc: Variant, map_w: float, map_h: float) -> void:
	logic_w = map_w
	logic_h = map_h
	all = []
	if doc is Dictionary:
		var projection: Variant = doc.get("projection", {})
		if projection is Dictionary:
			base_w = float(projection.get("base_w", 320))
			base_h = float(projection.get("base_h", 142))
		var cities: Variant = doc.get("cities", [])
		if cities is Array:
			all = cities
	rebuild()


func set_max_tier(tier: int) -> void:
	max_tier = clampi(tier, 1, 3)
	rebuild()


func count() -> int:
	return placed.size()


func by_id(id: String) -> Variant:
	for city in placed:
		if str(city.get("id", "")) == id:
			return city
	return null


func pick(lx: float, ly: float, hit_logic: float) -> Variant:
	var best: Variant = null
	var best_d := hit_logic
	for city in placed:
		var d := Vector2(float(city["lx"]), float(city["ly"])).distance_to(Vector2(lx, ly))
		if d < best_d:
			best_d = d
			best = city
	return best


func rebuild() -> void:
	placed = []
	var sx := logic_w / base_w
	var sy := logic_h / base_h
	for city in all:
		if not city is Dictionary:
			continue
		if bool(city.get("skip", false)):
			continue
		if city.get("map_x") == null or city.get("map_y") == null:
			continue
		var mx := float(city["map_x"])
		var my := float(city["map_y"])
		if mx < -2.0 or mx > base_w + 2.0 or my < -2.0 or my > base_h + 2.0:
			continue
		if int(city.get("tier", 99)) > max_tier:
			continue
		var copy: Dictionary = city.duplicate()
		copy["lx"] = mx * sx
		copy["ly"] = my * sy
		placed.append(copy)
