#!/bin/bash
# Runs the bridge against a fake chat site in a throwaway headless Chrome
# (own profile, own CDP port: your own browser is not touched).
# The site names must not contain one another: the bridge picks the site
# whose name is a substring of the model name (see BUGS).
#
#   examples/chat-bridge/test/run.sh
#
# Needs google-chrome (or $CHROME) and qjsm.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-google-chrome}"
CDP="${CDP_PORT:-9333}" SITE="${SITE_PORT:-18080}" BRIDGE="${BRIDGE_PORT:-18089}"
W="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  for _ in 1 2 3 4 5; do rm -rf "$W" 2>/dev/null && break; sleep 1; done # chrome may still be writing its profile
}
trap cleanup EXIT

cat > "$W/sites.json" <<JSON
{
  "fake":    { "host": "localhost:$SITE", "home": "http://localhost:$SITE/", "input": "textarea", "reply": ".reply", "name": "Fake", "context": 8000 },
  "rotted": { "host": "127.0.0.1:$SITE", "home": "http://127.0.0.1:$SITE/", "input": "textarea", "reply": ".reply" }
}
JSON

wait_port() { for _ in $(seq 100); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.2; done; echo "nothing on port $1" >&2; return 1; }

"$CHROME" --headless=new --remote-debugging-port="$CDP" --user-data-dir="$W/profile" --no-first-run about:blank >"$W/chrome.log" 2>&1 &
PIDS+=($!)
qjsm "$HERE/fake-site-server.js" "$SITE" "$HERE" >"$W/site.log" 2>&1 </dev/null &
PIDS+=($!)
wait_port "$CDP" && wait_port "$SITE" || exit 2
# the bridge only navigates blank tabs that exist (see --new-tabs): headless
# Chrome starts with one, two more make three chats possible
for _ in 1 2; do curl -s -X PUT "http://127.0.0.1:$CDP/json/new?about:blank" >/dev/null; done

CHAT_BRIDGE_SITES="$W/sites.json" qjsm "$HERE/../chat-bridge.js" --port "$CDP" --listen "$BRIDGE" --idle 1 --timeout 10 serve >"$W/bridge.log" 2>&1 </dev/null &
PIDS+=($!)
wait_port "$BRIDGE" || { cat "$W/bridge.log"; exit 2; }

qjsm "$HERE/shape.js" "http://127.0.0.1:$BRIDGE/v1" fake || exit 1
qjsm "$HERE/probe.js" "http://127.0.0.1:$BRIDGE/v1"
rc=$?
[ $rc -ne 0 ] && { echo "--- bridge log"; tail -20 "$W/bridge.log"; }
exit $rc
