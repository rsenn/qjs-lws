#!/bin/sh
# smoke.sh [REPL.js]: checks that ollama-repl really starts and answers
#
# `qjsm repl.js --help` passes with a missing import or an out-of-scope
# variable, since those only fail when a command runs. This script
#
#   1. imports every file under lib/ on its own (truncated file, missing export),
#      and runs tests/test-rawcolor.js, test-availability.js, test-delegates.js, test-skills.js, test-provider-alias.js, test-quota.js, test-pricing.js, test-own-sockets.js, test-session-store.js, test-session-cache.js, test-session-browser.js, test-empty-reply.js and test-session-env.js
#   2. starts the REPL in a pty in an empty directory, sends a fixed set of
#      commands and fails on any error, exception or unhandled rejection
#
# SMOKE_ARGS adds options to the REPL's command line (the restart passes its own).
# Exit status: 0 all good, 1 a check failed (the output says which).
# Used by hand, and by the self-restart (prepareRestart in repl.js).

REPL=${1:-$(dirname "$0")/repl.js}
DIR=$(cd "$(dirname "$REPL")" && pwd)
REPL=$DIR/$(basename "$REPL")
WAIT=${SMOKE_WAIT:-4}
BAD='error:|Error:|nhandled|is not defined|is read-only|Cannot read'
FAILED=0

# 1. every module loads on its own
for f in $(find "$DIR/lib" -name '*.js' | sort); do
  OUT=$(qjsm -e "import('$f').then(() => 0, e => import('std').then(s => { console.log(e.message); s.exit(1); }))" 2>&1) ||
    { echo "FAIL import $f: $OUT"; FAILED=1; }
done

# 1b. the colouring of the verbose view only adds colour
OUT=$(cd "$DIR" && qjsm tests/test-rawcolor.js 2>&1) || { echo "FAIL rawcolor: $OUT"; FAILED=1; }

# 1d. the delegate memory ranks and learns
OUT=$(cd "$DIR" && qjsm tests/test-delegates.js 2>&1) || { echo "FAIL delegates: $OUT"; FAILED=1; }

# 1e. skills are found in both directories
OUT=$(cd "$DIR" && qjsm tests/test-skills.js 2>&1) || { echo "FAIL skills: $OUT"; FAILED=1; }

# 1c. the gateway limits are worked out right (fake gateway)
OUT=$(cd "$DIR" && qjsm tests/test-availability.js 2>&1) || { echo "FAIL availability: $OUT"; FAILED=1; }

# 1d. --provider aliases resolve to the right env variables
OUT=$(cd "$DIR" && timeout 30 qjsm tests/test-provider-alias.js 2>&1) || { echo "FAIL provider-alias: $OUT"; FAILED=1; }

# 1e. /quota reads the rate-limit headers right
OUT=$(cd "$DIR" && timeout 30 qjsm tests/test-quota.js 2>&1) || { echo "FAIL quota: $OUT"; FAILED=1; }

# 1f. cost estimates from the price table
OUT=$(cd "$DIR" && timeout 30 qjsm tests/test-pricing.js 2>&1) || { echo "FAIL pricing: $OUT"; FAILED=1; }
OUT=$(cd "$DIR" && timeout 30 qjsm tests/test-own-sockets.js 2>&1) || { echo "FAIL own-sockets: $OUT"; FAILED=1; }

# 1g. the session files: atomic session.json, keys, saved settings, listing and pruning
for T in session-store session-cache session-browser empty-reply session-env quota-panel shared-spinner press-counter; do
  OUT=$(cd "$DIR" && timeout 30 qjsm tests/test-$T.js 2>&1) || { echo "FAIL $T: $OUT"; FAILED=1; }
done

# 2. the REPL starts and runs commands
WORK=$(mktemp -d) || exit 1
SOCK=/tmp/or-sm-$$.s # short, to stay clear of the 107 byte limit
trap 'rm -rf "$WORK" "$SOCK"' EXIT
cd "$WORK" || exit 1

LOG=$WORK/out.txt
{
  sleep "$WAIT"
  for c in /help /mode /tools /status /model /verbose /quit; do
    printf '%s\r' "$c"
    sleep 1
  done
} | timeout 60 script -qec "qjsm '$REPL' --listen '$SOCK' $SMOKE_ARGS" /dev/null > "$LOG" 2>&1
STATUS=$?

# the pty output without escape sequences
CLEAN=$WORK/clean.txt
sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b[78]//g' "$LOG" > "$CLEAN"

grep -q '✔ ready' "$CLEAN" || { echo "FAIL repl never printed ready"; FAILED=1; }
[ "$STATUS" = 0 ] || { echo "FAIL repl exit status $STATUS"; FAILED=1; }

if grep -E "$BAD" "$CLEAN" | grep -v 'resumed session' > "$WORK/bad.txt"; then
  echo "FAIL repl printed errors:"
  head -n 8 "$WORK/bad.txt"
  FAILED=1
fi

[ "$FAILED" = 0 ] && echo "smoke ok: $(find "$DIR/lib" -name '*.js' | wc -l) modules, repl started and ran 7 commands"
exit $FAILED
