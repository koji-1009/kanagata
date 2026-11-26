// An ECMA-262 `pattern` → the strings it matches, as template literal types.
//
// A pattern says which strings match; a template literal type (`` `https://${string}` ``)
// says which strings it admits. Where a pattern's strings are exactly a template's (fixed
// text, finite sets of characters, any text), the pattern is that type; anything else
// (`.`, `+`, a negated class, lookarounds, …) is no type.

import { inTemplate, lit, type Segment, STRING, type Ty, union } from "./ty.ts";

/**
 * The most strings TypeScript builds into one union from a template: it rejects 100,000
 * ("Expression produces a union type that is too complex to represent", TS2590).
 */
export const MAX_UNION = 99_999;

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

/** Characters: code point ranges, from and to, in order and apart. */
type Chars = [number, number][];

const LAST = 0x10ffff;
const ALL: Chars = [[0, LAST]];

function charsOf(cs: string[]): Chars {
	return either(
		cs.map((c) => [c.codePointAt(0) as number, c.codePointAt(0) as number]),
	);
}

function either(ranges: Chars): Chars {
	const out: Chars = [];
	for (const [from, to] of [...ranges].sort((x, y) => x[0] - y[0])) {
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

/** What `.` matches: every character but a line terminator (LF, CR, LS, PS). */
const DOT = other(charsOf(chars([0x0a, 0x0d, 0x2028, 0x2029])));

/** What a class escape matches: `\d`, `\s`, `\w`, or everything but one (`\D`). */
function escaped(cls: string): Chars {
	const set = charsOf(CLASS_ESCAPES[cls.toLowerCase()] as string[]);
	return cls === cls.toLowerCase() ? set : other(set);
}

/**
 * Characters a pattern matches at one place, and how a template reads them: the
 * characters in the order the pattern lists them, any character (`[\s\S]`, `[^]`), or
 * none it can write (`.`, `\D`, `[^a]`, a range too wide for a union).
 */
interface Letters {
	chars: Chars;
	text: string[] | "any" | undefined;
}

/** A pattern read: characters, a sequence, alternatives, a repetition. */
type Re =
	| Letters
	| { seq: Re[] }
	| { alt: Re[] }
	| { rep: Re; min: number; max: number; star?: true };

const ANY_TEXT: Re = {
	rep: { chars: ALL, text: "any" },
	min: 0,
	max: Infinity,
	star: true,
};

/**
 * A parser over a pattern's code points (the `u` flag: JSON Schema patterns are Unicode),
 * the one place that reads a pattern; templates (`lang`) and machines (`Machine`) are
 * built from what it reads. Lookarounds, word boundaries, back references and property
 * escapes, which neither says, throw `NoType`.
 */
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
	alternatives(top: boolean): Re {
		const alts = [this.items(top)];
		while (this.peek() === "|") {
			this.i++;
			alts.push(this.items(top));
		}
		return { alt: alts };
	}

	/** A sequence of terms; at the top, `^` and `$` anchor it, and any text is around it without them. */
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
			items.push(this.term());
		}
		// A `$` before the sequence ends anchors what neither a template nor a machine says.
		if (end && !this.done && this.peek() !== "|") throw new NoType();
		if (top && !end) items.push(ANY_TEXT);
		return { seq: items };
	}

	/** term := atom quantifier? */
	term(): Re {
		const atom = this.atom();
		const c = this.peek();
		let min = 0;
		let max = Infinity;
		if (c === "?") max = 1;
		else if (c === "+") min = 1;
		else if (c === "{") {
			// With the `u` flag a `{` here begins a quantifier.
			const m = /^\{(\d+)(,(\d*))?\}/.exec(
				this.cs.slice(this.i).join(""),
			) as RegExpExecArray;
			this.i += m[0].length - 1;
			min = Number(m[1]);
			max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
		} else if (c !== "*") return atom;
		this.i++;
		this.lazy();
		// A template reads `*` of any character only, not `{0,}`.
		return c === "*"
			? { rep: atom, min, max, star: true }
			: { rep: atom, min, max };
	}

	/** A `?` after a quantifier makes it lazy, which changes nothing a type says. */
	lazy(): void {
		if (this.peek() === "?") this.i++;
	}

	atom(): Re {
		const c = this.next();
		if (c === "(") {
			if (this.peek() === "?") {
				this.i++;
				const kind = this.next();
				// (?:…) and (?<name>…) group; lookarounds say what neither does.
				if (kind === "<" && this.peek() !== "=" && this.peek() !== "!") {
					while (this.next() !== ">");
				} else if (kind !== ":") throw new NoType();
			}
			const re = this.alternatives(false);
			this.next(); // ")"
			return re;
		}
		if (c === "[") return this.cls();
		if (c === "\\") {
			const e = this.escape(false);
			if (typeof e === "string") return { chars: charsOf([e]), text: [e] };
			// \d, \s and \w are sets; \D, \S and \W, everything but one.
			return { chars: escaped(e.cls), text: CLASS_ESCAPES[e.cls] };
		}
		// `^` and `$` here anchor what neither says; `.` leaves out line breaks.
		if (c === "^" || c === "$") throw new NoType();
		if (c === ".") return { chars: DOT, text: undefined };
		return { chars: charsOf([c]), text: [c] };
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

	/** `[…]`: for a template, a finite set of characters or any character (`[\s\S]`, `[^]`). */
	cls(): Letters {
		const negated = this.peek() === "^";
		if (negated) this.i++;
		const set = new Set<string>();
		const escapes = new Set<string>();
		const ranges: Chars = [];
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
				ranges.push(...escaped(a.cls));
				continue;
			}
			const from = a.codePointAt(0) as number;
			if (this.peek() === "-" && this.cs[this.i + 1] !== "]") {
				this.i++;
				// With the `u` flag a range ends at a character, not a class escape.
				const to = (one() as string).codePointAt(0) as number;
				ranges.push([from, to]);
				if (to - from >= MAX_UNION) wide = true;
				else for (const x of range(from, to)) set.add(x);
			} else {
				ranges.push([from, from]);
				set.add(a);
			}
		}
		this.i++;
		let any = false;
		let none = false;
		for (const e of escapes) {
			const lower = e.toLowerCase();
			if (e === lower)
				for (const x of CLASS_ESCAPES[lower] as string[]) set.add(x);
			else if (escapes.has(lower)) any = true;
			else none = true;
		}
		const chars = either(ranges);
		// [^] is any character; any other negated class is no finite set.
		if (negated)
			return {
				chars: other(chars),
				text: wide || set.size > 0 || escapes.size > 0 ? undefined : "any",
			};
		return {
			chars,
			text:
				none || (!any && (wide || set.size > MAX_UNION))
					? undefined
					: any
						? "any"
						: [...set],
		};
	}
}

/**
 * The strings an expression matches, as templates: what `Parser` read, where templates
 * say exactly those strings; `NoType` where they do not.
 */
function lang(re: Re): Lang {
	if ("chars" in re) {
		// Any one character, which only `*` makes a template of, and characters none writes.
		if (!Array.isArray(re.text)) throw new NoType();
		return [[{ set: re.text }]];
	}
	if ("seq" in re) return re.seq.reduce((l, r) => concat(l, lang(r)), EMPTY);
	if ("alt" in re) return bounded(re.alt.flatMap(lang));
	// Any number of any character is any text; anything else repeated without end is no template.
	if ("chars" in re.rep && re.rep.text === "any") {
		if (re.star) return [[ANY]];
		throw new NoType();
	}
	if (re.max === Infinity) throw new NoType();
	const atom = lang(re.rep);
	let out: Lang = [];
	let power = EMPTY;
	for (let k = 0; k <= re.max; k++) {
		if (k >= re.min) out = bounded([...out, ...power]);
		if (k < re.max) power = concat(power, atom);
	}
	return out;
}

/** Characters a template literal would read as more than themselves. */
const SPECIAL = /[`\\$\p{Cc}\p{Zl}\p{Zp}]+/gu;

/**
 * A template written out: fixed text as it is (or as a string where it would be read),
 * sets as unions of strings; any text alone is `string`.
 */
export function render(seq: Seq): Ty {
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
	return { kind: "template", text: `\`${text}\``, seq };
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

/** One template of the strings a pattern matches: its segments, and its type. */
export interface Template {
	readonly seq: Seq;
	readonly key: Ty;
}

const written = (seq: Seq): Template => ({ seq, key: render(seq) });

/** The templates of a pattern `patternType` reads, one for each of its alternatives. */
export function templates(pattern: string): Template[] {
	return templatesOf(pattern) as Template[];
}

/**
 * The templates of a pattern, one for each of its alternatives; undefined where no
 * template says its strings, or JavaScript cannot read it. Each pattern is read once: a
 * document repeats its patterns.
 */
function templatesOf(pattern: string): Template[] | undefined {
	if (!templated.has(pattern)) templated.set(pattern, readTemplates(pattern));
	return templated.get(pattern);
}

/** What `templatesOf` read of each pattern. */
const templated = new Map<string, Template[] | undefined>();

function readTemplates(pattern: string): Template[] | undefined {
	if (regex(pattern) === null) return undefined;
	try {
		return lang(new Parser(pattern).alternatives(true)).map(written);
	} catch {
		// NoType: the parser throws nothing else on a pattern RegExp reads.
		return undefined;
	}
}

/** Patterns compiled once each; null for one JavaScript cannot read. */
const compiled = new Map<string, RegExp | null>();

/** A pattern as a regular expression (JSON Schema patterns are Unicode); null where JavaScript cannot read it. */
export function regex(pattern: string): RegExp | null {
	let re = compiled.get(pattern);
	if (re === undefined) {
		try {
			re = new RegExp(pattern, "u");
		} catch {
			re = null;
		}
		compiled.set(pattern, re);
	}
	return re;
}

/** Whether template `outer` admits every string template `inner` does. */
export function includes(outer: Template, inner: Template): boolean {
	return contains(outer.seq, inner.seq, 0, 0);
}

/** Whether a template admits a string. */
export function admits(t: Template, key: string): boolean {
	return inTemplate(t.seq, key);
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
 * up, any text in either taking any number of the other's segments, and a set meeting a
 * set in the characters both have.
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

/** A pattern's machine, from its start to its accepting state. */
interface Read {
	m: Machine;
	start: number;
	accept: number;
}

/** Machines built once each; null for a pattern no machine says, or JavaScript cannot read. */
const machines = new Map<string, Read | null>();

function machine(pattern: string): Read | null {
	let read = machines.get(pattern);
	if (read === undefined) {
		read = null;
		if (regex(pattern) !== null)
			try {
				const m = new Machine();
				const start = m.state();
				const accept = m.build(new Parser(pattern).alternatives(true), start);
				read = { m, start, accept };
			} catch {
				// `NoType`, or more states than read.
			}
		machines.set(pattern, read);
	}
	return read;
}

/** The most pairs of states `matchesAll` visits before it gives up. */
const MAX_PAIRS = 10_000;

/**
 * Whether a pattern that is a regular expression (anywhere in the string, as JSON Schema
 * reads it) matches all strings of a template, read by running both machines side by side
 * until a string of the template it does not match; false for any other pattern, or one
 * too large to read.
 */
export function matchesAll(pattern: string, t: Template): boolean {
	const read = machine(pattern);
	if (read === null) return false;
	const { m, start, accept } = read;
	const tm = new Machine();
	const tStart = tm.state();
	const tAccept = tm.build(
		{
			seq: t.seq.map((s) =>
				"any" in s ? ANY_TEXT : { chars: charsOf(s.set), text: s.set },
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
				bounds.add(to + 1);
			}
	const letters = [...bounds];
	const seen = new Set<string>();
	const todo: [number[], number[]][] = [
		[tm.closure([tStart]), m.closure([start])],
	];
	for (let pair = todo.pop(); pair !== undefined; pair = todo.pop()) {
		const [ts, ps] = pair;
		const id = `${ts}|${ps}`;
		if (seen.has(id)) continue;
		if (seen.size >= MAX_PAIRS) return false;
		seen.add(id);
		// A string of the template the pattern does not match.
		if (ts.includes(tAccept) && !ps.includes(accept)) return false;
		for (const c of letters) {
			const next = tm.step(ts, c);
			if (next.length > 0) todo.push([next, m.step(ps, c)]);
		}
	}
	return true;
}

/**
 * The strings an ECMA-262 pattern matches (anywhere in the string, as JSON Schema reads
 * it), as template literal types; undefined where no type says exactly those, where
 * TypeScript would not build their union, or where JavaScript cannot read the pattern.
 * Each pattern is read once: a document repeats its patterns.
 */
export function patternType(pattern: string): Ty | undefined {
	if (!typed.has(pattern)) {
		const all = templatesOf(pattern);
		typed.set(
			pattern,
			all === undefined ? undefined : union(all.map((t) => t.key)),
		);
	}
	return typed.get(pattern);
}

/** What `patternType` read of each pattern. */
const typed = new Map<string, Ty | undefined>();
