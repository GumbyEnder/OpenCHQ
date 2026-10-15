extends RefCounted
class_name TerrainMap

const CELL_W := 320
const CELL_H := 136
const ROW_STRIDE := 162

## Id 2 prints as "ocean" in the 1990 string table. The successor calls it shallows.
const NAMES := [
	"ocean",
	"docks",
	"shallows",
	"lake",
	"capital",
	"base",
	"city",
	"oilfield",
	"plain",
	"forest",
	"mountain",
	"desert",
	"jungle",
	"polar",
	"wasteland",
]

## Forest, mountain, polar, jungle, and shallows. The manual names these as slower and gives no ratio.
const SLOW := [false, false, true, false, false, false, false, false, false, true, true, false, true, true, false]

const STEPS := [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]

## sites.json kinds. Facility is not one of these, so those centers stay as the file left them.
## Oilfield, plain, and forest paint the center only. The others also paint neighbors.
const PAINT_CENTER := {
	"capital": 4,
	"base": 5,
	"city": 6,
	"oilfield": 7,
	"plain": 8,
	"forest": 9,
}
const PAINT_NEIGHBORS := {
	"capital": true,
	"base": true,
	"city": true,
}

var file_bytes := PackedByteArray()
var bytes := PackedByteArray()


func load_bytes(data: PackedByteArray) -> String:
	if data.size() < CELL_H * ROW_STRIDE:
		return "Terrain file is shorter than 136 rows."
	file_bytes = data.duplicate()
	bytes = file_bytes.duplicate()
	return ""


## Writes one nibble. Y outside the map is left alone. X wraps.
func set_id(x: int, y: int, id: int) -> void:
	if y < 0 or y >= CELL_H or bytes.is_empty():
		return
	x = posmod(x, CELL_W)
	var i := y * ROW_STRIDE + (x >> 1)
	var v := int(bytes[i])
	var n := id & 0x0F
	if x % 2 == 0:
		bytes[i] = (n << 4) | (v & 0x0F)
	else:
		bytes[i] = (v & 0xF0) | n


## Restores the file, then paints in site-id order. A later site can overwrite an earlier cell.
## Water neighbors (id <= 2) become docks. Any other neighbor becomes city.
func paint_sites(places: Array) -> void:
	bytes = file_bytes.duplicate()
	var ordered: Array = places.duplicate()
	ordered.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return int(a.get("id", 0)) < int(b.get("id", 0))
	)
	for place in ordered:
		if not place is Dictionary:
			continue
		var kind := str(place.get("kind", ""))
		if not PAINT_CENTER.has(kind):
			continue
		var x := int(place.get("x", 0))
		var y := int(place.get("y", 0))
		set_id(x, y, int(PAINT_CENTER[kind]))
		if not bool(PAINT_NEIGHBORS.get(kind, false)):
			continue
		for dy in range(-1, 2):
			for dx in range(-1, 2):
				if dx == 0 and dy == 0:
					continue
				var ny := y + dy
				if ny < 0 or ny >= CELL_H:
					continue
				var cur := id_at(x + dx, ny)
				set_id(x + dx, ny, 1 if cur <= 2 else 6)


func id_at(x: int, y: int) -> int:
	if y < 0 or y >= CELL_H:
		return 13
	x = posmod(x, CELL_W)
	var v := int(bytes[y * ROW_STRIDE + (x >> 1)])
	if x % 2 == 0:
		return (v >> 4) & 0x0F
	return v & 0x0F


static func terrain_name(id: int) -> String:
	if id < 0 or id >= NAMES.size():
		return "unknown"
	return NAMES[id]


static func is_slow(id: int) -> bool:
	return id >= 0 and id < SLOW.size() and SLOW[id]


## Open ground and docks are 1. Slow ground and shallows are 2.
## Ocean and lake use the same 2-beat stand-in. The 1990 ratio was not recovered.
## Wasteland is refused. Returns -1 when refused.
static func land_pace(id: int) -> int:
	if id == 14:
		return -1
	if is_slow(id) or id == 0 or id == 3:
		return 2
	return 1


static func pace_word(id: int) -> String:
	if id == 14:
		return "blocked"
	if id == 0 or id == 3:
		return "transport"
	if is_slow(id):
		return "slow"
	return "open"


## Empty array when the goal is the start. null when no route.
## `blocked` skips a cell. The destination cell is always allowed.
func route(x0: int, y0: int, x1: int, y1: int, blocked: Callable) -> Variant:
	var w := CELL_W
	var h := CELL_H
	var sx := posmod(x0, w)
	var sy := y0
	var gx := posmod(x1, w)
	var gy := y1
	if sy < 0 or sy >= h or gy < 0 or gy >= h:
		return null
	var start := sy * w + sx
	var goal := gy * w + gx
	var dist := PackedInt32Array()
	dist.resize(w * h)
	dist.fill(-1)
	var prev := PackedInt32Array()
	prev.resize(w * h)
	prev.fill(-1)
	var buckets: Array = [[start]]
	dist[start] = 0
	var cur := 0
	var guard := 0
	var limit := w * h * 4
	while cur < buckets.size() and guard < limit:
		var bucket: Array = buckets[cur]
		if bucket.is_empty():
			cur += 1
			continue
		guard += 1
		var i: int = bucket.pop_back()
		if dist[i] != cur:
			continue
		if i == goal:
			break
		var x := i % w
		var y := int(float(i) / float(w))
		for step in STEPS:
			var nx: int = x + int(step.x)
			var ny: int = y + int(step.y)
			if ny < 0 or ny >= h:
				continue
			nx = posmod(nx, w)
			var is_dest := nx == gx and ny == gy
			if not is_dest and blocked.is_valid() and bool(blocked.call(nx, ny)):
				continue
			var pace := land_pace(id_at(nx, ny))
			if pace < 0:
				continue
			var ni := ny * w + nx
			var nd := cur + pace
			if dist[ni] != -1 and dist[ni] <= nd:
				continue
			dist[ni] = nd
			prev[ni] = i
			while buckets.size() <= nd:
				buckets.append([])
			(buckets[nd] as Array).append(ni)
	if dist[goal] < 0:
		return null
	var path: Array = []
	var walk := goal
	var safety := 0
	while walk != start:
		if prev[walk] < 0:
			return null
		var px := walk % w
		var py := int(float(walk) / float(w))
		var tid := id_at(px, py)
		path.append({"x": px, "y": py, "pace": land_pace(tid), "word": pace_word(tid)})
		walk = prev[walk]
		safety += 1
		if safety > w * h:
			return null
	path.reverse()
	return path


## Class 0 may enter ocean, docks, and shallows. Class 1 may enter ocean and docks.
static func sea_accepts(cls: int, id: int) -> bool:
	if cls == 0:
		return id <= 2
	if cls == 1:
		return id <= 1
	return false


## Bresenham, short way around the cylinder. Every cell after the start has to pass.
## Empty when the ends are the same cell. null when a cell is refused or off the map.
func straight_walk(x0: int, y0: int, x1: int, y1: int, cls: int) -> Variant:
	if y0 < 0 or y0 >= CELL_H or y1 < 0 or y1 >= CELL_H:
		return null
	var sx := posmod(x0, CELL_W)
	var gx := posmod(x1, CELL_W)
	if sx == gx and y0 == y1:
		return []
	var ax := sx
	var bx := gx
	var delta := bx - ax
	if absi(delta) > 160:
		if delta < 1:
			bx += CELL_W
		else:
			ax += CELL_W
	if not sea_accepts(cls, id_at(gx, y1)):
		return null
	var step_x := 1 if bx >= ax else -1
	var step_y := 1 if y1 >= y0 else -1
	var adx := absi(bx - ax)
	var ady := absi(y1 - y0)
	var path: Array = []
	var x := ax
	var y := y0
	var y_major := ady >= adx
	var steps := (ady - 1) if y_major else (adx - 1)
	var err := (2 * adx - ady) if y_major else (2 * ady - adx)
	for _i in steps:
		if y_major:
			y += step_y
			if err >= 0:
				x += step_x
				err += 2 * (adx - ady)
			else:
				err += 2 * adx
		else:
			x += step_x
			if err >= 0:
				y += step_y
				err += 2 * (ady - adx)
			else:
				err += 2 * ady
		var cx := posmod(x, CELL_W)
		var id := id_at(cx, y)
		if not sea_accepts(cls, id):
			return null
		path.append(_sea_step(cx, y, id))
	path.append(_sea_step(gx, y1, id_at(gx, y1)))
	return path


static func _sea_step(x: int, y: int, id: int) -> Dictionary:
	if id == 2:
		return {"x": x, "y": y, "pace": 2, "word": "slow"}
	return {"x": x, "y": y, "pace": 1, "word": "sea"}
