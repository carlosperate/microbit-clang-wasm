// The diagnostics reader against the output stored from each LLVM line, so it runs without building
// LLVM, and against output no compiler run here would print. `node --test test/test_diagnostics.mjs`.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { readDiagnostics } from '../lib/diagnostics.js';
import { cases, only, verify } from './diagnostics/cases.mjs';

const stored = new URL('./diagnostics/', import.meta.url);
const versions = (await readdir(stored)).filter((name) => /^\d+\.\d+\.\d+$/.test(name));

test('output is stored for at least one LLVM line', () => assert.ok(versions.length > 0));

for (const version of versions) {
    for (const testCase of cases) {
        test(`${version}: ${testCase.name}`, async () => {
            verify(testCase, await readFile(new URL(`${version}/${testCase.name}.txt`, stored), 'utf8'), readDiagnostics);
        });
    }
}

const diagnostics = (output) => only(readDiagnostics(output));

test('the linker run through the driver, its path in the parentheses', () => {
    const [error] = diagnostics('ld: error: undefined symbol: missing()\n' +
        '>>> referenced by main.cpp:7 (source/main.cpp:7)\n' +
        '>>>               build/user/0-main.cpp.obj:(main)\n');
    assert.deepEqual(error.notes, [{ file: 'source/main.cpp', line: 7, column: null, message: 'referenced here' }]);
});

test('a reference with no line is no location', () => {
    const [error] = diagnostics('ld.lld: error: undefined symbol: missing()\n>>> referenced by nodebug.cpp\n>>>               nodebug.o:(main)\n');
    assert.deepEqual(error.notes, []);
});

test('a duplicate symbol names where each definition is', () => {
    const [error] = diagnostics('ld.lld: error: duplicate symbol: f()\n>>> defined at a.cpp:1 (src/a.cpp:1)\n>>>            a.o:(f())\n' +
        '>>> defined at b.cpp:2 (src/b.cpp:2)\n>>>            b.o:(.text+0x0)\n');
    assert.deepEqual(error.notes.map(({ file, line, message }) => [file, line, message]),
        [['src/a.cpp', 1, 'defined here'], ['src/b.cpp', 2, 'defined here']]);
});

test('colour is ignored for reading and kept in the text', () => {
    const output = '\x1b[1mmain.cpp:1:2: \x1b[0m\x1b[0;1;31merror: \x1b[0m\x1b[1mbad\x1b[0m\n';
    const [error] = readDiagnostics(output);
    assert.deepEqual([error.file, error.line, error.column, error.message, error.text], ['main.cpp', 1, 2, 'bad', output]);
});

test('a line nobody recognises stays out of the message before it', () => {
    const records = readDiagnostics('a.h:1:1: warning: w [-Wfoo]\n    1 | x\n      | ^\nPLEASE submit a bug report\n');
    assert.deepEqual(records.map((record) => record.severity), ['warning', null]);
    assert.equal(records[1].text, 'PLEASE submit a bug report\n');
});

test('a chain with no message after it ends the message before it, keeping the order', () => {
    const output = 'a.h:1:1: warning: w\nIn file included from main.cpp:1:\n    1 | x\n';
    const records = readDiagnostics(output);
    assert.deepEqual(records.map((record) => record.severity), ['warning', null]);
    assert.equal(records.map((record) => record.text).join(''), output);
});

test('the closing count after a message with no excerpt stays apart from it', () => {
    const [warning, count] = readDiagnostics('<command line>:1:9: warning: w [-Wmacro-redefined]\n1 warning generated.\n');
    assert.deepEqual([warning.message, warning.flag, count.text], ['w', '-Wmacro-redefined', '1 warning generated.\n']);
});

test('a message line that reads like the closing count is still the message', () => {
    const output = 'main.cpp:1:15: error: static assertion failed: x\n1 error generated.\n    1 | static_assert(false, "x\\n1 error generated.");\n';
    const [error] = readDiagnostics(output);
    assert.deepEqual([error.message, error.text], ['static assertion failed: x\n1 error generated.', output]);
});

test('lines after a message with no excerpt stay apart from it', () => {
    const records = readDiagnostics('main.cpp:2:5: error: x\nPLEASE submit a bug report\nStack dump:\n');
    assert.deepEqual(records.map((record) => record.severity), ['error', null]);
    assert.equal(records[0].message, 'x');
});

test('source in the excerpt that looks like a message is still excerpt', () => {
    const output = 'main.cpp:2:5: error: x\n    2 |     puts("a.c:1: error: b");\n      |     ^\n';
    assert.deepEqual(readDiagnostics(output).map(({ severity, text }) => [severity, text]), [['error', output]]);
});

test('a bare [-Werror] is the option, and leaves the message', () => {
    const [error] = readDiagnostics('main.cpp:1:1: error: x [-Werror]\n');
    assert.deepEqual([error.message, error.flag], ['x', '-Werror']);
});

test('a carriage return ending the output is still a line ending', () => {
    const [error] = readDiagnostics('main.cpp:3: error: x\r');
    assert.deepEqual([error.severity, error.message], ['error', 'x']);
});

test('lines after a message with no location and no excerpt stay apart from it', () => {
    const records = readDiagnostics('clang++: warning: argument unused during compilation: \'-x\' [-Wunused-command-line-argument]\nPLEASE submit a bug report\n');
    assert.deepEqual(records.map((record) => record.severity), ['warning', null]);
});

test('a location without a column, and Windows line endings', () => {
    const [error] = readDiagnostics('main.cpp:3: error: x\r\n');
    assert.deepEqual([error.line, error.column, error.message, error.text], [3, null, 'x', 'main.cpp:3: error: x\r\n']);
});

test('the chain carries forward to messages printed without one', () => {
    const [first, second, third] = diagnostics('In file included from main.cpp:2:\nIn file included from b.h:3:\n' +
        'c.h:4:5: warning: one\nc.h:6:7: warning: two\nb.h:9:1: error: three\n');
    const chain = [{ file: 'b.h', line: 3 }, { file: 'main.cpp', line: 2 }];
    assert.deepEqual([first.includedFrom, second.includedFrom, third.includedFrom], [chain, chain, chain.slice(1)]);
});

test('a chain printed for a note goes with the note and is remembered', () => {
    const [error, later] = diagnostics('main.cpp:2:1: error: e\nIn file included from main.cpp:1:\na.h:1:1: note: n\na.h:3:1: error: f\n');
    assert.deepEqual([error.notes[0].file, later.includedFrom], ['a.h', [{ file: 'main.cpp', line: 1 }]]);
});

test('a too-many-errors stop is an error with no file, and names its option', () => {
    const [stop] = diagnostics('fatal error: too many errors emitted, stopping now [-ferror-limit=]\n');
    assert.deepEqual([stop.severity, stop.file, stop.flag, stop.message], ['error', null, '-ferror-limit=', 'too many errors emitted, stopping now']);
});

test('a note with no message before it, and a chain with none after it, are kept as text', () => {
    const output = 'a.h:1:1: note: alone\nIn file included from main.cpp:1:\n';
    assert.deepEqual(readDiagnostics(output), [{ severity: null, text: output }]);
});

test('nothing in, nothing out', () => assert.deepEqual(readDiagnostics(''), []));
