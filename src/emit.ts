// Turns `Ty` into TypeScript source text.

import { isIdent, isNumericKey } from "./ident.ts";
import { equal, type Keyed, type Prop, type Ty, type View } from "./ty.ts";

/**
 * The helper types the output declares where it uses them. Their names are lower case,
 * which no schema's name is (see `typeNames`).
 */
const HELPERS = {
	repeated: `/** \`N\` times the items of \`T\`, by the digits \`D\` of \`N\`: \`repeated<[string?], 3>\` is \`[string?, string?, string?]\`. */
export type repeated<T extends unknown[], N extends number, D extends string = \`\${N}\`, R extends unknown[] = []> = D extends \`\${infer F extends number}\${infer E}\`
  ? repeated<T, N, E, [...R, ...R, ...R, ...R, ...R, ...R, ...R, ...R, ...R, ...R, ...[[], T, [...T, ...T], [...T, ...T, ...T], [...T, ...T, ...T, ...T], [...T, ...T, ...T, ...T, ...T], [...T, ...T, ...T, ...T, ...T, ...T], [...T, ...T, ...T, ...T, ...T, ...T, ...T], [...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T], [...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T, ...T]][F]]>
  : R;
`,
	integers: `/** The integers the decimal texts \`S\` spell: \`\`integers<\`1\${0 | 1}\`>\`\` is \`10 | 11\`. */
export type integers<S extends string> = S extends \`\${infer N extends number}\` ? N : never;
`,
};

type Helper = keyof typeof HELPERS;

/** An integer literal TypeScript reads back from its text (`${infer N extends number}`), as a number. */
function integerOf(t: Ty): number | undefined {
	if (
		t.kind !== "lit" ||
		!/^-?(0|[1-9][0-9]*)$/.test(t.text) ||
		t.text === "-0"
	)
		return undefined;
	const n = Number(t.text);
	return Number.isSafeInteger(n) ? n : undefined;
}

/** Template literal types of the decimal texts of the integers from `lo` to `hi`. */
function spell(lo: number, hi: number): string[] {
	const out: string[] = [];
	if (lo < 0)
		for (const s of unsigned(Math.max(1, -hi), -lo)) out.push(`-${s}`);
	if (hi >= 0) out.push(...unsigned(Math.max(0, lo), hi));
	return out.map((s) => `\`${s}\``);
}

/** The texts of the non-negative integers from `lo` to `hi`, by their number of digits. */
function unsigned(lo: number, hi: number): string[] {
	const [a, b] = [String(lo), String(hi)];
	const out: string[] = [];
	for (let n = a.length; n <= b.length; n++)
		out.push(
			...sameLength(
				n === a.length ? a : `1${"0".repeat(n - 1)}`,
				n === b.length ? b : "9".repeat(n),
			),
		);
	return out;
}

/** The texts from `lo` to `hi`, of one length, as digits and sets of digits. */
function sameLength(lo: string, hi: string): string[] {
	if (lo === "") return [""];
	const [a, b] = [Number(lo[0]), Number(hi[0])];
	const [restLo, restHi] = [lo.slice(1), hi.slice(1)];
	if (a === b) return sameLength(restLo, restHi).map((r) => `${a}${r}`);
	const zeros = "0".repeat(restLo.length);
	const nines = "9".repeat(restLo.length);
	// The first and last digits take every rest only from or up to the bound.
	const from = restLo === zeros ? a : a + 1;
	const to = restHi === nines ? b : b - 1;
	const out: string[] = [];
	if (from !== a) out.push(...sameLength(restLo, nines).map((r) => `${a}${r}`));
	if (from <= to) {
		const set = Array.from({ length: to - from + 1 }, (_, i) => from + i);
		const d = set.length === 1 ? `${from}` : `\${${set.join(" | ")}}`;
		out.push(...sameLength(zeros, nines).map((r) => `${d}${r}`));
	}
	if (to !== b) out.push(...sameLength(zeros, restHi).map((r) => `${b}${r}`));
	return out;
}

type Tuple = Extract<Ty, { kind: "tuple" }>;

/** A member of the union a tuple is written as. */
interface Member {
	text: string;
	/** Whether it is `[…] & { length: … }`, an intersection. */
	bounded: boolean;
	/** Whether it uses `repeated`. */
	repeated: boolean;
}

/**
 * Items in a row. TypeScript bounds a length only item by item, so equal items in a row
 * are `...repeated<[T], n>` where that is shorter than writing each.
 */
function runs(items: string[]): { parts: string[]; repeated: boolean } {
	const parts: string[] = [];
	let repeated = false;
	for (let i = 0; i < items.length; ) {
		const item = items[i] as string;
		let j = i + 1;
		while (j < items.length && items[j] === item) j++;
		const n = j - i;
		const run = `...repeated<[${item}], ${n}>`;
		if (run.length < n * item.length + (n - 1) * 2) {
			repeated = true;
			parts.push(run);
		} else for (let k = 0; k < n; k++) parts.push(item);
		i = j;
	}
	return { parts, repeated };
}

/**
 * The lengths from `lo` to `hi`: listed, or the length of a tuple of `lo` items and
 * `hi - lo` optional ones where that is shorter.
 */
function lengths(lo: number, hi: number): { text: string; repeated: boolean } {
	const row = runs([
		...Array<string>(lo).fill("unknown"),
		...Array<string>(hi - lo).fill("unknown?"),
	]);
	const tuple = `[${row.parts.join(", ")}]["length"]`;
	let listed = String(lo);
	let n = lo + 1;
	for (; n <= hi && listed.length <= tuple.length; n++) listed += ` | ${n}`;
	return n > hi && listed.length <= tuple.length
		? { text: listed, repeated: false }
		: { text: tuple, repeated: row.repeated };
}

/** The first line, naming the kanagata version when one is given. */
function header(version: string | undefined): string {
	const by = version === undefined ? "kanagata" : `kanagata ${version}`;
	return `// Generated by ${by}. Do not edit.\n`;
}

/** Context precedence. A type binding looser than its context is parenthesized. */
const Prec = { Union: 0, Inter: 1, Postfix: 2 } as const;
type Prec = (typeof Prec)[keyof typeof Prec];

/** The declared name of a view of a component schema. */
type Namer = (schema: string, view: View) => string;

class Out {
	buf = "";
	depth = 0;
	/** The helper types written so far. */
	readonly used = new Set<Helper>();
	readonly #name: Namer;

	constructor(name: Namer) {
		this.#name = name;
	}

	ty(t: Ty, ctx: Prec): void {
		switch (t.kind) {
			case "unknown":
			case "never":
			case "null":
			case "undefined":
			case "string":
			case "number":
			case "boolean":
				this.buf += t.kind;
				break;
			case "nonNullish":
				this.buf += "{}";
				break;
			case "integer":
				this.buf += "number";
				break;
			case "blob":
				this.buf += "Blob";
				break;
			case "record":
				this.buf += "Record<string, unknown>";
				break;
			case "lit":
			case "template":
				this.buf += t.text;
				break;
			case "ref":
				this.buf += this.#name(t.schema, t.view);
				break;
			case "opRef":
				this.buf += `operations[${JSON.stringify(t.id)}]`;
				break;
			case "array":
				this.ty(t.elem, Prec.Postfix);
				this.buf += "[]";
				break;
			case "tuple":
				this.tuple(t, ctx);
				break;
			case "object":
				this.object(t.props);
				break;
			case "map":
				this.object(t.props, t.index, t.keyed);
				break;
			case "union":
				this.union(t.items, ctx);
				break;
			case "inter":
				this.list(t.items, " & ", ctx > Prec.Inter, Prec.Inter);
				break;
		}
	}

	/** A type as text, written as it would be here. */
	private text(t: Ty, ctx: Prec): string {
		const outer = this.buf;
		this.buf = "";
		this.ty(t, ctx);
		const text = this.buf;
		this.buf = outer;
		return text;
	}

	/** Types, or text written as it is, joined by `sep`. */
	private list(
		items: (Ty | string)[],
		sep: string,
		paren: boolean,
		inner: Prec,
	): void {
		if (paren) this.buf += "(";
		items.forEach((item, i) => {
			if (i > 0) this.buf += sep;
			if (typeof item === "string") this.buf += item;
			else this.ty(item, inner);
		});
		if (paren) this.buf += ")";
	}

	/** A tuple's members (see `members`), parenthesized where they bind looser than `ctx`. */
	private tuple(t: Tuple, ctx: Prec): void {
		const members = this.members(t);
		const paren =
			members.length > 1
				? ctx > Prec.Union
				: (members[0] as Member).bounded && ctx > Prec.Inter;
		this.list(
			members.map((m) => m.text),
			" | ",
			paren,
			Prec.Union,
		);
	}

	/**
	 * A tuple as the members of a union. An optional item (`[A?]`) admits `undefined`, which
	 * is no JSON value, and reads back as one, so the items past `min` are a tuple for each
	 * length: `[] | [A] | [A, B, ...R[]]`; an item that admits no value ends the arrays. In
	 * a closed tuple, the equal items that end it are one rest, `...T[]` with `length`
	 * bounding it, where that is shorter than a tuple for each of their lengths.
	 */
	private members(t: Tuple): Member[] {
		const cut = t.items.findIndex(
			(item, i) => i >= t.min && item.kind === "never",
		);
		const items = cut === -1 ? t.items : t.items.slice(0, cut);
		const rest = cut === -1 ? t.rest : undefined;
		const n = items.length;
		const texts: string[] = [];
		for (const [i, item] of items.entries())
			texts.push(
				i > 0 && equal(item, items[i - 1] as Ty)
					? (texts[i - 1] as string)
					: this.text(item, Prec.Union),
			);
		const exact = (length: number, more?: Ty): Member =>
			this.row(texts.slice(0, length), more);
		if (t.min === n) return this.use([exact(n, rest)]);
		// The items from `k` on are the rest's, or in a closed tuple, the last item's.
		const last = (rest ?? items[n - 1]) as Ty;
		let k = n;
		while (k > t.min && equal(items[k - 1] as Ty, last)) k--;
		const shorter: Member[] = [];
		for (let length = t.min; length < k; length++) shorter.push(exact(length));
		const tail =
			k === 0
				? {
						text: `${this.text(last, Prec.Postfix)}[]`,
						bounded: false,
						repeated: false,
					}
				: exact(k, last);
		if (rest !== undefined) return this.use([...shorter, tail]);
		const length = lengths(k, n);
		const bounded = {
			text: `${tail.text} & { length: ${length.text} }`,
			bounded: true,
			repeated: tail.repeated || length.repeated,
		};
		const each: Member[] = [];
		let size = -3;
		for (let i = k; i <= n && size <= bounded.text.length; i++) {
			const m = exact(i);
			each.push(m);
			size += m.text.length + 3;
		}
		return this.use([
			...shorter,
			...(size <= bounded.text.length ? each : [bounded]),
		]);
	}

	/** Members written: the helper they use with them. */
	private use(members: Member[]): Member[] {
		if (members.some((m) => m.repeated)) this.used.add("repeated");
		return members;
	}

	/** `[A, B, ...R[]]`: the items, and `rest` after them where it is given. */
	private row(items: string[], rest?: Ty): Member {
		const { parts, repeated } = runs(items);
		if (rest !== undefined) parts.push(`...${this.text(rest, Prec.Postfix)}[]`);
		return { text: `[${parts.join(", ")}]`, bounded: false, repeated };
	}

	/**
	 * Members joined by `|`, each written once. Integers in a row are `integers<…>`, spelled
	 * by their digits, where that is shorter than listing each. A tuple's members are the
	 * union's (see `members`). Members written alike may leave one, parenthesized as it
	 * binds.
	 */
	private union(items: Ty[], ctx: Prec): void {
		const parts = new Set<string>();
		// The members that are intersections.
		const inters = new Set<string>();
		for (let i = 0; i < items.length; ) {
			const first = integerOf(items[i] as Ty);
			let j = i + 1;
			if (first !== undefined)
				while (
					j < items.length &&
					integerOf(items[j] as Ty) === first + (j - i)
				)
					j++;
			const run = items.slice(i, j);
			i = j;
			if (run.length > 1) {
				// An integer literal is written as its text.
				const listed = run.reduce(
					(n, t) => n + (t as { text: string }).text.length + 3,
					-3,
				);
				const last = (first as number) + run.length - 1;
				const spelled = `integers<${spell(first as number, last).join(" | ")}>`;
				if (spelled.length < listed) {
					this.used.add("integers");
					parts.add(spelled);
					continue;
				}
			}
			for (const t of run)
				if (t.kind === "tuple")
					for (const m of this.members(t)) {
						parts.add(m.text);
						if (m.bounded) inters.add(m.text);
					}
				else {
					const text = this.text(t, Prec.Union);
					parts.add(text);
					if (t.kind === "inter") inters.add(text);
				}
		}
		const [only] = parts;
		const paren =
			parts.size > 1
				? ctx > Prec.Union
				: inters.has(only as string) && ctx > Prec.Inter;
		this.list([...parts], " | ", paren, Prec.Union);
	}

	object(props: Prop[], index?: Ty, keyed: Keyed[] = []): void {
		if (props.length === 0 && index === undefined && keyed.length === 0) {
			this.buf += "{}";
			return;
		}
		this.buf += "{\n";
		this.depth++;
		for (const p of props) {
			if (p.doc !== undefined) this.doc(p.doc);
			this.indent();
			this.key(p.key);
			if (p.optional) this.buf += "?";
			this.buf += ": ";
			this.ty(p.ty, Prec.Union);
			this.buf += ";\n";
		}
		for (const k of keyed) {
			this.indent();
			this.buf += "[key: ";
			this.ty(k.key, Prec.Union);
			this.buf += "]: ";
			this.ty(k.ty, Prec.Union);
			this.buf += ";\n";
		}
		if (index !== undefined) {
			this.indent();
			this.buf += "[key: string]: ";
			this.ty(index, Prec.Union);
			this.buf += ";\n";
		}
		this.depth--;
		this.indent();
		this.buf += "}";
	}

	private indent(): void {
		this.buf += "  ".repeat(this.depth);
	}

	/** Writes a property key: bare if it is an identifier or a canonical integer, otherwise as a JSON string. */
	key(k: string): void {
		this.buf += isIdent(k) || isNumericKey(k) ? k : JSON.stringify(k);
	}

	/** Writes a JSDoc comment on its own line(s) at the current indentation. */
	doc(d: string): void {
		const lines = d
			.replaceAll("*/", "*\\/")
			.split("\n")
			.map((l) => l.trimEnd());
		if (lines.length === 1) {
			this.indent();
			this.buf += `/** ${lines[0]} */\n`;
			return;
		}
		this.indent();
		this.buf += "/**\n";
		for (const line of lines) {
			this.indent();
			this.buf += line === "" ? " *\n" : ` * ${line}\n`;
		}
		this.indent();
		this.buf += " */\n";
	}
}

/** A named type declaration: `export type <name> = <ty>;` */
export interface Decl {
	name: string;
	ty: Ty;
	doc?: string;
}

/** Everything the generator emits. */
interface Document {
	paths: Prop[];
	/** Emitted only when the document has webhooks. */
	webhooks?: Prop[];
	operations: Prop[];
	/** Schema name → its declared type. */
	schemas: Prop[];
	decls: Decl[];
}

export function render(
	doc: Document,
	name: Namer,
	version: string | undefined,
): string {
	const out = new Out(name);
	out.buf += header(version);
	const interfaces: [string, Prop[]][] = [["paths", doc.paths]];
	if (doc.webhooks !== undefined) interfaces.push(["webhooks", doc.webhooks]);
	interfaces.push(["operations", doc.operations], ["schemas", doc.schemas]);
	for (const [name, props] of interfaces) {
		out.buf += `\nexport interface ${name} `;
		out.object(props);
		out.buf += "\n";
	}
	for (const decl of doc.decls) {
		out.buf += "\n";
		if (decl.doc !== undefined) out.doc(decl.doc);
		out.buf += `export type ${decl.name} = `;
		out.ty(decl.ty, Prec.Union);
		out.buf += ";\n";
	}
	for (const helper of Object.keys(HELPERS) as Helper[])
		if (out.used.has(helper)) out.buf += `\n${HELPERS[helper]}`;
	return out.buf;
}
