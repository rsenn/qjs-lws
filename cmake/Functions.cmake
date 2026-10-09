# Functions.cmake: shared helper library, adopted from qjs-modules
# (its cmake/Functions.cmake followed by cmake/Compat.cmake), plus the
# check_*_def helpers that are specific to this project (bottom).

include(CheckLibraryExists)
include(CheckCCompilerFlag)
include(CheckCSourceCompiles)

#
# add_cflags <ADD> [OUTPUT_VAR]
#
function(add_cflags ADD)
  if(${ARGC} LESS 2)
    set(OUTPUT_VAR CMAKE_C_FLAGS)
  else()
    set(OUTPUT_VAR "${ARGV1}")
  endif()
  
  #message_func("add_cflags" ${ADD} ${OUTPUT_VAR})

  set(RESULT "${${OUTPUT_VAR}}")
  string(REGEX REPLACE " +" ";" FLAGS "${RESULT}")
  string(REGEX REPLACE "^;+" "" FLAGS "${FLAGS}")
  list(REMOVE_DUPLICATES FLAGS) 
  if(NOT ADD IN_LIST FLAGS)
    list(APPEND RESULT ${ADD})
  endif()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# set_init <OUTPUT-VAR> [ITEMS...]
#
function(set_init OUTPUT_VAR)
  set(RESULT "")
  set_add(RESULT ${ARGN})
  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# set_add <OUTPUT-VAR> [ITEMS...]
#
function(set_add OUTPUT_VAR)
  set(RESULT "${${OUTPUT_VAR}}")
  foreach(ITEM ${ARGN})
    if(NOT ITEM IN_LIST RESULT)
      list(APPEND RESULT "${ITEM}")
    endif()
  endforeach()
  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# escape_string <OUTPUT-VAR> <STR>
#
function(escape_string OUTPUT_VAR STR)
  string(REPLACE "\\" "\\\\" RESULT "${STR}")

  string(REPLACE "\n" "\\n" RESULT "${RESULT}")
  string(REPLACE "\r" "\\r" RESULT "${RESULT}")
  string(REPLACE "\t" "\\t" RESULT "${RESULT}")
  string(REPLACE "${ANSI_ESCAPE}" "\\e" RESULT "${RESULT}")
  string(REPLACE "" "\\v" RESULT "${RESULT}")
  string(REPLACE "" "\\f" RESULT "${RESULT}")

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif(OUTPUT_VAR)
endfunction()

#
# unescape_string <OUTPUT-VAR> <STR>
#
function(unescape_string OUTPUT_VAR STR)
  string(REPLACE "\\n" "\n" RESULT "${STR}")
  string(REPLACE "\\r" "\r" RESULT "${RESULT}")
  string(REPLACE "\\t" "\t" RESULT "${RESULT}")
  string(REPLACE "\\x1b" "${ANSI_ESCAPE}" RESULT "${RESULT}")
  string(REPLACE "\\033" "${ANSI_ESCAPE}" RESULT "${RESULT}")
  string(REPLACE "\\e" "${ANSI_ESCAPE}"  RESULT "${RESULT}")
  string(REPLACE "\\v" ""  RESULT "${RESULT}")
  string(REPLACE "\\f" ""   RESULT "${RESULT}")

  string(REPLACE "\\\\" "\\" RESULT "${RESULT}")

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif(OUTPUT_VAR)
endfunction()

# ITEMS contains multiple items
#
# assign_items <ITEMS> [VAR0, ...]
#
macro(assign_items ITEMS)
  set(__L "${ITEMS}")
  set(__I 0)
  foreach(__A ${ARGN})
    list(GET __L "${__I}" "${__A}")
    math(EXPR __I "${__I} + 1")
 endforeach()
endmacro()

# LIST is the name of a list
#
# assign_list <LIST> [VAR0...]
#
macro(assign_list LIST)
  assign_items("${${LIST}}" ${ARGN})
endmacro()

#
# eat_line <BUFFER-VAR> <RESULT-VAR>
#
function(eat_line BUFFER_VAR RESULT_VAR)
  set(BUF "${${BUFFER_VAR}}")
  string(FIND "${BUF}" "\n" NL_POS)
  string(LENGTH "${BUF}" LEN)
  if(${NL_POS} EQUAL -1)
    set(NL_POS "${LEN}")
    set(NEXT_POS "${NL_POS}")
  else()
    math(EXPR NEXT_POS "${NL_POS} + 1")
  endif()
  string(SUBSTRING "${BUF}" "0" "${NL_POS}" RESULT)
  string(SUBSTRING "${BUF}"  "${NEXT_POS}"  -1 REST)
  set("${RESULT_VAR}" "${RESULT}" PARENT_SCOPE)
  set("${BUFFER_VAR}" "${REST}" PARENT_SCOPE)
endfunction()

#
# add_prefix <OUTPUT-VAR> <PREFIX> [ARGS...]
#
macro(add_prefix OUTPUT_VAR PREFIX)
  unset("${OUTPUT_VAR}" PARENT_SCOPE)
  foreach(ARG ${ARGN})
    list(APPEND "${OUTPUT_VAR}" "${PREFIX}${ARG}")
  endforeach()
endmacro()

#
# add_suffix <OUTPUT-VAR> <SUFFIX> [ARGS...]
#
macro(add_suffix OUTPUT_VAR SUFFIX)
  unset("${OUTPUT_VAR}" PARENT_SCOPE)
  foreach(ARG ${ARGN})
    list(APPEND "${OUTPUT_VAR}" "${ARG}${SUFFIX}")
  endforeach()
endmacro()

#
# assign_named_prefix <PREFIX> [ARGS...]
#
macro(assign_named_prefix PREFIX)
  set(ARGUMENTS "${ARGN}")

  while(NOT "${ARGUMENTS}" STREQUAL "")
    eat_line(ARGUMENTS NAME)
    eat_line(ARGUMENTS VALUE)

   set("${PREFIX}${NAME}" "${VALUE}" CACHE STRING "Color value")
  endwhile()
endmacro()

#
# assign_named_items [ARGS...]
#
macro(assign_named_items)
 unset(__N)
  foreach(__A ${ARGN})
     if(NOT DEFINED __N)
      set(__N "${__A}")
     else()
      set(__V "${__A}")
      endif()
     if(DEFINED __V)
         set("${__N}" "${__V}")
       unset(__N)
       unset(__V)
     endif()
  endforeach()
endmacro()

#
# assign_named_var <VAR_NAME>
#
macro(assign_named_var VAR_NAME)
  assign_named_items(${${VAR_NAME}})
endmacro()

#
# isin_var <OUTPUT-VAR> <ITEM> <VAR-NAME>
#
function(isin_var OUTPUT_VAR ITEM VAR_NAME)
  if(ITEM IN_LIST "${VAR_NAME}")
    set(RESULT TRUE)
  else()
    set(RESULT FALSE)
  endif()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# isin_list <OUTPUT-VAR> <ITEM> [LIST...]
#
function(isin_list OUTPUT_VAR ITEM)
  set(LIST "${ARGN}")
  isin_var("${OUTPUT_VAR}" "${ITEM}" LIST)
endfunction()

#
# absolute_paths <OUTPUT-VAR> [PATHS...]
#
function(absolute_paths OUTPUT_VAR)
  set(RESULT "")
  foreach(ARG ${ARGN})
      cmake_path(ABSOLUTE_PATH ARG OUTPUT_VARIABLE VALUE)
      list(APPEND RESULT "${VALUE}")
  endforeach()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# absolute_paths_in <OUTPUT-VAR> <BASE-DIRECTORY> [PATHS...]
#
function(absolute_paths_in OUTPUT_VAR BASE_DIRECTORY)
  set(RESULT "")
  foreach(ARG ${ARGN})
      cmake_path(ABSOLUTE_PATH ARG BASE_DIRECTORY "${BASE_DIRECTORY}" OUTPUT_VARIABLE VALUE)
      list(APPEND RESULT "${VALUE}")
  endforeach()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# relative_paths <OUTPUT-VAR> <BASE-DIRECTORY> [PATHS...]
#
function(relative_paths OUTPUT_VAR BASE_DIRECTORY)
  set(RESULT "")
  foreach(ARG ${ARGN})
      cmake_path(RELATIVE_PATH ARG BASE_DIRECTORY "${BASE_DIRECTORY}" OUTPUT_VARIABLE VALUE)
      list(APPEND RESULT "${VALUE}")
  endforeach()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# get_cwd <OUTPUT-VAR>
#
function(get_cwd OUTPUT_VAR)
  set(ARG ".")
  cmake_path(ABSOLUTE_PATH ARG OUTPUT_VARIABLE RESULT)
  string(REGEX REPLACE "[/\\\\]\\.$" "" RESULT "${RESULT}")

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# is_relative <PATH> <OUTPUT-VAR>
#
function(is_relative PATH OUTPUT_VAR)
  if(OUTPUT_VAR)
    cmake_path(IS_RELATIVE PATH "${OUTPUT_VAR}")
  endif()
endfunction()

#
# is_absolute <PATH> <OUTPUT-VAR>
#
function(is_absolute PATH OUTPUT_VAR)
  if(OUTPUT_VAR)
    cmake_path(IS_ABSOLUTE PATH "${OUTPUT_VAR}")
  endif()
endfunction()

#
# concat <OUTPUT-VAR> <SEPARATOR> [ARGUMENTS...]
#
function(concat OUTPUT_VAR SEPARATOR)
  set(RESULT "")
  foreach(ARG ${ARGN})
    if(NOT "${RESULT}" STREQUAL "")
      set(RESULT "${RESULT}${SEPARATOR}${ARG}")
    else()
      set(RESULT "${ARG}")
    endif()
  endforeach()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# basename <OUTPUT-VAR> <STR> [EXT_NAME]
#
function(basename OUTPUT_VAR STR)
  string(REGEX REPLACE ".*/" "" RESULT "${STR}")
  if(ARGN)
    string(REGEX REPLACE "\\${ARGN}\$" "" RESULT "${RESULT}")
  endif()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# var2define <NAME> [DEFINED_VALUE] [VAR_NAME]
#
function(var2define NAME)
  if(${ARGC} GREATER_EQUAL 3)
    set(VAR_NAME "${ARGV1}")
  else()
    set(VAR_NAME "${NAME}")
  endif()

  set(VALUE "${${VAR_NAME}}")
  if(${ARGC} LESS_EQUAL 1 AND ${ARGC} GREATER_EQUAL 0)
    if(VALUE)
      add_definitions(-D${NAME}=1)
    else()
      add_definitions(-D${NAME}=0)
    endif()
  else()
    if(VALUE)
      add_definitions(-D${NAME}=${ARGV1})
    endif()
  endif()
endfunction()

# Get number of columns the terminal supports
#
# get_columns <OUTPUT-VAR> [DEFAULT]
#
function(get_columns RESULT_VAR)
  if(${ARGC} GREATER_EQUAL 2)
    set(DEFAULT_VALUE ${ARGV1})
  else()
    set(DEFAULT_VALUE 80)
  endif()

  set(RESULT "$ENV{COLUMNS}")
  if(RESULT GREATER_EQUAL 1)
    # message("Got COLUMNS (${RESULT}) from environment")
  else()
    execute_process(COMMAND tput cols OUTPUT_VARIABLE TPUT_COLS ERROR_QUIET ERROR_VARIABLE TPUT_ERROR)
    if(NOT TPUT_ERROR AND TPUT_COLS)
      set(RESULT ${TPUT_COLS})
    else()
      set(SOURCE_NAME ttysize.c)
      set(SOURCE_CODE "#include <unistd.h>\n#include <fcntl.h>\n#include <termios.h>\n#include <sys/ioctl.h>\n#include <stdio.h>\n\nint\nmain() {\n\tstruct winsize sz;\n\tint fd = isatty(0) ? dup(0) : open(\"/dev/tty\", O_RDWR);\n\n\tif(!isatty(fd)) {\n\t\tfputs(\"not a tty\\n\", stderr);\n\t\tfflush(stderr);\n\t\treturn 1;\n\t}\n\n\tif(ioctl(fd, TIOCGWINSZ, &sz) == -1) {\n\t\tperror(\"ioctl\");\n\t\treturn 1;\n\t}\n\n\tclose(fd);\n\n\tprintf(\"%u\\n\", sz.ws_col);\n\treturn 0;\n}\n")
      message(CHECK_START "Trying to compile ${SOURCE_NAME}")
      try_run(RUN_RESULT COMPILE_RESULT SOURCE_FROM_CONTENT "${SOURCE_NAME}" "${SOURCE_CODE}" RUN_OUTPUT_STDOUT_VARIABLE RUN_OUTPUT COMPILE_OUTPUT_VARIABLE COMPILE_OUTPUT NO_CACHE)
      if(NOT COMPILE_RESULT)
        message(CHECK_FAIL "failed to compile:\n${COMPILE_OUTPUT}")
      else()
        if(RUN_RESULT STREQUAL 0)
          message(CHECK_PASS "ok")
          set(RESULT "${RUN_OUTPUT}")
        else()
          message(CHECK_FAIL "failed to run:\n${RUN_OUTPUT}")
        endif()
      endif()
    endif()
  endif()
  
  if(NOT RESULT GREATER_EQUAL 1)
    set(RESULT "${DEFAULT_VALUE}")
  endif()

  if(RESULT_VAR)
    set("${RESULT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

#
# named_dump <MSG> [VAR-NAMES...]
#
function(named_dump MSG)
  assign_named_var(DUMP_FORMAT)
  set(INDEX 0)
  math(EXPR LAST "${ARGC} - 2")
  set(RESULT "${MSG}${START}")

  foreach(VAR_NAME ${ARGN})
    set(VALUE "${${VAR_NAME}}")
    set(LINE "${INDENT}${VAR_NAME}${PROP}${QUOTE}${VALUE}${QUOTE}")
    if(INDEX LESS LAST)
      set(LINE "${LINE}${COMMA}")
    endif()
    set(RESULT "${RESULT}${NEWLINE}${LINE}")
    math(EXPR INDEX "${INDEX} + 1")
  endforeach()
  if(NOT END STREQUAL "")
    set(RESULT "${RESULT}${NEWLINE}${END}")
  endif()
  
  message("${RESULT}")
endfunction()

set(DUMP_FORMAT INDENT "  " START " {" END "}" PROP ": " QUOTE "'" COMMA "," NEWLINE "\\n")

#
# dump [VAR-NAMES...]
#
function(dump)
  named_dump("Variable dump" ${ARGN})
endfunction()

#
# dump_list <VAR-NAME>
#
function(dump_list VAR_NAME)
  assign_named_var(DUMP_FORMAT)
  message("List dump of ${VAR_NAME}:")
  list(LENGTH "${VAR_NAME}" NUM_ITEMS)
  set(INDEX 0)
  while(${INDEX} LESS ${NUM_ITEMS})
    list(GET "${VAR_NAME}" "${INDEX}" ITEM)
    message("${INDENT}${INDEX}: ${ITEM}")
    math(EXPR INDEX "${INDEX} + 1")
  endwhile()
endfunction()

#
# make_list <OUTPUT-VAR> <MAX_LINE_LEN>
#
function(make_list OUTPUT_VAR MAX_LINE_LEN)
  assign_named_var(LIST_FORMAT)
  set(RESULT "")
  set(LINE "")
  string(REPLACE " " ";" ARGS "${ARGN}")
  foreach(ITEM ${ARGS})
    string(LENGTH "${LINE}${SEP}${ITEM}" LEN)
    math(EXPR EFFECTIVE_LEN "${LEN} + 4")
    if(EFFECTIVE_LEN GREATER MAX_LINE_LEN)
      set(RESULT "${RESULT}\n${INDENT}${LINE}")
      set(LINE " ${ITEM}")
      string(LENGTH "${LINE}" LEN)
    else()
      set(LINE "${LINE}${SEP}${ITEM}")
    endif()
  endforeach()
  if(LINE)
    set(RESULT "${RESULT}\n${INDENT}${LINE}")
  endif()

  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()
 
set(LIST_FORMAT INDENT "    " SEP  " ")

#
# message_unescaped [STRINGS...]
#
function(message_unescaped)
  set(S "")
  foreach(ARG ${ARGN})
    set(S "${S}${ARG}")
  endforeach()
  unescape_string(S "${S}")
  message("${S}")
endfunction()

#
# message_func <FUNCTION-NAME> [STRINGS...]
#
function(message_func FUNC)
  set(S "${COLOR_LIGHTRED}${FUNC}${COLOR_NONE}")
  foreach(ARG ${ARGN})
    set(S "${S} ${ARG}")
  endforeach()
  unescape_string(S "${S}")
  message("${S}")
endfunction()

#
# init_colors
#
macro(init_colors)
  set(ANSI_ESCAPE "")
  set(SEMI "╎")
  set(COLORS
    NONE "${ANSI_ESCAPE}[0m"
    BLACK "${ANSI_ESCAPE}[0${SEMI}30m"
    RED "${ANSI_ESCAPE}[0${SEMI}31m"
    GREEN "${ANSI_ESCAPE}[0${SEMI}32m"
    BROWN "${ANSI_ESCAPE}[0${SEMI}33m"
    BLUE "${ANSI_ESCAPE}[0${SEMI}34m"
    MAGENTA "${ANSI_ESCAPE}[0${SEMI}35m"
    CYAN "${ANSI_ESCAPE}[0${SEMI}36m"
    LIGHTGRAY "${ANSI_ESCAPE}[0${SEMI}37m"
    DARKGRAY "${ANSI_ESCAPE}[1${SEMI}30m"
    LIGHTRED "${ANSI_ESCAPE}[1${SEMI}31m"
    LIGHTGREEN "${ANSI_ESCAPE}[1${SEMI}32m"
    YELLOW "${ANSI_ESCAPE}[1${SEMI}33m"
    LIGHTBLUE "${ANSI_ESCAPE}[1${SEMI}34m"
    LIGHTMAGENTA "${ANSI_ESCAPE}[1${SEMI}35m"
    LIGHTCYAN "${ANSI_ESCAPE}[1${SEMI}36m"
    WHITE "${ANSI_ESCAPE}[1${SEMI}37m" 
  )
  string(REPLACE ";" "\n" CMAP "${COLORS}")
  string(REPLACE "${SEMI}" ";" CMAP "${CMAP}")

  assign_named_prefix(COLOR_ ${CMAP})
endmacro()

#
# getenv <OUTPUT-VAR> <VAR-NAME>
#
function(getenv OUTPUT_VAR VAR_NAME)
  if(OUTPUT_VAR)
    if(DEFINED ENV{${VAR_NAME}})
      set("${OUTPUT_VAR}" "$ENV{${VAR_NAME}}" PARENT_SCOPE)
    else()
      unset("${OUTPUT_VAR}" PARENT_SCOPE)
    endif()
  endif()
endfunction()

#
# getenv_default <OUTPUT-VAR> <VAR-NAME> [DEFAULT-VALUE]
#
function(getenv_default OUTPUT_VAR VAR_NAME)
  if(DEFINED ENV{${VAR_NAME}})
    set(RESULT "$ENV{${VAR_NAME}}")
  else()
    set(RESULT "${ARGN}")
  endif()
  if(OUTPUT_VAR)
    set("${OUTPUT_VAR}" "${RESULT}" PARENT_SCOPE)
  endif()
endfunction()

include(CheckCXXCompilerFlag)
include(CheckIncludeFileCXX)

##
## canonicalize <OUTPUT-VARIABLE> <STR>
##
function(CANONICALIZE OUTPUT_VAR STR)
  string(REGEX REPLACE "^-W" "WARN_" TMP_STR "${STR}")

  string(REGEX REPLACE "-" "_" TMP_STR "${TMP_STR}")
  string(TOUPPER "${TMP_STR}" TMP_STR)

  set("${OUTPUT_VAR}" "${TMP_STR}" PARENT_SCOPE)
endfunction(CANONICALIZE OUTPUT_VAR STR)

##
## dirname <OUTPUT-VARIABLE> <STR>
##
function(DIRNAME OUTPUT_VAR STR)
  string(REGEX REPLACE "/[^/]+/*$" "" TMP_STR "${STR}")
  if(ARGN)
    string(REGEX REPLACE "\\${ARGN}\$" "" TMP_STR "${TMP_STR}")
  endif(ARGN)

  set("${OUTPUT_VAR}" "${TMP_STR}" PARENT_SCOPE)
endfunction(DIRNAME OUTPUT_VAR FILE)

##
## addprefix <OUTPUT-VARIABLE> <PREFIX>
##
function(ADDPREFIX OUTPUT_VAR PREFIX)
  set(OUTPUT "")
  foreach(ARG ${ARGN})
    list(APPEND OUTPUT "${PREFIX}${ARG}")
  endforeach(ARG ${ARGN})
  set("${OUTPUT_VAR}" "${OUTPUT}" PARENT_SCOPE)
endfunction(ADDPREFIX OUTPUT_VAR PREFIX)

##
## addsuffix <OUTPUT-VARIABLE> <PREFIX>
##
function(ADDSUFFIX OUTPUT_VAR SUFFIX)
  set(OUTPUT "")
  foreach(ARG ${ARGN})
    list(APPEND OUTPUT "${ARG}${SUFFIX}")
  endforeach(ARG ${ARGN})
  set("${OUTPUT_VAR}" "${OUTPUT}" PARENT_SCOPE)
endfunction(ADDSUFFIX OUTPUT_VAR SUFFIX)

##
## relative_path <OUTPUT-VARIABLE> <RELATIVE_TO>
##
function(RELATIVE_PATH OUT_VAR RELATIVE_TO)
  set(LIST "")

  foreach(ARG ${ARGN})
    file(RELATIVE_PATH ARG "${RELATIVE_TO}" "${ARG}")
    list(APPEND LIST "${ARG}")
  endforeach(ARG ${ARGN})

  set("${OUT_VAR}" "${LIST}" PARENT_SCOPE)
endfunction(RELATIVE_PATH RELATIVE_TO OUT_VAR)

##
## check_include_cxx_def <INCLUDE> [RESULT-VARIABLE] [PREPROCESSOR-DEFINITION]
##
macro(CHECK_INCLUDE_CXX_DEF INC)
  if(ARGC GREATER_EQUAL 2)
    set(RESULT_VAR "${ARGV1}")
    set(PREPROC_DEF "${ARGV2}")
  else(ARGC GREATER_EQUAL 2)
    clean_name("${INC}" INC_D)
    string(TOUPPER "HAVE_${INC_D}" RESULT_VAR)
    string(TOUPPER "HAVE_${INC_D}" PREPROC_DEF)
  endif(ARGC GREATER_EQUAL 2)

  check_include_file_cxx("${INC}" "${RESULT_VAR}")

  if(${${RESULT_VAR}})
    set("${RESULT_VAR}" TRUE CACHE INTERNAL "Define this if you have the '${INC}' header file")

    if(NOT "${PREPROC_DEF}" STREQUAL "")
      var2define("${PREPROC_DEF}" 1)
    endif(NOT "${PREPROC_DEF}" STREQUAL "")
  endif(${${RESULT_VAR}})
endmacro(CHECK_INCLUDE_CXX_DEF INC)

##
## append_parent <VARIABLE-NAME>
##
macro(APPEND_PARENT VAR)
  set(LIST "${${VAR}}")
  list(APPEND LIST ${ARGN})
  set("${VAR}" "${LIST}" PARENT_SCOPE)
endmacro(APPEND_PARENT VAR)

##
## contains <LIST-NAME> <VALUE> <OUTPUT-VARIABLE>
##
function(CONTAINS LIST VALUE OUTPUT)
  list(FIND "${LIST}" "${VALUE}" INDEX)

  if(${INDEX} GREATER -1)
    set(RESULT TRUE)
  else(${INDEX} GREATER -1)
    set(RESULT FALSE)
  endif(${INDEX} GREATER -1)

  if(NOT RESULT)
    foreach(ITEM ${${LIST}})
      if("${ITEM}" STREQUAL "${VALUE}")
        set(RESULT TRUE)
      endif("${ITEM}" STREQUAL "${VALUE}")
    endforeach(ITEM ${${LIST}})
  endif(NOT RESULT)

  set("${OUTPUT}" "${RESULT}" PARENT_SCOPE)
endfunction(CONTAINS LIST VALUE OUTPUT)

##
## add_unique <LIST-NAME> <VALUES...>
##
function(ADD_UNIQUE LIST)
  set(RESULT "${${LIST}}")

  foreach(ITEM ${ARGN})
    contains(RESULT "${ITEM}" FOUND)

    if(NOT FOUND)
      list(APPEND RESULT "${ITEM}")
    endif(NOT FOUND)
  endforeach(ITEM ${ARGN})

  set("${LIST}" "${RESULT}" PARENT_SCOPE)
endfunction(ADD_UNIQUE LIST)

##
## symlink <TARGET> <SYMLINK-PATH>
##
macro(SYMLINK TARGET LINK_NAME)
  install(
    CODE "message(\"Create symlink '$ENV{DESTDIR}${LINK_NAME}' to '${TARGET}'\")\nexecute_process(COMMAND ${CMAKE_COMMAND} -E create_symlink ${TARGET} $ENV{DESTDIR}${LINK_NAME})"
  )
endmacro(SYMLINK TARGET LINK_NAME)

##
## rpath_append <VARIABLE-NAME>
##
macro(RPATH_APPEND VAR)
  foreach(VALUE ${ARGN})
    if("${${VAR}}" STREQUAL "")
      set(${VAR} "${VALUE}")
    else("${${VAR}}" STREQUAL "")
      set(${VAR} "${CMAKE_INSTALL_RPATH}:${VALUE}")
    endif("${${VAR}}" STREQUAL "")
  endforeach(VALUE ${ARGN})
endmacro(RPATH_APPEND VAR)

##
## try_code <FILENAME> <CODE> <RESULT-VARIABLE> <OUTPUT-VARIABLE> <LIBS> <LINKER-FLAGS>
##
function(TRY_CODE FILE CODE RESULT_VAR OUTPUT_VAR LIBS LDFLAGS)
  if(NOT DEFINED "${RESULT_VAR}" OR NOT DEFINED "${OUTPUT_VAR}")
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/${FILE}" "${CODE}")

    try_compile(
      RESULT "${CMAKE_CURRENT_BINARY_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/${FILE}" CMAKE_FLAGS "${CMAKE_REQUIRED_FLAGS}"
      COMPILE_DEFINITIONS "${CMAKE_REQUIRED_DEFINITIONS}" LINK_OPTIONS "${LDFLAGS}" LINK_LIBRARIES "${LIBS}"
      OUTPUT_VARIABLE OUTPUT)

    set(${RESULT_VAR} "${RESULT}" PARENT_SCOPE)
    set(${OUTPUT_VAR} "${OUTPUT}" PARENT_SCOPE)
  endif(NOT DEFINED "${RESULT_VAR}" OR NOT DEFINED "${OUTPUT_VAR}")
endfunction()

##
## check_external <NAME> <LIBS> <LINKER-FLAGS> <OUTPUT-VARIABLE>
##
function(CHECK_EXTERNAL NAME LIBS LDFLAGS OUTPUT_VAR)
  try_code("test-${NAME}.c" "\n  extern int ${NAME}(void);\n  int main() {\n    ${NAME}();\n    return 0;\n  }\n  "
           "${OUTPUT_VAR}" OUT "${LIBS}" "${LDFLAGS}")
  #dump(OUTPUT_VAR OUT)
endfunction(CHECK_EXTERNAL NAME LIBS LDFLAGS OUTPUT_VAR)

##
## run_code <FILENAME> <CODE> <RESULT-VARIABLE> <OUTPUT-VARIABLE> <LIBS> <LINKER-FLAGS>
##
function(RUN_CODE FILE CODE RESULT_VAR OUTPUT_VAR LIBS LDFLAGS)
  string(RANDOM LENGTH 8 RND)
  set(FN "${CMAKE_CURRENT_BINARY_DIR}/${RND}-${FILE}")
  file(WRITE "${FN}" "${CODE}")
  string(REGEX REPLACE "\.[^./]+$" ".log" LOG "${FN}")

  try_run(RUN_RESULT COMPILE_RESULT SOURCES "${FN}" COMPILE_OUTPUT_VARIABLE COMPILE_OUTPUT
          RUN_OUTPUT_VARIABLE RUN_OUTPUT CMAKE_FLAGS "${CMAKE_REQUIRED_FLAGS}"
          COMPILE_DEFINITIONS "${CMAKE_REQUIRED_DEFINITIONS}" LINK_OPTIONS "${LDFLAGS}" LINK_LIBRARIES "${LIBS}")

  file(WRITE "${LOG}" "Compile output:\n${COMPILE_OUTPUT}\n\nRun output:\n${RUN_OUTPUT}\n")
  unset(LOG)

  set(${RESULT_VAR} "${COMPILE_RESULT}" PARENT_SCOPE)
  set(${OUTPUT_VAR} "${COMPILE_OUTPUT}" PARENT_SCOPE)

  file(REMOVE "${FN}")

  if(COMPILE_RESULT)
    if(NOT "${RUN_RESULT}" STREQUAL "")
      set(${RESULT_VAR} "${RUN_RESULT}" PARENT_SCOPE)
    endif(NOT "${RUN_RESULT}" STREQUAL "")
    if(NOT "${RUN_OUTPUT}" STREQUAL "")
      set(${OUTPUT_VAR} "${RUN_OUTPUT}" PARENT_SCOPE)
    endif(NOT "${RUN_OUTPUT}" STREQUAL "")
  endif(COMPILE_RESULT)

  file(REMOVE "${FN}")
  unset(FN)
  unset(RND)
endfunction()

##
## libname <OUTPUT-VARIABLE> <FILENAME>
##
function(LIBNAME OUT_VAR FILENAME)
  string(REGEX REPLACE ".*/(lib|)" "" LIBNAME "${FILENAME}")
  string(REGEX REPLACE "\.[^/.]+$" "" LIBNAME "${LIBNAME}")

  set(${OUT_VAR} "${LIBNAME}" PARENT_SCOPE)
endfunction(LIBNAME OUT_VAR FILENAME)


#
# append_vars <STR> <VARS...>: append STR to each space-separated variable
#
macro(append_vars STR)
  foreach(L ${ARGN})
    set(LIST "${${L}}")
    if(NOT LIST MATCHES ".*${STR}.*")
      if("${LIST}" STREQUAL "")
        set(LIST "${STR}")
      else()
        set(LIST "${LIST} ${STR}")
      endif()
    endif()
    string(REPLACE ";" " " LIST "${LIST}")
    set("${L}" "${LIST}" PARENT_SCOPE)
  endforeach()
endmacro()

#
# check_flag <FLAG> <VAR> [FLAG-VARS...]: if the compiler takes FLAG, add it to FLAG-VARS
#
function(check_flag FLAG VAR)
  if(NOT VAR OR VAR STREQUAL "")
    string(TOUPPER "${FLAG}" TMP)
    string(REGEX REPLACE "[^0-9A-Za-z]" _ VAR "${TMP}")
  endif()

  set(CMAKE_REQUIRED_QUIET ON)
  check_c_compiler_flag("${FLAG}" "${VAR}")
  set(CMAKE_REQUIRED_QUIET OFF)

  if(${VAR})
    append_vars(${FLAG} ${ARGN})
    message(STATUS "Compiler flag ${FLAG}: supported")
  else()
    message(STATUS "Compiler flag ${FLAG}: not supported")
  endif()
endfunction()

macro(check_flags FLAGS)
  foreach(FLAG ${FLAGS})
    check_flag(${FLAG} "" ${ARGN})
  endforeach()
endmacro()

#
# nowarn_flag <FLAG>: add a -Wno-* flag to C and C++ flags when supported (silently)
#
macro(nowarn_flag FLAG)
  canonicalize(VARNAME "${FLAG}")
  set(CMAKE_REQUIRED_QUIET ON)
  check_c_compiler_flag("${FLAG}" "${VARNAME}")
  set(CMAKE_REQUIRED_QUIET OFF)

  if(${VARNAME})
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${FLAG}")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${FLAG}")
  endif()
endmacro()

macro(add_nowarn_flags)
  string(REGEX REPLACE " -Wall" "" CMAKE_C_FLAGS "${CMAKE_C_FLAGS}")
  string(REGEX REPLACE " -Wall" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")

  nowarn_flag(-Wno-unused-value)
  nowarn_flag(-Wno-unused-variable)

  if("${CMAKE_CXX_COMPILER_ID}" MATCHES ".*Clang.*")
    nowarn_flag(-Wno-deprecated-anon-enum-enum-conversion)
    nowarn_flag(-Wno-extern-c-compat)
    nowarn_flag(-Wno-implicit-int-float-conversion)
    nowarn_flag(-Wno-deprecated-enum-enum-conversion)
  endif()
endmacro()

#
# message_table <TITLE> [KEY VALUE]...
#
# One status line for TITLE, then the rows aligned under it; rows with an
# empty value are left out, a list value goes one item to a line.
#
#   -- QuickJS
#   --   interpreter  /usr/local/bin/qjs
#   --   library      /usr/local/lib/libquickjs.so
#
function(message_table TITLE)
  set(WIDTH 0)
  math(EXPR LAST "${ARGC} - 1")

  foreach(I RANGE 1 ${LAST} 2)
    string(LENGTH "${ARGV${I}}" LEN)
    if(LEN GREATER WIDTH)
      set(WIDTH ${LEN})
    endif()
  endforeach()

  message(STATUS "${TITLE}")

  foreach(I RANGE 1 ${LAST} 2)
    math(EXPR J "${I} + 1")
    set(KEY "${ARGV${I}}")
    set(VALUE "${ARGV${J}}")

    if(NOT VALUE STREQUAL "")
      string(LENGTH "${KEY}" LEN)
      while(LEN LESS WIDTH)
        set(KEY "${KEY} ")
        math(EXPR LEN "${LEN} + 1")
      endwhile()

      set(PAD "")
      string(REGEX REPLACE "." " " PAD "${KEY}")

      set(FIRST TRUE)
      foreach(ITEM ${VALUE})
        if(FIRST)
          message(STATUS "  ${KEY}  ${ITEM}")
          set(FIRST FALSE)
        else()
          message(STATUS "  ${PAD}  ${ITEM}")
        endif()
      endforeach()
    endif()
  endforeach()
endfunction()

##
## project-specific helpers
##
include(CheckFunctionExists)
include(CheckIncludeFile)

##
## check_function_def <FUNCTION NAME> [RESULT VARIABLE] [PREPROC_DEF]
##
macro(CHECK_FUNCTION_DEF FUNC)
  if(${ARGC} GREATER 1)
    set(RESULT_VAR "${ARGV1}")
  else(${ARGC} GREATER 1)
    string(TOUPPER "HAVE_${FUNC}" RESULT_VAR)
  endif(${ARGC} GREATER 1)

  if(${ARGC} GREATER 2)
    set(PREPROC_DEF "${ARGV2}")
  else(${ARGC} GREATER 2)
    string(TOUPPER "HAVE_${FUNC}" PREPROC_DEF)
  endif(${ARGC} GREATER 2)

  if(NOT DEFINED ${RESULT_VAR})
    check_function_exists("${FUNC}" "_${RESULT_VAR}")

    if(${_${RESULT_VAR}})
      set("${RESULT_VAR}" TRUE
          CACHE INTERNAL "Define this if you have the '${FUNC}' function")
    else(${_${RESULT_VAR}})
      set("${RESULT_VAR}" FALSE
          CACHE INTERNAL "Define this if you have the '${FUNC}' function")
    endif(${_${RESULT_VAR}})
  endif(NOT DEFINED ${RESULT_VAR})

  set(DEFINE FALSE)

  if(${${RESULT_VAR}})
    if(NOT "${PREPROC_DEF}" STREQUAL "")
      set("${PREPROC_DEF}" "1")
      var2define("${PREPROC_DEF}" 1)
    endif(NOT "${PREPROC_DEF}" STREQUAL "")
  endif(${${RESULT_VAR}})

  #message("${RESULT_VAR}: ${${RESULT_VAR}}")

  list(APPEND CHECKED_FUNCTIONS "${FUNC}")
endmacro(CHECK_FUNCTION_DEF FUNC)

##
## check_functions <FUNCTION NAMES...>
##
macro(CHECK_FUNCTIONS)
  foreach(FUNC ${ARGN})
    string(TOUPPER "HAVE_${FUNC}" RESULT_VAR)
    check_function_def("${FUNC}" "${RESULT_VAR}")
  endforeach(FUNC ${ARGN})
endmacro(CHECK_FUNCTIONS)

##
## check_functions_def <FUNCTION NAMES...>
##
macro(CHECK_FUNCTIONS_DEF)
  foreach(FUNC ${ARGN})
    check_function_def("${FUNC}")
  endforeach(FUNC ${ARGN})
endmacro(CHECK_FUNCTIONS_DEF)

##
## clean_name <STRING> <OUTPUT VAR>
##
function(CLEAN_NAME STR OUTPUT_VAR)
  string(TOUPPER "${STR}" STR)
  string(REGEX REPLACE "[^A-Za-z0-9_]" "_" STR "${STR}")
  set("${OUTPUT_VAR}" "${STR}" PARENT_SCOPE)
endfunction(CLEAN_NAME STR OUTPUT_VAR)

##
## check_include_def <INCLUDE> [RESULT VARIABLE] [PREPROC_DEF]
##
macro(CHECK_INCLUDE_DEF INC)
  if(ARGC GREATER_EQUAL 2)
    set(RESULT_VAR "${ARGV1}")
    set(PREPROC_DEF "${ARGV2}")
  else(ARGC GREATER_EQUAL 2)
    clean_name("${INC}" INC_D)
    string(TOUPPER "HAVE_${INC_D}" RESULT_VAR)
    string(TOUPPER "HAVE_${INC_D}" PREPROC_DEF)
  endif(ARGC GREATER_EQUAL 2)

  check_include_file("${INC}" "${RESULT_VAR}")

  if(${${RESULT_VAR}})
    set("${RESULT_VAR}" TRUE
        CACHE INTERNAL "Define this if you have the '${INC}' header file")

    if(NOT "${PREPROC_DEF}" STREQUAL "")
      var2define("${PREPROC_DEF}" 1)
    endif(NOT "${PREPROC_DEF}" STREQUAL "")
  endif(${${RESULT_VAR}})

  list(APPEND CHECKED_INCLUDES "${INC}")
endmacro(CHECK_INCLUDE_DEF INC)

##
## check_includes <INCLUDE FILES...>
##
macro(CHECK_INCLUDES)
  foreach(INC ${ARGN})
    clean_name("HAVE_${INC}" RESULT_VAR)
    check_include_def("${INC}" "${RESULT_VAR}")
  endforeach(INC ${ARGN})
endmacro(CHECK_INCLUDES)

##
## check_includes_def <INCLUDE FILES...>
##
macro(CHECK_INCLUDES_DEF)
  foreach(INC ${ARGN})
    check_include_def("${INC}")
  endforeach(INC ${ARGN})
endmacro(CHECK_INCLUDES_DEF)

##
## check_function_and_include <FUNCTION> <INCLUDE>
##
macro(CHECK_FUNCTION_AND_INCLUDE FUNC INC)
  clean_name("HAVE_${INC}" INC_RESULT)
  clean_name("HAVE_${FUNC}" FUNC_RESULT)

  check_include_def("${INC}" "${INC_RESULT}" "${INC_RESULT}")

  if(${${INC_RESULT}})
    check_function_def("${FUNC}" "${FUNC_RESULT}" "${FUNC_RESULT}")
  endif(${${INC_RESULT}})
endmacro(CHECK_FUNCTION_AND_INCLUDE FUNC INC)


function(DEBUG)
  set(S "")
  foreach(ARG ${ARGN})
    set(S "${S} ${ARG}")
  endforeach(ARG ${ARGN})
  message("${S}")
endfunction(DEBUG)
