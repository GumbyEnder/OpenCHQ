extends RefCounted
class_name Assumptions

## Stand-ins. None of these were recovered. Change this file when a measurement replaces one.

## Cells (Chebyshev, x wraps). An enemy farther than this from every friendly piece stays unseen.
## Intel still reveals them. A still submarine stays hidden inside the range.
const SIGHT_CELLS := 8

## Oil eras only. The reserve starts here and falls by BURN each turn the ordered side
## is not standing on an oilfield cell. Zero turns the shortage flag on. Standing on one refills it.
const OIL_RESERVE := 10000
const OIL_BURN := 1

## 2023 only. Billions. A nuke is still 10 billion. Other prices stay uncharged.
const CASH_2023 := 40
const CASH_NOTE := "Stand-in cash pool: %d billion. Cities and oil use a stand-in shuffle."

## 2023 only. Same seed every reset, so the layout is stable. Capitals stay put.
const SHUFFLE_SEED := 2023

## Player lines. Not recovered wording. game.note keeps the older sentence.
const SHORTAGE_VOICE := "Stand-in shortage. Movement is stopped."
const FIGHT_VOICE := "Stand-in fight. The shot has no damage yet."
const GONE_VOICE := "Stand-in fight. The defender is gone."

## Shots in one continuous fight before the defender is removed. Not recovered.
## Raised above 4 so the Washington–Moscow march still meets short of one cell.
## The ungarrisoned march peaked at 5 shots, so the kept value is 6.
const HITS := 6

## Rounds a last-seen marker stays up. Not recovered. Sight stays SIGHT_CELLS.
const CONTACT_ROUNDS := 8

## Stand-in prices, in billions. Not recovered. A tank is twice an infantry.
## A nuke stays above the early pool, so 1986 still refuses it.
const PRICE_INFANTRY := 1
const PRICE_TANK := 2
const PRICE_SHIP := 2
const PRICE_SUB := 2
const PRICE_AIR := 2
const PRICE_NUKE := 10

## 1918, 1942, and 1986. Large enough for the purchases the checks already make.
## Below PRICE_NUKE. Not recovered.
const CASH_EARLY := 9

## Stand-in treasury. The user set the cadence. Each owned city and each owned
## well adds one billion, the same unit as the cash pool. Not a recovered rate.
## The oil file's production ratings are not used. A nuke stays a refused tool.
const PAY_EVERY := 25
const CITY_PAY := 1
const WELL_PAY := 1


static func cash_note() -> String:
	return CASH_NOTE % CASH_2023


static func shuffle_points(points: Array, seed: int) -> Array:
	var out: Array = points.duplicate()
	if out.size() < 2:
		return out
	var rng := RandomNumberGenerator.new()
	rng.seed = seed
	for i in range(out.size() - 1, 0, -1):
		var j := rng.randi_range(0, i)
		var swap: Variant = out[i]
		out[i] = out[j]
		out[j] = swap
	return out
