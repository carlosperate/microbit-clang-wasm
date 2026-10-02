// Fixes to the virtual filesystem of `@yowasp/runtime`, which every command and session runs on.
// The runtime is pinned exactly, so each fix replaces the runtime's method outright.

// By path: the package exports only its Application API. Bundled, so a move fails at build time.
import { Environment, directoryFromTree } from '../node_modules/@yowasp/runtime/lib/wasi-virt.js';

export { Environment, directoryFromTree };

const { Descriptor } = new Environment().exports.fs;
const sample = directoryFromTree({ file: '' });
const Directory = sample.constructor;
const File = sample.files.file.constructor;
const WriteStream = new Descriptor(sample.files.file).writeViaStream(0n).constructor;

// The runtime's positional write is a stub that throws, so a tool doing a pwrite failed with no
// useful error.
Descriptor.prototype.write = function (buffer, offset) {
    if (this.entry.data === undefined)
        throw 'is-directory';
    this.writeViaStream(offset).write(buffer);
    return BigInt(buffer.length);
};

// The runtime's own walk, except that it dropped every `..`, so `#include "../include/util.h"` found
// nothing. Above the directory the walk started from, `..` still stays put, as it did.
Directory.prototype.traverse = function (path, { create = null, remove = false } = {}) {
    const above = [];
    let entry = this;
    let separatorAt = -1;
    do {
        if (entry instanceof File)
            throw 'not-directory';
        const files = entry.files;
        separatorAt = path.indexOf('/');
        const segment = separatorAt === -1 ? path : path.substring(0, separatorAt);
        if (separatorAt === -1 && remove)
            delete files[segment];
        else if (segment === '' || segment === '.')
            /* disregard */;
        else if (segment === '..')
            entry = above.pop() ?? entry;
        else {
            above.push(entry);
            if (Object.hasOwn(files, segment))
                entry = files[segment];
            else if (create === 'directory' || (create !== null && separatorAt !== -1))
                entry = files[segment] = new Directory({});
            else if (create === 'file')
                entry = files[segment] = new File(new Uint8Array());
            else if (create instanceof File || create instanceof Directory)
                entry = files[segment] = create;
            else
                throw 'no-entry';
        }
        path = path.substring(separatorAt + 1);
    } while (separatorAt !== -1);
    return entry;
};

// The directory holding a path's last segment, and that segment.
function locate(directory, path, options) {
    const at = path.lastIndexOf('/');
    const name = path.slice(at + 1);
    if (name === '' || name === '.' || name === '..')
        throw 'invalid';
    const parent = at === -1 ? directory : directory.traverse(path.slice(0, at), options);
    if (!(parent instanceof Directory))
        throw 'not-directory';
    return [parent, name];
}

// The runtime placed the moved entry only where nothing was, so the temporary file Clang writes each
// output through was dropped and the old output kept, exit code 0. It also resolved the new path
// against the old one's directory.
Descriptor.prototype.renameAt = function (oldPath, newDescriptor, newPath) {
    if (!(this.entry instanceof Directory) || !(newDescriptor.entry instanceof Directory))
        throw 'not-directory';
    const [from, oldName] = locate(this.entry, oldPath);
    if (!Object.hasOwn(from.files, oldName))
        throw 'no-entry';
    const moved = from.files[oldName];
    // Creating the new path's missing folders is the runtime's own behaviour, kept.
    const [to, newName] = locate(newDescriptor.entry, newPath, { create: 'directory' });
    const replaced = Object.hasOwn(to.files, newName) ? to.files[newName] : null;
    if (replaced === moved)
        return;
    if (replaced instanceof Directory && moved instanceof File)
        throw 'is-directory';
    if (replaced instanceof File && moved instanceof Directory)
        throw 'not-directory';
    if (replaced instanceof Directory && replaced.size > 0)
        throw 'not-empty';
    to.files[newName] = moved;
    delete from.files[oldName];
};

// The last view made on each buffer below. The bytes it covers may have been handed out since, so
// only the zeros past them are written in place; any other write copies first.
const grown = new WeakMap();

// Writes arrive in pieces of at most 4 KB, WASI's limit per call, a few bytes each for Clang's
// objects, and the runtime copied the whole file for every piece, so a large output took quadratic
// time. A file now grows into room that doubles, costing up to twice its size in memory.
WriteStream.prototype.write = function (contents) {
    const { file } = this;
    const offset = Number(this.offset);
    const size = file.data.length;
    const length = Math.max(size, offset + contents.length);
    let buffer = file.data.buffer;
    if (grown.get(buffer) !== file.data || offset < size || buffer.byteLength < length) {
        // Only growth doubles, so Clang's rewrite of each object's header leaves no spare room.
        buffer = new ArrayBuffer(length > size ? Math.max(length, 2 * size) : length);
        new Uint8Array(buffer).set(file.data);
    }
    file.data = new Uint8Array(buffer, 0, length);
    grown.set(buffer, file.data);
    file.data.set(contents, offset);
    this.offset += BigInt(contents.length);
};
