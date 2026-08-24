# transform_search.cmake
file(READ "${SRC}" _CONTENT)
string(REPLACE "'./lib/fetch.js'" "'fetch'" _CONTENT "${_CONTENT}")
file(WRITE "${BIN}" "${_CONTENT}")
