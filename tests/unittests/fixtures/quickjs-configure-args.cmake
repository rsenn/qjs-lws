# Run with cmake -P: prints the quickjs_configure_args() result, one line,
# for the CMAKE_CROSSCOMPILING / CMAKE_SYSTEM_NAME given as -D options.
include("${BUILDQUICKJS_CMAKE}")
quickjs_configure_args(ARGS "${CMAKE_CURRENT_LIST_DIR}")
message("ARGS=${ARGS}")
