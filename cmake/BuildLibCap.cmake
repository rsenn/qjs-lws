# build_libcap(BINARY SUFFIX PIC)
#
# Downloads and builds libcap (plain Makefile build, static library only) into
# ${BINARY}/deps-${SUFFIX}. Sets LIBCAP_INCLUDE_DIR_${SUFFIX} and
# LIBCAP_LIBRARY_FILE_${SUFFIX}; the ExternalProject target is libcap_${SUFFIX}.
# Source: https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/
macro(build_libcap BINARY SUFFIX PIC)
  include(ExternalProject)

  message("-- Building libcap from source (${SUFFIX}, PIC=${PIC})")

  set(LIBCAP_PREFIX_${SUFFIX} "${BINARY}/deps-${SUFFIX}")
  set(LIBCAP_INCLUDE_DIR_${SUFFIX} "${LIBCAP_PREFIX_${SUFFIX}}/include")
  set(LIBCAP_LIBRARY_FILE_${SUFFIX}
      "${LIBCAP_PREFIX_${SUFFIX}}/lib/${CMAKE_STATIC_LIBRARY_PREFIX}cap${CMAKE_STATIC_LIBRARY_SUFFIX}")

  set(LIBCAP_CFLAGS_${SUFFIX} "-O2")
  if(PIC)
    string(APPEND LIBCAP_CFLAGS_${SUFFIX} " -fPIC")
  endif(PIC)

  # The Makefile builds in its source tree, so build there (BUILD_IN_SOURCE).
  # BUILD_CC is the compiler for the build-time helper (mkcapshort) and has to
  # run on the host, hence plain "cc" rather than the cross compiler.
  set(LIBCAP_MAKE_${SUFFIX}
      make -C libcap "CC=${CMAKE_C_COMPILER}" BUILD_CC=cc
      "CFLAGS=${LIBCAP_CFLAGS_${SUFFIX}}" "prefix=${LIBCAP_PREFIX_${SUFFIX}}"
      lib=lib SHARED=no GOLANG=no PAM_CAP=no)

  ExternalProject_Add(
    libcap_${SUFFIX}
    URL https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.78.tar.xz
    DOWNLOAD_DIR ${BINARY}/downloads-${SUFFIX}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    BUILD_IN_SOURCE TRUE
    CONFIGURE_COMMAND ""
    BUILD_COMMAND ${LIBCAP_MAKE_${SUFFIX}}
    INSTALL_COMMAND ${LIBCAP_MAKE_${SUFFIX}} install-static
    BUILD_BYPRODUCTS "${LIBCAP_LIBRARY_FILE_${SUFFIX}}")
endmacro()
