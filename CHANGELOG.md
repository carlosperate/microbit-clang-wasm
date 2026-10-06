# Changelog

Releases are named after the packaging revision in `config.json`, because one release can publish an
npm package per LLVM line. The versions each one published are listed under it.

## v0-alpha.3 - Unreleased

- `readCompletions` reads what Clang prints when asked to complete at a position into records,
  so an editor can offer completions from the compiler itself.
- Virtual filesystem fix: Compiling again to an output that already exists replaces it.
  Before, the old file was kept and the tool still reported success,
  so a rebuild could link stale objects.
- Virtual filesystem fix: `..` in a path is resolved, so `#include "../include/util.h"` finds its
  file as a native build does.
- Virtual filesystem fix: Large outputs written to files are faster.

## v0-alpha.2 - 2026/10/01

Published `microbit-clang-wasm@21.11.0-alpha.2`.

- `readDiagnostics` reads what Clang and LLD print into records, with the file, line and column,
  the warning option, the notes and the include chain, so an editor can show each error at the line
  it belongs to. Checked on every CI build against the compiler that build has just made.
- Every CI build checks that the packaged compiler turns the same source and flags into the same
  object as Arm's own Clang, byte for byte, for a C++ unit with CODAL's flags and a C unit against
  newlib.
- The npm package is also attached to its GitHub release.

## v0-alpha.1 - 2026/09/10

Published `microbit-clang-wasm@21.11.0-alpha.1`.

First release of this fork: Clang, LLD and the LLVM binutils as WebAssembly, for the BBC micro:bit.

- Compiles for the micro:bit's Cortex-M4 instead of for WebAssembly, built from
  [Arm Toolchain for Embedded](https://github.com/arm/arm-toolchain) 21.1.1.
- Ships Arm's C and C++ libraries and headers for that chip, so `--sysroot=/usr` is all a build
  needs. No configuration files, no multilib.
- Produces a hex byte for byte identical to the one Arm's own Clang produces.
- `setAssetLoader` lets the host hand over the compiler and the libraries by name, for a VS Code
  extension or anything else that cannot fetch a URL.
- `createSession` keeps one filesystem across commands, so a build of many files unpacks the
  libraries once. Editing a file and rebuilding takes 0.6 s rather than 1.7 s.
- Adds `ld.lld`, the linker an Arm target needs.
- Alpha while the packaging settles, so it is published under the `llvm-21` tag on npm and not
  under `latest`.

## Before this fork

Everything up to commit `ab5516d` is [YoWASP/clang](https://codeberg.org/YoWASP/clang) by Catherine
(whitequark), which this repository is a fork of.
Its history, releases and changelog live there.
