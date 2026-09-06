#!/bin/sh
# Runs the test-page/token server and the LiveKit agent worker in one container.
set -e
cd "$(dirname "$0")"
python token_server.py &
TOKEN_PID=$!
trap 'kill $TOKEN_PID 2>/dev/null' EXIT
exec python agent.py start
