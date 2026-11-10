// CLI behaviour (arguments, output files, exit codes, stderr), run in process
// against an in-memory Io. bin.test.ts checks the wiring to the real system.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Io, IoError, main, run } from "../src/cli.ts";

const SPEC = join(import.meta.dirname, "spec");
const BASIC = readFileSync(join(SPEC, "basic", "input.json"), "utf8");
const BASIC_DTS = readFileSync(join(SPEC, "basic", "expected.d.ts"), "utf8");
const encode = (text: string) => new TextEncoder().encode(text);

/** An in-memory file system and captured output; `fail` makes an operation throw. */
function memoryIo(
	files: Record<string, string | Uint8Array> = {},
	fail: Partial<Record<keyof Io, Error>> = {},
) {
	const fs = new Map(
		Object.entries(files).map(([k, v]) => [
			k,
			typeof v === "string" ? encode(v) : v,
		]),
	);
	const out = { stdout: "", stderr: "" };
	const check = (op: keyof Io) => {
		const e = fail[op];
		if (e !== undefined) throw e;
	};
	const io: Io = {
		read: (file) => {
			check("read");
			const bytes = fs.get(file === 0 ? "<stdin>" : file);
			if (bytes === undefined) throw new IoError("no such file or directory");
			return bytes;
		},
		write: (path, text) => {
			check("write");
			fs.set(path, encode(text));
		},
		exists: (path) => fs.has(path),
		stdout: (text) => {
			check("stdout");
			out.stdout += text;
		},
		stderr: (text) => {
			check("stderr");
			out.stderr += text;
		},
		asset: (name) =>
			name === "src/client.ts" ? "// the client\n" : '{"version":"9.9.9"}',
	};
	const text = (path: string) => new TextDecoder().decode(fs.get(path));
	return { io, out, text, fs };
}

test("generate to stdout", () => {
	const { io, out } = memoryIo({ "api.json": BASIC });
	assert.equal(run(["generate", "api.json"], io), 0);
	assert.equal(out.stdout, BASIC_DTS);
	assert.equal(out.stderr, "");
});

test("generate from stdin", () => {
	const { io, out } = memoryIo({ "<stdin>": BASIC });
	assert.equal(run(["generate", "-"], io), 0);
	assert.equal(out.stdout, BASIC_DTS);
});

test("generate to a file, then --check it", () => {
	const { io, out, text, fs } = memoryIo({ "api.json": BASIC });
	assert.equal(
		run(["generate", "api.json", "-o", "schema.d.ts", "--check"], io),
		1,
		"a missing file is out of date",
	);
	assert.equal(out.stderr, "schema.d.ts: out of date; run kanagata generate\n");

	assert.equal(run(["generate", "api.json", "-o", "schema.d.ts"], io), 0);
	assert.equal(text("schema.d.ts"), BASIC_DTS);
	assert.equal(out.stdout, "");
	assert.equal(
		run(["generate", "api.json", "-o", "schema.d.ts", "--check"], io),
		0,
	);

	fs.set("schema.d.ts", encode("stale"));
	assert.equal(
		run(["generate", "api.json", "-o", "schema.d.ts", "--check"], io),
		1,
	);
	assert.equal(text("schema.d.ts"), "stale", "--check never writes");

	fs.set("schema.d.ts", new Uint8Array([0xff, 0xfe]));
	assert.equal(
		run(["generate", "api.json", "-o", "schema.d.ts", "--check"], io),
		1,
		"a file that is not UTF-8 is out of date",
	);
});

test("warnings go to stderr, the declarations still to stdout", () => {
	const src = readFileSync(join(SPEC, "unsupported-not", "input.json"), "utf8");
	const { io, out } = memoryIo({ "api.json": src });
	assert.equal(run(["generate", "api.json"], io), 0);
	assert.equal(
		out.stderr,
		readFileSync(
			join(SPEC, "unsupported-not", "expected.warn"),
			"utf8",
		).replace(/^(.*?): /gm, "$1: warning: "),
	);
	assert.equal(
		out.stdout,
		readFileSync(join(SPEC, "unsupported-not", "expected.d.ts"), "utf8"),
	);
});

test("input errors exit 2 with the message on stderr", () => {
	const { io, out } = memoryIo({
		"bad.json": "{",
		"latin1.json": new Uint8Array([0x7b, 0xff]),
	});
	assert.equal(run(["generate", "bad.json"], io), 2);
	assert.equal(out.stderr, "1:2: unexpected end of input\n");
	out.stderr = "";
	assert.equal(run(["generate", "latin1.json"], io), 2);
	assert.equal(out.stderr, "latin1.json: stream did not contain valid UTF-8\n");
	assert.equal(out.stdout, "");
});

test("YAML files are read like JSON ones", () => {
	const yaml = readFileSync(join(SPEC, "yaml-basic", "input.yaml"), "utf8");
	const { io, out } = memoryIo({ "api.yaml": yaml });
	assert.equal(run(["generate", "api.yaml"], io), 0);
	assert.equal(out.stdout, BASIC_DTS);
});

test("external $refs are read relative to the input file; stdin has no location", () => {
	const doc =
		'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"defs/a.yaml"}}}}';
	const { io, out } = memoryIo({
		"api/openapi.json": doc,
		"api/defs/a.yaml": "type: string\n",
		"<stdin>": doc,
	});
	assert.equal(run(["generate", "api/openapi.json"], io), 0);
	assert.match(out.stdout, /export type A = string;/);
	assert.equal(run(["generate", "-"], io), 2);
	assert.equal(
		out.stderr,
		"#/components/schemas/A: external $ref, but the document's location is unknown: defs/a.yaml\n",
	);
});

test("a referenced file that is not UTF-8 cannot be read", () => {
	const { io, out } = memoryIo({
		"api.json":
			'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"a.yaml"}}}}',
		"a.yaml": new Uint8Array([0xff]),
	});
	assert.equal(run(["generate", "api.json"], io), 2);
	assert.equal(
		out.stderr,
		"#/components/schemas/A: cannot read a.yaml: not valid UTF-8\n",
	);
});

test("I/O failures exit 2 as `file: message`", () => {
	const missing = memoryIo();
	assert.equal(run(["generate", "nope.json"], missing.io), 2);
	assert.equal(missing.out.stderr, "nope.json: no such file or directory\n");

	const stdin = memoryIo({}, { read: new IoError("bad descriptor") });
	assert.equal(run(["generate", "-"], stdin.io), 2);
	assert.equal(stdin.out.stderr, "stdin: bad descriptor\n");

	const unwritable = memoryIo(
		{ "api.json": BASIC },
		{ write: new IoError("permission denied") },
	);
	assert.equal(
		run(["generate", "api.json", "-o", "out.d.ts"], unwritable.io),
		2,
	);
	assert.equal(unwritable.out.stderr, "out.d.ts: permission denied\n");
	assert.equal(run(["init", "-o", "c.ts"], unwritable.io), 2);
	assert.match(unwritable.out.stderr, /c\.ts: permission denied\n$/);

	const closed = memoryIo(
		{ "api.json": BASIC },
		{ stdout: new IoError("broken pipe") },
	);
	assert.equal(run(["generate", "api.json"], closed.io), 2);
	assert.equal(closed.out.stderr, "stdout: broken pipe\n");
});

test("a failing stderr does not change the exit code", () => {
	const { io } = memoryIo({}, { stderr: new IoError("broken pipe") });
	assert.equal(run(["frobnicate"], io), 2);
});

test("anything but a usage, input or I/O error is a bug: exit 3, leaving 1 to --check", () => {
	const { io, out } = memoryIo(
		{ "api.json": BASIC },
		{ read: new RangeError("bug in read") },
	);
	assert.equal(main(["generate", "api.json"], io), 3);
	assert.match(
		out.stderr,
		/^internal error \(a bug in kanagata\): RangeError: bug in read\n {4}at /,
	);
	const ok = memoryIo({ "api.json": BASIC });
	assert.equal(main(["generate", "api.json"], ok.io), 0);
	const stdout = memoryIo(
		{ "api.json": BASIC },
		{ stdout: new RangeError("bug") },
	);
	assert.equal(main(["generate", "api.json"], stdout.io), 3);
	const check = memoryIo({ "api.json": BASIC, "out.d.ts": "x" });
	check.io.read = (file) => {
		if (file === "out.d.ts") throw new RangeError("bug");
		return encode(BASIC);
	};
	assert.equal(
		main(["generate", "api.json", "-o", "out.d.ts", "--check"], check.io),
		3,
	);
	// A bug in writing to stderr leaves only the exit code.
	const silent = memoryIo({}, { stderr: new RangeError("bug in stderr") });
	assert.equal(main(["frobnicate"], silent.io), 3);
});

test("usage errors exit 2", () => {
	const cases: [string[], string][] = [
		[["generate"], "missing <openapi.json|yaml> (use - for stdin)\n"],
		[["generate", "a.json", "b.json"], "unexpected argument: b.json\n"],
		[["generate", "a.json", "--check"], "--check needs -o <out.d.ts>\n"],
		[["generate", "a.json", "--force"], "unknown option: --force\n"],
		[["generate", "a.json", "-o"], "-o needs a path\n"],
		[["init", "--check"], "unknown option: --check\n"],
		[["init", "extra"], "unexpected argument: extra\n"],
		[["frobnicate"], "unknown command: frobnicate (see kanagata --help)\n"],
	];
	for (const [args, stderr] of cases) {
		const { io, out } = memoryIo();
		assert.equal(run(args, io), 2, args.join(" "));
		assert.equal(out.stderr, stderr, args.join(" "));
	}
	const { io, out } = memoryIo();
	assert.equal(run([], io), 2);
	assert.match(out.stderr, /^kanagata - TypeScript types/);
});

test("help and version", () => {
	for (const args of [
		["--help"],
		["-h"],
		["generate", "--help"],
		["init", "-h"],
	]) {
		const { io, out } = memoryIo();
		assert.equal(run(args, io), 0, args.join(" "));
		assert.match(out.stdout, /kanagata generate/, args.join(" "));
	}
	for (const args of [["--version"], ["-V"]]) {
		const { io, out } = memoryIo();
		assert.equal(run(args, io), 0);
		assert.equal(out.stdout, "kanagata 9.9.9\n");
	}
});

test("init writes the client, stamped with the version, once unless --force", () => {
	const { io, out, text, fs } = memoryIo();
	const copy = (s: string) => s.endsWith("// the client\n");
	assert.equal(run(["init"], io), 0);
	assert.equal(
		text("client.ts"),
		"// Written by `kanagata init` (kanagata 9.9.9). This copy is yours: edit it as you like.\n// the client\n",
		"./client.ts by default",
	);

	assert.equal(run(["init", "-o", "src/client.ts"], io), 0);
	fs.set("src/client.ts", encode("mine"));
	assert.equal(run(["init", "-o", "src/client.ts"], io), 2);
	assert.equal(
		out.stderr,
		"src/client.ts: already exists (use --force to overwrite)\n",
	);
	assert.equal(text("src/client.ts"), "mine");
	assert.equal(run(["init", "-o", "src/client.ts", "--force"], io), 0);
	assert.ok(copy(text("src/client.ts")));
});
