// Smoke test for the packaged toolchain, run by CI against the packed tarball.
//
// Upstream's version compiled for WebAssembly and executed the result under node:wasi. This
// compiler targets a Cortex-M4, so the output cannot be run here; the checks are that it is ARM
// code, that the linker is reachable, and that a broken file fails with a useful diagnostic.

const { commands, createSession, readDiagnostics, setAssetLoader } = await import('microbit-clang-wasm');
const { readFile, stat } = await import('node:fs/promises');
const { CPU, cases, produce, verify } = await import('./diagnostics/cases.mjs');
const SYSROOT = '--sysroot=/usr';

// An extension host has no URL to fetch and no filesystem the generated loader can reach, so the
// package has to accept bytes by name. Set before the first command, which is when they are read.
const assets = new URL('.', import.meta.resolve('microbit-clang-wasm'));
const requested = [];
setAssetLoader((name) => {
    requested.push(name);
    return readFile(new URL(name, assets));
});

// Every extension update re-downloads this file, so it is worth failing a build over.
const WASM_BUDGET = 80 * 1024 * 1024;

function check(condition, message) {
    if (!condition) {
        console.error(`FAIL: ${message}`);
        process.exit(1);
    }
    console.log(`ok: ${message}`);
}

const core = await stat(new URL('llvm.core.wasm', assets));
check(core.size <= WASM_BUDGET, `llvm.core.wasm is ${(core.size / 1048576).toFixed(1)} MB, within its ${WASM_BUDGET / 1048576} MB budget`);

// The C and C++ libraries and the Clang builtin headers all have to resolve from the packaged
// sysroot, so the sources below include from all three.
const cOut = await commands['clang'](
    [...CPU, SYSROOT, '-O2', '-c', 'test.c', '-o', 'test.o'],
    { 'test.c': '#include <stdint.h>\n#include <string.h>\nuint32_t len(const char *s) { return strlen(s); }\n' },
);
const cxxOut = await commands['clang++'](
    [...CPU, SYSROOT, '-O2', '-std=c++11', '-fno-exceptions', '-fno-rtti', '-c', 'test.cc', '-o', 'test.o'],
    { 'test.cc': '#include <cstdio>\n#include <cmath>\nint twice(int n) { return n * 2 + (int)sqrtf(4.0f); }\n' },
);

for (const [language, out] of [['C', cOut], ['C++', cxxOut]]) {
    const object = out['test.o'];
    check(object instanceof Uint8Array && object.length > 0, `${language} compiles to an object`);
    const elf = new DataView(object.buffer, object.byteOffset, object.byteLength);
    check(elf.getUint32(0, false) === 0x7f454c46, `${language} object is an ELF file`);
    check(elf.getUint16(18, true) === 40, `${language} object targets ARM (EM_ARM)`);
}

// ld.lld is the ELF flavour of lld, which is what an Arm target links with.
let lldVersion = '';
await commands['ld.lld'](['--version'], {}, { stdout: (bytes) => bytes && (lldVersion += new TextDecoder().decode(bytes)) });
check(/^LLD /.test(lldVersion.trim()), `ld.lld reports a version: ${lldVersion.trim().split('(')[0].trim()}`);

// A driver that cannot be replayed must fail rather than quietly returning its inputs unchanged.
let diagnostics = '';
let failed = false;
try {
    await commands['clang++'](
        [...CPU, SYSROOT, '-c', 'bad.cc', '-o', 'bad.o'],
        { 'bad.cc': 'int main() { return nope; }\n' },
        { stderr: (bytes) => bytes && (diagnostics += new TextDecoder().decode(bytes)) },
    );
} catch (error) {
    failed = error.code !== 0;
}
check(failed, 'a file with an error exits non-zero');
check(/bad\.cc:1:\d+: error:/.test(diagnostics), 'the diagnostic names the file, line and column');

check(requested.includes('llvm.core.wasm'), 'the host asset loader supplied the compiler module');
check(requested.includes('llvm-resources.tar'), 'the host asset loader supplied the sysroot');

// A session keeps one filesystem across commands, so what one tool writes the next one reads.
const session = createSession();
await session.writeFile('session.c', 'int twice(int n) { return n * 2; }\n');
const compiled = await session.clang([...['clang', ...CPU], SYSROOT, '-O2', '-c', 'session.c', '-o', 'session.o'], {});
check(compiled === 0, 'a session compiles a file');

let sizeOutput = '';
const sized = await session.exec(['size', 'session.o'], { stdout: (bytes) => bytes && (sizeOutput += new TextDecoder().decode(bytes)) });
check(sized === 0 && /session\.o/.test(sizeOutput), 'a later command in the session sees the object the first one wrote');

// One environment carries the arguments, so overlapping commands must queue rather than overwrite
// each other's: unserialised, both of these reported success and only one object appeared.
await session.writeFile('one.c', 'int one(void) { return 1; }\n');
await session.writeFile('two.c', 'int two(void) { return 2; }\n');
const both = await Promise.all([
    session.clang(['clang', ...CPU, SYSROOT, '-c', 'one.c', '-o', 'one.o'], {}),
    session.clang(['clang', ...CPU, SYSROOT, '-c', 'two.c', '-o', 'two.o'], {}),
]);
check(both.every((code) => code === 0), 'overlapping session commands both succeed');
check(await session.readFile('one.o') !== null && await session.readFile('two.o') !== null,
      'overlapping session commands each produce their own object');

// The driver leaves scratch files in tmp/ and the session clears them; a caller's own tmp/ must not
// go with them.
await session.writeFile('tmp/keep.c', 'int keep(void) { return 3; }\n');
const kept = await session.clang(['clang', ...CPU, SYSROOT, '-c', 'tmp/keep.c', '-o', 'tmp/keep.o'], {});
check(kept === 0 && (await session.readFile('tmp/keep.c')) !== null && (await session.readFile('tmp/keep.o')) !== null,
      'a caller\'s files under tmp/ survive the driver replay');

// readFile hands out a copy: the sysroot's bytes are shared by every session in the process.
const header = await session.readFile('/usr/include/stdint.h');
header[0] = 0;
check((await session.readFile('/usr/include/stdint.h'))[0] !== 0, 'mutating what readFile returned does not reach the session');

// The driver's -### output arrives in thousands of tiny chunks; a multi-byte character in a file
// name must survive being split across two of them.
await session.writeFile('héllo.c', 'int hello(void) { return 1; }\n');
const accented = await session.clang(['clang', ...CPU, SYSROOT, '-c', 'héllo.c', '-o', 'héllo.o'], {});
check(accented === 0 && (await session.readFile('héllo.o')) !== null, 'a non-ASCII file name survives the driver replay');

let sessionDiagnostics = '';
await session.writeFile('bad.c', 'int main() { return nope; }\n');
const rejected = await session.clang(
    ['clang', ...CPU, SYSROOT, '-c', 'bad.c', '-o', 'bad.o'],
    { stderr: (bytes) => bytes && (sessionDiagnostics += new TextDecoder().decode(bytes)) },
);
check(rejected !== 0 && /error:/.test(sessionDiagnostics), 'a session reports a failure with its diagnostic');

// Clang writes each output to a temporary file and renames it over the old one, which the runtime
// used to drop, keeping the old object with exit code 0.
await session.writeFile('first.c', 'int first(void) { return 1; }\n');
await session.writeFile('second.c', 'int second(void) { return 2; }\n');
await session.clang(['clang', ...CPU, SYSROOT, '-c', 'first.c', '-o', 'again.o'], {});
const again = await session.clang(['clang', ...CPU, SYSROOT, '-c', 'second.c', '-o', 'again.o'], {});
let symbols = '';
await session.exec(['nm', 'again.o'], { stdout: (bytes) => bytes && (symbols += new TextDecoder().decode(bytes)) });
check(again === 0 && /\bsecond\b/.test(symbols) && !/\bfirst\b/.test(symbols), 'compiling again to the same output replaces the object');

// The runtime used to drop `..`, so this include looked for source/include/util.h.
await session.writeFile('source/main.c', '#include "../include/util.h"\nint main(void) { return UTIL; }\n');
await session.writeFile('include/util.h', '#define UTIL 0\n');
const up = await session.clang(['clang', ...CPU, SYSROOT, '-c', 'source/main.c', '-o', 'source/main.o'], {});
check(up === 0, 'an #include through .. finds its file');

// A file arrives in pieces of at most 4 KB, now grown in place rather than copied whole for each.
await session.writeFile('big.c', Array.from({ length: 50000 }, (_, i) => `int value${i} = ${i};\n`).join(''));
let printed = '';
await session.clang(['clang', ...CPU, SYSROOT, '-E', 'big.c'], { stdout: (bytes) => bytes && (printed += new TextDecoder().decode(bytes)) });
await session.clang(['clang', ...CPU, SYSROOT, '-E', 'big.c', '-o', 'big.i'], {});
const written = new TextDecoder().decode(await session.readFile('big.i'));
check(written.length > 1000000 && written === printed, `a ${(written.length / 1048576).toFixed(1)} MB output written to a file is what stdout prints`);

// What this compiler prints, read by the reader packaged with it: each LLVM line's own check.
const reading = createSession();
for (const testCase of cases) {
    let failure = null;
    try {
        verify(testCase, await produce(reading, testCase), readDiagnostics);
    } catch (error) {
        failure = error;
        console.error(error);
    }
    check(failure === null, `the diagnostics reader reads ${testCase.name} as this compiler prints it`);
}

console.log('all checks passed');
