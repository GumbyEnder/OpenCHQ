extends Control

signal begin_match(year: int, side: String)

var _era: OptionButton
var _side: OptionButton
var _won: Label


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	set_anchors_preset(Control.PRESET_FULL_RECT)
	var normal := _box(Color("1a2438"), Color("243049"))
	var hover := _box(Color("243049"), Color("4ecdc4"))
	var theme_set := Theme.new()
	theme_set.set_color("font_color", "Label", Color("e4ecff"))
	theme_set.set_font_size("font_size", "Label", 14)
	theme_set.set_color("font_color", "Button", Color("e4ecff"))
	theme_set.set_color("font_hover_color", "Button", Color.WHITE)
	theme_set.set_color("font_pressed_color", "Button", Color("4ecdc4"))
	theme_set.set_stylebox("normal", "Button", normal)
	theme_set.set_stylebox("hover", "Button", hover)
	theme_set.set_stylebox("pressed", "Button", _box(Color("14343a"), Color("4ecdc4")))
	theme_set.set_stylebox("focus", "Button", normal)
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

	var backdrop := ColorRect.new()
	backdrop.color = Color("070b14")
	backdrop.mouse_filter = Control.MOUSE_FILTER_STOP
	backdrop.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(backdrop)

	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_STOP
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(center)

	var card := PanelContainer.new()
	card.custom_minimum_size = Vector2(420, 0)
	var panel := StyleBoxFlat.new()
	panel.bg_color = Color("10182a")
	panel.border_color = Color("243049")
	panel.set_border_width_all(1)
	panel.set_corner_radius_all(6)
	panel.content_margin_left = 22
	panel.content_margin_right = 22
	panel.content_margin_top = 22
	panel.content_margin_bottom = 22
	card.add_theme_stylebox_override("panel", panel)
	center.add_child(card)

	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	card.add_child(box)

	var title := Label.new()
	title.text = "OpenCHQ"
	title.add_theme_font_size_override("font_size", 22)
	title.add_theme_color_override("font_color", Color("4ecdc4"))
	box.add_child(title)
	_won = Label.new()
	_won.visible = false
	_won.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_won.add_theme_font_size_override("font_size", 16)
	_won.add_theme_color_override("font_color", Color("4ecdc4"))
	_won.custom_minimum_size = Vector2(360, 0)
	box.add_child(_won)
	box.add_child(_muted("Pick an era and a side. The map stays hidden until Start."))

	_era = OptionButton.new()
	_era.add_item("1918", 1918)
	_era.add_item("1942", 1942)
	_era.add_item("1986", 1986)
	_era.add_item("2023", 2023)
	_era.add_item("????", 9999)
	_era.select(2)
	box.add_child(_labeled("Era", _era))

	_side = OptionButton.new()
	_side.add_item("Blue", 1)
	_side.add_item("Red", 2)
	_side.select(0)
	box.add_child(_labeled("Side", _side))

	var start := Button.new()
	start.text = "Start"
	start.pressed.connect(_emit_begin)
	box.add_child(start)


func _emit_begin() -> void:
	var year := _era.get_item_id(_era.selected)
	var side := "red" if _side.get_item_id(_side.selected) == 2 else "blue"
	begin_match.emit(year, side)


## Empty until a finished match returns here. The name sits above Start.
func set_winner(side: String) -> void:
	if _won == null:
		return
	if side != "blue" and side != "red":
		_won.visible = false
		_won.text = ""
		return
	var who := "Red" if side == "red" else "Blue"
	_won.text = "%s wins" % who
	_won.visible = true


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
	lab.add_theme_font_size_override("font_size", 13)
	lab.add_theme_color_override("font_color", Color("8b99b8"))
	lab.custom_minimum_size = Vector2(360, 0)
	return lab


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
