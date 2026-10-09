# find_libcap()
#
# Looks for libcap and checks that the toolchain in use can actually compile
# against and link it (a host libcap found by find_library() is of no use to
# e.g. musl-gcc). Sets LIBCAP_FOUND, and when found LIBCAP_INCLUDE_DIR and
# LIBCAP_LIBRARY.
macro(find_libcap)
  include(CheckCSourceCompiles)

  set(LIBCAP_FOUND FALSE)

  find_path(LIBCAP_INCLUDE_DIR NAMES sys/capability.h)
  find_library(LIBCAP_LIBRARY NAMES cap)

  if(LIBCAP_INCLUDE_DIR AND LIBCAP_LIBRARY)
    set(old_REQUIRED_INCLUDES "${CMAKE_REQUIRED_INCLUDES}")
    set(old_REQUIRED_LIBRARIES "${CMAKE_REQUIRED_LIBRARIES}")
    set(CMAKE_REQUIRED_INCLUDES "${LIBCAP_INCLUDE_DIR}")
    set(CMAKE_REQUIRED_LIBRARIES "${LIBCAP_LIBRARY}")

    check_c_source_compiles(
      "#include <sys/capability.h>
       int main(void) { cap_t c = cap_init(); cap_free(c); return 0; }"
      LIBCAP_WORKS)

    set(CMAKE_REQUIRED_INCLUDES "${old_REQUIRED_INCLUDES}")
    set(CMAKE_REQUIRED_LIBRARIES "${old_REQUIRED_LIBRARIES}")

    if(LIBCAP_WORKS)
      set(LIBCAP_FOUND TRUE)
    endif(LIBCAP_WORKS)
  endif(LIBCAP_INCLUDE_DIR AND LIBCAP_LIBRARY)

  if(LIBCAP_FOUND)
    message(STATUS "\tLibcap library: ${LIBCAP_LIBRARY}")
    message(STATUS "\tLibcap include dir: ${LIBCAP_INCLUDE_DIR}")
  else(LIBCAP_FOUND)
    message(STATUS "\tLibcap not found")
  endif(LIBCAP_FOUND)
endmacro()
