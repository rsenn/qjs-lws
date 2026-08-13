// Adapted from: https://github.com/web-platform-tests/wpt/blob/master/fetch/api/headers/headers-basic.any.js
// Tests basic Headers functionality

import { Headers } from '../../lib/lws/headers.js';
import { test, promise_test, assert_equals, assert_true, assert_throws_js, runWptTests } from './wpt-harness.js';

test(function() {
  new Headers();
}, "Create headers from no parameter");

test(function() {
  new Headers(undefined);
}, "Create headers from undefined parameter");

test(function() {
  new Headers({});
}, "Create headers from empty object");

const parameters = [null, 1];
parameters.forEach(function(parameter) {
  test(function() {
    assert_throws_js(TypeError, function() { new Headers(parameter) }, "Create headers with " + parameter);
  }, "Create headers with " + parameter + " should throw");
});

const headerDict = {"name1": "value1",
                  "name2": "value2",
                  "name3": "value3",
                  "name4": null,
                  "name5": undefined,
                  "name6": 1,
                  "Content-Type": "value4"
};

const headerSeq = [];
for(const name in headerDict)
  headerSeq.push([name, headerDict[name]]);

test(function() {
  const headers = new Headers(headerSeq);
  for(const name in headerDict) {
    assert_equals(headers.get(name), String(headerDict[name]),
      "name: " + name + " has value: " + headerDict[name]);
  }
  assert_equals(headers.get("length"), null, "init should be treated as a sequence, not as a dictionary");
}, "Create headers with sequence");

test(function() {
  const headers = new Headers(headerDict);
  for(const name in headerDict) {
    assert_equals(headers.get(name), String(headerDict[name]),
      "name: " + name + " has value: " + headerDict[name]);
  }
}, "Create headers with dictionary");

test(function() {
  const headers = new Headers([["name", "value"], ["Name", "Value"]]);
  assert_equals(headers.get("name"), "value, Value", "Duplicate header names should be combined");
}, "Create headers with duplicate names");

test(function() {
  const headers = new Headers([["name1", "value1"]]);
  const headers2 = new Headers(headers);
  assert_equals(headers2.get("name1"), "value1", "Headers should be copied");
  headers.set("name1", "newValue");
  assert_equals(headers2.get("name1"), "value1", "Copied headers should be independent");
}, "Create headers from Headers object");

test(function() {
  const headers = new Headers([["name1", "value1"]]);
  assert_true(headers.has("name1"), "has() should return true for existing header");
  assert_true(!headers.has("name2"), "has() should return false for non-existing header");
  assert_true(headers.has("Name1"), "has() should be case-insensitive");
}, "Headers.has()");

test(function() {
  const headers = new Headers([["name1", "value1"]]);
  headers.set("name2", "value2");
  assert_equals(headers.get("name2"), "value2", "set() should add new header");
  headers.set("name1", "newValue");
  assert_equals(headers.get("name1"), "newValue", "set() should replace existing header");
}, "Headers.set()");

test(function() {
  const headers = new Headers([["name1", "value1"]]);
  headers.append("name1", "value2");
  assert_equals(headers.get("name1"), "value1, value2", "append() should add to existing header");
  headers.append("name2", "value3");
  assert_equals(headers.get("name2"), "value3", "append() should add new header");
}, "Headers.append()");

test(function() {
  const headers = new Headers([["name1", "value1"], ["name2", "value2"]]);
  headers.delete("name1");
  assert_true(!headers.has("name1"), "delete() should remove header");
  assert_equals(headers.get("name2"), "value2", "delete() should not affect other headers");
}, "Headers.delete()");

runWptTests();
