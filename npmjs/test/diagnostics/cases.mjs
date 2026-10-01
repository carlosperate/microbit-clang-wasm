// Broken programs, and what the diagnostics reader must make of what the tools say about them.
// The stored-output tests check them with no compiler at all; the smoke test checks them against
// the compiler each CI job has just built, so every LLVM line is read by the reader it ships with.

import assert from 'node:assert/strict';

export const CPU = ['--target=arm-none-eabi', '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=softfp'];
const CXX = ['--sysroot=/usr', '-std=c++17', '-fno-exceptions', '-fno-rtti', '-Wall', '-Wextra', '-g'];

export const only = (records) => records.filter((record) => record.severity !== null);

export const cases = [
    {
        name: 'columns-after-utf8',
        files: { 'main.cpp': 'int main() {\n    const char *s = "héllo 🙂"; int x = oops;\n}\n' },
        check(records) {
            const [error] = records.filter((record) => record.severity === 'error');
            assert.deepEqual([error.file, error.line, error.column], ['case/main.cpp', 2, 44]); // bytes: é is 2, 🙂 is 4
            assert.match(error.message, /'oops'/);
        },
    },
    {
        name: 'missing-include',
        files: { 'main.cpp': '#include "missing.h"\nint main() {}\n' },
        check(records) {
            const [fatal] = only(records);
            assert.deepEqual([fatal.severity, fatal.file, fatal.line, fatal.column], ['error', 'case/main.cpp', 1, 10]);
            assert.match(fatal.message, /missing\.h/);
        },
    },
    {
        name: 'template-in-library',
        files: { 'main.cpp': '#include <algorithm>\nstruct S { int v; };\nint main() {\n    S a, b;\n    std::max(a, b);\n}\n' },
        check(records) {
            const [first] = only(records);
            assert.equal(first.severity, 'error');
            assert.match(first.file, /^\/usr\/include\/c\+\+\/v1\//);
            assert.deepEqual(first.includedFrom.at(-1), { file: 'case/main.cpp', line: 1 });
            assert.ok(first.notes.some((note) => note.file === 'case/main.cpp' && note.line === 5), 'a note names the user\'s std::max');
        },
    },
    {
        name: 'error-in-user-header',
        files: {
            'util.h': 'struct T { void f(int); };\ninline void g() { T t; t.f(); }\n',
            'main.cpp': '#include "util.h"\nint main() { g(); }\n',
        },
        check(records) {
            const [error] = only(records);
            assert.deepEqual([error.file, error.line], ['case/util.h', 2]);
            assert.deepEqual(error.includedFrom, [{ file: 'case/main.cpp', line: 1 }]);
            assert.deepEqual([error.notes[0].file, error.notes[0].line], ['case/util.h', 1]);
        },
    },
    {
        // A note in a header moves Clang's idea of the current chain without printing it, so the
        // header's next error comes with none. The reader may only say what it was told.
        name: 'note-before-error-in-header',
        files: {
            'a.h': 'void f(int);\ntemplate <class T> void g(T t) { t.nope(); }\n',
            'main.cpp': '#include "a.h"\nint main() {\n    f();\n    g(1);\n}\n',
        },
        check(records) {
            const [call, instantiated] = only(records);
            assert.deepEqual([call.file, call.line, call.notes[0].file], ['case/main.cpp', 3, 'case/a.h']);
            assert.deepEqual([instantiated.file, instantiated.line], ['case/a.h', 2]);
            if (instantiated.includedFrom.length) assert.deepEqual(instantiated.includedFrom, [{ file: 'case/main.cpp', line: 1 }]);
            assert.ok(instantiated.notes.some((note) => note.file === 'case/main.cpp' && note.line === 4));
        },
    },
    {
        name: 'werror-and-warnings',
        files: { 'main.cpp': 'int main(int argc, char **argv) {\n    int unused = 3;\n}\n' },
        flags: ['-Werror=unused-variable'],
        check(records) {
            const found = only(records).map(({ severity, line, flag, message }) => ({ severity, line, flag, message }));
            assert.deepEqual(found.find((record) => record.severity === 'error'),
                { severity: 'error', line: 2, flag: '-Wunused-variable', message: 'unused variable \'unused\'' });
            assert.equal(found.filter((record) => record.severity === 'warning' && record.flag === '-Wunused-parameter').length, 2);
        },
    },
    {
        // Clang prints a message's line breaks as they are; the notes after it are still its own.
        name: 'multi-line-message',
        files: { 'main.cpp': 'template <class T> void f() { static_assert(sizeof(T) == 0, "first line\\nsecond line"); }\nint main() { f<int>(); }\n' },
        check(records) {
            const [error] = only(records);
            assert.match(error.message, /: first line\nsecond line$/);
            assert.ok(error.notes.some((note) => note.file === 'case/main.cpp' && note.line === 2), 'the requested-here note stays with it');
        },
    },
    {
        name: 'bracket-in-message',
        files: { 'main.cpp': 'static_assert(false, "bad [-1]");\nint main() {}\n' },
        check(records) {
            const [error] = only(records);
            assert.deepEqual([error.flag, error.message], [null, 'static assertion failed: bad [-1]']);
        },
    },
    {
        name: 'undefined-symbol-twice',
        files: { 'main.cpp': 'void missing();\nint main() {\n    missing();\n    missing();\n}\n' },
        link: [],
        check(records) {
            const [error] = only(records);
            assert.deepEqual([error.severity, error.file, error.message], ['error', null, 'undefined symbol: missing()']);
            // LLD gives the full path from the debug information, and these compile at the root.
            assert.deepEqual(error.notes.map((note) => [note.file.replace(/^\//, ''), note.line, note.message]),
                [['case/main.cpp', 3, 'referenced here'], ['case/main.cpp', 4, 'referenced here']]);
        },
    },
    {
        name: 'flash-overflow',
        files: {
            'main.cpp': 'const char big[4096] = {1};\nint main() { return big[0]; }\n',
            'small.ld': 'MEMORY { FLASH (rx) : ORIGIN = 0, LENGTH = 1K }\nSECTIONS { .text : { *(.text*) *(.rodata*) } > FLASH }\n',
        },
        link: ['-T', 'case/small.ld'],
        check(records) {
            const [error] = only(records);
            assert.deepEqual([error.severity, error.file, error.line], ['error', null, null]);
            assert.match(error.message, /will not fit in region 'FLASH'/);
        },
    },
    {
        name: 'driver-error',
        files: {},
        check(records) {
            const errors = only(records);
            assert.ok(errors.length > 0 && errors.every((record) => record.severity === 'error' && record.file === null));
            assert.match(errors[0].message, /case\/main\.cpp/);
        },
    },
];

// Everything the case needs: the text comes back whole, every excerpt line joins its message, and
// what is left over is only Clang's closing count.
export function verify(testCase, output, readDiagnostics) {
    const records = readDiagnostics(output);
    assert.equal(records.map((record) => record.text).join(''), output, 'joining the text gives the output back');
    for (const record of records.filter((record) => record.severity === null)) {
        assert.match(record.text, /^(\d+ (warnings?|errors?)( and \d+ errors?)? generated\.\n)+$/, 'nothing is left outside a message');
    }
    testCase.check(records);
}

// The output of the step the case is about: the compile, or the link once that compiled cleanly.
export async function produce(session, { files, flags = [], link }) {
    await session.remove('case');
    await session.writeTree({ case: files });
    const run = async (argv) => {
        const decoder = new TextDecoder();
        let output = '';
        const code = await session.run(argv, { stderr: (bytes) => bytes && (output += decoder.decode(bytes, { stream: true })) });
        return { code, output: output + decoder.decode() };
    };
    const compiled = await run(['clang++', ...CPU, ...CXX, ...flags, '-c', 'case/main.cpp', '-o', 'case/main.o']);
    if (!link) return compiled.output;
    if (compiled.code !== 0 || compiled.output) throw new Error(`the program to link did not compile cleanly:\n${compiled.output}`);
    return (await run(['ld.lld', 'case/main.o', ...link, '-o', 'case/main.elf', '-e', 'main'])).output;
}
