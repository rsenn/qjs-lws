const DEBUG = false;

export function noop() {
  return void 0;
}

export class AssertionError extends Error {}

function assertImpl(test, message) {
  if(!test) throw new AssertionError('Assertion failed' + (message ? `: ${message}` : ''));
}

export const assert = DEBUG ? assertImpl : noop;
export const assert_default = assertImpl;
