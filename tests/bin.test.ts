// The executable, as a user runs it: arguments in, exit code and output out.
// Behaviour is covered in process by cli.test.ts; this checks the wiring.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const BIN = join(ROOT, "src", "bin.ts");
const BASIC = join(ROOT, "tests", "spec", "basic");

test("generate prints the declarations and exits 0", () => {
	const out = spawnSync(
		process.execPath,
		[BIN, "generate", join(BASIC, "input.json")],
		{ encoding: "utf8" },
	);
	assert.equal(out.status, 0);
	assert.equal(out.stdout, readFileSync(join(BASIC, "expected.d.ts"), "utf8"));
	assert.equal(out.stderr, "");
});

test("an error goes to stderr with exit code 2", () => {
	const out = spawnSync(
		process.execPath,
		[BIN, "generate", "does-not-exist.json"],
		{ encoding: "utf8" },
	);
	assert.equal(out.status, 2);
	assert.match(out.stderr, /^does-not-exist\.json: \S/);
	assert.doesNotMatch(out.stderr, /ENOENT/);
});

test("a stdout nobody reads exits 2", async () => {
	const child = spawn(
		process.execPath,
		[BIN, "generate", join(BASIC, "input.json")],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout.destroy();
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (d: string) => {
		stderr += d;
	});
	const status = await new Promise<number | null>((resolve) =>
		child.on("close", resolve),
	);
	assert.equal(status, 2);
	assert.match(stderr, /^stdout: \S/);
});
