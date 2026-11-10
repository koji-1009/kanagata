// What the package publishes: src/ is the library, compiled one to one into dist/.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const build = JSON.parse(read("tsconfig.build.json"));

/** The source a published dist/ file is compiled from. */
function source(published: string): string {
	const m = /^(?:\.\/)?dist\/(.+)\.(?:d\.ts|js)$/.exec(published);
	assert.ok(m, `${published} is not in dist/`);
	return `src/${m[1]}.ts`;
}

test("the build is ES2022, the client's syntax baseline README states", () => {
	assert.equal(build.compilerOptions.target, "es2022");
});

test("every entry point is a dist/ file built from a source in src/", () => {
	assert.deepEqual(pkg.exports, {
		".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
		"./client": { types: "./dist/client.d.ts", default: "./dist/client.js" },
	});
	const entries = [
		pkg.bin.kanagata,
		...Object.values<Record<string, string>>(pkg.exports).flatMap(
			Object.values,
		),
	];
	for (const entry of entries)
		assert.ok(existsSync(new URL(source(entry), root)), entry);
});

test("the package ships dist/ and the client's source, which init copies", () => {
	assert.deepEqual(pkg.files, ["dist", "src/client.ts"]);
});

test("the client imports nothing, so an app bundles only the client", () => {
	assert.doesNotMatch(
		read("src/client.ts"),
		/^\s*import\b|\bfrom\s+["']|\bimport\(/m,
	);
});
