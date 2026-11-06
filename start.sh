#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
EXEC_MODE="${NOCTURN_EXEC_MODE:-ssh}"
SOCK="${NOCTURN_SOTA_SSH_SOCK:-$HOME/Documents/ChatGPT/multica/.multica/sota-ssh.sock}"
SOTA="${NOCTURN_SOTA_HOST:-root@115.190.90.101}"
SOTA_PORT="${NOCTURN_SOTA_PORT:-10780}"

# 1. If running in SSH mode, ensure SSH control master & reverse tunnels (4100 for Nocturn CLI callback, 8317 for Model Gateway)
if [ "$EXEC_MODE" = "ssh" ]; then
  if ! ssh -p "$SOTA_PORT" -S "$SOCK" -O check "$SOTA" 2>/dev/null; then
    mkdir -p "$(dirname "$SOCK")"
    ssh -fNM -p "$SOTA_PORT" -S "$SOCK" \
      -R 127.0.0.1:4100:127.0.0.1:4100 \
      -R 127.0.0.1:8317:127.0.0.1:8317 \
      "$SOTA"
  else
    ssh -p "$SOTA_PORT" -S "$SOCK" -O forward -R 127.0.0.1:4100:127.0.0.1:4100 "$SOTA" 2>/dev/null || true
    ssh -p "$SOTA_PORT" -S "$SOCK" -O forward -R 127.0.0.1:8317:127.0.0.1:8317 "$SOTA" 2>/dev/null || true
  fi
fi

# 2. Restart Nocturn server on http://localhost:4100
kill -9 $(lsof -ti :4100) 2>/dev/null || true
nohup node --experimental-strip-types src/server/index.ts > /tmp/nocturn-server.log 2>&1 &
sleep 1
echo "✅ Nocturn 已启动 (mode=$EXEC_MODE)：http://localhost:4100"
