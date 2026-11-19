#!/bin/bash
# Runs the bridge against a fake chat site in a throwaway headless Chrome
# (own profile, own CDP port: your own browser is not touched).
# fake and fakerot are on purpose: a site whose name contains another's must stay reachable.
#
#   examples/chat-bridge/test/run.sh
#
# Needs google-chrome (or $CHROME) and qjsm.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-google-chrome}"
CDP="${CDP_PORT:-9333}" SITE="${SITE_PORT:-18080}" BRIDGE="${BRIDGE_PORT:-18089}"
SITEA="${SITE_A_PORT:-18081}" SITEB="${SITE_B_PORT:-18082}" # two more pages for the routing tests
W="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  for _ in 1 2 3 4 5; do rm -rf "$W" 2>/dev/null && break; sleep 1; done # chrome may still be writing its profile
}
trap cleanup EXIT
trap 'exit 143' TERM INT

cat > "$W/sites.json" <<JSON
{
  "\$replace": true,
  "fake":    { "host": "localhost:$SITE", "home": "http://localhost:$SITE/", "input": "textarea", "reply": ".reply", "name": "Fake", "context": 8000, "auto": false, "pick": { "url": "http://localhost:$SITE/?model={model}" } },
  "fakerot": { "host": "127.0.0.2:$SITE", "home": "http://127.0.0.2:$SITE/", "input": "textarea", "reply": ".reply", "auto": false, "timeout": 2, "models": ["gpt-a", "gpt-b"], "pick": { "open": "#model-open", "option": ".model-opt" } },
  "rotted": { "host": "127.0.0.1:$SITE", "home": "http://127.0.0.1:$SITE/", "input": "textarea", "reply": ".reply", "auto": false },
  "alpha":  { "host": "localhost:$SITEA", "home": "http://localhost:$SITEA/", "input": "textarea", "reply": ".reply", "rank": 1 },
  "omega":  { "host": "localhost:$SITEB", "home": "http://localhost:$SITEB/", "input": "textarea", "reply": ".reply", "rank": 2 }
}
JSON

wait_port() { for _ in $(seq 100); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.2; done; echo "nothing on port $1" >&2; return 1; }

"$CHROME" --headless=new --remote-debugging-port="$CDP" --user-data-dir="$W/profile" --no-first-run about:blank >"$W/chrome.log" 2>&1 &
PIDS+=($!)
qjsm "$HERE/fake-site-server.js" "$SITE" "$HERE" >"$W/site.log" 2>&1 </dev/null &
PIDS+=($!)
for port in "$SITEA" "$SITEB"; do
  qjsm "$HERE/fake-site-server.js" "$port" "$HERE" >"$W/site-$port.log" 2>&1 </dev/null &
  PIDS+=($!)
done
wait_port "$CDP" && wait_port "$SITE" && wait_port "$SITEA" && wait_port "$SITEB" || exit 2
# the bridge only navigates blank tabs that exist (see --new-tabs): headless
# Chrome starts with one, two more make three chats possible
for _ in 1 2 3 4; do curl -s -X PUT "http://127.0.0.1:$CDP/json/new?about:blank" >/dev/null; done

CHAT_BRIDGE_STATE="$W/state.json" CHAT_BRIDGE_SITES="$W/sites.json" qjsm "$HERE/../chat-bridge.js" --port "$CDP" --listen "$BRIDGE" --idle 1 --timeout 10 serve >"$W/bridge.log" 2>&1 </dev/null &
PIDS+=($!)
wait_port "$BRIDGE" || { cat "$W/bridge.log"; exit 2; }

# HOLD=1: leave the bridge and the pages running for manual tries (curl 127.0.0.1:$BRIDGE)
[ -n "${HOLD:-}" ] && { echo "bridge on $BRIDGE, site on $SITE, press ^C"; sleep 900; exit 0; }
qjsm "$HERE/probe.js" "http://127.0.0.1:$BRIDGE/v1" "$SITEA"
rc=$?
# last: the limit test of the probe has made the learned quota of the fake site visible
qjsm "$HERE/shape.js" "http://127.0.0.1:$BRIDGE/v1" fake || rc=1
# the harness reads the bridge like a gateway: its limits, health and usage show up in the commands
if [ $rc -eq 0 ]; then
  H="$HERE/../../ollama-repl/repl.js"
  out=$(printf '/gateway providers\n/gateway limited\n/gateway usage\n/model list all\n/route smart\n/exit\n' | OPENAI_API_URL="http://127.0.0.1:$BRIDGE/v1" XDG_CONFIG_HOME="$W/cfg" timeout 60 qjsm "$H" --provider openai --model fake 2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g')
  echo "$out" > "$W/harness.txt"
  if echo "$out" | grep -q "fake .*rate_limited" && echo "$out" | grep -q "cannot serve a request" && echo "$out" | grep -q "gateway month" && echo "$out" | grep -qE "^fake +fake +cooldown in " && echo "$out" | grep -q "routing: auto:smart"; then echo "✅ the harness shows the bridge's providers, limits and usage"; else echo "❌ the harness does not read the bridge"; echo "$out" | tail -25; rc=1; fi
fi

# a restart keeps the limit the probe ran into (state.json): the site is still exhausted, with its reset time
if [ $rc -eq 0 ]; then
  kill "${PIDS[-1]}"; wait "${PIDS[-1]}" 2>/dev/null; unset 'PIDS[-1]'
  CHAT_BRIDGE_STATE="$W/state.json" CHAT_BRIDGE_SITES="$W/sites.json" qjsm "$HERE/../chat-bridge.js" --port "$CDP" --listen "$BRIDGE" --idle 1 --timeout 10 serve >>"$W/bridge.log" 2>&1 </dev/null &
  PIDS+=($!)
  wait_port "$BRIDGE" || { cat "$W/bridge.log"; exit 2; }
  if curl -s "http://127.0.0.1:$BRIDGE/v1/models" | grep -q '"execution_status":"exhausted"'; then echo "✅ a restart keeps the cooldown"; else echo "❌ a restart forgot the cooldown"; rc=1; fi
fi
[ $rc -ne 0 ] && { echo "--- bridge log"; tail -20 "$W/bridge.log"; }
exit $rc
