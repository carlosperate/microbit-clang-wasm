import { Application } from '@yowasp/runtime';
import * as generatedResources from '../gen/llvm-resources.js';
import { instantiate } from '../gen/llvm.js';

import { Exit } from '@yowasp/runtime';
export { Exit } from '@yowasp/runtime';
export { readDiagnostics } from './diagnostics.js';

// By path: the runtime's package exports only its Application API, and a session needs the
// filesystem underneath it. Pinned, and bundled by esbuild, so a move fails at build time.
import { Environment, directoryFromTree } from '../node_modules/@yowasp/runtime/lib/wasi-virt.js';

const ARGV0 = 'yowasp-llvm';

// Where the packed resources mount the libraries and headers; consumers pass it as `--sysroot`.
export const sysroot = '/usr';

// The tools that need the `-###` replay rather than a plain run.
const DRIVERS = new Set(['clang', 'clang++']);

// The generated loader fetches each asset from a URL, which an extension host cannot do; there the
// bytes come from `vscode.workspace.fs`.
let assetLoader = null;

/** @param {((name: string) => Promise<Uint8Array | Response> | Uint8Array | Response) | null} loader */
export function setAssetLoader(loader) {
    assetLoader = loader;
}

function suppliedBy(loader, fallback) {
    return async (url, init) => {
        const name = url.pathname.split('/').pop();
        const supplied = await loader(name);
        if (supplied === undefined || supplied === null) return fallback(url, init);
        if (supplied instanceof Response) return supplied;
        // compileStreaming rejects anything not typed as wasm, in Node as well as in a browser.
        return new Response(supplied, {
            headers: {
                'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
                'content-length': supplied.byteLength,
            },
        });
    };
}

// Memoised so a Session and the files-in/files-out commands share one copy of the 34 MB sysroot
// and one set of compiled modules, whichever runs first.
let modulesOnce = null;
let filesystemOnce = null;

const withLoader = (fetch) => (assetLoader ? suppliedBy(assetLoader, fetch) : fetch);

// Dropped again if it fails, so a host whose asset read failed once can retry.
const retryable = (promise, forget) => promise.catch((error) => { forget(); throw error; });

const resources = {
    totalSize: generatedResources.totalSize,
    modules: (fetch) => (modulesOnce ??= retryable(generatedResources.modules(withLoader(fetch)), () => { modulesOnce = null; })),
    filesystem: (fetch) => (filesystemOnce ??= retryable(generatedResources.filesystem(withLoader(fetch)), () => { filesystemOnce = null; })),
};

// The runtime's positional write is a stub that throws, so a tool doing a pwrite fails with no useful
// error. Patched only while it is still the stub, so an upstream fix takes over.
const { Descriptor } = new Environment().exports.fs;
if (/not implemented/.test(Descriptor.prototype.write.toString())) {
    // The runtime's own stream write, which copies rather than writing in place: a file's bytes may
    // be a view into the shared resources tar.
    Descriptor.prototype.write = function (buffer, offset) {
        if (this.entry.data === undefined)
            throw 'is-directory';
        this.writeViaStream(offset).write(buffer);
        return BigInt(buffer.length);
    };
}

const llvm = new Application(resources, instantiate, ARGV0);
const runLLVM = llvm.run.bind(llvm);

function subcommand(command, subcommandName) {
    return function (args = null, files = {}, options = {}) {
        if (args === null)
            return command(args, files, options); // preload resources
        return command([subcommandName, ...args], files, options);
    }
}

/** See the `clang/lib/Driver/Job.cpp` file, `Command::Print()` subroutine, as well as
  * the `llvm/lib/Support/Program.cpp` file, `sys::printArg()` subroutine.
  * @param {string} line
  * @return {string[]} */
function unquoteClangArgs(line) {
    // `*` not `+` on the quoted alternative: clang marks a command it would have run in-process
    // with an empty argument, which the caller then shifts off, and dropping it here left that
    // branch unreachable.
    return Array.from(line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])*)")/g), (match) => {
        if (match[1] !== undefined) {
            return match[1];
        } else if (match[2] !== undefined) {
            return match[2].replaceAll(/\\["$\\]/g, (m) => m[1]);
        }
    });
}

/** The sub-commands `-###` says it would run, or null when there is no list to replay.
  *
  * The banner varies by vendor build, so the list is found structurally: it starts at the first
  * quoted line. Guessing at banner lines once discarded whole lists, which looks exactly like a
  * build that succeeded and compiled nothing.
  * @param {string} output
  * @return {string[][] | null} */
function parseDriverCommands(output) {
    const commands = [];
    for (const line of output.split("\n")) {
        // Clang would run this one in-process; we need a separate run either way.
        if (line === " (in-process)")
            continue;
        if (line.startsWith(' "')) {
            const argv = unquoteClangArgs(line);
            // An empty argv[0] is how clang marks that command, followed by its own argv[0].
            commands.push(argv[0] === "" ? argv.slice(1) : argv);
        } else if (commands.length === 0) {
            continue; // still in the banner
        } else if (line === "") {
            break; // the list ends at a blank line
        } else {
            return null; // malformed
        }
    }
    return commands.length === 0 ? null : commands;
}

// horrific ??? code. [insert standard disclaimer here]
// 'it cant hurt me if im not looking at it'
function runClang(args = null, files = {}, options = {}) {
    if (args === null)
        return runLLVM(args, files, options); // preload resources

    // We pattern-match output of `-###` plus `args` to understand which subprocesses to run.
    // If `args` contains `-###` this is an explicit user request to display these subprocesess,
    // and we should not interpret the output in any way.
    if (args.includes("-###"))
        return runLLVM(args, files, options);

    // All of these options have more priority than `-###`, and we shouldn't interfere with them.
    if (args.includes(`--version`) ||
            args.includes(`-help`) ||
            args.includes(`--help`) ||
            args.includes(`--help-hidden`))
        return runLLVM(args, files, options);

    function writeStderr(output) {
        if (options.stderr === undefined) {
            console.log(output);
        } else {
            options.stderr(new TextEncoder().encode(output));
            options.stderr(null);
        }
    }

    let gen = (function* () {
        const [arg0, ...argsRest] = args;

        /** @type {Uint8Array[]} Output of `-###` */
        const outputSubarrays = [];
        function captureOutput(bytes) {
            if (bytes !== null)
                outputSubarrays.push(new Uint8Array(bytes));
        }

        /** @type {Exit | undefined} Outcome of running `-###` */
        let hash3Error = undefined;
        try {
            yield runLLVM([arg0, "-###", ...argsRest], files, {
                stdout: captureOutput,
                stderr: captureOutput,
                synchronously: options.synchronously,
            });
        } catch (err) {
            hash3Error = err;
        }

        const outputArray = new Uint8Array(outputSubarrays.reduce((a, b) => a + b.length, 0));
        let outputLength = 0;
        for (const outputSubarray of outputSubarrays) {
            outputArray.subarray(outputLength, outputLength + outputSubarray.length).set(outputSubarray);
            outputLength += outputSubarray.length;
        }
        const output = new TextDecoder().decode(outputArray);

        if (hash3Error !== undefined) {
            // Something definitely went wrong, and the output contains no commands to execute,
            // but probably has a human-readable explanation. We had to squish it all to stderr
            // though, even though some of it might've been printed to stdout originally.
            writeStderr(output);
            throw hash3Error;
        }

        const commands = parseDriverCommands(output);
        if (commands === null) {
            // No command list to replay. Rather than guess which options cause that — the
            // `-print-*` and `-dump*` queries report something and exit, but `-dumpdir` compiles
            // like any other flag — hand the original arguments back to clang and let it decide.
            // A query then prints and exits 0; anything else fails with clang's own diagnostic,
            // never by quietly returning the inputs as though it had compiled them.
            return yield runLLVM(args, files, options);
        }
        // Verbose? Print `-###` output. This will differ slightly from a desktop compiler,
        // but is more in the spirit of the `-v` option.
        if (args.includes('-v'))
            writeStderr(output);
        // Run the command list.
        for (const command of commands) {
            // If this command line fails, the `Exit` exception will bubble up its exit code
            // and output tree.
            try {
                files = yield runLLVM(command, files, options);
            } catch (err) {
                if (err instanceof Exit)
                    delete err.files.tmp;
                throw err;
            }
        }
        delete files.tmp;
        return files;
    })();

    let promise, resolve, reject;
    function runNext(value) {
        try {
            let done;
            do {
                ({ value, done } = gen.next(value));
            } while (!(value instanceof Promise) && !done);
            if (done) {
                if (resolve) resolve(value);
                else return value;
            }
            if (!promise) promise = new Promise((_resolve, _reject) =>
                (resolve = _resolve, reject = _reject));
            value.then(
                nextVal => done ? resolve() : runNext(nextVal),
                error => { // give the coroutine a first chance to handle the error.
                    // we have SEH at home!
                    try { ({ value, done } = gen.throw(error)); }
                    catch (e) { reject(e); }
                });
        }
        catch (e) {
            if (reject) reject(e);
            else throw e;
        }
    }
    const maybeSyncReturn = runNext(null);
    return promise || maybeSyncReturn;
}

/** A filesystem that outlives one command; the module instance does not, as clang's global state
  * is not reusable. Rationale in api.d.ts. */
class Session {
    #environment = null;
    #queue = Promise.resolve();

    // The promise, not the environment: two callers arriving together would otherwise each unpack
    // the sysroot. Dropped again if it fails, so a host that supplies its assets can retry.
    #ready() {
        return (this.#environment ??= this.#build().catch((error) => {
            this.#environment = null;
            throw error;
        }));
    }

    async #build() {
        // Fetches and unpacks the resources if that has not happened yet. The no-op progress
        // callback replaces the runtime's default, which logs a percentage to the console.
        await runLLVM(null, {}, { fetchProgress: () => {} });
        const environment = new Environment();
        for (const [name, contents] of Object.entries(await resources.filesystem()))
            environment.root.files[name] = directoryFromTree(contents);
        return environment;
    }

    /** Runs one tool. `argv[0]` is its name, as in `['clang++', '-c', 'main.cpp']`.
      * @return {Promise<number>} the exit code */
    exec(argv, options) {
        return this.#serially(() => this.#exec(argv, options));
    }

    // One environment carries the arguments and the streams, so a command that started while
    // another was mid-flight would run with the other's. A driver replay holds the queue for all of
    // its sub-commands, which also keeps their scratch files apart.
    #serially(work) {
        const result = this.#queue.then(work, work);
        this.#queue = result.then(() => {}, () => {});
        return result;
    }

    async #exec(argv, { stdin = null, stdout = null, stderr = null } = {}) {
        const environment = await this.#ready();
        environment.args = [ARGV0, ...argv];
        environment.stdin = stdin;
        environment.stdout = stdout;
        environment.stderr = stderr;

        const modules = await resources.modules();
        const command = await instantiate((name) => modules[name], { runtime: environment.exports });
        try {
            command.run.run();
            return 0;
        } catch (error) {
            if (error instanceof Exit)
                return error.code;
            throw error;
        }
    }

    /** Runs a tool by the name a native toolchain uses, `llvm-` prefix and all, taking the driver
      * replay when it is the compiler.
      * @return {Promise<number>} the exit code */
    run(argv, options = {}) {
        const [tool, ...args] = argv;
        const name = tool.replace(/^llvm-/, ''); // the multicall binary dispatches on the bare name
        return DRIVERS.has(name) ? this.clang([name, ...args], options) : this.exec([name, ...args], options);
    }

    /** Runs the compiler driver, replaying the sub-commands it reports with `-###`, since it cannot
      * start subprocesses of its own here.
      * @return {Promise<number>} the exit code */
    clang(argv, options = {}) {
        return this.#serially(() => this.#clang(argv, options));
    }

    async #clang(argv, options) {
        const [tool, ...args] = argv;
        // As runClang: an explicit -### is a request to see the list, not run it, and the queries
        // below print and exit without one.
        if (['-###', '--version', '-help', '--help', '--help-hidden'].some((flag) => args.includes(flag)))
            return this.#exec(argv, options);

        // Collected as bytes and decoded once: the driver's output arrives in thousands of
        // single-byte chunks, so a multi-byte character in a file name spans two of them.
        const chunks = [];
        const capture = (bytes) => { if (bytes !== null) chunks.push(Uint8Array.from(bytes)); };

        const code = await this.#exec([tool, '-###', ...args], { stdout: capture, stderr: capture });
        const output = new TextDecoder().decode(concat(chunks));
        const commands = code === 0 ? parseDriverCommands(output) : null;
        if (commands === null)
            return this.#exec(argv, options); // no list to replay: let clang answer for itself
        if (args.includes('-v'))
            options.stderr?.(new TextEncoder().encode(output));

        // The driver invents scratch files under tmp/ for its sub-commands; they are the tmp/ paths
        // in that list the caller did not name. Anything the caller did name there is theirs.
        const named = new Set(argv);
        const scratch = commands.flat().filter((arg) => /^\/?tmp\//.test(arg) && !named.has(arg));
        const { root } = await this.#ready();
        const hadTmp = root.files.tmp !== undefined;
        try {
            for (const command of commands) {
                const status = await this.#exec(command, options);
                if (status !== 0)
                    return status;
            }
            return 0;
        } finally {
            for (const path of scratch) await this.remove(path.replace(/^\//, ''));
            if (!hadTmp && Object.keys(root.files.tmp?.files ?? {}).length === 0)
                await this.remove('tmp');
        }
    }

    // The three below go through the runtime's own traversal, so they resolve a path exactly as the
    // WASI calls the compiler makes do.

    /** @param {string} path @param {Uint8Array | string} data */
    async writeFile(path, data) {
        const { root } = await this.#ready();
        const entry = root.traverse(path, { create: 'file' });
        // traverse hands back whatever is there; setting `data` on a directory would silently turn
        // it into something that is both.
        if (entry.files !== undefined)
            throw new Error(`${path} is a directory`);
        entry.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    }

    /** @param {object} tree nested objects with string or Uint8Array leaves, merged at the root */
    async writeTree(tree) {
        const { root } = await this.#ready();
        merge(root, directoryFromTree(tree));
    }

    /** @param {string} path @return {Promise<Uint8Array | null>} null if it is absent or a directory */
    async readFile(path) {
        const { root } = await this.#ready();
        try {
            // A copy: the bytes may be a view into the sysroot every session shares.
            return root.traverse(path).data?.slice() ?? null;
        } catch {
            return null;
        }
    }

    /** @param {string} path a file or a directory, ignored if it is not there */
    async remove(path) {
        const { root } = await this.#ready();
        try {
            root.traverse(path, { remove: true });
        } catch {
            // already gone
        }
    }
}

function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

function merge(into, from) {
    for (const [name, entry] of Object.entries(from.files)) {
        if (entry.files !== undefined && into.files[name]?.files !== undefined)
            merge(into.files[name], entry);
        else
            into.files[name] = entry;
    }
}

export function createSession() {
    return new Session();
}

export { runLLVM, runClang };
export const commands = {
    // LLVM tools
    'addr2line': subcommand(runLLVM, 'addr2line'), // actually `symbolizer`
    'ar': subcommand(runLLVM, 'ar'),
    'c++filt': subcommand(runLLVM, 'c++filt'),
    'dwarfdump': subcommand(runLLVM, 'dwarfdump'),
    'nm': subcommand(runLLVM, 'nm'),
    'objcopy': subcommand(runLLVM, 'objcopy'),
    'objdump': subcommand(runLLVM, 'objdump'),
    'readobj': subcommand(runLLVM, 'readobj'),
    'ranlib': subcommand(runLLVM, 'ranlib'), // actually `ar`
    'size': subcommand(runLLVM, 'size'),
    'strip': subcommand(runLLVM, 'strip'), // actually `objcopy`
    'symbolizer': subcommand(runLLVM, 'symbolizer'),
    // Compiler and linker
    'wasm-ld': subcommand(runLLVM, 'wasm-ld'),
    'ld.lld': subcommand(runLLVM, 'ld.lld'), // ELF flavour of lld, which is what an Arm target links with
    'clang': subcommand(runClang, 'clang'),
    'clang++': subcommand(runClang, 'clang++'),
};
export const version = VERSION;
