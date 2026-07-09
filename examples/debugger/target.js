/**
 * Sample debug target. Run with:
 *   QUICKJS_DEBUG_ADDRESS=127.0.0.1:9229 qjs target.js
 * (server.js must already be listening.) Execution pauses immediately on
 * connect; use the demo page to step through it.
 */
function fib(n) {
  if(n < 2) return n;

  const a = fib(n - 1);
  const b = fib(n - 2);

  return a + b;
}

function main() {
  for(let i = 0; i < 100; i++) {
    const result = fib(i);
    console.log(i, result);
  }
}

main();
