extends Control
class_name MapView

signal clicked(world: Vector2)
signal hovered(world: Vector2)

const OCEAN := Color("55ffff")
const SLOW_DOT := Color("ffe08a")
const BLUE_PATH := Color(0.490, 0.714, 1.0, 0.9)
const RED_PATH := Color(1.0, 0.553, 0.553, 0.9)
const OWNER := {
	"blue": Color("7eb6ff"),
	"red": Color("ff8d8d"),
	"neutral": Color("d5dbe8"),
}
## Walk-grid paint that the source picture leaves out. Not a side color.
const PAINT_COLOR := {
	1: Color("555555"),
	4: Color("ffd27a"),
	6: Color("aa5500"),
}

var logic_w := 30720.0
var logic_h := 13632.0
var source_scale := 96.0
var pan_x := 0.0
var pan_y := 0.0
var view_scale := 1.0
var map_tex: Texture2D
var land_tex: Texture2D
var transport_tex: Texture2D
var sea_tex: Texture2D
var terrain: TerrainMap
var sites: SiteBook
var oil: OilLayer
var atlas: AtlasLayer
var game: MatchState
var preview: Array = []
var show_preview := false
var era_year := 1986
var labels_on := false
## Drawn repair mark. The bar has no amount, so its text stays empty.
var repair_caption := ""
var repair_bar_text := ""

var _drag := false
var _drag_moved := false
var _drag_start := Vector2.ZERO
var _drag_pan := Vector2.ZERO
var _k0 := 0
var _k1 := 0
var _chips: Control
var _chip_labels := {}
var _note: Label
var _stamp: Label
var _contact: Label
var _quote: Label
var _badge: Label
var _pulse: Label
var _flash: Label
var _banner: Label
var _sat: Label
var _paint: Array = []
var _paint_for: TerrainMap = null


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	mouse_default_cursor_shape = Control.CURSOR_DRAG
	clip_contents = true
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_build_overlay()


func _build_overlay() -> void:
	_note = Label.new()
	_note.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_note.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_note.add_theme_font_size_override("font_size", 14)
	_note.add_theme_color_override("font_color", Color("e4ecff"))
	add_child(_note)
	_stamp = _overlay_label(Color("4ecdc4"))
	_contact = _overlay_label(Color("d6c07a"))
	_quote = _overlay_label(Color("e4ecff"))
	_badge = _overlay_label(Color("d6c07a"))
	_pulse = _overlay_label(Color("4ecdc4"))
	_flash = _overlay_label(Color("ff8d8d"))
	_banner = _overlay_label(Color("4ecdc4"))
	_sat = _overlay_label(Color("7eb6ff"))
	add_child(_stamp)
	add_child(_contact)
	add_child(_quote)
	add_child(_badge)
	add_child(_pulse)
	add_child(_flash)
	add_child(_banner)
	add_child(_sat)
	var rows := VBoxContainer.new()
	rows.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rows.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	rows.add_theme_constant_override("separation", 4)
	add_child(rows)
	_chips = rows
	var keys := [
		["terrain", "beat", "time", "capitals"],
		["sites", "oil", "zoom"],
	]
	for row_keys in keys:
		var row := HBoxContainer.new()
		row.mouse_filter = Control.MOUSE_FILTER_IGNORE
		row.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		row.add_theme_constant_override("separation", 6)
		rows.add_child(row)
		for key in row_keys:
			var lab := Label.new()
			lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
			lab.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
			lab.add_theme_font_size_override("font_size", 12)
			lab.add_theme_color_override("font_color", Color("8b99b8"))
			var panel := PanelContainer.new()
			panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
			panel.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
			panel.add_theme_stylebox_override("panel", _chip_style())
			panel.add_child(lab)
			row.add_child(panel)
			if key == "terrain":
				lab.text = "—"
			_chip_labels[key] = lab


func set_chip(key: String, text: String) -> void:
	var lab: Label = _chip_labels.get(key)
	if lab != null:
		lab.text = text


func _overlay_label(color: Color) -> Label:
	var lab := Label.new()
	lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	lab.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	lab.add_theme_font_size_override("font_size", 14)
	lab.add_theme_color_override("font_color", color)
	return lab


func set_stamp(running: bool) -> void:
	if _stamp != null:
		_stamp.text = "Running" if running else "Held"


func set_contact(on: bool) -> void:
	if _contact != null:
		_contact.text = "Last seen" if on else ""


func set_quote(text: String) -> void:
	if _quote != null:
		_quote.text = text


func set_badge(text: String) -> void:
	if _badge != null:
		_badge.text = text


func set_pulse(on: bool) -> void:
	if _pulse != null:
		_pulse.text = "Pulse" if on else ""


func set_flash(text: String) -> void:
	if _flash != null:
		_flash.text = text


func set_banner(text: String) -> void:
	if _banner != null:
		_banner.text = text


func set_satellite(on: bool) -> void:
	if _sat != null:
		_sat.text = "Satellite" if on else ""


func set_note(text: String, win: bool) -> void:
	_note.text = text
	_note.add_theme_color_override("font_color", Color("4ecdc4") if win else Color("e4ecff"))


func set_pixel_filter(pixel: bool) -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST if pixel else CanvasItem.TEXTURE_FILTER_LINEAR
	queue_redraw()


func marker_hit() -> float:
	return 11.0 / maxf(view_scale, 0.000001)


func cell_center(x: int, y: int) -> Vector2:
	return Vector2((x + 0.5) * source_scale, (y + 0.5) * source_scale)


func cell_of(world: Vector2) -> Vector2i:
	var x := int(floor(world.x / source_scale))
	var y := int(floor(world.y / source_scale))
	return Vector2i(posmod(x, TerrainMap.CELL_W), y)


func fit_scale() -> float:
	var pad := 12.0
	var sx := (size.x - pad * 2.0) / logic_w
	var sy := (size.y - pad * 2.0) / logic_h
	return minf(sx, sy)


func is_near_fit() -> bool:
	var fit := fit_scale()
	if fit <= 0.0 or view_scale <= 0.0:
		return false
	return absf(view_scale - fit) < fit * 0.08


func fit_view() -> void:
	if size.x < 2.0 or size.y < 2.0:
		return
	view_scale = fit_scale()
	pan_x = (size.x - logic_w * view_scale) / 2.0
	pan_y = (size.y - logic_h * view_scale) / 2.0
	queue_redraw()


func zoom_text() -> String:
	if logic_w <= 0.0 or view_scale <= 0.0 or size.x < 2.0:
		return "—"
	var frac := minf(1.0, size.x / (logic_w * view_scale))
	return "%d%% of width" % int(round(frac * 100.0))


func zoom_to(world: Vector2) -> void:
	if size.x < 2.0:
		return
	var min_s := fit_scale()
	var max_s := size.x / (logic_w * 0.03)
	view_scale = clampf(size.x / (logic_w * 0.1), min_s, max_s)
	pan_x = size.x * 0.5 - world.x * view_scale
	pan_y = size.y * 0.5 - world.y * view_scale
	queue_redraw()


## The player's land piece and ship. The other side is not marked.
func marked_piece(unit: MatchState.Token) -> bool:
	if game == null or unit == null:
		return false
	if unit.side != game.player_side:
		return false
	return unit.domain == "land" or unit.domain == "sea"


## Era 9999 omits the opponent until their capital is found.
func piece_drawn(unit: MatchState.Token) -> bool:
	return game != null and game.shows_piece(unit)


## Fit both points, including across the east-west wrap. Not the whole map.
func frame_points(points: Array) -> void:
	if size.x < 2.0 or size.y < 2.0 or logic_w <= 0.0 or points.is_empty():
		return
	var base := (points[0] as Vector2).x
	var min_x := 0.0
	var max_x := 0.0
	var min_y := (points[0] as Vector2).y
	var max_y := min_y
	for point in points:
		var at := point as Vector2
		var dx := _short_dx(base, at.x)
		min_x = minf(min_x, dx)
		max_x = maxf(max_x, dx)
		min_y = minf(min_y, at.y)
		max_y = maxf(max_y, at.y)
	var pad_x := maxf(source_scale * 2.0, (max_x - min_x) * 0.18)
	var pad_y := maxf(source_scale * 3.0, (max_y - min_y) * 0.28)
	min_x -= pad_x
	max_x += pad_x
	min_y -= pad_y
	max_y += pad_y
	var span_x := maxf(source_scale, max_x - min_x)
	var span_y := maxf(source_scale, max_y - min_y)
	var min_s := fit_scale()
	var max_s := size.x / (logic_w * 0.03)
	view_scale = clampf(minf(size.x / span_x, size.y / span_y), min_s, max_s)
	var mid_x := base + (min_x + max_x) * 0.5
	var mid_y := (min_y + max_y) * 0.5
	pan_x = size.x * 0.5 - mid_x * view_scale
	pan_y = size.y * 0.5 - mid_y * view_scale
	queue_redraw()


func sees(world: Vector2) -> bool:
	if view_scale <= 0.0 or size.x < 2.0 or logic_w <= 0.0:
		return false
	for k in [-1, 0, 1]:
		var s := _world_to_screen(world.x + float(k) * logic_w, world.y)
		if s.x >= 4.0 and s.x <= size.x - 4.0 and s.y >= 4.0 and s.y <= size.y - 4.0:
			return true
	return false


func _short_dx(from: float, to: float) -> float:
	var d := to - from
	if logic_w <= 0.0:
		return d
	if d > logic_w * 0.5:
		d -= logic_w
	elif d < -logic_w * 0.5:
		d += logic_w
	return d


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var button := event as InputEventMouseButton
		if button.button_index == MOUSE_BUTTON_WHEEL_UP or button.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if button.pressed:
				var factor := 1.14 if button.button_index == MOUSE_BUTTON_WHEEL_UP else 0.88
				_zoom_at(button.position, factor)
			accept_event()
			return
		if button.button_index != MOUSE_BUTTON_LEFT:
			return
		if button.pressed:
			_drag = true
			_drag_moved = false
			_drag_start = button.position
			_drag_pan = Vector2(pan_x, pan_y)
			mouse_default_cursor_shape = Control.CURSOR_MOVE
		else:
			mouse_default_cursor_shape = Control.CURSOR_DRAG
			if _drag and not _drag_moved:
				clicked.emit(screen_to_world(button.position))
			_drag = false
		accept_event()
	elif event is InputEventMouseMotion and _drag:
		var motion := event as InputEventMouseMotion
		if motion.position.distance_to(_drag_start) > 4.0:
			_drag_moved = true
		pan_x = _drag_pan.x + (motion.position.x - _drag_start.x)
		pan_y = _drag_pan.y + (motion.position.y - _drag_start.y)
		queue_redraw()
		accept_event()
	elif event is InputEventMouseMotion and not _drag:
		hovered.emit(screen_to_world((event as InputEventMouseMotion).position))


func screen_to_world_raw(screen: Vector2) -> Vector2:
	return Vector2((screen.x - pan_x) / view_scale, (screen.y - pan_y) / view_scale)


func screen_to_world(screen: Vector2) -> Vector2:
	var raw := screen_to_world_raw(screen)
	return Vector2(fposmod(raw.x, logic_w), raw.y)


func _zoom_at(screen: Vector2, factor: float) -> void:
	if size.x < 2.0 or view_scale <= 0.0:
		return
	var before := screen_to_world_raw(screen)
	var min_s := fit_scale()
	var max_s := size.x / (logic_w * 0.03)
	view_scale = clampf(view_scale * factor, min_s, max_s)
	pan_x = screen.x - before.x * view_scale
	pan_y = screen.y - before.y * view_scale
	queue_redraw()
	set_chip("zoom", zoom_text())


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_place_overlay()


func _place_overlay() -> void:
	if _note != null:
		_note.position = Vector2(12, 44)
		_note.size = Vector2(maxf(0.0, size.x - 24.0), 48)
	if _stamp != null:
		_stamp.position = Vector2(maxf(12.0, size.x - 120.0), 12)
	if _contact != null:
		_contact.position = Vector2(12, 12)
	if _quote != null:
		_quote.position = Vector2(12, 96)
	if _badge != null:
		_badge.position = Vector2(12, 120)
	if _pulse != null:
		_pulse.position = Vector2(12, 144)
	if _flash != null:
		_flash.position = Vector2(120, 144)
	if _banner != null:
		_banner.position = Vector2(12, 168)
	if _sat != null:
		_sat.position = Vector2(12, 192)
	if _chips != null:
		_chips.position = Vector2(12, maxf(0.0, size.y - 68.0))
		_chips.size = Vector2(maxf(0.0, size.x - 24.0), 60)


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), OCEAN)
	if map_tex == null or view_scale <= 0.0:
		return
	_update_k_range()
	for k in range(_k0, _k1 + 1):
		var origin := _world_to_screen(k * logic_w, 0.0)
		var rect := Rect2(origin, Vector2(logic_w * view_scale, logic_h * view_scale))
		if rect.intersects(Rect2(Vector2(-2, -2), size + Vector2(4, 4))):
			draw_texture_rect(map_tex, rect, false)
	_draw_painted()
	if oil != null and oil.visible:
		_draw_oil()
	if atlas != null and atlas.visible:
		_draw_atlas()
	if sites != null:
		_draw_sites()
	if game != null:
		_draw_paths()
		_draw_tokens()
		_draw_feedback()


func rebuild_paint() -> void:
	_paint_for = terrain
	_paint = terrain.picture_cells() if terrain != null else []


func paint_count() -> int:
	if _paint_for != terrain:
		rebuild_paint()
	return _paint.size()


func draws_paint_id(id: int) -> bool:
	return PAINT_COLOR.has(id)


func _draw_painted() -> void:
	if terrain == null or view_scale <= 0.0:
		return
	if _paint_for != terrain:
		rebuild_paint()
	var cell := source_scale * view_scale
	if cell < 0.5 or _paint.is_empty():
		return
	var view := Rect2(Vector2(-2, -2), size + Vector2(4, 4))
	for mark in _paint:
		var id := int(mark["id"])
		if not PAINT_COLOR.has(id):
			continue
		var col := PAINT_COLOR[id] as Color
		var wx := float(mark["x"]) * source_scale
		var wy := float(mark["y"]) * source_scale
		for k in range(_k0, _k1 + 1):
			var origin := _world_to_screen(wx + float(k) * logic_w, wy)
			var x0 := floorf(origin.x)
			var y0 := floorf(origin.y)
			var x1 := floorf(origin.x + cell)
			var y1 := floorf(origin.y + cell)
			if x1 <= x0:
				x1 = x0 + 1.0
			if y1 <= y0:
				y1 = y0 + 1.0
			var rect := Rect2(x0, y0, x1 - x0, y1 - y0)
			if rect.intersects(view):
				draw_rect(rect, col)


func _oil_fill(field: Dictionary) -> Color:
	var neutral := Color("2ecc71") if bool(field.get("offshore", false)) else Color("1a8f3c")
	if game == null:
		return neutral
	var who := game.oil_owner_at(int(float(field.get("map_x", -1))), int(float(field.get("map_y", -1))))
	if who == "blue":
		return Color("3d7ec9")
	if who == "red":
		return Color("c4473a")
	return neutral


func _draw_oil() -> void:
	for field in oil.placed:
		var id := str(field.get("id", ""))
		var hot := id == oil.hover_id or id == oil.selected_id
		var fill := _oil_fill(field)
		for s in _screens(float(field["lx"]), float(field["ly"])):
			if hot:
				draw_circle(s, 8.5, Color(0.180, 0.800, 0.443, 0.28))
			draw_circle(s, 4.5, fill)
			draw_arc(s, 4.5, 0, TAU, 20, Color.WHITE if id == oil.selected_id else Color(0, 0, 0, 0.7), 2.0 if id == oil.selected_id else 1.0, true)
			if _show_name(id == oil.hover_id, id == oil.selected_id):
				_paint_label(s + Vector2(6.5, -1.0), str(field.get("name", "")), Color("b8ffc8"))


func _draw_atlas() -> void:
	for city in atlas.placed:
		var id := str(city.get("id", ""))
		var tier := int(city.get("tier", 3))
		var radius := 5.0 if tier == 1 else 3.5
		var fill := Color("ffd27a") if tier == 1 else (Color("9ecbff") if tier == 2 else Color("c5d0e6"))
		fill.a = 0.85
		var hot := id == atlas.hover_id or id == atlas.selected_id
		for s in _screens(float(city["lx"]), float(city["ly"])):
			draw_circle(s, radius, fill)
			draw_arc(s, radius, 0, TAU, 20, Color.WHITE if hot else Color(0, 0, 0, 0.45), 2.0 if id == atlas.selected_id else 1.0, true)
			if _show_name(id == atlas.hover_id, id == atlas.selected_id):
				_paint_label(s + Vector2(radius + 2.0, -1.0), str(city.get("name", "")), Color("ffe6a8"))


func _draw_sites() -> void:
	for place in sites.places:
		var id := int(place["id"])
		var kind := str(place["kind"])
		var radius := 7.0 if kind == "capital" else (4.5 if kind == "city" else 3.5)
		var fill: Color = OWNER.get(str(place["owner"]), OWNER["neutral"])
		var hot := id == sites.hover_id or id == sites.selected_id
		var stroke := Color.WHITE if id == sites.selected_id else Color(0, 0, 0, 0.75)
		var width := 2.0 if id == sites.selected_id else 1.0
		for s in _screens(float(place["logic_x"]), float(place["logic_y"])):
			if hot:
				draw_circle(s, radius + 5.0, Color(1, 1, 1, 0.22))
			if kind == "capital":
				_diamond(s, radius, fill, stroke, width)
			elif kind == "facility":
				draw_circle(s, radius, fill)
				draw_arc(s, radius, 0, TAU, 20, stroke, width, true)
			else:
				var rect := Rect2(s.x - radius, s.y - radius, radius * 2.0, radius * 2.0)
				draw_rect(rect, fill)
				draw_rect(rect, stroke, false, width)
			if _show_name(id == sites.hover_id, id == sites.selected_id):
				_paint_label(s + Vector2(-2.0, radius + 18.0), str(place["title"]), Color("f3f6ff"))


func _draw_paths() -> void:
	var blue: MatchState.Token = game.token("blue")
	var red: MatchState.Token = game.token("red")
	var preview_sea := show_preview and not preview.is_empty() and game.selected_domain == "sea"
	var blue_path: Array = [] if blue == null else blue.path
	var red_path: Array = [] if red == null else red.path
	if show_preview and not preview.is_empty() and not preview_sea:
		if game.selected_side == "red":
			red_path = preview
		else:
			blue_path = preview
	var player := game.player_side
	if piece_drawn(blue):
		_draw_path(MatchState.visible_steps(blue_path, "blue", player), BLUE_PATH)
	if piece_drawn(red):
		_draw_path(MatchState.visible_steps(red_path, "red", player), RED_PATH)
	for unit in game.tokens:
		if unit.domain != "sea" or not piece_drawn(unit):
			continue
		var path: Array = unit.path
		if unit.side == game.selected_side and preview_sea:
			path = preview
		if path.is_empty():
			continue
		var color := BLUE_PATH if unit.side == "blue" else RED_PATH
		_draw_path(MatchState.visible_steps(path, unit.side, game.player_side), color)


func _draw_path(path: Array, color: Color) -> void:
	for step in path:
		var center := cell_center(int(step["x"]), int(step["y"]))
		var word := str(step["word"])
		var col := color if word == "open" or word == "sea" else SLOW_DOT
		for s in _screens(center.x, center.y):
			draw_rect(Rect2(s.x - 1.5, s.y - 1.5, 3.0, 3.0), col)


func _draw_tokens() -> void:
	repair_caption = ""
	repair_bar_text = ""
	var cell_px := source_scale * view_scale
	for unit in game.tokens:
		if not piece_drawn(unit):
			continue
		var center := cell_center(unit.x, unit.y)
		var selected := _token_selected(unit)
		var word := TerrainMap.pace_word(terrain.id_at(unit.x, unit.y))
		var kind := "sea" if unit.domain == "sea" else Roster.token_kind(era_year, word)
		if unit.domain != "sea" and unit.transporting:
			kind = "transport"
		var tex: Texture2D = sea_tex if kind == "sea" else (land_tex if kind == "land" else (transport_tex if kind == "transport" else null))
		var sprite := tex if cell_px >= 14.0 and tex != null else null
		var owned := marked_piece(unit)
		for s in _screens(center.x, center.y):
			var mark := Rect2()
			if sprite != null:
				var h := minf(22.0, maxf(14.0, cell_px * 0.7))
				var w := h * float(sprite.get_width()) / float(sprite.get_height())
				var rect := Rect2(s.x - w * 0.5, s.y - h - 6.0, w, h)
				draw_texture_rect(sprite, rect, false)
				var outline := Color("7eb6ff") if unit.side == "blue" else Color("ff8d8d")
				draw_rect(rect.grow(1.0), outline, false, 2.0 if selected else 1.0)
				mark = rect
			else:
				var radius := 10.0 if selected else 8.0
				var fill := Color("1d4ed8") if unit.side == "blue" else Color("b91c1c")
				draw_circle(s, radius, fill)
				draw_arc(s, radius, 0, TAU, 24, Color.WHITE, 3.0 if selected else 1.5, true)
				mark = Rect2(s.x - radius, s.y - radius, radius * 2.0, radius * 2.0)
			if owned:
				_draw_owned_mark(mark)
			elif unit.revealed and unit.side != game.player_side:
				_paint_label(Vector2(mark.position.x, mark.end.y + 16.0), "Revealed", Color("e4ecff"))
			if unit.entrenched:
				_paint_label(Vector2(mark.position.x, mark.position.y - 18.0), "Entrenched", Color("d6c07a"))
			elif game.submarine_hidden(unit) and unit.side == game.player_side:
				_paint_label(Vector2(mark.position.x, mark.position.y - 18.0), "Hidden", Color("d6c07a"))
			elif unit.label == "Aircraft" and unit.idle_rounds > 0:
				_paint_label(Vector2(mark.position.x, mark.position.y - 18.0), "Inactive %d" % unit.idle_rounds, Color("d6c07a"))
			if game.repairing(unit):
				var label_at := Vector2(mark.position.x, mark.end.y + 16.0)
				_paint_label(label_at, "Repairing", Color("d6c07a"))
				draw_rect(Rect2(label_at.x, label_at.y + 4.0, 18.0, 4.0), Color("d6c07a"), false, 1.0)
				repair_caption = "Repairing"
				repair_bar_text = ""


func _draw_feedback() -> void:
	if game == null:
		return
	if game.pulse == "intel":
		draw_arc(size * 0.5, 36.0, 0, TAU, 32, Color("4ecdc4"), 3.0, true)
	if game.flash_kind != "" and game.flash_cell.x > -900:
		var at := cell_center(game.flash_cell.x, game.flash_cell.y)
		for s in _screens(at.x, at.y):
			draw_rect(Rect2(s.x - 14.0, s.y - 14.0, 28.0, 28.0), Color("ff8d8d"), false, 2.0)
	if not game.satellites.is_empty():
		draw_circle(Vector2(28, 28), 5.0, Color("7eb6ff"))
	for mark in game.contacts:
		var at := cell_center(int(mark.get("x", 0)), int(mark.get("y", 0)))
		for s in _screens(at.x, at.y):
			draw_rect(Rect2(s.x - 6.0, s.y - 6.0, 12.0, 12.0), Color("d6c07a"), false, 1.5)


func _draw_owned_mark(rect: Rect2) -> void:
	var box := rect.grow(4.0)
	var col := Color("4ecdc4")
	var arm := minf(8.0, minf(box.size.x, box.size.y) * 0.45)
	var width := 2.0
	var tl := box.position
	var tr := Vector2(box.end.x, box.position.y)
	var bl := Vector2(box.position.x, box.end.y)
	var br := box.end
	draw_line(tl, tl + Vector2(arm, 0.0), col, width)
	draw_line(tl, tl + Vector2(0.0, arm), col, width)
	draw_line(tr, tr + Vector2(-arm, 0.0), col, width)
	draw_line(tr, tr + Vector2(0.0, arm), col, width)
	draw_line(bl, bl + Vector2(arm, 0.0), col, width)
	draw_line(bl, bl + Vector2(0.0, -arm), col, width)
	draw_line(br, br + Vector2(-arm, 0.0), col, width)
	draw_line(br, br + Vector2(0.0, -arm), col, width)
	_paint_label(Vector2(box.position.x, box.end.y + 16.0), "Yours", col)


func _token_selected(unit: MatchState.Token) -> bool:
	if game.focus != null:
		return game.focus == unit
	if game.selected_side != unit.side:
		return false
	if game.selected_domain == "":
		return unit.domain != "sea"
	return unit.domain == game.selected_domain


func _show_name(hot: bool, selected: bool) -> bool:
	return hot or selected or labels_on or _names_close()


func _names_close() -> bool:
	if logic_w <= 0.0 or view_scale <= 0.0 or size.x < 2.0:
		return false
	return size.x / (logic_w * view_scale) < 0.28


func _diamond(center: Vector2, radius: float, fill: Color, stroke: Color, width: float) -> void:
	var pts := PackedVector2Array([
		center + Vector2(0, -radius),
		center + Vector2(radius, 0),
		center + Vector2(0, radius),
		center + Vector2(-radius, 0),
	])
	draw_colored_polygon(pts, fill)
	var line := pts.duplicate()
	line.append(pts[0])
	draw_polyline(line, stroke, width, true)


func _paint_label(at: Vector2, text: String, color: Color) -> void:
	if text == "":
		return
	var font := ThemeDB.fallback_font
	if font == null:
		return
	var font_size := 12
	var width := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x
	draw_rect(Rect2(at.x, at.y - 15.0, width + 6.0, 16.0), Color(0, 0, 0, 0.6))
	draw_string(font, at + Vector2(3, -2), text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, color)


func _update_k_range() -> void:
	var x0 := (0.0 - pan_x) / view_scale
	var x1 := (size.x - pan_x) / view_scale
	_k0 = int(floor(x0 / logic_w)) - 1
	_k1 = int(floor(x1 / logic_w)) + 1


func _world_to_screen(wx: float, wy: float) -> Vector2:
	return Vector2(pan_x + wx * view_scale, pan_y + wy * view_scale)


func _screens(logic_x: float, logic_y: float) -> Array[Vector2]:
	var out: Array[Vector2] = []
	for k in range(_k0, _k1 + 1):
		var s := _world_to_screen(logic_x + float(k) * logic_w, logic_y)
		if s.x < -80.0 or s.x > size.x + 80.0:
			continue
		if s.y < -80.0 or s.y > size.y + 80.0:
			continue
		out.append(s)
	return out


func _chip_style() -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = Color(0.039, 0.063, 0.110, 0.82)
	box.border_color = Color("243049")
	box.set_border_width_all(1)
	box.set_corner_radius_all(6)
	box.set_content_margin_all(6)
	return box
