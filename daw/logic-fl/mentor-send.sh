#!/bin/bash
# mentor-send.sh — upload exported DAW stems to Music Mentor and open the app.
#
# Logic Pro:  File → Export → All Tracks as Audio Files… → choose a folder
# FL Studio:  File → Export → Wave file… → tick "Split mixer tracks" → choose a folder
# Then:       ./mentor-send.sh /path/to/that/folder ["Session title"]
#
# One-time setup:  chmod +x mentor-send.sh
set -euo pipefail

WORKER="https://tt515--music-mentor-worker-api-app.modal.run"
SITE="https://music-mentor-one.vercel.app"

DIR="${1:?Usage: mentor-send.sh /path/to/stems-folder [\"Session title\"]}"
TITLE="${2:-$(basename "$DIR")}"

urlencode() { python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

roster=""
count=0
shopt -s nullglob nocaseglob
for f in "$DIR"/*.{wav,aif,aiff,mp3,flac,m4a}; do
  name="$(basename "$f")"
  echo "Uploading: $name"
  resp="$(curl -s -X POST "$WORKER/upload" -F "file=@$f")"
  id="$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('upload_id',''))" 2>/dev/null || true)"
  if [ -n "$id" ]; then
    [ -n "$roster" ] && roster+=","
    roster+="${id}~$(urlencode "$name")"
    count=$((count+1))
  else
    echo "  ! failed: $resp" | head -c 200; echo
  fi
done

if [ "$count" -eq 0 ]; then
  echo "No files uploaded — is the folder right? ($DIR)"
  exit 1
fi

url="$SITE/?tracks=$roster&title=$(urlencode "$TITLE")"
echo "Uploaded $count stems. Opening Music Mentor…"
open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo "Open manually: $url"
