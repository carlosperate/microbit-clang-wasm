// The claim this whole package rests on: given the same source and the same flags, it generates
// exactly what Arm's own Clang generates. Objects are compared byte for byte with `.comment`
// removed, which carries each build's producer string and is the one place the two legitimately
// differ.
//
// Skipped unless ATFE_HOME points at an Arm Toolchain for Embedded install and ATFE_SYSROOT at the
// flat sysroot `atfe-sysroot.sh` assembles.

import { commands } from 'microbit-clang-wasm';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { ATFE_HOME, ATFE_SYSROOT } = process.env;
const ready = ATFE_HOME && ATFE_SYSROOT;

const CPU = ['--target=arm-none-eabi', '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=softfp'];
const CXX = ['-O2', '-std=c++11', '-fno-exceptions', '-fno-rtti'];

// Between them these reach the C library, the C++ headers, libm and the optimiser, which is where a
// compiler built differently would show up.
const CASES = [
	{
		name: 'a C++ translation unit, the flags CODAL builds with',
		file: 'probe.cpp',
		driver: 'clang++',
		flags: [...CPU, ...CXX],
		source: `#include <cstdint>
#include <cstring>
#include <cmath>

struct Buffer { uint8_t data[64]; int used; };
static Buffer buffer;

template <typename T> static T clampTo(T value, T low, T high) {
    return value < low ? low : (value > high ? high : value);
}

extern "C" int append(const char *text, int limit) {
    int length = clampTo<int>((int)strlen(text), 0, limit);
    memcpy(buffer.data + buffer.used, text, length);
    buffer.used += length;
    return (int)sqrtf((float)buffer.used) + clampTo(length, 1, 32);
}
`,
	},
	{
		name: 'a C translation unit against newlib',
		file: 'probe.c',
		driver: 'clang',
		flags: [...CPU, '-O2', '-std=c11'],
		source: `#include <stdint.h>
#include <string.h>
#include <stdlib.h>

static char scratch[128];

uint32_t summarise(const char *text) {
    size_t length = strlen(text);
    if (length >= sizeof(scratch)) length = sizeof(scratch) - 1;
    memmove(scratch, text, length);
    scratch[length] = 0;
    return (uint32_t)(strtoul(scratch, NULL, 10) + length);
}
`,
	},
];

/** Everything but the producer string, which records how each compiler was built. */
async function withoutComment(directory, name, bytes) {
	const object = path.join(directory, name);
	await writeFile(object, bytes);
	const stripped = `${object}.stripped`;
	await run(path.join(ATFE_HOME, 'bin', 'llvm-objcopy'), ['--remove-section=.comment', object, stripped]);
	return createHash('sha256').update(await readFile(stripped)).digest('hex');
}

for (const { name, file, driver, flags, source } of CASES) {
	test(`generates what Arm's Clang generates for ${name}`, {
		skip: ready ? false : 'set ATFE_HOME and ATFE_SYSROOT',
	}, async () => {
		const work = await mkdtemp(path.join(tmpdir(), 'equivalence-'));
		const object = `${file}.o`;

		// The packaged sysroot is mounted at /usr inside the compiler; the native one is a real path.
		const out = await commands[driver]([...flags, '--sysroot=/usr', '-c', file, '-o', object], { [file]: source });
		assert.ok(out[object] instanceof Uint8Array, `the WebAssembly compiler produced no ${object}`);

		const sourcePath = path.join(work, file);
		await writeFile(sourcePath, source);
		const nativeObject = path.join(work, `native-${object}`);
		await run(path.join(ATFE_HOME, 'bin', driver), [
			...flags, `--sysroot=${ATFE_SYSROOT}`, '-c', sourcePath, '-o', nativeObject,
		]);

		assert.equal(
			await withoutComment(work, `wasm-${object}`, out[object]),
			await withoutComment(work, `copy-${object}`, await readFile(nativeObject)),
			'the two compilers disagree about this translation unit'
		);
	});
}
