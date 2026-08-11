#!/bin/bash
# Test script for CDP Inspector
# This script starts Chrome with remote debugging, opens a test page, and runs the inspector

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=9222
TEST_PAGE="file://$SCRIPT_DIR/inspector-test.html"

echo "=== CDP Inspector Test ==="
echo ""

# Kill any existing Chrome instances on the debug port
echo "Cleaning up any existing Chrome instances on port $PORT..."
pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true
sleep 1

# Start Chrome with remote debugging
echo "Starting Chrome with remote debugging on port $PORT..."
if command -v google-chrome &> /dev/null; then
    CHROME_CMD="google-chrome"
elif command -v chromium &> /dev/null; then
    CHROME_CMD="chromium"
elif command -v chromium-browser &> /dev/null; then
    CHROME_CMD="chromium-browser"
else
    echo "Error: Chrome/Chromium not found. Please install one of:"
    echo "  - google-chrome"
    echo "  - chromium"
    echo "  - chromium-browser"
    exit 1
fi

$CHROME_CMD \
    --remote-debugging-port=$PORT \
    --remote-debugging-address=127.0.0.1 \
    --no-first-run \
    --no-default-browser-check \
    --disable-default-apps \
    --disable-popup-blocking \
    --disable-translate \
    --disable-background-networking \
    --disable-sync \
    --disable-extensions \
    "$TEST_PAGE" &

CHROME_PID=$!
echo "Chrome started (PID: $CHROME_PID)"

# Wait for Chrome to be ready
echo "Waiting for Chrome to be ready..."
for i in {1..10}; do
    if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
        echo "Chrome is ready!"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "Error: Chrome failed to start within 10 seconds"
        kill $CHROME_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

echo ""
echo "Available debug targets:"
curl -s "http://127.0.0.1:$PORT/json/list" | jq -r '.[] | "  - \(.title): \(.url)"'
echo ""

# Run the inspector
echo "Running inspector..."
echo "(Press Ctrl+C to stop)"
echo ""

timeout 30 qjsm inspector.js $PORT

# Cleanup
echo ""
echo "Cleaning up..."
kill $CHROME_PID 2>/dev/null || true
wait $CHROME_PID 2>/dev/null || true

echo "Test complete!"
