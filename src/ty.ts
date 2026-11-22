// Intermediate representation of TypeScript types, and its normalization.

export interface Prop {
	key: string;
	ty: Ty;
	optional: boolean;
	doc?: string;
	/** A key a JSON object must have: its value is a JSON value, never `undefined` (see `presentKeys`). */
	present?: true;
}

/** An index signature by a template literal type: `[key: `x-${string}`]: ty`. */
export interface Keyed {
	key: Ty;
	ty: Ty;
}

/** Which view of a component schema a reference means: as returned, or as sent. */
export type View = "read" | "write";

export type Ty =
	| { kind: "unknown" }
	/** `{}`: any value but `null` and `undefined`. */
	| { kind: "nonNullish" }
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
	/**
	 * A template literal type, as printed: `` `https://${"us" | "eu"}.example.com` ``; the
	 * `pattern` it is from, if it is, tells which strings it admits.
	 */
	| { kind: "template"; text: string; pattern?: string }
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
	/**
	 * Object literal with index signatures: `{ a: A; [key: `x-${string}`]: K; [key: string]: T }`,
	 * `keyed` by template literal types, `index` by any string.
	 */
	| { kind: "map"; props: Prop[]; index?: Ty; keyed?: Keyed[] }
	| { kind: "union"; items: Ty[] }
	| { kind: "inter"; items: Ty[] };

export const UNKNOWN: Ty = { kind: "unknown" };
export const NON_NULLISH: Ty = { kind: "nonNullish" };
export const NEVER: Ty = { kind: "never" };
export const NULL: Ty = { kind: "null" };
export const UNDEFINED: Ty = { kind: "undefined" };
export const STRING: Ty = { kind: "string" };
export const NUMBER: Ty = { kind: "number" };
export const INTEGER: Ty = { kind: "integer" };
export const BOOLEAN: Ty = { kind: "boolean" };
export const BLOB: Ty = { kind: "blob" };
export const RECORD: Ty = { kind: "record" };
/** `{} | null`: any JSON value. */
export const ANY_JSON: Ty = { kind: "union", items: [NON_NULLISH, NULL] };

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

/**
 * Structural equality. References to two views of a schema differ only where `views` says
 * the schema's views differ: always (`true`), never (`false`), or for the schemas in it.
 */
export function equal(
	a: Ty,
	b: Ty,
	views: boolean | ReadonlySet<string> = true,
): boolean {
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
				p.present === q.present &&
				eq(p.ty, q.ty)
			);
		});
	switch (a.kind) {
		case "lit":
		case "template":
			return b.kind === a.kind && a.text === (b as { text: string }).text;
		case "ref":
			return (
				b.kind === "ref" &&
				a.schema === b.schema &&
				(a.view === b.view ||
					(typeof views === "boolean" ? !views : !views.has(a.schema)))
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
		case "map": {
			if (b.kind !== "map" || !props(a.props, b.props)) return false;
			const keyed = (m: typeof a) => [
				...(m.keyed ?? []).flatMap((k) => [k.key, k.ty]),
				...(m.index === undefined ? [] : [STRING, m.index]),
			];
			return list(keyed(a), keyed(b));
		}
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
			for (const k of t.keyed ?? []) refs(k.ty, out);
			if (t.index !== undefined) refs(t.index, out);
			break;
		case "union":
		case "inter":
			for (const i of t.items) refs(i, out);
			break;
	}
	return out;
}

/**
 * The component schemas a type is made of directly: through unions and intersections,
 * not inside an object, array or tuple type, where TypeScript defers a reference.
 */
export function bareRefs(
	t: Ty,
	out: { schema: string; view: View }[] = [],
): { schema: string; view: View }[] {
	if (t.kind === "ref") out.push({ schema: t.schema, view: t.view });
	else if (t.kind === "union" || t.kind === "inter")
		for (const i of t.items) bareRefs(i, out);
	return out;
}

/**
 * Whether a type admits any value: `unknown`, a union with a member that does, an
 * intersection of such types, or a reference to a component whose type (`resolve`) does.
 */
export function admitsAny(
	t: Ty,
	resolve: (r: { schema: string; view: View }) => boolean,
): boolean {
	switch (t.kind) {
		case "unknown":
			return true;
		case "ref":
			return resolve(t);
		case "union":
			return t.items.some((i) => admitsAny(i, resolve));
		case "inter":
			return t.items.every((i) => admitsAny(i, resolve));
		default:
			return false;
	}
}

/**
 * Adds `{} | null` to each key a JSON object must have (`Prop.present`) whose type
 * admits any value (`any`): such a type admits `undefined` in TypeScript, which would
 * stay in the type another member gives (`{ a?: string } & { a: unknown }` reads `a`
 * as `string | undefined`), while JSON has no `undefined`. `unknown` becomes `{} | null`.
 * A type with no such key is kept as it is.
 */
export function presentKeys(t: Ty, any: (t: Ty) => boolean): Ty {
	// Each part gone through; unchanged, the type is itself, and what is known of it stays.
	let changed = false;
	// The items of a long tuple are one type, gone through once.
	let last: Ty | undefined;
	let lastOut = t;
	const go = (u: Ty) => {
		if (u !== last) {
			last = u;
			lastOut = presentKeys(u, any);
		}
		if (lastOut !== u) changed = true;
		return lastOut;
	};
	const props = (ps: Prop[]) =>
		ps.map((p) => {
			const ty = go(p.ty);
			if (!p.present || !any(ty)) return ty === p.ty ? p : { ...p, ty };
			changed = true;
			return { ...p, ty: inter([ty, ANY_JSON]) };
		});
	let out: Ty = t;
	switch (t.kind) {
		case "array": {
			const elem = go(t.elem);
			if (changed) out = { kind: "array", elem };
			break;
		}
		case "tuple": {
			const items = t.items.map(go);
			const rest = t.rest === undefined ? undefined : go(t.rest);
			if (changed)
				out =
					rest === undefined
						? { kind: "tuple", items, min: t.min }
						: { kind: "tuple", items, min: t.min, rest };
			break;
		}
		case "object": {
			const ps = props(t.props);
			if (changed) out = { kind: "object", props: ps };
			break;
		}
		case "map": {
			const ps = props(t.props);
			const keyed = t.keyed?.map((k) => ({ key: k.key, ty: go(k.ty) }));
			const index = t.index === undefined ? undefined : go(t.index);
			if (changed)
				out = {
					kind: "map",
					props: ps,
					...(keyed === undefined ? {} : { keyed }),
					...(index === undefined ? {} : { index }),
				};
			break;
		}
		case "union":
		case "inter": {
			const items = t.items.map(go);
			if (changed) out = { kind: t.kind, items };
			break;
		}
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
	// A literal is no kind type; a union of thousands of them has none to read.
	const kinds = out.flatMap((t) =>
		t.kind === "lit" ? [] : (kindsOf(t) ?? []),
	);
	// `number` admits every whole number; a primitive admits its literals, `string` its templates.
	if (kinds.length > 0)
		out = out.filter((t) =>
			t.kind === "integer"
				? !kinds.includes("number")
				: t.kind === "template"
					? !kinds.includes("string")
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
	// One type meets nothing: it is as it was built.
	if (out.length === 1) return out[0] as Ty;
	const arrays = out.filter(isArrayTy);
	if (arrays.length > 1)
		return inter([...out.filter((t) => !isArrayTy(t)), meetArrays(arrays)]);
	// A union with arrays meets the other arrays member by member, so that their items
	// read as both say: `(string | unknown[]) & (string | string[])` is `string | string[]`.
	const arrayish = out.filter(hasArray);
	if (arrayish.length > 1 && arrayish.some((t) => t.kind === "union")) {
		const combos = arrayish.reduce<Ty[][]>(
			(acc, t) =>
				acc.flatMap((c) =>
					(t.kind === "union" ? t.items : [t]).map((m) => [...c, m]),
				),
			[[]],
		);
		return inter([
			...out.filter((t) => !arrayish.includes(t)),
			union(combos.map((c) => inter(c))),
		]);
	}
	const merged = mergeObjects(out);
	if (merged !== out) return inter(merged);
	// A union of object types meets the object type next to it member by member, each
	// one object type: `{ a?: A } & ({ b: B } | { c: C })` is `{ a?: A; b: B } | { a?: A; c: C }`.
	const objects = out.find((t) => t.kind === "object");
	const alternatives = out.find(
		(t): t is Extract<Ty, { kind: "union" }> =>
			t.kind === "union" && t.items.every((m) => m.kind === "object"),
	);
	if (objects !== undefined && alternatives !== undefined) {
		const rest = out.filter((t) => t !== alternatives && t !== objects);
		return inter([
			...rest,
			union(alternatives.items.map((m) => inter([objects, m]))),
		]);
	}
	const narrowed = prune(narrow(out));
	// Narrowing can make members equal (`"a" & ("a" | 1) & string`); normalize again.
	// Each round drops a member or shrinks a set of values, so this ends.
	if (narrowed !== out) return inter(narrowed);
	if (out.some((t) => t.kind === "never")) return NEVER;
	// Members of kinds no value has both of meet nowhere: `null & string[]`.
	const kinds = out.map(kindSet).filter((k) => k !== undefined);
	if (
		kinds.some((a, i) =>
			kinds
				.slice(i + 1)
				.some((b) => !a.some((x) => b.some((y) => meets(x, y)))),
		)
	)
		return NEVER;
	if (out.length === 0) return UNKNOWN;
	return { kind: "inter", items: out };
}

type ArrayTy = Extract<Ty, { kind: "array" | "tuple" }>;

const isArrayTy = (t: Ty): t is ArrayTy =>
	t.kind === "array" || t.kind === "tuple";

/** An array or tuple, or a union with one. */
const hasArray = (t: Ty): boolean =>
	isArrayTy(t) || (t.kind === "union" && t.items.some(isArrayTy));

/**
 * Object types are one object type: each property's types met, required where one
 * requires it (so that the items of arrays read as both say: TypeScript reads an item
 * of `A[] & B[]` as `A`). A required property that admits nothing admits no object.
 * Returns `items` itself when there is one object type at most.
 */
function mergeObjects(items: Ty[]): Ty[] {
	const objects = items.filter(
		(t): t is Extract<Ty, { kind: "object" }> => t.kind === "object",
	);
	if (objects.length < 2) return items;
	const props: Prop[] = [];
	for (const o of objects)
		for (const p of o.props) {
			const i = props.findIndex((q) => q.key === p.key);
			const q = props[i];
			if (q === undefined) {
				props.push(p);
				continue;
			}
			const met: Prop = {
				...q,
				ty: inter([q.ty, p.ty]),
				optional: q.optional && p.optional,
			};
			if (p.present) met.present = true;
			if (met.doc === undefined && p.doc !== undefined) met.doc = p.doc;
			props[i] = met;
		}
	if (props.some((p) => !p.optional && p.ty.kind === "never")) return [NEVER];
	return [
		...items.filter((t) => t.kind !== "object"),
		{ kind: "object", props },
	];
}

/**
 * Arrays and tuples meet item by item: `string[]` and `[unknown, unknown, ...unknown[]]`
 * are `[string, string, ...string[]]`. TypeScript reads an item of their intersection
 * as the tuple's alone (`unknown`). A tuple without `rest` closes the others at its
 * length, and requiring more items than that admits nothing.
 */
function meetArrays(arrays: ArrayTy[]): Ty {
	const rows = arrays.map((t) =>
		t.kind === "tuple" ? t : { items: [], min: 0, rest: t.elem },
	);
	const min = Math.max(...rows.map((r) => r.min));
	const closed = rows.filter((r) => r.rest === undefined);
	const length = Math.min(
		Math.max(...rows.map((r) => r.items.length)),
		...closed.map((r) => r.items.length),
	);
	if (min > length) return NEVER;
	// Below `length`, a closed tuple has the item and an open one its item or `rest`.
	const items = Array.from({ length }, (_, i) =>
		inter(rows.map((r) => r.items[i] ?? (r.rest as Ty))),
	);
	if (items.slice(0, min).some((t) => t.kind === "never")) return NEVER;
	if (closed.length > 0) return { kind: "tuple", items, min };
	const rest = inter(rows.map((r) => r.rest as Ty));
	return length === 0
		? { kind: "array", elem: rest }
		: { kind: "tuple", items, min, rest };
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

/**
 * `f`, remembered for each union and intersection: a type is never changed once built,
 * and the normalization asks again for the same ones, unions of thousands of literals
 * among them. Other types cost less to read again than to look up.
 */
function remembered<T>(f: (t: Ty) => T): (t: Ty) => T {
	const known = new WeakMap<Ty, T>();
	return (t) => {
		if (t.kind !== "union" && t.kind !== "inter") return f(t);
		if (known.has(t)) return known.get(t) as T;
		const r = f(t);
		known.set(t, r);
		return r;
	};
}

/** The kinds of value an "any value of these kinds" type admits: `string`, `string | null`, `Record`, `unknown[]`. */
const kindsOf = remembered((t: Ty): ValueKind[] | undefined =>
	kindsBy(t, (m) => {
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
	}),
);

/** The kind `one` gives each member of a union (or the type), if it gives every one a kind. */
function kindsBy(
	t: Ty,
	one: (m: Ty) => ValueKind | undefined,
): ValueKind[] | undefined {
	if (t.kind !== "union") {
		const k = one(t);
		return k === undefined ? undefined : ONE_KIND[k];
	}
	const kinds: ValueKind[] = [];
	for (const m of t.items) {
		const k = one(m);
		if (k === undefined) return undefined;
		kinds.push(k);
	}
	return kinds;
}

/** Each kind alone, one list for all that ask (none changes it). */
const ONE_KIND: Record<ValueKind, ValueKind[]> = {
	string: ["string"],
	number: ["number"],
	integer: ["integer"],
	boolean: ["boolean"],
	null: ["null"],
	object: ["object"],
	array: ["array"],
};

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
 * and contradictions (`number & string`, `"a" & "b"`) are `never`. A template
 * (from `pattern`) is some strings: it meets kinds as `string` does and stands for them,
 * and the values next to it keep the strings it admits.
 * Returns `items` itself when nothing changes.
 */
function narrow(items: Ty[]): Ty[] {
	const strings = items.map(isStrings);
	const templates = items.filter((_, i) => strings[i]);
	const kindSets = items.map((t, i) => (strings[i] ? undefined : kindsOf(t)));
	const present: ValueKind[][] = kindSets.filter((k) => k !== undefined);
	if (templates.length > 0) present.push(["string"]);
	const kinds = present.length === 0 ? undefined : present.reduce(meet);
	const valueSets = items.map((t, i) =>
		kindSets[i] === undefined ? valuesOf(t) : undefined,
	);
	const literalSets = valueSets
		.filter(isLiterals)
		.map((v) => new Set(v.map(valueKey)));
	const keep = (m: Ty) =>
		(kinds === undefined || admits(kinds, m)) &&
		(!isLiteral(m) || literalSets.every((s) => s.has(valueKey(m)))) &&
		templates.every((t) => admitsString(t, m));
	const hasValues = valueSets.some((v) => v !== undefined);
	let changed = false;
	let literalsSeen = false;
	let kindsSeen = false;
	const out: Ty[] = [];
	items.forEach((t, i) => {
		const values = valueSets[i];
		if (strings[i]) {
			// Values say more; kinds without strings admit none of it.
			if (hasValues || kinds?.length === 0) {
				changed = true;
				if (!hasValues) out.push(NEVER);
			} else out.push(t);
		} else if (values !== undefined) {
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
			if (hasValues || kindsSeen || templates.length > 0) {
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

/** Whether a type admits some strings only, a template among them: `` `a${string}` ``, `` `a${string}` | "b" ``. */
function isStrings(t: Ty): boolean {
	const members = t.kind === "union" ? t.items : [t];
	return (
		members.some((m) => m.kind === "template") &&
		members.every((m) => m.kind === "template" || valueKind(m) === "string")
	);
}

/**
 * Whether a type of some strings admits a string literal: a template by its pattern (the
 * templates values meet are from `pattern`), a literal by its text.
 */
function admitsString(t: Ty, m: Ty): boolean {
	const text = (m as { text: string }).text;
	const s = JSON.parse(text) as string;
	return (t.kind === "union" ? t.items : [t]).some((x) =>
		x.kind === "template"
			? new RegExp(x.pattern as string, "u").test(s)
			: (x as { text: string }).text === text,
	);
}

/** The kinds of value a type admits, where its form says so: `{ a: A }` objects, `string | A[]` strings and arrays. */
const kindSet = remembered((t: Ty): ValueKind[] | undefined => {
	if (t.kind === "inter") {
		// The kinds every member it says them of allows.
		const sets = t.items.map(kindSet).filter((s) => s !== undefined);
		return sets.length === 0
			? undefined
			: sets.reduce((a, b) => a.filter((k) => b.some((o) => meets(k, o))));
	}
	if (t.kind !== "union") return memberKinds(t);
	const kinds: ValueKind[] = [];
	for (const m of t.items) {
		const k = memberKinds(m);
		if (k === undefined) return undefined;
		kinds.push(...k);
	}
	return kinds;
});

/** `kindSet` of a type that is no union. */
function memberKinds(m: Ty): ValueKind[] | undefined {
	if (m.kind === "inter") return kindSet(m);
	const k =
		kindsOf(m)?.[0] ??
		valueKind(m) ??
		(m.kind === "null"
			? "null"
			: m.kind === "array"
				? "array"
				: m.kind === "template"
					? "string"
					: undefined);
	return k === undefined ? undefined : ONE_KIND[k];
}

const meets = (a: ValueKind, b: ValueKind): boolean =>
	a === b ||
	(a === "integer" && b === "number") ||
	(a === "number" && b === "integer");

/**
 * Drops the members of a union another member of the intersection rules out by kind:
 * `{ a?: string } & (Cat | string)` is `{ a?: string } & Cat`. Returns `items` itself
 * when nothing changes.
 */
function prune(items: Ty[]): Ty[] {
	if (!items.some((t) => t.kind === "union")) return items;
	const sets = items.map(kindSet);
	let changed = false;
	const out = items.map((t, i) => {
		if (t.kind !== "union") return t;
		const others = sets.filter(
			(s, j): s is ValueKind[] => j !== i && s !== undefined,
		);
		const kept = t.items.filter((m) => {
			const own = kindSet(m);
			return (
				own === undefined ||
				others.every((s) => own.some((k) => s.some((o) => meets(k, o))))
			);
		});
		if (kept.length === t.items.length) return t;
		changed = true;
		return union(kept);
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
	// A number's key is remembered: a range is thousands of them, met again and again.
	let key = numberKeys.get(m);
	if (key === undefined) {
		key = numberKey(m.text);
		numberKeys.set(m, key);
	}
	return key;
}

const numberKeys = new WeakMap<Ty, string>();

function numberKey(text: string): string {
	const [, sign, int, frac = "", exp = "0"] =
		/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) as RegExpExecArray;
	let digits = `${int}${frac}`.replace(/^0+/, "");
	let e = Number(exp) - frac.length;
	if (digits === "") return "#0";
	while (digits.endsWith("0")) {
		digits = digits.slice(0, -1);
		e++;
	}
	return `#${sign}${digits}e${e}`;
}

/** Whether two types of JSON values are the same value: literals by value (`1` and `1.0`), others by structure. */
export function equalValues(a: Ty, b: Ty): boolean {
	return a.kind === "lit" && b.kind === "lit"
		? valueKey(a) === valueKey(b)
		: equal(a, b);
}

/** Whether a value (`"a"`, `1.5`, `null`, an exact object) is of one of these kinds. */
function admits(kinds: ValueKind[], m: Ty): boolean {
	const kind = m.kind === "null" ? "null" : valueKind(m);
	if (
		kind === "number" &&
		m.kind === "lit" &&
		kinds.includes("integer") &&
		isWholeText(m.text)
	)
		return true;
	return kind !== undefined && kinds.includes(kind);
}

/** Whether a number's text is a whole number by its exact value (`1e400` is, `1e-400` is not). */
function isWholeText(text: string): boolean {
	return !numberKey(text).includes("e-");
}
