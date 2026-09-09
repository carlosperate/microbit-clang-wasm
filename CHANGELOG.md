# Changelog

## 21.11.0-alpha.1

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
(whitequark), which this repository is a fork of. Its history, releases and changelog live there.
