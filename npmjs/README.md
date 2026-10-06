# micro:bit Clang/LLD WebAssembly package

Clang, LLD and the LLVM binutils as one WebAssembly binary that targets the
[BBC micro:bit][]'s Cortex-M4, packaged with [Arm Toolchain for Embedded][atfe]'s
newlib-nano, libc++ and compiler-rt for that CPU. Runs in a browser, in Node
and inside VS Code, and downloads nothing at runtime.

This is the compiler and its libraries, and readers for what they print: the
browser equivalent of installing `arm-none-eabi-gcc`. It knows nothing about
CODAL; for that, see [`microbit-clang-wasm-codal`][codal].

The API runs the tools in a virtual filesystem and provides no executables.
Files go in and come back out as a tree of `Uint8Array`s. If you import
`.../gen/bundle.js` directly, use it as a module.

```js
import { commands } from 'microbit-clang-wasm';

const files = await commands['clang++'](
    ['-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=softfp',
     '--sysroot=/usr', '-c', 'main.cpp', '-o', 'main.o'],
    { 'main.cpp': 'int main() { return 0; }' },
);
```

`commands` covers `clang`, `clang++`, `ld.lld`, `wasm-ld`, `ar`, `ranlib`, `objcopy`, `objdump`,
`strip`, `nm`, `readobj`, `size`, `c++filt`, `addr2line`, `symbolizer` and `dwarfdump`. The sysroot
travels with the package and is mounted at `/usr`; pass `--sysroot=/usr` explicitly rather than
relying on a configuration file, which has no meaningful location in a virtual filesystem.

`readDiagnostics(output)` turns what one run of `clang`, `clang++` or `ld.lld` wrote to stderr into
records, for an editor to put errors where they belong: file, line, column (in bytes, as Clang counts
them), severity, message, the warning option such as `-Wunused-variable`, the notes, the include
chain, and the text printed for each. Lines it does not recognise come back as text, and joining
every record's `text` gives the output back unchanged.

```js
import { readDiagnostics } from 'microbit-clang-wasm';

for (const record of readDiagnostics(stderr)) {
    if (!record.severity) continue; // a summary line, or text that is no diagnostic
    // The linker and the driver name no file.
    const where = record.file ? `${record.file}:${record.line}: ` : '';
    console.log(`${where}${record.severity}: ${record.message}`);
}
```

`readCompletions(output)` reads what Clang prints on stdout when asked to complete at a position,
with `-fsyntax-only -Xclang -code-completion-at=<file>:<line>:<column>`, for an editor's completion
list. Each candidate comes with its name, whether it is inherited, overridden or private from there,
its completion string in pieces (text, result type, the arguments to type and the optional ones
with their defaults) and, with `-Xclang -code-completion-brief-comments`, the first sentence of its
documentation. Keywords, patterns such as `sizeof(…)`, the overloads of a call the position is in
and the type expected there are records of their own. The column counts bytes.

```js
import { readCompletions } from 'microbit-clang-wasm';

for (const record of readCompletions(stdout)) {
    if (record.kind === 'candidate' && !record.tags.includes('Inaccessible')) {
        console.log(record.name, record.brief ?? '');
    }
}
```

Derived from [YoWASP/clang][yowasp] by Catherine (whitequark), which does the hard part of building
LLVM for WASI. The compiler is LLVM under Apache-2.0 with LLVM exception; the runtime libraries carry
Arm Toolchain for Embedded's own notices, libc++ and compiler-rt under Apache-2.0 with LLVM exception
and newlib under several BSD-style notices.

[BBC micro:bit]: https://microbit.org/
[atfe]: https://github.com/arm/arm-toolchain
[codal]: https://github.com/carlosperate/microbit-clang-wasm-codal
[yowasp]: https://codeberg.org/YoWASP/clang
