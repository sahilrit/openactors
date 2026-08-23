#!/usr/bin/env bash
#
# Puts this server on the public internet with a real HTTPS certificate, so
# Claude's connector — which reaches your server from Anthropic's cloud, not
# from your machine — can see it.
#
# The ordering is the whole point. A quick tunnel picks its hostname when it
# starts, and the server has to advertise that exact hostname in its OAuth
# metadata: a client that discovers "localhost" cannot come back to it. So the
# tunnel starts first, its URL is read, and only then does the server start.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8080}"
CF="$PROJECT/.bin/cloudflared"
LOG="$PROJECT/logs/tunnel.log"

if [ ! -x "$CF" ]; then
  echo "cloudflared is missing. Run: scripts/install-tunnel.sh" >&2
  exit 1
fi
if [ -z "${OAUTH_PASSWORD:-}" ]; then
  echo "OAUTH_PASSWORD must be set — it is the only thing standing between the" >&2
  echo "public internet and a server that runs arbitrary scrapers on this machine." >&2
  exit 1
fi

# Check the port BEFORE opening the tunnel, not after.
#
# Getting this order wrong is not a cosmetic bug: if something else is already
# listening, the tunnel publishes *that* server to the internet — and it may
# well be one started without OAUTH_PASSWORD, i.e. an unauthenticated scraper
# runner reachable by anyone. Refuse instead.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already listening on port $PORT." >&2
  echo "Refusing to open a tunnel: it would publish that server, not this one," >&2
  echo "and it may have no authentication configured." >&2
  echo >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/  /' >&2
  echo >&2
  echo "Stop it, or run with a different PORT." >&2
  exit 1
fi

mkdir -p "$PROJECT/logs"
: > "$LOG"

cleanup() {
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "starting tunnel to localhost:$PORT …"
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC=""
for _ in $(seq 1 60); do
  PUBLIC=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$PUBLIC" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "tunnel exited early:" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 1
done

if [ -z "$PUBLIC" ]; then
  echo "the tunnel did not report a URL within 60s:" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

echo
echo "  Public URL : $PUBLIC"
echo "  Connector  : $PUBLIC/mcp     <- paste this into Claude"
echo "  Console    : $PUBLIC"
echo
echo "Claude will send you to a consent page asking for OAUTH_PASSWORD."
echo "Leave this running; the URL dies when you stop it."
echo

PUBLIC_URL="$PUBLIC" PORT="$PORT" node "$PROJECT/dist/src/http.js" &
SERVER_PID=$!

wait "$SERVER_PID"
