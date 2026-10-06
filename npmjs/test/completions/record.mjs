// Stores what this checkout's built package prints on stdout for each case, under its LLVM version,
// for the tests that run without a compiler. Run from `npmjs/` after `npm run all`:
// `node test/completions/record.mjs`. Diff the result against the previous line's to see a change.

import { mkdir, writeFile } from 'node:fs/promises';

import { cases, produce } from './cases.mjs';

const { createSession } = await import('microbit-clang-wasm');
const { default: pkg } = await import('microbit-clang-wasm/package.json', { with: { type: 'json' } });

const out = new URL(`${pkg.llvm.version}/`, import.meta.url);
await mkdir(out, { recursive: true });
const session = createSession();
for (const testCase of cases) {
    await writeFile(new URL(`${testCase.name}.txt`, out), (await produce(session, testCase)).stdout);
    console.log(`${pkg.llvm.version}/${testCase.name}.txt`);
}
