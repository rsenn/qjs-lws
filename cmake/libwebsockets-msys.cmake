# Included right after project() of libwebsockets (via
# CMAKE_PROJECT_libwebsockets_INCLUDE) when targeting MSYS/Cygwin.
# The headers pick the plat/unix code there (no _WIN32 macro), so the
# CMakeLists must too: present the target as a POSIX one.
set(WIN32 FALSE)
set(UNIX TRUE)
set(CYGWIN TRUE)
