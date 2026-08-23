#!/usr/bin/env bash
#
# Installs (or removes) a launchd agent that runs the digest daily.
#
# launchd rather than cron: it survives reboots, needs no always-running
# process, and catches up a missed run when the Mac was asleep at the scheduled
# time — which cron does not, and which matters for a laptop that is not on at
# 08:00 every day.
set -euo pipefail

LABEL="com.openactors.digest"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
HOUR="${DIGEST_HOUR:-8}"
MINUTE="${DIGEST_MINUTE:-0}"

usage() { echo "usage: $0 [install|uninstall|status|run]"; exit 1; }
[ $# -eq 1 ] || usage

case "$1" in
  install)
    if [ ! -f "$PROJECT/dist/src/digest.js" ]; then
      echo "dist/ is missing or stale. Run 'npm run build' first." >&2
      exit 1
    fi
    if [ ! -f "$PROJECT/searches.json" ]; then
      echo "No searches.json. Copy searches.example.json and edit it first." >&2
      exit 1
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/logs"

    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$PROJECT/dist/src/digest.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <!-- Run as soon as the Mac wakes if it was asleep at the scheduled time. -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$PROJECT/logs/digest.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/logs/digest.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

    plutil -lint "$PLIST" >/dev/null
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    printf 'Installed. Runs daily at %02d:%02d.\n' "$HOUR" "$MINUTE"
    echo "  logs:      $PROJECT/logs/digest.log"
    echo "  digest:    $PROJECT/digests/latest.md"
    echo "  remove:    $0 uninstall"
    ;;

  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL."
    ;;

  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "loaded:"; launchctl list | grep "$LABEL"
    else
      echo "not loaded"
    fi
    [ -f "$PROJECT/logs/digest.log" ] && { echo "--- last log ---"; tail -8 "$PROJECT/logs/digest.log"; }
    ;;

  run)
    # Runs exactly as launchd would, which is what makes this useful for
    # debugging: the same binary, working directory and environment.
    cd "$PROJECT" && "$NODE" dist/src/digest.js
    ;;

  *) usage ;;
esac
