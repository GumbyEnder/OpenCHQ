extends RefCounted

## Short tones. If the machine has no audio device, play() does nothing.
## No class_name: a headless --script run cannot see a new global class until an editor scan.

var _players := {}


func _init() -> void:
	for name in ["order", "refuse", "contact", "city", "oil", "win", "loss"]:
		var player := AudioStreamPlayer.new()
		player.stream = _blip()
		player.volume_db = -12.0
		_players[name] = player


func attach(parent: Node) -> void:
	for name in _players:
		var player: AudioStreamPlayer = _players[name]
		if player.get_parent() == null:
			parent.add_child(player)


func play(name: String) -> void:
	if AudioServer.get_output_device_list().is_empty():
		return
	var player: AudioStreamPlayer = _players.get(name)
	if player == null or not player.is_inside_tree():
		return
	player.play()


func _blip() -> AudioStreamWAV:
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = 22050
	stream.stereo = false
	var count := 180
	var data := PackedByteArray()
	data.resize(count * 2)
	for i in count:
		var sample := int(sin(float(i) * 0.35) * 3000.0)
		data[i * 2] = sample & 255
		data[i * 2 + 1] = (sample >> 8) & 255
	stream.data = data
	return stream
