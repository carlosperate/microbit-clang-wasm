#!/bin/sh -ex
#
# Provides a Linux environment for build.sh and nothing else: no build decisions live here. The
# repository is mounted read-write and build.sh runs unchanged, so the tree ends up exactly as a
# native `./build.sh` would leave it. On Linux, just run ./build.sh directly.
#
# Usage:  ATFE_SYSROOT=<flat ATfE sysroot> ./build-with-docker.sh [llvm version]
#         MAKEFLAGS=-j8 STAGE=tblgen ./build-with-docker.sh     # both forwarded if set
#         DOCKER=podman ./build-with-docker.sh

DOCKER=${DOCKER:-docker}
REPO=$(cd "$(dirname "$0")" && pwd)

# build.sh takes the version as its first argument or from LLVM_VERSION; the latter crosses into the
# container without any argument list to keep quoted.
if [ $# -gt 0 ]; then
  LLVM_VERSION=$1
  export LLVM_VERSION
fi

# The sysroot is only needed for the WebAssembly stage; bind mounts need absolute paths. Held in the
# positional parameters, the only list a POSIX shell can pass on without breaking on a space.
set --
if [ "${STAGE:-all}" != tblgen ]; then
  SYSROOT=$(cd "${ATFE_SYSROOT:-${REPO}/atfe-sysroot}" && pwd)
  set -- -v "${SYSROOT}":/atfe-sysroot:ro -e ATFE_SYSROOT=/atfe-sysroot
fi

"${DOCKER}" build -t microbit-clang-wasm "${REPO}"

# --user keeps the output owned by the caller rather than root, which matters on Linux; that user has
# no passwd entry in the container, hence HOME.
exec "${DOCKER}" run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${REPO}":/work -w /work -e HOME=/work \
  "$@" \
  -e MAKEFLAGS -e LLVM_VERSION -e STAGE -e CCACHE_MAXSIZE \
  microbit-clang-wasm ./build.sh
