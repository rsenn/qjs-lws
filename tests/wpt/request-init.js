// Adapted from: https://github.com/web-platform-tests/wpt/blob/master/fetch/api/request/request-init-002.any.js
// Tests Request initialization

import { Request } from '../../lib/lws/request.js';
import { Headers } from '../../lib/lws/headers.js';
import { test, promise_test, assert_equals, assert_true, assert_throws_js, runWptTests } from './wpt-harness.js';

test(function() {
  const headerDict = {"name1": "value1",
                      "name2": "value2",
                      "name3": "value3"
                      };
  const headers = new Headers(headerDict);
  const request = new Request("http://example.com", { "headers" : headers });
  for(const name in headerDict) {
    assert_equals(request.headers.get(name), headerDict[name],
      "request's headers has " + name + " : " + headerDict[name]);
  }
}, "Initialize Request with headers values");

function makeRequestInit(body, method) {
  return {"method": method, "body": body};
}

function checkRequestInit(body, bodyType, expectedTextBody) {
  promise_test(function(test) {
    const request = new Request("http://example.com", makeRequestInit(body, "POST"));
    if(body) {
      assert_throws_js(TypeError, function() { new Request("http://example.com", makeRequestInit(body, "GET")); }, "GET with body");
      assert_throws_js(TypeError, function() { new Request("http://example.com", makeRequestInit(body, "HEAD")); }, "HEAD with body");
    } else {
      new Request("http://example.com", makeRequestInit(body, "GET")); // should not throw
    }
    const reqHeaders = request.headers;
    const mime = reqHeaders.get("Content-Type");
    assert_true(!body || (mime && mime.search(bodyType) > -1), "Content-Type header should be \"" + bodyType + "\", not \"" + mime + "\"");
    return request.text().then(function(bodyAsText) {
      assert_true(bodyAsText.search(expectedTextBody) > -1, "Retrieve and verify request body");
    });
  }, `Initialize Request's body with "${body}", ${bodyType}`);
}

checkRequestInit(undefined, undefined, "");
checkRequestInit(null, null, "");
checkRequestInit("This is a USVString", "text/plain;charset=UTF-8", "This is a USVString");

test(function() {
  const request = new Request("http://example.com");
  assert_equals(request.method, "GET", "default method should be GET");
  assert_equals(request.url, "http://example.com/", "url should be normalized");
  assert_equals(request.body, null, "default body should be null");
}, "Check Request default values");

test(function() {
  const request = new Request("http://example.com", {method: "POST", body: "test"});
  assert_equals(request.method, "POST", "method should be POST");
  assert_true(request.body !== null, "body should not be null");
}, "Check Request with custom method and body");

runWptTests();
