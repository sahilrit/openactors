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
MINUTE="${DIGEST_MINUTE:-0}"
# Hours between runs. 24 means once a day at DIGEST_HOUR; a smaller divisor of
# 24 (1,2,3,4,6,8,12) schedules several fixed times a day.
EVERY="${DIGEST_EVERY_HOURS:-24}"
HOUR="${DIGEST_HOUR:-$([ "$EVERY" -eq 24 ] && echo 8 || echo 0)}"

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

    if [ "$EVERY" -lt 1 ] || [ "$EVERY" -gt 24 ] || [ $((24 % EVERY)) -ne 0 ]; then
      echo "DIGEST_EVERY_HOURS must divide 24 evenly (1,2,3,4,6,8,12,24); got $EVERY" >&2
      exit 1
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/logs"

    # Fixed clock times rather than StartInterval: an interval timer drifts and
    # restarts from zero on reboot, while calendar entries stay predictable and
    # let launchd catch up a run missed while the Mac was asleep.
    if [ "$EVERY" -eq 24 ]; then
      INTERVALS=$(printf '  <dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>' "$HOUR" "$MINUTE")
      SCHEDULE_DESC=$(printf 'daily at %02d:%02d' "$HOUR" "$MINUTE")
    else
      INTERVALS="  <array>"
      TIMES=""
      h=$HOUR
      while [ "$h" -lt 24 ]; do
        INTERVALS="$INTERVALS
    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$MINUTE</integer></dict>"
        TIMES="$TIMES $(printf '%02d:%02d' "$h" "$MINUTE")"
        h=$((h + EVERY))
      done
      INTERVALS="$INTERVALS
  </array>"
      SCHEDULE_DESC="every ${EVERY}h at${TIMES}"
    fi

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
$INTERVALS
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
    echo "Installed. Runs $SCHEDULE_DESC."
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
    # Guarded so a missing log (nothing has run yet) is not reported as a
    # failure by this command's own exit code.
    if [ -f "$PROJECT/logs/digest.log" ]; then
      echo "--- last run ---"
      tail -8 "$PROJECT/logs/digest.log"
    else
      echo "(no runs yet)"
    fi
    ;;

  run)
    # Runs exactly as launchd would, which is what makes this useful for
    # debugging: the same binary, working directory and environment.
    cd "$PROJECT" && "$NODE" dist/src/digest.js
    ;;

  *) usage ;;
esac
