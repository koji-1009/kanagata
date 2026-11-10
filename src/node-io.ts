// The real `Io`: synchronous file system calls on the standard file descriptors,
// so output is complete before the process exits and write errors are reported.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Io, IoError } from "./cli.ts";

/** The package root: the nearest directory above this file with a package.json (above src/ in development, dist/ when built). */
function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
	return dir;
}

export const nodeIo: Io = {
	read: (file) => io(() => readFileSync(file)),
	write: (path, text) =>
		io(() => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}),
	exists: (path) => existsSync(path),
	stdout: (text) =>
		io(() =>
			writeAll(
				(bytes, offset) => writeSync(1, bytes, offset),
				Buffer.from(text),
			),
		),
	stderr: (text) =>
		io(() =>
			writeAll(
				(bytes, offset) => writeSync(2, bytes, offset),
				Buffer.from(text),
			),
		),
	asset: (name) => readFileSync(join(packageRoot(), name), "utf8"),
};

/** Runs a file system call, turning its error into an IoError with a plain message. */
function io<T>(f: () => T): T {
	try {
		return f();
	} catch (e) {
		throw new IoError(plainMessage(e as Error));
	}
}

/** `no such file or directory` from Node's `ENOENT: no such file or directory, open 'x'`. */
export function plainMessage(e: Error): string {
	return (
		/^[A-Z]+: (.*?)(?:, \w+(?: '.*')?)?$/s.exec(e.message)?.[1] ?? e.message
	);
}

/**
 * Writes all of `bytes` with `write(bytes, offset) → bytes written`, retrying when a
 * non-blocking pipe is full (EAGAIN): stdout can be a pipe a parent made non-blocking.
 */
export function writeAll(
	write: (bytes: Uint8Array, offset: number) => number,
	bytes: Uint8Array,
): void {
	let done = 0;
	while (done < bytes.length) {
		try {
			done += write(bytes, done);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
		}
	}
}
