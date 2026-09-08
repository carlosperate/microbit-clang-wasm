#!/bin/sh -ex
#
# Provides a Linux environment for build.sh and nothing else: no build decisions live here. The
# repository is mounted read-write and build.sh runs unchanged, so the tree ends up exactly as a
# native `./build.sh` would leave it. On Linux, just run ./build.sh directly.
#
# Usage:  ATFE_SYSROOT=<flat ATfE sysroot> ./build-with-docker.sh [llvm version]
#         MAKEFLAGS=-j8 ./build-with-docker.sh     # forwarded if set
#         DOCKER=podman ./build-with-docker.sh

DOCKER=${DOCKER:-docker}
REPO=$(cd "$(dirname "$0")" && pwd)
SYSROOT=$(cd "${ATFE_SYSROOT:-${REPO}/atfe-sysroot}" && pwd) # bind mounts need absolute paths

"${DOCKER}" build -t microbit-clang-wasm "${REPO}"

# --user keeps the output owned by the caller rather than root, which matters on Linux; that user has
# no passwd entry in the container, hence HOME.
exec "${DOCKER}" run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${REPO}":/work -w /work -e HOME=/work \
  -v "${SYSROOT}":/atfe-sysroot:ro -e ATFE_SYSROOT=/atfe-sysroot \
  -e MAKEFLAGS -e LLVM_VERSION \
  microbit-clang-wasm ./build.sh "$@"
