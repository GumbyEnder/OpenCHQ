extends RefCounted
class_name SeaLanes

## File offset of DS:0 in CHQ_unpacked.EXE: 0x3600 + (0x2f2b << 4).
const FILE_BASE := 0x328B0
const COUNT := 151
const GROUPS := 27
const EDGE_BYTES := 0x3DE2 - 0x3736

var _x := PackedInt32Array()
var _y := PackedInt32Array()
var _neighbors: Array = []


func count() -> int:
	return _x.size()


func point(index: int) -> Vector2i:
	return Vector2i(_x[index], _y[index])


func load_bytes(data: PackedByteArray) -> String:
	if data.size() < FILE_BASE + 0x3DE2:
		return "Unpacked EXE is too short for the sea-lane tables."
	_x.resize(COUNT)
	_y.resize(COUNT)
	for i in COUNT:
		var at := FILE_BASE + 0x3356 + i * 2
		_x[i] = int(data[at]) | (int(data[at + 1]) << 8)
		_y[i] = int(data[FILE_BASE + 0x3484 + i])
	if _x[0] != 0 or _y[0] != 15 or _x[150] != 318 or _y[150] != 10:
		return "Sea-lane endpoints are not the unpacked table."
	var group := data.slice(FILE_BASE + 0x351C, FILE_BASE + 0x351C + COUNT)
	var alt := data.slice(FILE_BASE + 0x35B4, FILE_BASE + 0x35B4 + COUNT)
	var slot := data.slice(FILE_BASE + 0x364C, FILE_BASE + 0x364C + COUNT)
	var stride := data.slice(FILE_BASE + 0x36E4, FILE_BASE + 0x36E4 + 28)
	var edges := data.slice(FILE_BASE + 0x3736, FILE_BASE + 0x3736 + EDGE_BYTES)
	var base := PackedInt32Array()
	base.resize(GROUPS)
	for g in GROUPS:
		var at := FILE_BASE + 0x3700 + g * 2
		base[g] = int(data[at]) | (int(data[at + 1]) << 8)
	_neighbors.clear()
	for i in COUNT:
		_neighbors.append([])
	for a in COUNT:
		var ga := _ends(group[a], alt[a])
		for b in COUNT:
			if a == b:
				continue
			var gb := _ends(group[b], alt[b])
			if ga.x == gb.x:
				_link(a, b, _edge_at(edges, stride, base, ga.x, slot[a] & 0x0F, slot[b] & 0x0F))
			if gb.y >= 0 and ga.x == gb.y:
				_link(a, b, _edge_at(edges, stride, base, ga.x, slot[a] & 0x0F, slot[b] >> 4))
			if ga.y >= 0 and ga.y == gb.x:
				_link(a, b, _edge_at(edges, stride, base, ga.y, slot[a] >> 4, slot[b] & 0x0F))
			if ga.y >= 0 and gb.y >= 0 and ga.y == gb.y:
				_link(a, b, _edge_at(edges, stride, base, ga.y, slot[a] >> 4, slot[b] >> 4))
	return ""


## Straight walk first. The waypoint graph is only the fallback.
## `cls` 0 may use shallows. `cls` 1 refuses them. null when neither way is open.
func route(terrain: TerrainMap, x0: int, y0: int, x1: int, y1: int, cls: int) -> Variant:
	var direct: Variant = terrain.straight_walk(x0, y0, x1, y1, cls)
	if direct != null:
		return direct
	if y0 < 0 or y0 >= TerrainMap.CELL_H or y1 < 0 or y1 >= TerrainMap.CELL_H:
		return null
	var sx := posmod(x0, TerrainMap.CELL_W)
	var gx := posmod(x1, TerrainMap.CELL_W)
	var start := _nearest(terrain, sx, y0, cls)
	var goal := _nearest(terrain, gx, y1, cls)
	if start < 0 or goal < 0:
		return null
	var chain := _chain(terrain, start, goal, cls)
	if chain.is_empty():
		return null
	var pts: Array = [Vector2i(sx, y0)]
	for index in chain:
		pts.append(Vector2i(_x[int(index)], _y[int(index)]))
	var end := Vector2i(gx, y1)
	if pts[pts.size() - 1] != end:
		pts.append(end)
	var folded: Array = [pts[0]]
	for i in range(1, pts.size()):
		if pts[i] != folded[folded.size() - 1]:
			folded.append(pts[i])
	var path: Array = []
	for i in range(folded.size() - 1):
		var a: Vector2i = folded[i]
		var b: Vector2i = folded[i + 1]
		var leg: Variant = terrain.straight_walk(a.x, a.y, b.x, b.y, cls)
		if leg == null:
			return null
		for step in leg:
			path.append(step)
	if path.is_empty():
		return null
	return path


## Bit 0x20 stores a second group in the alt table. The low five bits stay the first group.
static func _ends(group_byte: int, alt_byte: int) -> Vector2i:
	if (group_byte & 0x20) != 0:
		return Vector2i(group_byte & 0x1F, alt_byte)
	return Vector2i(group_byte, -1)


static func _edge_at(edges: PackedByteArray, stride: PackedByteArray, base: PackedInt32Array, group: int, slot_a: int, slot_b: int) -> int:
	if group < 0 or group >= GROUPS:
		return -1
	var idx := int(stride[group]) * slot_a + slot_b + int(base[group])
	if idx < 0 or idx >= edges.size():
		return -1
	return int(edges[idx])


func _link(a: int, b: int, named: int) -> void:
	if named != b:
		return
	var row: Array = _neighbors[a]
	if row.has(b):
		return
	row.append(b)


## FUN_16ee_09dc window. The cost is the short-way major axis, plus 2 when the start is land.
func _nearest(terrain: TerrainMap, x: int, y: int, cls: int) -> int:
	for i in COUNT:
		if _x[i] == x and _y[i] == y and TerrainMap.sea_accepts(cls, terrain.id_at(x, y)):
			return i
	var xmin := x - 0x21
	var xmax := x + 0x21
	var ymin := 0 if y < 0x22 else y - 0x21
	var ymax := 0x87 if y + 0x21 >= 0x88 else y + 0x21
	if xmax > 0x13F:
		xmax = x - 0x11F
		xmin = x - 0x161
	var wrapped := xmin < 0
	var best := 65000
	var found := -1
	var land_start := terrain.id_at(x, y) > 2
	for i in COUNT:
		var xx := _x[i]
		var yy := _y[i]
		if yy < ymin or yy > ymax:
			continue
		if wrapped:
			if not (xmin + 0x140 <= xx or xx <= xmax):
				continue
		elif xx < xmin or xx > xmax:
			continue
		if not TerrainMap.sea_accepts(cls, terrain.id_at(xx, yy)):
			continue
		if terrain.straight_walk(x, y, xx, yy, cls) == null:
			continue
		var cost := _major(x, y, xx, yy)
		if land_start:
			cost += 2
		if cost < best:
			best = cost
			found = i
	return found


func _chain(terrain: TerrainMap, start: int, goal: int, cls: int) -> Array:
	var dist := PackedInt32Array()
	dist.resize(COUNT)
	dist.fill(1 << 30)
	var prev := PackedInt32Array()
	prev.resize(COUNT)
	prev.fill(-1)
	var used := PackedByteArray()
	used.resize(COUNT)
	dist[start] = 0
	for _step in COUNT:
		var u := -1
		var best := 1 << 30
		for i in COUNT:
			if used[i] == 0 and dist[i] < best:
				best = dist[i]
				u = i
		if u < 0 or best >= (1 << 30):
			return []
		if u == goal:
			break
		used[u] = 1
		if not TerrainMap.sea_accepts(cls, terrain.id_at(_x[u], _y[u])):
			continue
		for v in _neighbors[u]:
			var vi := int(v)
			if not TerrainMap.sea_accepts(cls, terrain.id_at(_x[vi], _y[vi])):
				continue
			var leg: Variant = terrain.straight_walk(_x[u], _y[u], _x[vi], _y[vi], cls)
			if leg == null:
				continue
			var nd: int = dist[u] + maxi(1, (leg as Array).size())
			if nd < dist[vi]:
				dist[vi] = nd
				prev[vi] = u
	if dist[goal] >= (1 << 30):
		return []
	var chain: Array = []
	var cur := goal
	var guard := 0
	while cur != start and guard < COUNT:
		chain.append(cur)
		cur = prev[cur]
		if cur < 0:
			return []
		guard += 1
	chain.append(start)
	chain.reverse()
	return chain


static func _major(x0: int, y0: int, x1: int, y1: int) -> int:
	var ax := x0
	var bx := x1
	var delta := bx - ax
	if absi(delta) > 160:
		if delta < 1:
			bx += TerrainMap.CELL_W
		else:
			ax += TerrainMap.CELL_W
	return maxi(absi(bx - ax), absi(y1 - y0))
