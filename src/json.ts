// Minimal JSON parser that keeps key order and the original number notation.

import { GenerateError } from "./error.ts";

//
// `JSON.parse` cannot be used: it moves integer-like keys ("200", "0") to the front
// of an object and turns numbers into doubles, losing their notation.

/** Up to this many keys, an object is scanned for a repeated key; past it a Set is cheaper. */
const SCAN_KEYS = 8;

/** A number exactly as written in the input. */
export class JsonNumber {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
}

/** Whether `text` is a number in JSON's grammar. */
export function isJsonNumber(text: string): boolean {
	return /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text);
}

/** An object with its members in input order; its keys are unique (the JSON and YAML readers reject repeats). */
export class JsonObject {
	readonly entries: [string, Value][];
	readonly #index: Map<string, Value>;

	constructor(entries: [string, Value][] = []) {
		this.entries = entries;
		this.#index = new Map(entries);
	}

	/** The member with this key. */
	get(key: string): Value | undefined {
		return this.#index.get(key);
	}

	/** The member with this key if it is a string. */
	str(key: string): string | undefined {
		const v = this.#index.get(key);
		return typeof v === "string" ? v : undefined;
	}
}

export type Value = null | boolean | string | JsonNumber | Value[] | JsonObject;

export class ParseError extends GenerateError {
	readonly line: number;
	readonly col: number;
	readonly msg: string;

	constructor(line: number, col: number, msg: string) {
		super("json", `${line}:${col}: ${msg}`);
		this.line = line;
		this.col = col;
		this.msg = msg;
	}
}

/** Looks up an object member; undefined for anything that is not an object. */
export function get(v: Value | undefined, key: string): Value | undefined {
	return v instanceof JsonObject ? v.get(key) : undefined;
}

/** Looks up an object member that is a string. */
export function str(v: Value | undefined, key: string): string | undefined {
	return v instanceof JsonObject ? v.str(key) : undefined;
}

/**
 * Resolves a JSON Pointer, with or without the leading `#`.
 * Each token is percent-decoded, then `~1` becomes `/` and `~0` becomes `~`.
 */
export function pointer(root: Value, ptr: string): Value | undefined {
	const p = ptr.startsWith("#") ? ptr.slice(1) : ptr;
	if (p === "") return root;
	if (!p.startsWith("/")) return undefined;
	let cur: Value = root;
	for (const raw of p.slice(1).split("/")) {
		const token = unescapeToken(raw);
		let next: Value | undefined;
		if (cur instanceof JsonObject) {
			next = cur.get(token);
		} else if (Array.isArray(cur)) {
			if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
			next = cur[Number(token)];
		}
		if (next === undefined) return undefined;
		cur = next;
	}
	return cur;
}

/** A scalar as JSON: numbers as written. */
export function toJson(v: null | boolean | string | JsonNumber): string {
	return v instanceof JsonNumber ? v.text : JSON.stringify(v);
}

/** Decodes one JSON Pointer token from a URI fragment: percent escapes, then `~1` → `/` and `~0` → `~`. */
export function unescapeToken(raw: string): string {
	return decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Encodes one JSON Pointer token (`~` → `~0`, `/` → `~1`). */
export function escapeToken(s: string): string {
	return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Parses a JSON document. Throws ParseError. */
export function parse(src: string): Value {
	const p = new Parser(src);
	if (src.charCodeAt(0) === 0xfeff) p.pos = 1;
	p.ws();
	const v = p.value();
	p.ws();
	if (p.pos < src.length)
		throw p.err("unexpected characters after the JSON value");
	return v;
}

/** Characters a string run stops at: `"`, `\` and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON forbids raw U+0000–U+001F in strings; this range finds them.
const STRING_RUN = /[^"\\\u0000-\u001f]*/y;

class Parser {
	readonly src: string;
	pos = 0;

	constructor(src: string) {
		this.src = src;
	}

	err(msg: string, at = this.pos): ParseError {
		let line = 1;
		let col = 1;
		const end = Math.min(at, this.src.length);
		for (let i = 0; i < end; i++) {
			const c = this.src.charCodeAt(i);
			if (c === 0x0a) {
				line++;
				col = 1;
			} else if (c < 0xdc00 || c > 0xdfff) {
				// a low surrogate continues the character its high surrogate started
				col++;
			}
		}
		return new ParseError(line, col, msg);
	}

	peek(): number {
		// NaN at the end of input
		return this.src.charCodeAt(this.pos);
	}

	ws(): void {
		for (;;) {
			const c = this.peek();
			if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
			this.pos++;
		}
	}

	unexpected(): ParseError {
		const c = this.src.codePointAt(this.pos);
		if (c === undefined) return this.err("unexpected end of input");
		return this.err(
			`unexpected character ${JSON.stringify(String.fromCodePoint(c))}`,
		);
	}

	value(): Value {
		switch (this.peek()) {
			case 0x7b: // {
				return this.object();
			case 0x5b: // [
				return this.array();
			case 0x22: // "
				return this.string();
			case 0x74: // t
				return this.literal("true", true);
			case 0x66: // f
				return this.literal("false", false);
			case 0x6e: // n
				return this.literal("null", null);
			default: {
				const c = this.peek();
				if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
				throw this.unexpected();
			}
		}
	}

	object(): JsonObject {
		this.pos++;
		const members: [string, Value][] = [];
		// Most objects are small: a scan finds a repeated key there, a Set past SCAN_KEYS.
		let seen: Set<string> | undefined;
		this.ws();
		if (this.peek() === 0x7d) {
			this.pos++;
			return new JsonObject(members);
		}
		for (;;) {
			this.ws();
			const c = this.peek();
			if (c !== 0x22) {
				if (c === 0x7d && members.length > 0) throw this.err("trailing comma");
				throw this.unexpected();
			}
			const keyStart = this.pos;
			const key = this.string();
			// JSON leaves repeated keys to the reader; a schema with two is ambiguous.
			const repeated =
				seen === undefined ? members.some(([k]) => k === key) : seen.has(key);
			if (repeated)
				throw this.err(`duplicate key ${JSON.stringify(key)}`, keyStart);
			this.ws();
			if (this.peek() !== 0x3a) {
				throw this.err(
					this.pos >= this.src.length
						? "unexpected end of input"
						: "expected ':'",
				);
			}
			this.pos++;
			this.ws();
			members.push([key, this.value()]);
			if (seen !== undefined) seen.add(key);
			else if (members.length === SCAN_KEYS)
				seen = new Set(members.map(([k]) => k));
			this.ws();
			const d = this.peek();
			if (d === 0x2c) {
				this.pos++;
			} else if (d === 0x7d) {
				this.pos++;
				break;
			} else {
				throw this.err(
					this.pos >= this.src.length
						? "unexpected end of input"
						: "expected ',' or '}'",
				);
			}
		}
		return new JsonObject(members);
	}

	array(): Value[] {
		this.pos++;
		const items: Value[] = [];
		this.ws();
		if (this.peek() === 0x5d) {
			this.pos++;
			return items;
		}
		for (;;) {
			this.ws();
			if (this.peek() === 0x5d) throw this.err("trailing comma");
			items.push(this.value());
			this.ws();
			const d = this.peek();
			if (d === 0x2c) {
				this.pos++;
			} else if (d === 0x5d) {
				this.pos++;
				break;
			} else {
				throw this.err(
					this.pos >= this.src.length
						? "unexpected end of input"
						: "expected ',' or ']'",
				);
			}
		}
		return items;
	}

	string(): string {
		this.pos++; // opening quote
		let out = "";
		for (;;) {
			STRING_RUN.lastIndex = this.pos;
			STRING_RUN.test(this.src);
			out += this.src.slice(this.pos, STRING_RUN.lastIndex);
			this.pos = STRING_RUN.lastIndex;
			const c = this.peek();
			if (c === 0x22) {
				this.pos++;
				return out;
			}
			if (c === 0x5c) {
				out += this.escape();
			} else if (this.pos >= this.src.length) {
				throw this.err("unexpected end of input in string");
			} else {
				throw this.err("control character in string");
			}
		}
	}

	escape(): string {
		const start = this.pos;
		this.pos++; // backslash
		const c = this.peek();
		let out: string;
		switch (c) {
			case 0x22:
				out = '"';
				break;
			case 0x5c:
				out = "\\";
				break;
			case 0x2f:
				out = "/";
				break;
			case 0x62:
				out = "\b";
				break;
			case 0x66:
				out = "\f";
				break;
			case 0x6e:
				out = "\n";
				break;
			case 0x72:
				out = "\r";
				break;
			case 0x74:
				out = "\t";
				break;
			case 0x75: {
				// A UTF-16 code unit; a surrogate pair is two escapes, joined by the string.
				const hex = this.src.slice(this.pos + 1, this.pos + 5);
				this.pos += 5;
				return String.fromCharCode(Number.parseInt(hex, 16));
			}
			default:
				if (this.pos >= this.src.length)
					throw this.err("unexpected end of input in string");
				throw this.err("invalid escape sequence", start);
		}
		this.pos++;
		return out;
	}

	number(): JsonNumber {
		const start = this.pos;
		if (this.peek() === 0x2d) this.pos++;
		const first = this.peek();
		if (first === 0x30) this.pos++;
		else if (first >= 0x31 && first <= 0x39) this.digits();
		else throw this.err("invalid number", start);
		if (this.peek() === 0x2e) {
			this.pos++;
			if (!isDigit(this.peek())) throw this.err("invalid number", start);
			this.digits();
		}
		const e = this.peek();
		if (e === 0x65 || e === 0x45) {
			this.pos++;
			const sign = this.peek();
			if (sign === 0x2b || sign === 0x2d) this.pos++;
			if (!isDigit(this.peek())) throw this.err("invalid number", start);
			this.digits();
		}
		return new JsonNumber(this.src.slice(start, this.pos));
	}

	digits(): void {
		while (isDigit(this.peek())) this.pos++;
	}

	literal<T extends Value>(word: string, v: T): T {
		if (!this.src.startsWith(word, this.pos)) throw this.unexpected();
		this.pos += word.length;
		return v;
	}
}

function isDigit(c: number): boolean {
	return c >= 0x30 && c <= 0x39;
}
