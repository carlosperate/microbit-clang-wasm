export type Tree = {
    [name: string]: Tree | string | Uint8Array
};

export type InputStream =
    (byteLength: number) => Uint8Array | null;

export type OutputStream =
    (bytes: Uint8Array | null) => void;

export type ProgressCallback =
    (event: { source: object, totalLength: number, doneLength: number }) => void;

export type RunOptions = {
    stdin?:  InputStream  | null;
    stdout?: OutputStream | null;
    stderr?: OutputStream | null;
    decodeASCII?: boolean;
    synchronously?: boolean;
    fetchProgress?: ProgressCallback;
};

// `args` of null preloads the resources without running anything.
export type Command =
    (args?: string[] | null, files?: Tree, options?: RunOptions) => Promise<Tree> | Tree | undefined;

export class Exit extends Error {
    code: number;
    files: Tree;
}

//--------8<--------8<--------8<--------8<--------8<--------8<--------8<--------8<--------8<--------

export const runLLVM: Command;

// Wraps runLLVM: replays the sub-commands the driver reports with `-###`, since the driver cannot
// start subprocesses of its own here.
export const runClang: Command;

export const version: string;

/** Where the packed resources mount the libraries and headers; pass it as `--sysroot`. */
export const sysroot: string;

export type SessionOptions = {
    stdin?:  InputStream  | null;
    stdout?: OutputStream | null;
    stderr?: OutputStream | null;
};

// A filesystem that outlives one command. The commands above rebuild the whole tree per invocation,
// which costs more than a small compile once a sysroot and a source bundle are in it; a session
// keeps it, so a build of many files pays that once.
export type Session = {
    /** Runs a tool by the name a native toolchain uses, `llvm-` prefix and all, taking the driver
      * replay when it is the compiler. Resolves to the exit code. */
    run: (argv: string[], options?: SessionOptions) => Promise<number>;
    /** Runs one tool by its bare name, with no driver replay. */
    exec: (argv: string[], options?: SessionOptions) => Promise<number>;
    /** Runs the compiler driver, replaying the sub-commands it reports with `-###`. */
    clang: (argv: string[], options?: SessionOptions) => Promise<number>;
    writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
    /** Merges a tree of nested objects with string or Uint8Array leaves at the root. */
    writeTree: (tree: Tree) => Promise<void>;
    readFile: (path: string) => Promise<Uint8Array | null>;
    /** Removes a file or directory; does nothing if it is not there. */
    remove: (path: string) => Promise<void>;
};

export function createSession(): Session;

export type AssetLoader =
    (name: string) => Promise<Uint8Array | Response> | Uint8Array | Response | null | undefined;

// Supplies the package's own `.wasm` and `-resources.tar` by name, for a host that cannot fetch a
// URL: `vscode.workspace.fs` in an extension, the filesystem in Node. Returning nothing falls back
// to the generated loader. Set it before the first command runs, which is when they are read.
export function setAssetLoader(loader: AssetLoader | null): void;

export const commands: {
    'addr2line': Command,
    'size': Command,
    'objdump': Command,
    'objcopy': Command,
    'strip': Command,
    'c++filt': Command,
    'ar': Command,
    'ranlib': Command,
    'dwarfdump': Command,
    'nm': Command,
    'readobj': Command,
    'symbolizer': Command,
    'wasm-ld': Command,
    'ld.lld': Command,
    'clang': Command,
    'clang++': Command,
};
