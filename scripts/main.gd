extends Control

const MapViewScript = preload("res://scripts/map_view.gd")
const HudScript = preload("res://scripts/hud.gd")
const StartScreenScript = preload("res://scripts/start_screen.gd")
const BuyScreenScript = preload("res://scripts/buy_screen.gd")
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
var buy_screen: PanelContainer
var drawer_button: Button

var era_year := 1986
var player_side := "blue"
var started := false
var buying := false
var match_buy := false
var _buy_kind := ""
var time_on := false
var pixel_filter := true
var labels_on := false
var oil_user_off := false
var inspect := {}
var preview_key := ""
var log_lines: PackedStringArray = []
var _drawer_open := false
var _was_narrow := false
var stills_open := false
var _still_stem := ""
## land, sea, or bomb. Empty until the player picks a mission.
var _air_pick := ""
## Set while an infantry paradrop is waiting for a cell.
var _drop_pick := false
## Set while foreign aid is waiting for a city.
var _aid_pick := false
## Set while a nuke launch is waiting for a city.
var _nuke_pick := false
var _clock: Timer
var follow_on := false
var pause_open := false
var pause_layer: Control
var coach: Control
var minimap: Control
var tones
var _toast_seen := ""
var _winner_seen := ""
var _pulse_hold := 0
const _Tones = preload("res://scripts/tones.gd")
const _Minimap = preload("res://scripts/minimap.gd")


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
	_build_layers()
	start_screen = StartScreenScript.new()
	start_screen.z_index = 20
	add_child(start_screen)
	start_screen.connect("begin_match", _open_buy)
	buy_screen = BuyScreenScript.new()
	buy_screen.visible = false
	buy_screen.z_index = 15
	add_child(buy_screen)
	buy_screen.connect("kind_chosen", _arm_buy)
	buy_screen.connect("begin_pressed", _finish_buy)
	buy_screen.connect("back_pressed", _cancel_buy)
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


func _build_layers() -> void:
	tones = _Tones.new()
	tones.attach(self)
	coach = _coach_panel()
	coach.z_index = 12
	coach.visible = false
	add_child(coach)
	pause_layer = _pause_panel()
	pause_layer.z_index = 30
	pause_layer.visible = false
	add_child(pause_layer)
	minimap = _Minimap.new()
	minimap.game = game
	minimap.sites = sites
	minimap.enemy_capital.connect(_center_enemy_capital)
	hud.host_extra(minimap)


func _coach_panel() -> Control:
	var panel := PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.position = Vector2(16, 16)
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.06, 0.09, 0.16, 0.88)
	style.border_color = Color("4ecdc4")
	style.set_border_width_all(1)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 10
	style.content_margin_bottom = 10
	panel.add_theme_stylebox_override("panel", style)
	var box := VBoxContainer.new()
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	box.add_theme_constant_override("separation", 4)
	panel.add_child(box)
	for line in ["Select your piece.", "Click a destination.", "Press Run."]:
		var lab := Label.new()
		lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
		lab.text = line
		lab.add_theme_color_override("font_color", Color("e4ecff"))
		box.add_child(lab)
	var dismiss := Button.new()
	dismiss.text = "Dismiss"
	dismiss.mouse_filter = Control.MOUSE_FILTER_STOP
	dismiss.pressed.connect(func() -> void:
		coach.visible = false
	)
	box.add_child(dismiss)
	return panel


func _pause_panel() -> Control:
	var layer := Control.new()
	layer.set_anchors_preset(Control.PRESET_FULL_RECT)
	layer.mouse_filter = Control.MOUSE_FILTER_STOP
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.55)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	layer.add_child(dim)
	var card := PanelContainer.new()
	card.position = Vector2(80, 80)
	card.custom_minimum_size = Vector2(360, 0)
	var style := StyleBoxFlat.new()
	style.bg_color = Color("10182a")
	style.border_color = Color("243049")
	style.set_border_width_all(1)
	style.content_margin_left = 14
	style.content_margin_right = 14
	style.content_margin_top = 14
	style.content_margin_bottom = 14
	card.add_theme_stylebox_override("panel", style)
	layer.add_child(card)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	card.add_child(box)
	var title := Label.new()
	title.text = "Paused"
	title.add_theme_color_override("font_color", Color("4ecdc4"))
	box.add_child(title)
	box.add_child(_menu_button("Resume", func() -> void:
		_set_pause(false)
	))
	box.add_child(_menu_button("Restart", func() -> void:
		var ask := pause_layer.find_child("restart_ask", true, false)
		if ask != null:
			ask.visible = true
	))
	var ask := VBoxContainer.new()
	ask.name = "restart_ask"
	ask.visible = false
	var prompt := Label.new()
	prompt.text = "Restart this match?"
	ask.add_child(prompt)
	ask.add_child(_menu_button("Confirm", func() -> void:
		ask.visible = false
		_set_pause(false)
		_on_command("reset", null)
	))
	box.add_child(ask)
	box.add_child(_menu_button("Quit", func() -> void:
		_quit_to_era()
	))
	box.add_child(_menu_button("Save", func() -> void:
		_save_match()
	))
	box.add_child(_menu_button("Load", func() -> void:
		_load_match()
	))
	for row in hud.detach_match_menus():
		box.add_child(row)
	return layer


func _menu_button(text: String, on_press: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(on_press)
	return button


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
	game.country_names = countries
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
	if minimap != null:
		minimap.game = game
		minimap.sites = sites
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
	if buy_screen != null:
		buy_screen.position = hud.position
		buy_screen.size = hud.size
	if start_screen != null:
		start_screen.visible = not started and not buying
		start_screen.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	if buying:
		map.visible = true
		hud.visible = false
		if buy_screen != null:
			buy_screen.visible = true
		drawer_button.visible = false
	elif not started:
		map.visible = false
		hud.visible = false
		if buy_screen != null:
			buy_screen.visible = false
		drawer_button.visible = false
	else:
		map.visible = true
		hud.visible = true
		if buy_screen != null:
			buy_screen.visible = false


func _open_buy(year: int, side: String) -> void:
	if started or buying:
		return
	player_side = "red" if side == "red" else "blue"
	_buy_kind = ""
	if start_screen != null and start_screen.has_method("set_winner"):
		start_screen.call("set_winner", "")
	if get_viewport() != null:
		get_viewport().gui_release_focus()
	_set_era(year)
	if game != null:
		game.player_side = player_side
		game.reset()
		game.note = "Purchase New Units"
	buying = true
	match_buy = false
	if buy_screen != null and buy_screen.has_method("set_done"):
		buy_screen.call("set_done", "Begin")
	if buy_screen != null and buy_screen.has_method("set_catalog"):
		buy_screen.call("set_catalog", Roster.buy_rows(era_year))
		var intro := "Your land piece and your ship are already placed. Land and aircraft go in a friendly city. Ships go on a dock. Begin starts the match. Time stays held until Run."
		if era_year == 2023:
			intro = "No army is on the map. Land and aircraft go in a friendly city. Ships go on a dock. %s Begin starts the match. Time stays held until Run." % Assumptions.cash_note()
		elif era_year >= 9999:
			intro = "Your land piece and your ship are already placed. Cities on the map are city-states. The opponent stays hidden until their capital is found. Land and aircraft go in a friendly city. Ships go on a dock. Begin starts the match. Time stays held until Run."
		buy_screen.call("set_intro", intro)
		buy_screen.call("set_status", "Pick a unit, then a cell. Begin starts the match.")
	_layout()
	_frame_owned()
	_sync()


func _arm_buy(kind: String) -> void:
	_buy_kind = kind
	if kind == "Nuke" and game != null:
		var refused := game.place_purchase(player_side, kind, 0, 0)
		_buy_kind = ""
		if buy_screen != null:
			buy_screen.call("set_status", refused)
		_log(refused)


func _open_match_buy() -> void:
	if not started or buying or game == null:
		return
	_buy_kind = ""
	buying = true
	match_buy = true
	if buy_screen != null and buy_screen.has_method("set_catalog"):
		buy_screen.call("set_catalog", Roster.buy_rows(era_year))
		buy_screen.call("set_intro", "The match is running. Stand-in prices are charged. The city becomes unready. The time was not recovered.")
		buy_screen.call("set_status", "Pick a unit, then a cell. Close returns to the match.")
		buy_screen.call("set_done", "Close")
	_layout()
	_sync()


func _close_match_buy() -> void:
	match_buy = false
	buying = false
	_buy_kind = ""
	if buy_screen != null and buy_screen.has_method("set_done"):
		buy_screen.call("set_done", "Begin")
	_layout()
	_sync()


func _cancel_buy() -> void:
	if not buying:
		return
	if match_buy:
		_close_match_buy()
		return
	buying = false
	_buy_kind = ""
	started = false
	_set_era(1986)
	if game != null:
		game.reset()
	_layout()
	_sync()


func _finish_buy() -> void:
	if not buying:
		return
	if match_buy:
		_close_match_buy()
		return
	buying = false
	_buy_kind = ""
	started = true
	if game != null:
		var empty_2023 := era_year == 2023 and game.token(player_side) == null and game.sea_token(player_side) == null
		if empty_2023:
			game.note = "You are %s. 2023 starts with no army. %s" % [_side_name(player_side), Assumptions.cash_note()]
		else:
			game.note = "You are %s. Your land piece and your ship are marked." % _side_name(player_side)
	_layout()
	_frame_owned()
	if coach != null:
		coach.visible = true
	var who := "Red" if player_side == "red" else "Blue"
	_log("%d original sites. Era %s. Side %s." % [sites.count(), _era_name(era_year), who])
	_sync()


func _place_armed(world: Vector2) -> void:
	if game == null:
		return
	if _buy_kind == "":
		var picked: Variant = sites.pick(world.x, world.y, map.marker_hit()) if sites != null else null
		if picked is Dictionary:
			_show_site(picked)
			var kind := str(picked["kind"])
			if era_year >= 9999 and kind == "city":
				kind = "city-state"
			if buy_screen != null:
				buy_screen.call("set_status", "%s · %s · %s" % [str(picked["title"]), kind, str(picked["owner"])])
		elif buy_screen != null:
			buy_screen.call("set_status", "Pick a unit, then a cell.")
		return
	var cell := map.cell_of(world)
	var refused := game.place_purchase(player_side, _buy_kind, cell.x, cell.y, started)
	var line := refused if refused != "" else game.note
	if buy_screen != null:
		buy_screen.call("set_status", line)
	_log(line)
	map.queue_redraw()


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
		"rematch":
			_rematch()
		"follow":
			follow_on = not follow_on
			if follow_on:
				_follow_selection()
			_sync()
		"cancel":
			_cancel_path()
		"piece":
			_select_listed(int(arg))
		"reset":
			_reset_state()
			_frame_owned()
			_log("Opening view restored")
			_sync()
		"time":
			_toggle_time()
		"speed":
			_apply_speed(int(arg))
		"atlas":
			_toggle_atlas()
		"oil":
			_toggle_oil()
		"labels":
			_toggle_labels()
		"buy":
			_open_match_buy()
		"entrench":
			var dug := game.entrench(player_side)
			if dug != "":
				game.note = dug
				_log(dug)
			_sync()
			map.queue_redraw()
		"land_strike", "sea_strike", "bomb":
			_drop_pick = false
			_aid_pick = false
			_nuke_pick = false
			_arm_mission(action)
		"paradrop":
			_air_pick = ""
			_aid_pick = false
			_nuke_pick = false
			_arm_drop()
		"scramble":
			_air_pick = ""
			_drop_pick = false
			_aid_pick = false
			_nuke_pick = false
			var scrambled := game.scramble(player_side, game.focus)
			game.note = scrambled
			_log(scrambled)
			_sync()
			map.queue_redraw()
		"stills":
			stills_open = not stills_open
			hud.set_stills_open(stills_open)
			_log("Stills catalog" if stills_open else "Stills closed")
		"foreign_aid":
			_air_pick = ""
			_drop_pick = false
			_nuke_pick = false
			_arm_aid()
		"nuke":
			_air_pick = ""
			_drop_pick = false
			_aid_pick = false
			_arm_nuke()
		"satellite", "intel":
			_aid_pick = false
			_nuke_pick = false
			var line := game.use_tool(player_side, action)
			if line != "":
				game.note = line
				_log(line)
			_sync()
		"recon", "killer":
			_air_pick = ""
			_drop_pick = false
			_aid_pick = false
			_nuke_pick = false
			var placed := game.place_satellite(player_side, action)
			game.note = placed
			_log(placed)
			_sync()
			map.queue_redraw()
		"cease":
			_air_pick = ""
			_drop_pick = false
			_aid_pick = false
			_nuke_pick = false
			var asked := game.offer_cease(player_side)
			game.note = asked
			_log(asked)
			_sync()
		"cease_yes", "cease_no":
			_air_pick = ""
			_drop_pick = false
			_aid_pick = false
			_nuke_pick = false
			var reply := game.answer_cease(player_side, "yes" if action == "cease_yes" else "no")
			game.note = reply
			_log(reply)
			_sync()
		"era":
			_set_era(int(arg))
			_log("Era %s" % _era_name(era_year))
			_drop_menu_focus()
		"filter":
			pixel_filter = str(arg) == "pixel"
			map.set_pixel_filter(pixel_filter)
			_sync()
			_drop_menu_focus()
		"tier":
			atlas.set_max_tier(int(arg))
			map.queue_redraw()
			_drop_menu_focus()
		"still":
			_show_stills(str(arg))
			_drop_menu_focus()
		"still_next":
			if stills != null and hud != null:
				hud.set_still_note(stills.advance(_still_stem))
			_drop_menu_focus()


## A menu pick leaves the OptionButton focused, which swallows the shortcut keys.
func _drop_menu_focus() -> void:
	var focus := get_viewport().gui_get_focus_owner()
	if focus is OptionButton:
		focus.release_focus()


func _unhandled_input(event: InputEvent) -> void:
	if not event is InputEventKey:
		return
	var key := event as InputEventKey
	if not key.pressed or key.echo:
		return
	if key.keycode == KEY_ESCAPE and started:
		_set_pause(not pause_open)
		get_viewport().set_input_as_handled()
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
		KEY_T, KEY_P:
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
	follow_on = false
	map.fit_view()
	_log("Fit the whole map")
	_sync_zoom()
	if hud != null:
		hud.mark_follow(false)


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
	if not started or game == null or game.winner() != "":
		return
	var line := game.toggle_speed()
	time_on = game.speed_index > 0
	if line != "":
		game.note = line
		_log(line)
	_sync()
	_drop_menu_focus()


## Speeds 1 through 6 all leave the clock interval alone.
func _apply_speed(index: int) -> void:
	if game == null:
		return
	var line := game.set_speed(index)
	time_on = game.speed_index > 0
	if line != "":
		game.note = line
		_log(line)
	_sync()
	_drop_menu_focus()


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


func _sync_oil_cells() -> void:
	if game == null or oil == null:
		return
	var cells: Array = []
	for field in oil.placed:
		cells.append({
			"x": int(float(field.get("map_x", -1))),
			"y": int(float(field.get("map_y", -1))),
			"name": str(field.get("name", "Oil well")),
			"region": str(field.get("region", "")),
		})
	game.set_oil_cells(cells)


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
	_sync_oil_cells()
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
	follow_on = false
	_winner_seen = ""
	_toast_seen = ""
	_pulse_hold = 0
	_set_pause(false)
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
	stills_open = false
	_air_pick = ""
	_drop_pick = false
	_aid_pick = false
	_nuke_pick = false
	if hud != null:
		hud.set_stills_open(false)
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
	_follow_selection()
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
			elif unit != null:
				found = game.formed_transport_route(unit, cell.x, cell.y)
				if found == null:
					var other := game.token(_opponent_side())
					var conceal := game.opponent_hidden()
					var blocked := func(nx: int, ny: int) -> bool:
						if conceal:
							return false
						return other != null and other.x == nx and other.y == ny
					found = terrain.route(unit.x, unit.y, cell.x, cell.y, blocked)
			map.preview = found if found is Array else []
			map.show_preview = true
			changed = true
		_set_quote()
	elif map.show_preview:
		map.show_preview = false
		map.preview = []
		preview_key = ""
		changed = true
		map.set_quote("")
	if changed:
		map.queue_redraw()


func _arm_nuke() -> void:
	_air_pick = ""
	_drop_pick = false
	_aid_pick = false
	var line := game.use_tool(player_side, "nuke")
	if line.contains("not in this era"):
		_nuke_pick = false
		game.note = line
		_log(line)
		_sync()
		return
	if game.nukes_stopped():
		_nuke_pick = false
		game.note = "Further launches are stopped."
		_log(game.note)
		_sync()
		return
	_nuke_pick = true
	game.note = "Click a city. Capitals are excluded. Crews will not target the home country."
	_log(game.note)
	_sync()


func _arm_aid() -> void:
	_nuke_pick = false
	var line := game.use_tool(player_side, "foreign_aid")
	if line.contains("not in this era"):
		_aid_pick = false
		game.note = line
		_log(line)
		_sync()
		return
	_aid_pick = true
	game.note = "Click a city. The cost was not recovered."
	_log(game.note)
	_sync()


func _arm_drop() -> void:
	_nuke_pick = false
	var unit = game.focus
	_drop_pick = false
	if unit == null or unit.side != player_side:
		game.note = "Only infantry can paradrop."
		_log(game.note)
		_sync()
		return
	var line := game.paradrop(unit)
	_drop_pick = line.begins_with("Click")
	game.note = line
	_log(line)
	_sync()
	map.queue_redraw()


func _arm_mission(action: String) -> void:
	_nuke_pick = false
	var craft = game.focus
	if craft == null or craft.label != "Aircraft" or craft.side != player_side:
		_air_pick = ""
		game.note = "Select an aircraft. The range was not recovered."
		_log(game.note)
		_sync()
		return
	if action == "land_strike":
		_air_pick = "land"
		game.note = "Click a land piece. The range was not recovered."
	elif action == "sea_strike":
		_air_pick = "sea"
		game.note = "Click a sea piece. The range was not recovered."
	else:
		_air_pick = "bomb"
		game.note = "Click an empty city, base, or oil site. The range was not recovered."
	_log(game.note)
	_sync()


func _fly_click(picked: Dictionary, cell: Vector2i) -> String:
	var craft = game.focus
	if _air_pick == "land" or _air_pick == "sea":
		if str(picked.get("kind", "")) != "token":
			return game.fly_strike(player_side, craft, _air_pick, null)
		return game.fly_strike(player_side, craft, _air_pick, picked.get("unit"))
	var site: Variant = sites.at_cell(cell.x, cell.y)
	if site is Dictionary and game.bomb_site_kind(str(site.get("kind", ""))):
		return game.fly_bomb(player_side, craft, str(site.get("title", "site")), "site:%d" % int(site["id"]), _cell_taken(cell.x, cell.y))
	if str(picked.get("kind", "")) == "oil":
		var field: Dictionary = picked.get("field", {})
		var title := str(field.get("name", "oil site"))
		var key := "oil:%s" % str(field.get("id", ""))
		var ox := int(field.get("map_x", cell.x))
		var oy := int(field.get("map_y", cell.y))
		return game.fly_bomb(player_side, craft, title, key, _cell_taken(ox, oy))
	return game.fly_bomb(player_side, craft, "", "", false)


func _cell_taken(x: int, y: int) -> bool:
	for unit in game.tokens:
		if posmod(unit.x, TerrainMap.CELL_W) == posmod(x, TerrainMap.CELL_W) and unit.y == y:
			return true
	return false


func _on_click(world: Vector2) -> void:
	if buying:
		_place_armed(world)
		return
	if not started:
		return
	get_viewport().gui_release_focus()
	var cell := map.cell_of(world)
	var picked := _pick(world)
	if _nuke_pick:
		var chosen: Dictionary = {}
		var site: Variant = sites.at_cell(cell.x, cell.y)
		if site is Dictionary:
			chosen = site
		var launched := game.launch_nuke(player_side, chosen)
		_log(launched)
		_nuke_pick = false
		map.show_preview = false
		map.preview = []
		preview_key = ""
		_sync()
		map.queue_redraw()
		return
	if _aid_pick:
		var chosen: Dictionary = {}
		var site: Variant = sites.at_cell(cell.x, cell.y)
		if site is Dictionary:
			chosen = site
		var spent := game.spend_aid(player_side, chosen)
		_log(spent)
		_aid_pick = false
		map.show_preview = false
		map.preview = []
		preview_key = ""
		_sync()
		map.queue_redraw()
		return
	if _drop_pick and game.selected_side == player_side:
		var dropped := game.paradrop(game.focus, cell.x, cell.y)
		_log(dropped)
		_drop_pick = false
		map.show_preview = false
		map.preview = []
		preview_key = ""
		_sync()
		map.queue_redraw()
		return
	if _air_pick != "" and game.selected_side == player_side:
		var flown := _fly_click(picked, cell)
		_log(flown)
		_air_pick = ""
		map.show_preview = false
		map.preview = []
		preview_key = ""
		_sync()
		map.queue_redraw()
		return
	sites.selected_id = -1
	atlas.selected_id = ""
	oil.selected_id = ""
	var mine := player_side
	var who := _side_name(mine)
	if game.selected_side == mine and not (str(picked.get("kind", "")) == "token" and str(picked.get("side", "")) == mine):
		var refused := game.order(mine, cell.x, cell.y)
		_sound(refused if refused != "" else "order")
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
		game.focus = picked.get("unit")
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
	game.focus = null
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
		return {"kind": "token", "side": best.side, "domain": best.domain, "unit": best}
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
	var kind_line := str(site["kind"])
	if era_year >= 9999 and kind_line == "city":
		kind_line = "city-state"
	var body := "%s\n%s · %s\ncell (%d, %d)" % [
		str(site["country"]),
		kind_line,
		str(site["owner"]),
		int(site["x"]),
		int(site["y"]),
	]
	if game != null and game.city_unready(int(site["id"])):
		body += "\nunready. The time was not recovered."
	hud.set_card(str(site["title"]), body)


func _show_sea(unit: MatchState.Token) -> void:
	inspect = {"kind": "sea"}
	var access := "May enter ocean, docks, and shallows."
	if unit.ship_class != 0:
		access = "May enter ocean and docks. Shallows are refused."
	var title := "Sea piece"
	var body := "Sails by the sea lanes.\n%s" % access
	if unit.label == "Submarine":
		title = "Submarine"
		if game.submarine_hidden(unit):
			body = "It is still. It stays hidden.\n%s" % access
		elif unit.revealed:
			body = "Revealed.\n%s" % access
		elif not unit.path.is_empty():
			body = "It is moving.\n%s" % access
	hud.set_card(title, body)


func _show_oil(field: Dictionary) -> void:
	inspect = {"kind": "oil", "id": str(field.get("id", ""))}
	var body := oil.blurb(field)
	if game != null:
		var who := game.oil_owner_at(int(float(field.get("map_x", -1))), int(float(field.get("map_y", -1))))
		if who == "blue" or who == "red":
			body += "\nOwner: %s." % _side_name(who)
		elif who == "neutral" or who == "":
			body += "\nUnowned."
		else:
			body += "\nOwner: %s." % who
	hud.set_card(str(field.get("name", "Oil")), body)


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
	var empty_army := era_year == 2023 and game.token(player_side) == null and game.sea_token(player_side) == null
	hud.set_opening(empty_army)
	hud.set_result(game.winner())
	if game.winner() != "":
		hud.set_result_detail(game.round, _owner_lines())
	var said := game.spoken()
	map.set_note(said, won)
	hud.set_note(said, won)
	hud.set_running(time_on, game.round)
	hud.set_treasury(game.cash_billions, game.city_income(player_side), game.oil_income(player_side), game.shortage())
	hud.set_speed(game.speed_index)
	var oil_open := Roster.tool_open(era_year, "oil")
	hud.set_toggles(atlas.visible, oil.visible and oil_open, oil_open, labels_on)
	hud.set_era(era_year)
	hud.set_tools({
		"nuke": Roster.tool_open(era_year, "nuke"),
		"satellite": Roster.tool_open(era_year, "satellite"),
		"recon": Roster.tool_open(era_year, "satellite"),
		"killer": Roster.tool_open(era_year, "satellite"),
		"foreign_aid": Roster.tool_open(era_year, "foreign_aid"),
		"intel": Roster.tool_open(era_year, "intel"),
		"cease": Roster.tool_open(era_year, "cease"),
		"cease_yes": Roster.tool_open(era_year, "cease") and game.cease_open,
		"cease_no": Roster.tool_open(era_year, "cease") and game.cease_open,
	})
	hud.set_filter_pixel(pixel_filter)
	hud.set_tier(atlas.max_tier)
	hud.set_atlas_row(atlas.visible)
	map.set_stamp(time_on)
	map.set_contact(not game.contacts.is_empty())
	_sync_badge()
	_sync_feedback()
	hud.set_gauge(Roster.tool_open(era_year, "oil"), game.oil_reserve, game.oil_short)
	hud.set_toast(str(game.toasts.back()) if not game.toasts.is_empty() else "")
	_toast_sound()
	hud.set_pieces(_friendly_rows())
	hud.set_piece_card(_piece_card_text())
	hud.mark_follow(follow_on)
	if minimap != null:
		minimap.queue_redraw()
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


func _set_quote() -> void:
	if map == null or map.preview.is_empty():
		if map != null:
			map.set_quote("")
		return
	var line := "%d steps" % map.preview.size()
	var named := ""
	for step in map.preview:
		var tid := terrain.id_at(int(step["x"]), int(step["y"]))
		if TerrainMap.pace_word(tid) == "slow":
			named = TerrainMap.terrain_name(tid)
			break
	if named != "":
		line += "\n%s" % named
	map.set_quote(line)


func _sync_badge() -> void:
	var unit = game.focus
	if unit != null and unit.label == "Aircraft" and unit.idle_rounds > 0:
		map.set_badge("Inactive %d" % unit.idle_rounds)
	else:
		map.set_badge("")


func _sync_feedback() -> void:
	if game.pulse == "intel" and _pulse_hold == 0:
		map.set_pulse(true)
		_pulse_hold = 1
	elif _pulse_hold > 0:
		_pulse_hold = 0
		game.pulse = ""
		map.set_pulse(false)
	else:
		map.set_pulse(false)
	if game.flash_kind == "aid":
		map.set_flash("Aid")
	elif game.flash_kind == "nuke":
		map.set_flash("Nuke")
	else:
		map.set_flash("")
	map.set_banner(game.cease_banner)
	map.set_satellite(not game.satellites.is_empty())


func _friendly_rows() -> Array:
	var rows: Array = []
	for i in game.tokens.size():
		var unit = game.tokens[i]
		if unit.side != player_side:
			continue
		var name := str(unit.label)
		if name == "":
			name = "Sea" if unit.domain == "sea" else "Land"
		rows.append({"text": "%s · %s" % [name, game.piece_state(unit)], "index": i})
	return rows


func _piece_card_text() -> String:
	var unit = game.focus
	if unit == null or unit.side != player_side:
		return ""
	var name := str(unit.label)
	if name == "":
		name = "Sea" if unit.domain == "sea" else "Land"
	var ground := TerrainMap.terrain_name(terrain.id_at(unit.x, unit.y))
	var dest := "none"
	if not unit.path.is_empty():
		var last: Dictionary = unit.path[unit.path.size() - 1]
		dest = "%s,%s" % [str(last["x"]), str(last["y"])]
	return "%s\n%s\n%s\n%d steps left" % [name, ground, dest, unit.path.size()]


func _owner_lines() -> String:
	var lines: PackedStringArray = []
	for place in sites.places:
		if str(place.get("kind", "")) != "capital":
			continue
		lines.append("%s %s" % [str(place.get("title", "")), str(place.get("owner", ""))])
	return "\n".join(lines)


func _select_listed(index: int) -> void:
	if game == null or index < 0 or index >= game.tokens.size():
		return
	var unit = game.tokens[index]
	if unit.side != player_side:
		return
	game.focus = unit
	game.selected_side = unit.side
	game.selected_domain = unit.domain
	var world := map.cell_center(unit.x, unit.y)
	map.pan_x = map.size.x * 0.5 - world.x * map.view_scale
	map.pan_y = map.size.y * 0.5 - world.y * map.view_scale
	_sync()
	map.queue_redraw()


func _follow_selection() -> void:
	if not follow_on or map == null or game == null:
		return
	var unit = game.focus
	if unit == null or unit.side != player_side or not game.tokens.has(unit):
		unit = game.token(player_side)
	if unit == null:
		return
	var world := map.cell_center(unit.x, unit.y)
	map.pan_x = map.size.x * 0.5 - world.x * map.view_scale
	map.pan_y = map.size.y * 0.5 - world.y * map.view_scale


func _cancel_path() -> void:
	if game == null:
		return
	var unit = game.focus if game.focus != null and game.tokens.has(game.focus) else game.ordered_unit(player_side)
	if unit == null:
		return
	unit.path = []
	unit.debt = 0
	game.note = "Path cleared."
	map.show_preview = false
	map.preview = []
	preview_key = ""
	map.set_quote("")
	_log(game.note)
	_sync()
	map.queue_redraw()


func _center_enemy_capital() -> void:
	if sites == null or map == null:
		return
	var cap: Variant = sites.capital(_opponent_side())
	if not cap is Dictionary:
		return
	follow_on = false
	map.zoom_to(map.cell_center(int(cap["x"]), int(cap["y"])))
	if hud != null:
		hud.mark_follow(false)
	_sync_zoom()


func _save_match() -> void:
	if game == null:
		return
	var err := game.save_match("user://openchq-save.json")
	if err == "":
		game.note = "Saved the match."
	else:
		game.note = err
	_log(game.note)
	_sync()


func _load_match() -> void:
	if game == null:
		return
	var err := game.load_match("user://openchq-save.json")
	if err != "":
		game.note = err
	_log(game.note)
	_sync()
	map.queue_redraw()


func _quit_to_era() -> void:
	_set_pause(false)
	time_on = false
	started = false
	buying = false
	match_buy = false
	_layout()
	_sync()


func _rematch() -> void:
	if game == null or game.winner() == "":
		return
	var year := era_year
	var side := player_side
	time_on = false
	started = false
	buying = false
	log_lines = PackedStringArray()
	if hud != null:
		hud.set_log("")
	_open_buy(year, side)


func _set_pause(open: bool) -> void:
	pause_open = open
	if pause_layer == null:
		return
	pause_layer.visible = open
	if not open:
		var ask := pause_layer.find_child("restart_ask", true, false)
		if ask != null:
			ask.visible = false


func _sound(token: String) -> void:
	if tones == null or token == "":
		return
	if token == "order":
		tones.play("order")
	else:
		tones.play("refuse")


func _toast_sound() -> void:
	var latest := ""
	if not game.toasts.is_empty():
		latest = str(game.toasts.back())
	if latest != _toast_seen:
		_toast_seen = latest
		if tones != null:
			if latest == "Contact":
				tones.play("contact")
			elif latest == "City taken":
				tones.play("city")
			elif latest == "Oil short":
				tones.play("oil")
	var won := game.winner()
	if won == _winner_seen:
		return
	_winner_seen = won
	if tones == null or won == "":
		return
	tones.play("win" if won == player_side else "loss")


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
	stills_open = false
	hud.set_stills_open(false)


func _show_stills(stem: String) -> void:
	if pack == null or stills == null or hud == null:
		return
	_still_stem = stem
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
