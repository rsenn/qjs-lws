# scratch project for test-check-cflag.js: probes three flags in a row and
# prints "PROBE <flag> <result>" for each
cmake_minimum_required(VERSION 3.10)
project(check_cflag_probe C)

include(CheckCCompilerFlag)
include("${CHECKS_DIR}/Functions.cmake")
include("${CHECKS_DIR}/Checks.cmake")

foreach(flag -fnonexistent-flag-for-test -O0 -g)
  check_cflag("${flag}" OK)
  message(STATUS "PROBE ${flag} ${OK}")
endforeach()
