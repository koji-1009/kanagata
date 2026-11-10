// The real Io: file system calls and their errors.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IoError } from "../src/cli.ts";
import { nodeIo, plainMessage, writeAll } from "../src/node-io.ts";

const ROOT = join(import.meta.dirname, "..");

test("files are read, written and checked for", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "kanagata-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "a.txt");
	assert.equal(nodeIo.exists(file), false);
	nodeIo.write(file, "héllo");
	assert.equal(nodeIo.exists(file), true);
	assert.equal(new TextDecoder().decode(nodeIo.read(file)), "héllo");
	assert.throws(() => nodeIo.read(join(dir, "missing")), IoError);
	// Missing parent directories are created, as for `-o src/api/schema.d.ts` in a new project.
	nodeIo.write(join(dir, "src", "api", "schema.d.ts"), "x");
	assert.equal(nodeIo.exists(join(dir, "src", "api", "schema.d.ts")), true);
	// A parent that is a file cannot be.
	assert.throws(() => nodeIo.write(join(file, "inside.ts"), "x"), IoError);
});

test("assets come from the package root", () => {
	assert.equal(
		nodeIo.asset("src/client.ts"),
		readFileSync(join(ROOT, "src", "client.ts"), "utf8"),
	);
	assert.equal(JSON.parse(nodeIo.asset("package.json")).name, "kanagata");
});

test("Node's error text loses the code and the file name", () => {
	const e = (message: string) =>
		Object.assign(new Error(message), { code: message.split(":")[0] });
	assert.equal(
		plainMessage(e("ENOENT: no such file or directory, open 'a/b.json'")),
		"no such file or directory",
	);
	assert.equal(plainMessage(e("EPIPE: broken pipe, write")), "broken pipe");
	assert.equal(plainMessage(new Error("something else")), "something else");
});

test("writeAll continues after partial writes and a full pipe", () => {
	const written: number[] = [];
	let calls = 0;
	writeAll(
		(bytes, offset) => {
			calls++;
			if (calls === 2)
				throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
			const n = Math.min(2, bytes.length - offset);
			written.push(...bytes.subarray(offset, offset + n));
			return n;
		},
		new Uint8Array([1, 2, 3, 4, 5]),
	);
	assert.deepEqual(written, [1, 2, 3, 4, 5]);
	assert.throws(
		() =>
			writeAll(
				() => {
					throw Object.assign(new Error("EPIPE: broken pipe, write"), {
						code: "EPIPE",
					});
				},
				new Uint8Array([1]),
			),
		/EPIPE/,
	);
});

test("stdout and stderr write through", () => {
	// Writing nothing exercises the real descriptors without printing into the test report.
	nodeIo.stdout("");
	nodeIo.stderr("");
});
