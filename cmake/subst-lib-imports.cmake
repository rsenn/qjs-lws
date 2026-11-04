# strips the in-repo "../../lib/" prefix from import paths: the project's lib/
# files are installed dir-less into the QuickJS module dir, where they
# resolve as bare specifiers (e.g. '../../lib/serve.js' -> 'serve.js')
file(READ "${SRC}" _CONTENT)
string(REPLACE "'../../lib/" "'" _CONTENT "${_CONTENT}")
file(WRITE "${BIN}" "${_CONTENT}")
