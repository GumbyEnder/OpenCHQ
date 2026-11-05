extends Control

## Stand-in minimap. Capitals, friendly pieces, and contact marks. Not a recovered layout.

signal enemy_capital

var game: MatchState
var sites: SiteBook


func _ready() -> void:
	custom_minimum_size = Vector2(168, 78)
	mouse_filter = Control.MOUSE_FILTER_STOP
	var mark := Button.new()
	mark.text = "Enemy capital"
	mark.mouse_filter = Control.MOUSE_FILTER_STOP
	mark.position = Vector2(4, 4)
	mark.pressed.connect(func() -> void:
		enemy_capital.emit()
	)
	add_child(mark)


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("10182a"))
	draw_rect(Rect2(Vector2.ZERO, size), Color("243049"), false, 1.0)
	if game == null or sites == null or size.x < 8.0:
		return
	var sx := size.x / float(TerrainMap.CELL_W)
	var sy := size.y / float(TerrainMap.CELL_H)
	for place in sites.places:
		if str(place.get("kind", "")) != "capital":
			continue
		var col := Color("1d4ed8") if str(place.get("owner", "")) == "blue" else Color("b91c1c")
		draw_circle(Vector2(float(place["x"]) * sx, float(place["y"]) * sy), 3.0, col)
	for unit in game.tokens:
		if unit.side != game.player_side:
			continue
		draw_rect(Rect2(float(unit.x) * sx, float(unit.y) * sy, 3.0, 3.0), Color("4ecdc4"))
	for mark in game.contacts:
		draw_rect(Rect2(float(mark.get("x", 0)) * sx, float(mark.get("y", 0)) * sy, 3.0, 3.0), Color("d6c07a"))
