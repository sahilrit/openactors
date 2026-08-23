#!/usr/bin/env bash
# Fetches the cloudflared binary into .bin/ — no sudo, no package manager.
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$PROJECT/.bin"
case "$(uname -m)" in
  arm64) PKG=cloudflared-darwin-arm64.tgz ;;
  *)     PKG=cloudflared-darwin-amd64.tgz ;;
esac
curl -fsSL -o /tmp/cloudflared.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/$PKG"
tar -xzf /tmp/cloudflared.tgz -C "$PROJECT/.bin"
chmod +x "$PROJECT/.bin/cloudflared"
"$PROJECT/.bin/cloudflared" --version
