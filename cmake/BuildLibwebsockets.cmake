include(CheckLibraryExists)

include(cmake/FindZlib.cmake)
include(cmake/BuildZlib.cmake)
include(cmake/FindLibCap.cmake)
include(cmake/BuildLibCap.cmake)
include(cmake/FindBrotli.cmake)
include(cmake/BuildBrotli.cmake)
include(cmake/BuildLibreSSL.cmake)

# ON: always build libcap from source; AUTO: use the system libcap if there is
# a usable one, else build lws without it; OFF: build lws without libcap.
set(BUILD_LIBCAP AUTO CACHE STRING "Build libcap from source (AUTO, ON, OFF)")
set_property(CACHE BUILD_LIBCAP PROPERTY STRINGS AUTO ON OFF)
string(TOUPPER "${BUILD_LIBCAP}" BUILD_LIBCAP)
if(NOT BUILD_LIBCAP MATCHES "^(AUTO|ON|OFF)$")
  message(FATAL_ERROR "BUILD_LIBCAP must be AUTO, ON or OFF (is '${BUILD_LIBCAP}')")
endif()

set(BUILD_BROTLI AUTO CACHE STRING "Build brotli from source (AUTO, ON, OFF)")
set_property(CACHE BUILD_BROTLI PROPERTY STRINGS AUTO ON OFF)
string(TOUPPER "${BUILD_BROTLI}" BUILD_BROTLI)
if(NOT BUILD_BROTLI MATCHES "^(AUTO|ON|OFF)$")
  message(FATAL_ERROR "BUILD_BROTLI must be AUTO, ON or OFF (is '${BUILD_BROTLI}')")
endif()


macro(build_libwebsockets)
  # Accepts either the legacy positional form build_libwebsockets(<target>)
  # or build_libwebsockets(TARGET <target> PIC <ON|OFF>). PIC controls
  # whether the compiled objects get -fPIC (needed when this build feeds a
  # shared module) or not (cheaper/smaller when it only ever feeds a static
  # module) - see build-pic-and-nopic-libwebsockets in CMakeLists.txt.
  cmake_parse_arguments(BLW "" "TARGET;PIC" "" ${ARGN})

  if(BLW_TARGET)
    set(TARGET "${BLW_TARGET}")
  elseif(BLW_UNPARSED_ARGUMENTS)
    list(GET BLW_UNPARSED_ARGUMENTS 0 TARGET)
  else()
    set(TARGET libwebsockets)
  endif()

  if(DEFINED BLW_PIC)
    set(LWS_BUILD_PIC "${BLW_PIC}")
  else()
    set(LWS_BUILD_PIC ON)
  endif()

  set(LWS_BINARY_DIR "${CMAKE_CURRENT_BINARY_DIR}/${TARGET}")

  # Once zlib had to be built, ZLIB_LIBRARY points at that build, which
  # find_zlib() would mistake for a found system zlib on the next call.
  if(ZLIB_BUILT)
    set(ZLIB_FOUND FALSE)
  else(ZLIB_BUILT)
    find_zlib()
  endif(ZLIB_BUILT)

  if(ZLIB_FOUND)
    set(LWS_ZLIB_INCLUDE_DIRS_VALUE "${ZLIB_INCLUDE_DIR}")
    set(LWS_ZLIB_LIBRARIES_VALUE "${ZLIB_LIBRARY}")
  else(ZLIB_FOUND)
    # One zlib build per libwebsockets target, since PIC may differ between them.
    build_zlib(${CMAKE_CURRENT_BINARY_DIR} ${TARGET} ${LWS_BUILD_PIC})
    set(ZLIB_DEPS zlib_${TARGET})
    set(LWS_ZLIB_INCLUDE_DIRS_VALUE "${ZLIB_INCLUDE_DIR_${TARGET}}")
    set(LWS_ZLIB_LIBRARIES_VALUE "${ZLIB_LIBRARY_FILE_${TARGET}}")
    # The rest of the project links ${ZLIB_LIBRARY}; point it at the built
    # zlib (the PIC one, if any, since shared modules need it).
    if(NOT ZLIB_BUILT OR LWS_BUILD_PIC)
      set(ZLIB_LIBRARY "${ZLIB_LIBRARY_FILE_${TARGET}}")
      set(ZLIB_LIBRARIES "${ZLIB_LIBRARY}")
      set(ZLIB_INCLUDE_DIR "${ZLIB_INCLUDE_DIR_${TARGET}}")
    endif()
    set(ZLIB_BUILT TRUE)
  endif(ZLIB_FOUND)


  message(STATUS "Building libwebsockets from source (${TARGET}, PIC=${LWS_BUILD_PIC})")

  if(NOT DEFINED LIBWEBSOCKETS_C_FLAGS)
    message(
      FATAL_ERROR "Please set LIBWEBSOCKETS_C_FLAGS before including this file."
    )
  endif()

  set(LWS_WITHOUT_TESTAPPS TRUE)
  set(LWS_WITHOUT_TEST_SERVER TRUE)
  set(LWS_WITHOUT_TEST_PING TRUE)
  set(LWS_WITHOUT_TEST_CLIENT TRUE)
  set(LWS_LINK_TESTAPPS_DYNAMIC OFF CACHE BOOL "link test apps dynamic")
  set(LWS_WITH_STATIC ON CACHE BOOL "build libwebsockets static library")
  set(LWS_HAVE_LIBCAP FALSE CACHE BOOL "have libcap")

  set(LIBWEBSOCKETS_INCLUDE_DIR "${LWS_BINARY_DIR}")

  include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/libwebsockets/include
    ${LWS_BINARY_DIR}
    ${LWS_BINARY_DIR}/include)

  set(LIBWEBSOCKETS_FOUND ON CACHE BOOL "found libwebsockets")
  unset(LIBCAP_DEPS)
  set(LIBCAP_FOUND FALSE)
  if(BUILD_LIBCAP STREQUAL "ON")
    # One libcap build per libwebsockets target, since PIC may differ between them.
    build_libcap(${CMAKE_CURRENT_BINARY_DIR} ${TARGET} ${LWS_BUILD_PIC})
    set(LIBCAP_DEPS libcap_${TARGET})
    set(LIBCAP_FOUND TRUE)
    set(LWS_LIBCAP_INCLUDE_DIR_VALUE "${LIBCAP_INCLUDE_DIR_${TARGET}}")
    set(LWS_LIBCAP_LIBRARY_VALUE "${LIBCAP_LIBRARY_FILE_${TARGET}}")
  else()
    find_libcap()

    if(LIBCAP_FOUND)
      set(LWS_LIBCAP_INCLUDE_DIR_VALUE "${LIBCAP_INCLUDE_DIR}")
      set(LWS_LIBCAP_LIBRARY_VALUE "${LIBCAP_LIBRARY}")
    elseif(BUILD_LIBCAP STREQUAL "AUTO")
       # One libcap build per libwebsockets target, since PIC may differ between them.
      build_libcap(${CMAKE_CURRENT_BINARY_DIR} ${TARGET} ${LWS_BUILD_PIC})
      set(LIBCAP_DEPS libcap_${TARGET})
      set(LIBCAP_FOUND TRUE)
      set(LWS_LIBCAP_INCLUDE_DIR_VALUE "${LIBCAP_INCLUDE_DIR_${TARGET}}")
      set(LWS_LIBCAP_LIBRARY_VALUE "${LIBCAP_LIBRARY_FILE_${TARGET}}")
    endif()
  endif()

  # Variables the OpenSSL/brotli handling below may override with a built copy.
  # Remember what the caller had, so each build_libwebsockets() call (PIC and
  # non-PIC) starts from that and decides on its own whether to build.
  set(LWS_DEP_VARS
      OPENSSL_LIBRARIES OPENSSL_INCLUDE_DIR OPENSSL_INCLUDE_DIRS
      OPENSSL_LIBRARY_DIR OPENSSL_ROOT_DIR OPENSSL_LIBRARY BROTLI_LIBRARIES
      BROTLI_INCLUDE_DIR)
  foreach(v ${LWS_DEP_VARS})
    if(NOT LWS_DEP_VARS_STASHED)
      if(DEFINED ${v})
        set(LWS_ORIG_${v} "${${v}}")
        set(LWS_ORIG_${v}_DEFINED TRUE)
      else()
        set(LWS_ORIG_${v}_DEFINED FALSE)
      endif()
    elseif(LWS_ORIG_${v}_DEFINED)
      set(${v} "${LWS_ORIG_${v}}")
    else()
      unset(${v})
    endif()
  endforeach(v)
  set(LWS_DEP_VARS_STASHED TRUE)

  unset(SSL_DEPS)
  unset(BROTLI_DEPS)
  set(LWS_C_FLAGS_FULL "${LIBWEBSOCKETS_C_FLAGS}")
  set(LWS_BROTLI_LIBRARIES_VALUE "brotlienc;brotlidec")

  # Toolchains with their own libc headers (musl-gcc) don't see the kernel's
  # linux/ and asm/ headers that libwebsockets includes. Make them reachable,
  # but only after the toolchain's own directories.
  include(CheckIncludeFile)
  check_include_file(linux/if_packet.h LWS_HAVE_KERNEL_HEADERS)
  if(NOT LWS_HAVE_KERNEL_HEADERS)
    file(GLOB LWS_KERNEL_INCLUDE_DIRS /usr/include /usr/include/*-linux-gnu)
    foreach(d ${LWS_KERNEL_INCLUDE_DIRS})
      if(IS_DIRECTORY "${d}/linux" OR IS_DIRECTORY "${d}/asm")
        string(APPEND LWS_C_FLAGS_FULL " -idirafter ${d}")
        # the modules include libwebsockets' private headers too
        if(NOT LWS_KERNEL_INCLUDES_ADDED)
          add_compile_options("SHELL:-idirafter ${d}")
        endif()
      endif()
    endforeach(d)
    set(LWS_KERNEL_INCLUDES_ADDED TRUE)
  endif(NOT LWS_HAVE_KERNEL_HEADERS)

  # A TLS library the toolchain can use, else build LibreSSL.
  if(WITH_SSL AND NOT WITH_MBEDTLS AND NOT WITH_WOLFSSL)
    include(CheckCSourceCompiles)
    set(old_REQUIRED_INCLUDES "${CMAKE_REQUIRED_INCLUDES}")
    set(old_REQUIRED_LIBRARIES "${CMAKE_REQUIRED_LIBRARIES}")
    set(old_REQUIRED_LINK_OPTIONS "${CMAKE_REQUIRED_LINK_OPTIONS}")
    set(CMAKE_REQUIRED_INCLUDES "${OPENSSL_INCLUDE_DIR}")
    set(CMAKE_REQUIRED_LIBRARIES "${OPENSSL_LIBRARIES}")
    if(OPENSSL_LIBRARY_DIR)
      set(CMAKE_REQUIRED_LINK_OPTIONS "-L${OPENSSL_LIBRARY_DIR}")
    endif(OPENSSL_LIBRARY_DIR)
    unset(LWS_OPENSSL_WORKS CACHE)
    # Linking alone can't tell a glibc libssl.so from one the toolchain's libc
    # can load (e.g. musl-gcc against the host's), so run it when possible.
    set(LWS_OPENSSL_TEST_SOURCE
        "#include <openssl/ssl.h>
         int main(void) { SSL_CTX *c = SSL_CTX_new(TLS_method()); SSL_CTX_free(c); return 0; }")
    if(CMAKE_CROSSCOMPILING)
      check_c_source_compiles("${LWS_OPENSSL_TEST_SOURCE}" LWS_OPENSSL_WORKS)
    else(CMAKE_CROSSCOMPILING)
      include(CheckCSourceRuns)
      check_c_source_runs("${LWS_OPENSSL_TEST_SOURCE}" LWS_OPENSSL_WORKS)
    endif(CMAKE_CROSSCOMPILING)
    set(CMAKE_REQUIRED_INCLUDES "${old_REQUIRED_INCLUDES}")
    set(CMAKE_REQUIRED_LIBRARIES "${old_REQUIRED_LIBRARIES}")
    set(CMAKE_REQUIRED_LINK_OPTIONS "${old_REQUIRED_LINK_OPTIONS}")

    if(NOT LWS_OPENSSL_WORKS)
      # One build per libwebsockets target, since PIC may differ between them.
      build_libressl(${CMAKE_CURRENT_BINARY_DIR} ${TARGET} ${LWS_BUILD_PIC})
      set(SSL_DEPS libressl_${TARGET})
      set(OPENSSL_LIBRARIES "${LIBRESSL_LIBRARIES_${TARGET}}")
      set(OPENSSL_INCLUDE_DIR "${LIBRESSL_INCLUDE_DIR_${TARGET}}")
      set(OPENSSL_INCLUDE_DIRS "${LIBRESSL_INCLUDE_DIR_${TARGET}}")
      set(OPENSSL_LIBRARY_DIR "${LIBRESSL_LIBRARY_DIR_${TARGET}}")
      set(OPENSSL_ROOT_DIR "${LIBRESSL_PREFIX_${TARGET}}")
      set(OPENSSL_LIBRARY "")
    endif(NOT LWS_OPENSSL_WORKS)
  endif(WITH_SSL AND NOT WITH_MBEDTLS AND NOT WITH_WOLFSSL)

  if(WITH_BROTLI)
    set(BROTLI_FOUND FALSE)
    if(NOT BUILD_BROTLI)
      find_brotli()
    endif(NOT BUILD_BROTLI)

    if(BROTLI_FOUND)
      set(old_REQUIRED_INCLUDES "${CMAKE_REQUIRED_INCLUDES}")
      set(old_REQUIRED_LIBRARIES "${CMAKE_REQUIRED_LIBRARIES}")
      set(CMAKE_REQUIRED_INCLUDES "${BROTLI_INCLUDE_DIR}")
      set(CMAKE_REQUIRED_LIBRARIES "${BROTLI_LIBRARIES}")
      unset(LWS_BROTLI_WORKS CACHE)
      check_c_source_compiles(
        "#include <brotli/encode.h>
         int main(void) { return BrotliEncoderVersion() == 0; }"
        LWS_BROTLI_WORKS)
      set(CMAKE_REQUIRED_INCLUDES "${old_REQUIRED_INCLUDES}")
      set(CMAKE_REQUIRED_LIBRARIES "${old_REQUIRED_LIBRARIES}")
      if(NOT LWS_BROTLI_WORKS)
        set(BROTLI_FOUND FALSE)
      endif(NOT LWS_BROTLI_WORKS)
    endif(BROTLI_FOUND)

    if(BROTLI_FOUND)
      if(BROTLI_INCLUDE_DIR AND NOT BROTLI_INCLUDE_DIR STREQUAL "/usr/include")
        string(APPEND LWS_C_FLAGS_FULL " -I${BROTLI_INCLUDE_DIR}")
      endif()
    else(BROTLI_FOUND)
      build_brotli(${CMAKE_CURRENT_BINARY_DIR} ${TARGET} ${LWS_BUILD_PIC})
      set(BROTLI_DEPS brotli_${TARGET})
      set(BROTLI_LIBRARIES "${BROTLI_LIBRARIES_${TARGET}}")
      set(BROTLI_INCLUDE_DIR "${BROTLI_INCLUDE_DIR_${TARGET}}")
      set(LWS_BROTLI_LIBRARIES_VALUE "${BROTLI_LIBRARIES_${TARGET}}")
      string(APPEND LWS_C_FLAGS_FULL " -I${BROTLI_INCLUDE_DIR}")
    endif(BROTLI_FOUND)
  endif(WITH_BROTLI)

  set(LIBWEBSOCKETS_LIBRARIES "${LWS_BROTLI_LIBRARIES_VALUE}")
  if(LIBCAP_FOUND)
    list(APPEND LIBWEBSOCKETS_LIBRARIES "${LWS_LIBCAP_LIBRARY_VALUE}")
  endif(LIBCAP_FOUND)
  if(OPENSSL_LIBRARIES)
    set(LIBWEBSOCKETS_LIBRARIES
        "${OPENSSL_LIBRARIES};${LIBWEBSOCKETS_LIBRARIES}")
  else(OPENSSL_LIBRARIES)
    if(MBEDTLS_LIBRARIES)
      set(LIBWEBSOCKETS_LIBRARIES
          "${MBEDTLS_LIBRARIES};${LIBWEBSOCKETS_LIBRARIES}")
    endif(MBEDTLS_LIBRARIES)
  endif(OPENSSL_LIBRARIES)

  option(USE_GNUTLS "Build libwebsockets with gnutls" OFF)
  option(USE_HTTP3 "Build libwebsockets with h3/quic support" OFF)

  set(LIBWEBSOCKETS_ARGS
      -DLWS_WITH_SSL:BOOL=ON
      -DLWS_WITH_WOLFSSL:BOOL=OFF
      -DLWS_WITH_MBEDTLS:BOOL=OFF
      -DLWS_WITH_GNUTLS:BOOL=OFF
      #-DLWS_WITH_HTTP3:BOOL=OFF

      #-DLWS_WITH_SQLITE3:BOOL=ON
      #-DLWS_WITH_SPAWN:BOOL=ON
      -DLWS_WITH_DISKCACHE:BOOL=ON
      #-DLWS_WITH_WEBRTC:BOOL=ON
      -DLWS_WITH_ASYNC_QUEUE:BOOL=ON
      )


  if(USE_GNUTLS)
    set(LIBWEBSOCKETS_ARGS ${LIBWEBSOCKETS_ARGS}  -DLWS_WITH_GNUTLS:BOOL=ON)
  else(USE_GNUTLS)
    set(LIBWEBSOCKETS_ARGS ${LIBWEBSOCKETS_ARGS}  -DLWS_WITH_GNUTLS:BOOL=OFF)
  endif(USE_GNUTLS)

  if(USE_HTTP3)
    set(LIBWEBSOCKETS_ARGS ${LIBWEBSOCKETS_ARGS}  -DLWS_WITH_HTTP3:BOOL=ON)
  else(USE_HTTP3)
    set(LIBWEBSOCKETS_ARGS ${LIBWEBSOCKETS_ARGS}  -DLWS_WITH_HTTP3:BOOL=OFF)
  endif(USE_HTTP3)

  if(CMAKE_TOOLCHAIN_FILE)
    set(LIBWEBSOCKETS_ARGS
        ${LIBWEBSOCKETS_ARGS}
        -DCMAKE_TOOLCHAIN_FILE:FILEPATH=${CMAKE_TOOLCHAIN_FILE})
  endif(CMAKE_TOOLCHAIN_FILE)

  if(OPENSSL_LIBRARIES)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DLWS_OPENSSL_LIBRARIES:STRING=${OPENSSL_LIBRARIES} -DOPENSSL_LIBRARIES:STRING=${OPENSSL_LIBRARIES}"
    )
  endif(OPENSSL_LIBRARIES)
  if(OPENSSL_LIBRARY)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DLWS_OPENSSL_LIBRARIES:STRING=${OPENSSL_LIBRARY} -DOPENSSL_LIBRARIES:STRING=${OPENSSL_LIBRARY}"
    )
  endif(OPENSSL_LIBRARY)
  if(OPENSSL_LIBRARY_DIR)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DCMAKE_LIBRARY_PATH:STRING=${OPENSSL_LIBRARY_DIR} -DOPENSSL_LIBRARY_DIR:PATH=${OPENSSL_LIBRARY_DIR} -DLWS_OPENSSL_LIBRARY_DIR:PATH=${OPENSSL_LIBRARY_DIR}"
    )
  endif(OPENSSL_LIBRARY_DIR)
  if(OPENSSL_INCLUDE_DIR)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DCMAKE_INCLUDE_PATH:STRING=${OPENSSL_INCLUDE_DIR} -DLWS_OPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR} -DLWS_OPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR} -DOPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR} -DOPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR}"
    )
  endif(OPENSSL_INCLUDE_DIR)
  if(OPENSSL_INCLUDE_DIRS)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DCMAKE_INCLUDE_PATH:STRING=${OPENSSL_INCLUDE_DIRS} -DLWS_OPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIRS} -DLWS_OPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR} -DOPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIRS} -DOPENSSL_INCLUDE_DIRS:STRING=${OPENSSL_INCLUDE_DIR}"
    )
  endif(OPENSSL_INCLUDE_DIRS)
  if(OPENSSL_EXECUTABLE)
    set(LIBWEBSOCKETS_ARGS
        "${LIBWEBSOCKETS_ARGS} -DOPENSSL_EXECUTABLE:FILEPATH=${OPENSSL_EXECUTABLE}"
    )
  endif(OPENSSL_EXECUTABLE)
  
  if(TERMUX)
    set(LIBWEBSOCKETS_ARGS
      "${LIBWEBSOCKETS_ARGS} -DTERMUX=TRUE"
    )
  endif(TERMUX)

  if(WIN32)
    set(LIBWEBSOCKETS_LIBRARIES "websockets_static;${LIBWEBSOCKETS_LIBRARIES}")
  else(WIN32)
    set(LIBWEBSOCKETS_LIBRARIES "websockets;${LIBWEBSOCKETS_LIBRARIES}")
  endif(WIN32)

  if(WIN32)
    set(LIBWEBSOCKETS_LIBRARIES "${LIBWEBSOCKETS_LIBRARIES};crypt32")
  endif(WIN32)
  #    "${CMAKE_CURRENT_BINARY_DIR}/libwebsockets/lib/libwebsockets.a;${LIBWEBSOCKETS_LIBRARIES}"
  #else(EXISTS "${CMAKE_CURRENT_BINARY_DIR}/libwebsockets/lib/libwebsockets.a")
  #  set(LIBWEBSOCKETS_LIBRARIES "websockets;${LIBWEBSOCKETS_LIBRARIES}")
  #endif(EXISTS "${CMAKE_CURRENT_BINARY_DIR}/libwebsockets/lib/libwebsockets.a")
  # Not CACHEd: build_libwebsockets() can run twice in one configure (once
  # PIC, once not - see CMakeLists.txt), and each call's INCLUDE_DIR/
  # LIBRARY_DIR must reflect *that* call's own binary dir, not get stuck on
  # whichever call happened to run first.
  set(LIBWEBSOCKETS_LIBRARIES "${LIBWEBSOCKETS_LIBRARIES}")
  set(LIBWEBSOCKETS_LIBRARY_DIR "${LWS_BINARY_DIR}/lib")

  # Per-target copies so the caller can wire up each of qjs-lws/qjs-lws-static
  # with the right variant when both are built in the same configure.
  set(${TARGET}_LWS_INCLUDE_DIR "${LIBWEBSOCKETS_INCLUDE_DIR}")
  set(${TARGET}_LWS_LIBRARY_DIR "${LIBWEBSOCKETS_LIBRARY_DIR}")
  set(${TARGET}_LWS_LIBRARIES "${LIBWEBSOCKETS_LIBRARIES}")

  # LWS_HAVE_X509_VERIFY_PARAM_set1_host's own CHECK_FUNCTION_EXISTS()
  # (libwebsockets/lib/tls/CMakeLists.txt) runs with CMAKE_REQUIRED_LIBRARIES
  # missing the OpenSSL libs (confirmed via this sub-build's own
  # CMakeConfigureLog.yaml: the check's link line has -lgnutls -ldl -lpthread,
  # no -lssl/-lcrypto, even with LWS_WITH_SSL=ON and OPENSSL_LIBRARIES passed
  # above) so it always comes back false, even though this function has been
  # in OpenSSL since 1.0.2 and every OpenSSL this project links against has
  # it. A false result here isn't just a missed optimization: the client TLS
  # code (lib/tls/openssl/openssl-client.c) has a #else branch for it that
  # unconditionally fails the connection unless the caller also set
  # LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK - which lib/fetch.js's own direct
  # https:// requests do, masking this, but libwebsockets' own internal
  # http->https redirect-follow (lib/roles/http/client/client-http.c) does
  # not, so any http:// URL that 301s to https:// (as most real CDNs do)
  # fails outright with "bio_create failed" until this is pre-seeded (see
  # lib/lws/protocols.js's onClientHttpRedirect for the other half of the
  # fix - even with this, lws's own redirect-follow still carries over the
  # original http:// request's other permissive TLS flags, or lack of
  # them, unchanged). Pre-seeding the cache value, same technique as the
  # HMAC_CTX_new/RSA_SET0_KEY/etc. entries below, skips the broken check
  # instead of fixing its CMAKE_REQUIRED_LIBRARIES ordering inside the
  # vendored submodule.
  list(APPEND LIBWEBSOCKETS_ARGS -DLWS_HAVE_X509_VERIFY_PARAM_set1_host:INTERNAL=1)

  list(APPEND LIBWEBSOCKETS_ARGS -DLWS_HAVE_HMAC_CTX_new:INTERNAL=1
       -DLWS_HAVE_RSA_SET0_KEY:INTERNAL=1 -DLWS_HAVE_ECDSA_SIG_set0:INTERNAL=1
       -DLWS_HAVE_BN_bn2binpad:INTERNAL=1)

  include(ExternalProject)

  if(WITH_WOLFSSL)
    set(LIBWEBSOCKETS_ARGS
        -DLWS_WITH_WOLFSSL:BOOL=ON
        #-DLWS_HAVE_EVP_PKEY_new_raw_private_key:BOOL=ON
        -DLWS_WITH_NETWORK:BOOL=OFF
        -DLWS_WITH_DIR:BOOL=OFF
        # -DLWS_WITH_RANGES:BOOL=ON
        -DLWS_WITH_JOSE:BOOL=OFF
        -DLWS_WITH_ACCESS_LOG:BOOL=OFF
        -DLWS_WITH_SSL:BOOL=OFF
        -DLWS_WITH_MBEDTLS:BOOL=OFF)
    find_package(WOLFSSL NAMES wolfssl PATHS "${WOLFSSL_DIR}" REQUIRED)

    if(WOLFSSL_FOUND)

      include(${WOLFSSL_CONFIG})

      dirname(WOLFSSL_DIR "${WOLFSSL_CONFIG}")

      include(${WOLFSSL_DIR}/wolfssl-config.cmake)

      get_target_property(pkgcfg_lib_WOLFSSL_wolfssl wolfssl
                          IMPORTED_LOCATION_RELWITHDEBINFO)

      dirname(WOLFSSL_LIBRARIES_DIR ${pkgcfg_lib_WOLFSSL_wolfssl})
      string(REGEX REPLACE "/lib.*" "/include" WOLFSSL_INCLUDE_DIR
                           "${WOLFSSL_LIBRARIES_DIR}")

      set(WOLFSSL_LIBRARIES ${WOLFSSL_LIBRARIES} ${pkgcfg_lib_WOLFSSL_wolfssl})
      #list(FILTER WOLFSSL_LIBRARIES EXCLUDE REGEX wolfssl_shared)

      #dump(WOLFSSL_FOUND WOLFSSL_LIBRARIES WOLFSSL_LIBRARIES_DIR WOLFSSL_INCLUDE_DIR)
      set(LIBWEBSOCKETS_ARGS
          ${LIBWEBSOCKETS_ARGS}
          -DLWS_WOLFSSL_LIBRARIES:STRING=${WOLFSSL_LIBRARIES}
          -DLWS_WOLFSSL_INCLUDE_DIRS:STRING=${WOLFSSL_INCLUDE_DIR})

    endif(WOLFSSL_FOUND)

  elseif(WITH_WOLFSSL)
    set(LIBWEBSOCKETS_ARGS -DLWS_ROLE_H2:BOOL=ON -DLWS_WITH_RANGES:BOOL=ON)
    if(1)

    elseif(WITH_SSL)
      if(WITH_MBEDTLS)
        set(LIBWEBSOCKETS_ARGS
            -DLWS_WITH_MBEDTLS:BOOL=ON -DLWS_WITH_WOLFSSL:BOOL=OFF
            -DLWS_WITH_SSL:BOOL=OFF)
        set(LIBWEBSOCKETS_ARGS
            ${LIBWEBSOCKETS_ARGS}
            -DLWS_MBEDTLS_LIBRARIES:STRING=${MBEDTLS_LIBRARIES}
            -DLWS_MBEDTLS_INCLUDE_DIRS:STRING=${MBEDTLS_INCLUDE_DIR})
      endif()
    endif()
  endif()

  # Without a libcap usable by this toolchain, stop lws from picking up the
  # host's: its find_path() adds -I/usr/include ahead of the toolchain's own
  # headers, which breaks e.g. musl-gcc builds (host bits/errno.h).
  if(LIBCAP_FOUND)
    list(APPEND LIBWEBSOCKETS_ARGS -DLWS_WITH_LIBCAP:BOOL=ON
         "-DLIBCAP_INCLUDE_DIRS:PATH=${LWS_LIBCAP_INCLUDE_DIR_VALUE}"
         "-DLIBCAP_LIBRARIES:FILEPATH=${LWS_LIBCAP_LIBRARY_VALUE}")
  else(LIBCAP_FOUND)
    list(APPEND LIBWEBSOCKETS_ARGS -DLWS_WITH_LIBCAP:BOOL=OFF)
  endif(LIBCAP_FOUND)

  if(LWS_ZLIB_LIBRARIES_VALUE)
    list(APPEND LIBWEBSOCKETS_ARGS
         "-DLWS_ZLIB_LIBRARIES:PATH=${LWS_ZLIB_LIBRARIES_VALUE}")
  endif(LWS_ZLIB_LIBRARIES_VALUE)

  if(LWS_ZLIB_INCLUDE_DIRS_VALUE)
    list(APPEND LIBWEBSOCKETS_ARGS
         "-DLWS_ZLIB_INCLUDE_DIRS:PATH=${LWS_ZLIB_INCLUDE_DIRS_VALUE}")
  endif(LWS_ZLIB_INCLUDE_DIRS_VALUE)

  #if("${LWS_HAVE_HMAC_CTX_new}" STREQUAL "")
  #set(LWS_HAVE_HMAC_CTX_new 1 CACHE STRING "Have HMAC_CTX_new")
  #endif("${LWS_HAVE_HMAC_CTX_new}" STREQUAL "")
  #
  #if("${LWS_HAVE_EVP_MD_CTX_free}" STREQUAL "")
  #set(LWS_HAVE_EVP_MD_CTX_free 1 CACHE STRING "Have EVP_MD_CTX_free")
  #endif("${LWS_HAVE_EVP_MD_CTX_free}" STREQUAL "")
  #
  if("${LWS_HAVE_X509_VERIFY_PARAM_set1_host}" STREQUAL "")
    set(LWS_HAVE_X509_VERIFY_PARAM_set1_host 1
        CACHE STRING "Have X509_VERIFY_PARAM_set1_host")
  endif("${LWS_HAVE_X509_VERIFY_PARAM_set1_host}" STREQUAL "")
  #[[if(CMAKE_PREFIX_PATH OR OPENSSL_ROOT_DIR)
    set(LIBWEBSOCKETS_ARGS "${LIBWEBSOCKETS_ARGS} -DCMAKE_PREFIX_PATH:STRING=${CMAKE_PREFIX_PATH};${OPENSSL_ROOT_DIR}")
  endif()
  if(CMAKE_LIBRARY_PATH OR OPENSSL_LIBRARY_DIR)
    set(LIBWEBSOCKETS_ARGS "${LIBWEBSOCKETS_ARGS} -DCMAKE_LIBRARY_PATH:STRING=${CMAKE_LIBRARY_PATH};${OPENSSL_LIBRARY_DIR}")
  endif()
  if(CMAKE_INCLUDE_PATH OR OPENSSL_INCLUDE_DIR)
    set(LIBWEBSOCKETS_ARGS "${LIBWEBSOCKETS_ARGS} -DCMAKE_INCLUDE_PATH:STRING=${CMAKE_INCLUDE_PATH};${OPENSSL_INCLUDE_DIR}")
  endif()]]

  string(REGEX REPLACE "[ \t\n]" "\n\t" ARGS "${LIBWEBSOCKETS_ARGS}")
  string(REGEX REPLACE ";-D" "\n\t-D" ARGS "${ARGS}")
  message(VERBOSE "libwebsockets configuration arguments:\n\t${ARGS}")
  string(REGEX REPLACE "[ ]" ";" LIBWEBSOCKETS_ARGS "${LIBWEBSOCKETS_ARGS}")

  ExternalProject_Add(
    "${TARGET}"
    SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/libwebsockets
    BINARY_DIR ${LWS_BINARY_DIR}
    PREFIX ${TARGET}
    DEPENDS ${ZLIB_DEPS} ${LIBCAP_DEPS} ${SSL_DEPS} ${BROTLI_DEPS}
    CMAKE_ARGS
      -DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON
      "-DCMAKE_C_COMPILER:FILEPATH=${CMAKE_C_COMPILER}"
      "-DCMAKE_C_FLAGS:STRING=${LWS_C_FLAGS_FULL}"
      #"-DCMAKE_C_FLAGS:STRING=${LIBWEBSOCKETS_C_FLAGS} -DSSL_CTRL_SET_TLSEXT_HOSTNAME"
      "-DCMAKE_VERBOSE_MAKEFILE:BOOL=${CMAKE_VERBOSE_MAKEFILE}"
      "-DCMAKE_INSTALL_RPATH:STRING=${MBEDTLS_LIBRARY_DIR}"
      "-DCMAKE_BUILD_TYPE:STRING=${CMAKE_BUILD_TYPE}"
      "-DCMAKE_LIBRARY_PATH:PATH=${CMAKE_LIBRARY_PATH}"
      #"-DCMAKE_REQUIRED_LIBRARIES:STRING=tls;ssl;crypto;pthread;dl"
      #"-DCMAKE_REQUIRED_LINK_OPTIONS:STRING=-L${OPENSSL_LIBRARY_DIR}"
      -DBUILD_TESTING:BOOL=OFF
      -DCMAKE_COLOR_MAKEFILE:BOOL=ON
      -DCOMPILER_IS_CLANG:BOOL=OFF
      -DDISABLE_WERROR:BOOL=ON
      -DLWS_AVOID_SIGPIPE_IGN:BOOL=OFF
      -DLWS_CLIENT_HTTP_PROXYING:BOOL=ON
      -DLWS_FALLBACK_GETHOSTBYNAME:BOOL=ON
      -DLWS_FOR_GITOHASHI:BOOL=OFF
      -DLWS_HTTP_HEADERS_ALL:BOOL=OFF
      -DLWS_IPV6:BOOL=ON
      -DLWS_LOGS_TIMESTAMP:BOOL=ON
      -DLWS_LOG_TAG_LIFECYCLE:BOOL=ON
      -DLWS_REPRODUCIBLE:BOOL=ON
      -DLWS_ROLE_DBUS:BOOL=OFF
      -DLWS_ROLE_MQTT:BOOL=OFF
      -DLWS_ROLE_RAW_FILE:BOOL=ON
      -DLWS_ROLE_RAW_PROXY:BOOL=ON
      -DLWS_ROLE_WS:BOOL=ON
      -DLWS_SSL_CLIENT_USE_OS_CA_CERTS:BOOL=ON
      -DLWS_SSL_SERVER_WITH_ECDH_CERT:BOOL=OFF
      -DLWS_STATIC_PIC:BOOL=${LWS_BUILD_PIC}
      -DLWS_SUPPRESS_DEPRECATED_API_WARNINGS:BOOL=ON
      -DLWS_TLS_LOG_PLAINTEXT_RX:BOOL=OFF
      -DLWS_TLS_LOG_PLAINTEXT_TX:BOOL=OFF
      -DLWS_UNIX_SOCK:BOOL=ON
      -DLWS_WITHOUT_BUILTIN_SHA1:BOOL=OFF
      -DLWS_WITHOUT_CLIENT:BOOL=OFF
      -DLWS_WITHOUT_DAEMONIZE:BOOL=ON
      -DLWS_WITHOUT_EVENTFD:BOOL=OFF
      -DLWS_WITHOUT_EXTENSIONS:BOOL=OFF
      -DLWS_WITHOUT_SERVER:BOOL=OFF
      -DLWS_WITHOUT_TESTAPPS:BOOL=ON
      -DLWS_WITHOUT_TEST_SERVER:BOOL=OFF
      -DLWS_WITH_ACCESS_LOG:BOOL=OFF
      -DLWS_WITH_ACME:BOOL=ON
      -DLWS_WITH_ALSA:BOOL=OFF
      -DLWS_WITH_ASAN:BOOL=OFF
      -DLWS_WITH_BORINGSSL:BOOL=OFF
      -DLWS_WITH_BUNDLED_ZLIB:BOOL=OFF
      -DLWS_WITH_CGI:BOOL=OFF
      -DLWS_WITH_CONMON:BOOL=ON
      -DLWS_WITH_CUSTOM_HEADERS:BOOL=ON
      -DLWS_WITH_DISKCACHE:BOOL=OFF
      -DLWS_WITH_DISTRO_RECOMMENDED:BOOL=OFF
      -DLWS_WITH_DRIVERS:BOOL=OFF
      -DLWS_WITH_ESP32:BOOL=OFF
      -DLWS_WITH_EVLIB_PLUGINS:BOOL=OFF
      -DLWS_WITH_EXPORT_LWSTARGETS:BOOL=ON
      -DLWS_WITH_EXTERNAL_POLL:BOOL=ON
      -DLWS_WITH_FANALYZER:BOOL=OFF
      -DLWS_WITH_FILE_OPS:BOOL=ON
      -DLWS_WITH_FSMOUNT:BOOL=ON
      -DLWS_WITH_FTS:BOOL=OFF
      -DLWS_WITH_GCOV:BOOL=OFF
      -DLWS_WITH_GENCRYPTO:BOOL=OFF
      -DLWS_WITH_GLIB:BOOL=OFF
      -DLWS_WITH_GTK:BOOL=OFF
      -DLWS_WITH_HTTP2:BOOL=${WITH_HTTP2}
      -DLWS_WITH_HTTP_BASIC_AUTH:BOOL=ON
      -DLWS_WITH_HTTP_BROTLI:BOOL=ON
      -DLWS_WITH_HTTP_PROXY:BOOL=ON
      -DLWS_WITH_HTTP_STREAM_COMPRESSION:BOOL=ON
      -DLWS_WITH_HTTP_UNCOMMON_HEADERS:BOOL=ON
      -DLWS_WITH_HUBBUB:BOOL=OFF
      #-DLWS_WITH_LEJP:BOOL=ON
      #-DLWS_WITH_LEJP_CONF:BOOL=OFF
      -DLWS_WITH_LIBEV:BOOL=OFF
      -DLWS_WITH_LIBEVENT:BOOL=OFF
      -DLWS_WITH_LIBUV:BOOL=OFF
      -DLWS_WITH_LWSAC:BOOL=ON
      -DLWS_WITH_LWSWS:BOOL=OFF
      -DLWS_WITH_LWS_DSH:BOOL=OFF
      -DLWS_WITH_MINIMAL_EXAMPLES:BOOL=OFF
      -DLWS_WITH_MINIZ:BOOL=OFF
      -DLWS_WITH_NETLINK:BOOL=ON
      -DLWS_WITH_NO_LOGS:BOOL=OFF
      -DLWS_WITH_PEER_LIMITS:BOOL=OFF
      -DLWS_WITH_PLUGINS:BOOL=ON
      -DLWS_WITH_PLUGINS_API:BOOL=OFF
      -DLWS_WITH_SDEVENT:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS_AUTH_SIGV4:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS_CPP:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS_PROXY_API:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS_STATIC_POLICY_ONLY:BOOL=OFF
      -DLWS_WITH_SECURE_STREAMS_SYS_AUTH_API_AMAZON_COM:BOOL=OFF
      -DLWS_WITH_SELFTESTS:BOOL=ON
      -DLWS_WITH_SEQUENCER:BOOL=OFF
      -DLWS_WITH_SHARED:BOOL=OFF
      -DLWS_WITH_SOCKS5:BOOL=ON
      -DLWS_WITH_SPAWN:BOOL=OFF
      -DLWS_WITH_SQLITE3:BOOL=OFF
      -DLWS_WITH_STATIC:BOOL=ON
      -DLWS_WITH_STRUCT_JSON:BOOL=OFF
      -DLWS_WITH_STRUCT_SQLITE3:BOOL=OFF
      -DLWS_WITH_SUL_DEBUGGING:BOOL=OFF
      -DLWS_WITH_SYS_ASYNC_DNS:BOOL=ON
      -DLWS_WITH_SYS_DHCP_CLIENT:BOOL=OFF
      -DLWS_WITH_SYS_FAULT_INJECTION:BOOL=OFF
      -DLWS_WITH_SYS_METRICS:BOOL=OFF
      -DLWS_WITH_SYS_NTPCLIENT:BOOL=OFF
      -DLWS_WITH_SYS_SMD:BOOL=ON
      -DLWS_WITH_SYS_STATE:BOOL=ON
      -DLWS_WITH_THREADPOOL:BOOL=ON
      -DLWS_WITH_TLS_SESSIONS:BOOL=ON
      -DLWS_WITH_UDP:BOOL=ON
      -DLWS_WITH_ULOOP:BOOL=OFF
      -DLWS_WITH_UNIX_SOCK:BOOL=ON
      -DLWS_WITH_ZIP_FOPS:BOOL=ON
      -DLWS_WITH_ZLIB:BOOL=ON
    CMAKE_CACHE_ARGS
      ${LIBWEBSOCKETS_ARGS}
      -DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON
      -DLWS_HAVE_LIBCAP:BOOL=FALSE
      -DLWS_WITH_PLUGINS_API:BOOL=${LWS_WITH_PLUGINS_API}
      -DLWS_WITH_PLUGINS:BOOL=${LWS_WITH_PLUGINS}
      -DLWS_WITH_PLUGINS_BUILTIN:BOOL=${LWS_WITH_PLUGINS_BUILTIN}
      #"-DLWS_HAVE_X509_VERIFY_PARAM_set1_host:STRING=1"
      #"-DLWS_HAVE_X509_VERIFY_PARAM_set1_host_sym:STRING=1"
    INSTALL_COMMAND ""
    #LOG_DOWNLOAD ON
    USES_TERMINAL_DOWNLOAD ON
    #LOG_CONFIGURE ON
    USES_TERMINAL_CONFIGURE ON
    #LOG_BUILD ON
    USES_TERMINAL_BUILD ON
    #LOG_OUTPUT_ON_FAILURE ON
  )
  # ExternalProject_Get_Property("${TARGET}" CMAKE_CACHE_DEFAULT_ARGS)
  #message("CMAKE_CACHE_DEFAULT_ARGS of libwebsockets = ${CMAKE_CACHE_DEFAULT_ARGS}")

  #link_directories("${CMAKE_CURRENT_BINARY_DIR}/libwebsockets/lib")

  if(ARGN)
    ExternalProject_Add_StepDependencies("${TARGET}" build ${ARGN})
  endif(ARGN)

  # What the rest of the project links against must be the PIC variant, which
  # the shared module needs, even though the non-PIC build runs last.
  foreach(v ${LWS_DEP_VARS})
    if(LWS_BUILD_PIC)
      if(DEFINED ${v})
        set(LWS_PIC_${v} "${${v}}")
        set(LWS_PIC_${v}_DEFINED TRUE)
      else()
        set(LWS_PIC_${v}_DEFINED FALSE)
      endif()
      set(LWS_HAVE_PIC_DEPS TRUE)
    elseif(LWS_HAVE_PIC_DEPS)
      if(LWS_PIC_${v}_DEFINED)
        set(${v} "${LWS_PIC_${v}}")
      else()
        unset(${v})
      endif()
    endif()
  endforeach(v)

endmacro()
