extends RefCounted
class_name OilLayer

var all: Array = []
var placed: Array = []
var base_w := 320.0
var base_h := 142.0
var logic_w := 30720.0
var logic_h := 13632.0
var era_year := 1986
var visible := true
var hover_id := ""
var selected_id := ""


func load_doc(doc: Variant, map_w: float, map_h: float) -> void:
	logic_w = map_w
	logic_h = map_h
	all = []
	if doc is Dictionary:
		base_w = float(doc.get("base_w", 320))
		base_h = float(doc.get("base_h", 142))
		var fields: Variant = doc.get("fields", [])
		if fields is Array:
			all = fields
	set_era(era_year)


func set_era(year: int) -> void:
	era_year = year
	_rebuild()


func count() -> int:
	return placed.size()


func by_id(id: String) -> Variant:
	for field in placed:
		if str(field.get("id", "")) == id:
			return field
	return null


func pick(lx: float, ly: float, hit_logic: float) -> Variant:
	var best: Variant = null
	var best_d := hit_logic
	for field in placed:
		var d := Vector2(float(field["lx"]), float(field["ly"])).distance_to(Vector2(lx, ly))
		if d < best_d:
			best_d = d
			best = field
	return best


func blurb(field: Dictionary) -> String:
	var where := "offshore" if bool(field.get("offshore", false)) else "onshore"
	return "%s\nproposed field · %s\nRate unknown. Listed from %s.\ngrid (%s, %s)" % [
		str(field.get("region", "")),
		where,
		str(field.get("era_min", "")),
		str(field.get("map_x", "")),
		str(field.get("map_y", "")),
	]


func _rebuild() -> void:
	placed = []
	var sx := logic_w / base_w
	var sy := logic_h / base_h
	for field in all:
		if not field is Dictionary:
			continue
		if int(field.get("era_min", 0)) > era_year:
			continue
		var copy: Dictionary = field.duplicate()
		copy["lx"] = float(field.get("map_x", 0)) * sx
		copy["ly"] = float(field.get("map_y", 0)) * sy
		placed.append(copy)
