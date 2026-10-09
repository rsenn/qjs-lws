# apply_patches(<source-dir> <patch-dir>)
#
# Applies every <patch-dir>/*.patch to <source-dir>, in name order, at
# configure time - so that whatever probes the result (the lws compat
# checks) sees the patched tree.
#
# Each patch is all-or-nothing: `git apply --check` first, and a patch with
# any rejected hunk is skipped whole, never half-applied (no .rej files).
# A patch that is already in the tree (its reverse applies cleanly) is
# reported and left alone, so re-configuring is a no-op.
#
# Sets APPLY_PATCHES_APPLIED / _PRESENT / _REJECTED to the patch names.
function(apply_patches SOURCE_DIR PATCH_DIR)
  find_package(Git QUIET)
  file(GLOB PATCHES "${PATCH_DIR}/*.patch")
  list(SORT PATCHES)

  set(APPLIED "")
  set(PRESENT "")
  set(REJECTED "")

  if(NOT GIT_FOUND)
    message(STATUS "git not found - not applying patches from ${PATCH_DIR}")
  else()
    foreach(PATCH ${PATCHES})
      get_filename_component(NAME "${PATCH}" NAME)

      execute_process(COMMAND "${GIT_EXECUTABLE}" apply --check "${PATCH}"
                      WORKING_DIRECTORY "${SOURCE_DIR}" RESULT_VARIABLE FWD
                      OUTPUT_QUIET ERROR_VARIABLE FWD_ERR)
      if(FWD EQUAL 0)
        execute_process(COMMAND "${GIT_EXECUTABLE}" apply "${PATCH}"
                        WORKING_DIRECTORY "${SOURCE_DIR}" RESULT_VARIABLE RES
                        OUTPUT_QUIET ERROR_QUIET)
        if(RES EQUAL 0)
          list(APPEND APPLIED "${NAME}")
          continue()
        endif()
      endif()

      execute_process(COMMAND "${GIT_EXECUTABLE}" apply --reverse --check "${PATCH}"
                      WORKING_DIRECTORY "${SOURCE_DIR}" RESULT_VARIABLE REV
                      OUTPUT_QUIET ERROR_QUIET)
      if(REV EQUAL 0)
        list(APPEND PRESENT "${NAME}")
      else()
        list(APPEND REJECTED "${NAME}")
        string(STRIP "${FWD_ERR}" FWD_ERR)
        string(REPLACE "\n" ";" FWD_ERR "${FWD_ERR}")
        list(GET FWD_ERR 0 FWD_ERR)
        message(VERBOSE "patch ${NAME} rejected: ${FWD_ERR}")
      endif()
    endforeach()

    set(ROWS "")
    foreach(NAME ${APPLIED})
      list(APPEND ROWS "applied" "${NAME}")
    endforeach()
    foreach(NAME ${PRESENT})
      list(APPEND ROWS "present" "${NAME}")
    endforeach()
    foreach(NAME ${REJECTED})
      list(APPEND ROWS "rejected" "${NAME}")
    endforeach()
    if(ROWS)
      message_table("libwebsockets patches" ${ROWS})
    endif()
  endif()

  set(APPLY_PATCHES_APPLIED "${APPLIED}" PARENT_SCOPE)
  set(APPLY_PATCHES_PRESENT "${PRESENT}" PARENT_SCOPE)
  set(APPLY_PATCHES_REJECTED "${REJECTED}" PARENT_SCOPE)
endfunction()
