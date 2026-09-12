# Building qjs-lws

The module is built with CMake; the result is a QuickJS native module
`lws.so` plus its companion JS helpers under `lib/`.

## Prerequisite: QuickJS itself

qjs-lws is a QuickJS native module, so a QuickJS install (headers +
library, found via `cmake/FindQuickJS.cmake`) must exist first. This
project is developed against the `cxx-designated` branch of
[rsenn/quickjs](https://github.com/rsenn/quickjs) (a fork of
[bellard/quickjs](https://bellard.org/quickjs/) with the `cfg.sh`/CMake
build used below) - not `main` - so clone that branch specifically.
qjs-lws is meant to be checked out *inside* that clone, as
`quickjs/qjs-lws`, not next to it: several things (this doc's own
build recipe, and `examples/ollama-repl`'s sibling-project lookup)
resolve QuickJS's own source via `..` from qjs-lws's own directory.

```sh
git clone -b cxx-designated https://github.com/rsenn/quickjs.git
cd quickjs
cmake -B build/release -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .
sudo cmake --build build/release --target install -j
```

The install step needs write access to `-DCMAKE_INSTALL_PREFIX`
(`/usr/local` above) - drop `sudo` if you pointed it at a prefix your
user already owns.

QuickJS also ships a `cfg.sh` (source it, then run `TYPE=Release
prefix=/usr/local cfg`) that wraps the same `cmake` invocation and
picks a host-triplet-named build directory (e.g. `build/x86_64-linux-gnu`)
instead of a fixed one - convenient once you know it, but that
directory name isn't the same on every machine, so it doesn't belong
in a copy-pasteable recipe; the plain `cmake`/`build/release` form
above (and in "Standard build" below) is the one to follow here.

Once QuickJS itself is installed, `cd ..` back out and continue with
qjs-lws itself - clone it *inside* that same `quickjs` checkout (see
"Standard build" below) - and, if any of the `examples/` you want to
run need it, qjs-modules (next section).

## Optional prerequisite: qjs-modules (needed by some examples)

[qjs-modules](https://github.com/rsenn/qjs-modules) is a separate
sibling project (native + pure-JS modules for QuickJS, and the `qjsm`
interpreter - "QuickJS Modular", a superset of plain `qjs` with ES
module resolution, `process`/`fs`/`util`/etc. built in). qjs-lws itself
doesn't need it, but a few `examples/` do:

| Example | Needs qjs-modules for | Run with |
|---|---|---|
| `examples/ollama-repl` | the `qjsm` interpreter itself (ES module resolution, `process`/`fs`/etc. availability); `REPL` from `'repl'` (interactive prompt); `Console` from `'console'` (via the shared `lib/logger.js`) | `qjsm repl.js ...` (not plain `qjs` - see the example's own `CLAUDE.md`) |
| `examples/crawler` | `Console` from `'console'`, `Repeater` from `'repeater'`, `XMLParser` from `'xml'` | `qjs` (imports resolve once qjs-modules' JS libdir is installed) |
| `examples/debugger` | `TextEncoder`/`TextDecoder` from `'textcode'` | `qjs` |

Everything else under `examples/` (`dns-server`, `proxy`,
`raw-proxy-fallback`, `websocket-chat`) runs on plain `qjs` + qjs-lws
alone, no qjs-modules install needed.

Build/install it the same way, after QuickJS itself is installed (it
also needs `quickjs.h`/etc., found the same way qjs-lws finds them):

```sh
git clone https://github.com/rsenn/qjs-modules.git
cd qjs-modules
cmake -B build/release -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .
sudo cmake --build build/release --target install -j
```

This installs the pure-JS modules (`console.js`/`repl.js`/`fs.js`/...)
under QuickJS's module search path, the native modules (`xml`, ...)
alongside them, and the `qjsm` binary to `bin` - see qjs-modules' own
`README.md` for its module index and optional `MODULE_*` CMake flags
(most native modules besides the ones above are gated behind an
external library dependency and off by default).

## Required dependencies

- A C compiler (GCC or Clang). Windows builds use MinGW (see
  `x86_64-w64-mingw32.log`).
- CMake ≥ 3.5.
- A QuickJS install (`quickjs.h`, `cutils.h`, `list.h`) - see
  "Prerequisite: QuickJS itself" above. The build uses
  `cmake/FindQuickJS.cmake` and `cmake/QuickJSModule.cmake`.
- libwebsockets (optionally vendored; `BUILD_LIBWEBSOCKETS=ON` will
  build the submodule under `libwebsockets/`).
- zlib (only when not using the in-tree libwebsockets).

## Configuration options

From `CMakeLists.txt`:

| Option | Default | Purpose |
|--------|---------|---------|
| `BUILD_LIBWEBSOCKETS`  | `ON`  | Build the vendored libwebsockets submodule |
| `DO_TESTS`             | `ON`  | Build and install the JS smoke tests |
| `USE_CURL`             | `OFF` | Use libcurl for `fetch()` |
| `BUILD_CURL`           | `OFF` | Vendor-build curl when `USE_CURL=ON` |
| `BUILD_MINIMAL_EXAMPLES` | `OFF` | Build the libwebsockets minimal examples |
| `DEBUG_OUTPUT`         | `OFF` | Define `DEBUG_OUTPUT`; activates the `DEBUG()` / `DEBUG_WSI()` macros |
| `USE_EPOLL`            | `OFF` | Linux-only. Route pollfd management through a single `epoll(7)` instance (`lws-epoll.c`) instead of one `os.setReadHandler`/`setWriteHandler` registration per fd — see [event-loop.md](native/event-loop.md#optional-epoll7-backend-use_epoll) |
| `DISABLE_WERROR`       | `ON`  | Don't treat warnings as errors |

### libwebsockets plugins

A `PLUGIN()` macro pulls in selected libwebsockets in-tree plugins
(`-DPLUGIN_PROTOCOL_*=1`). The compiled-in protocol slot reservation
in `lws-context.c` (lines around `protocols_fromarray`) leaves room
for them. To enable a plugin you re-enable the matching `#ifdef
PLUGIN_PROTOCOL_*` block in `lws-context.c` (currently commented
out).

Available macros: `DEADDROP`, `RAW_PROXY`, `FULLTEXT_DEMO`,
`LWS_STATUS`, `LWS_ACME_CLIENT`, `LWS_SSHD_DEMO`, `DUMB_INCREMENT`,
`MIRROR`, `LWS_RAW_SSHD`, `RAW_TEST`.

## Standard build

Run from *inside* a QuickJS checkout (see "Prerequisite: QuickJS
itself" above):

```sh
git clone https://github.com/rsenn/qjs-lws.git
cd qjs-lws
git submodule update --init --recursive
cmake -B build/release -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DDEBUG_OUTPUT=OFF -DDO_TESTS=ON .
sudo cmake --build build/release --target install -j
```

The shared module is written to `build/release/lws.so` (or `lws.dll` /
`lws.dylib`), and installed alongside its `lib/` JS helpers under the
`-DCMAKE_INSTALL_PREFIX` given above. Drop the install step (and
`sudo`) if you just want to build it in place and run from `build/release`
directly, e.g. for the "Loading the module" recipe below.

## Loading the module

QuickJS resolves `import 'lws'` to `lws.so` when the directory is on
the module search path. The `qjs` binary supports `-I <path>` and
falls back to the script's own directory.

```sh
qjs -I ./build/release  ./tests/unittests/test-lwscontext.js
```

## Debugging tips

- `-DDEBUG_OUTPUT=ON` enables `DEBUG()`/`DEBUG_WSI()` macros that
  print every callback invocation prefixed with the wsi id.
- `logLevel(LLL_USER | LLL_INFO | LLL_DEBUG)` shows libwebsockets's
  own logs.
- `LWSSocket.list()` enumerates every live wsi the binding knows
  about — useful for leak hunts.
