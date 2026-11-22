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
export type Segment = { set: string[] } | { any: true };

const ANY: Segment = { any: true };

/** A template: its segments, one after the other. */
export type Seq = Segment[];

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
 * Whether the template `b` admits every string the template `a` does, from segment `j` of
 * `b` and `i` of `a`: any text in `b` takes any number of `a`'s segments, and a set in `b`
 * one set of `a` within it.
 */
function contains(b: Seq, a: Seq, i: number, j: number): boolean {
	const y = b[j];
	if (y === undefined) return i === a.length;
	if ("any" in y)
		return (
			contains(b, a, i, j + 1) || (i < a.length && contains(b, a, i + 1, j))
		);
	const x = a[i];
	if (x === undefined || !("set" in x)) return false;
	const set = new Set(y.set);
	return x.set.every((c) => set.has(c)) && contains(b, a, i + 1, j + 1);
}

/**
 * Whether the templates `a` and `b` admit a string both do, from segment `i` of `a` and
 * `j` of `b`: any text in either takes any number of the other's segments, and two sets
 * meet where they share a character.
 */
function meets(a: Seq, b: Seq, i: number, j: number): boolean {
	const x = a[i];
	const y = b[j];
	if (x === undefined && y === undefined) return true;
	if (x !== undefined && "any" in x)
		return meets(a, b, i + 1, j) || (y !== undefined && meets(a, b, i, j + 1));
	if (y !== undefined && "any" in y)
		return meets(a, b, i, j + 1) || (x !== undefined && meets(a, b, i + 1, j));
	if (x === undefined || y === undefined) return false;
	const set = new Set(y.set);
	return x.set.some((c) => set.has(c)) && meets(a, b, i + 1, j + 1);
}

/** One template of the strings a pattern matches: its segments, and its type. */
export interface Template {
	readonly seq: Seq;
	readonly key: Ty;
}

const written = (seq: Seq): Template => ({ seq, key: render(seq) });

/** The templates of a pattern `patternType` reads, one for each of its alternatives. */
export function templates(pattern: string): Template[] {
	return new Parser(pattern).alternation(true).map(written);
}

/** Whether template `outer` admits every string template `inner` does. */
export function includes(outer: Template, inner: Template): boolean {
	return contains(outer.seq, inner.seq, 0, 0);
}

/** How the strings of template `a` stand to those of `b`: all among them, some, or none. */
export function relation(
	a: Template,
	b: Template,
): "within" | "meets" | "apart" {
	return includes(b, a)
		? "within"
		: meets(a.seq, b.seq, 0, 0)
			? "meets"
			: "apart";
}

/** The strings of a template without any text; undefined for one with it. */
export function strings(t: Template): string[] | undefined {
	if (t.seq.some((s) => "any" in s)) return undefined;
	return t.seq.reduce(
		(out, s) =>
			out.flatMap((p) => (s as { set: string[] }).set.map((c) => p + c)),
		[""],
	);
}

/** The most steps `common` takes before it gives up: alignments grow with any text. */
const MAX_STEPS = 10_000;

/**
 * The strings both templates admit, as templates: one for each way their segments line
 * up, the way `meets` reads them, a set meeting a set in the characters both have.
 */
function common(
	a: Seq,
	b: Seq,
	i: number,
	j: number,
	steps: { n: number },
): Seq[] {
	if (++steps.n > MAX_STEPS) throw new NoType();
	const x = a[i];
	const y = b[j];
	if (x === undefined && y === undefined) return [[]];
	const out: Seq[] = [];
	const after = (s: Segment, rest: Seq[]) => {
		for (const r of rest) out.push([s, ...r]);
	};
	const anyX = x !== undefined && "any" in x;
	// Any text in both takes text together, until one of them ends.
	if (anyX && y !== undefined && "any" in y)
		after(ANY, [
			...common(a, b, i + 1, j, steps),
			...common(a, b, i, j + 1, steps),
		]);
	else if (anyX) {
		out.push(...common(a, b, i + 1, j, steps));
		if (y !== undefined) after(y, common(a, b, i, j + 1, steps));
	} else if (y !== undefined && "any" in y) {
		out.push(...common(a, b, i, j + 1, steps));
		if (x !== undefined) after(x, common(a, b, i + 1, j, steps));
	} else if (x !== undefined && y !== undefined) {
		const set = new Set(y.set);
		const both = x.set.filter((c) => set.has(c));
		if (both.length > 0)
			after({ set: both }, common(a, b, i + 1, j + 1, steps));
	}
	return out;
}

/**
 * The strings both templates admit, as the fewest of these templates that say them
 * (`` `x-${string}` `` and `` `${string}-y` ``: `` `x-${string}-y` `` and `"x-y"`);
 * undefined where the ways they line up are too many to read.
 */
export function meet(a: Template, b: Template): Template[] | undefined {
	let seqs: Seq[];
	try {
		seqs = common(a.seq, b.seq, 0, 0, { n: 0 });
	} catch {
		return undefined;
	}
	// A template another one includes says no more.
	let kept: Template[] = [];
	for (const t of seqs.map(written)) {
		if (kept.some((o) => includes(o, t))) continue;
		kept = [...kept.filter((o) => !includes(t, o)), t];
	}
	return kept;
}

/** Characters: code point ranges, from and to, in order and apart. */
type Chars = [number, number][];

const LAST = 0x10ffff;
const ALL: Chars = [[0, LAST]];

function charsOf(cs: string[]): Chars {
	const points = cs
		.map((c) => c.codePointAt(0) as number)
		.sort((x, y) => x - y);
	const out: Chars = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last !== undefined && p <= last[1] + 1) last[1] = Math.max(last[1], p);
		else out.push([p, p]);
	}
	return out;
}

function either(sets: Chars[]): Chars {
	const ranges = sets.flat().sort((x, y) => x[0] - y[0]);
	const out: Chars = [];
	for (const [from, to] of ranges) {
		const last = out[out.length - 1];
		if (last !== undefined && from <= last[1] + 1)
			last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

function other(set: Chars): Chars {
	const out: Chars = [];
	let next = 0;
	for (const [from, to] of set) {
		if (from > next) out.push([next, from - 1]);
		next = to + 1;
	}
	if (next <= LAST) out.push([next, LAST]);
	return out;
}

const has = (set: Chars, c: number) => set.some(([f, t]) => f <= c && c <= t);

/** What `.` matches: every character but a line terminator. */
const DOT = other(charsOf(["\n", "\r", " ", " "]));

/** A pattern read as a regular expression: characters, a sequence, alternatives, a repetition. */
type Re =
	| { chars: Chars }
	| { seq: Re[] }
	| { alt: Re[] }
	| { rep: Re; min: number; max: number };

const ANY_TEXT: Re = { rep: { chars: ALL }, min: 0, max: Infinity };

/**
 * A parser of the patterns that are regular expressions: all but lookarounds, word
 * boundaries, back references and property escapes, which throw `NoType`.
 */
class Expression extends Parser {
	alternatives(top: boolean): Re {
		const alts = [this.items(top)];
		while (this.peek() === "|") {
			this.i++;
			alts.push(this.items(top));
		}
		return { alt: alts };
	}

	/** A sequence; at the top, `^` and `$` anchor it, and any text is around it without them. */
	items(top: boolean): Re {
		const items: Re[] = [];
		const start = top && this.peek() === "^";
		if (start) this.i++;
		else if (top) items.push(ANY_TEXT);
		let end = false;
		while (!this.done && this.peek() !== "|" && this.peek() !== ")") {
			if (top && this.peek() === "$") {
				this.i++;
				end = true;
				break;
			}
			items.push(this.repeated());
		}
		if (end && !this.done && this.peek() !== "|") throw new NoType();
		if (top && !end) items.push(ANY_TEXT);
		return { seq: items };
	}

	repeated(): Re {
		const unit = this.unit();
		const c = this.peek();
		let min = 0;
		let max = Infinity;
		if (c === "?") max = 1;
		else if (c === "+") min = 1;
		else if (c === "{") {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(
				this.cs.slice(this.i).join(""),
			) as RegExpExecArray;
			this.i += m[0].length - 1;
			min = Number(m[1]);
			max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
		} else if (c !== "*") return unit;
		this.i++;
		this.lazy();
		return { rep: unit, min, max };
	}

	unit(): Re {
		const c = this.next();
		if (c === "(") {
			if (this.peek() === "?") {
				this.i++;
				const kind = this.next();
				if (kind === "<" && this.peek() !== "=" && this.peek() !== "!") {
					while (this.next() !== ">");
				} else if (kind !== ":") throw new NoType();
			}
			const re = this.alternatives(false);
			this.next(); // ")"
			return re;
		}
		if (c === "[") return { chars: this.chars() };
		if (c === "\\") {
			const e = this.escape(false);
			return { chars: typeof e === "string" ? charsOf([e]) : escaped(e.cls) };
		}
		if (c === "^" || c === "$") throw new NoType();
		return { chars: c === "." ? DOT : charsOf([c]) };
	}

	/** `[…]`, negated or not. */
	chars(): Chars {
		const negated = this.peek() === "^";
		if (negated) this.i++;
		const sets: Chars[] = [];
		const one = (): string | { cls: string } => {
			const c = this.next();
			return c === "\\" ? this.escape(true) : c;
		};
		while (this.peek() !== "]") {
			const a = one();
			if (typeof a !== "string") sets.push(escaped(a.cls));
			else if (this.peek() === "-" && this.cs[this.i + 1] !== "]") {
				this.i++;
				const b = one() as string;
				sets.push([[a.codePointAt(0) as number, b.codePointAt(0) as number]]);
			} else sets.push(charsOf([a]));
		}
		this.i++;
		const set = either(sets);
		return negated ? other(set) : set;
	}
}

/** What a class escape matches: `\d`, `\s`, `\w`, or everything but one (`\D`). */
function escaped(cls: string): Chars {
	const set = charsOf(CLASS_ESCAPES[cls.toLowerCase()] as string[]);
	return cls === cls.toLowerCase() ? set : other(set);
}

/** The most states a machine has before a reading gives up. */
const MAX_STATES = 5_000;

/** A nondeterministic machine over characters: each state's moves, and its free moves. */
class Machine {
	readonly moves: { chars: Chars; to: number }[][] = [];
	readonly free: number[][] = [];

	state(): number {
		if (this.moves.length >= MAX_STATES) throw new NoType();
		this.moves.push([]);
		this.free.push([]);
		return this.moves.length - 1;
	}

	/** The states of an expression's strings, from `from` to the returned one. */
	build(re: Re, from: number): number {
		if ("chars" in re) {
			const to = this.state();
			(this.moves[from] as { chars: Chars; to: number }[]).push({
				chars: re.chars,
				to,
			});
			return to;
		}
		if ("seq" in re) return re.seq.reduce((at, r) => this.build(r, at), from);
		if ("alt" in re) {
			const to = this.state();
			for (const r of re.alt) {
				const start = this.state();
				(this.free[from] as number[]).push(start);
				(this.free[this.build(r, start)] as number[]).push(to);
			}
			return to;
		}
		let at = from;
		for (let k = 0; k < re.min; k++) at = this.build(re.rep, at);
		if (re.max === Infinity) {
			const start = this.state();
			(this.free[at] as number[]).push(start);
			(this.free[this.build(re.rep, start)] as number[]).push(start);
			return start;
		}
		const to = this.state();
		for (let k = re.min; k < re.max; k++) {
			(this.free[at] as number[]).push(to);
			at = this.build(re.rep, at);
		}
		(this.free[at] as number[]).push(to);
		return to;
	}

	/** The states reachable from `states` by free moves. */
	closure(states: number[]): number[] {
		const seen = new Set(states);
		const todo = [...states];
		for (let s = todo.pop(); s !== undefined; s = todo.pop())
			for (const t of this.free[s] as number[])
				if (!seen.has(t)) {
					seen.add(t);
					todo.push(t);
				}
		return [...seen].sort((x, y) => x - y);
	}

	step(states: number[], c: number): number[] {
		const to = states.flatMap((s) =>
			(this.moves[s] as { chars: Chars; to: number }[]).flatMap((m) =>
				has(m.chars, c) ? [m.to] : [],
			),
		);
		return this.closure(to);
	}
}

/** The most pairs of states `matching` visits before it gives up. */
const MAX_PAIRS = 10_000;

/**
 * Whether a pattern that is a regular expression (anywhere in the string, as JSON Schema
 * reads it) matches all strings of a template, some, or none, read by running both
 * machines side by side; undefined for any other pattern, or one too large to read.
 */
export function matching(
	pattern: string,
	t: Template,
): "within" | "meets" | "apart" | undefined {
	try {
		new RegExp(pattern, "u");
	} catch {
		return undefined;
	}
	const m = new Machine();
	const start = m.state();
	let accept: number;
	try {
		accept = m.build(new Expression(pattern).alternatives(true), start);
	} catch {
		return undefined;
	}
	const tm = new Machine();
	const tStart = tm.state();
	const tAccept = tm.build(
		{
			seq: t.seq.map((s) =>
				"any" in s ? ANY_TEXT : { chars: charsOf(s.set) },
			),
		},
		tStart,
	);
	// The characters no move tells apart are one: each range between the bounds of any move.
	const bounds = new Set([0]);
	for (const moves of [...m.moves, ...tm.moves])
		for (const { chars } of moves)
			for (const [from, to] of chars) {
				bounds.add(from);
				if (to < LAST) bounds.add(to + 1);
			}
	const letters = [...bounds];
	let some = false;
	let all = true;
	const seen = new Set<string>();
	const todo: [number[], number[]][] = [
		[tm.closure([tStart]), m.closure([start])],
	];
	for (let pair = todo.pop(); pair !== undefined; pair = todo.pop()) {
		const [ts, ps] = pair;
		const id = `${ts}|${ps}`;
		if (seen.has(id)) continue;
		if (seen.size >= MAX_PAIRS) return undefined;
		seen.add(id);
		if (ts.includes(tAccept)) {
			if (ps.includes(accept)) some = true;
			else all = false;
		}
		for (const c of letters) {
			const next = tm.step(ts, c);
			if (next.length > 0) todo.push([next, m.step(ps, c)]);
		}
	}
	return all ? "within" : some ? "meets" : "apart";
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
