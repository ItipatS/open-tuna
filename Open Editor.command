#!/bin/sh
# Double-click to open the Open Tuna editor (macOS). Keep the Terminal window open; close it to stop.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/serve.py --open
fi
echo "python3 not found. Install it with:  xcode-select --install   (or from python.org), then try again."
read -r _
