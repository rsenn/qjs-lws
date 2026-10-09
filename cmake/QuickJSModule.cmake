# quickjs_module_options([SHARED_DEFAULT <ON|OFF>] [STATIC_DEFAULT <ON|OFF>])
#
# Declares BUILD_SHARED/BUILD_STATIC the same way across
# every qjs-* project, so a single -DBUILD_SHARED_MODULES=.../
# -DBUILD_STATIC_MODULES=... passed to the top-level quickjs/ build reaches
# every add_subdirectory()'d qjs-* submodule unchanged (same cache-variable
# name everywhere). Guarded by NOT DEFINED so a value already set by the
# caller - this project's own earlier option() call, or the outer build -
# always wins; this macro only ever supplies the fallback default.
#
# WASI/Emscripten have no dlopen()-able shared-module story, so the shared
# default is forced off and the static default forced on there regardless
# of what the caller asked for.
macro(quickjs_module_options)
  cmake_parse_arguments(QMO "" "SHARED_DEFAULT;STATIC_DEFAULT" "" ${ARGN})
  if(NOT DEFINED QMO_SHARED_DEFAULT)
    set(QMO_SHARED_DEFAULT ON)
  endif()

  if(NOT DEFINED QMO_STATIC_DEFAULT)
    set(QMO_STATIC_DEFAULT OFF)
  endif(NOT DEFINED QMO_STATIC_DEFAULT)

  if(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(QMO_SHARED_DEFAULT OFF)
    set(QMO_STATIC_DEFAULT ON)
  endif(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

  if(NOT DEFINED BUILD_SHARED)
    option(BUILD_SHARED "Build shared QuickJS module(s)" ${QMO_SHARED_DEFAULT})
  endif()

  if(NOT DEFINED BUILD_STATIC)
    option(BUILD_STATIC "Build static QuickJS module(s) (*.a)" ${QMO_STATIC_DEFAULT})
  endif(NOT DEFINED BUILD_STATIC)
endmacro()

if(NOT PRECOMPILED_MODULE_DIR)
  set(PRECOMPILED_MODULE_DIR "modules/"
      CACHE PATH "subdirectory of build directory for precompiled .js modules")
endif(NOT PRECOMPILED_MODULE_DIR)

function(module_path NAME OUTVAR)
  cmake_path(SET OUTNAME "${CMAKE_CURRENT_BINARY_DIR}")
  cmake_path(APPEND OUTNAME ${PRECOMPILED_MODULE_DIR})
  file(MAKE_DIRECTORY "${OUTNAME}")
  cmake_path(APPEND OUTNAME "${NAME}")

  set(${OUTVAR} "${OUTNAME}" PARENT_SCOPE)
endfunction(module_path NAME)

#
# config_module <TARGET_NAME>
#
# Apply the common link directory, dependencies and compile options
# (QUICKJS_LIBRARY_DIR, QUICKJS_MODULE_DEPENDENCIES, QUICKJS_MODULE_CFLAGS) to
# the target TARGET_NAME.
#
function(config_module TARGET_NAME)
  if(QUICKJS_LIBRARY_DIR)
    set_target_properties(${TARGET_NAME} PROPERTIES LINK_DIRECTORIES "${QUICKJS_LIBRARY_DIR}")
  endif()

  if(QUICKJS_MODULE_DEPENDENCIES)
    target_link_libraries(${TARGET_NAME} ${QUICKJS_MODULE_DEPENDENCIES})
  endif()

  if(QUICKJS_MODULE_CFLAGS)
    target_compile_options(${TARGET_NAME} PRIVATE "${QUICKJS_MODULE_CFLAGS}")
  endif(QUICKJS_MODULE_CFLAGS)
endfunction()

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
    "${BASE}.c" ALL
    BYPRODUCTS "${OUTFILE}"
    COMMAND "${QJSC}" -v -c -o "${OUTFILE}" -m "${INFILE}" ${ARGN}
    DEPENDS ${QJSC_DEPS} ${INFILE}
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUTFILE} from ${INFILE} using qjs compiler"
    SOURCES "${INFILE}")
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
      set(S
          "${S}\nextern const uint32_t qjsc_${NAME}_size;\nextern const uint8_t qjsc_${NAME}[];\n"
      )
    endif(NOT DOES_CONTAIN)
  endforeach(NAME ${SYMBOLS})

  module_path(${BASE} OUTFILE)

  file(WRITE "${OUTFILE}.h" "${S}")

  dump(SYMBOLS)
endfunction(generate_module_header SOURCE)

#
# make_module_header <SOURCE>
#
# Add a target that regenerates the header of the C module SOURCE by running
# remake_module() in a cmake script.
#
function(make_module_header SOURCE)
  string(REGEX REPLACE "\\.tmp$" "" BASE2 "${SOURCE}")
  basename(BASE "${BASE2}" .c)
  string(REGEX REPLACE "\\.c$" ".h" HEADER "${BASE2}")
  string(REGEX REPLACE "-" "_" NAME "${BASE}")
  set(SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/gen-${BASE}-header.cmake")
  make_script("${SCRIPT}" "message(\"Generating module '${NAME}'\")\nremake_module(${SOURCE})\n"
              "${CMAKE_CURRENT_SOURCE_DIR}/cmake/Functions.cmake;${CMAKE_CURRENT_SOURCE_DIR}/cmake/QuickJSModule.cmake")
  add_custom_target(${BASE}.h ALL ${CMAKE_COMMAND} -P ${SCRIPT} DEPENDS ${SOURCE} BYPRODUCTS ${HEADER}
                    SOURCES ${SOURCE})
endfunction()

#
# list_definitions <SOURCE> <OUTVAR>
#
# Store the names of the qjsc_* definitions in the C file SOURCE in OUTVAR,
# leaving out the one named by the extra argument.
#
function(list_definitions SOURCE OUTVAR)
  file(READ "${SOURCE}" CSRC)
  string(REGEX MATCHALL "qjsc_[0-9A-Za-z_]+" SYMBOLS "${CSRC}")
  list(FILTER SYMBOLS EXCLUDE REGEX "_size$")
  string(REGEX REPLACE "qjsc_" "" SYMBOLS "${SYMBOLS}")
  set(OUT "")

  foreach(DEF ${SYMBOLS})
    if(ARGN AND NOT "${DEF}" STREQUAL "${ARGN}")
      list(APPEND OUT "${DEF}")
    endif(ARGN AND NOT "${DEF}" STREQUAL "${ARGN}")
  endforeach(DEF ${SYMBOLS})

  set("${OUTVAR}" "${OUT}" PARENT_SCOPE)
endfunction()

#
# include_definitions <OUTVAR>
#
# Store in OUTVAR an #include line for the header of each definition name
# given (underscores written as '-').
#
function(include_definitions OUTVAR)
  #print_str("include_definitions(${OUTVAR} ${ARGN})")
  set(S "")
  foreach(DEF ${ARGN})
    string(STRIP "${DEF}" DEF)
    string(REGEX REPLACE "_" "-" NAME "${DEF}")
    set(S "${S}#include \"${NAME}.h\"\n")
  endforeach(DEF ${ARGN})

  #print_str("include_definitions S=${S}")
  set("${OUTVAR}" "${S}" PARENT_SCOPE)
endfunction()

#
# extract_definition <SOURCE> <OUTVAR> <DEF>
#
# Store in OUTVAR the qjsc_<DEF> definition (the const data declaration) found
# in the C file SOURCE.
#
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
endfunction()

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

#
# make_script <OUTPUT_FILE> <TEXT> <INCLUDES>
#
# Write the cmake script OUTPUT_FILE that includes the files INCLUDES and then
# runs TEXT.
#
function(make_script OUTPUT_FILE TEXT INCLUDES)
  basename(BASE "${SOURCE}" .c)
  string(REGEX REPLACE "\\.c$" ".h" HEADER "${SOURCE}")
  string(REGEX REPLACE "-" "_" NAME "${BASE}")
  set(S "cmake_policy(SET CMP0007 NEW)\n")
  foreach(INC ${INCLUDES})
    set(S "${S}\ninclude(${INC})\n")
  endforeach()

  set(S "${S}\n\n${TEXT}\n")
  file(WRITE "${OUTPUT_FILE}" "${S}")
endfunction()

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
    set_add(DEPS ${${VNAME}_DEPS})
  else(ARGN)
    set(SOURCES quickjs-${NAME}.c #${${VNAME}_SOURCES}
                ${COMMON_SOURCES})
    set_add(LIBS ${${VNAME}_LIBRARIES})
  endif(ARGN)
  set_add(LIBS ${COMMON_LIBRARIES})

  message(
    STATUS
      "Building QuickJS module: ${FNAME} (deps: ${DEPS}, libs: ${LIBS}) JS_${UNAME}_MODULE=1"
  )

  if(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(BUILD_SHARED OFF)
  endif(WASI OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

  if(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(PREFIX "lib")
  else(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
    set(PREFIX "")
  endif(NOT WASI AND "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")

  #dump(VNAME ${VNAME}_SOURCES SOURCES)

  if(BUILD_SHARED)
    #add_library(${TARGET_NAME} MODULE ${SOURCES})
    add_library(${TARGET_NAME} SHARED ${SOURCES})

    set_target_properties(
      ${TARGET_NAME}
      PROPERTIES RPATH "${MBEDTLS_LIBRARY_DIR}:${QUICKJS_C_MODULE_DIR}"
                 INSTALL_RPATH "${QUICKJS_C_MODULE_DIR}" PREFIX "${PREFIX}"
                 OUTPUT_NAME "${VNAME}" COMPILE_FLAGS "${MODULE_COMPILE_FLAGS}")

    target_compile_definitions(
      ${TARGET_NAME}
      PRIVATE _GNU_SOURCE=1 JS_SHARED_LIBRARY=1 JS_${UNAME}_MODULE=1
              QUICKJS_PREFIX="${QUICKJS_INSTALL_PREFIX}")

    target_link_directories(${TARGET_NAME} PUBLIC "${CMAKE_CURRENT_BINARY_DIR}")
    target_link_libraries(${TARGET_NAME} PUBLIC ${LIBS} ${QUICKJS_LIBRARY})

    install(
      TARGETS ${TARGET_NAME}
      RUNTIME DESTINATION "${QUICKJS_C_MODULE_DIR}"
              PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ
                          GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)

    config_module(${TARGET_NAME})

    set(LIBRARIES ${${VNAME}_LIBRARIES})
    if(LIBRARIES)
      target_link_libraries(${TARGET_NAME} PRIVATE ${LIBRARIES})
    endif(LIBRARIES)
    if(DEPS)
      add_dependencies(${TARGET_NAME} ${DEPS})
    endif(DEPS)

  endif(BUILD_SHARED)

  add_library(${TARGET_NAME}-static STATIC ${SOURCES})

  set(MODULES_STATIC "${QJS_MODULES_STATIC}")
  list(APPEND MODULES_STATIC "${TARGET_NAME}-static")
  set(QJS_MODULES_STATIC "${MODULES_STATIC}" PARENT_SCOPE)

  set_target_properties(
    ${TARGET_NAME}-static
    PROPERTIES OUTPUT_NAME "${VNAME}" PREFIX "quickjs-" SUFFIX
                                                        "${LIBRARY_SUFFIX}"
               COMPILE_FLAGS "")
  target_compile_definitions(
    ${TARGET_NAME}-static PRIVATE _GNU_SOURCE=1 JS_${UNAME}_MODULE=1
                                  QUICKJS_PREFIX="${QUICKJS_INSTALL_PREFIX}")
  target_link_directories(${TARGET_NAME}-static PUBLIC
                          "${CMAKE_CURRENT_BINARY_DIR}")
  target_link_libraries(${TARGET_NAME}-static INTERFACE ${QUICKJS_LIBRARY})
endfunction()

if(WASI OR EMSCRIPTEN)
  set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
endif(WASI OR EMSCRIPTEN)

quickjs_module_options(SHARED_DEFAULT ON STATIC_DEFAULT OFF)

if(WIN32 OR MINGW)
  set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS TRUE)
endif(WIN32 OR MINGW)

if(WASI OR WASM OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL "Emscripten")
  set(LIBRARY_PREFIX "lib")
  set(LIBRARY_SUFFIX ".a")
endif(WASI OR WASM OR EMSCRIPTEN OR "${CMAKE_SYSTEM_NAME}" STREQUAL
                                    "Emscripten")

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

    #message("Import module: ${MODULE}, specifiers: ${IDS}")

    list(APPEND IMPORTS "${MODULE}:${IDS}")
  endforeach()

  #message("Imports:\n${IMPORTS}")
  #dump(IMPORTS)

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
  file(RELATIVE_PATH INCLUDEDIR "${CMAKE_CURRENT_BINARY_DIR}"
       "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

  file(RELATIVE_PATH LIBDIR "${CMAKE_CURRENT_BINARY_DIR}/modules"
       "${CMAKE_CURRENT_SOURCE_DIR}/lib")
  file(CREATE_LINK "${LIBDIR}" "${CMAKE_CURRENT_BINARY_DIR}/modules/lib"
       COPY_ON_ERROR SYMBOLIC)

  file(
    GENERATE
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_FILE}.cmake"
    CONTENT
      "include(${INCLUDEDIR}/QuickJSModule.cmake)

parse_jsimports(${IN} JSIMPORTS)
get_jsimport_specifiers(\"\${JSIMPORTS}\" SPECIFIERS)

string(REGEX REPLACE \";\" \",\\n  \" EXPORTS \"\${SPECIFIERS}\")
configure_file(
  ${IN}
  ${OUT}
  @ONLY
)")

  add_custom_command(
    OUTPUT "${NAME}"
    BYPRODUCTS "${OUT}"
    COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    DEPENDS "${INPUT_FILE}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_js.cmake"
            SOURCES "${NAME}.cmake" #VERBATIM
  )

  add_custom_target(
    "${NAME}" ALL
    BYPRODUCTS "${OUT}"
    COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake"
    DEPENDS "${INPUT_FILE}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_js.cmake"
    SOURCES "${NAME}.cmake" #VERBATIM
  )
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

  file(RELATIVE_PATH INCLUDEDIR "${CMAKE_CURRENT_BINARY_DIR}"
       "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
  file(RELATIVE_PATH OUT "${CMAKE_CURRENT_BINARY_DIR}" "${OUTPUT_FILE}")
  file(RELATIVE_PATH IN "${CMAKE_CURRENT_BINARY_DIR}" "${INPUT_FILE}")

  file(
    GENERATE
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_FILE}.cmake"
    CONTENT
      "include(${INCLUDEDIR}/QuickJSModule.cmake)\n
parse_precompiled_symbols(${C_FILE} LWSJS_LIBS)
generate_precompiled_header(X LWSJS_H \"\${LWSJS_LIBS}\")
write_module_file(${NAME} \"\${LWSJS_H}\")")

  #message("generate_precompiled_h ${NAME}")

  add_custom_command(
    OUTPUT "${NAME}"
    BYPRODUCTS "${OUT}"
    COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake"
    DEPENDS "${INPUT_FILE}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_h.cmake"
            SOURCES "${INPUT_FILE}" #VERBATIM
  )
  add_custom_target(
    "${NAME}" ALL
    BYPRODUCTS "${OUT}"
    COMMAND ${CMAKE_COMMAND} -P "${CMAKE_FILE}.cmake"
    DEPENDS "${INPUT_FILE}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    COMMENT "Generate ${OUT} from ${IN} using generate_precompiled_h.cmake"
    SOURCES "${INPUT_FILE}" #VERBATIM
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

#
# get_native_modules <OUTPUT-VARIABLE>
#
# Names of the native modules, one per quickjs-<name>.c in the source
# directory, with '-' written '_': quickjs-child-process.c -> child_process.
#
function(get_native_modules OUTVAR)
  file(GLOB FILES RELATIVE "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/quickjs-*.c")

  set(NAMES "")
  foreach(FILE ${FILES})
    string(REGEX REPLACE "^quickjs-(.*)\\.c$" "\\1" NAME "${FILE}")
    string(REPLACE "-" "_" NAME "${NAME}")
    list(APPEND NAMES "${NAME}")
  endforeach(FILE ${FILES})

  list(SORT NAMES)
  set("${OUTVAR}" "${NAMES}" PARENT_SCOPE)
endfunction()

#
# get_compiled_modules <OUTPUT-VARIABLE>
#
# Names of the JS modules that can be compiled into a builtin, one per .js
# file below lib/ without the extension: lib/fsPromises.js -> fsPromises,
# lib/xml/read.js -> xml/read.
#
function(get_compiled_modules OUTVAR)
  file(GLOB_RECURSE FILES RELATIVE "${CMAKE_CURRENT_SOURCE_DIR}/lib" "${CMAKE_CURRENT_SOURCE_DIR}/lib/*.js")

  set(NAMES "")
  foreach(FILE ${FILES})
    string(REGEX REPLACE "\\.js$" "" NAME "${FILE}")
    list(APPEND NAMES "${NAME}")
  endforeach(FILE ${FILES})

  list(SORT NAMES)
  set("${OUTVAR}" "${NAMES}" PARENT_SCOPE)
endfunction()

#
# compile_code <RESULT-VARIABLE> <CODE>
#
# Try to compile the C source CODE against QuickJS and store whether it worked
# in RESULT-VARIABLE, unless already defined.
#
function(compile_code RESULT_VAR CODE)
  string(TOLOWER "${RESULT_VAR}" NAME)
  string(REGEX REPLACE "_" "-" FILE "try-${NAME}.c")

  if(NOT DEFINED "${RESULT_VAR}")
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/${FILE}" "${CODE}")

    # must match the include search order the real qjsm.c/quickjs-*.c translation units get
    # (see include_directories(${QUICKJS_INCLUDE_DIRS}) / include_directories(${QUICKJS_INCLUDE_DIR})
    # in CMakeLists.txt) - otherwise this probe can silently detect a different header than the one
    # actually compiled against (js-module-loader-detection-vs-actual-headers)
    set(_compile_code_includes "${QUICKJS_INCLUDE_DIRS}" "${QUICKJS_SOURCES_ROOT}")
    set(_compile_code_iflags "")

    foreach(_dir ${_compile_code_includes})
      set(_compile_code_iflags "${_compile_code_iflags} -I${_dir}")
    endforeach(_dir ${_compile_code_includes})

    try_compile(
      RESULT "${CMAKE_CURRENT_BINARY_DIR}"
      "${CMAKE_CURRENT_BINARY_DIR}/${FILE}"
      LINK_OPTIONS "-L${QUICKJS_LIBRARY_DIR}"
      COMPILE_DEFINITIONS "${_compile_code_iflags}"
      CMAKE_FLAGS
        "-DINCLUDE_DIRECTORIES=${_compile_code_includes}" "-DLINK_DIRECTORIES=${QUICKJS_LIBRARY_DIR}" LINK_DIRECTORIES
        "${QUICKJS_LIBRARY_DIR}"
      LINK_LIBRARIES "${QUICKJS_LIBRARY}"
      OUTPUT_VARIABLE OUTPUT)

    set(${RESULT_VAR} "${RESULT}" PARENT_SCOPE)

    if(NOT RESULT)
      message(STATUS "Failed to compile '${FILE}'. Output:\n${OUTPUT}")
    endif(NOT RESULT)

  endif(NOT DEFINED "${RESULT_VAR}")
endfunction()
