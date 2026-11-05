extends RefCounted
class_name Stills

## Extracted PAN images. Playback follows extracted file order until the PAN opcodes are read.

const NOTE := "Extracted stills. Playback is an assumption: extracted file order."
const MISSING_NOTE := "Stills are missing. Pieces stay colored discs."
const PLAYBACK_KNOWN := false

var names := PackedStringArray()
var _files := {}
var frame := 0


func load_pack(pack) -> void:
	names = PackedStringArray()
	_files = {}
	for row in pack.json_array("anims/_summary.json"):
		if not row is Dictionary:
			continue
		var stem := str(row.get("file", "")).get_basename()
		if stem == "" or _files.has(stem):
			continue
		var paths := PackedStringArray()
		var manifest: Variant = pack.json_any("anims/%s/manifest.json" % stem)
		if manifest is Dictionary:
			for image in manifest.get("embedded_images", []):
				if not image is Dictionary:
					continue
				var file := str(image.get("file", ""))
				if file == "":
					continue
				paths.append("anims/%s/%s" % [stem, file])
		names.append(stem)
		_files[stem] = paths


func image_count() -> int:
	var count := 0
	for stem in names:
		count += files_for(stem).size()
	return count


func advance(stem: String) -> String:
	var files := files_for(stem)
	if files.is_empty():
		frame = 0
		return NOTE
	frame = (frame + 1) % files.size()
	return "Playing %s. Assumption: extracted file order." % files[frame].get_file()


func files_for(stem: String) -> PackedStringArray:
	var got: Variant = _files.get(stem, null)
	if got is PackedStringArray:
		return got
	return PackedStringArray()


func has_file(rel: String) -> bool:
	for stem in names:
		if files_for(stem).has(rel):
			return true
	return false
