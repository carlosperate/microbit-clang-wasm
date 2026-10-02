// The fixes in lib/filesystem.js, against the runtime itself, so no compiler is needed. It imports
// the runtime from npmjs/node_modules: `node --test npmjs/test/test_filesystem.mjs`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { Environment, directoryFromTree, directoryIntoTree } from '../node_modules/@yowasp/runtime/lib/wasi-virt.js';
import '../lib/filesystem.js';

const { Descriptor } = new Environment().exports.fs;
const text = (entry) => new TextDecoder().decode(entry.data);
const bytes = (...values) => new Uint8Array(values);
const code = (expected) => (thrown) => thrown === expected;

// Each fix replaces a method outright, so a new runtime would lose whatever it changed in them.
test('the runtime is the version these fixes were written against', async () => {
    const manifest = new URL('../node_modules/@yowasp/runtime/package.json', import.meta.url);
    const { version } = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(version, '11.0.67', 'read the methods lib/filesystem.js replaces in the new lib/wasi-virt.js, then update this');
});

test('a rename replaces the file already at the new path', () => {
    const root = directoryFromTree({ 'out.o': 'old', 'out.o.tmp': 'new' });
    new Descriptor(root).renameAt('out.o.tmp', new Descriptor(root), 'out.o');
    assert.deepEqual(directoryIntoTree(root), { 'out.o': 'new' });
});

test('a rename resolves the new path against the new descriptor', () => {
    const root = directoryFromTree({ a: { 'x.tmp': 'x' }, b: {} });
    new Descriptor(root.traverse('a')).renameAt('x.tmp', new Descriptor(root.traverse('b')), 'x');
    assert.deepEqual(directoryIntoTree(root), { a: {}, b: { x: 'x' } });
});

test('a rename still creates the folders the new path needs', () => {
    const root = directoryFromTree({ 'x.tmp': 'x' });
    new Descriptor(root).renameAt('x.tmp', new Descriptor(root), 'build/user/x.o');
    assert.deepEqual(directoryIntoTree(root), { build: { user: { 'x.o': 'x' } } });
});

test('a rename through `..` in the new path keeps what it moves', () => {
    const root = directoryFromTree({ source: { 'main.cpp': 'm' }, target: {} });
    new Descriptor(root).renameAt('source', new Descriptor(root), 'target/../target');
    assert.deepEqual(directoryIntoTree(root), { target: { 'main.cpp': 'm' } });
});

test('a file renamed onto itself is kept', () => {
    const root = directoryFromTree({ f: 'f' });
    new Descriptor(root).renameAt('f', new Descriptor(root), './f');
    assert.deepEqual(directoryIntoTree(root), { f: 'f' });
});

test('a rename never replaces a directory with a file, a file with a directory, or a full directory', () => {
    const tree = { f: 'f', full: { inside: 'i' }, empty: {} };
    const root = directoryFromTree(tree);
    const at = new Descriptor(root);
    assert.throws(() => at.renameAt('f', at, 'empty'), code('is-directory'));
    assert.throws(() => at.renameAt('empty', at, 'f'), code('not-directory'));
    assert.throws(() => at.renameAt('empty', at, 'full'), code('not-empty'));
    assert.deepEqual(directoryIntoTree(root), tree);
});

test('`..` goes back up the path', () => {
    const root = directoryFromTree({ source: { 'main.cpp': 'm' }, include: { 'util.h': 'u' } });
    assert.equal(text(root.traverse('source/../include/util.h')), 'u');
    assert.equal(text(root.traverse('source/./../source/main.cpp')), 'm');
    root.traverse('source/../made.h', { create: 'file' });
    assert.ok(Object.hasOwn(root.files, 'made.h'));
});

test('`..` above where the walk starts stays there, as before', () => {
    const root = directoryFromTree({ f: 'f' });
    assert.equal(text(root.traverse('../f')), 'f');
});

test('`..` after a file is not a directory', () => {
    const root = directoryFromTree({ source: { 'main.cpp': 'm' } });
    assert.throws(() => root.traverse('source/main.cpp/../main.cpp'), code('not-directory'));
});

// The runtime copied the file for each piece, 1,024 buffers here; doubling needs 11.
test('writing 4 MB in 4 KB pieces copies the file a logarithmic number of times', () => {
    const root = directoryFromTree({ out: '' });
    const stream = new Descriptor(root.traverse('out')).writeViaStream(0n);
    const piece = new Uint8Array(4096);
    const pieces = 1024;
    const buffers = new Set();
    for (let i = 0; i < pieces; i++) {
        piece.fill(i & 0xff);
        stream.write(piece);
        buffers.add(root.traverse('out').data.buffer);
    }
    const { data } = root.traverse('out');
    assert.equal(data.length, pieces * piece.length);
    for (let i = 0; i < pieces; i++) {
        assert.equal(data[i * piece.length], i & 0xff);
        assert.equal(data[(i + 1) * piece.length - 1], i & 0xff);
    }
    assert.equal(buffers.size, 11);
});

// Clang's last write to each object patches its header.
test('rewriting a file\'s start leaves it no spare room', () => {
    const root = directoryFromTree({ f: '' });
    const file = new Descriptor(root.traverse('f'));
    for (let i = 0; i < 5; i++) file.writeViaStream(BigInt(i)).write(bytes(i));
    file.writeViaStream(0n).write(bytes(9));
    const { data } = root.traverse('f');
    assert.deepEqual([...data], [9, 1, 2, 3, 4]);
    assert.equal(data.buffer.byteLength, data.length);
});

test('a write never changes the buffer a file was given', () => {
    const given = bytes(1, 2, 3, 4);
    const root = directoryFromTree({ f: given });
    new Descriptor(root.traverse('f')).writeViaStream(0n).write(bytes(9));
    assert.deepEqual([...given], [1, 2, 3, 4]);
    assert.deepEqual([...root.traverse('f').data], [9, 2, 3, 4]);
});

// One run's outputs become the next run's inputs, sharing their buffers, when the driver is replayed.
test('two files sharing written bytes never change each other, whichever is written', () => {
    const first = directoryFromTree({ f: '' });
    const stream = new Descriptor(first.traverse('f')).writeViaStream(0n);
    for (const piece of [bytes(1, 2), bytes(3, 4), bytes(5)]) stream.write(piece);
    const second = directoryFromTree({ g: first.traverse('f').data });
    // Both append into the room past the bytes they share, then each overwrites one of them.
    new Descriptor(second.traverse('g')).writeViaStream(5n).write(bytes(6));
    new Descriptor(first.traverse('f')).writeViaStream(5n).write(bytes(7));
    new Descriptor(first.traverse('f')).writeViaStream(0n).write(bytes(8));
    new Descriptor(second.traverse('g')).writeViaStream(1n).write(bytes(9));
    assert.deepEqual([...first.traverse('f').data], [8, 2, 3, 4, 5, 7]);
    assert.deepEqual([...second.traverse('g').data], [1, 9, 3, 4, 5, 6]);
});

test('a write past the end after a shrink leaves zeros between', () => {
    const root = directoryFromTree({ f: '' });
    const file = new Descriptor(root.traverse('f'));
    file.writeViaStream(0n).write(bytes(1, 2));
    file.writeViaStream(2n).write(bytes(3, 4, 5, 6));
    file.setSize(2n);
    file.writeViaStream(4n).write(bytes(7));
    assert.deepEqual([...root.traverse('f').data], [1, 2, 0, 0, 7]);
});

test('the positional write writes where it is told', () => {
    const root = directoryFromTree({ f: 'abcd' });
    const written = new Descriptor(root.traverse('f')).write(new TextEncoder().encode('XY'), 1n);
    assert.equal(written, 2n);
    assert.equal(text(root.traverse('f')), 'aXYd');
});
