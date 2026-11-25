// QuickJS unit test for colorReasoning from rawcolor.js
// Tests the structured ANSI highlighting for reasoning text

import { colorReasoning } from '../examples/ollama-repl/lib/rawcolor.js';

// Test 1: Basic text without special formatting
const basic = colorReasoning("Hello world");
assert(basic.includes('\x1b[3;38;2;125;211;252m'), "Basic text should have base SGR");
assert(basic.includes('\x1b[0m'), "Basic text should have RESET");
assert(basic.replace(/\x1b\[[0-9;]*m/g, '') === 'Hello world', "Basic text content preserved");

// Test 2: Inline backtick spans
const withBacktick = colorReasoning("Hello \`code\` world");
assert(withBacktick.includes('\x1b[38;2;163;230;53m'), "Inline backtick should have lime color");
assert(withBacktick.includes('\x1b[0m'), "Inline backtick should have RESET");

// Test 3: List markers
const withList = colorReasoning("- item 1\n* item 2\n1. item 3");
assert(withList.includes('\x1b[38;2;45;212;191m'), "List markers should have teal color");
assert(withList.includes('\x1b[38;2;163;230;53m'), "List markers should have lime color for -");

const withoutList = colorReasoning("no marker here");
assert(withoutList.includes('\x1b[3;38;2;125;211;252m'), "No list should have base SGR");

// Test 4: Bold emphasis
const withBold = colorReasoning("Hello **bold** world");
assert(withBold.includes('\x1b[1m'), "Bold should have BOLD SGR");
assert(withBold.includes('\x1b[3;38;2;125;211;252m'), "After bold should restore base SGR");

// Test 5: Numbers (amber)
const withNumbers = colorReasoning("The value is 42 and 3.14");
assert(withNumbers.includes('\x1b[38;2;251;191;36m'), "Numbers should have amber color");

// Test 6: Each line ends with RESET
const multiLine = colorReasoning("line1\nline2\nline3");
const lines = multiLine.split('\n');
lines.forEach((line, i) => {
  assert(line.endsWith('\x1b[0m'), `Line ${i} should end with RESET`);
});

// Test 7: stripAnsi invariant - only ANSI added, chars intact
const testStr = "Hello \`test\` 42 world";
const colored = colorReasoning(testStr);
const stripped = colored.replace(/\x1b\[[0-9;]*m/g, '');
assert(stripped === testStr, `stripAnsi invariant failed: "${stripped}" !== "${testStr}"`);

// Test 8: Heading markers
const withHeading = colorReasoning("# Title\n## Subtitle");
assert(withHeading.includes('\x1b[38;2;45;212;191m'), "Headings should have teal color");

// Test 9: Quoted strings (lime placeholder)
const withQuotes = colorReasoning('He said "hello"');
assert(withQuotes.includes('\x1b[38;2;163;230;53m'), "Quoted strings should have lime color");

print("All colorReasoning tests passed!");