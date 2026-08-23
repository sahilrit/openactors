#!/usr/bin/env bash
#
# A permanent public URL via a named Cloudflare tunnel.
#
# Unlike a quick tunnel, the hostname never changes — so Claude's connector
# keeps working across restarts instead of needing to be re-added every time.
#
# Requires a domain on your Cloudflare account. That is Cloudflare's
# constraint, not this script's: named tunnels route through a zone you
# control, and there is no free Cloudflare-provided hostname for them.
#
#   scripts/named-tunnel.sh setup   jobs.example.com
#   scripts/named-tunnel.sh run     jobs.example.com
#   scripts/named-tunnel.sh install jobs.example.com   # start at login
#   scripts/named-tunnel.sh status
#   scripts/named-tunnel.sh remove
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF="$PROJECT/.bin/cloudflared"
TUNNEL_NAME="${TUNNEL_NAME:-openactors}"
PORT="${PORT:-8080}"
CONFIG_DIR="$HOME/.cloudflared"
CONFIG="$CONFIG_DIR/openactors.yml"
LABEL="com.openactors.tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() { sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 1 ] || usage
ACTION="$1"; HOSTNAME_ARG="${2:-}"

require_login() {
  if [ ! -f "$CONFIG_DIR/cert.pem" ]; then
    echo "Not logged in to Cloudflare yet. Run:" >&2
    echo "    $CF tunnel login" >&2
    echo >&2
    echo "That opens a browser, asks you to pick a domain you own, and writes" >&2
    echo "$CONFIG_DIR/cert.pem. It is the one step that needs your account." >&2
    exit 1
  fi
}

tunnel_id() { "$CF" tunnel list --output json 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try { const t=JSON.parse(s).find(t=>t.name==='$TUNNEL_NAME'); console.log(t?t.id:''); }
    catch { console.log(''); }
  });"; }

case "$ACTION" in
  setup)
    [ -n "$HOSTNAME_ARG" ] || { echo "Give the hostname, e.g. jobs.example.com" >&2; exit 1; }
    require_login

    ID="$(tunnel_id)"
    if [ -z "$ID" ]; then
      echo "creating tunnel '$TUNNEL_NAME' …"
      "$CF" tunnel create "$TUNNEL_NAME"
      ID="$(tunnel_id)"
    else
      echo "tunnel '$TUNNEL_NAME' already exists ($ID)"
    fi
    [ -n "$ID" ] || { echo "could not determine the tunnel id" >&2; exit 1; }

    # Points the hostname at this tunnel. Idempotent: re-running only updates
    # the CNAME, so a changed hostname does not need the tunnel rebuilt.
    echo "routing $HOSTNAME_ARG -> $TUNNEL_NAME …"
    "$CF" tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_ARG"

    cat > "$CONFIG" <<YAML
tunnel: $ID
credentials-file: $CONFIG_DIR/$ID.json

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://localhost:$PORT
  # Cloudflare requires a catch-all; without it the config is rejected.
  - service: http_status:404
YAML

    echo
    echo "  Config     : $CONFIG"
    echo "  Hostname   : https://$HOSTNAME_ARG"
    echo "  Connector  : https://$HOSTNAME_ARG/mcp"
    echo
    echo "Next: scripts/named-tunnel.sh run $HOSTNAME_ARG"
    ;;

  run)
    [ -n "$HOSTNAME_ARG" ] || { echo "Give the hostname" >&2; exit 1; }
    [ -f "$CONFIG" ] || { echo "Run setup first." >&2; exit 1; }
    [ -n "${OAUTH_PASSWORD:-}" ] || {
      echo "OAUTH_PASSWORD must be set — it is the only thing between the public" >&2
      echo "internet and a server that runs arbitrary scrapers on this machine." >&2
      exit 1; }

    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Something is already listening on port $PORT; the tunnel would publish" >&2
      echo "that server rather than this one. Stop it, or set a different PORT." >&2
      exit 1
    fi

    mkdir -p "$PROJECT/logs"
    cleanup() { [ -n "${T:-}" ] && kill "$T" 2>/dev/null || true; [ -n "${S:-}" ] && kill "$S" 2>/dev/null || true; }
    trap cleanup EXIT INT TERM

    "$CF" tunnel --config "$CONFIG" run "$TUNNEL_NAME" > "$PROJECT/logs/tunnel.log" 2>&1 &
    T=$!
    echo "  Connector : https://$HOSTNAME_ARG/mcp"
    echo "  Console   : https://$HOSTNAME_ARG"
    echo

    PUBLIC_URL="https://$HOSTNAME_ARG" PORT="$PORT" node "$PROJECT/dist/src/http.js" &
    S=$!
    wait "$S"
    ;;

  install)
    [ -n "$HOSTNAME_ARG" ] || { echo "Give the hostname" >&2; exit 1; }
    [ -f "$CONFIG" ] || { echo "Run setup first." >&2; exit 1; }
    [ -n "${OAUTH_PASSWORD:-}" ] || { echo "Set OAUTH_PASSWORD so the agent inherits it." >&2; exit 1; }

    mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/logs"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT/scripts/named-tunnel.sh</string>
    <string>run</string>
    <string>$HOSTNAME_ARG</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OAUTH_PASSWORD</key><string>$OAUTH_PASSWORD</string>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/logs/service.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/logs/service.err.log</string>
</dict>
</plist>
PLIST_EOF
    plutil -lint "$PLIST" >/dev/null
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed. The tunnel and server now start at login and restart if they die."
    echo "  logs: $PROJECT/logs/service.log"
    ;;

  status)
    [ -f "$CONFIG_DIR/cert.pem" ] && echo "cloudflare login: yes" || echo "cloudflare login: NO"
    ID="$(tunnel_id 2>/dev/null || true)"
    echo "tunnel id: ${ID:-(not created yet)}"
    [ -f "$CONFIG" ] && { echo "--- config ---"; sed 's/^/  /' "$CONFIG"; } || echo "config: not written"
    launchctl list 2>/dev/null | grep -q "$LABEL" && echo "service: loaded" || echo "service: not loaded"
    ;;

  remove)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST" "$CONFIG"
    echo "Removed the service and config. The tunnel itself still exists;"
    echo "delete it with: $CF tunnel delete $TUNNEL_NAME"
    ;;

  *) usage ;;
esac
