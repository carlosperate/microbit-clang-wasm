// Programs to complete in, each with `@` where the cursor is, and what the completions reader must
// make of what Clang prints there. The stored-output tests check them with no compiler; the smoke
// test checks them against the compiler each CI job has just built.

import assert from 'node:assert/strict';

import { CPU } from '../diagnostics/cases.mjs';

const CXX = ['--sysroot=/usr', '-std=c++17', '-fno-exceptions', '-fno-rtti'];
const COMPLETE = ['-fsyntax-only', '-Xclang', '-code-completion-brief-comments'];

const kind = (records, wanted) => records.filter((record) => record.kind === wanted);
const named = (records, name) => kind(records, 'candidate').filter((record) => record.name === name);
const one = (records, name) => {
    const found = named(records, name);
    assert.equal(found.length, 1, `one candidate named ${name}`);
    return found[0];
};
const text = (text) => ({ kind: 'text', text });
const informative = (text) => ({ kind: 'informative', text });
const placeholder = (text) => ({ kind: 'placeholder', text });
const optional = (...chunks) => ({ kind: 'optional', chunks });
const COUNT = [informative('int'), text('count')];

const THING = `struct Base {
    int inherited;
    virtual void speak();
};
class Thing : public Base {
public:
    int count;
    void speak() override;
    int size() const;
    void move(int x, int y = 0, int z = 1);
private:
    int secret;
};
`;
const SHOW = 'void show(int value, int delay);\nvoid show(const char *text, int delay = 120);\n';

export const cases = [
    {
        name: 'member-of-object',
        files: { 'main.cpp': `${THING}int main() {\n    Thing thing;\n    thing.@\n}\n` },
        check(records) {
            const { kind, name, tags, chunks, brief } = one(records, 'count');
            assert.deepEqual({ kind, name, tags, chunks, brief }, { kind: 'candidate', name: 'count', tags: [], chunks: COUNT, brief: null });
            assert.deepEqual(one(records, 'inherited').tags, ['InBase']);
            assert.deepEqual(one(records, 'secret').tags, ['Inaccessible']);
            assert.deepEqual(named(records, 'speak').map((record) => record.tags), [[], ['Hidden', 'InBase']]);
            assert.deepEqual(one(records, 'move').chunks, [
                informative('void'), text('move('), placeholder('int x'),
                optional(text(', '), placeholder('int y = 0'), optional(text(', '), placeholder('int z = 1'))),
                text(')'),
            ]);
            assert.deepEqual(one(records, 'size').chunks, [informative('int'), text('size()'), informative(' const')]);
            assert.deepEqual(one(records, 'Base').chunks, [text('Base::')]);
        },
    },
    {
        name: 'member-through-pointer',
        files: { 'main.cpp': `${THING}int main() {\n    Thing *thing = nullptr;\n    thing->@\n}\n` },
        check(records) {
            assert.deepEqual(one(records, 'count').chunks, COUNT);
        },
    },
    {
        name: 'namespace-scope',
        files: { 'main.cpp': 'namespace tools {\n    int level;\n    struct Box { static int made; };\n}\nint main() {\n    tools::@\n}\n' },
        check(records) {
            assert.deepEqual(one(records, 'level').chunks, [informative('int'), text('level')]);
            assert.deepEqual(one(records, 'Box').chunks, [text('Box')]);
        },
    },
    {
        name: 'class-scope',
        files: { 'main.cpp': 'namespace tools {\n    struct Box { static int made; };\n}\nint main() {\n    tools::Box::@\n}\n' },
        check(records) {
            assert.deepEqual(one(records, 'made').chunks, [informative('int'), text('made')]);
        },
    },
    {
        name: 'brief-comments',
        files: {
            'main.cpp': 'struct Display {\n    /**\n     * Scrolls the given text\n     * across the display.\n     *\n     * More detail, not brief.\n     */\n    void scroll(const char *text);\n    /// Ratio : brightness over time.\n    int fade;\n};\nint main() {\n    Display display;\n    display.@\n}\n',
        },
        check(records) {
            assert.equal(one(records, 'scroll').brief, 'Scrolls the given text across the display.');
            const fade = one(records, 'fade');
            assert.deepEqual([fade.chunks, fade.brief], [[informative('int'), text('fade')], 'Ratio : brightness over time.']);
        },
    },
    {
        name: 'overloads-first-argument',
        files: { 'main.cpp': `${SHOW}int main() {\n    show(@\n}\n` },
        check(records) {
            assert.deepEqual(kind(records, 'overload').map((record) => record.chunks), [
                [informative('void'), text('show('), placeholder('const char *text'), text(')')],
                [informative('void'), text('show('), placeholder('int value'), text(', int delay)')],
            ]);
            const [{ file, line, column }] = kind(records, 'opening-paren');
            assert.deepEqual({ file, line, column }, { file: 'case/main.cpp', line: 4, column: 9 });
            // Inside the arguments everything in scope is offered too, keywords and patterns included.
            assert.ok(kind(records, 'keyword').some((record) => record.name === 'char16_t'));
            const sizeOf = kind(records, 'pattern').find((record) => record.name === 'sizeof');
            assert.deepEqual(sizeOf.chunks, [informative('size_t'), text('sizeof('), placeholder('expression-or-type'), text(')')]);
            assert.deepEqual(kind(records, 'pattern').find((record) => record.name === 'static_cast').chunks,
                [text('static_cast<'), placeholder('type'), text('>('), placeholder('expression'), text(')')]);
        },
    },
    {
        name: 'overloads-second-argument',
        files: { 'main.cpp': `${SHOW}int main() {\n    show(1, @\n}\n` },
        check(records) {
            assert.deepEqual(kind(records, 'overload').map((record) => record.chunks),
                [[informative('void'), text('show(int value, '), placeholder('int delay'), text(')')]]);
            assert.deepEqual(kind(records, 'preferred-type').map((record) => record.type), ['int']);
        },
    },
    {
        // Clang leaves a defaulted parameter out of an overload, the current one included.
        name: 'overloads-defaulted-argument',
        files: { 'main.cpp': 'void show(const char *text, int delay = 120);\nint main() {\n    show("hi", @\n}\n' },
        check(records) {
            assert.deepEqual(kind(records, 'overload').map((record) => record.chunks), [[informative('void'), text('show(const char *text)')]]);
        },
    },
    {
        name: 'macros',
        files: { 'main.cpp': '#define CASE_ID_BUTTON 1\n#define CASE_TWICE(x) ((x) * 2)\nint main() {\n    int id = CASE_@\n}\n' },
        flags: ['-Xclang', '-code-completion-macros'],
        check(records) {
            assert.deepEqual(one(records, 'CASE_ID_BUTTON').chunks, [text('CASE_ID_BUTTON')]);
            assert.deepEqual(one(records, 'CASE_TWICE').chunks, [text('CASE_TWICE('), placeholder('x'), text(')')]);
        },
    },
    {
        // Inside a folder, so only its own entries are listed rather than every header in the sysroot.
        name: 'include-names',
        files: { 'main.cpp': '#include "drivers/@\n', drivers: { '(platform).h': '', 'sensor(v2).h': '', sub: { 'x.h': '' } } },
        check(records) {
            assert.deepEqual(kind(records, 'pattern').map((record) => [record.name, record.chunks]), [
                ['(platform).h', [text('(platform).h"')]],
                ['sensor(v2).h', [text('sensor(v2).h"')]],
                ['sub/', [text('sub/')]],
            ]);
        },
    },
    {
        name: 'typed-prefix',
        files: { 'main.cpp': 'struct Display { int display; int displayTimer; int brightness; };\nint main() {\n    Display d;\n    d.disp@\n}\n' },
        check(records) {
            assert.deepEqual(records.map((record) => record.name), ['display', 'displayTimer']);
        },
    },
    {
        name: 'error-earlier',
        files: { 'main.cpp': `${THING}int main() {\n    int broken = ;\n    Thing thing;\n    thing.@\n}\n` },
        exitCode: 1,
        check(records) {
            assert.deepEqual(one(records, 'count').chunks, COUNT);
        },
    },
    {
        // A column counted in characters rather than bytes would land inside `thing` and offer no `count`.
        name: 'column-after-utf8',
        files: { 'main.cpp': `${THING}int main() {\n    Thing thing; const char *s = "é🙂"; thing.@\n}\n` },
        check(records) {
            assert.deepEqual(one(records, 'count').chunks, COUNT);
        },
    },
    {
        name: 'preferred-type',
        files: { 'main.cpp': 'struct Colour { int red; };\nint main() {\n    Colour wanted;\n    Colour colour = wa@\n}\n' },
        check(records) {
            assert.deepEqual(kind(records, 'preferred-type').map((record) => record.type), ['Colour']);
            assert.deepEqual(one(records, 'wanted').chunks, [informative('Colour'), text('wanted')]);
        },
    },
];

// The line and the column of the `@`, in bytes as Clang counts them, and the source without it.
function cursor(source) {
    const at = source.indexOf('@');
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    const column = new TextEncoder().encode(before.slice(before.lastIndexOf('\n') + 1)).length + 1;
    return { line, column, source: before + source.slice(at + 1) };
}

// Joining the text gives stdout back, and no line goes unrecognised.
export function verify(testCase, output, readCompletions) {
    const records = readCompletions(output);
    assert.equal(records.map((record) => record.text).join(''), output, 'joining the text gives the output back');
    assert.deepEqual(records.filter((record) => record.kind === null).map((record) => record.text), [], 'every line is recognised');
    testCase.check(records);
}

/** @return {Promise<{ stdout: string, stderr: string, exitCode: number }>} the case's completion run */
export async function produce(session, { files, flags = [] }) {
    const { line, column, source } = cursor(files['main.cpp']);
    await session.remove('case');
    await session.writeTree({ case: { ...files, 'main.cpp': source } });
    const decoders = [new TextDecoder(), new TextDecoder()];
    const out = ['', ''];
    const exitCode = await session.run(
        ['clang++', ...CPU, ...CXX, ...COMPLETE, ...flags, '-Xclang', `-code-completion-at=case/main.cpp:${line}:${column}`, 'case/main.cpp'],
        {
            stdout: (bytes) => bytes && (out[0] += decoders[0].decode(bytes, { stream: true })),
            stderr: (bytes) => bytes && (out[1] += decoders[1].decode(bytes, { stream: true })),
        },
    );
    return { stdout: out[0] + decoders[0].decode(), stderr: out[1] + decoders[1].decode(), exitCode };
}
