// Intermediate representation of TypeScript types, and its normalization.

export interface Prop {
	key: string;
	ty: Ty;
	optional: boolean;
	doc?: string;
}

/** Which view of a component schema a reference means: as returned, or as sent. */
export type View = "read" | "write";

export type Ty =
	| { kind: "unknown" }
	| { kind: "never" }
	| { kind: "null" }
	| { kind: "undefined" }
	| { kind: "string" }
	| { kind: "number" }
	/** A whole number; printed as `number`, but it narrows `enum` / `const` values to whole ones. */
	| { kind: "integer" }
	| { kind: "boolean" }
	| { kind: "blob" }
	/** `Record<string, unknown>`: any object. */
	| { kind: "record" }
	/** Literal in JSON notation: `"admin"` with quotes, `1`, `true`. */
	| { kind: "lit"; text: string }
	/** A component schema, by its key in `components.schemas`; named when emitted. */
	| { kind: "ref"; schema: string; view: View }
	/** `operations[id]` */
	| { kind: "opRef"; id: string }
	| { kind: "array"; elem: Ty }
	/**
	 * `[A, B?, ...R[]]`: the first `min` items are required, the rest optional,
	 * followed by any number of `rest` items when given.
	 */
	| { kind: "tuple"; items: Ty[]; min: number; rest?: Ty }
	/** Object literal; `{}` when empty. */
	| { kind: "object"; props: Prop[] }
	/** Object literal with an index signature: `{ a: A; [key: string]: T }`. */
	| { kind: "map"; props: Prop[]; index: Ty }
	| { kind: "union"; items: Ty[] }
	| { kind: "inter"; items: Ty[] };

export const UNKNOWN: Ty = { kind: "unknown" };
export const NEVER: Ty = { kind: "never" };
export const NULL: Ty = { kind: "null" };
export const UNDEFINED: Ty = { kind: "undefined" };
export const STRING: Ty = { kind: "string" };
export const NUMBER: Ty = { kind: "number" };
export const INTEGER: Ty = { kind: "integer" };
export const BOOLEAN: Ty = { kind: "boolean" };
export const BLOB: Ty = { kind: "blob" };
export const RECORD: Ty = { kind: "record" };

export const lit = (text: string): Ty => ({ kind: "lit", text });
export const ref = (schema: string, view: View = "read"): Ty => ({
	kind: "ref",
	schema,
	view,
});
export const opRef = (id: string): Ty => ({ kind: "opRef", id });
export const array = (elem: Ty): Ty => ({ kind: "array", elem });
export const object = (props: Prop[]): Ty => ({ kind: "object", props });

/** A closed tuple whose items are all required. */
export const tuple = (items: Ty[]): Ty => ({
	kind: "tuple",
	items,
	min: items.length,
});

/** A required property without documentation. */
export const prop = (key: string, ty: Ty): Prop => ({
	key,
	ty,
	optional: false,
});

/** Structural equality; with `views: false`, references to either view of a schema are equal. */
export function equal(a: Ty, b: Ty, views = true): boolean {
	if (a === b) return true;
	const eq = (x: Ty, y: Ty) => equal(x, y, views);
	// Both lists have the same length when their items are compared.
	const list = (x: Ty[], y: Ty[]) =>
		x.length === y.length && x.every((t, i) => eq(t, y[i] as Ty));
	const props = (x: Prop[], y: Prop[]) =>
		x.length === y.length &&
		x.every((p, i) => {
			const q = y[i] as Prop;
			return (
				p.key === q.key &&
				p.optional === q.optional &&
				p.doc === q.doc &&
				eq(p.ty, q.ty)
			);
		});
	switch (a.kind) {
		case "lit":
			return b.kind === "lit" && a.text === b.text;
		case "ref":
			return (
				b.kind === "ref" &&
				a.schema === b.schema &&
				(!views || a.view === b.view)
			);
		case "array":
			return b.kind === "array" && eq(a.elem, b.elem);
		case "tuple":
			return (
				b.kind === "tuple" &&
				a.min === b.min &&
				list(a.items, b.items) &&
				(a.rest === undefined
					? b.rest === undefined
					: b.rest !== undefined && eq(a.rest, b.rest))
			);
		case "object":
			return b.kind === "object" && props(a.props, b.props);
		case "map":
			return (
				b.kind === "map" && props(a.props, b.props) && eq(a.index, b.index)
			);
		case "union":
		case "inter":
			return b.kind === a.kind && list(a.items, b.items);
		default:
			return a.kind === b.kind;
	}
}

/** Every component schema a type refers to. */
export function refs(t: Ty, out = new Set<string>()): Set<string> {
	const props = (ps: Prop[]) => {
		for (const p of ps) refs(p.ty, out);
	};
	switch (t.kind) {
		case "ref":
			out.add(t.schema);
			break;
		case "array":
			refs(t.elem, out);
			break;
		case "tuple":
			for (const i of t.items) refs(i, out);
			if (t.rest !== undefined) refs(t.rest, out);
			break;
		case "object":
			props(t.props);
			break;
		case "map":
			props(t.props);
			refs(t.index, out);
			break;
		case "union":
		case "inter":
			for (const i of t.items) refs(i, out);
			break;
	}
	return out;
}

/**
 * Collects distinct members: literals by their text through a Set (enums can have
 * thousands), other types by structure.
 */
function distinct(): { out: Ty[]; add: (t: Ty) => void } {
	const out: Ty[] = [];
	const texts = new Set<string>();
	const add = (t: Ty): void => {
		if (t.kind === "lit") {
			if (texts.has(t.text)) return;
			texts.add(t.text);
		} else if (out.some((o) => equal(o, t))) return;
		out.push(t);
	};
	return { out, add };
}

/**
 * Builds a normalized union: flattens, removes duplicates, `never` and literals a
 * primitive member already admits (`string | ""` is `string`), collapses to
 * `unknown` if any member is `unknown`, and unwraps a single member.
 */
export function union(items: Ty[]): Ty {
	const members = distinct();
	const push = (t: Ty): void => {
		if (t.kind === "union") t.items.forEach(push);
		else if (t.kind !== "never") members.add(t);
	};
	items.forEach(push);
	let out = members.out;
	if (out.some((t) => t.kind === "unknown")) return UNKNOWN;
	const kinds = out.flatMap((t) => kindsOf(t) ?? []);
	// `number` admits every whole number; a primitive admits its literals.
	out = out.filter((t) =>
		t.kind === "integer"
			? !kinds.includes("number")
			: t.kind !== "lit" || !admits(kinds, t),
	);
	if (out.length === 0) return NEVER;
	const [only] = out;
	return out.length === 1 && only !== undefined
		? only
		: { kind: "union", items: out };
}

/**
 * Builds a normalized intersection: flattens, removes duplicates and `unknown`,
 * narrows sets of values by the kinds of value around them (see `narrow`),
 * collapses to `never` if any member is `never`, and unwraps a single member.
 */
export function inter(items: Ty[]): Ty {
	const members = distinct();
	const push = (t: Ty): void => {
		if (t.kind === "inter") t.items.forEach(push);
		else if (t.kind !== "unknown") members.add(t);
	};
	items.forEach(push);
	const out = members.out;
	const narrowed = narrow(out);
	// Narrowing can make members equal (`"a" & ("a" | 1) & string`); normalize again.
	// Each round drops a member or shrinks a set of values, so this ends.
	if (narrowed !== out) return inter(narrowed);
	if (out.some((t) => t.kind === "never")) return NEVER;
	if (out.length === 0) return UNKNOWN;
	const [only] = out;
	return out.length === 1 && only !== undefined
		? only
		: { kind: "inter", items: out };
}

/** A kind of JSON value; `integer` is the whole numbers among `number`. */
type ValueKind =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "null"
	| "object"
	| "array";

/** The kinds of value an "any value of these kinds" type admits: `string`, `string | null`, `Record`, `unknown[]`. */
function kindsOf(t: Ty): ValueKind[] | undefined {
	const one = (m: Ty): ValueKind | undefined => {
		if (
			m.kind === "string" ||
			m.kind === "number" ||
			m.kind === "integer" ||
			m.kind === "boolean" ||
			m.kind === "null"
		)
			return m.kind;
		if (m.kind === "record") return "object";
		if (m.kind === "array" && m.elem.kind === "unknown") return "array";
		return undefined;
	};
	const kinds = (t.kind === "union" ? t.items : [t]).map(one);
	return kinds.every((k) => k !== undefined)
		? (kinds as ValueKind[])
		: undefined;
}

/**
 * The kind of value a type that lists values admits: a literal by its notation, any
 * tuple as an array, any object or map type as an object (not only those from
 * const / enum, so `type: string` with `properties` meets as `never`).
 */
function valueKind(t: Ty): ValueKind | undefined {
	if (t.kind === "lit")
		return t.text.startsWith('"')
			? "string"
			: t.text === "true" || t.text === "false"
				? "boolean"
				: "number";
	if (t.kind === "tuple") return "array";
	if (t.kind === "object" || t.kind === "map") return "object";
	return undefined;
}

/**
 * An intersection of sets of JSON values, by one rule. Kind types (`string`,
 * `number | null`, `Record`) meet: K is the kinds every one allows (`integer`
 * within `number`). Sets of literals meet each other (numbers by value). Then the
 * sets of values keep what K allows, and the kind types go; with no values, one
 * type says what K is. So `type` next to `enum` gives `"a"`, not `string & "a"`,
 * and contradictions (`number & string`, `"a" & "b"`) are `never`.
 * Returns `items` itself when nothing changes.
 */
function narrow(items: Ty[]): Ty[] {
	const kindSets = items.map(kindsOf);
	const present = kindSets.filter((k) => k !== undefined);
	const kinds = present.length === 0 ? undefined : present.reduce(meet);
	const valueSets = items.map((t, i) =>
		kindSets[i] === undefined ? valuesOf(t) : undefined,
	);
	const literalSets = valueSets
		.filter(isLiterals)
		.map((v) => new Set(v.map(valueKey)));
	const keep = (m: Ty) =>
		(kinds === undefined || admits(kinds, m)) &&
		(!isLiteral(m) || literalSets.every((s) => s.has(valueKey(m))));
	const hasValues = valueSets.some((v) => v !== undefined);
	let changed = false;
	let literalsSeen = false;
	let kindsSeen = false;
	const out: Ty[] = [];
	items.forEach((t, i) => {
		const values = valueSets[i];
		if (values !== undefined) {
			if (isLiterals(values)) {
				// The first set of literals, narrowed by the others, stands for them all.
				if (literalsSeen) {
					changed = true;
					return;
				}
				literalsSeen = true;
			}
			const kept = values.filter(keep);
			if (kept.length === values.length) out.push(t);
			else {
				changed = true;
				out.push(union(kept));
			}
		} else if (kindSets[i] !== undefined) {
			if (hasValues || kindsSeen) {
				changed = true;
				return;
			}
			kindsSeen = true;
			if (present.length === 1) out.push(t);
			else {
				changed = true;
				out.push(union((kinds as ValueKind[]).map((k) => KIND_TY[k])));
			}
		} else out.push(t);
	});
	return changed ? out : items;
}

/** The members of a type that lists values (literals, null, exact objects and tuples), if it is one. */
function valuesOf(t: Ty): Ty[] | undefined {
	const members = t.kind === "union" ? t.items : [t];
	return members.every((m) => valueKind(m) !== undefined || m.kind === "null")
		? members
		: undefined;
}

const isLiteral = (m: Ty): boolean => m.kind === "lit" || m.kind === "null";

const isLiterals = (v: Ty[] | undefined): v is Ty[] =>
	v?.every(isLiteral) === true;

/** The type for each kind of value. */
const KIND_TY: Record<ValueKind, Ty> = {
	string: STRING,
	number: NUMBER,
	integer: INTEGER,
	boolean: BOOLEAN,
	null: NULL,
	object: RECORD,
	array: { kind: "array", elem: UNKNOWN },
};

/** The kinds both sets allow; `integer` is within `number`. */
function meet(a: ValueKind[], b: ValueKind[]): ValueKind[] {
	return a.flatMap((k): ValueKind[] => {
		if (b.includes(k) || (k === "integer" && b.includes("number"))) return [k];
		return k === "number" && b.includes("integer") ? ["integer"] : [];
	});
}

/**
 * A key that is equal for equal JSON values: a number by its exact value, so `1`,
 * `1.0`, `10e-1` and `-0` / `0` meet, without the rounding of a JavaScript number
 * (`12345678901234567890` and `…891` stay apart).
 */
function valueKey(m: Ty): string {
	if (m.kind !== "lit") return "null";
	if (valueKind(m) !== "number") return m.text;
	const [, sign, int, frac = "", exp = "0"] =
		/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(
			m.text,
		) as RegExpExecArray;
	let digits = `${int}${frac}`.replace(/^0+/, "");
	let e = Number(exp) - frac.length;
	if (digits === "") return "#0";
	while (digits.endsWith("0")) {
		digits = digits.slice(0, -1);
		e++;
	}
	return `#${sign}${digits}e${e}`;
}

/** Whether a value (`"a"`, `1.5`, `null`, an exact object) is of one of these kinds. */
function admits(kinds: ValueKind[], m: Ty): boolean {
	const kind = m.kind === "null" ? "null" : valueKind(m);
	if (
		kind === "number" &&
		m.kind === "lit" &&
		kinds.includes("integer") &&
		Number.isInteger(Number(m.text))
	)
		return true;
	return kind !== undefined && kinds.includes(kind);
}
