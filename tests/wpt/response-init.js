// Adapted from: https://github.com/web-platform-tests/wpt/blob/master/fetch/api/response/response-init-001.any.js
// Tests Response initialization

import { Response } from '../../lib/lws/response.js';
import { test, promise_test, assert_equals, assert_true, runWptTests } from './wpt-harness.js';

const defaultValues = { "type" : "default",
                      "url" : "",
                      "ok" : true,
                      "status" : 200,
                      "statusText" : "",
                      "body" : null
};

const statusCodes = { "givenValues" : [200, 300, 400, 500, 599],
                      "expectedValues" : [200, 300, 400, 500, 599]
};
const statusTexts = { "givenValues" : ["", "OK", "with space", String.fromCharCode(0x80)],
                      "expectedValues" : ["", "OK", "with space", String.fromCharCode(0x80)]
};
const initValuesDict = { "status" : statusCodes,
                         "statusText" : statusTexts
};

function isOkStatus(status) {
  return 200 <= status && 299 >= status;
}

const response = new Response();
for(const attributeName in defaultValues) {
  test(function() {
    const expectedValue = defaultValues[attributeName];
    assert_equals(response[attributeName], expectedValue,
      "Expect default response." + attributeName + " is " + expectedValue);
  }, "Check default value for " + attributeName + " attribute");
}

for(const attributeName in initValuesDict) {
  test(function() {
    const valuesToTest = initValuesDict[attributeName];
    for(const valueIdx in valuesToTest["givenValues"]) {
      const givenValue = valuesToTest["givenValues"][valueIdx];
      const expectedValue = valuesToTest["expectedValues"][valueIdx];
      const responseInit = {};
      responseInit[attributeName] = givenValue;
      const response = new Response("", responseInit);
      assert_equals(response[attributeName], expectedValue,
        "Expect response." + attributeName + " is " + expectedValue +
        " when initialized with " + givenValue);
      assert_equals(response.ok, isOkStatus(response.status),
        "Expect response.ok is " + isOkStatus(response.status));
    }
  }, "Check " + attributeName + " init values and associated getter");
}

test(function() {
  const response = new Response("test body");
  assert_true(response.body !== null, "body should not be null when initialized with string");
}, "Check Response with body");

test(function() {
  const headers = {"Content-Type": "text/plain"};
  const response = new Response("test", {headers: headers});
  assert_equals(response.headers.get("Content-Type"), "text/plain", "headers should be set");
}, "Check Response with headers");

runWptTests();
