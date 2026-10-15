extends RefCounted
class_name Roster

const ART_LAND := "anims/TANKS/img_02_48x31.png"
const ART_TRANSPORT := "anims/TRNSPRT/img_02_43x16.png"
const ART_SEA := "anims/CRUISER/img_03_43x16.png"

const ROWS := [
	{"era_min": 1918, "name": "Cruiser", "file": "anims/CRUISER/img_03_43x16.png"},
	{"era_min": 1918, "name": "Submarine", "file": "anims/SUB/img_03_43x16.png"},
	{"era_min": 1918, "name": "Transport", "file": "anims/TRNSPRT/img_02_43x16.png"},
	{"era_min": 1942, "name": "Tanks", "file": "anims/TANKS/img_02_48x31.png"},
	{"era_min": 1942, "name": "Aircraft", "file": "anims/AIRSHIP/img_09_28x22.png"},
	{"era_min": 1942, "name": "Carrier", "file": "anims/CARRIER/img_03_43x16.png"},
	{"era_min": 1986, "name": "Nuke", "file": "anims/NUKE/img_15_33x14.png", "tool": "nuke"},
	{"era_min": 1986, "name": "Recon sat", "file": "anims/SPYSAT/img_00_26x25.png", "tool": "satellite"},
	{"era_min": 1986, "name": "Killer sat", "file": "anims/KILLSAT/img_02_39x18.png", "tool": "satellite"},
]


## Nukes, satellites, foreign aid, and intel are 1986 and 2023 only.
## Oil is a constraint in those two and in the concealed start. Not in 1918 or 1942.
static func tool_open(era_year: int, tool: String) -> bool:
	if tool == "oil":
		return era_year == 1986 or era_year == 2023 or era_year >= 9999
	if tool == "nuke" or tool == "satellite" or tool == "foreign_aid" or tool == "intel":
		return era_year == 1986 or era_year == 2023
	return false


## The concealed start keeps the 1942 roster and does not inherit the 1986 tools.
static func rows_for(era_year: int) -> Array:
	var year := 1942 if era_year >= 9999 else era_year
	var out: Array = []
	for row in ROWS:
		var tool := str(row.get("tool", ""))
		if tool != "":
			if tool_open(era_year, tool):
				out.append(row)
			continue
		if int(row["era_min"]) <= year:
			out.append(row)
	return out


static func notes_for(era_year: int) -> PackedStringArray:
	var year := 1986 if era_year >= 9999 else era_year
	var notes := PackedStringArray()
	if year <= 1942:
		notes.append("Infantry is on the 1918 roster. The animation set has no infantry frame.")
	if not tool_open(era_year, "nuke"):
		notes.append("Nukes, satellites, foreign aid, and intel are not in this era.")
	if era_year >= 9999:
		notes.append("The concealed-start scenario hides the opponent. This loop still shows both pieces.")
	return notes


## Ocean and lake use the transport frame. Shallows stay on land.
## 1918 land stays a disc: the set has no infantry frame.
static func token_kind(era_year: int, pace_word: String) -> String:
	if pace_word == "transport":
		return "transport"
	var year := 1986 if era_year >= 9999 else era_year
	if year >= 1942:
		return "land"
	return ""
