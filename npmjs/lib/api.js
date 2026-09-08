import { Application } from '@yowasp/runtime';
import * as resources from '../gen/llvm-resources.js';
import { instantiate } from '../gen/llvm.js';

import { Exit } from '@yowasp/runtime';
export { Exit } from '@yowasp/runtime';

const llvm = new Application(resources, instantiate, 'yowasp-llvm');
const runLLVM = llvm.run.bind(llvm);

function subcommand(command, subcommandName) {
    return function (args = null, files = {}, options = {}) {
        if (args === null)
            return command(args, files, options); // preload resources
        return command([subcommandName, ...args], files, options);
    }
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

    /** See the `clang/lib/Driver/Job.cpp` file, `Command::Print()` subroutine, as well as
      * the `llvm/lib/Support/Program.cpp` file, `sys::printArg()` subroutine.
      * @param {string} line
      * @return {string[]} */
    function unquoteClangArgs(line) {
        // `*` not `+` on the quoted alternative: clang marks a command it would have run in-process
        // with an empty argument, which the loop below then shifts off, and dropping it here left
        // that branch unreachable.
        return Array.from(line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])*)")/g), (match) => {
            if (match[1] !== undefined) {
                return match[1];
            } else if (match[2] !== undefined) {
                return match[2].replaceAll(/\\["$\\]/g, (m) => m[1]);
            }
        });
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

        // The banner before the command list is not a fixed set of lines: vendor builds add their
        // own (ATfE prints `Arm Toolchain ID:`, and a configuration file adds another), and an
        // unrecognised one used to discard the whole list and return the inputs unchanged, which
        // looks exactly like a build that succeeded and compiled nothing. So the banner is skipped
        // structurally instead: the list starts at the first quoted command line.
        /** @type {string[][]} */
        const commands = [];
        let inList = false;
        let malformed = false;
        for (const line of output.split("\n")) {
            // Indicates clang would ordinarily invoke itself as a library for the following command
            // line. Since we do not have an ordinarily working compiler driver (but rather a
            // compiler driver²), those invocations need a separate `runLLVM` call anyway.
            if (line === " (in-process)")
                continue;
            if (line.startsWith(' "')) {
                commands.push(unquoteClangArgs(line));
                inList = true;
            } else if (!inList) {
                continue; // still in the banner
            } else if (line === "") {
                break; // the list ends at a blank line
            } else {
                malformed = true;
                break;
            }
        }
        if (commands.length === 0 || malformed) {
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
            if (command[0] === "") {
                // Clang would normally run this command in-process, which is indicated by
                // an empty argument in the command list, followed by clang's argv[0] for
                // this command. This distinction doesn't matter for us.
                command.shift();
            }
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
