import { tests, eq, assert } from './tinytest.js';
import { createLogger, parseEntry, parseNDJSON, unescapeData } from '../../lib/lws/log.js';

const USER = 10; // index into lws.so's log level tables
const TAG = '[wsisrv|1|localhost|adopted|127.0.0.1]';
const RX = `${TAG}: RAW_RX: RX 99 bytes: 0000005a\\n{"type":"event","n":1}`;
const TX = `${TAG}: TX 40 bytes (proto=HTTP): HTTP/1.1 200 OK\\r\\nA: b\\r\\n\\r\\nhello`;
const REQ = `${TAG}: RX 30 bytes: GET /x HTTP/1.1\\r\\nHost: a\\r\\n\\r\\n`;

function run(format, msgs) {
  let text = '';
  const log = createLogger({ format, out: s => (text += s), color: false });

  for(const m of msgs) log(USER, m);
  return text;
}

await tests({
  'unescapeData reverses the C-side escaping'() {
    eq('a\nb\r\t\\ \x01\xff', unescapeData('a\\nb\\r\\t\\\\ \\x01\\xff'));
  },

  'parseEntry splits tag, event and traffic fields'() {
    const e = parseEntry(USER, RX);

    eq('wsisrv', e.wsi.kind);
    eq(1, e.wsi.id);
    eq('127.0.0.1', e.wsi.peer);
    eq('RAW_RX', e.event);
    eq('rx', e.dir);
    eq(99, e.bytes);
    eq('0000005a\n{"type":"event","n":1}', e.data);
    eq('HTTP', parseEntry(USER, TX).proto);
  },

  'parseEntry handles untagged and listen-socket messages'() {
    eq('PROTOCOL_INIT', parseEntry(USER, 'PROTOCOL_INIT').event);

    const e = parseEntry(USER, '[wsi|1|listen|localhost||8998]: FILTER_NETWORK_CONNECTION');
    eq(8998, e.wsi.port);
    eq('FILTER_NETWORK_CONNECTION', e.event);
  },

  'ndjson output is reparseable'() {
    const out = run('ndjson', ['PROTOCOL_INIT', RX, TX]);
    const entries = parseNDJSON(out);

    eq(3, entries.length);
    eq('PROTOCOL_INIT', entries[0].event);
    eq('0000005a\n{"type":"event","n":1}', entries[1].data);
    eq('HTTP/1.1 200 OK\r\nA: b\r\n\r\nhello', entries[2].data);
    eq(out.split('\n').length - 1, 3, 'one line per entry');
  },

  'human output pretty-prints JSON payloads over several lines'() {
    const out = run('human', [RX]);
    const lines = out.trimEnd().split('\n');

    assert(/wsisrv#1 127\.0\.0\.1 RX 99 bytes RAW_RX$/.test(lines[0]), lines[0]);
    assert(lines.length > 2, 'payload on following lines');
    assert(lines.slice(1).every(l => l.startsWith('    ')), 'payload indented');
    assert(out.includes('"type": "event"'));
    assert(!out.includes('\x1b'), 'no colour when disabled');
  },

  'human output colours only when asked'() {
    let text = '';
    createLogger({ format: 'human', out: s => (text += s), color: true })(USER, RX);
    assert(text.includes('\x1b['));
  },

  'curl output imitates curl --verbose'() {
    const out = run('curl', [`${TAG}: SERVER_NEW_CLIENT_INSTANTIATED`, REQ, TX]);
    const lines = out.split('\n');

    assert(lines.includes('* Connection #1 from 127.0.0.1'), out);
    assert(lines.includes('> GET /x HTTP/1.1'));
    assert(lines.includes('> Host: a'));
    assert(lines.includes('< HTTP/1.1 200 OK'));
    assert(lines.includes('< A: b'));
    assert(lines.includes('} [HTTP 40 bytes data]'));
    assert(lines.includes('hello'));
  },

  'filter drops entries'() {
    let text = '';
    createLogger({ format: 'ndjson', out: s => (text += s), filter: e => e.dir == 'tx' })(USER, RX);
    eq('', text);
  },

  'unknown format throws'() {
    let err;
    try {
      createLogger({ format: 'xml' });
    } catch(e) {
      err = e;
    }
    assert(err instanceof TypeError);
  },
});
