# microbit-clang-wasm

A fork of [YoWASP/clang](https://codeberg.org/YoWASP/clang) by Catherine (whitequark), which builds
Clang and LLD as WebAssembly so they can run in a browser or in Node.

**The goal of this fork:** make the compiler build BBC micro:bit programs. The browser equivalent
of installing `arm-none-eabi-gcc`, so CODAL is not in here, this package is wrapped with CODAL in 
[microbit-clang-wasm-codal](https://github.com/carlosperate/microbit-clang-wasm-codal), and a
VS Code extension created in [vscode-microbit-cpp](https://github.com/carlosperate/vscode-microbit-cpp).

🚧 Status: pre-release, still work-in-progress. Nothing is published yet.

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

## Versioning scheme

The package version follows `MAJOR.MINOR.PATCH`, but it combines the LLVM version with the version
of this package's own JavaScript and build scripts, where:

- MAJOR is the LLVM major version
- MINOR is the LLVM minor and patch versions joined as one number: LLVM 21.1.1 → `11`
- PATCH is a single number for the packaging: the JavaScript, the build scripts, the sysroot

```
    21 . 11 . 3 [-alpha.1]
    └┬┘  └┬┘  └┬┘   └┬┘
     │    │    │     └── optional, while the packaging is still settling
     │    │    └── packaging version
     │    └─────── LLVM minor.patch (1.1)
     └──────────── LLVM major
```

So `~21.11.0` locks to Arm Toolchain for Embedded 21.1.1 while taking packaging fixes, and `^21.10.0`
takes any 21.x. What is inside is also recorded: `npm view microbit-clang-wasm llvm`.

Until the packaging settles, `config.json`'s `prerelease` adds a semver prerelease part, so
`21.11.0-alpha.1` is the first attempt at packaging revision 0. Those can be published and
superseded without spending a revision number; clear the key for a real release.

Everything is defined once, in `config.json`: the LLVM lines with their tags and commits, which one
`build.sh` builds by default, the wasi-sdk pin, `revision`, the packaging number — one number for
the whole repository, since the same JavaScript builds every line — and `prerelease`. To release,
bump `revision` and push a tag: CI builds every line and publishes `21.11.3`, `22.10.3`, … each
under the dist-tag `llvm-<major>`; versions already on npm are skipped. `latest` is moved by hand,
which is also what keeps it off a prerelease.

## Building

Needs Linux, and **at least 16 GB of memory**, mostly due to the final LTO process that needs a
lot of memory and will take a container host down with it if starved. A cold build could take an
hour, as it compiles all of LLVM.

One thing needs to be supplied, the Arm sysroot. Everything else, the LLVM source at the pinned
commit, the wasi-sdk, the build directories, ccache is fetched by `build.sh` or is created inside
the repository.

```sh
./atfe-sysroot.sh <unpacked ATfE release>                         # assembles ./atfe-sysroot
./build.sh                                                        # config.json's default version
./build.sh 22.1.0                                                 # or pick one
MAKEFLAGS=-j8 ./build.sh                                          # job count, if not all cores
STAGE=tblgen ./build.sh                                           # native generators only
```

`atfe-sysroot.sh` takes the LLVM release Arm publishes, plus its newlib-nano overlay, and lays out
the one variant we ship, with the notices that have to travel with those libraries. Put the result
somewhere else and pass it as `ATFE_SYSROOT`. `config.json` lists the versions that can be built,
each with its patches under `patches/<tag>/`; `Dockerfile` lists the packages `build.sh` needs.

`STAGE` splits the build in two, the native code generators and the WebAssembly compiler that needs
them. CI runs them as separate jobs so that neither approaches GitHub's six-hour limit on a cold
build; locally the default builds both.

Alternatively `build-with-docker.sh` uses Docker (or podman, with `DOCKER=podman`) to provide the
Linux environment and runs the same `build.sh`, taking the same arguments:

```sh
ATFE_SYSROOT=<Arm sysroot> ./build-with-docker.sh 22.1.0
```

Then `./package-npmjs.sh` builds the npm package.

## Using the package

```js
import { commands, setAssetLoader } from 'microbit-clang-wasm';

const objects = await commands['clang++'](['--target=arm-none-eabi', '-c', 'main.cpp'], { 'main.cpp': source });
```

Files in, files out. `commands` covers `clang`, `clang++`, `ld.lld` and the binutils.
The sysroot is inside the package and is reached with `--sysroot=/usr`.

The files are a plain object keyed by filename, where a nested object is a directory and a file is
either a **string** or a **`Uint8Array`**.
The result has the same shape: a file comes back as a string if its contents are ASCII, otherwise
a `Uint8Array`, unless `{ decodeASCII: false }` is passed, which is faster over a large tree and always gives bytes.
A command that fails throws `Exit`, carrying its `code` and the `files` it did produce.

Every invocation rebuilds that whole tree, which costs more than a small compile once a sysroot and
a source bundle are in it. For a build of many files use a session, which keeps one filesystem:

```js
import { createSession } from 'microbit-clang-wasm';

const session = createSession();
await session.writeFile('main.cpp', source);        // or writeTree({ src: { ... } })
const code = await session.clang(['clang++', '--target=arm-none-eabi', '-c', 'main.cpp', '-o', 'main.o'],
                                 { stderr: (bytes) => ... });
const object = await session.readFile('main.o');    // Uint8Array, or null
```

`session.clang` runs the compiler driver and replays the sub-commands it reports, since it cannot
start subprocesses here. `session.exec` runs any other tool. Both resolve to an exit code rather
than throwing.

The generated loader resolves each asset as a URL relative to itself and fetches it, which a VS Code
extension host cannot do. `setAssetLoader` lets the host supply those bytes by name instead, from
`vscode.workspace.fs`, the filesystem, or anywhere else. Set it before the first command, which is
when the assets are read:

```js
setAssetLoader((name) => readFile(new URL(name, assetsDirectory)));   // llvm.core.wasm, llvm-resources.tar, ...
```

## Licences

[LICENSES](LICENSES) describes each shipped component.
The compiler is LLVM (Apache-2.0 with LLVM exception), the packaging comes from YoWASP/clang (ISC),
and the libraries come from Arm Toolchain for Embedded, whose own notices ship inside the package
at `usr/share/licenses`.
