# tools/t6 — reading the original's setup numbers

The rig behind `docs/re/START_MONEY.md`. It drives DOSBox 0.74-3 on Xvfb, walks the original's
new-war setup, photographs the `OPPONENT'S STARTING MONEY` dialog and Monitor Four, and reads the
per-side money slots straight out of the process.

Why it is committed: Part A closed 1918 Blue and measured three more eras. Red, era 5 and the
spinner limits are still open, and they start from these scripts rather than from a transcript.

## Requirements

- `dosbox` 0.74-3 and `xvfb` on the host.
- The original tree at `/mnt/nas/projects/Command HQ` (`COMMAND/CHQ.EXE`). Override the mount with
  `CHQ_HOME` if it lives elsewhere.
- `root` for the memory reads (`/proc/<pid>/mem`; the box has NOPASSWD sudo).

## The walk

    bash tools/t6/rea-run.sh start          # Xvfb :99 + DOSBox on dosbox_rea_linux.conf
    bash tools/t6/t6-final.sh 1 1 1 1918-blue
    bash tools/t6/rea-run.sh kill

`t6-final.sh <era 1..5> <side 1|2> <opp 1..6> <tag>` leaves shots in `docs/captures/startmoney-<tag>-*`
and prints the globals it read beside each one.

## Verbs

- `rea-run.sh start|kill|shoot <tag>|key <keysym>|click <x> <y>|move <x> <y>`
- `t6-dump.py <pid> [side]` — `0x148e/0x1490/0x1446/0x144a/0x144e/0x1452/0x148c/0xe378/0x3eb2/0xe32c`
- `t6-cursor.py <png>` — where the mouse cursor is in a shot, so a click can be aimed
- `t6-spinner.py`, `t6-walk.sh`, `t6-setup.sh` — the setup walk, one stage each
- `read-globals.py` — older dump. Its labels for `0x157e` (time left, not money) and `0x1452`
  (oil out, not income) are **wrong**; kept only for the DS base anchor.

## Never

Do not write a number into `config/game.json` that one of these did not read. A shot without a
globals dump beside it is a picture, not a value.
