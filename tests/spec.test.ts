// Specification runner.
//
// tests/spec/<name>/: input.json or input.yaml → expected.d.ts (and expected.warn, one warning per
// line as `location: message`; absent means no warnings), generated with the options
// in options.json (absent means none). Each input is generated twice to check determinism.
//
// tests/errors/<name>/: input.json or input.yaml → the CLI's stderr (expected.err)
// and exit code (expected.code).
//
// Expectations are written by hand and never rewritten by the runner.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Io, run } from "../src/cli.ts";
import { generate, type Options } from "../src/index.ts";
import { nodeIo } from "../src/node-io.ts";

const TESTS = import.meta.dirname;

function cases(kind: string): string[] {
	const root = join(TESTS, kind);
	const dirs = readdirSync(root)
		.sort()
		.map((d) => join(root, d))
		.filter((p) => statSync(p).isDirectory());
	assert.ok(dirs.length > 0, `no cases in ${root}`);
	return dirs;
}

const readOrEmpty = (path: string): string =>
	existsSync(path) ? readFileSync(path, "utf8") : "";

for (const dir of cases("spec")) {
	const name = dir.slice(dir.lastIndexOf("/") + 1);
	test(`spec/${name}`, () => {
		const input = ["input.json", "input.yaml"].find((f) =>
			existsSync(join(dir, f)),
		);
		assert.ok(input, `no input.json or input.yaml in ${dir}`);
		const src = readFileSync(join(dir, input), "utf8");
		// Other files in the case directory can be referred to.
		const source = {
			url: pathToFileURL(join(dir, input)).href,
			read: (url: string) => readFileSync(fileURLToPath(url), "utf8"),
		};
		const optionsFile = join(dir, "options.json");
		const options: Options = existsSync(optionsFile)
			? JSON.parse(readFileSync(optionsFile, "utf8"))
			: {};
		const generated = generate(src, source, options);
		assert.equal(
			generated.code,
			readFileSync(join(dir, "expected.d.ts"), "utf8"),
			"expected.d.ts",
		);
		const warnings = generated.warnings
			.map((w) => `${w.at}: ${w.msg}\n`)
			.join("");
		assert.equal(
			warnings,
			readOrEmpty(join(dir, "expected.warn")),
			"expected.warn",
		);
		assert.equal(
			generate(src, source, options).code,
			generated.code,
			"output is not deterministic",
		);
	});
}

for (const dir of cases("errors")) {
	const name = dir.slice(dir.lastIndexOf("/") + 1);
	test(`errors/${name}`, () => {
		const input = ["input.json", "input.yaml"].find((f) =>
			existsSync(join(dir, f)),
		);
		assert.ok(input, `no input.json or input.yaml in ${dir}`);
		// The CLI as run from the case directory, with its output captured.
		const out = { stdout: "", stderr: "" };
		const io: Io = {
			...nodeIo,
			read: (file) => nodeIo.read(file === 0 ? 0 : join(dir, file)),
			stdout: (text) => {
				out.stdout += text;
			},
			stderr: (text) => {
				out.stderr += text;
			},
		};
		const status = run(["generate", input], io);
		assert.equal(
			out.stderr,
			readFileSync(join(dir, "expected.err"), "utf8"),
			"expected.err",
		);
		assert.equal(
			String(status),
			readFileSync(join(dir, "expected.code"), "utf8").trim(),
			"exit code",
		);
		assert.equal(out.stdout, "", "stdout is not empty");
	});
}
