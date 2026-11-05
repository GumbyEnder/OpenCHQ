extends PanelContainer
class_name Hud

signal command(action: String, arg: Variant)

var _era: OptionButton
var _speed: OptionButton
var _filter: OptionButton
var _filter_row: HBoxContainer
var _tier: OptionButton
var _atlas_row: HBoxContainer
var _atlas_hold: Control
var _still_scroll: ScrollContainer
var _orders: Label
var _opening: Label
var _turn: Label
var _treasury: Label
var _note: Label
var _result: PanelContainer
var _result_title: Label
var _card_title: Label
var _card_body: Label
var _log: Label
var _roster_notes: VBoxContainer
var _roster_row: HBoxContainer
var _still_note: Label
var _still_row: HBoxContainer
var _still_pick: OptionButton
var _still_grid: GridContainer
var _stills: Button
var _stills_hold: HBoxContainer
var _era_row: HBoxContainer
var _speed_row: HBoxContainer
var _time: Button
var _atlas: Button
var _oil: Button
var _labels: Button
var _tools := {}
var _active: StyleBoxFlat
var _gauge: Label
var _toast: Label
var _piece_list: VBoxContainer
var _piece_card: Label
var _result_body: Label
var _follow: Button


func _ready() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var panel := StyleBoxFlat.new()
	panel.bg_color = Color("10182a")
	panel.border_color = Color("243049")
	panel.border_width_left = 1
	add_theme_stylebox_override("panel", panel)
	var normal := _box(Color("1a2438"), Color("243049"))
	var hover := _box(Color("243049"), Color("4ecdc4"))
	_active = _box(Color("14343a"), Color("4ecdc4"))
	var theme_set := Theme.new()
	theme_set.set_color("font_color", "Label", Color("e4ecff"))
	theme_set.set_font_size("font_size", "Label", 14)
	theme_set.set_color("font_color", "Button", Color("e4ecff"))
	theme_set.set_color("font_hover_color", "Button", Color.WHITE)
	theme_set.set_color("font_pressed_color", "Button", Color("4ecdc4"))
	theme_set.set_color("font_disabled_color", "Button", Color("8b99b8"))
	theme_set.set_stylebox("normal", "Button", normal)
	theme_set.set_stylebox("hover", "Button", hover)
	theme_set.set_stylebox("pressed", "Button", _active)
	theme_set.set_stylebox("focus", "Button", normal)
	theme_set.set_stylebox("disabled", "Button", _box(Color("121826"), Color("243049")))
	theme_set.set_color("font_color", "OptionButton", Color("e4ecff"))
	theme_set.set_stylebox("normal", "OptionButton", normal)
	theme_set.set_stylebox("hover", "OptionButton", hover)
	theme_set.set_stylebox("focus", "OptionButton", normal)
	var popup := _box(Color("10182a"), Color("243049"))
	theme_set.set_stylebox("panel", "PopupMenu", popup)
	theme_set.set_color("font_color", "PopupMenu", Color("e4ecff"))
	theme_set.set_color("font_hover_color", "PopupMenu", Color("10182a"))
	theme_set.set_stylebox("hover", "PopupMenu", _box(Color("4ecdc4"), Color("4ecdc4")))
	theme = theme_set

	var scroll := ScrollContainer.new()
	scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)
	var box := VBoxContainer.new()
	box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	box.add_theme_constant_override("separation", 10)
	scroll.add_child(box)
	var margin := MarginContainer.new()
	margin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	margin.add_theme_constant_override("margin_left", 14)
	margin.add_theme_constant_override("margin_right", 14)
	margin.add_theme_constant_override("margin_top", 14)
	margin.add_theme_constant_override("margin_bottom", 14)
	# Margin around the vbox: reparent.
	scroll.remove_child(box)
	margin.add_child(box)
	scroll.add_child(margin)

	var title := Label.new()
	title.text = "OpenCHQ"
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color("4ecdc4"))
	box.add_child(title)
	box.add_child(_result_card())
	_orders = _muted("Blue moves on orders. Red marches on your capital.")
	box.add_child(_orders)
	_turn = _muted("Turn 0")
	box.add_child(_turn)
	_treasury = _muted("Resources 0 billion. City income 0. Oil income 0.")
	box.add_child(_treasury)
	box.add_child(_opening_card())

	_follow = _button("Follow", "follow")
	box.add_child(_row([_button("Fit", "fit"), _button("Zoom to selection", "zoom"), _follow]))
	_time = _button("Run", "time")
	box.add_child(_row([_button("Reset", "reset"), _time, _button("Cancel", "cancel")]))
	box.add_child(_row([_button("Buy", "buy"), _button("Entrench", "entrench")]))
	box.add_child(_row([_button("Land strike", "land_strike"), _button("Sea strike", "sea_strike")]))
	box.add_child(_row([_button("Bomb", "bomb"), _button("Scramble", "scramble")]))
	box.add_child(_row([_button("Paradrop", "paradrop")]))
	_stills = _button("Stills", "stills")
	_stills_hold = _row([_stills])
	box.add_child(_stills_hold)
	_atlas = _button("Atlas", "atlas")
	_atlas.visible = false
	_oil = _button("Oil", "oil")
	_labels = _button("Labels", "labels")
	box.add_child(_row([_atlas, _oil, _labels]))
	box.add_child(_row([_tool_button("Nuke", "nuke"), _tool_button("Satellites", "satellite")]))
	box.add_child(_row([_tool_button("Recon sat", "recon"), _tool_button("Killer sat", "killer")]))
	box.add_child(_row([_tool_button("Foreign aid", "foreign_aid"), _tool_button("Intel", "intel")]))
	box.add_child(_row([_tool_button("Cease fire", "cease"), _tool_button("Yes", "cease_yes"), _tool_button("No", "cease_no")]))

	_era = OptionButton.new()
	_era.add_item("1918", 1918)
	_era.add_item("1942", 1942)
	_era.add_item("1986", 1986)
	_era.add_item("2023", 2023)
	_era.add_item("????", 9999)
	_era.select(2)
	_era.item_selected.connect(func(index: int) -> void:
		command.emit("era", _era.get_item_id(index))
	)
	_era_row = _labeled("Era", _era)
	box.add_child(_era_row)

	_speed = OptionButton.new()
	_speed.add_item("Held", 100)
	_speed.add_item("Slow", 101)
	_speed.add_item("Normal", 103)
	_speed.add_item("Fast", 106)
	_speed.select(0)
	_speed.item_selected.connect(func(index: int) -> void:
		command.emit("speed", _speed.get_item_id(index) - 100)
	)
	_speed_row = _labeled("Speed", _speed)
	box.add_child(_speed_row)

	_filter = OptionButton.new()
	_filter.add_item("Pixel", 0)
	_filter.add_item("Smooth", 1)
	_filter.item_selected.connect(func(index: int) -> void:
		command.emit("filter", "pixel" if index == 0 else "smooth")
	)
	_filter_row = _labeled("Filter", _filter)
	_filter_row.visible = false
	box.add_child(_filter_row)

	_tier = OptionButton.new()
	_tier.add_item("Major capitals", 1)
	_tier.add_item("Tiers 1–2", 2)
	_tier.add_item("All atlas capitals", 3)
	_tier.item_selected.connect(func(index: int) -> void:
		command.emit("tier", _tier.get_item_id(index))
	)
	_atlas_row = _labeled("Atlas tier", _tier)
	_atlas_row.visible = false
	# The opening card replaces this control. The row flag still tracks the toggle.
	_atlas_hold = Control.new()
	_atlas_hold.visible = false
	_atlas_hold.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_atlas_hold.add_child(_atlas_row)
	box.add_child(_atlas_hold)

	_gauge = _muted("Reserve 0")
	_gauge.visible = false
	box.add_child(_gauge)
	_toast = Label.new()
	_toast.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_toast.add_theme_color_override("font_color", Color("d6c07a"))
	box.add_child(_toast)
	_note = Label.new()
	_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_note)
	_piece_card = _muted("")
	box.add_child(_piece_card)
	_piece_list = VBoxContainer.new()
	_piece_list.add_theme_constant_override("separation", 4)
	box.add_child(_piece_list)
	_card_title = Label.new()
	_card_title.add_theme_font_size_override("font_size", 16)
	_card_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_card_title)
	_card_body = _muted("")
	box.add_child(_card_body)

	_roster_notes = VBoxContainer.new()
	box.add_child(_roster_notes)
	var roster_scroll := ScrollContainer.new()
	roster_scroll.custom_minimum_size = Vector2(0, 78)
	roster_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	roster_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	box.add_child(roster_scroll)
	_roster_row = HBoxContainer.new()
	_roster_row.add_theme_constant_override("separation", 8)
	roster_scroll.add_child(_roster_row)

	_still_note = _muted("")
	_still_note.visible = false
	box.add_child(_still_note)
	_still_pick = OptionButton.new()
	_still_pick.item_selected.connect(func(index: int) -> void:
		command.emit("still", _still_pick.get_item_text(index))
	)
	_still_row = _labeled("Stills", _still_pick)
	_still_row.add_child(_button("Next frame", "still_next"))
	_still_row.visible = false
	box.add_child(_still_row)
	_still_scroll = ScrollContainer.new()
	_still_scroll.visible = false
	_still_scroll.custom_minimum_size = Vector2(0, 150)
	_still_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_still_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	box.add_child(_still_scroll)
	_still_grid = GridContainer.new()
	_still_grid.columns = 4
	_still_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_still_grid.add_theme_constant_override("h_separation", 6)
	_still_grid.add_theme_constant_override("v_separation", 6)
	_still_scroll.add_child(_still_grid)

	var rules := _muted("Drag the map. The world wraps east to west. Wheel zooms. Click your piece, then a cell. Ocean is a transport for the land piece. A sea piece sails by the sea lanes. Forest, mountain, polar, jungle, and shallows are slower. The 1990 ratio was not recovered. Oil rates are unknown. Nukes, satellites, foreign aid, and intel are only in 1986 and 2023. Oil is also on in the concealed start. Costs and radii stay unknown. An enemy route shows its first three steps. City income is the cities you hold. Oil income is the wells you hold. Both add to resources every 25 rounds. A tank costs twice an infantry unit. An oil shortage stops movement, grounds planes, and stops city income. Overlapping land icons engage. A shot is every other round and the damage is unknown. A second friendly deals damage and takes none. Flank and rear hits hurt more. Sea units are not flanked and are not pinned. A pinned land unit stays until the fight ends or a new move order. Keys: T time, L labels, F fit, R reset, O oil, A atlas.")
	rules.visible = false
	box.add_child(rules)
	_log = _muted("")
	box.add_child(_log)


func set_opening(empty_army: bool) -> void:
	if _opening == null:
		return
	if empty_army:
		_opening.text = "Hold every capital. 2023 starts with no army. %s Time stays held until Run." % Assumptions.cash_note()
		return
	_opening.text = "Hold every capital. The marked land piece and the marked ship are yours. Click a piece, then a cell. Time stays held until Run."


func set_orders(side: String, concealed: bool = false) -> void:
	if _orders == null:
		return
	var who := "Red" if side == "red" else "Blue"
	var other := "Blue" if side == "red" else "Red"
	if concealed:
		_orders.text = "%s moves on orders. %s stays hidden until their capital is found." % [who, other]
	else:
		_orders.text = "%s moves on orders. %s marches on your capital." % [who, other]


func set_note(text: String, win: bool) -> void:
	_note.text = text
	_note.add_theme_color_override("font_color", Color("4ecdc4") if win else Color("e4ecff"))


## Hidden until a side holds every capital. The name comes first, then Start.
func set_result(side: String) -> void:
	if _result == null:
		return
	var named := side == "blue" or side == "red"
	_result.visible = named
	if not named or _result_title == null:
		return
	var who := "Red" if side == "red" else "Blue"
	_result_title.text = "%s wins" % who
	if _result_body != null:
		_result_body.text = ""


func set_card(title: String, body: String) -> void:
	_card_title.text = title
	_card_body.text = body


func set_log(text: String) -> void:
	_log.text = text


func set_running(running: bool, turn: int = 0) -> void:
	if running:
		_time.text = "Pause"
	elif turn > 0:
		_time.text = "Resume"
	else:
		_time.text = "Run"
	_mark(_time, running)
	if _turn != null:
		_turn.text = "Turn %d" % turn


func set_treasury(cash: int, cities: int, wells: int, stopped: bool) -> void:
	if _treasury == null:
		return
	if cash < 0:
		_treasury.text = ""
		return
	if stopped:
		_treasury.text = "Resources %d billion. City income is stopped. Oil income is stopped." % cash
		return
	_treasury.text = "Resources %d billion. City income %d. Oil income %d." % [cash, cities, wells]


func set_toggles(atlas_on: bool, oil_on: bool, oil_enabled: bool, labels_on: bool) -> void:
	_mark(_atlas, atlas_on)
	_mark(_oil, oil_on)
	_oil.visible = oil_enabled
	_oil.disabled = not oil_enabled
	_mark(_labels, labels_on)


func set_era(year: int) -> void:
	_select_id(_era, year)


func set_speed(index: int) -> void:
	if _speed == null:
		return
	_select_id(_speed, 100 + index)


func set_tools(open_map: Dictionary) -> void:
	for key in _tools:
		var button := _tools[key] as Button
		var open := bool(open_map.get(key, false))
		button.visible = open
		button.disabled = not open


func set_filter_pixel(pixel: bool) -> void:
	_filter.set_block_signals(true)
	_filter.select(0 if pixel else 1)
	_filter.set_block_signals(false)


func set_tier(tier: int) -> void:
	_select_id(_tier, tier)


func set_atlas_row(show_row: bool) -> void:
	_atlas_row.visible = show_row
	_atlas_hold.visible = false


func set_roster(entries: Array, notes: PackedStringArray) -> void:
	for child in _roster_notes.get_children():
		child.queue_free()
	for note in notes:
		_roster_notes.add_child(_muted(note))
	for child in _roster_row.get_children():
		child.queue_free()
	for entry in entries:
		var figure := VBoxContainer.new()
		figure.custom_minimum_size = Vector2(52, 70)
		var rect := TextureRect.new()
		rect.custom_minimum_size = Vector2(48, 32)
		rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		rect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		rect.texture = entry.get("texture")
		figure.add_child(rect)
		var caption := Label.new()
		caption.text = str(entry.get("name", ""))
		caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		caption.add_theme_font_size_override("font_size", 11)
		caption.add_theme_color_override("font_color", Color("8b99b8"))
		figure.add_child(caption)
		_roster_row.add_child(figure)


func host_extra(node: Control) -> void:
	if _piece_list != null and _piece_list.get_parent() != null:
		_piece_list.get_parent().add_child(node)


func detach_match_menus() -> Array:
	var rows: Array = [_era_row, _speed_row, _stills_hold]
	for row in rows:
		if row != null and row.get_parent() != null:
			row.get_parent().remove_child(row)
	return rows


func set_gauge(show_gauge: bool, reserve: int, short: bool) -> void:
	if _gauge == null:
		return
	_gauge.visible = show_gauge
	if not show_gauge:
		return
	if short:
		_gauge.text = "Reserve %d Short" % reserve
	else:
		_gauge.text = "Reserve %d" % reserve


func set_toast(text: String) -> void:
	if _toast != null:
		_toast.text = text


func set_piece_card(text: String) -> void:
	if _piece_card != null:
		_piece_card.text = text


func set_pieces(entries: Array) -> void:
	if _piece_list == null:
		return
	for child in _piece_list.get_children():
		child.queue_free()
	for entry in entries:
		var button := Button.new()
		button.text = str(entry.get("text", ""))
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		var index := int(entry.get("index", -1))
		button.pressed.connect(func() -> void:
			command.emit("piece", index)
		)
		_piece_list.add_child(button)


func set_result_detail(turn: int, owners: String) -> void:
	if _result_body == null:
		return
	_result_body.text = "Turn %d\n%s" % [turn, owners]


func mark_follow(on: bool) -> void:
	if _follow != null:
		_mark(_follow, on)


func set_still_note(text: String) -> void:
	_still_note.text = text


func set_still_catalog(names: PackedStringArray, note: String) -> void:
	_still_note.text = note
	_still_pick.set_block_signals(true)
	_still_pick.clear()
	for stem in names:
		_still_pick.add_item(stem)
	if not names.is_empty():
		_still_pick.select(0)
	_still_pick.set_block_signals(false)


func set_stills_open(open: bool) -> void:
	_still_note.visible = open
	_still_row.visible = open
	_still_scroll.visible = open
	if _stills != null:
		_mark(_stills, open)


func set_still_sheet(entries: Array) -> void:
	for child in _still_grid.get_children():
		_still_grid.remove_child(child)
		child.free()
	for entry in entries:
		var cell := VBoxContainer.new()
		cell.custom_minimum_size = Vector2(64, 0)
		cell.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var tex: Texture2D = entry.get("texture")
		if tex == null:
			cell.add_child(_disc())
		else:
			var rect := TextureRect.new()
			rect.custom_minimum_size = Vector2(56, 36)
			rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
			rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			rect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
			rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
			rect.texture = tex
			cell.add_child(rect)
		var caption := Label.new()
		caption.text = str(entry.get("name", ""))
		caption.clip_text = true
		caption.custom_minimum_size = Vector2(64, 0)
		caption.add_theme_font_size_override("font_size", 10)
		caption.add_theme_color_override("font_color", Color("8b99b8"))
		cell.add_child(caption)
		_still_grid.add_child(cell)


## A missing file keeps the same colored disc as a piece with no still.
func _disc() -> Panel:
	var disc := Panel.new()
	disc.custom_minimum_size = Vector2(28, 28)
	disc.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color("1d4ed8")
	style.set_corner_radius_all(14)
	disc.add_theme_stylebox_override("panel", style)
	return disc


func _tool_button(text: String, action: String) -> Button:
	var button := _button(text, action)
	_tools[action] = button
	return button


func _result_card() -> PanelContainer:
	var card := PanelContainer.new()
	var panel := StyleBoxFlat.new()
	panel.bg_color = Color("14343a")
	panel.border_color = Color("4ecdc4")
	panel.set_border_width_all(1)
	panel.set_corner_radius_all(6)
	panel.content_margin_left = 10
	panel.content_margin_right = 10
	panel.content_margin_top = 10
	panel.content_margin_bottom = 10
	card.add_theme_stylebox_override("panel", panel)
	var inner := VBoxContainer.new()
	inner.add_theme_constant_override("separation", 8)
	card.add_child(inner)
	_result_title = Label.new()
	_result_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_result_title.add_theme_font_size_override("font_size", 16)
	_result_title.add_theme_color_override("font_color", Color("4ecdc4"))
	inner.add_child(_result_title)
	_result_body = _muted("")
	inner.add_child(_result_body)
	var rematch := Button.new()
	rematch.text = "Rematch"
	rematch.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rematch.pressed.connect(func() -> void:
		command.emit("rematch", null)
	)
	inner.add_child(rematch)
	var again := Button.new()
	again.text = "Start"
	again.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	again.pressed.connect(func() -> void:
		command.emit("start", null)
	)
	inner.add_child(again)
	card.visible = false
	_result = card
	return card


func _opening_card() -> PanelContainer:
	var card := PanelContainer.new()
	var panel := StyleBoxFlat.new()
	panel.bg_color = Color("14343a")
	panel.border_color = Color("4ecdc4")
	panel.set_border_width_all(1)
	panel.set_corner_radius_all(6)
	panel.content_margin_left = 10
	panel.content_margin_right = 10
	panel.content_margin_top = 10
	panel.content_margin_bottom = 10
	card.add_theme_stylebox_override("panel", panel)
	var inner := VBoxContainer.new()
	inner.add_theme_constant_override("separation", 6)
	card.add_child(inner)
	var title := Label.new()
	title.text = "Every capital"
	title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color("4ecdc4"))
	inner.add_child(title)
	_opening = _muted("Hold every capital. The marked land piece and the marked ship are yours. Click a piece, then a cell. Time stays held until Run.")
	inner.add_child(_opening)
	return card


func _button(text: String, action: String) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(func() -> void:
		command.emit(action, null)
	)
	return button


func _row(buttons: Array) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	for button in buttons:
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(button)
	return row


func _labeled(caption: String, control: Control) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var lab := Label.new()
	lab.text = caption
	lab.custom_minimum_size = Vector2(72, 0)
	lab.add_theme_color_override("font_color", Color("8b99b8"))
	row.add_child(lab)
	control.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(control)
	return row


func _muted(text: String) -> Label:
	var lab := Label.new()
	lab.text = text
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lab.add_theme_font_size_override("font_size", 12)
	lab.add_theme_color_override("font_color", Color("8b99b8"))
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	return lab


func _mark(button: Button, on: bool) -> void:
	if on:
		button.add_theme_stylebox_override("normal", _active)
	else:
		button.remove_theme_stylebox_override("normal")


func _select_id(option: OptionButton, id: int) -> void:
	option.set_block_signals(true)
	for i in option.item_count:
		if option.get_item_id(i) == id:
			option.select(i)
			break
	option.set_block_signals(false)


func _box(fill: Color, border: Color) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = fill
	box.border_color = border
	box.set_border_width_all(1)
	box.set_corner_radius_all(4)
	box.content_margin_left = 8
	box.content_margin_right = 8
	box.content_margin_top = 4
	box.content_margin_bottom = 4
	return box
