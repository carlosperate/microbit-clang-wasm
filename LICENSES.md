# Licences of the shipped components

This package brings together several projects' work, so no single licence covers it.
`package.json` says `SEE LICENSE IN LICENSES.md` and points here. Every project's own notice ships
with it, as listed at the end.

## This repository's own files

**Apache-2.0**, the text in `LICENSE.txt` at the root, as in the upstream YoWASP/clang repository
this is a fork of. That covers the build scripts, the JavaScript in `npmjs/lib/`, the tests and the
CI workflow. Code that came from YoWASP/clang keeps Catherine's (whitequark) copyright.

## Apache-2.0 with LLVM exception

- **LLVM: Clang, LLD and the LLVM binutils**, compiled to WebAssembly as `gen/llvm.core.wasm` from
  [`arm/arm-toolchain`](https://github.com/arm/arm-toolchain) at an Arm Toolchain for Embedded
  (ATfE) release tag.
- **Clang's builtin headers**, under `lib/clang/<version>/include`, from the same LLVM build.
- **libc++, libc++abi, libunwind and compiler-rt**: the C++ standard library, its ABI support, stack
  unwinding and the compiler's runtime helpers, from the same ATfE release.
- **jco**, by the Bytecode Alliance, which turns the compiler into a WebAssembly component: the three
  small modules `gen/llvm.core2.wasm` to `gen/llvm.core4.wasm`, and the loader it generates inside
  `gen/bundle.js`.
- **The WASI patch** in `patches/*/*.patch`, a commit from YoWASP's LLVM fork and so LLVM code. It is
  applied at build time and does not ship as a file.

## BSD-style notices

- **newlib-nano**: the C library (`libc.a`, `libg.a`) and the maths library (`libm.a`).
- **libgloss**: the start-up code and system stubs, `crt0.o`, `libnosys.a`, `librdimon.a` and
  their relatives.

These are not one licence but a collection of BSD-style and similar permissive notices, one per
contributor's code: Arm's `COPYING.NEWLIB` alone carries 57 of them.

## ISC

- **[YoWASP/clang](https://codeberg.org/YoWASP/clang)** by Catherine (whitequark), whose npm package
  declares ISC: the packaging that `gen/bundle.js` and `lib/api.d.ts` grew from.
- **[`@yowasp/runtime`](https://www.npmjs.com/package/@yowasp/runtime)**, by the same author,
  bundled into `gen/bundle.js`.

## Where the notices are

- `LICENSE.txt`, beside this file: Apache-2.0.
- `share/licenses/` inside `gen/llvm-resources.tar`, which the package mounts at
  `/usr/share/licenses`: Arm's own notice files for every library, as ATfE ships them. They include
  the LLVM, Clang, LLD, libc++, libc++abi, libunwind and compiler-rt licences with the LLVM
  exception, `COPYING.NEWLIB`, `COPYING.LIBGLOSS` and Arm's `THIRD-PARTY-LICENSES.txt`.
