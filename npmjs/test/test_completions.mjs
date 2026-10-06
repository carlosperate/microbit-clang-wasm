// The completions reader against the output stored from each LLVM line, so it runs without building
// LLVM, and against output no case prints. `node --test npmjs/test/test_completions.mjs`.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { readCompletions } from '../lib/completions.js';
import { cases, verify } from './completions/cases.mjs';

const stored = new URL('./completions/', import.meta.url);
const versions = (await readdir(stored)).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
const config = JSON.parse(await readFile(new URL('../../config.json', import.meta.url), 'utf8'));

// So a new line cannot publish before its recording, whose diff is where a format change shows first.
test('every LLVM line config.json builds has its output stored', () => {
    assert.deepEqual(Object.keys(config.llvm.releases).filter((version) => !versions.includes(version)), []);
});

for (const version of versions) {
    for (const testCase of cases) {
        test(`${version}: ${testCase.name}`, async () => {
            verify(testCase, await readFile(new URL(`${version}/${testCase.name}.txt`, stored), 'utf8'), readCompletions);
        });
    }
}

test('a declaration named Pattern is a candidate when it has tags', () => {
    const [record] = readCompletions('COMPLETION: Pattern (InBase) : [#int#][#Base::#]Pattern\n');
    assert.deepEqual([record.kind, record.name, record.tags], ['candidate', 'Pattern', ['InBase']]);
});

test('a line nobody recognises is kept as it is', () => {
    const output = 'COMPLETION: count : [#int#]count\nSomething else\n';
    const records = readCompletions(output);
    assert.deepEqual(records.map((record) => record.kind), ['candidate', null]);
    assert.equal(records.map((record) => record.text).join(''), output);
});

test('a string whose brackets do not balance is not read as a candidate', () => {
    assert.deepEqual(readCompletions('COMPLETION: f : [#void#]f({#<#int x#>\n').map((record) => record.kind), [null]);
});

test('a pattern is named by what is typed up to its arguments, an included file whole', () => {
    const records = readCompletions(['[#void#]delete [] <#expression#>', '[#size_t#]sizeof...(<#parameter-pack#>)', 'MicroBit.h"', 'vector>', 'codal/']
        .map((string) => `COMPLETION: Pattern : ${string}\n`).join(''));
    assert.deepEqual(records.map((record) => [record.kind, record.name]),
        [['pattern', 'delete []'], ['pattern', 'sizeof...'], ['pattern', 'MicroBit.h'], ['pattern', 'vector'], ['pattern', 'codal/']]);
});

test('an opening parenthesis from a macro is read where it was expanded', () => {
    const [record] = readCompletions('OPENING_PAREN_LOC: case/main.cpp:3:9 <Spelling=case/main.cpp:1:20>\n');
    assert.deepEqual([record.kind, record.file, record.line, record.column], ['opening-paren', 'case/main.cpp', 3, 9]);
});

test('a last line with no newline is read', () => {
    const [record] = readCompletions('PREFERRED-TYPE: int');
    assert.deepEqual([record.kind, record.type, record.text], ['preferred-type', 'int', 'PREFERRED-TYPE: int']);
});
