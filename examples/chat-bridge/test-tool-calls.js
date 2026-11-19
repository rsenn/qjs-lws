import { extractCalls } from './tool-calls.js';

const tools = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: {}, offset: {} }, required: ['path'] } } },
  { type: 'function', function: { name: 'add', parameters: { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] } } },
  { type: 'function', function: { name: 'now', parameters: { type: 'object', properties: {} } } }
];
let fail = 0;
const t = (label, text, want) => {
  const got = JSON.stringify(extractCalls(text, tools));
  if(got != JSON.stringify(want)) { fail++; console.log('FAIL', label, got); } else console.log('ok  ', label);
};
const rf = { name: 'read_file', arguments: { path: 'slug.js' } };

t('standard', '```tool_call\n{"name":"read_file","arguments":{"path":"slug.js"}}\n```', [rf]);
t('flat + ui text', 'tool_call\nKopieren\nHerunterladen\n{"name": "read_file", "path": "slug.js"}', [rf]);
t('parameters', '{"name":"read_file","parameters":{"path":"slug.js"}}', [rf]);
t('args', '{"name":"read_file","args":{"path":"slug.js"}}', [rf]);
t('string arguments', '{"name":"read_file","arguments":"{\\"path\\":\\"slug.js\\"}"}', [rf]);
t('openai shape', '{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"slug.js\\"}"}}', [rf]);
t('tool key', '{"tool":"read_file","arguments":{"path":"slug.js"}}', [rf]);
t('empty args, required', '{"name":"read_file","arguments":{}}', []);
t('empty args, none required', '{"name":"now","arguments":{}}', [{ name: 'now', arguments: {} }]);
t('flat, none required', '{"name":"now"}', [{ name: 'now', arguments: {} }]);
t('unknown tool', '{"name":"rm","arguments":{"path":"/"}}', []);
t('two calls', '{"name":"add","a":1,"b":2}\n```\n{"name":"read_file","path":"x"}', [{ name: 'add', arguments: { a: 1, b: 2 } }, { name: 'read_file', arguments: { path: 'x' } }]);
t('flat ignores foreign keys', '{"name":"read_file","path":"x","bogus":1}', [{ name: 'read_file', arguments: { path: 'x' } }]);
t('prose with braces', 'use {curly} braces', []);
console.log(fail ? `${fail} failed` : 'all passed');
