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

## Recent Fixes (August 2026)

### Response.status Spec Violation (FIXED - commit e139858)

**Problem**: `Response.status` was implemented as a chainable setter method instead of a readonly property per WHATWG spec.

**Solution**: 
- Converted `Response.status` to readonly property
- Created separate `ServerResponse` class with chainable `status(code)` method for Express-style middleware
- Fixed `lib/lws/protocols.js` to create Response with status/headers when established (not mutated after)
- Updated `lib/lws/app.js` to use `res.status(code)` chaining
- All tests pass (27 middleware, 26 app, 4 fetch, 13 response unit tests)

### Additional WHATWG Fetch API Compliance (FIXED)

**Completed fixes**:
- **Body.bytes()** - Implemented method returning Promise<Uint8Array>
- **Body.formData()** - Now returns FormData instance (created `lib/lws/formdata.js`)
- **Request.clone()** - Checks bodyUsed and throws TypeError if already consumed
- **Response.clone()** - Checks bodyUsed and throws TypeError if already consumed  
- **Headers iteration** - Now sorted lexicographically (not insertion order)

## Current Work

### Remaining Critical Spec Violations

**Priority 1**: Remaining WHATWG Fetch API issues
1. **fetch() Request input** - Accept Request objects as first argument (currently only accepts URL strings)
2. **fetch() error types** - Use TypeError instead of ConnectionError for network errors
3. **fetch() AbortSignal handling** - Complete implementation (wrong error type, overwrites handler, no pre-check)

**Priority 2**: WebSocket and Server gaps
4. **WebSocket.url property** - Missing from implementation
5. **Server.url property** - Missing from Bun.serve() implementation
6. **EventTarget options** - Add support for `once` and `signal` parameters

See `BUGS` file for complete list of known spec violations.

## Next Steps

### Priority 1: Critical Spec Violations
1. **fetch() Request input** - Accept Request objects as first argument
2. **fetch() error types** - Use TypeError instead of ConnectionError
3. **fetch() AbortSignal handling** - Complete implementation

### Priority 2: High-Impact Missing Features
4. **WebSocket.url property** - Store and expose URL
5. **Server.url property** - Construct URL from hostname and port
6. **EventTarget options** - Add once/signal support
7. **WebSocket bufferedAmount** - Expose write queue size (requires native support)

### Priority 3: Bun.js API Completion
8. **Server methods** - Implement reload, ref/unref, subscriberCount, requestIP, timeout, etc.
9. **WebSocket handler options** - Add drain, ping/pong, compression, timeouts
10. **ServerWebSocket properties** - Add remoteAddress, subscriptions, cork
11. **UDPSocket methods** - Fix send() signature, add multicast methods
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

## Response vs ServerResponse Architecture (FIXED August 13, 2026)

**Status: COMPLETE** - Response and ServerResponse are now properly separated.

**The Fix (commit e139858):**
- `Response` (WHATWG): readonly `status` property, immutable after construction
- `ServerResponse` (Express): chainable `status(code)` method, mutable until sent
- Client-side: Response created with status/headers in `onEstablishedClientHttp()` instead of mutation
- `serve.js` bridges them via `flush()` function
- All unit tests pass

**Implementation Details:**
- `lib/lws/response.js`: Response has readonly getters, ServerResponse has chainable methods
- `lib/lws/protocols.js`: Client Response created when established (not mutated after)
- `lib/lws/app.js`: Uses `res.status(code)` chaining (ServerResponse)
- `lib/lws/middleware.js`: Uses `res.status(code)` chaining (ServerResponse)
- `lib/serve.js`: `flush()` copies Response properties onto ServerResponse

**Key Design:**
- Response follows WHATWG Fetch API spec (immutable, declarative)
- ServerResponse follows Express conventions (mutable, imperative, streaming)
- Both classes are correct for their use cases
- Inheritance preserves code reuse (headers, body, etc.)

**What Changed:**
- Before: Response had chainable `status(code)` method (violated spec)
- After: Response has readonly `status` property, ServerResponse has chainable method
- Before: Client Response created early, mutated when status arrived
- After: Client Response created when established with all properties
- Before: `redirected` tracked on Response object
- After: `redirected` tracked on session, passed to Response constructor

See `doc/api-compatibility.md` for full API surface assessment.

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
