extends RefCounted
class_name DataPack

var root := ""
var _textures := {}


func open() -> String:
	root = _resolve()
	if root == "":
		return "No data pack. Set OPENCHQ_DATA, or put the extract path in local/data_root.txt. On Windows this share is K:\\. A /mnt/nas path is read from there, and ../Command HQ/modern/extracted is the extract next to this project. See data_root.example."
	return ""


func json_any(rel: String) -> Variant:
	var path := root.path_join(rel)
	if not FileAccess.file_exists(path):
		return null
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	return parsed


func json_dict(rel: String) -> Dictionary:
	var parsed: Variant = json_any(rel)
	return parsed if parsed is Dictionary else {}


func json_array(rel: String) -> Array:
	var parsed: Variant = json_any(rel)
	return parsed if parsed is Array else []


func bytes(rel: String) -> PackedByteArray:
	var path := root.path_join(rel)
	if not FileAccess.file_exists(path):
		return PackedByteArray()
	return FileAccess.get_file_as_bytes(path)


func texture(rel: String) -> Texture2D:
	if _textures.has(rel):
		return _textures[rel]
	var path := root.path_join(rel)
	if not FileAccess.file_exists(path):
		return null
	var image := Image.new()
	if image.load(path) != OK:
		return null
	var tex := ImageTexture.create_from_image(image)
	_textures[rel] = tex
	return tex


static func _resolve() -> String:
	var env := OS.get_environment("OPENCHQ_DATA").strip_edges()
	var hit := _pick(env)
	if hit != "":
		return hit
	var local := ProjectSettings.globalize_path("res://local/data_root.txt")
	if FileAccess.file_exists(local):
		for line in FileAccess.get_file_as_string(local).split("\n"):
			var text := line.strip_edges()
			if text == "" or text.begins_with("#"):
				continue
			hit = _pick(text)
			if hit != "":
				return hit
	var bundled := ProjectSettings.globalize_path("res://data")
	hit = _pick(bundled)
	if hit != "":
		return hit
	# Same share as this project: K:\projects\OpenCHQ beside K:\projects\Command HQ\...
	return _pick("../Command HQ/modern/extracted")


static func _pick(path: String) -> String:
	for candidate in _candidates(path):
		if _usable(candidate):
			return candidate
	return ""


## A relative line is from this project. /mnt/nas is this share, which Windows mounts as K:.
static func _candidates(path: String) -> PackedStringArray:
	var out := PackedStringArray()
	var text := path.strip_edges().replace("\\", "/")
	if text == "":
		return out
	if _is_relative(text):
		var joined := _project_dir().path_join(text).simplify_path()
		if not out.has(joined):
			out.append(joined)
	if not out.has(text):
		out.append(text)
	if OS.get_name() == "Windows" and (text == "/mnt/nas" or text.begins_with("/mnt/nas/")):
		var rest := ""
		if text.begins_with("/mnt/nas/"):
			rest = text.substr(9)
		var win := "K:/" + rest
		if not out.has(win):
			out.append(win)
	return out


static func _project_dir() -> String:
	return ProjectSettings.globalize_path("res://").simplify_path()


static func _is_relative(path: String) -> bool:
	if path.begins_with("/") or path.begins_with("res://") or path.begins_with("user://"):
		return false
	if path.length() >= 2 and path.substr(1, 1) == ":":
		return false
	return true


static func _usable(path: String) -> bool:
	if path == "":
		return false
	return FileAccess.file_exists(path.path_join("data/sites.json")) \
		and FileAccess.file_exists(path.path_join("data/tmap.bin")) \
		and FileAccess.file_exists(path.path_join("pics/WORLD_MAP.png"))
