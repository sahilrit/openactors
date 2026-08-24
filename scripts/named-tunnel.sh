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
# A dashboard-created tunnel carries its whole configuration in a token, so it
# needs neither cert.pem nor a local ingress file. That matters here because
# `cloudflared tunnel login` polls an endpoint that is unreliable on some
# networks, and it is the only step the token route skips entirely.
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$CONFIG_DIR/tunnel-token}"
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

# The token route: everything is configured in the Cloudflare dashboard, and
# this only runs the connector.
run_with_token() {
  [ -s "$TOKEN_FILE" ] || return 1
  [ -n "${OAUTH_PASSWORD:-}" ] || {
    echo "OAUTH_PASSWORD must be set — it is the only thing between the public" >&2
    echo "internet and a server that runs arbitrary scrapers on this machine." >&2
    exit 1; }

  local HOST="$1"
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Something is already listening on port $PORT; the tunnel would publish" >&2
    echo "that server rather than this one. Stop it, or set a different PORT." >&2
    exit 1
  fi

  mkdir -p "$PROJECT/logs"
  cleanup() { [ -n "${T:-}" ] && kill "$T" 2>/dev/null || true; [ -n "${S:-}" ] && kill "$S" 2>/dev/null || true; }
  trap cleanup EXIT INT TERM

  "$CF" tunnel --no-autoupdate run --token "$(tr -d '[:space:]' < "$TOKEN_FILE")" \
    > "$PROJECT/logs/tunnel.log" 2>&1 &
  T=$!

  echo "  Connector : https://$HOST/mcp"
  echo "  Console   : https://$HOST"
  echo
  PUBLIC_URL="https://$HOST" PORT="$PORT" node "$PROJECT/dist/src/http.js" &
  S=$!
  wait "$S"
}

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

    # Prefer the token when one exists: it needs no login and no local config.
    if [ -s "$TOKEN_FILE" ]; then
      run_with_token "$HOSTNAME_ARG"
      exit $?
    fi

    [ -f "$CONFIG" ] || { echo "Run setup first, or save a dashboard token to $TOKEN_FILE" >&2; exit 1; }
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
    { [ -f "$CONFIG" ] || [ -s "$TOKEN_FILE" ]; } || { echo "Run setup, or save a dashboard token first." >&2; exit 1; }
    [ -n "${OAUTH_PASSWORD:-}" ] || { echo "Set OAUTH_PASSWORD so the agent inherits it." >&2; exit 1; }

    # Agent logs go to ~/Library/Logs, not the project directory.
    #
    # ~/Documents is TCC-protected: launchd cannot create the stdout/stderr
    # files there, and the agent then starts but does nothing — running with a
    # healthy PID and completely empty logs, which is a maddening thing to
    # debug. ~/Library/Logs is not protected.
    LOG_DIR="$HOME/Library/Logs/openactors"
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    NODE_BIN="$(command -v node)"

    # Two agents invoking their binaries directly, rather than one agent running
    # a shell script.
    #
    # macOS TCC denies /bin/bash access to ~/Documents, so a shell-based agent
    # dies instantly with "Operation not permitted" while the very same command
    # works from a terminal. Calling cloudflared and node directly sidesteps the
    # shell, which is also why the existing digest agent has always worked.
    write_agent() {
      local label="$1" plist="$HOME/Library/LaunchAgents/$1.plist"; shift
      local args=""
      for a in "$@"; do args="$args
    <string>$a</string>"; done

      cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>$args
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OAUTH_PASSWORD</key><string>$OAUTH_PASSWORD</string>
    <key>PUBLIC_URL</key><string>https://$HOSTNAME_ARG</string>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>
</dict>
</plist>
PLIST_EOF
      plutil -lint "$plist" >/dev/null
      launchctl unload "$plist" 2>/dev/null || true
      launchctl load "$plist"
    }

    write_agent "$LABEL" "$CF" tunnel --no-autoupdate --config "$CONFIG" run "$TUNNEL_NAME"
    write_agent "$LABEL.server" "$NODE_BIN" "$PROJECT/dist/src/http.js"

    echo "Installed two agents; both start at login and restart if they die."
    echo "  tunnel : $LABEL"
    echo "  server : $LABEL.server"
    echo "  logs   : $LOG_DIR/"
    ;;

  status)
    [ -s "$TOKEN_FILE" ] && echo "dashboard token: present ($TOKEN_FILE)" || echo "dashboard token: none"
    [ -f "$CONFIG_DIR/cert.pem" ] && echo "cloudflare login: yes" || echo "cloudflare login: NO"
    ID="$(tunnel_id 2>/dev/null || true)"
    echo "tunnel id: ${ID:-(not created yet)}"
    [ -f "$CONFIG" ] && { echo "--- config ---"; sed 's/^/  /' "$CONFIG"; } || echo "config: not written"
    for l in "$LABEL" "$LABEL.server"; do
      launchctl list 2>/dev/null | grep -q "$l" && echo "agent $l: loaded" || echo "agent $l: not loaded"
    done
    ;;

  remove)
    for l in "$LABEL" "$LABEL.server"; do
      launchctl unload "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$l.plist"
    done
    rm -f "$CONFIG"
    echo "Removed the service and config. The tunnel itself still exists;"
    echo "delete it with: $CF tunnel delete $TUNNEL_NAME"
    ;;

  *) usage ;;
esac
