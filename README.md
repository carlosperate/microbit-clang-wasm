# microbit-clang-wasm

A fork of [YoWASP/clang](https://codeberg.org/YoWASP/clang) by Catherine (whitequark), which builds
Clang and LLD as WebAssembly so they can run in a browser or in Node.

**The goal of this fork:** make that compiler build BBC micro:bit programs. The browser equivalent
of installing `arm-none-eabi-gcc`, so CODAL is not in here, this package is wrapped with CODAL in 
[microbit-clang-wasm-codal](https://github.com/carlosperate/microbit-clang-wasm-codal), and the
VS Code extension in [vscode-microbit-cpp](https://github.com/carlosperate/vscode-microbit-cpp).

Status: pre-release, still work-in-progress. Nothing is published yet.

## What we changed from the upstream YoWASP/clang

- Compiler targets Arm, not WebAssembly. Upstream builds a compiler that targets WebAssembly, this
  one targets Arm and includes the libraries specific to the micro:bit's Cortex-M4f.
- **It ships Arm's libraries.** Upstream includes a C and C++ library for WebAssembly; we include
  [Arm Toolchain for Embedded](https://github.com/arm/arm-toolchain)'s newlib-nano, libc++ and
  compiler-rt for the micro:bit's processor instead.
- **It exposes `ld.lld`**, the linker used for Arm programs, next to upstream's `wasm-ld`.
- **It builds LLVM from Arm's release**, not from plain LLVM, so the code it generates matches the
  toolchain we compare against. Upstream's one WebAssembly fix is kept in `patches/` and applied
  during the build.
- **Assertions are off**, which makes the binary smaller and faster.

## Building

Needs Linux, and **at least 16 GB of memory**: compiling is modest, but the final link is one LTO
process that needs a lot and will take a container host down with it if starved. A cold build takes
hours, because it compiles all of LLVM.

You supply one thing, the Arm sysroot. Everything else — the LLVM source at the pinned commit, the
wasi-sdk, the build directories, ccache — `build.sh` fetches or creates inside the repository.

```sh
ATFE_SYSROOT=<Arm sysroot: include/ and lib/> ./build.sh          # newest supported version
ATFE_SYSROOT=... ./build.sh 22.1.0                                # or pick one
MAKEFLAGS=-j8 ATFE_SYSROOT=... ./build.sh                         # job count, if not all cores
```

Drop the sysroot in `./atfe-sysroot` and `ATFE_SYSROOT` can be omitted. `ls patches/` is the list of
versions that can be built; `Dockerfile` lists the packages `build.sh` needs.

Anywhere without Linux, `build-with-docker.sh` provides the environment and runs the same
`build.sh`, taking the same arguments (or podman, with `DOCKER=podman`):

```sh
ATFE_SYSROOT=<Arm sysroot> ./build-with-docker.sh 22.1.0
```

Then `./package-npmjs.sh` builds the npm package.

## Licences

The compiler is LLVM (Apache-2.0 with LLVM exception). The packaging comes from YoWASP/clang. The
libraries come from Arm Toolchain for Embedded and keep their own notices. Upstream declares ISC in
its package but ships an Apache-2.0 `LICENSE.txt`; that needs settling before we publish.
