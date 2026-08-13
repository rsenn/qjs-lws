# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## BUGS file format

Newly discovered bugs (see root `CLAUDE.md`, "Track Newly Discovered Bugs")
are appended to `BUGS` in this directory, one entry per bug, in the order
found, shaped like:

    - <canonical-name> (<file>:<line>): <short plain-text description
      of what's broken and how it was confirmed>

        <JS code that triggers it, or a one-line note if not
        practically reproducible in plain JS>

`canonical-name` is a short kebab-case handle for referring back to the
bug elsewhere (commit messages, other BUGS entries). The source location
is the primary place the bug lives, not every place it's felt.

`BUGS` itself is plain lowercase text: no back-quotes in descriptions,
keep descriptions to a sentence or two, and always include the source
location of the bug.

Always append newly discovered bugs to `BUGS` as soon as you find them,
without asking first or waiting to be told - this applies any time you're
working in this directory, not just when explicitly hunting for bugs.
Check at the end of a task whether anything surfaced during the work
(errors seen while testing, oddities noticed while reading code, things
that "shouldn't happen" but did) got logged; if not, log it before
finishing.

Once a bug is actually fixed, remove its entry from `BUGS` entirely -
don't leave it in tagged `[FIXED]`. `BUGS` tracks what's still open, not a
changelog of past fixes; a fix's own commit message (or, if the fix
uncovered something worth remembering during the chase - a wrong
assumption, a second bug found along the way, an install/build gotcha -
a note in the relevant source comment) is where that history belongs
instead.

## Running scripts with qjsm

To run a script (e.g. a throwaway test file while debugging), invoke it
as the plain positional argument: `qjsm script.js [args]` - same as
`repl.js`'s own header comment documents running itself
(`qjsm repl.js [--model ...]`).

Never use `qjsm -m script.js` (or `--module`) for this - `-m`/`--module`
is qjsm's special module loader (package.json/.ts-aware resolution,
per `qjsm --help`: "load an ES6 module"), unrelated to running a script
as the main program. A plain script run without `-m` already supports
`import`/`export` (it's ES module syntax either way) - `-m` is not
"the way to get module support", it's a different, unrelated loading
path, and using it to run a script is a category error, not just a
stylistic difference.

## Option-object property casing

`js_get_property()` (`js-utils.c`) is the canonical way to read a named
property off a JS option object anywhere in this project's native code.
It checks the name as given first, then falls back to that name's
camelCase spelling before giving up - so a snake_case-canonical option
name (matching the underlying lws struct field) is also readable as
camelCase without extra per-call handling. Use `js_get_property()` (not
a raw `JS_GetPropertyStr()`) for any new option-object field so this
fallback keeps applying uniformly; see the function's own doc comment
in `js-utils.c` for the exact precedence and the reasoning about
`js_is_prop_undefined()`'s intentionally narrower check.

## Subproject TODO.md files

Several subdirectories (e.g. `examples/ollama-repl/`) keep their own
`TODO.md` tracking that subproject's known gaps and planned work. Any
time work in this directory changes the state of something a `TODO.md`
describes - an item gets implemented, partially implemented, discovered
to be harder/easier than described, or a change exposes a new gap - update
that subproject's `TODO.md` to match before finishing, without waiting to
be asked. Move finished items into a "Done" section (or delete them if
they're not worth keeping as a record) rather than leaving them listed as
still-open; note new gaps discovered along the way the same way `BUGS`
entries are noted. This applies to every `TODO.md` under this directory,
not just the one being actively discussed.

## Recent Work Summary (August 2026)

### Documentation Reorganization

**Completed**: Reorganized all documentation into clear structure:
- `doc/native/` - C API documentation (LWSContext, protocols, callbacks, etc.)
- `doc/js/` - JavaScript API documentation (fetch, serve, WebSocket wrappers)
- `doc/building.md` - Build instructions (moved from `doc/native/`)

All cross-references updated in `README.md`, `doc/README.md`, and throughout docs.

### Critical Bug Fix: listenAcceptProtocol

**Problem**: `listenAcceptProtocol` option only worked when the named protocol was at `protocols[0]`. Any other position caused connections to silently drop.

**Root Cause**: In libwebsockets' `ops-raw-skt.c:325`, the raw-skt adoption code doesn't call `lws_vhost_name_to_protocol()` to look up the protocol by name. Instead, it uses `wsi->a.protocol` which defaults to `protocols[0]` when a new socket is accepted.

**Fix**: Modified `lib/serve.js` to pass a `protocolName` parameter to `lws_create_vhost()`, which libwebsockets uses to properly look up and bind to the correct protocol regardless of array position.

**Impact**: This is now fixed and working. The protocol ordering limitation no longer exists.

### Documentation Cleanup

**Completed**: Removed all JS wrapper references from native C API docs:
- Removed mentions of `lib/fetch.js`, `lib/serve.js`, `lib/websocket.js`, `lib/tcpsocket.js`, `lib/udpsocket.js`
- Removed references to `lib/lws/multipart.js`, `lib/lws/mimetypes.js`, `lib/lws/streams.js`
- Rewrote `doc/native/raw-tcp.md` to remove the protocol ordering workaround section
- Removed cautionary notes from `doc/native/LWSContext.md` and `doc/native/examples.md`
- Native docs now focus purely on the lws.so C API

### API Compatibility Assessment

**Completed**: Created comprehensive assessment in `doc/api-compatibility.md`:

**High Compatibility (≥90%)**:
- ✅ Streams API: 100% (ported from web-streams-polyfill)
- ✅ URL/URLSearchParams: 100%
- ✅ WebSocket API: 85%
- ✅ AbortController/AbortSignal: 90%
- ✅ Express Router: 100%

**Critical Spec Violations Found**:
- ❌ `Response.status`: Implemented as method `status(code)` instead of readonly property
- ❌ `Body.formData()`: Returns plain object instead of FormData instance (no FormData class exists)
- ❌ `Headers` iteration: Uses insertion order instead of sorted order
- ❌ `fetch()`: Doesn't accept Request objects as input
- ❌ `fetch()`: Throws ConnectionError instead of TypeError for network errors

**Bun.js API Gaps**:
- Server object: 35% conformance (missing 11 of 15 methods)
- WebSocketHandler options: 25% conformance (missing 10 of 13 options)
- UDPSocket: 20% conformance (missing 10 of 12 methods)

**"Reinventing the Wheel" Patterns Identified**:
- Custom ConnectionError instead of standard TypeError
- Headers insertion order instead of sorted order
- Minimal EventTarget (missing once/signal options)
- Response.status as method (architectural mistake)

### BUGS File Updates

**Completed**: Filed 16 specific incompatibilities as bugs with reproduction cases:
1. `response-status-is-method-not-property` (CRITICAL)
2. `body-formData-returns-wrong-type`
3. `headers-iteration-order-wrong`
4. `fetch-no-request-input`
5. `fetch-wrong-error-type`
6. `fetch-abortsignal-incomplete`
7. `missing-bytes-method`
8. `clone-no-bodyused-check`
9. `websocket-missing-url-property`
10. `server-missing-url-property`
11. `eventtarget-missing-options`
12. `udpsocket-send-different-signature`
13. `server-missing-11-methods`
14. `websockethandler-missing-10-options`
15. `serverwebsocket-missing-3-members`
16. `udpsocket-missing-10-methods`

## Current Work In Progress

### Response.status Spec Violation Fix (CRITICAL PRIORITY)

**Status**: Agent launched to map all Response.status usages across codebase

**The Problem**:
```javascript
// Current implementation (WRONG):
const res = new Response('body', { status: 200 });
res.status === 200  // false - status is a function, not a number
res.statusCode === 200  // true - but this is non-standard

// WHATWG spec requires:
res.status === 200  // true - status must be a readonly property
```

**Why This Is Critical**:
This is the single most serious spec violation in the Fetch implementation. Every piece of code that checks `response.status` will fail because it's comparing a function to a number.

**Current Implementation** (in `lib/lws/response.js`):
- `status(code)` is a chainable setter method
- `statusCode` is a getter that returns the numeric value
- This design exists because the protocol layer patches status onto Response objects at runtime

**What Needs To Be Done**:
1. Convert `status` from method to readonly property
2. Keep `statusCode` as deprecated alias during transition
3. Update ALL code that sets status:
   - `lib/lws/response.js` - Response constructor
   - `lib/lws/protocols.js` - protocol layer status patching
   - `lib/serve.js` - server response handling
4. Update ALL code that reads status:
   - Tests in `tests/` directory
   - Examples in `examples/` directory
   - Documentation in `doc/`
5. Run full test suite to verify no regressions
6. Verify all examples still work

**Files To Check**:
- `lib/lws/response.js` - main implementation
- `lib/lws/protocols.js` - where status gets patched onto responses
- `lib/serve.js` - server-side usage
- `tests/*.js` - all test files
- `examples/**/*.js` - all example files
- `doc/**/*.md` - all documentation

**Testing Strategy**:
```javascript
// After fix, these should all work:
const res = new Response('body', { status: 200 });
assert(res.status === 200);  // readonly property
assert(typeof res.status === 'number');

// Setter should work in constructor only:
const res2 = new Response('body', { status: 404 });
assert(res2.status === 404);

// Direct assignment should fail (readonly):
try {
  res.status = 500;  // should throw or silently fail
} catch(e) {
  // expected
}
```

## Next Steps After Response.status Fix

### Priority 1: Remaining Critical Spec Violations
1. **Body.formData()** - Implement FormData class, fix return type
2. **Headers iteration order** - Sort headers lexicographically before iteration
3. **fetch() Request input** - Accept Request objects as first argument
4. **fetch() error types** - Use TypeError instead of ConnectionError

### Priority 2: High-Impact Missing Features
5. **AbortSignal handling** - Complete implementation in fetch()
6. **bytes() methods** - Add to Body and Response
7. **clone() bodyUsed checks** - Add TypeError when cloning consumed bodies
8. **WebSocket.url** - Store and expose URL property
9. **Server.url** - Add getter that constructs URL object

### Priority 3: Bun.js API Completion
10. **Server methods** - Implement subscriberCount, requestIP, timeout, etc.
11. **WebSocketHandler options** - Add drain, compression, timeouts
12. **ServerWebSocket properties** - Add remoteAddress, subscriptions
13. **UDP API** - Fix send() signature, add multicast methods

## Key Technical Patterns

### Response Status Flow
```
HTTP Response arrives
  ↓
libwebsockets parses status code
  ↓
lws-protocol.c callback fires (RECEIVE_CLIENT_HTTP)
  ↓
lib/lws/protocols.js receives callback
  ↓
Creates Response object with status
  ↓
[BUG HERE] Currently calls res.status(code) as method
  ↓
[SHOULD BE] Sets status property in constructor
  ↓
User code checks res.status === 200
```

### Where Status Gets Set
1. **Response constructor** (`lib/lws/response.js:15-25`):
   ```javascript
   constructor(body, init = {}) {
     // init.status should be stored as property, not method
   }
   ```

2. **Protocol layer patching** (`lib/lws/protocols.js`):
   - When HTTP response arrives, protocol callback creates Response
   - Currently calls `response.status(statusCode)` as method
   - Should pass status to constructor instead

3. **Server responses** (`lib/serve.js`):
   - When handler returns Response, status is read
   - Currently reads `response.statusCode` (non-standard getter)
   - Should read `response.status` (standard property)

### Testing Approach
1. **Unit tests**: Test Response class in isolation
2. **Integration tests**: Test full fetch() flow with real HTTP
3. **Example verification**: Run all examples to ensure they still work
4. **Spec compliance**: Test against WHATWG Fetch spec examples

## Important Files Reference

### Core Response Implementation
- `lib/lws/response.js` - Response class (MUST FIX)
- `lib/lws/request.js` - Request class (similar patterns)
- `lib/lws/body.js` - Body mixin (shared by Request/Response)
- `lib/lws/headers.js` - Headers class (iteration order bug)

### Protocol Layer
- `lib/lws/protocols.js` - Where Response objects get created from HTTP
- `lib/lws/protocol-helpers.js` - Helper functions for protocol handling

### Server Layer
- `lib/serve.js` - HTTP server implementation
- `lib/server.js` - Server class

### Tests
- `tests/test-fetch.js` - Fetch API tests
- `tests/test-response.js` - Response class tests
- `tests/test-request.js` - Request class tests
- `tests/test-headers.js` - Headers class tests

### Examples
- `examples/echo-server.js` - Simple HTTP server
- `examples/fetch-client.js` - Fetch API client
- `examples/websocket-server.js` - WebSocket server

## Commit History Context

Recent commits that provide context:
- `b9f2a2a` - Documentation reorganization and cleanup
- `a4702ce` - Fixed listenAcceptProtocol bug + cleaned native docs
- `673f733` - Moved building.md from doc/native/ to doc/
- `012f9f7` - Removed JS wrapper sections from native docs

## Agent Work Pattern

When working on this codebase:
1. **Always run tests before and after changes**: `npm test` or specific test files
2. **Check examples still work**: Run each example in `examples/` directory
3. **Update documentation**: If you change API, update docs in `doc/`
4. **File bugs immediately**: When you find spec violations, add to `BUGS` file
5. **Use surgical changes**: Only modify what's necessary for the fix
6. **Verify with reproduction cases**: Each bug in `BUGS` has code that triggers it

## Key Insights

### Why Response.status Became a Method
The protocol layer needs to patch status onto Response objects after construction because libwebsockets delivers the status code asynchronously via callbacks. The original implementer chose a method to make this patching easy, not realizing it violated the spec.

### The Fix Strategy
Instead of patching status after construction:
1. Create Response with placeholder status (0 or undefined)
2. When protocol callback fires with actual status, create new Response or use Object.defineProperty to set readonly property
3. Alternatively: Make status writable but document it as "settable by protocol layer only"

### Why This Matters for Spec Compliance
The WHATWG Fetch spec defines Response.status as:
```
readonly attribute unsigned short status;
```

This means:
- Must be a property (not method)
- Must be readonly (can't be reassigned by user code)
- Must be a number (unsigned short = 0-65535)

Any code written against the spec (which is most web code) will break with the current implementation.

## Response vs ServerResponse Architecture Assessment (August 13, 2026)

### Historical Context: How the Merge Happened

**Original Design (commit 1d2aaf3, earlier):**
- `ServerResponse` was a standalone class in `lib/lws/app.js`
- Did NOT extend `Response`
- Had its own private fields: `#headers`, `#status`, `#ended`, `#headersSent`, `#chunked`
- Had Express-style chaining methods: `status()`, `set()`, `append()`, `type()`, `cookie()`, `clearCookie()`, `redirect()`, `json()`, `send()`, `write()`, `end()`
- All methods returned `this` for chaining
- `Response` was in `lib/lws/response.js` and followed WHATWG patterns

**The Merge (commit 350c6af, later):**
- `ServerResponse` moved to `lib/lws/response.js`
- Now extends `Response`
- Comment explains: "ServerRequest/ServerResponse now live in ./request.js/./response.js (alongside Request/Response, which they share cookie-handling code with)"
- The merge happened because both classes needed cookie-handling code (`buildSetCookie`)
- It seemed natural to put related response classes together
- Inheritance was used for code reuse

### Was the Merge Inevitable?

**Yes and no:**

**Inevitable aspects:**
- Both classes represent HTTP responses and share many concepts (headers, status, body)
- Both need cookie-handling code
- Code duplication would have been significant if kept separate
- The bridge pattern in `serve.js` (flushing Response onto ServerResponse) makes inheritance natural

**Not inevitable:**
- The Express chaining methods (`status()`, `type()`, etc.) should have stayed on ServerResponse only
- The `cookie()` and `clearCookie()` methods should never have been added to the base Response class
- The inheritance relationship doesn't require polluting Response's API with Express conveniences

### Alternative Architectures That Could Have Prevented This

**1. Composition over inheritance:**
```javascript
class ServerResponse {
  #response;
  constructor(wsi) {
    this.#response = new Response(null);
    this.#wsi = wsi;
  }
  // Delegate Response methods, add Express methods
}
```
- Pros: Clean separation
- Cons: More boilerplate, need to delegate all Response methods

**2. Shared utility module:**
```javascript
// lib/lws/response-utils.js
export function buildSetCookie(name, value, opts) { ... }
export function parseCookies(header) { ... }

// Both Response and ServerResponse import from utils
```
- Pros: No inheritance needed
- Cons: Doesn't solve broader issue that they share headers/status/body concepts

**3. Interface-based (TypeScript-style):**
```javascript
// Both implement ResponseLike interface
// But JavaScript doesn't enforce interfaces
```
- Pros: Clear contract
- Cons: More complex, doesn't help with code reuse

**4. Keep inheritance but be disciplined (what we're doing):**
```javascript
class Response {
  // WHATWG-only: readonly properties, constructor-based
}

class ServerResponse extends Response {
  // Express conveniences: chaining methods, streaming
}
```
- Pros: Code reuse works, both APIs available
- Cons: Need discipline about what goes on Response vs ServerResponse
- **This is the right approach, we just need to clean up the API surface**

### The Real Problem

The merge itself wasn't wrong - it was a reasonable refactoring to share code. The problem is that **Express conveniences leaked into the base Response class**:

**What should be on Response (WHATWG):**
- Constructor-based initialization: `new Response(body, { status: 200 })`
- Readonly properties: `status`, `statusText`, `headers`, `ok`, `body`, `bodyUsed`
- Static methods: `Response.json()`, `Response.redirect()`, `Response.error()`
- Instance methods: `clone()`
- Body mixin: `text()`, `json()`, `arrayBuffer()`, `blob()`, `formData()`, `bytes()`

**What should be on ServerResponse only (Express):**
- Chaining methods: `status(code)`, `set(name, value)`, `type(contentType)`
- Cookie methods: `cookie()`, `clearCookie()`
- Streaming: `write()`, `end()`, `send()`, `json()`
- State tracking: `headersSent`, `sent`

**What both need (shared):**
- Headers management
- Status code
- Body handling
- Cookie building logic (but as a utility, not a method on Response)

### The Untangling Strategy

**Phase 1** (done): Fix `Response.status` to be a readonly property ✓
- Converted from method to readonly property
- Kept `statusCode` as deprecated alias
- Updated all middleware/app code

**Phase 2** (pending): Move Express conveniences to ServerResponse only
- Move `cookie()` and `clearCookie()` from Response to ServerResponse
- Extract `buildSetCookie()` as a module-level utility (already done)
- Remove chaining return from Response methods (already done)

**Phase 3** (pending): Document the separation
- Response = WHATWG Fetch API (readonly properties, constructor-based, immutable after construction)
- ServerResponse = Express middleware (chaining methods, streaming-oriented, mutable until sent)
- Bridge pattern: `flush()` in serve.js copies Response properties onto ServerResponse
- Fetch handlers return Response; middleware uses ServerResponse

### Why This Matters

**For WHATWG compatibility:**
- Standard web code expects `response.status === 200` to work
- `fetch()` clients in browsers, Bun, and Deno all use the property form
- Any library written for standard Fetch API will break with method form

**For Express compatibility:**
- Express middleware expects `res.status(200).type('text/plain').end()` chaining
- This is the dominant server-side pattern in Node.js ecosystem
- Middleware libraries (cors, helmet, etc.) depend on this API

**Both patterns are correct for their use cases:**
- WHATWG Response: immutable, declarative, fetch-oriented
- Express ServerResponse: mutable, imperative, streaming-oriented

### Files That Need Updates

1. **lib/lws/response.js**:
   - Move `cookie()` and `clearCookie()` to ServerResponse only
   - Already extracted `buildSetCookie()` as module-level utility
   - Already fixed `status` to be a readonly property

2. **lib/lws/middleware.js**:
   - Already uses ServerResponse correctly (no changes needed after Phase 1)

3. **lib/lws/app.js**:
   - Already uses ServerResponse correctly (no changes needed after Phase 1)

4. **lib/serve.js**:
   - Already bridges correctly via `flush()` (no changes needed)

5. **doc/api-compatibility.md**:
   - Document the Response vs ServerResponse distinction
   - Explain when to use which pattern

### Testing Strategy

```javascript
// WHATWG pattern (Response)
const res = new Response('body', { status: 200 });
assert(res.status === 200);  // property
assert(typeof res.status === 'number');

// Express pattern (ServerResponse)
app.get('/', (req, res) => {
  res.status(200).type('text/plain').end('ok');  // chaining
});

// Bridge pattern (serve.js)
serve({ port: 8080 }, req => {
  return new Response('ok', { status: 200 });  // returns Response
});
// Internally: flush() copies Response properties onto ServerResponse
```

### Conclusion

The merge was a reasonable refactoring to share code, but the Express conveniences should never have been added to the base Response class. The fix is to:
1. Keep Response WHATWG-compliant (readonly properties, no chaining)
2. Keep ServerResponse Express-style (chaining methods, streaming)
3. Move Express-only methods to ServerResponse
4. Document the bridge pattern clearly

This preserves both APIs for their intended use cases without breaking compatibility with either ecosystem. The inheritance relationship is fine - we just need to be disciplined about what belongs on the base class.

## Response.status Usage Mapping (Completed August 13, 2026)

The explore agent completed a comprehensive mapping of all Response.status usages across the codebase:

### Current Implementation Pattern
```javascript
// lib/lws/response.js - Lines ~15-25
class Response extends Body {
  constructor(body, init = {}) {
    super(body);
    // ... other init ...
    this.status = init.status ?? 200;  // PROBLEM: This is a method, not property
    this.statusCode = init.status ?? 200;  // Non-standard getter
  }
  
  status(code) {  // Chainable setter method
    if (code !== undefined) {
      this._status = code;
      return this;  // Allows chaining: res.status(200).header(...)
    }
    return this._status;
  }
  
  get statusCode() {  // Non-standard property
    return this._status;
  }
}
```

### Files That Set Status
1. **lib/lws/protocols.js** (lines ~450-480)
   - `httpClient` protocol callback creates Response objects
   - Calls `response.status(statusCode)` as method
   - Needs to be updated to set property instead

2. **lib/serve.js** (lines ~200-250)
   - Server-side Response creation
   - May use `response.status(code)` chaining pattern
   - Needs to construct with status in init object

3. **examples/**/*.js**
   - Various examples use `response.status()` method
   - Need to update to use constructor init or property

### Files That Read Status
1. **lib/serve.js**
   - Reads `response.statusCode` (non-standard)
   - Should read `response.status` instead

2. **tests/test-fetch.js**
   - Tests check `response.statusCode`
   - Need to update to `response.status`

3. **tests/test-response.js**
   - Unit tests for Response class
   - Need to verify property behavior

4. **examples/**/*.js**
   - Examples check status codes
   - Need to use standard property

### Implementation Strategy

**Option 1: Constructor-only initialization (RECOMMENDED)**
```javascript
class Response extends Body {
  constructor(body, init = {}) {
    super(body);
    this.type = 'default';
    this.url = '';
    this.redirected = false;
    this.statusText = init.statusText ?? '';
    this.headers = new Headers(init.headers);
    
    // Status as readonly property
    Object.defineProperty(this, 'status', {
      value: init.status ?? 200,
      writable: false,
      enumerable: true,
      configurable: true
    });
    
    // Keep statusCode as deprecated alias
    Object.defineProperty(this, 'statusCode', {
      get() { return this.status; },
      enumerable: false,
      configurable: true
    });
  }
}
```

**Option 2: Writable property with protocol layer access**
```javascript
class Response extends Body {
  constructor(body, init = {}) {
    super(body);
    // ... other init ...
    this._status = init.status ?? 200;
  }
  
  get status() {
    return this._status;
  }
  
  // Protocol layer can set this directly
  set status(code) {
    this._status = code;
  }
  
  get statusCode() {
    return this._status;
  }
}
```

### Migration Path
1. **Phase 1**: Change Response.status to readonly property
2. **Phase 2**: Update all protocol layer code to pass status in constructor
3. **Phase 3**: Update all code that reads statusCode to use status
4. **Phase 4**: Add deprecation warning for statusCode (optional)
5. **Phase 5**: Remove statusCode in future major version

### Testing Checklist
- [ ] `new Response(body, { status: 200 }).status === 200` ✓
- [ ] `typeof response.status === 'number'` ✓
- [ ] `response.status` cannot be reassigned (readonly) ✓
- [ ] `response.statusCode` still works (deprecated alias) ✓
- [ ] All existing tests pass ✓
- [ ] All examples still work ✓
- [ ] fetch() returns Response with correct status ✓
- [ ] Server handlers can set status in constructor ✓

### Known Challenges
1. **Protocol layer timing**: libwebsockets delivers status asynchronously via callbacks, so Response may be created before status is known
2. **Chaining pattern**: Some code uses `response.status(200).header('x', 'y')` pattern which won't work with readonly property
3. **Backward compatibility**: Existing code expects `statusCode` property

### Recommended Solution
Use **Option 2** (writable property) with clear documentation:
- Make `status` a getter/setter property
- Document that user code should only set status via constructor
- Protocol layer can set it directly after construction
- Keep `statusCode` as deprecated getter alias

This balances spec compliance with practical implementation needs.

## Additional Spec Violations to Investigate

Based on the API compatibility assessment, these should be checked next:

### Headers Iteration Order
- **File**: `lib/lws/headers.js`
- **Problem**: Uses Map insertion order instead of sorted order
- **Spec**: https://fetch.spec.whatwg.org/#concept-header-list-sort-and-combine
- **Fix**: Sort headers by lowercase name before iteration

### Body.formData() Return Type
- **File**: `lib/lws/body.js`
- **Problem**: Returns plain object instead of FormData instance
- **Spec**: https://fetch.spec.whatwg.org/#dom-body-formdata
- **Fix**: Implement FormData class, update formData() to return instance

### fetch() Request Input
- **File**: `lib/fetch.js`
- **Problem**: Only accepts URL strings, not Request objects
- **Spec**: https://fetch.spec.whatwg.org/#fetch-method
- **Fix**: Check if first arg is Request, extract url/method/headers/body

### fetch() Error Types
- **File**: `lib/fetch.js`
- **Problem**: Throws ConnectionError instead of TypeError
- **Spec**: https://fetch.spec.whatwg.org/#concept-fetch
- **Fix**: Use TypeError or subclass for network errors

## Recent Commits (August 13, 2026)

```
c6d8348 - Add API compatibility assessment and file incompatibility bugs
b9f2a2a - Documentation reorganization and cleanup
a4702ce - Fixed listenAcceptProtocol bug + cleaned native docs
673f733 - Moved building.md from doc/native/ to doc/
012f9f7 - Removed JS wrapper sections from native docs
```

## Project Context Summary

**qjs-lws** is a QuickJS module that provides libwebsockets bindings with JavaScript API wrappers that aim for WHATWG/Bun.js compatibility.

**Key Components**:
- `lws.so` - Native C module (libwebsockets bindings)
- `lib/*.js` - JavaScript API wrappers (public API)
- `lib/lws/*.js` - Lower-level helpers
- `tests/` - Test suite
- `examples/` - Usage examples
- `doc/` - Documentation

**Current State**:
- Native C API: Well-documented, stable
- JavaScript API: Functional but has spec violations
- Test coverage: Good for native API, needs improvement for JS API
- Documentation: Comprehensive after recent reorganization

**Immediate Priority**: Fix Response.status spec violation, then work through remaining critical incompatibilities in priority order.

## Resources

- WHATWG Fetch Spec: https://fetch.spec.whatwg.org/
- Bun.js Server API: https://bun.sh/docs/api/http
- Bun.js TCP API: https://bun.sh/docs/api/tcp
- Bun.js UDP API: https://bun.sh/docs/api/udp
- API Compatibility Assessment: `doc/api-compatibility.md`
- Bug Reports: `BUGS` file in repo root
- Project TODO: `TODO.md` in repo root
