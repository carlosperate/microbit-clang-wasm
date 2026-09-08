// Smoke test for the packaged toolchain, run by CI against the packed tarball.
//
// Upstream's version compiled for WebAssembly and executed the result under node:wasi. This
// compiler targets a Cortex-M4, so the output cannot be run here; the checks are that it is ARM
// code, that the linker is reachable, and that a broken file fails with a useful diagnostic.

const { commands } = await import('microbit-clang-wasm');

const CPU = ['--target=arm-none-eabi', '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=softfp'];
const SYSROOT = '--sysroot=/usr';

function check(condition, message) {
    if (!condition) {
        console.error(`FAIL: ${message}`);
        process.exit(1);
    }
    console.log(`ok: ${message}`);
}

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

console.log('all checks passed');
