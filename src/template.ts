// An ECMA-262 `pattern` → the strings it matches, as template literal types.
//
// A pattern says which strings match; a template literal type (`` `https://${string}` ``)
// says which strings it admits. Where a pattern's strings are exactly a template's (fixed
// text, finite sets of characters, any text), the pattern is that type; anything else
// (`.`, `+`, a negated class, lookarounds, …) is no type.

import { lit, STRING, type Ty, union } from "./ty.ts";

/**
 * The most strings TypeScript builds into one union from a template: it rejects 100,000
 * ("Expression produces a union type that is too complex to represent", TS2590).
 */
export const MAX_UNION = 99_999;

/** Part of a template: one of a finite set of strings, or any text. */
type Segment = { set: string[] } | { any: true };

const ANY: Segment = { any: true };

/** A template: its segments, one after the other. */
type Seq = Segment[];

/** Strings: the union of some templates. */
type Lang = Seq[];

/** No type says the strings: a reason not to read further. */
class NoType extends Error {}

/** How many strings of fixed length a template's sets make. */
function count(seq: Seq): number {
	let n = 1;
	for (const s of seq) if ("set" in s) n *= s.set.length;
	return n;
}

function size(lang: Lang): number {
	let n = 0;
	for (const seq of lang) n += count(seq);
	return n;
}

/** Strings no more than TypeScript builds into a union. */
function bounded(lang: Lang): Lang {
	if (size(lang) > MAX_UNION) throw new NoType();
	return lang;
}

/** Every string of `a` followed by every string of `b`. */
function concat(a: Lang, b: Lang): Lang {
	const out: Lang = [];
	for (const x of a) for (const y of b) out.push([...x, ...y]);
	return bounded(out);
}

const EMPTY: Lang = [[]];

/** Characters that stand for themselves when escaped. */
const SYNTAX = new Set("^$\\.*+?()[]{}|/");

const range = (from: number, to: number): string[] =>
	Array.from({ length: to - from + 1 }, (_, i) =>
		String.fromCodePoint(from + i),
	);

const chars = (codes: number[]): string[] =>
	codes.map((c) => String.fromCodePoint(c));

/** The characters `\s` matches: WhiteSpace and LineTerminator (ECMA-262). */
const SPACE = [
	...range(0x09, 0x0d),
	...chars([0x20, 0xa0, 0x1680]),
	...range(0x2000, 0x200a),
	...chars([0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]),
];

const DIGIT = range(0x30, 0x39);
const WORD = [...range(0x41, 0x5a), ...range(0x61, 0x7a), ...DIGIT, "_"];

/** What a class escape matches; for `\D`, `\S`, `\W`, the escape it negates. */
const CLASS_ESCAPES: Record<string, string[]> = { d: DIGIT, s: SPACE, w: WORD };

/** What an atom matches: some strings, or any one character (`[\s\S]`), which only `*` makes a type of. */
interface Atom {
	lang: Lang;
	anyChar: boolean;
}

/** A parser over a pattern's code points (the `u` flag: JSON Schema patterns are Unicode). */
class Parser {
	readonly cs: string[];
	i = 0;

	constructor(pattern: string) {
		this.cs = [...pattern];
	}

	get done(): boolean {
		return this.i >= this.cs.length;
	}

	peek(): string | undefined {
		return this.cs[this.i];
	}

	/** The next code point; the pattern is one RegExp reads, so it does not end where one is due. */
	next(): string {
		return this.cs[this.i++] as string;
	}

	/** alternation := sequence ('|' sequence)* */
	alternation(top: boolean): Lang {
		const alts = [this.sequence(top)];
		while (this.peek() === "|") {
			this.i++;
			alts.push(this.sequence(top));
		}
		return bounded(alts.flat());
	}

	/** A sequence of terms; at the top, `^` and `$` anchor it, and it is unanchored without them. */
	sequence(top: boolean): Lang {
		let lang = EMPTY;
		const start = top && this.peek() === "^";
		if (start) this.i++;
		else if (top) lang = [[ANY]];
		let end = false;
		while (!this.done && this.peek() !== "|" && this.peek() !== ")") {
			if (top && this.peek() === "$") {
				this.i++;
				end = true;
				break;
			}
			lang = concat(lang, this.term());
		}
		if (top && !end) lang = concat(lang, [[ANY]]);
		// A `$` before the sequence ends anchors nothing a template says.
		if (end && !this.done && this.peek() !== "|") throw new NoType();
		return lang;
	}

	/** term := atom quantifier? */
	term(): Lang {
		const atom = this.atom();
		const c = this.peek();
		if (c === "?") {
			this.i++;
			this.lazy();
			if (atom.anyChar) throw new NoType();
			return [...EMPTY, ...atom.lang];
		}
		if (c === "*" || c === "+") {
			this.i++;
			this.lazy();
			// Any number of any character is any text; anything else repeated is no template.
			if (c === "*" && atom.anyChar) return [[ANY]];
			throw new NoType();
		}
		if (c === "{") {
			// With the `u` flag a `{` here begins a quantifier.
			const m = /^\{(\d+)(,(\d*))?\}/.exec(
				this.cs.slice(this.i).join(""),
			) as RegExpExecArray;
			this.i += m[0].length;
			this.lazy();
			const min = Number(m[1]);
			const max =
				m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
			if (max === Infinity || atom.anyChar) throw new NoType();
			let out: Lang = [];
			let power = EMPTY;
			for (let k = 0; k <= max; k++) {
				if (k >= min) out = bounded([...out, ...power]);
				if (k < max) power = concat(power, atom.lang);
			}
			return out;
		}
		if (atom.anyChar) throw new NoType();
		return atom.lang;
	}

	/** A `?` after a quantifier makes it lazy, which changes nothing a type says. */
	lazy(): void {
		if (this.peek() === "?") this.i++;
	}

	atom(): Atom {
		const c = this.next();
		if (c === "(") {
			if (this.peek() === "?") {
				this.i++;
				const kind = this.next();
				// (?:…) and (?<name>…) group; lookarounds say what no type does.
				if (kind === "<" && this.peek() !== "=" && this.peek() !== "!") {
					while (this.next() !== ">");
				} else if (kind !== ":") throw new NoType();
			}
			const lang = this.alternation(false);
			this.next(); // ")"
			return { lang, anyChar: false };
		}
		if (c === "[") return this.cls();
		if (c === "\\") {
			const e = this.escape(false);
			if (typeof e === "string")
				return { lang: [[{ set: [e] }]], anyChar: false };
			// \d, \s and \w are sets; \D, \S and \W, everything but one.
			const set = CLASS_ESCAPES[e.cls];
			if (set === undefined) throw new NoType();
			return { lang: [[{ set }]], anyChar: false };
		}
		// `.` leaves out line breaks; `^` and `$` here anchor what no template says.
		if (c === "." || c === "^" || c === "$") throw new NoType();
		return { lang: [[{ set: [c] }]], anyChar: false };
	}

	/**
	 * The character an escape stands for, or the class escape it is (`d`, `D`, …). In a class
	 * `\b` is a backspace and `\-` a hyphen; outside it `\b` and `\B` are word boundaries.
	 */
	escape(inClass: boolean): string | { cls: string } {
		const c = this.next();
		if (SYNTAX.has(c) || (inClass && c === "-")) return c;
		const controls: Record<string, string> = {
			t: "\t",
			n: "\n",
			v: "\v",
			f: "\f",
			r: "\r",
		};
		if (c in controls) return controls[c] as string;
		if (inClass && c === "b") return "\b";
		// With the `u` flag `\0` is not followed by a digit.
		if (c === "0") return "\0";
		if (c === "c")
			return String.fromCodePoint((this.next().codePointAt(0) as number) % 32);
		if (c === "x") return this.hex(2);
		if (c === "u") {
			if (this.peek() !== "{") return this.hex(4);
			this.i++;
			let digits = "";
			for (let d = this.next(); d !== "}"; d = this.next()) digits += d;
			return String.fromCodePoint(Number.parseInt(digits, 16));
		}
		if (c.toLowerCase() in CLASS_ESCAPES) return { cls: c };
		// Word boundaries, back references, \k<name>, \p{…}.
		throw new NoType();
	}

	hex(n: number): string {
		let digits = "";
		for (let k = 0; k < n; k++) digits += this.next();
		return String.fromCodePoint(Number.parseInt(digits, 16));
	}

	/** `[…]`: a finite set of characters, or any character (`[\s\S]`, `[^]`). */
	cls(): Atom {
		const negated = this.peek() === "^";
		if (negated) this.i++;
		const set = new Set<string>();
		const escapes = new Set<string>();
		// A range of more characters than a union holds is not written out: it is no finite
		// set, unless the class is any character anyway.
		let wide = false;
		const one = (): string | { cls: string } => {
			const c = this.next();
			return c === "\\" ? this.escape(true) : c;
		};
		while (this.peek() !== "]") {
			const a = one();
			if (typeof a !== "string") {
				escapes.add(a.cls);
				continue;
			}
			if (this.peek() === "-" && this.cs[this.i + 1] !== "]") {
				this.i++;
				// With the `u` flag a range ends at a character, not a class escape.
				const b = one() as string;
				const from = a.codePointAt(0) as number;
				const to = b.codePointAt(0) as number;
				if (to - from >= MAX_UNION) wide = true;
				else for (const x of range(from, to)) set.add(x);
			} else set.add(a);
		}
		this.i++;
		let any = false;
		for (const e of escapes) {
			const lower = e.toLowerCase();
			if (e === lower)
				for (const x of CLASS_ESCAPES[lower] as string[]) set.add(x);
			else if (escapes.has(lower)) any = true;
			else throw new NoType();
		}
		if (negated) {
			// [^] is any character; any other negated class is no finite set.
			if (wide || set.size > 0 || escapes.size > 0) throw new NoType();
			any = true;
		}
		if (any) return { lang: [], anyChar: true };
		if (wide || set.size > MAX_UNION) throw new NoType();
		return { lang: [[{ set: [...set] }]], anyChar: false };
	}
}

/** Characters a template literal would read as more than themselves. */
const SPECIAL = /[`\\$\p{Cc}\p{Zl}\p{Zp}]+/gu;

/**
 * A template written out: fixed text as it is (or as a string where it would be read),
 * sets as unions of strings; any text alone is `string`.
 */
function render(seq: Seq): Ty {
	// Adjacent single characters are one piece of text, and adjacent any text is one.
	const parts: (string | Segment)[] = [];
	for (const s of seq) {
		const last = parts[parts.length - 1];
		if ("set" in s && s.set.length === 1) {
			const c = s.set[0] as string;
			if (typeof last === "string") parts[parts.length - 1] = last + c;
			else parts.push(c);
		} else if (!("any" in s && typeof last === "object" && "any" in last))
			parts.push(s);
	}
	if (parts.every((p) => typeof p === "string"))
		return lit(JSON.stringify(parts.join("")));
	if (parts.length === 1 && parts[0] === ANY) return STRING;
	const strings = (values: string[]) =>
		`\${${values.map((c) => JSON.stringify(c)).join(" | ")}}`;
	const text = parts
		.map((p) =>
			typeof p === "string"
				? p.replace(SPECIAL, (run) => strings([run]))
				: "set" in p
					? strings(p.set)
					: `\${${"string"}}`,
		)
		.join("");
	return { kind: "template", text: `\`${text}\`` };
}

/**
 * The strings an ECMA-262 pattern matches (anywhere in the string, as JSON Schema reads
 * it), as template literal types; undefined where no type says exactly those, where
 * TypeScript would not build their union, or where JavaScript cannot read the pattern.
 */
export function patternType(pattern: string): Ty | undefined {
	try {
		new RegExp(pattern, "u");
	} catch {
		return undefined;
	}
	let lang: Lang;
	try {
		lang = new Parser(pattern).alternation(true);
	} catch {
		// NoType: the parser throws nothing else on a pattern RegExp reads.
		return undefined;
	}
	// A template keeps the pattern, so that the values next to it can be read against it.
	return union(
		lang
			.map(render)
			.map((t) => (t.kind === "template" ? { ...t, pattern } : t)),
	);
}
