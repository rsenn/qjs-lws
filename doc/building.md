# Building qjs-lws

The module is built with CMake; the result is a QuickJS native module
`lws.so` plus its companion JS helpers under `lib/`.

## Required dependencies

- A C compiler (GCC or Clang). Windows builds use MinGW (see
  `x86_64-w64-mingw32.log`).
- CMake ≥ 3.5.
- A QuickJS install (`quickjs.h`, `cutils.h`, `list.h`). The build
  uses `cmake/FindQuickJS.cmake` and `cmake/QuickJSModule.cmake`.
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

```sh
git submodule update --init --recursive
mkdir build && cd build
cmake -DDEBUG_OUTPUT=OFF -DDO_TESTS=ON ..
make -j
```

The shared module is written to `build/lws.so` (or `lws.dll` /
`lws.dylib`).

## Loading the module

QuickJS resolves `import 'lws'` to `lws.so` when the directory is on
the module search path. The `qjs` binary supports `-I <path>` and
falls back to the script's own directory.

```sh
qjs -I ./build  ./tests/test-server.js
```

## Debugging tips

- `-DDEBUG_OUTPUT=ON` enables `DEBUG()`/`DEBUG_WSI()` macros that
  print every callback invocation prefixed with the wsi id.
- `logLevel(LLL_USER | LLL_INFO | LLL_DEBUG)` shows libwebsockets's
  own logs.
- `LWSSocket.list()` enumerates every live wsi the binding knows
  about — useful for leak hunts.
