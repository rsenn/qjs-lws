#!/bin/sh
# Runs every tests/unittests/test-*.js suite with qjsm and reports overall
# pass/fail. tinytest.js doesn't set a process exit code on failure, so this
# greps its own summary line instead.
#
# Usage: tests/unittests/run-all.sh [qjsm-binary]

set -u
QJSM="${1:-qjsm}"
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

total_failed=0
suites_failed=0

for f in "$DIR"/test-*.js; do
  name="$(basename "$f")"
  out="$("$QJSM" "$f" 2>&1)"
  summary="$(printf '%s\n' "$out" | grep -E 'tests? (succeeded|failed)\.$' | tail -1)"

  if printf '%s' "$summary" | grep -q 'failed\.$'; then
    echo "FAIL  $name: $summary"
    suites_failed=$((suites_failed + 1))
    total_failed=$((total_failed + 1))
  elif [ -n "$summary" ]; then
    echo "OK    $name: $summary"
  else
    echo "ERROR $name: no summary line found (suite crashed?)"
    printf '%s\n' "$out" | tail -20
    suites_failed=$((suites_failed + 1))
  fi
done

echo
if [ "$suites_failed" -eq 0 ]; then
  echo "All suites passed."
  exit 0
else
  echo "$suites_failed suite(s) had failures."
  exit 1
fi
