macro(find_brotli)
  if(NOT PKG_CONFIG_FOUND)
    include(FindPkgConfig)
  endif(NOT PKG_CONFIG_FOUND)
  message(STATUS "Finding brotli library...")
  pkg_search_module(BROTLIDEC libbrotlidec brotlidec QUIET)
  pkg_search_module(BROTLIENC libbrotlienc brotlienc QUIET)
  pkg_search_module(BROTLICOMMON libbrotlicommon brotlicommon QUIET)

  if(NOT BROTLICOMMON_FOUND OR "${BROTLICOMMON_FOUND}" STREQUAL "")

    find_library(BROTLIDEC_LIBRARY NAMES brotlidec CMAKE_FIND_ROOT_PATH_BOTH)
    find_library(BROTLIENC_LIBRARY NAMES brotlienc CMAKE_FIND_ROOT_PATH_BOTH)
    find_library(BROTLICOMMON_LIBRARY NAMES brotlicommon
                 CMAKE_FIND_ROOT_PATH_BOTH)
    if(BROTLIDEC_LIBRARY AND BROTLIENC_LIBRARY AND BROTLICOMMON_LIBRARY)
      set(BROTLI_FOUND TRUE)
      set(BROTLI_LIBRARY ${BROTLIDEC_LIBRARY} ${BROTLIENC_LIBRARY}
                         ${BROTLICOMMON_LIBRARY})

    endif(BROTLIDEC_LIBRARY AND BROTLIENC_LIBRARY AND BROTLICOMMON_LIBRARY)

  endif(NOT BROTLICOMMON_FOUND OR "${BROTLICOMMON_FOUND}" STREQUAL "")

  if(BROTLICOMMON_FOUND OR BROTLI_FOUND)

    set(BROTLI_LIBRARY "")
    if(pkgcfg_lib_BROTLIENC_brotlienc AND EXISTS
                                          "${pkgcfg_lib_BROTLIENC_brotlienc}")
      list(APPEND BROTLI_LIBRARY "${pkgcfg_lib_BROTLIENC_brotlienc}")
    endif(pkgcfg_lib_BROTLIENC_brotlienc
          AND EXISTS "${pkgcfg_lib_BROTLIENC_brotlienc}")
    if(pkgcfg_lib_BROTLIENC_brotlidec AND EXISTS
                                          "${pkgcfg_lib_BROTLIENC_brotlidec}")
      list(APPEND BROTLI_LIBRARY "${pkgcfg_lib_BROTLIENC_brotlidec}")
    endif(pkgcfg_lib_BROTLIENC_brotlidec
          AND EXISTS "${pkgcfg_lib_BROTLIENC_brotlidec}")
    if(pkgcfg_lib_BROTLIENC_brotlicommon
       AND EXISTS "${pkgcfg_lib_BROTLIENC_brotlicommon}")
      list(APPEND BROTLI_LIBRARY "${pkgcfg_lib_BROTLIENC_brotlicommon}")
    endif(pkgcfg_lib_BROTLIENC_brotlicommon
          AND EXISTS "${pkgcfg_lib_BROTLIENC_brotlicommon}")

    set(BROTLI_LINK_LIBRARY
        ${pkgcfg_lib_BROTLIENC_brotlienc} ${pkgcfg_lib_BROTLIDEC_brotlidec}
        ${pkgcfg_lib_BROTLICOMMON_brotlicommon})
    set(BROTLI_LIBRARY_DIR ${BROTLICOMMON_LIBRARY_DIRS})
    set(BROTLI_FOUND TRUE)
  endif(BROTLICOMMON_FOUND OR BROTLI_FOUND)

  # a .pc file written for another prefix (MSYS2's /mingw64) names directories that are not
  # here: then the headers and libraries are looked up in the toolchain's own directories
  if(BROTLI_FOUND AND BROTLICOMMON_INCLUDE_DIRS)
    set(_BROTLI_INC_OK FALSE)
    foreach(_dir ${BROTLICOMMON_INCLUDE_DIRS})
      if(EXISTS "${_dir}/brotli/encode.h")
        set(_BROTLI_INC_OK TRUE)
      endif(EXISTS "${_dir}/brotli/encode.h")
    endforeach(_dir)

    if(NOT _BROTLI_INC_OK)
      find_path(BROTLI_TOOLCHAIN_INCLUDE_DIR NAMES brotli/encode.h)
      set(_libs "")
      foreach(_name brotlienc brotlidec brotlicommon)
        find_library(BROTLI_TOOLCHAIN_${_name} NAMES ${_name})
        if(BROTLI_TOOLCHAIN_${_name})
          list(APPEND _libs "${BROTLI_TOOLCHAIN_${_name}}")
        endif(BROTLI_TOOLCHAIN_${_name})
      endforeach(_name)

      list(LENGTH _libs _count)
      if(BROTLI_TOOLCHAIN_INCLUDE_DIR AND _count EQUAL 3)
        list(GET _libs 0 _first)
        get_filename_component(_libdir "${_first}" DIRECTORY)
        set(BROTLICOMMON_INCLUDE_DIRS "${BROTLI_TOOLCHAIN_INCLUDE_DIR}")
        set(BROTLICOMMON_LIBRARY_DIRS "${_libdir}")
        set(BROTLI_INCLUDE_DIR "${BROTLI_TOOLCHAIN_INCLUDE_DIR}" CACHE PATH "Brotli include dir" FORCE)
        set(BROTLI_LIBRARIES "${_libs}" CACHE PATH "Brotli libraries" FORCE)
        set(BROTLI_LIBRARY_DIR "${_libdir}" CACHE PATH "Brotli library dir" FORCE)
      else()
        set(BROTLI_FOUND FALSE)
      endif()
    endif(NOT _BROTLI_INC_OK)
  endif(BROTLI_FOUND AND BROTLICOMMON_INCLUDE_DIRS)

  if(NOT BROTLI_INCLUDE_DIR AND BROTLICOMMON_INCLUDE_DIRS)
    set(BROTLI_INCLUDE_DIR "${BROTLICOMMON_INCLUDE_DIRS}"
        CACHE PATH "Brotli include dir")
  endif(NOT BROTLI_INCLUDE_DIR AND BROTLICOMMON_INCLUDE_DIRS)

  if(NOT BROTLI_LIBRARIES)
    if(BROTLICOMMON_LIBRARY)
      set(BROTLI_LIBRARIES
          "${BROTLIENC_LIBRARY};${BROTLIDEC_LIBRARY};${BROTLICOMMON_LIBRARY}"
          CACHE PATH "Brotli libraries")
    else(BROTLICOMMON_LIBRARY)
      set(BROTLI_LIBRARIES "brotlienc;brotlidec;brotlicommon"
          CACHE PATH "Brotli libraries")
    endif(BROTLICOMMON_LIBRARY)
  endif(NOT BROTLI_LIBRARIES)

  if(NOT BROTLI_LIBRARY_DIR AND BROTLICOMMON_LIBRARY_DIRS)
    set(BROTLI_LIBRARY_DIR "${BROTLICOMMON_LIBRARY_DIRS}"
        CACHE PATH "Brotli library dir")
  endif(NOT BROTLI_LIBRARY_DIR AND BROTLICOMMON_LIBRARY_DIRS)

endmacro()
