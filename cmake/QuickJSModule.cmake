if(NOT PRECOMPILED_MODULE_DIR)
  set(PRECOMPILED_MODULE_DIR "modules/" CACHE PATH "subdirectory of build directory for precompiled .js modules")
endif(NOT PRECOMPILED_MODULE_DIR)

function(module_path NAME OUTVAR)
  cmake_path(SET OUTNAME "${CMAKE_CURRENT_BINARY_DIR}")
  cmake_path(APPEND OUTNAME ${PRECOMPILED_MODULE_DIR})
  file(MAKE_DIRECTORY "${OUTNAME}")
  cmake_path(APPEND OUTNAME "${NAME}")

  set(${OUTVAR} "${OUTNAME}" PARENT_SCOPE)
endfunction(module_path NAME)

function(config_module TARGET_NAME)
  if(QUICKJS_LIBRARY_DIR)
    set_target_properties(${TARGET_NAME} PROPERTIES LINK_DIRECTORIES "${QUICKJS_LIBRARY_DIR}")
  endif(QUICKJS_LIBRARY_DIR)
  if(QUICKJS_MODULE_DEPENDENCIES)
    target_link_libraries(${TARGET_NAME} ${QUICKJS_MODULE_DEPENDENCIES})
  endif(QUICKJS_MODULE_DEPENDENCIES)
  if(QUICKJS_MODULE_CFLAGS)
    target_compile_options(${TARGET_NAME} PRIVATE "${QUICKJS_MODULE_CFLAGS}")
  endif(QUICKJS_MODULE_CFLAGS)
endfunction(config_module TARGET_NAME)

##
## compile_module SOURCE
##
function(compile_module SOURCE)
  basename(BASE "${SOURCE}" .js)

  module_path("${SOURCE}" INPUT_FILE)
  module_path("${BASE}.c" OUTPUT_FILE)

  list(APPEND COMPILED_MODULES "${OUTPUT_FILE}")
  list(APPEND COMPILED_TARGETS "${BASE}.c")

  set(COMPILED_MODULES "${COMPILED_MODULES}" PARENT_SCOPE)
  set(COMPILED_TARGETS "${COMPILED_TARGETS}" PARENT_SCOPE)

  file(RELATIVE_PATH INFILE "${CMAKE_CURRENT_BINARY_DIR}" "${INPUT_FILE}")
  file(RELATIVE_PATH OUTFILE "${CMAKE_CURRENT_BINARY_DIR}" "${OUTPUT_FILE}")

  message(STATUS "Compile QuickJS module '${OUTFILE}' from '${INFILE}'")

  add_custom_target(
    "${BASE}.c" ALL BYPRODUCTS "${OUTFILE}" COMMAND "${QJSC}" -v -c -o "${OUTFILE}" -m "${INFILE}" ${ARGN}
    DEPENDS ${QJSC_DEPS} ${INFILE} WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUTFILE} from ${INFILE} using qjs compiler" SOURCES "${INFILE}")
endfunction(compile_module SOURCE)

##
## generate_module_header SOURCE
##
function(generate_module_header SOURCE)
  basename(BASE "${SOURCE}" .c)
  string(REGEX REPLACE "\\.c$" ".h" HEADER "${SOURCE}")
  string(REGEX REPLACE "-" "_" NAME "${BASE}")

  #message("generate_module_header SOURCE=${SOURCE}")

  file(READ "${SOURCE}" CSRC)
  string(REGEX MATCHALL "qjsc_[0-9A-Za-z_]+" SYMBOLS "${CSRC}")
  list(FILTER SYMBOLS EXCLUDE REGEX "_size$")
  list(FILTER SYMBOLS EXCLUDE REGEX "^\\s*$")
  string(REGEX REPLACE "qjsc_" "" SYMBOLS "${SYMBOLS}")
  set(S "#include <inttypes.h>\n")
  set(INCLUDES "${ARGN}")

  foreach(INCLUDE ${INCLUDES})
    string(STRIP "${INCLUDE}" INCLUDE)
    string(REGEX REPLACE "_" "-" FNAME "${INCLUDE}")
    if(NOT FNAME MATCHES "\\.h$")
      set(FNAME "${INCLUDE}.h")
    endif(NOT FNAME MATCHES "\\.h$")
    set(S "${S}#include \"${FNAME}\"\n")
  endforeach(INCLUDE ${INCLUDES})

  foreach(NAME ${SYMBOLS})
    contains(INCLUDES "${NAME}" DOES_CONTAIN)
    #message(" contains(INCLUDES \"${NAME}\" DOES_CONTAIN) = ${DOES_CONTAIN}")
    if(NOT DOES_CONTAIN)
      set(S "${S}\nextern const uint32_t qjsc_${NAME}_size;\nextern const uint8_t qjsc_${NAME}[];\n")
    endif(NOT DOES_CONTAIN)
  endforeach(NAME ${SYMBOLS})

  module_path(${BASE} OUTFILE)

  file(WRITE "${OUTFILE}.h" "${S}")

  dump(SYMBOLS)
endfunction(generate_module_header SOURCE)

##
## make_module_header SOURCE
##
function(make_module_header SOURCE)
  string(REGEX REPLACE "\\.tmp$" "" BASE2 "${SOURCE}")
  basename(BASE "${BASE2}" .c)
  string(REGEX REPLACE "\\.c$" ".h" HEADER "${BASE2}")
  string(REGEX REPLACE "-" "_" NAME "${BASE}")
  set(SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/gen-${BASE}-header.cmake")

  make_script("${SCRIPT}" "message(\"Generating module '${NAME}'\")\nremake_module(${SOURCE})\n"
              "${CMAKE_CURRENT_SOURCE_DIR}/cmake/functions.cmake;${CMAKE_CURRENT_SOURCE_DIR}/cmake/QuickJSModule.cmake")

  add_custom_target(${BASE}.h ALL ${CMAKE_COMMAND} -P ${SCRIPT} DEPENDS ${SOURCE} BYPRODUCTS ${HEADER}
                    SOURCES ${SOURCE})
endfunction(make_module_header SOURCE)

##
## list_definitions SOURCE OUTVAR
##
function(list_definitions SOURCE OUTVAR)
  file(READ "${SOURCE}" CSRC)
  string(REGEX MATCHALL "qjsc_[0-9A-Za-z_]+" SYMBOLS "${CSRC}")
  list(FILTER SYMBOLS EXCLUDE REGEX "_size$")
  string(REGEX REPLACE "qjsc_" "" SYMBOLS "${SYMBOLS}")
  set(S "")

  foreach(DEF ${SYMBOLS})
    if(ARGN AND NOT "${DEF}" STREQUAL "${ARGN}")
      list(APPEND S "${DEF}")
    endif(ARGN AND NOT "${DEF}" STREQUAL "${ARGN}")
  endforeach(DEF ${SYMBOLS})

  set("${OUTVAR}" "${S}" PARENT_SCOPE)
endfunction(list_definitions SOURCE OUTVAR)

##
## include_definitions OUTVAR
##
function(include_definitions OUTVAR)
  set(S "")

  foreach(DEF ${ARGN})
    string(STRIP "${DEF}" DEF)
    string(REGEX REPLACE "_" "-" NAME "${DEF}")
    set(S "${S}#include \"${NAME}.h\"\n")
  endforeach(DEF ${ARGN})

  set("${OUTVAR}" "${S}" PARENT_SCOPE)
endfunction(include_definitions OUTVAR)

##
## extract_definition SOURCE OUTVAR DEF
##
function(extract_definition SOURCE OUTVAR DEF)
  basename(BASE "${SOURCE}" .c)
  file(READ "${SOURCE}" CSRC)
  string(REGEX MATCHALL "const[^\n;]*qjsc_${DEF}[[_][^;]*;" DEFINITIONS "${CSRC}")
  string(REPLACE "\n" "\\n" DEFINITIONS "${DEFINITIONS}")
  string(REGEX REPLACE ";\\s*;*" ";" DEFINITIONS "${DEFINITIONS}")
  string(REGEX REPLACE ";;" ";" DEFINITIONS "${DEFINITIONS}")
  string(REGEX REPLACE "\n" ";\n" DEFINITIONS "${DEFINITIONS}")
  string(REGEX REPLACE ";;*" ";" DEFINITIONS "${DEFINITIONS}")
  set(S "")

  foreach(LINE ${DEFINITIONS})
    if(S STREQUAL "")
      set(S "${LINE};")
    else(S STREQUAL "")
      set(S "${S}\n\n${LINE};")
    endif(S STREQUAL "")
  endforeach(LINE ${DEFINITIONS})

  string(REGEX REPLACE "\\\\n" "\\n" S "${S}")
  set("${OUTVAR}" "${S}\n" PARENT_SCOPE)
endfunction(extract_definition SOURCE OUTVAR DEF)

##
## remake_module SOURCE
##
function(remake_module SOURCE)
  basename(BASE "${SOURCE}" .c)
  string(REGEX REPLACE "-" "_" NAME "${BASE}")

  list_definitions("${SOURCE}" DEFLIST ${NAME})
  list(REMOVE_ITEM DEFLIST "${NAME}")
  list(REMOVE_ITEM DEFLIST "${BASE}")
  list(FILTER DEFLIST EXCLUDE REGEX "^${NAME}$")
  list(FILTER DEFLIST EXCLUDE REGEX "^${BASE}$")

  #print_str("Included definitions in ${NAME}: ${DEFLIST}")

  include_definitions(INC "${DEFLIST}")

  extract_definition("${SOURCE}" DEF "${NAME}")

  module_path(${BASE} OUTFILE)

  file(WRITE "${OUTFILE}.c" "#include \"${OUTFILE}.h\"\n\n${DEF}")
  generate_module_header(${SOURCE} ${DEFLIST})

endfunction(remake_module SOURCE)

##
## make_script OUTPUT_FILE TEXT INCLUDES
##
function(make_script OUTPUT_FILE TEXT INCLUDES)
  basename(BASE "${SOURCE}" .c)
  string(REGEX REPLACE "\\.c$" ".h" HEADER "${SOURCE}")
  string(REGEX REPLACE "-" "_" NAME "${BASE}")
  set(S "cmake_policy(SET CMP0007 NEW)\n")

  foreach(INC ${INCLUDES})
    set(S "${S}\ninclude(${INC})\n")
  endforeach(INC ${INCLUDES})

  set(S "${S}\n\n${TEXT}\n")
  file(WRITE "${OUTPUT_FILE}" "${S}")
endfunction(make_script OUTPUT_FILE TEXT INCLUDES)

##
## make_module FNAME
##
function(make_module FNAME)
  string(REGEX REPLACE "_" "-" NAME "${FNAME}")
  string(REGEX REPLACE "-" "_" VNAME "${FNAME}")
  string(TOUPPER "${FNAME}" UUNAME)
  string(REGEX REPLACE "-" "_" UNAME "${UUNAME}")

  set(TARGET_NAME qjs-${NAME})
  set(DEPS ${${VNAME}_DEPS})
  set(LIBS ${${VNAME}_LIBRARIES})

  if(ARGN)
    set(SOURCES ${ARGN} #${${VNAME}_SOURCES}
                ${COMMON_SOURCES})
    add_unique(DEPS ${${VNAME}_DEPS})
  else(ARGN)
    set(SOURCES quickjs-${NAME}.c #${${VNAME}_SOURCES}
                ${COMMON_SOURCES})
    add_unique(LIBS ${${VNAME}_LIBRARIES})
  endif(ARGN)
  add_unique(LIBS ${COMMON_LIBRARIES})

  message(STATUS "Building QuickJS module: ${FNAME} (deps: ${DEPS}, libs: ${LIBS}) JS_${UNAME}_MODULE=1")

  if(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(BUILD_SHARED_MODULES OFF)
  endif(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

  if(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(PREFIX "lib")
  else(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(PREFIX "")
  endif(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

  #dump(VNAME ${VNAME}_SOURCES SOURCES)

  if(BUILD_SHARED_MODULES)
    #add_library(${TARGET_NAME} MODULE ${SOURCES})
    add_library(${TARGET_NAME} SHARED ${SOURCES})

    set_target_properties(
      ${TARGET_NAME}
      PROPERTIES RPATH "${MBEDTLS_LIBRARY_DIR}:${QUICKJS_C_MODULE_DIR}" INSTALL_RPATH "${QUICKJS_C_MODULE_DIR}"
                 PREFIX "${PREFIX}" OUTPUT_NAME "${VNAME}" COMPILE_FLAGS "${MODULE_COMPILE_FLAGS}")

    target_compile_definitions(${TARGET_NAME} PRIVATE _GNU_SOURCE=1 JS_SHARED_LIBRARY=1 JS_${UNAME}_MODULE=1
                                                      QUICKJS_PREFIX="${QUICKJS_INSTALL_PREFIX}")

    target_link_directories(${TARGET_NAME} PUBLIC "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(${TARGET_NAME} PUBLIC ${LIBS} ${QUICKJS_LIBRARY})

    install(TARGETS ${TARGET_NAME}
            RUNTIME DESTINATION "${QUICKJS_C_MODULE_DIR}" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ
                                                                      GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)

    config_module(${TARGET_NAME})

    set(LIBRARIES ${${VNAME}_LIBRARIES})
    if(LIBRARIES)
      target_link_libraries(${TARGET_NAME} PRIVATE ${LIBRARIES})
    endif(LIBRARIES)
    if(DEPS)
      add_dependencies(${TARGET_NAME} ${DEPS})
    endif(DEPS)

  endif(BUILD_SHARED_MODULES)

  add_library(${TARGET_NAME}-static STATIC ${SOURCES})

  set(MODULES_STATIC "${QJS_MODULES_STATIC}")
  list(APPEND MODULES_STATIC "${TARGET_NAME}-static")
  set(QJS_MODULES_STATIC "${MODULES_STATIC}" PARENT_SCOPE)

  set_target_properties(${TARGET_NAME}-static
                        PROPERTIES OUTPUT_NAME "${VNAME}" PREFIX "quickjs-" SUFFIX "${LIBRARY_SUFFIX}" COMPILE_FLAGS "")
  target_compile_definitions(${TARGET_NAME}-static PRIVATE _GNU_SOURCE=1 JS_${UNAME}_MODULE=1
                                                           QUICKJS_PREFIX="${QUICKJS_INSTALL_PREFIX}")
  target_link_directories(${TARGET_NAME}-static PUBLIC "${CMAKE_CURRENT_BINARY_DIR}")
  target_link_libraries(${TARGET_NAME}-static INTERFACE ${QUICKJS_LIBRARY})
endfunction()

if(WASI OR EMSCRIPTEN)
  set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
  option(BUILD_SHARED_MODULES "Build shared modules" OFF)
else(WASI OR EMSCRIPTEN)
  option(BUILD_SHARED_MODULES "Build shared modules" ON)
endif(WASI OR EMSCRIPTEN)

if(WIN32 OR MINGW)
  set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS TRUE)
endif(WIN32 OR MINGW)

if(WASI OR WASM OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
  set(LIBRARY_PREFIX "lib")
  set(LIBRARY_SUFFIX ".a")
endif(WASI OR WASM OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

if(NOT LIBRARY_PREFIX)
  set(LIBRARY_PREFIX "${CMAKE_STATIC_LIBRARY_PREFIX}")
endif(NOT LIBRARY_PREFIX)
if(NOT LIBRARY_SUFFIX)
  set(LIBRARY_SUFFIX "${CMAKE_STATIC_LIBRARY_SUFFIX}")
endif(NOT LIBRARY_SUFFIX)

##
## generate_precompiled NAME
##
## parses a JS script with import statements and collects all identifiers from them
##
function(parse_jsimports FILENAME OUTVAR)
  file(READ "${FILENAME}" DATA)
  string(REGEX REPLACE "[\n;]+" ";" LINES "${DATA}")
  list(FILTER LINES INCLUDE REGEX "import.*")

  unset(IMPORTS)

  foreach(LINE ${LINES})
    string(REGEX REPLACE ".*{\\s*" "" LINE "${LINE}")
    string(REGEX REPLACE "\\s*}[^\\n]*from\\s* ['\"`]" ";" LINE "${LINE}")
    string(REGEX REPLACE "['\"`]\\s*;\?\\s*" "" LINE "${LINE}")

    list(GET LINE 0 IDS)
    list(GET LINE 1 MODULE)

    string(REGEX REPLACE "[ \t]+" "" IDS "${IDS}")

    message("Import module: ${MODULE}, specifiers: ${IDS}")

    list(APPEND IMPORTS "${MODULE}:${IDS}")
  endforeach()

  set(${OUTVAR} "${IMPORTS}" PARENT_SCOPE)
endfunction(parse_jsimports FILENAME OUTVAR)

##
## generate_precompiled NAME
##
## parses a JS script with import statements and collects all identifiers from them
##
function(get_jsimport_specifiers IMPORTS OUTVAR)
  string(REGEX REPLACE "\.[^: ;]*:" "," SPECIFIERS "${IMPORTS}")
  string(REPLACE "," ";" SPECIFIERS "${SPECIFIERS}")

  list(FILTER SPECIFIERS INCLUDE REGEX "[A-Za-z0-9_]+")

  set(${OUTVAR} "${SPECIFIERS}" PARENT_SCOPE)
endfunction(get_jsimport_specifiers IMPORTS OUTVAR)

##
## generate_precompiled NAME
##
## parses a JS script with import statements and collects all identifiers from them
##
function(generate_precompiled_js NAME)
  module_path("${NAME}" OUTPUT_FILE)

  set(INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/${NAME}.cmake")

  string(REGEX REPLACE "[^A-Za-z0-9_]" "_" CMAKE_FILE "generate_${NAME}")

  file(RELATIVE_PATH IN "${CMAKE_CURRENT_BINARY_DIR}" "${INPUT_FILE}")
  file(RELATIVE_PATH OUT "${CMAKE_CURRENT_BINARY_DIR}" "${OUTPUT_FILE}")
  file(RELATIVE_PATH INCLUDEDIR "${CMAKE_CURRENT_BINARY_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

  file(RELATIVE_PATH LIBDIR "${CMAKE_CURRENT_BINARY_DIR}/modules" "${CMAKE_CURRENT_SOURCE_DIR}/lib")
  file(CREATE_LINK "${LIBDIR}" "${CMAKE_CURRENT_BINARY_DIR}/modules/lib" COPY_ON_ERROR SYMBOLIC)

  file(
    GENERATE
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_FILE}.cmake"
    CONTENT
      "include(${INCLUDEDIR}/QuickJSModule.cmake)

parse_jsimports(${IN} JSIMPORTS)
get_jsimport_specifiers(\"\${JSIMPORTS}\" SPECIFIERS)

string(REGEX REPLACE \";\" \", \" EXPORTS \"\${SPECIFIERS}\")
configure_file(
  ${IN}
  ${OUT}
  @ONLY
)")

  add_custom_command(
    OUTPUT "${NAME}" BYPRODUCTS "${OUT}" COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}" DEPENDS "${NAME}.cmake" #VERBATIM
  )

  add_custom_target(
    "${NAME}" ALL BYPRODUCTS "${OUT}" COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake" DEPENDS "${NAME}.cmake"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_js.cmake" SOURCES "${NAME}.cmake")
endfunction(generate_precompiled_js NAME)

##
## generate_precompiled NAME
##
## parses a JS script with import statements and collects all identifiers from them
##
function(generate_precompiled_h NAME)
  module_path("${NAME}" OUTPUT_FILE)

  string(REGEX REPLACE "\.h$" ".c" C_FILE "${NAME}")
  module_path("${C_FILE}" INPUT_FILE)

  string(REGEX REPLACE "[^A-Za-z0-9_]" "_" CMAKE_FILE "generate_${NAME}")

  file(RELATIVE_PATH INCLUDEDIR "${CMAKE_CURRENT_BINARY_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

  file(
    GENERATE
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_FILE}.cmake"
    CONTENT
      "include(${INCLUDEDIR}/QuickJSModule.cmake)\n
parse_precompiled_symbols(${C_FILE} LWSJS_LIBS)\ngenerate_precompiled_header(X LWSJS_H \"\${LWSJS_LIBS}\")\nwrite_module_file(${NAME} \"\${LWSJS_H}\")\n"
  )

  file(RELATIVE_PATH OUT "${CMAKE_CURRENT_BINARY_DIR}" "${OUTPUT_FILE}")
  file(RELATIVE_PATH IN "${CMAKE_CURRENT_BINARY_DIR}" "${INPUT_FILE}")

  message("generate_precompiled_h ${NAME}")

  add_custom_command(
    OUTPUT "${NAME}" BYPRODUCTS "${OUT}" COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake" DEPENDS "${C_FILE}"
    #VERBATIM
  )
  add_custom_target(
    "${NAME}" ALL BYPRODUCTS "${OUT}" COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake" DEPENDS "${C_FILE}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_h.cmake" SOURCES "${IN}" #VERBATIM
  )
endfunction(generate_precompiled_h NAME)

##
## parse_precompiled_symbols NAME OUTPUT
##
## parses a C source generated by qjsc and gets all bytecode block identifiers
##
function(parse_precompiled_symbols NAME OUTVAR)
  module_path("${NAME}" FILE)

  if(EXISTS "${FILE}")
    file(READ "${FILE}" PRECOMP_C)
    string(REGEX REPLACE "[^A-Za-z0-9_]+" ";" SYMBOLS "${PRECOMP_C}")

    list(FILTER SYMBOLS INCLUDE REGEX ".*jsc.*")
    list(FILTER SYMBOLS EXCLUDE REGEX ".*_size$")
    string(REGEX REPLACE "qjsc_" "" SYMBOLS "${SYMBOLS}")

    set(${OUTVAR} "${SYMBOLS}" PARENT_SCOPE)
  endif()
endfunction(parse_precompiled_symbols NAME OUTVAR)

##
## generate_precompiled_header MACRO OUTVAR MODULE...
##
## generates a header for the #define/#include/#undef preprocessor iteration trick
##
function(generate_precompiled_header MACRO OUTVAR)
  message("generate_precompiled_header ${NAME} ${MACRO}")

  if(MACRO STREQUAL "")
    set(MACRO "X")
  endif()

  set(S "")
  set(I 0)

  foreach(MODULE ${ARGN})
    set(S "${S}${MACRO}(${MODULE}, ${I})\n")
    math(EXPR I "1 + ${I}")
  endforeach()

  set(${OUTVAR} "${S}" PARENT_SCOPE)
endfunction(generate_precompiled_header MACRO OUTVAR)

##
## write_module_file NAME S
##
function(write_module_file NAME S)
  module_path(${NAME} OUTFILE)
  file(WRITE "${OUTFILE}" "${S}")
endfunction(write_module_file NAME S)
