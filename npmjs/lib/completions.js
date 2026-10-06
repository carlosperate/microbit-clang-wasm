// Reads what `clang -fsyntax-only -Xclang -code-completion-at=<file>:<line>:<column>` prints on
// stdout, one record per line. The format is `PrintingCodeCompleteConsumer`'s in Clang's
// `lib/Sema/CodeCompleteConsumer.cpp`, a testing interface upstream checks line by line but never
// documents, so each LLVM line's own output is stored and read in this package's tests.

const CANDIDATE = /^COMPLETION: (.*)$/s;
const PATTERN = 'Pattern';
const TAGS = / \(((?:Hidden|InBase|Inaccessible)(?:,(?:Hidden|InBase|Inaccessible))*)\)$/;
const OVERLOAD = /^OVERLOAD: (.*)$/s;
// A parenthesis that comes from a macro also says where it was spelled.
const OPENING_PAREN = /^OPENING_PAREN_LOC: (.+?):(\d+):(\d+)(?: <Spelling=.*>)?$/s;
const PREFERRED_TYPE = /^PREFERRED-TYPE: (.*)$/s;
// Between a candidate's name, its completion string and its brief comment.
const SEPARATOR = ' : ';

/** @param {string} output one run's stdout @return {object[]} rationale in api.d.ts */
export function readCompletions(output) {
    return (output.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text) => read(text.replace(/\r?\n$/, ''), text));
}

function read(line, text) {
    const candidate = CANDIDATE.exec(line);
    if (candidate) return readCandidate(candidate[1], text) ?? { kind: null, text };
    const overload = OVERLOAD.exec(line);
    if (overload) {
        const string = readString(overload[1], 0, false);
        return string ? { kind: 'overload', chunks: string.chunks, text } : { kind: null, text };
    }
    const paren = OPENING_PAREN.exec(line);
    if (paren) return { kind: 'opening-paren', file: paren[1], line: Number(paren[2]), column: Number(paren[3]), text };
    const preferred = PREFERRED_TYPE.exec(line);
    if (preferred) return { kind: 'preferred-type', type: preferred[1], text };
    return { kind: null, text };
}

// `<name>[ (<tags>)] : <string>[ : <brief comment>]`; a keyword's name alone; or a pattern, such
// as `sizeof(<#expression-or-type#>)`, named `Pattern` whatever it is.
function readCandidate(rest, text) {
    const split = rest.indexOf(SEPARATOR);
    if (split === -1) return { kind: 'keyword', name: rest, text };
    const head = rest.slice(0, split);
    const from = split + SEPARATOR.length;
    if (head === PATTERN) {
        const string = readString(rest, from, false);
        const name = string && patternName(string.chunks);
        return name ? { kind: 'pattern', name, chunks: string.chunks, text } : null;
    }
    const tags = TAGS.exec(head);
    const string = readString(rest, from, true);
    if (!string) return null;
    // The format has no escaping: the first separator outside a chunk ends the string.
    const brief = string.end < rest.length ? rest.slice(string.end + SEPARATOR.length) : null;
    const name = tags ? head.slice(0, tags.index) : head;
    return { kind: 'candidate', name, tags: tags ? tags[1].split(',') : [], chunks: string.chunks, brief, text };
}

// An included file or folder is one piece of text that ends as the include does, and is named whole
// but for its closing quote: `sensor(v2).h"`, `vector>`, `codal/`. In any other pattern what is typed
// comes first after the result type, up to its arguments: `sizeof` in `[#size_t#]sizeof(`, `delete []`.
function patternName(chunks) {
    const [only] = chunks;
    if (chunks.length === 1 && only.kind === 'text' && /["/>]$/.test(only.text)) return only.text.replace(/["> ]+$/, '');
    const first = chunks.find((chunk) => chunk.kind !== 'informative');
    return first?.kind === 'text' ? first.text.split(/[(<]/)[0].replace(/ +$/, '') || null : null;
}

// `[#…#]` is a result type or informative text, `<#…#>` a placeholder, `{#…#}` an optional part
// holding chunks of its own, the rest plain text. Null when the brackets do not balance. Only a
// candidate has a brief comment after its string; an overload has none.
function readString(line, from, untilBrief) {
    const root = [];
    const open = [root];
    let plain = '';
    const flush = () => {
        if (plain) open.at(-1).push({ kind: 'text', text: plain });
        plain = '';
    };
    let at = from;
    while (at < line.length) {
        if (untilBrief && open.length === 1 && line.startsWith(SEPARATOR, at)) break;
        const mark = line.slice(at, at + 2);
        if (mark === '[#' || mark === '<#') {
            const end = line.indexOf(mark === '[#' ? '#]' : '#>', at + 2);
            if (end === -1) return null;
            flush();
            open.at(-1).push({ kind: mark === '[#' ? 'informative' : 'placeholder', text: line.slice(at + 2, end) });
            at = end + 2;
        } else if (mark === '{#') {
            flush();
            const optional = { kind: 'optional', chunks: [] };
            open.at(-1).push(optional);
            open.push(optional.chunks);
            at += 2;
        } else if (mark === '#}' && open.length > 1) {
            flush();
            open.pop();
            at += 2;
        } else {
            plain += line[at++];
        }
    }
    if (open.length > 1) return null;
    flush();
    return { chunks: root, end: at };
}
