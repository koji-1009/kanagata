// Command-line interface, over an `Io` so it runs the same against the real system
// (node-io.ts, used by bin.ts) and in tests.

import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { GenerateError, generate, type Source } from "./index.ts";

/** What the CLI needs from the outside world. Failures throw IoError. */
export interface Io {
	/** The bytes of a file; `0` is standard input. */
	read(file: string | 0): Uint8Array;
	write(path: string, text: string): void;
	exists(path: string): boolean;
	stdout(text: string): void;
	stderr(text: string): void;
	/** A file shipped with kanagata. */
	/** A file of the package, by its path from the package root. */
	asset(name: "src/client.ts" | "package.json"): string;
}

/** An I/O failure; the message says what went wrong without naming the file (`no such file or directory`). */
export class IoError extends Error {}

const HELP = `kanagata - TypeScript types from OpenAPI 3.0 / 3.1 (JSON or YAML)

Usage:
  kanagata generate <openapi.json|yaml> [-o <out.d.ts>] [--check]
  kanagata init [-o <client.ts>] [--force]

Commands:
  generate   Write the type declarations for the document (- reads stdin)
  init       Copy the fetch client (kanagata/client) into your project to own it

Options:
  -o <path>   Output file (generate: stdout, init: ./client.ts)
  --check     Exit with 1 if the -o file differs from the generated output
  --force     Let init overwrite an existing file
  -h, --help  Show this help
  -V, --version  Show the version

Exit codes: 0 success, 1 --check found a difference, 2 input error,
3 a bug in kanagata
`;

/** Exit code for usage, input and I/O errors. */
const INPUT_ERROR = 2;

/** A usage or I/O error: printed to stderr, exit code 2. */
class Failure extends Error {}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Runs the CLI and returns the exit code. Anything but a usage, input or I/O error propagates. */
export function run(args: readonly string[], io: Io): number {
	const out = (text: string) => attempt("stdout", () => io.stdout(text));
	const err = (line: string) => {
		try {
			io.stderr(`${line}\n`);
		} catch (e) {
			if (!(e instanceof IoError)) throw e; // nowhere left to report an I/O failure
		}
	};
	try {
		switch (args[0]) {
			case "generate":
				return generateCommand(args.slice(1), io, out, err);
			case "init":
				return initCommand(args.slice(1), io, out);
			case "-h":
			case "--help":
				out(HELP);
				return 0;
			case "-V":
			case "--version":
				out(`kanagata ${version(io)}\n`);
				return 0;
			case undefined:
				throw new Failure(HELP);
			default:
				throw new Failure(`unknown command: ${args[0]} (see kanagata --help)`);
		}
	} catch (e) {
		if (!(e instanceof Failure || e instanceof GenerateError)) throw e;
		err(e.message);
		return INPUT_ERROR;
	}
}

/** Exit code for a bug in kanagata: an error `run` does not expect. */
const INTERNAL_ERROR = 3;

/** `run`, with a bug reported on stderr and exit code 3 (1 means `--check` found a difference). */
export function main(args: readonly string[], io: Io): number {
	try {
		return run(args, io);
	} catch (e) {
		try {
			io.stderr(`internal error (a bug in kanagata): ${inspect(e)}\n`);
		} catch {
			// nowhere left to report it; the exit code still says what happened
		}
		return INTERNAL_ERROR;
	}
}

function version(io: Io): string {
	return JSON.parse(io.asset("package.json")).version;
}

/** Runs an I/O step; its failure is reported as `label: message`. */
function attempt<T>(label: string, f: () => T): T {
	try {
		return f();
	} catch (e) {
		if (e instanceof IoError) throw new Failure(`${label}: ${e.message}`);
		throw e;
	}
}

interface Flags {
	positional: string[];
	output?: string;
	check: boolean;
	force: boolean;
	help: boolean;
}

function parseFlags(
	args: readonly string[],
	allowed: readonly string[],
): Flags {
	const f: Flags = { positional: [], check: false, force: false, help: false };
	const rest = args[Symbol.iterator]();
	for (const a of rest) {
		const isOption = a.startsWith("-") && a !== "-";
		const isHelp = a === "-h" || a === "--help";
		if (isOption && !allowed.includes(a) && !isHelp)
			throw new Failure(`unknown option: ${a}`);
		if (a === "-o") {
			const path = rest.next();
			if (path.done) throw new Failure("-o needs a path");
			f.output = path.value;
		} else if (a === "--check") f.check = true;
		else if (a === "--force") f.force = true;
		else if (isHelp) f.help = true;
		else f.positional.push(a);
	}
	return f;
}

function generateCommand(
	args: readonly string[],
	io: Io,
	out: (text: string) => void,
	err: (line: string) => void,
): number {
	const f = parseFlags(args, ["-o", "--check"]);
	if (f.help) {
		out(HELP);
		return 0;
	}
	const [input, extra] = f.positional;
	if (input === undefined)
		throw new Failure("missing <openapi.json|yaml> (use - for stdin)");
	if (extra !== undefined) throw new Failure(`unexpected argument: ${extra}`);
	if (f.check && f.output === undefined)
		throw new Failure("--check needs -o <out.d.ts>");
	const label = input === "-" ? "stdin" : input;
	const src = decode(
		label,
		attempt(label, () => io.read(input === "-" ? 0 : input)),
	);

	// A file has a location, so its $refs to other files can be followed; stdin has none.
	const generated = generate(
		src,
		input === "-" ? undefined : fileSource(input, io),
	);
	for (const w of generated.warnings) err(`${w.at}: warning: ${w.msg}`);

	const target = f.output;
	if (target === undefined) {
		out(generated.code);
		return 0;
	}
	if (f.check) {
		// A file that is missing or not UTF-8 is simply out of date.
		let current: string | undefined;
		try {
			current = strictUtf8.decode(io.read(target));
		} catch (e) {
			if (!(e instanceof IoError || e instanceof TypeError)) throw e;
		}
		if (current === generated.code) return 0;
		err(`${target}: out of date; run kanagata generate`);
		return 1;
	}
	attempt(target, () => io.write(target, generated.code));
	return 0;
}

function initCommand(
	args: readonly string[],
	io: Io,
	out: (text: string) => void,
): number {
	const f = parseFlags(args, ["-o", "--force"]);
	if (f.help) {
		out(HELP);
		return 0;
	}
	if (f.positional.length > 0)
		throw new Failure(`unexpected argument: ${f.positional[0]}`);
	const target = f.output ?? "client.ts";
	if (io.exists(target) && !f.force)
		throw new Failure(`${target}: already exists (use --force to overwrite)`);
	// The version tells which generator's rules (binary and text media types) the copy follows.
	const client = `// Written by \`kanagata init\` (kanagata ${version(io)}). This copy is yours: edit it as you like.\n${io.asset("src/client.ts")}`;
	attempt(target, () => io.write(target, client));
	return 0;
}

/** The input file's location, and a reader for the local files its `$ref`s point to. */
function fileSource(input: string, io: Io): Source {
	return {
		url: pathToFileURL(resolve(input)).href,
		read: (url) => {
			const target = new URL(url);
			if (target.protocol !== "file:")
				throw new Error("only local files are read");
			// Io takes paths as the user gives them: relative to the working directory.
			const bytes = io.read(relative(process.cwd(), fileURLToPath(target)));
			try {
				return strictUtf8.decode(bytes);
			} catch {
				throw new Error("not valid UTF-8");
			}
		},
	};
}

function decode(label: string, bytes: Uint8Array): string {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		throw new Failure(`${label}: stream did not contain valid UTF-8`);
	}
}
