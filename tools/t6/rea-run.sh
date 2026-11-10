#!/usr/bin/env bash
# Headless original-game driver for the T-006 starting-money pass.
# Starts Xvfb :99 + DOSBox with CHQ.EXE, exposes tiny verbs so a caller can walk the setup.
set -u
D="${DISPLAY_NUM:-:99}"
CONF="/mnt/nas/projects/Command HQ/dosbox_rea_linux.conf"
OUT="${1:-/tmp}"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> /tmp/rea-run.log; }

case "${2:-}" in
  start)
    if ! DISPLAY="$D" xdotool getdisplaygeometry >/dev/null 2>&1; then
      Xvfb "$D" -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
      sleep 2
    fi
    ( DISPLAY="$D" setsid dosbox -conf "$CONF" >/tmp/dosbox-rea.log 2>&1 & )
    sleep "${3:-14}"
    ;;
  kill)
    pkill -x dosbox-bin 2>/dev/null; pkill -x dosbox 2>/dev/null; sleep 1
    pkill -x Xvfb 2>/dev/null
    ;;
  shoot)
    ffmpeg -hide_banner -loglevel error -f x11grab -video_size 1024x768 -i "$D" -frames:v 1 -y "$OUT/${3:-shot}.png"
    ;;
  key)
    DISPLAY="$D" xdotool key --clearmodifiers "${3:-Return}"; sleep "${4:-0.6}"
    ;;
  click)
    DISPLAY="$D" xdotool mousemove "${3:-512}" "${4:-384}" click 1; sleep "${5:-0.5}"
    ;;
  move)
    DISPLAY="$D" xdotool mousemove "${3:-512}" "${4:-384}"; sleep 0.2
    ;;
  type)
    DISPLAY="$D" xdotool type --delay "${4:-120}" "$3"; sleep 0.4
    ;;
  *) echo "usage: $0 <outdir> start|kill|shoot <name>|key <sym> [pause]|click <x> <y> [pause]|move <x> <y>|type <text> [delay]" ;;
esac
log "verb=${2:-} arg3=${3:-} arg4=${4:-}"
