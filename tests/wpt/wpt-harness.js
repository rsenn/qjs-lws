// Adapter for WPT (Web Platform Tests) harness to work with qjsm
// Maps WPT test functions to tinytest framework

import { tests, eq, assert, fail } from '../unittests/tinytest.js';

const pendingTests = {};
const pendingPromiseTests = [];

function test(fn, name) {
  pendingTests[name] = fn;
}

function promise_test(fn, name) {
  pendingPromiseTests.push({ fn, name });
}

function assert_equals(actual, expected, message) {
  if(actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert_true(condition, message) {
  if(!condition) {
    throw new Error(`${message}: expected true, got ${condition}`);
  }
}

function assert_false(condition, message) {
  if(condition) {
    throw new Error(`${message}: expected false, got ${condition}`);
  }
}

function assert_throws_js(errorType, fn, message) {
  try {
    fn();
    throw new Error(`${message}: expected ${errorType.name} to be thrown`);
  } catch(e) {
    if(!(e instanceof errorType)) {
      throw new Error(`${message}: expected ${errorType.name}, got ${e.constructor.name}`);
    }
  }
}

function assert_array_equals(actual, expected, message) {
  if(!Array.isArray(actual) || !Array.isArray(expected)) {
    throw new Error(`${message}: both values must be arrays`);
  }
  if(actual.length !== expected.length) {
    throw new Error(`${message}: array lengths differ (${actual.length} vs ${expected.length})`);
  }
  for(let i = 0; i < actual.length; i++) {
    if(actual[i] !== expected[i]) {
      throw new Error(`${message}: arrays differ at index ${i} (${actual[i]} vs ${expected[i]})`);
    }
  }
}

async function runWptTests() {
  // Run synchronous tests
  const testObj = {};
  for(const [name, fn] of Object.entries(pendingTests)) {
    testObj[name] = fn;
  }
  
  // Run promise tests
  for(const { fn, name } of pendingPromiseTests) {
    testObj[name] = async () => await fn({ done: () => {} });
  }
  
  await tests(testObj);
}

export { test, promise_test, assert_equals, assert_true, assert_false, assert_throws_js, assert_array_equals, runWptTests };
