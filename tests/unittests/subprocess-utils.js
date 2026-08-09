/**
 * Helpers for tests/unittests/test-server.js and test-client.js: each test
 * there exercises one half (server or client) of a connection by spawning
 * the *other* half as a separate `qjsm` subprocess, so the two sides run in
 * genuinely independent event loops - the same shape a real client and a
 * real server would have.
 */
import * as os from 'os';

/**
 * A port unlikely to collide with another concurrently-running instance of
 * this same suite (or the OS's own ephemeral range) - spread by pid so two
 * `run-all.sh` invocations racing each other still land on different ports.
 * Uses its own counter (not `seq`, shared with tmpPath()) so callers can
 * freely interleave freePort() and spawnQjsm() calls without either one's
 * numbering affecting the other's spread.
 */
export function freePort() {
  return 19000 + (os.getpid() % 4000) + (portSeq++ % 50);
}
