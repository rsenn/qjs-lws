# build_brotli(BINARY SUFFIX PIC)
#
# Downloads and builds brotli as static libraries into ${BINARY}/deps-${SUFFIX}.
# Sets BROTLI_INCLUDE_DIR_${SUFFIX} and BROTLI_LIBRARIES_${SUFFIX} (full paths
# of enc, dec, common); the ExternalProject target is brotli_${SUFFIX}.
macro(build_brotli BINARY SUFFIX PIC)
  include(ExternalProject)

  message("-- Building brotli from source (${SUFFIX}, PIC=${PIC})")

  set(BROTLI_PREFIX_${SUFFIX} "${BINARY}/deps-${SUFFIX}")
  set(BROTLI_INCLUDE_DIR_${SUFFIX} "${BROTLI_PREFIX_${SUFFIX}}/include")
  set(BROTLI_LIBRARIES_${SUFFIX})
  foreach(_brotli_lib brotlienc brotlidec brotlicommon)
    list(APPEND BROTLI_LIBRARIES_${SUFFIX}
         "${BROTLI_PREFIX_${SUFFIX}}/lib/${CMAKE_STATIC_LIBRARY_PREFIX}${_brotli_lib}${CMAKE_STATIC_LIBRARY_SUFFIX}")
  endforeach(_brotli_lib)

  ExternalProject_Add(
    brotli_${SUFFIX}
    URL https://github.com/google/brotli/archive/refs/tags/v1.2.0.tar.gz
    DOWNLOAD_DIR ${BINARY}/downloads-${SUFFIX}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    BINARY_DIR ${BINARY}/brotli-${SUFFIX}
    CMAKE_CACHE_ARGS
      "-DCMAKE_INSTALL_PREFIX:PATH=${BROTLI_PREFIX_${SUFFIX}}"
      "-DCMAKE_INSTALL_LIBDIR:PATH=lib"
      "-DCMAKE_C_COMPILER:FILEPATH=${CMAKE_C_COMPILER}"
      "-DCMAKE_SYSROOT:PATH=${CMAKE_SYSROOT}"
      "-DCMAKE_TOOLCHAIN_FILE:FILEPATH=${CMAKE_TOOLCHAIN_FILE}"
      "-DCMAKE_C_FLAGS:STRING=-w"
      "-DCMAKE_VERBOSE_MAKEFILE:BOOL=${CMAKE_VERBOSE_MAKEFILE}"
      "-DCMAKE_BUILD_TYPE:STRING=${CMAKE_BUILD_TYPE}"
      "-DCMAKE_POSITION_INDEPENDENT_CODE:BOOL=${PIC}"
      "-DBUILD_SHARED_LIBS:BOOL=OFF"
      "-DBROTLI_DISABLE_TESTS:BOOL=ON"
      "-DBROTLI_BUILD_TOOLS:BOOL=OFF"
    BUILD_BYPRODUCTS ${BROTLI_LIBRARIES_${SUFFIX}})
endmacro()
