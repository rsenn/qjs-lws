include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/QuickJSModule.cmake)

function(GENERATE_PRECOMPILED NAME)
  if(NOT NAME)
    set(NAME precompiled)
  endif()

  file(READ ${NAME}.js.cmake JS_CMAKE)
  string(REGEX REPLACE "[\n;]+" ";" LINES "${JS_CMAKE}")
  list(FILTER LINES INCLUDE REGEX "import.*")

  unset(IMPORTS)

  foreach(LINE ${LINES})
    string(REGEX REPLACE ".*{\\s*" "" LINE "${LINE}")
    string(REGEX REPLACE "\\s*}[^\\n]*from\\s* ['\"`]" ";" LINE "${LINE}")
    string(REGEX REPLACE "['\"`]\\s*;\?\\s*" "" LINE "${LINE}")

    list(GET LINE 0 IDS)
    list(GET LINE 1 MODULE)

    string(REGEX REPLACE "[ \t]+" "" IDS "${IDS}")
    
    list(APPEND IMPORTS "${MODULE}:${IDS}")
  endforeach()

  string(REGEX REPLACE "\.[^: ;]*:" "," EXPORTS "${IMPORTS}")
  string(REPLACE "," ";" EXPORTS "${EXPORTS}")

  list(FILTER EXPORTS INCLUDE REGEX "[A-Za-z0-9_]+")
  list(JOIN EXPORTS ",\n  " EXPORTS)

  file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/modules/${NAME}.js"
       "${JS_CMAKE}\n__lwsPrecompiledReady(\n  ${EXPORTS}\n);\n")

  compile_module(${NAME}.js -D lws.so -M fs)
endfunction()
