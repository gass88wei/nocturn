#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
SOCK="/Users/yangxin/Documents/ChatGPT/multica/.multica/sota-ssh.sock"
SOTA="root@115.190.90.101"
SOTA_PORT="10780"

# 1. Ensure SSH control master & reverse tunnels (4100 for Nocturn CLI callback, 8317 for Model Gateway)
if ! ssh -p "$SOTA_PORT" -S "$SOCK" -O check "$SOTA" 2>/dev/null; then
  mkdir -p "$(dirname "$SOCK")"
  ssh -fNM -p "$SOTA_PORT" -S "$SOCK" \
    -R 127.0.0.1:4100:127.0.0.1:4100 \
    -R 127.0.0.1:8317:127.0.0.1:8317 \
    "$SOTA"
else
  ssh -p "$SOTA_PORT" -S "$SOCK" -O forward -R 127.0.0.1:4100:127.0.0.1:4100 "$SOTA" || true
  ssh -p "$SOTA_PORT" -S "$SOCK" -O forward -R 127.0.0.1:8317:127.0.0.1:8317 "$SOTA" || true
fi

# 2. Restart Nocturn server on http://localhost:4100
kill -9 $(lsof -ti :4100) 2>/dev/null || true
nohup node --experimental-strip-types src/server/index.ts > /tmp/nocturn-server.log 2>&1 &
sleep 1
echo "✅ Nocturn 已启动并连接 sota (/home/qijinyin/multimodal/yangxin/nocturn)：http://localhost:4100"
