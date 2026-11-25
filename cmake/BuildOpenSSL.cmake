# build_openssl(BINARY SUFFIX PIC)
#
# Downloads and builds OpenSSL from the newest release tarball
# (https://github.com/openssl/openssl/releases) as static libraries into
# ${BINARY}/deps-${SUFFIX}. Sets OPENSSL_INCLUDE_DIR_${SUFFIX},
# OPENSSL_LIBRARY_DIR_${SUFFIX}, OPENSSL_LIBRARIES_${SUFFIX} (ssl, crypto) and
# OPENSSL_PREFIX_${SUFFIX}; the ExternalProject target is openssl_${SUFFIX}.
set(OPENSSL_VERSION "4.1.0" CACHE STRING "OpenSSL release to build")
set(OPENSSL_URL "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
    CACHE STRING "OpenSSL release tarball")

macro(build_openssl BINARY SUFFIX PIC)
  include(ProcessorCount)
  ProcessorCount(_OSSL_JOBS)
  if(NOT _OSSL_JOBS)
    set(_OSSL_JOBS 1)
  endif()

  include(ExternalProject)

  message("-- Building OpenSSL ${OPENSSL_VERSION} from source (${SUFFIX}, PIC=${PIC})")

  set(OPENSSL_PREFIX_${SUFFIX} "${BINARY}/deps-${SUFFIX}")
  set(OPENSSL_INCLUDE_DIR_${SUFFIX} "${OPENSSL_PREFIX_${SUFFIX}}/include")
  set(OPENSSL_LIBRARY_DIR_${SUFFIX} "${OPENSSL_PREFIX_${SUFFIX}}/lib")
  set(OPENSSL_LIBRARIES_${SUFFIX}
      "${OPENSSL_LIBRARY_DIR_${SUFFIX}}/${CMAKE_STATIC_LIBRARY_PREFIX}ssl${CMAKE_STATIC_LIBRARY_SUFFIX}"
      "${OPENSSL_LIBRARY_DIR_${SUFFIX}}/${CMAKE_STATIC_LIBRARY_PREFIX}crypto${CMAKE_STATIC_LIBRARY_SUFFIX}")

  set(OPENSSL_CONFIGURE_FLAGS_${SUFFIX} no-shared no-tests no-docs no-apps no-dso)
  if(${PIC})
    list(APPEND OPENSSL_CONFIGURE_FLAGS_${SUFFIX} -fPIC)
  endif()
  # dietlibc: no <sys/syscall.h>-style extras, no threads library worth using
  if(DIET OR HAVE_DIETLIBC OR CMAKE_C_COMPILER MATCHES "diet")
    list(APPEND OPENSSL_CONFIGURE_FLAGS_${SUFFIX} no-threads no-secure-memory no-async no-ml-kem no-ml-dsa no-slh-dsa)
  endif()

  ExternalProject_Add(
    openssl_${SUFFIX}
    URL ${OPENSSL_URL}
    DOWNLOAD_DIR ${BINARY}/downloads-${SUFFIX}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    BUILD_IN_SOURCE TRUE
    CONFIGURE_COMMAND
      ${CMAKE_COMMAND} -E env "CC=${CMAKE_C_COMPILER}" <SOURCE_DIR>/Configure
      --prefix=${OPENSSL_PREFIX_${SUFFIX}} --libdir=lib ${OPENSSL_CONFIGURE_FLAGS_${SUFFIX}}
    # --trace prints every command, -j builds in parallel, MAKEFLAGS= drops the -s of the outer CMake makefile
    BUILD_COMMAND ${CMAKE_COMMAND} -E env MAKEFLAGS= make -j${_OSSL_JOBS} --trace build_libs
    USES_TERMINAL_CONFIGURE TRUE
    USES_TERMINAL_BUILD TRUE
    INSTALL_COMMAND make install_dev
    BUILD_BYPRODUCTS ${OPENSSL_LIBRARIES_${SUFFIX}})
endmacro()
