extends PanelContainer

signal kind_chosen(kind: String)
signal begin_pressed
signal back_pressed

var _status: Label
var _intro: Label
var _list: VBoxContainer
var _begin: Button
var _armed := ""


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	var panel := StyleBoxFlat.new()
	panel.bg_color = Color("10182a")
	panel.border_color = Color("243049")
	panel.set_border_width_all(1)
	panel.content_margin_left = 14
	panel.content_margin_right = 14
	panel.content_margin_top = 14
	panel.content_margin_bottom = 14
	add_theme_stylebox_override("panel", panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	add_child(box)
	var title := Label.new()
	title.text = "Purchase New Units"
	title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color("4ecdc4"))
	box.add_child(title)
	_intro = _muted("Your land piece and your ship are already placed. Land and aircraft go in a friendly city. Ships go on a dock. Begin starts the match. Time stays held until Run.")
	box.add_child(_intro)
	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 6)
	box.add_child(_list)
	_status = _muted("Pick a unit, then a cell. Begin starts the match.")
	box.add_child(_status)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var back := Button.new()
	back.text = "Back"
	back.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	back.pressed.connect(func() -> void:
		back_pressed.emit()
	)
	row.add_child(back)
	_begin = Button.new()
	_begin.text = "Begin"
	_begin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_begin.pressed.connect(func() -> void:
		begin_pressed.emit()
	)
	row.add_child(_begin)
	box.add_child(row)


func set_intro(text: String) -> void:
	if _intro != null:
		_intro.text = text


func set_catalog(rows: Array) -> void:
	_armed = ""
	if _list == null:
		return
	for child in _list.get_children():
		child.queue_free()
	for row in rows:
		var name := str(row["name"])
		var price := str(row["price"])
		var button := Button.new()
		button.text = name if price == "" else "%s — %s" % [name, price]
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.pressed.connect(_choose.bind(name))
		_list.add_child(button)


func set_status(text: String) -> void:
	if _status != null:
		_status.text = text


func status_text() -> String:
	if _status == null:
		return ""
	return _status.text


func set_done(text: String) -> void:
	if _begin != null:
		_begin.text = text


func _choose(kind: String) -> void:
	_armed = kind
	set_status("Placing New Purchase")
	kind_chosen.emit(kind)


func _muted(text: String) -> Label:
	var lab := Label.new()
	lab.text = text
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lab.add_theme_font_size_override("font_size", 13)
	lab.add_theme_color_override("font_color", Color("8b99b8"))
	return lab
