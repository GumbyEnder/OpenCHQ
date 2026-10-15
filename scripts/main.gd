extends Control

const MapViewScript = preload("res://scripts/map_view.gd")
const HudScript = preload("res://scripts/hud.gd")
const StartScreenScript = preload("res://scripts/start_screen.gd")
const StillsScript = preload("res://scripts/stills.gd")

var pack: DataPack
var terrain: TerrainMap
var sites: SiteBook
var oil: OilLayer
var atlas: AtlasLayer
var game: MatchState
var stills
var map: MapView
var hud: Hud
var start_screen: Control
var drawer_button: Button

var era_year := 1986
var player_side := "blue"
var started := false
var time_on := false
var pixel_filter := true
var labels_on := false
var oil_user_off := false
var inspect := {}
var preview_key := ""
var log_lines: PackedStringArray = []
var _drawer_open := false
var _was_narrow := false
var _clock: Timer


func _ready() -> void:
	_apply_start_size()
	set_anchors_preset(Control.PRESET_FULL_RECT)
	map = MapViewScript.new()
	map.visible = false
	add_child(map)
	hud = HudScript.new()
	hud.visible = false
	add_child(hud)
	hud.command.connect(_on_command)
	start_screen = StartScreenScript.new()
	start_screen.z_index = 20
	add_child(start_screen)
	start_screen.connect("begin_match", _begin_match)
	drawer_button = Button.new()
	drawer_button.text = "Controls"
	drawer_button.position = Vector2(12, 8)
	drawer_button.visible = false
	drawer_button.z_index = 10
	drawer_button.pressed.connect(_toggle_drawer)
	add_child(drawer_button)
	map.clicked.connect(_on_click)
	map.hovered.connect(_on_hover)
	var err := _load_pack()
	if err != "":
		_fail(err)
		return
	_clock = Timer.new()
	_clock.wait_time = 0.14
	_clock.timeout.connect(_on_tick)
	add_child(_clock)
	_clock.start()
	resized.connect(_on_resized)
	_boot()


func _apply_start_size() -> void:
	var win := get_window()
	if win == null:
		return
	win.mode = Window.MODE_WINDOWED
	win.size = Vector2i(2000, 1000)


func _boot() -> void:
	if size.x < 2.0:
		await get_tree().process_frame
	_on_resized()
	_reset_state()
	map.fit_view()
	_sync()
	var shot := OS.get_environment("OPENCHQ_SHOT")
	if shot != "":
		for _i in 4:
			await RenderingServer.frame_post_draw
		var image := get_viewport().get_texture().get_image()
		var save_err := image.save_png(shot)
		print("SHOT %s %s" % [shot, error_string(save_err)])
		get_tree().quit(0 if save_err == OK else 1)
		return
	if OS.get_environment("OPENCHQ_SMOKE") == "1":
		await get_tree().process_frame
		var win := get_window()
		print("SMOKE window %s root %s map %s" % [win.size, size, map.size])
		if win.size != Vector2i(2000, 1000) or size != Vector2(2000, 1000):
			print("SMOKE_FAIL expected 2000x1000")
			get_tree().quit(1)
			return
		if map.size.x != 1660.0 or map.size.y != 1000.0:
			print("SMOKE_FAIL map should be 1660x1000 beside the 340-wide panel")
			get_tree().quit(1)
			return
		print("SMOKE_OK sites=%d" % sites.count())
		get_tree().quit(0)


func _load_pack() -> String:
	pack = DataPack.new()
	var err := pack.open()
	if err != "":
		return err
	var map_res := pack.json_dict("data/map_res.json")
	var logic_w := float(map_res.get("logic_w", 30720))
	var logic_h := float(map_res.get("logic_h", 13632))
	var source_scale := float(map_res.get("scale_from_source", 96))
	terrain = TerrainMap.new()
	err = terrain.load_bytes(pack.bytes("data/tmap.bin"))
	if err != "":
		return err
	var countries: Array = pack.json_dict("data/game_meta.json").get("countries", [])
	sites = SiteBook.new()
	err = sites.load_sites(pack.json_array("data/sites.json"), countries, source_scale)
	if err != "":
		return err
	if sites.capital("blue") == null or sites.capital("red") == null:
		return "The site list has no blue and red capitals."
	terrain.paint_sites(sites.places)
	oil = OilLayer.new()
	oil.load_doc(pack.json_any("data/resources_oil.json"), logic_w, logic_h)
	atlas = AtlasLayer.new()
	atlas.load_doc(pack.json_any("data/cities_capitals.json"), logic_w, logic_h)
	atlas.visible = false
	game = MatchState.new()
	game.terrain = terrain
	game.sites = sites
	var lanes := SeaLanes.new()
	err = lanes.load_bytes(pack.bytes("exe/CHQ_unpacked.EXE"))
	if err != "":
		return err
	game.sea = lanes
	game.reset()
	var map_tex := pack.texture("pics/WORLD_MAP.png")
	if map_tex == null:
		return "Map image missing: pics/WORLD_MAP.png"
	map.logic_w = logic_w
	map.logic_h = logic_h
	map.source_scale = source_scale
	map.map_tex = map_tex
	map.land_tex = pack.texture(Roster.ART_LAND)
	map.transport_tex = pack.texture(Roster.ART_TRANSPORT)
	map.sea_tex = pack.texture(Roster.ART_SEA)
	map.terrain = terrain
	map.sites = sites
	map.oil = oil
	map.atlas = atlas
	map.game = game
	stills = StillsScript.new()
	stills.load_pack(pack)
	_bind_stills()
	return ""


func _fail(message: String) -> void:
	if start_screen != null:
		start_screen.visible = false
	var lab := Label.new()
	lab.text = message
	lab.z_index = 30
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lab.set_anchors_preset(Control.PRESET_FULL_RECT)
	lab.offset_left = 24
	lab.offset_top = 24
	lab.offset_right = -24
	lab.offset_bottom = -24
	add_child(lab)
	push_error(message)
	if OS.get_environment("OPENCHQ_SMOKE") == "1":
		print("SMOKE_FAIL %s" % message)
		get_tree().quit(1)


func _on_resized() -> void:
	if map == null or size.x < 2.0:
		return
	var was_fit := map.is_near_fit()
	_layout()
	if was_fit:
		map.fit_view()
	else:
		map.queue_redraw()
	_sync_zoom()


func _layout() -> void:
	var narrow := size.x < 760.0
	if narrow and not _was_narrow:
		_drawer_open = false
	_was_narrow = narrow
	drawer_button.visible = narrow
	if narrow:
		var panel_h := minf(size.y * 0.72, 560.0)
		hud.size = Vector2(size.x, panel_h)
		if _drawer_open:
			hud.position = Vector2(0, size.y - panel_h)
			map.position = Vector2.ZERO
			map.size = Vector2(size.x, maxf(1.0, size.y - panel_h))
		else:
			hud.position = Vector2(0, size.y)
			map.position = Vector2.ZERO
			map.size = size
	else:
		var panel_w := 340.0
		map.position = Vector2.ZERO
		map.size = Vector2(size.x - panel_w, size.y)
		hud.position = Vector2(size.x - panel_w, 0)
		hud.size = Vector2(panel_w, size.y)
	map._place_overlay()
	if start_screen != null:
		start_screen.visible = not started
		start_screen.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	if not started:
		map.visible = false
		hud.visible = false
		drawer_button.visible = false
	else:
		map.visible = true
		hud.visible = true


func _begin_match(year: int, side: String) -> void:
	if started:
		return
	player_side = "red" if side == "red" else "blue"
	if game != null:
		game.player_side = player_side
		game.note = "You are %s. Your land piece and your ship are marked." % _side_name(player_side)
	started = true
	if start_screen != null and start_screen.has_method("set_winner"):
		start_screen.call("set_winner", "")
	if get_viewport() != null:
		get_viewport().gui_release_focus()
	_set_era(year)
	_layout()
	_frame_owned()
	var who := "Red" if player_side == "red" else "Blue"
	_log("%d original sites. Era %s. Side %s." % [sites.count(), _era_name(era_year), who])
	_sync()


func _toggle_drawer() -> void:
	var was_fit := map.is_near_fit()
	var center := Vector2.ZERO
	if map.view_scale > 0.0:
		center = map.screen_to_world_raw(map.size * 0.5)
	_drawer_open = not _drawer_open
	_layout()
	if was_fit:
		map.fit_view()
	elif map.view_scale > 0.0:
		map.pan_x = map.size.x * 0.5 - center.x * map.view_scale
		map.pan_y = map.size.y * 0.5 - center.y * map.view_scale
		map.queue_redraw()
	_sync_zoom()


func _on_command(action: String, arg: Variant) -> void:
	if not started:
		return
	match action:
		"fit":
			_fit()
		"zoom":
			_zoom_selection()
		"start":
			_return_to_start()
		"reset":
			_reset_state()
			_frame_owned()
			_log("Opening view restored")
			_sync()
		"time":
			_toggle_time()
		"atlas":
			_toggle_atlas()
		"oil":
			_toggle_oil()
		"labels":
			_toggle_labels()
		"nuke", "satellite", "foreign_aid", "intel":
			var line := game.use_tool(player_side, action)
			if line != "":
				game.note = line
				_log(line)
			_sync()
		"era":
			_set_era(int(arg))
			_log("Era %s" % _era_name(era_year))
		"filter":
			pixel_filter = str(arg) == "pixel"
			map.set_pixel_filter(pixel_filter)
			_sync()
		"tier":
			atlas.set_max_tier(int(arg))
			map.queue_redraw()
		"still":
			_show_stills(str(arg))


func _unhandled_input(event: InputEvent) -> void:
	if not event is InputEventKey:
		return
	var key := event as InputEventKey
	if not key.pressed or key.echo:
		return
	var focus := get_viewport().gui_get_focus_owner()
	if not started:
		return
	if focus is LineEdit or focus is TextEdit or focus is OptionButton:
		return
	match key.keycode:
		KEY_R:
			_on_command("reset", null)
		KEY_F:
			_fit()
		KEY_L:
			_toggle_labels()
		KEY_O:
			_toggle_oil()
		KEY_A:
			_toggle_atlas()
		KEY_T:
			_toggle_time()
		_:
			return
	get_viewport().set_input_as_handled()


func _frame_owned() -> void:
	if map == null or game == null or map.size.x < 2.0:
		return
	var points: Array[Vector2] = []
	var land := game.token(player_side)
	var ship := game.sea_token(player_side)
	if land != null:
		points.append(map.cell_center(land.x, land.y))
	if ship != null:
		points.append(map.cell_center(ship.x, ship.y))
	if points.size() < 2:
		map.fit_view()
		return
	map.frame_points(points)


func _fit() -> void:
	map.fit_view()
	_log("Fit the whole map")
	_sync_zoom()


func _zoom_selection() -> void:
	var target: Variant = _selected_world()
	if target == null:
		_log("Select a site or your piece first")
		return
	map.zoom_to(target)
	_log("Zoomed to the selection")
	_sync_zoom()
	map.queue_redraw()


func _toggle_time() -> void:
	if game.winner() != "":
		return
	time_on = not time_on
	_log("Time running" if time_on else "Time held")
	_sync()


func _toggle_atlas() -> void:
	atlas.visible = not atlas.visible
	if not atlas.visible:
		atlas.hover_id = ""
		atlas.selected_id = ""
	_log("Atlas on" if atlas.visible else "Atlas off")
	_sync()
	map.queue_redraw()


func _toggle_oil() -> void:
	if not Roster.tool_open(era_year, "oil"):
		return
	oil.visible = not oil.visible
	oil_user_off = not oil.visible
	if not oil.visible:
		oil.hover_id = ""
		oil.selected_id = ""
	_sync()
	map.queue_redraw()


func _toggle_labels() -> void:
	labels_on = not labels_on
	map.labels_on = labels_on
	_sync()
	map.queue_redraw()


func _set_era(year: int) -> void:
	era_year = year
	map.era_year = year
	if game != null:
		game.era_year = year
	var allow := Roster.tool_open(year, "oil")
	oil.set_era(year)
	if not allow:
		oil.visible = false
	elif not oil_user_off:
		oil.visible = true
	if oil.selected_id != "" and oil.by_id(oil.selected_id) == null:
		oil.selected_id = ""
		if str(inspect.get("kind", "")) == "oil":
			inspect = {}
	hud.set_roster(_roster_entries(), Roster.notes_for(era_year))
	_sync()
	map.queue_redraw()


func _return_to_start() -> void:
	if not started or game == null or game.winner() == "":
		return
	var who := game.winner()
	time_on = false
	started = false
	log_lines = PackedStringArray()
	if hud != null:
		hud.set_log("")
	_reset_state()
	_sync()
	if start_screen != null and start_screen.has_method("set_winner"):
		start_screen.call("set_winner", who)
	_layout()


func _reset_state() -> void:
	time_on = false
	pixel_filter = true
	labels_on = false
	oil_user_off = false
	inspect = {}
	preview_key = ""
	map.show_preview = false
	map.preview = []
	map.labels_on = false
	map.set_pixel_filter(true)
	sites.selected_id = -1
	sites.hover_id = -1
	atlas.visible = false
	atlas.hover_id = ""
	atlas.selected_id = ""
	atlas.set_max_tier(1)
	oil.hover_id = ""
	oil.selected_id = ""
	map.set_chip("terrain", "—")
	_set_era(1986)
	game.reset()
	_show_idle()


func _on_tick() -> void:
	if not time_on or game == null or game.winner() != "":
		return
	for line in game.tick():
		_log(str(line))
	_sync()
	map.queue_redraw()


func _on_hover(world: Vector2) -> void:
	if not started:
		return
	var cell := map.cell_of(world)
	var tid := terrain.id_at(cell.x, cell.y)
	map.set_chip("terrain", "%s · %s" % [TerrainMap.terrain_name(tid), TerrainMap.pace_word(tid)])
	var hit := map.marker_hit()
	var site: Variant = sites.pick(world.x, world.y, hit)
	var city: Variant = atlas.pick(world.x, world.y, hit) if atlas.visible else null
	var field: Variant = oil.pick(world.x, world.y, hit) if oil.visible else null
	var next_site := int(site["id"]) if site is Dictionary else -1
	var next_city := ""
	var next_oil := ""
	if not site is Dictionary and city is Dictionary:
		next_city = str(city["id"])
	if not site is Dictionary and not city is Dictionary and field is Dictionary:
		next_oil = str(field["id"])
	var changed := sites.hover_id != next_site or atlas.hover_id != next_city or oil.hover_id != next_oil
	sites.hover_id = next_site
	atlas.hover_id = next_city
	oil.hover_id = next_oil
	if game.selected_side == player_side:
		var key := "%d,%d" % [cell.x, cell.y]
		if key != preview_key:
			preview_key = key
			var unit := game.ordered_unit(player_side)
			var found: Variant = null
			if unit != null and unit.domain == "sea":
				found = game.ship_route(unit.x, unit.y, cell.x, cell.y, unit.ship_class)
			else:
				var other := game.token(_opponent_side())
				var conceal := game.opponent_hidden()
				var blocked := func(nx: int, ny: int) -> bool:
					if conceal:
						return false
					return other.x == nx and other.y == ny
				found = terrain.route(unit.x, unit.y, cell.x, cell.y, blocked)
			map.preview = found if found is Array else []
			map.show_preview = true
			changed = true
	elif map.show_preview:
		map.show_preview = false
		map.preview = []
		preview_key = ""
		changed = true
	if changed:
		map.queue_redraw()


func _on_click(world: Vector2) -> void:
	if not started:
		return
	get_viewport().gui_release_focus()
	var cell := map.cell_of(world)
	var picked := _pick(world)
	sites.selected_id = -1
	atlas.selected_id = ""
	oil.selected_id = ""
	var mine := player_side
	var who := _side_name(mine)
	if game.selected_side == mine and not (str(picked.get("kind", "")) == "token" and str(picked.get("side", "")) == mine):
		var refused := game.order(mine, cell.x, cell.y)
		_log(refused if refused != "" else game.note)
		var site: Variant = sites.at_cell(cell.x, cell.y)
		if site is Dictionary:
			sites.selected_id = int(site["id"])
			_show_site(site)
		map.show_preview = false
		map.preview = []
		preview_key = ""
		_sync()
		map.queue_redraw()
		return
	if str(picked.get("kind", "")) == "token" and str(picked.get("side", "")) == mine:
		game.selected_side = mine
		game.selected_domain = str(picked.get("domain", "land"))
		var home_unit := game.ordered_unit(mine)
		var home: Variant = sites.at_cell(home_unit.x, home_unit.y)
		if home is Dictionary:
			sites.selected_id = int(home["id"])
			_show_site(home)
		elif home_unit.domain == "sea":
			_show_sea(home_unit)
		game.note = "%s sea piece selected. Click a destination." % who if home_unit.domain == "sea" else "%s piece selected. Click a destination." % who
		_log("%s sea piece selected" % who if home_unit.domain == "sea" else "%s piece selected" % who)
		_sync()
		map.queue_redraw()
		return
	game.selected_side = ""
	game.selected_domain = ""
	map.show_preview = false
	map.preview = []
	preview_key = ""
	match picked.get("kind", ""):
		"token":
			_log("%s moves on its own" % _side_name(_opponent_side()))
			var home_red: Variant = sites.at_cell(game.token(_opponent_side()).x, game.token(_opponent_side()).y)
			if home_red is Dictionary:
				sites.selected_id = int(home_red["id"])
				_show_site(home_red)
		"site":
			var chosen: Dictionary = picked["site"]
			sites.selected_id = int(chosen["id"])
			_show_site(chosen)
			_log(str(chosen["title"]))
		"city":
			var city: Dictionary = picked["city"]
			atlas.selected_id = str(city["id"])
			_show_city(city)
		"oil":
			var field: Dictionary = picked["field"]
			oil.selected_id = str(field["id"])
			_show_oil(field)
			_log(str(field.get("name", "")))
		_:
			_show_idle()
	_sync()
	map.queue_redraw()


func _pick(world: Vector2) -> Dictionary:
	var hit := map.marker_hit()
	var best: MatchState.Token = null
	var best_d := hit * 1.35
	for unit in game.tokens:
		if not game.shows_piece(unit):
			continue
		var dist := map.cell_center(unit.x, unit.y).distance_to(world)
		if dist > best_d:
			continue
		if best == null or dist < best_d:
			best = unit
			best_d = dist
	if best != null:
		return {"kind": "token", "side": best.side, "domain": best.domain}
	var site: Variant = sites.pick(world.x, world.y, hit)
	if site is Dictionary:
		return {"kind": "site", "site": site}
	if atlas.visible:
		var city: Variant = atlas.pick(world.x, world.y, hit)
		if city is Dictionary:
			return {"kind": "city", "city": city}
	if oil.visible:
		var field: Variant = oil.pick(world.x, world.y, hit)
		if field is Dictionary:
			return {"kind": "oil", "field": field}
	return {"kind": "ground"}


func _selected_world() -> Variant:
	if game.selected_side != "":
		var unit := game.ordered_unit(game.selected_side)
		return map.cell_center(unit.x, unit.y)
	match str(inspect.get("kind", "")):
		"site":
			var site: Variant = sites.by_id(int(inspect.get("id", -1)))
			if site is Dictionary:
				return Vector2(float(site["logic_x"]), float(site["logic_y"]))
		"oil":
			var field: Variant = oil.by_id(str(inspect.get("id", "")))
			if field is Dictionary:
				return Vector2(float(field["lx"]), float(field["ly"]))
		"city":
			var city: Variant = atlas.by_id(str(inspect.get("id", "")))
			if city is Dictionary:
				return Vector2(float(city["lx"]), float(city["ly"]))
	return null


func _show_idle() -> void:
	inspect = {}
	hud.set_card("Nothing selected", "Click a site or your piece")


func _show_site(site: Dictionary) -> void:
	inspect = {"kind": "site", "id": int(site["id"])}
	hud.set_card(str(site["title"]), "%s\n%s · %s\ncell (%d, %d)" % [
		str(site["country"]),
		str(site["kind"]),
		str(site["owner"]),
		int(site["x"]),
		int(site["y"]),
	])


func _show_sea(unit: MatchState.Token) -> void:
	inspect = {"kind": "sea"}
	var access := "May enter ocean, docks, and shallows."
	if unit.ship_class != 0:
		access = "May enter ocean and docks. Shallows are refused."
	hud.set_card("Sea piece", "Sails by the sea lanes.\n%s" % access)


func _show_oil(field: Dictionary) -> void:
	inspect = {"kind": "oil", "id": str(field.get("id", ""))}
	hud.set_card(str(field.get("name", "Oil")), oil.blurb(field))


func _show_city(city: Dictionary) -> void:
	inspect = {"kind": "city", "id": str(city.get("id", ""))}
	hud.set_card(str(city.get("name", "")), "%s\natlas tier %s\nNot one of the 84 original sites." % [
		str(city.get("country", "")),
		str(city.get("tier", "")),
	])


func _refresh_card() -> void:
	match str(inspect.get("kind", "")):
		"site":
			var site: Variant = sites.by_id(int(inspect.get("id", -1)))
			if site is Dictionary:
				_show_site(site)
		"oil":
			var field: Variant = oil.by_id(str(inspect.get("id", "")))
			if field is Dictionary:
				_show_oil(field)
		"city":
			var city: Variant = atlas.by_id(str(inspect.get("id", "")))
			if city is Dictionary:
				_show_city(city)
		_:
			if inspect.is_empty():
				_show_idle()


func _sync() -> void:
	if hud == null or game == null:
		return
	var won := game.winner() != ""
	hud.set_orders(player_side, game.opponent_hidden())
	hud.set_result(game.winner())
	map.set_note(game.note, won)
	hud.set_note(game.note, won)
	hud.set_running(time_on)
	var oil_open := Roster.tool_open(era_year, "oil")
	hud.set_toggles(atlas.visible, oil.visible and oil_open, oil_open, labels_on)
	hud.set_era(era_year)
	hud.set_tools({
		"nuke": Roster.tool_open(era_year, "nuke"),
		"satellite": Roster.tool_open(era_year, "satellite"),
		"foreign_aid": Roster.tool_open(era_year, "foreign_aid"),
		"intel": Roster.tool_open(era_year, "intel"),
	})
	hud.set_filter_pixel(pixel_filter)
	hud.set_tier(atlas.max_tier)
	hud.set_atlas_row(atlas.visible)
	map.set_chip("beat", "beat %d" % game.beat)
	map.set_chip("time", "time %s" % ("running" if time_on else "held"))
	map.set_chip("capitals", "capitals %s" % _capital_score())
	map.set_chip("sites", "sites %d" % sites.count())
	var oil_text := "off"
	if game.shortage():
		oil_text = "short"
	elif oil.visible and Roster.tool_open(era_year, "oil"):
		oil_text = str(oil.count())
	map.set_chip("oil", "oil %s" % oil_text)
	_sync_zoom()
	_refresh_card()


func _sync_zoom() -> void:
	if map != null:
		map.set_chip("zoom", map.zoom_text())


func _capital_score() -> String:
	var blue_n := 0
	var red_n := 0
	for place in sites.places:
		if str(place["kind"]) != "capital":
			continue
		if str(place["owner"]) == "blue":
			blue_n += 1
		elif str(place["owner"]) == "red":
			red_n += 1
	return "%d–%d" % [blue_n, red_n]


func _bind_stills() -> void:
	if hud == null or stills == null:
		return
	if stills.names.is_empty():
		hud.set_still_catalog(PackedStringArray(), StillsScript.MISSING_NOTE)
		hud.set_still_sheet([])
		return
	hud.set_still_catalog(stills.names, StillsScript.NOTE)
	_show_stills(stills.names[0])


func _show_stills(stem: String) -> void:
	if pack == null or stills == null or hud == null:
		return
	var entries: Array = []
	for rel in stills.files_for(stem):
		entries.append({
			"name": rel.get_file(),
			"texture": pack.texture(rel),
		})
	hud.set_still_sheet(entries)


func _roster_entries() -> Array:
	var entries: Array = []
	for row in Roster.rows_for(era_year):
		entries.append({
			"name": str(row["name"]),
			"texture": pack.texture(str(row["file"])),
		})
	return entries


func _era_name(year: int) -> String:
	return "????" if year >= 9999 else str(year)


func _side_name(side: String) -> String:
	return "Red" if side == "red" else "Blue"


func _opponent_side() -> String:
	return "red" if player_side == "blue" else "blue"


func _log(message: String) -> void:
	if hud == null:
		return
	log_lines.insert(0, "[%s] %s" % [Time.get_time_string_from_system(), message])
	if log_lines.size() > 12:
		log_lines.resize(12)
	hud.set_log("\n".join(log_lines))
