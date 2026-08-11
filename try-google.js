#!/usr/bin/env qjsm
/**
 * PoC: try to execute Google's out.html JS against a minimal DOM + window shim
 * to discover what browser APIs are needed to render search results.
 *
 * Usage: qjsm try-google.js
 *
 * Strategy:
 * 1. Parse out.html into a DOM tree via the 'dom' module
 * 2. Set up globalThis with shims for window, navigator, location, etc.
 * 3. Attach a real MutationObserver (from 'dom') to document.documentElement
 * 4. Extract <script> elements and eval them one by one
 * 5. After each script / event phase, drain observer records to see what
 *    the script changed in the DOM
 * 6. Log every error/missing API to discover what's needed
 * 7. After execution, dump document.body.outerHTML to see what got rendered
 */
import { Parser, Factory, Node, Element, MutationObserver } from 'dom';
import { err as stderr, out as stdout } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { setInterval, clearInterval } from 'timers';
import { atob, btoa } from 'util';

const TRACE_MISSING = true; // log every missing API access
const TRACE_ERRORS = true; // log every thrown error
const DUMP_DOM = true; // dump body HTML after execution
const MAX_SCRIPT_CHARS = 500000; // skip scripts larger than this
const MAX_RECORDS_LOGGED = 50; // cap per-phase record spam

// ─── Proxy trap that logs missing property access ───
function trapMissing(obj, label) {
  if(!TRACE_MISSING) return obj;

  const accessed = new Set();

  return new Proxy(obj, {
    get(target, prop, receiver) {
      if(prop in target || typeof prop === 'symbol') {
        const val = Reflect.get(target, prop, receiver);
        // Recursively trap nested objects
        if(val && typeof val === 'object' && typeof prop === 'string' && !accessed.has(prop)) {
          accessed.add(prop);
          return trapMissing(val, `${label}.${prop}`);
        }
        return val;
      }
      console.log(`[MISSING] ${label}.${String(prop)} accessed (returned undefined)`);
      return undefined;
    },
    has(target, prop) {
      if(!(prop in target)) {
        console.log(`[MISSING] '${String(prop)}' in ${label} (returned false)`);
      }
      return prop in target;
    },
  });
}

// ─── Summarise a batch of MutationRecords into readable lines ───
function summariseRecords(records, phaseLabel) {
  if(!records.length) {
    console.log(`    [MO] ${phaseLabel}: (no DOM mutations)`);
    return;
  }

  console.log(`    [MO] ${phaseLabel}: ${records.length} record(s)`);

  // Bucket by type for compact output
  const buckets = { childList: [], attributes: [], characterData: [] };
  for(const r of records) {
    const b = buckets[r.type];
    if(b) b.push(r);
    else console.log(`      ? unknown record type: ${r.type}`);
  }

  const tagOf = n => {
    if(!n) return '?';
    if(n.nodeType === 1) return `<${n.tagName ?? n.nodeName ?? '?'}>`;
    if(n.nodeType === 3) return `#text(${(n.data ?? '').length})`;
    if(n.nodeType === 8) return `#comment`;
    return `node(${n.nodeType})`;
  };

  const show = (prefix, line) => {
    if(prefix < MAX_RECORDS_LOGGED) console.log(`      ${line}`);
    else if(prefix === MAX_RECORDS_LOGGED) console.log(`      ... (${records.length - MAX_RECORDS_LOGGED} more records suppressed)`);
  };

  let shown = 0;
  for(const r of buckets.childList) {
    const added = [...(r.addedNodes ?? [])].map(tagOf).join(',') || '-';
    const removed = [...(r.removedNodes ?? [])].map(tagOf).join(',') || '-';
    show(shown++, `childList ${tagOf(r.target)} +[${added}] -[${removed}]`);
  }
  for(const r of buckets.attributes) {
    show(shown++, `attributes ${tagOf(r.target)}.${r.attributeName} = ${JSON.stringify(r.target.getAttribute?.(r.attributeName) ?? '?')}`);
  }
  for(const r of buckets.characterData) {
    const data = (r.target.data ?? '').slice(0, 60);
    show(shown++, `characterData ${tagOf(r.target)} "${data}"`);
  }
}

// Flush microtask queue so MutationObserver callbacks fire before we
// call takeRecords(). One zero-delay setTimeout round-trip is enough
// for the 'dom' module's internal queue.
function flushMicrotasks() {
  return new Promise(r => setTimeout(r, 0));
}

// ─── Build the window/document/navigator shims ───
function buildShims(doc) {
  // Performance API
  const perfStart = Date.now();
  const performance = {
    now: () => Date.now() - perfStart,
    timing: { navigationStart: perfStart, responseStart: perfStart },
    navigation: { type: 0 },
    mark: (...args) => {},
    getEntriesByType: () => [],
    getEntriesByName: () => [],
  };

  // Navigator
  const navigator = trapMissing(
    {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      language: 'de-CH',
      languages: ['de-CH', 'en-US', 'en'],
      platform: 'Linux x86_64',
      cookieEnabled: true,
      onLine: true,
      vendor: 'Google Inc.',
      appName: 'Netscape',
      appVersion: '5.0 (X11; Linux x86_64)',
      sendBeacon: () => true,
      userAgentData: {
        getHighEntropyValues: () =>
          Promise.resolve({
            platform: 'Linux',
            platformVersion: '6.1.0',
            uaFullVersion: '120.0.6099.71',
            architecture: 'x86',
            model: '',
            bitness: '64',
            fullVersionList: [{ brand: 'Chromium', version: '120.0.6099.71' }],
            wow64: false,
          }),
        brands: [{ brand: 'Chromium', version: '120' }],
        mobile: false,
      },
      connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
      mediaDevices: undefined,
      serviceWorker: undefined,
    },
    'navigator',
  );

  // Location
  const location = trapMissing(
    {
      href: 'https://www.google.com/search?q=browser+console.log+css&hl=de',
      protocol: 'https:',
      host: 'www.google.com',
      hostname: 'www.google.com',
      port: '',
      pathname: '/search',
      search: '?q=browser+console.log+css&hl=de',
      hash: '',
      origin: 'https://www.google.com',
      ancestorOrigins: [],
      assign: () => {},
      replace: () => {},
      reload: () => {},
      toString: () => 'https://www.google.com/search?q=browser+console.log+css&hl=de',
    },
    'location',
  );

  // History
  const history = {
    replaceState: () => {},
    pushState: () => {},
    state: null,
    length: 1,
  };

  // Screen
  const screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1050,
    colorDepth: 24,
    pixelDepth: 24,
  };

  // Storage stubs
  function makeStorage() {
    const store = new Map();
    return {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: i => [...store.keys()][i] ?? null,
    };
  }

  // TrustedTypes shim (Google's code checks for this)
  const trustedTypes = {
    createPolicy: (name, rules) => ({
      name,
      createHTML: s => s,
      createScript: s => s,
      createScriptURL: s => s,
    }),
  };

  // Event stubs
  class EventStub {
    constructor(type, opts = {}) {
      this.type = type;
      this.target = opts.target ?? null;
      this.currentTarget = opts.currentTarget ?? null;
      this.bubbles = opts.bubbles ?? false;
      this.cancelable = opts.cancelable ?? false;
      this.defaultPrevented = false;
      this.timeStamp = Date.now();
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {}
    initCustomEvent() {}
  }

  // Minimal addEventListener/removeEventListener on document/documentElement
  const eventListeners = new Map();

  function addEventListener(type, handler, opts) {
    const key = `${type}:${typeof opts === 'boolean' ? opts : (opts?.capture ?? false)}`;
    if(!eventListeners.has(key)) eventListeners.set(key, []);
    eventListeners.get(key).push({ handler, opts });
  }

  function removeEventListener(type, handler, opts) {
    const key = `${type}:${typeof opts === 'boolean' ? opts : (opts?.capture ?? false)}`;
    const list = eventListeners.get(key);
    if(list) {
      const idx = list.findIndex(e => e.handler === handler);
      if(idx !== -1) list.splice(idx, 1);
    }
  }

  function dispatchEvent(event) {
    const key = `${event.type}:false`;
    const list = eventListeners.get(key) ?? [];
    for(const { handler } of list) {
      try {
        handler.call(doc.documentElement ?? doc, event);
      } catch(e) {
        if(TRACE_ERRORS) console.log(`[EVENT ERROR] ${event.type}:`, e.message);
      }
    }
    return !event.defaultPrevented;
  }

  // XMLHttpRequest stub
  class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.responseType = '';
    }
    open(method, url) {
      this.readyState = 1;
      this._url = url;
    }
    setRequestHeader() {}
    send(body) {
      // Simulate immediate completion
      this.readyState = 4;
      this.status = 200;
      this.responseText = '{}';
      this.response = '{}';
      this.onreadystatechange?.();
      this.onload?.();
    }
    abort() {}
    getAllResponseHeaders() {
      return '';
    }
    getResponseHeader() {
      return null;
    }
    addEventListener() {}
    removeEventListener() {}
  }

  // fetch() stub
  function fetchStub(url, opts) {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
      blob: () => Promise.resolve(new Blob()),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }

  // ─── Intercepted Timers ───
  const interceptedSetTimeout = (callback, delay, ...args) => {
    console.log(`[TIMER] setTimeout set with delay ${delay}ms`);
    const wrappedCallback = (...cbArgs) => {
      console.log(`[TIMER] setTimeout handler fired (delay was ${delay}ms)`);
      if (typeof callback === 'function') {
        return callback(...cbArgs);
      } else {
        return (0, eval)(callback);
      }
    };
    return setTimeout(wrappedCallback, delay, ...args);
  };

  const interceptedSetInterval = (callback, delay, ...args) => {
    console.log(`[TIMER] setInterval set with delay ${delay}ms`);
    const wrappedCallback = (...cbArgs) => {
      console.log(`[TIMER] setInterval handler fired (interval ${delay}ms)`);
      if (typeof callback === 'function') {
        return callback(...cbArgs);
      } else {
        return (0, eval)(callback);
      }
    };
    return setInterval(wrappedCallback, delay, ...args);
  };

  // Build the window object
  const win = {
    document: doc,
    location,
    navigator,
    history,
    screen,
    performance,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    trustedTypes,

    // Timers (intercepted)
    setTimeout: interceptedSetTimeout,
    clearTimeout,
    setInterval: interceptedSetInterval,
    clearInterval,

    // Encoding
    btoa,
    atob,

    // Console
    console: trapMissing(
      {
        log: (...args) => console.log('[PAGE]', ...args),
        warn: (...args) => console.log('[PAGE WARN]', ...args),
        error: (...args) => console.log('[PAGE ERROR]', ...args),
        info: (...args) => console.log('[PAGE INFO]', ...args),
        debug: (...args) => {},
        trace: (...args) => {},
        dir: (...args) => {},
        table: (...args) => {},
        time: () => {},
        timeEnd: () => {},
        count: () => {},
        group: () => {},
        groupEnd: () => {},
        assert: () => {},
        clear: () => {},
      },
      'console',
    ),

    // DOM events on window
    addEventListener,
    removeEventListener,
    dispatchEvent,

    // XMLHttpRequest
    XMLHttpRequest,
    fetch: fetchStub,

    // Common globals
    self: undefined, // will be set below
    window: undefined, // will be set below
    globalThis: undefined,
    parent: undefined,
    top: undefined,
    frames: undefined,
    opener: null,

    // Misc
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    pageXOffset: 0,
    pageYOffset: 0,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    name: '',
    closed: false,
    length: 0,
    status: '',

    // Promise
    Promise,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Array,
    Object,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    NaN,
    Infinity,
    undefined,

    // Encoding
    TextEncoder: class {
      encode(s) {
        return new Uint8Array([...s].map(c => c.charCodeAt(0)));
      }
    },
    TextDecoder: class {
      decode(a) {
        return String.fromCharCode(...a);
      }
    },
    URL:
      typeof URL !== 'undefined'
        ? URL
        : class {
            constructor(u) {
              this.href = u;
            }
          },

    // Blob/File
    Blob: class {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts?.type ?? '';
        this.size = 0;
      }
    },
    File: class {
      constructor(parts, name, opts) {
        this.name = name;
        this.parts = parts;
      }
    },
    FormData: class {
      append() {}
      get() {
        return null;
      }
    },

    // Crypto
    crypto: {
      getRandomValues: arr => {
        for(let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
      subtle: undefined,
    },

    // Image constructor (Google creates img elements)
    Image: function(width, height) {
      return doc.createElement('img');
    },

    // Real MutationObserver from 'dom' — NOT the shim.
    MutationObserver,

    // CustomEvent
    CustomEvent: EventStub,
    Event: EventStub,
    UIEvent: EventStub,
    MouseEvent: EventStub,
    KeyboardEvent: EventStub,

    // requestAnimationFrame
    requestAnimationFrame: cb => win.setTimeout(cb, 16),
    cancelAnimationFrame: id => clearTimeout(id),

    // queueMicrotask
    queueMicrotask: typeof queueMicrotask !== 'undefined' ? queueMicrotask : fn => Promise.resolve().then(fn),

    // getComputedStyle stub
    getComputedStyle: () =>
      new Proxy(
        {},
        {
          get: (t, p) => {
            if(p === 'visibility') return 'visible';
            if(p === 'display') return 'block';
            if(p === 'height') return 'auto';
            if(p === 'width') return 'auto';
            return '';
          },
        },
      ),

    // matchMedia
    matchMedia: query => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),

    // getSelection
    getSelection: () => ({ rangeCount: 0, toString: () => '' }),

    // open/close/print
    open: () => null,
    close: () => {},
    print: () => {},
    focus: () => {},
    blur: () => {},
    scroll: () => {},
    scrollTo: () => {},
    scrollBy: () => {},

    // eval
    eval,
  };

  // Self-references
  win.self = win;
  win.window = win;
  win.globalThis = win;
  win.parent = win;
  win.top = win;
  win.frames = win;

  return win;
}

// ─── Main ───
async function main() {
  console.log('=== Google JS Execution PoC ===\n');

  // 1. Parse out.html
  console.log('[1] Parsing out.html...');
  const parser = new Parser();

  let doc;
  try {
    doc = parser.parseFromFile('out.html');
    console.log(`    Parsed: documentElement = <${doc.documentElement?.tagName ?? '??'}>`);
    console.log(`    Body: ${doc.body ? `<${doc.body.tagName}>` : 'null'}`);
    console.log(`    Scripts found: ${[...doc.querySelectorAll('script')].length}`);
  } catch(e) {
    console.log(`    PARSE ERROR: ${e.message}`);
    console.log(e.stack);
    return;
  }

  // 2. Build shims
  console.log('\n[2] Building window/navigator shims...');
  const win = buildShims(doc);

  // 3. Install globals
  console.log('\n[3] Installing globals...');
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.self = win;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.screen = win.screen;
  globalThis.performance = win.performance;
  globalThis.localStorage = win.localStorage;
  globalThis.sessionStorage = win.sessionStorage;
  globalThis.trustedTypes = win.trustedTypes;
  globalThis.XMLHttpRequest = win.XMLHttpRequest;
  globalThis.fetch = win.fetch;
  globalThis.btoa = win.btoa;
  globalThis.atob = win.atob;
  globalThis.addEventListener = win.addEventListener;
  globalThis.removeEventListener = win.removeEventListener;
  globalThis.dispatchEvent = win.dispatchEvent;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.matchMedia = win.matchMedia;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.Image = win.Image;
  globalThis.Event = win.Event;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.crypto = win.crypto;
  globalThis.MutationObserver = MutationObserver;
  globalThis.setTimeout = win.setTimeout;
  globalThis.clearTimeout = win.clearTimeout;
  globalThis.setInterval = win.setInterval;
  globalThis.clearInterval = win.clearInterval;

  // 3b. Attach a real MutationObserver to document.documentElement (with subtree).
  //     We collect every record into `mutationLog` tagged with the phase that
  //     was running when it fired, so we can drain + summarise per phase below.
  let currentPhase = 'init';
  const mutationLog = []; // array of { phase, records[] }
  const observer = new MutationObserver(records => {
    // Batch records for the current phase. If we're already accumulating for
    // this phase, extend the existing bucket; otherwise start a new one.
    const last = mutationLog[mutationLog.length - 1];
    if(last && last.phase === currentPhase) {
      last.records.push(...records);
    } else {
      mutationLog.push({ phase: currentPhase, records: [...records] });
    }
  });

  observer.observe(doc.documentElement, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
    attributeOldValue: true,
    characterDataOldValue: true,
  });
  console.log('    MutationObserver attached to <' + doc.documentElement.tagName + '> (subtree)');

  os.kill(os.getpid(), os.SIGUSR1);


  // Helper: flush microtasks + drain any pending records, then summarise.
  async function reportMutations(label) {
    await flushMicrotasks();
    const extra = observer.takeRecords();
    if(extra.length) {
      const last = mutationLog[mutationLog.length - 1];
      if(last && last.phase === currentPhase) last.records.push(...extra);
      else mutationLog.push({ phase: currentPhase, records: [...extra] });
    }
    // Print only the buckets tagged with this phase.
    const phaseBuckets = mutationLog.filter(b => b.phase === currentPhase);
    const all = phaseBuckets.flatMap(b => b.records);
    summariseRecords(all, label);
  }

  // 4. Extract and execute scripts
  console.log('\n[4] Executing <script> elements...\n');
  const scripts = [...doc.querySelectorAll('script')];
  let executed = 0,
    errors = 0;

  for(let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    const src = script.getAttribute('src');
    let code = script.textContent ?? '';

    if(src) {
      console.log(`  Script[${i}]: src="${src}" (external - skipping)`);
      continue;
    }

    if(!code.trim()) continue;

    if(code.length > MAX_SCRIPT_CHARS) {
      console.log(`  Script[${i}]: ${code.length} chars (skipping - too large)`);
      continue;
    }

    console.log(`  Script[${i}]: ${code.length} chars, first 80: ${code.slice(0, 80).replace(/\n/g, '\\n')}...`);

    currentPhase = `script[${i}]`;

    try {
      // Use indirect eval to run in global scope
      (0, eval)(code);
      executed++;
      console.log(`    ✓ executed successfully`);
    } catch(e) {
      errors++;
      console.log(`    ✗ ERROR: ${e.message}`);
      if(e.stack) {
        const lines = e.stack.split('\n').slice(0, 5);
        for(const line of lines) console.log(`      ${line}`);
      }
    }

    await reportMutations(`after script[${i}]`);
  }

  console.log(`\n  Executed: ${executed}, Errors: ${errors}, Skipped: ${scripts.length - executed - errors}`);

  // 5. Fire DOMContentLoaded and load events
  console.log('\n[5] Firing DOMContentLoaded and load events...');

  currentPhase = 'DOMContentLoaded';
  try {
    const dcl = new win.Event('DOMContentLoaded', { bubbles: true });
    doc.dispatchEvent?.(dcl) ?? win.dispatchEvent(dcl);
    console.log('    DOMContentLoaded dispatched');
  } catch(e) {
    console.log(`    DOMContentLoaded error: ${e.message}`);
  }
  await reportMutations('after DOMContentLoaded');

  currentPhase = 'load';
  try {
    const load = new win.Event('load');
    win.dispatchEvent(load);
    console.log('    load dispatched');
  } catch(e) {
    console.log(`    load error: ${e.message}`);
  }
  await reportMutations('after load');

  // Wait a bit for async operations
  currentPhase = 'async-settle';
  await new Promise(r => setTimeout(r, 200));
  await reportMutations('after 200ms settle');

  // 6. Dump the resulting DOM
  if(DUMP_DOM) {
    console.log('\n[6] Resulting DOM state:');
    console.log(`    <${doc.documentElement?.tagName}>`);

    const body = doc.body;
    if(body) {
      const html = body.outerHTML ?? body.innerHTML ?? '(no HTML)';
      console.log(`    <body> length: ${html.length} chars`);
      console.log(`    <body> children: ${body.children?.length ?? 0}`);
      console.log(`    <body> first 500 chars:`);
      console.log(`    ${html.slice(0, 500)}`);

      // Count elements by tag
      const tags = {};
      try {
        for(const el of doc.querySelectorAll('*')) {
          const tag = el.tagName ?? '?';
          tags[tag] = (tags[tag] ?? 0) + 1;
        }
        console.log(`\n    Element counts:`);
        for(const [tag, count] of Object.entries(tags)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)) {
          console.log(`      <${tag}>: ${count}`);
        }
      } catch(e) {
        console.log(`    (querySelectorAll failed: ${e.message})`);
      }

      // Look for search result links
      console.log(`\n    Looking for search results (a[href] with /url?...):`);
      let found = 0;
      try {
        for(const a of doc.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') ?? '';
          if(href.includes('/url?') || (!href.startsWith('/') && href.startsWith('http'))) {
            const text = (a.textContent ?? '').slice(0, 80);
            console.log(`      ${href.slice(0, 80)} - ${text}`);
            if(++found >= 10) break;
          }
        }
        if(found === 0) console.log('      (none found)');
      } catch(e) {
        console.log(`    (search failed: ${e.message})`);
      }
    } else {
      console.log('    No <body> element found');
    }
  }

  // 7. Mutation summary across the whole run
  console.log('\n=== Mutation summary ===');
  const totals = { childList: 0, attributes: 0, characterData: 0, other: 0 };
  let totalRecords = 0;
  for(const bucket of mutationLog) {
    for(const r of bucket.records) {
      totalRecords++;
      if(r.type in totals) totals[r.type]++;
      else totals.other++;
    }
  }
  console.log(`Total MutationRecords captured: ${totalRecords}`);
  console.log(`  childList:    ${totals.childList}`);
  console.log(`  attributes:   ${totals.attributes}`);
  console.log(`  characterData:${totals.characterData}`);
  console.log(`  other:        ${totals.other}`);

  // Per-phase totals
  const phaseTotals = {};
  for(const bucket of mutationLog) {
    phaseTotals[bucket.phase] = (phaseTotals[bucket.phase] ?? 0) + bucket.records.length;
  }
  if(Object.keys(phaseTotals).length) {
    console.log(`Per-phase totals:`);
    for(const [phase, n] of Object.entries(phaseTotals)) {
      console.log(`  ${phase}: ${n}`);
    }
  }

  observer.disconnect();

  // 8. Final summary
  console.log('\n=== Summary ===');
  console.log(`Scripts executed: ${executed}/${scripts.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Body child count: ${doc.body?.children?.length ?? 0}`);

  // Check if google object was populated
  if(typeof google !== 'undefined') {
    console.log(`window.google keys: ${Object.keys(google).join(', ')}`);
  }
}

try {
  await main();
} catch(e) {
  console.log('FATAL:', e.message);
  console.log(e.stack);
}
