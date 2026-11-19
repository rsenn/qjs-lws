## qjs-lws MSYS build — session handoff

**Decisions:**
- Treat MSYS as a POSIX platform: toolchain files msys32/msys64.cmake now set CMAKE_SYSTEM_NAME MSYS — MSYS compilers define __MSYS__/__CYGWIN__ but not _WIN32, so libwebsockets headers select plat/unix and CMake must agree (WIN32 false, UNIX true)
- Patch 0010 (net/route.h skip, ETHER_ADDR_LEN fallback for __CYGWIN__) in qjs-lws/patches — applied at configure by cmake/ApplyPatches.cmake
- Committed and pushed qjs-lws as e810526 (MSYS/Windows port work); no Co-Authored-By trailer, per CLAUDE.md
- Verified: scratch configure + build of target libwebsockets for msys32 with -DWITH_SSL=OFF succeeds

**Open / blocked:**
- Full qjs-lws (not just libwebsockets) build for MSYS untested; `if(WIN32)` link libs (crypt32, iphlpapi) no longer apply under SYSTEM_NAME MSYS
- BuildLibwebsockets.cmake lines ~384/388: dev warnings, endif() args mismatch (user WIP, harmless)
- MSYS sysroot has no OpenSSL (msys2-get.sh -s <triplet> openssl needed for SSL builds)
- Existing qjs-modules msys build trees need reconfigure (system name changed)
- /opt/cmake-toolchains edits uncommitted (separate repo, dubious ownership; user decides)
- Other uncommitted work: qjs-ffi (CMakeLists, BuildLibFFI.cmake, ffi.c), qjs-modules (BUGS, quickjs-path.c, quickjs-sockets.c, TODO.md MSYS bullet); remaining TODO.md item 8 threads (static musl, gating for qjs-lws/qjs-ffi, c-utils pkgcfg typo gap)

**Conventions noted:**
- Always run qjsm/qjs/ctest under timeout + memory limit (qjs-modules CLAUDE.md)
- Commit only when asked; leave scratch/untracked junk out; no force pushes
