/**
 * Very simple in-browser unit-test library, with zero deps.
 *
 * Background turns green if all tests pass, otherwise red.
 * View the JavaScript console to see failure reasons.
 *
 * Example:
 *
 *   adder.js (code under test)
 *
 *     function add(a, b) {
 *       return a + b;
 *     }
 *
 *   adder-test.html (tests - just open a browser to see results)
 *
 *     <script src="tinytest.js"></script>
 *     <script src="adder.js"></script>
 *     <script>
 *
 *     tests({
 *
 *       'adds numbers'() {
 *         eq(6, add(2, 4));
 *         eq(6.6, add(2.6, 4));
 *       },
 *
 *       'subtracts numbers'() {
 *         eq(-2, add(2, -4));
 *       },
 *
 *     });
 *     </script>
 *
 * That's it. Stop using over complicated frameworks that get in your way.
 *
 * -Joe Walnes
 * MIT License. See https://github.com/joewalnes/jstinytest/
 */
import { getenv, exit } from 'std';

const only = getenv('TEST_ONLY');

class Skip extends Error {}

const TinyTest = {
  async run(tests) {
    let count = 0,
      failures = 0,
      skipped = 0;

    for(let testName in tests) {
      if(only && !only.split('|').some(o => testName.includes(o))) continue; // TEST_ONLY=<substring>[|<substring>...]: run just the matching tests
      let testAction = tests[testName];
      //console.log('Test:', testName, testAction);
      try {
        await testAction();
        console.log('\u2705 Test:', testName);
      } catch(e) {
        if(e instanceof Skip) {
          skipped++;
          console.log('\u26a0\ufe0f  Test:', testName, `(skipped: ${e.message})`);
        } else {
          failures++;
          (console.error || console.log).call(console, '\u274c Test:', testName, 'FAILED', e);
          (console.error || console.log).call(console, e.stack);
        }
      }
      count++;
    }

    /* the summary line keeps its shape: run-all.sh greps it */
    if(skipped) console.log(`\u26a0\ufe0f  ${skipped} skipped`);
    if(failures) {
      console.log(`${failures} out of ${count} tests failed.`);
      exit(1); /* so ctest sees the failure, and a server a failed test left running cannot hang the run */
    } else console.log(`${count - skipped} tests succeeded.`);
  },

  /* skip the running test (shown as a warning, not a failure) */
  skip(reason) {
    throw new Skip(reason);
  },

  /* import an optional module (one from qjs-modules, say) or skip the test */
  async needs(name) {
    try {
      return await import(name);
    } catch(e) {
      throw new Skip(`needs the '${name}' module`);
    }
  },

  fail(msg) {
    throw new Error('fail(): ' + msg);
  },

  assert(value, msg) {
    if(!value) {
      throw new Error('assert(): ' + msg);
    }
  },

  assertEquals(expected, actual) {
    if(expected != actual) {
      throw new Error('assertEquals() "' + expected + '" != "' + actual + '"');
    }
  },

  assertStrictEquals(expected, actual) {
    if(expected !== actual) {
      throw new Error('assertStrictEquals() "' + expected + '" !== "' + actual + '"');
    }
  },
};

export const fail = TinyTest.fail,
  skip = TinyTest.skip,
  needs = TinyTest.needs,
  assert = TinyTest.assert,
  assertEquals = TinyTest.assertEquals,
  eq = TinyTest.assertEquals, // alias for assertEquals
  assertStrictEquals = TinyTest.assertStrictEquals,
  tests = TinyTest.run;
