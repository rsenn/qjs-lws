// Inside trapMissing get(target, prop, receiver)
if (!(prop in target)) {
  console.log(`[MISSING] ${label}.${String(prop)}`);
  // Return a noop function so calls like document.body.appendChild() don't throw
  return (...args) => console.log(`[IGNORED CALL] ${label}.${String(prop)}`);
}