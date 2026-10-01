// Reads only the first line of each Clang and LLD message, `file:line:col: severity: message`, the
// format Clang copied from GCC and every editor depends on. Of the code excerpt under it, whose layout
// changes between versions, only the gutter (` 12 | `) is relied on, to tell its lines apart; with
// -fno-diagnostics-show-line-numbers there is none, and excerpts and notes come back as plain text.

const SEVERITY = '(fatal error|error|warning|note|remark)';
// A tool speaking for itself, `ld.lld: error: ...`, or a bare `error: ...`. Tried before LOCATED,
// whose lazy file name would otherwise swallow a `line:` further along the message.
const UNLOCATED = new RegExp(`^(?:[^\\s:]+: )?${SEVERITY}: (.*)$`, 's');
const LOCATED = new RegExp(`^(.+?):(\\d+):(?:(\\d+):)? ${SEVERITY}: (.*)$`, 's');
const INCLUDED_FROM = /^In file included from (.+):(\d+):$/s;
// Only lines shaped like the excerpt's gutter join a message, so a line nobody recognises stays
// apart from it and is never hidden along with a message a caller chose not to show.
const EXCERPT = /^ *\d* \|( |$)/;
const LINKER_DETAIL = /^>>> /;
// The parenthesised path is the full one; without it, the first is already the path.
const LINKER_LOCATION = /^>>> (referenced by|defined at) (.+?):(\d+)(?: \((.+):(\d+)\))?$/s;
const LINKER_NOTE = { 'referenced by': 'referenced here', 'defined at': 'defined here' };
// Clang's own bracket holds only options, so text a program wrote, such as `[-1]`, stays put.
const OPTION = '-[A-Za-z][\\w#+=.-]*';
const FLAG = new RegExp(` \\[(${OPTION}(?:,${OPTION})*)\\]$`);
const COLOUR = /\x1b\[[\d;]*m/g;

/** @param {string} output one run of one tool @return {object[]} rationale in api.d.ts */
export function readDiagnostics(output) {
    const lines = (output.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(classify);
    const joined = (from, to) => lines.slice(from, to).map((entry) => entry.raw).join('');
    const records = [];
    const includers = new Map(); // a file to the line that included it, from every chain printed
    let open = null; // the diagnostic that excerpt, note and linker lines belong to

    // Text in between closes the message before it, so joining every record keeps the output's order.
    const other = (from, to) => {
        open = null;
        const last = records.at(-1);
        if (last?.severity === null) last.text += joined(from, to);
        else records.push({ severity: null, text: joined(from, to) });
    };

    for (let i = 0; i < lines.length;) {
        let at = i; // past an include chain, which only the message after it can take
        while (lines[at]?.kind === 'include') at++;
        const head = lines[at]?.head;
        if (head && (head.severity !== 'note' || open)) {
            learn(includers, lines.slice(i, at).map((entry) => entry.included), head.file);
            // Clang prints a message's own line breaks as they are, then its excerpt: lines with no
            // excerpt after them were never the message's.
            let end = at + 1;
            while (lines[end]?.kind === 'text') end++;
            if (lines[end]?.kind !== 'excerpt') end = at + 1;
            const message = [head.message, ...lines.slice(at + 1, end).map((entry) => entry.line)].join('\n');
            if (head.severity === 'note') {
                open.notes.push({ file: head.file, line: head.line, column: head.column, message });
                open.text += joined(i, end);
            } else {
                open = { ...head, ...splitFlag(message), notes: [], includedFrom: includedFrom(includers, head.file), text: joined(i, end) };
                records.push(open);
            }
            i = end;
        } else if (at === i && open && (lines[i].kind === 'excerpt' || lines[i].kind === 'linker')) {
            open.text += lines[i].raw;
            const reference = LINKER_LOCATION.exec(lines[i].line);
            if (reference) {
                const [, verb, name, line, path, pathLine] = reference;
                open.notes.push({ file: path ?? name, line: Number(pathLine ?? line), column: null, message: LINKER_NOTE[verb] });
            }
            i++;
        } else {
            const end = Math.max(at, i + 1);
            other(i, end);
            i = end;
        }
    }
    return records;
}

// One kind per line, in this order, so a gutter line is never a head however its source reads.
function classify(raw) {
    const line = raw.replace(/\r?\n?$/, '').replace(COLOUR, '');
    const included = INCLUDED_FROM.exec(line);
    if (included) return { raw, line, kind: 'include', included: { file: included[1], line: Number(included[2]) } };
    if (EXCERPT.test(line)) return { raw, line, kind: 'excerpt' };
    if (LINKER_DETAIL.test(line)) return { raw, line, kind: 'linker' };
    const head = readHead(line);
    return { raw, line, kind: head ? 'head' : 'text', head };
}

function readHead(line) {
    const bare = UNLOCATED.exec(line);
    if (bare) return head(bare[1], null, null, null, bare[2]);
    const located = LOCATED.exec(line);
    if (located) return head(located[4], located[1], Number(located[2]), located[3] ? Number(located[3]) : null, located[5]);
    return null;
}

function head(severity, file, line, column, message) {
    return { severity: severity === 'fatal error' ? 'error' : severity, file, line, column, message };
}

function splitFlag(message) {
    const bracket = FLAG.exec(message);
    if (!bracket) return { message, flag: null };
    // `[-Werror,-Wunused-variable]` names the warning last; a bare `[-Werror]` has only itself.
    const options = bracket[1].split(',');
    return { message: message.slice(0, bracket.index), flag: options.filter((option) => option !== '-Werror').pop() ?? options[0] };
}

// A chain is printed only when it changes, so each one is remembered file by file for the
// messages after it that come without one.
function learn(includers, chain, file) {
    if (chain.length === 0 || file === null) return;
    includers.set(file, chain.at(-1));
    for (let i = chain.length - 1; i > 0; i--) includers.set(chain[i].file, chain[i - 1]);
}

function includedFrom(includers, file) {
    const lines = [];
    const seen = new Set([file]);
    for (let at = includers.get(file); at && !seen.has(at.file); at = includers.get(at.file)) {
        lines.push(at);
        seen.add(at.file);
    }
    return lines;
}
