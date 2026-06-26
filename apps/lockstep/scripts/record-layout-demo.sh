#!/usr/bin/env bash
set -euo pipefail

ELECTRON_BIN="/workspace/node_modules/.pnpm/electron@41.1.1/node_modules/electron/dist/electron"
URL="http://127.0.0.1:5200/showcase-preview.html?record=1"
WINDOW_W=1280
WINDOW_H=960
WINDOW_X=320
WINDOW_Y=120

killall -9 electron 2>/dev/null || true
pkill -f "google-chrome.*showcase-preview" 2>/dev/null || true
sleep 1

if [[ -x "$ELECTRON_BIN" ]]; then
  chmod -x "$ELECTRON_BIN"
  restore_electron() { chmod +x "$ELECTRON_BIN"; }
  trap restore_electron EXIT
fi

google-chrome \
  --app="$URL" \
  --window-size="$WINDOW_W,$WINDOW_H" \
  --window-position="$WINDOW_X,$WINDOW_Y" \
  --disable-infobars \
  --no-first-run \
  >/dev/null 2>&1 &

echo "Recording demo for 36 seconds..."
sleep 36
echo "Done."
