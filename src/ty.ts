// Intermediate representation of TypeScript types, and its normalization.

import { type JsonNumber, JsonObject, toJson, type Value } from "./json.ts";

export interface Prop {
	readonly key: string;
	readonly ty: Ty;
	readonly optional: boolean;
	readonly doc?: string;
	/** A key a JSON object must have: its value is a JSON value, never `undefined` (see `presentKeys`). */
	readonly present?: true;
}

/** An index signature by a template literal type: `[key: `x-${string}`]: ty`. */
export interface Keyed {
	readonly key: Ty;
	readonly ty: Ty;
}

/** Which view of a component schema a reference means: as returned, or as sent. */
export type View = "read" | "write";

/** Part of a template literal type: one of a finite set of strings, or any text. */
export type Segment = { set: string[] } | { any: true };

/**
 * Whether a template literal type's segments admit a string, from segment `i` and its
 * position `at`: a set by one of its strings there, any text by any run of it.
 */
export function inTemplate(seq: Segment[], s: string, i = 0, at = 0): boolean {
	const x = seq[i];
	if (x === undefined) return at === s.length;
	if ("any" in x) {
		for (let end = at; end <= s.length; end++)
			if (inTemplate(seq, s, i + 1, end)) return true;
		return false;
	}
	return x.set.some(
		(e) => s.startsWith(e, at) && inTemplate(seq, s, i + 1, at + e.length),
	);
}

export type Ty =
	| { readonly kind: "unknown" }
	/** `{}`: any value but `null` and `undefined`. */
	| { readonly kind: "nonNullish" }
	| { readonly kind: "never" }
	| { readonly kind: "null" }
	| { readonly kind: "undefined" }
	| { readonly kind: "string" }
	| { readonly kind: "number" }
	/** A whole number; printed as `number`, but it narrows `enum` / `const` values to whole ones. */
	| { readonly kind: "integer" }
	| { readonly kind: "boolean" }
	| { readonly kind: "blob" }
	/** `Record<string, unknown>`: any object. */
	| { readonly kind: "record" }
	/** Literal in JSON notation: `"admin"` with quotes, `1`, `true`. */
	| { readonly kind: "lit"; readonly text: string }
	/**
	 * A template literal type, as printed: `` `https://${"us" | "eu"}.example.com` ``, and
	 * its segments, which say which strings it admits (see `inTemplate`).
	 */
	| {
			readonly kind: "template";
			readonly text: string;
			readonly seq: Segment[];
	  }
	/**
	 * A component schema, by its key in `components.schemas`; named when emitted. `kinds`
	 * are those of its type, and `size` its combinations (see `combinations`), once all
	 * components are converted (see `withRefKinds`).
	 */
	| {
			readonly kind: "ref";
			readonly schema: string;
			readonly view: View;
			readonly kinds?: ValueKind[] | undefined;
			readonly size?: number;
	  }
	/** `operations[id]` */
	| { readonly kind: "opRef"; readonly id: string }
	| { readonly kind: "array"; readonly elem: Ty }
	/**
	 * The arrays of the first `min` items and any of the others after them, in order,
	 * followed by any number of `rest` items when given: `[] | [A] | [A, B, ...R[]]` for
	 * `min` 0 (written so by `emit`, since an optional item would admit `undefined`).
	 */
	| {
			readonly kind: "tuple";
			readonly items: Ty[];
			readonly min: number;
			readonly rest?: Ty;
	  }
	/** Object literal; `{}` when empty. */
	| { readonly kind: "object"; readonly props: Prop[] }
	/**
	 * Object literal with index signatures: `{ a: A; [key: `x-${string}`]: K; [key: string]: T }`,
	 * `keyed` by template literal types, `index` by any string.
	 */
	| {
			readonly kind: "map";
			readonly props: Prop[];
			readonly index?: Ty;
			readonly keyed?: Keyed[];
	  }
	| { readonly kind: "union"; readonly items: Ty[] }
	| { readonly kind: "inter"; readonly items: Ty[] };

export const UNKNOWN: Ty = { kind: "unknown" };
const NON_NULLISH: Ty = { kind: "nonNullish" };
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
const ANY_JSON: Ty = { kind: "union", items: [NON_NULLISH, NULL] };

export const lit = (text: string): Ty => ({ kind: "lit", text });
export const ref = (schema: string, view: View = "read"): Ty => ({
	kind: "ref",
	schema,
	view,
});
export const opRef = (id: string): Ty => ({ kind: "opRef", id });
export const array = (elem: Ty): Ty => ({ kind: "array", elem });
export const object = (props: Prop[]): Ty => ({ kind: "object", props });

// The most of each part kanagata writes one type of. Past them it writes a wider type,
// which admits every value the schema does, and notes it (`Ctx.info`): TypeScript rejects
// some such types (a tuple of 10,000 items, TS2799; a union of 100,000 members, TS2590)
// and slows down on others well before. Each is about where TypeScript 7 takes tens of
// milliseconds to check one type.

/** Items of a tuple. */
export const MAX_ITEMS = 9999;

/**
 * Members of a union of values: the strings of a pattern's templates (and those patterns
 * share), the numbers bounds admit but integers in a row.
 */
export const MAX_VALUES = 10_000;

/**
 * Integers in a row bounds admit, which `emit` spells by their digits (`integers<…>`) and
 * TypeScript builds into a union cheaply, below a union of 100,000 (TS2590): 99,999 take
 * it about 190 ms.
 */
export const MAX_INTEGERS = 99_999;

/**
 * The strings of the sets of the templates that key an object type's index signatures,
 * which TypeScript checks each against each other.
 */
export const MAX_KEYS = 300;

/**
 * Combinations of an intersection of unions, which TypeScript builds into the union of
 * them (a template's strings among them), and the cases `unevaluatedItems` reads, a union
 * of each set of branches.
 */
export const MAX_COMBINATIONS = 1000;

/**
 * Items or properties written in the members of one union: a tuple for each length past
 * the required items, an object type for each set of properties, a tuple for each place
 * of the item `contains` admits.
 */
export const MAX_WRITTEN = 20_000;

/** The note for a part typed wider for its size: `more than 9999 items; not typed`. */
export const manyNote = (most: number, what: string, typed: string): string =>
	`more than ${most} ${what}; ${typed}`;

/** The note for a count of more items than kanagata writes a tuple of. */
export const MANY_ITEMS = manyNote(MAX_ITEMS, "items", "not typed");

/** The note for an intersection that left out unions past `MAX_COMBINATIONS`. */
export const COMBINATIONS_LEFT_OUT = manyNote(
	MAX_COMBINATIONS,
	"combinations",
	"some of its parts are not typed",
);

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

/** A key a JSON object must have, of this type (see `Prop.present`). */
export const present = (key: string, ty: Ty): Prop => ({
	key,
	ty,
	optional: false,
	present: true,
});

/** A key an object does not have: `key?: never`. */
export const neverProp = (key: string): Prop => ({
	key,
	ty: NEVER,
	optional: true,
});

/** The objects without this key: `{ key?: never }`. */
export const absent = (key: string): Ty => ({
	kind: "object",
	props: [neverProp(key)],
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
		case "opRef":
			return b.kind === "opRef" && a.id === b.id;
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
 * What a reference's component is: its type, the kinds of value it admits and its
 * combinations (see `combinations`), in the reference's view.
 */
interface Components {
	kinds: (r: RefTy) => ValueKind[] | undefined;
	type: (r: RefTy) => Ty;
	size: (r: RefTy) => number;
}

/**
 * The type with each reference an intersection meets of the kinds of its component's
 * type, and those intersections and the unions around them built again, which leave
 * out what those kinds rule out: `(Base | string) & Extra` is `Base & Extra` where `Extra`
 * is an object type. Elsewhere a reference's kinds change nothing (a union reads none),
 * so it stays as it is. A reference that a part of another kind would meet as TypeScript
 * does not read it is written out there (`writtenOut`). `met` says whether `t` is met
 * there, through unions and intersections; `done` holds the types gone through already,
 * outside an intersection and in one, so that each is gone through once. A type nothing
 * in changes is itself. A reference met also has its combinations, and an intersection
 * whose combinations waited for them (`deferred`) is built again, of them at most.
 */
export function withRefKinds(
	t: Ty,
	components: Components,
	done: readonly [Map<Ty, Ty>, Map<Ty, Ty>],
	met = false,
): Ty {
	const was = final;
	final = true;
	try {
		return refKinded(t, components, done, met);
	} finally {
		final = was;
	}
}

function refKinded(
	t: Ty,
	components: Components,
	done: readonly [Map<Ty, Ty>, Map<Ty, Ty>],
	met: boolean,
): Ty {
	if (t.kind === "ref") {
		if (!met) return t;
		const kinds = components.kinds(t);
		const size = components.size(t);
		return kinds === undefined && size === 1 ? t : { ...t, kinds, size };
	}
	// Most types are of no parts, which nothing changes.
	if (!PARTED.has(t.kind)) return t;
	const seen = done[met ? 1 : 0];
	const known = seen.get(t);
	if (known !== undefined) return known;
	let changed = false;
	const go = (u: Ty, inside = false) => {
		const out = refKinded(u, components, done, inside);
		if (out !== u) changed = true;
		return out;
	};
	const props = (ps: Prop[]) =>
		ps.map((p) => {
			const ty = go(p.ty);
			return ty === p.ty ? p : { ...p, ty };
		});
	let out: Ty = t;
	switch (t.kind) {
		case "array": {
			const elem = go(t.elem);
			if (changed) out = { kind: "array", elem };
			break;
		}
		case "tuple": {
			const items = t.items.map((u) => go(u));
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
		case "union": {
			const items = t.items.map((u) => go(u, met));
			if (changed) out = union(items);
			break;
		}
		case "inter": {
			let items = t.items.map((u) => go(u, true));
			// What a reference written out is made of may be written out in turn.
			let written = writtenOut(items, components);
			while (written !== undefined) {
				items = written.map((u) => go(u, true));
				changed = true;
				written = writtenOut(items, components);
			}
			if (changed || deferred.has(t)) out = inter(items);
			break;
		}
	}
	seen.set(t, out);
	return out;
}

/**
 * The parts of an intersection with each reference of several kinds written out (its
 * component's type) where another part has a kind that meets one of them as TypeScript
 * does not read it: an object type and a value of another kind than `null`. TypeScript
 * meets each member of the reference's type with the other parts on its own, and
 * `string & { y?: string }` admits every string, so `Value & { y?: string }` with `Value`
 * being `{ x?: number } | string` is `{ x?: number; y?: string }`. It reads `null` met
 * with an object type, and two other kinds, as `never`. undefined where none is.
 */
function writtenOut(items: Ty[], components: Components): Ty[] | undefined {
	const rows = items.map((t) => (t.kind === "union" ? t.items : [t]));
	const kinds = rows.map((ms) => ms.flatMap((m) => memberKinds(m) ?? []));
	const apart = (k: ValueKind, o: ValueKind) =>
		(k === "object" && o !== "object" && o !== "null") ||
		(o === "object" && k !== "object" && k !== "null");
	let written = false;
	const out = items.map((t, i) => {
		const others = kinds.flatMap((ks, j) => (j === i ? [] : ks));
		let own = false;
		const ms = (rows[i] as Ty[]).map((m) => {
			const ks = m.kind === "ref" ? m.kinds : undefined;
			if (
				ks === undefined ||
				ks.length < 2 ||
				!ks.some((k) => others.some((o) => apart(k, o)))
			)
				return m;
			own = true;
			return components.type(m as RefTy);
		});
		if (!own) return t;
		written = true;
		return union(ms);
	});
	return written ? out : undefined;
}

/** The kinds of type made of other types. */
const PARTED = new Set<Ty["kind"]>([
	"array",
	"tuple",
	"object",
	"map",
	"union",
	"inter",
]);

/**
 * Collects distinct members: literals by their text through a Set (enums can have
 * thousands), other types by their structure: a few one by one (`same`), past `FEW` by
 * their keys (`structure`) through a Set (unions of thousands of tuples are built too).
 */
function distinct(): { out: Ty[]; add: (t: Ty) => void } {
	const out: Ty[] = [];
	// Made when first needed: most unions and intersections have few members, and no literal.
	let texts: Set<string> | undefined;
	let others = 0;
	let keys: Set<string> | undefined;
	const add = (t: Ty): void => {
		if (t.kind === "lit") {
			texts ??= new Set();
			if (texts.has(t.text)) return;
			texts.add(t.text);
		} else if (keys === undefined) {
			for (const o of out) if (same(o, t)) return;
			out.push(t);
			if (++others >= FEW)
				keys = new Set(
					out.flatMap((o) => (o.kind === "lit" ? [] : [structure(o)])),
				);
			return;
		} else {
			const key = structure(t);
			if (keys.has(key)) return;
			keys.add(key);
		}
		out.push(t);
	};
	return { out, add };
}

/** How many members other than literals `distinct` compares one by one. */
const FEW = 16;

/**
 * A key that is equal for types TypeScript reads as one: equal by structure (references to
 * the two views of a schema differ), an object type's properties, a map's index signatures
 * and the members of a union or intersection in any order. Strings in it are JSON, so the
 * key of a member does not run into the next one's. Remembered: a type is never changed
 * once built.
 */
const structure = (t: Ty): string => {
	let key = structures.get(t);
	if (key === undefined) {
		key = structureOf(t);
		structures.set(t, key);
	}
	return key;
};

const structures = new WeakMap<Ty, string>();

function structureOf(t: Ty): string {
	const list = (ts: Ty[]) => ts.map(structure).join(",");
	const set = (keys: string[]) =>
		keys.length < 2 ? (keys[0] ?? "") : keys.sort().join(",");
	const props = (ps: Prop[]) =>
		set(
			ps.map(
				(p) =>
					`${JSON.stringify(p.key)}${p.optional ? "?" : ""}${p.present ? "!" : ""}${p.doc === undefined ? "" : JSON.stringify(p.doc)}:${structure(p.ty)}`,
			),
		);
	switch (t.kind) {
		case "lit":
		case "template":
			return `${t.kind}${JSON.stringify(t.text)}`;
		case "ref":
			return `ref${JSON.stringify(t.schema)}${t.view}`;
		case "opRef":
			return `opRef${JSON.stringify(t.id)}`;
		case "array":
			return `array(${structure(t.elem)})`;
		case "tuple":
			return `tuple${t.min}(${list(t.items)}${t.rest === undefined ? "" : `;${structure(t.rest)}`})`;
		case "object":
			return `object(${props(t.props)})`;
		case "map":
			return `map(${props(t.props)};${set(signatures(t).map((k) => `${structure(k.key)}:${structure(k.ty)}`))})`;
		case "union":
		case "inter":
			return `${t.kind}(${set(t.items.map(structure))})`;
		default:
			return t.kind;
	}
}

type MapTy = Extract<Ty, { kind: "map" }>;

/** A map's index signatures; `[key: string]` is the one keyed by `string`. */
const signatures = (t: MapTy): Keyed[] => [
	...(t.keyed ?? []),
	...(t.index === undefined ? [] : [{ key: STRING, ty: t.index }]),
];

/**
 * Whether two types have one structure (`structure` gives them one key), compared without
 * keys: in order where the order is the type's, as sets where TypeScript reads none.
 */
function same(a: Ty, b: Ty): boolean {
	if (a === b) return true;
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "array":
			return same(a.elem, (b as typeof a).elem);
		case "tuple": {
			const c = b as typeof a;
			return (
				a.min === c.min &&
				a.items.length === c.items.length &&
				a.items.every((t, i) => same(t, c.items[i] as Ty)) &&
				(a.rest === undefined
					? c.rest === undefined
					: c.rest !== undefined && same(a.rest, c.rest))
			);
		}
		case "object":
			return sameProps(a.props, (b as typeof a).props);
		case "map": {
			const c = b as typeof a;
			return (
				sameProps(a.props, c.props) &&
				sameSet(
					signatures(a),
					signatures(c),
					(x, y) => same(x.key, y.key) && same(x.ty, y.ty),
				)
			);
		}
		case "union":
		case "inter": {
			const c = b as typeof a;
			if (a.items.length !== c.items.length) return false;
			const i = a.items.findIndex((t, j) => !same(t, c.items[j] as Ty));
			if (i < 0) return true;
			// Out of order: a member the other lacks tells them apart without keys.
			const t = a.items[i] as Ty;
			if (!c.items.some((u) => same(t, u))) return false;
			return a.items.length < FEW
				? sameSet(a.items, c.items, same)
				: structure(a) === structure(c);
		}
		default:
			return equal(a, b);
	}
}

const sameProp = (p: Prop, q: Prop): boolean =>
	p.key === q.key &&
	p.optional === q.optional &&
	p.present === q.present &&
	p.doc === q.doc &&
	same(p.ty, q.ty);

/**
 * Whether two object types have the same properties, in any order: in order first; a key
 * is an object type's once, so another property at the same key tells them apart, and a
 * key the other lacks too.
 */
function sameProps(x: Prop[], y: Prop[]): boolean {
	if (x.length !== y.length) return false;
	const i = x.findIndex((p, j) => !sameProp(p, y[j] as Prop));
	if (i < 0) return true;
	const p = x[i] as Prop;
	if (p.key === (y[i] as Prop).key || !y.some((q) => q.key === p.key))
		return false;
	const byKey = new Map(y.map((q) => [q.key, q]));
	return x.every((p) => {
		const q = byKey.get(p.key);
		return q !== undefined && sameProp(p, q);
	});
}

/** Whether two lists have the same members, in any order (each list has a member once). */
const sameSet = <T>(x: T[], y: T[], eq: (a: T, b: T) => boolean): boolean =>
	x.length === y.length && x.every((a) => y.some((b) => eq(a, b)));

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
	// `number` admits every whole number; a primitive admits its literals, `string` its
	// templates, `Record<string, unknown>` every object type and `unknown[]` every array.
	if (kinds.length > 0)
		out = out.filter((t) =>
			t.kind === "integer"
				? !kinds.includes("number")
				: t.kind === "template"
					? !kinds.includes("string")
					: t.kind === "object" || t.kind === "map"
						? !kinds.includes("object")
						: t.kind === "tuple" ||
								(t.kind === "array" && t.elem.kind !== "unknown")
							? !kinds.includes("array")
							: t.kind !== "lit" || !ofKinds(kinds, t),
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
	// read as both say: `(string | unknown[]) & (string | string[])` is `string | string[]`;
	// past MAX_COMBINATIONS combinations of their members they stay as they are (below).
	const arrayish = out.filter(hasArray);
	if (
		arrayish.length > 1 &&
		arrayish.some((t) => t.kind === "union") &&
		arrayish.reduce((n, t) => n * memberCount(t), 1) <= MAX_COMBINATIONS
	) {
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
	const byKind = meetByKind(out);
	if (byKind !== undefined) return byKind;
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
	// TypeScript builds the union of every combination of the unions' members (and of the
	// strings of templates, and of the components references are): past MAX_COMBINATIONS,
	// those of the most are left out, as many as that takes, but one. Where a reference's are not
	// known yet, nor are the kinds that leave members out, so the intersection waits for
	// them (`withRefKinds`).
	if (out.reduce((n, t) => n * combinations(t), 1) > MAX_COMBINATIONS) {
		if (!final && out.some(refersDeep)) {
			const waiting: Ty = { kind: "inter", items: out };
			deferred.add(waiting);
			metRefs++;
			return waiting;
		}
		widened++;
		const left = [...out];
		while (
			left.length > 1 &&
			left.reduce((n, t) => n * combinations(t), 1) > MAX_COMBINATIONS
		) {
			const most = left.reduce((a, b) =>
				combinations(b) > combinations(a) ? b : a,
			);
			left.splice(left.indexOf(most), 1);
		}
		return inter(left);
	}
	if (out.some(holdsRef)) metRefs++;
	return { kind: "inter", items: out };
}

/** The members of a union, one for any other type. */
const memberCount = (t: Ty): number =>
	t.kind === "union" ? t.items.length : 1;

/**
 * The members TypeScript reads a type as where it meets another: a union's, an
 * intersection's combinations, a template's strings of its sets (`` `${"a" | "b"}-${string}` ``
 * is two), and a reference's those of its component (`size`, or `of`); one for any other.
 */
export function combinations(
	t: Ty,
	of: (r: RefTy) => number = (r) => r.size ?? 1,
): number {
	switch (t.kind) {
		case "union":
			return t.items.reduce((n, m) => n + combinations(m, of), 0);
		case "inter":
			return t.items.reduce((n, m) => n * combinations(m, of), 1);
		case "ref":
			return of(t);
		case "template": {
			let n = 1;
			for (const s of t.seq) if ("set" in s) n *= s.set.length;
			return n;
		}
		default:
			return 1;
	}
}

/**
 * Whether references' kinds and combinations are known (`withRefKinds`), so that no
 * intersection waits for them.
 */
let final = false;

/** The intersections built before their references' combinations were known. */
const deferred = new WeakSet<Ty>();

/** Whether a type has a reference, as a part or a member of one, at any depth. */
const refersDeep = (t: Ty): boolean =>
	t.kind === "ref" ||
	((t.kind === "union" || t.kind === "inter") && t.items.some(refersDeep));

/** How many intersections have left out unions past `MAX_COMBINATIONS`. */
let widened = 0;

/**
 * Builds a type, and says whether an intersection in it left out unions past
 * `MAX_COMBINATIONS`, but in types built within it the same way, which say so themselves.
 */
export function leavingOut<T>(build: () => T): [T, boolean] {
	const was = widened;
	widened = 0;
	try {
		const built = build();
		return [built, widened > 0];
	} finally {
		widened = was;
	}
}

/**
 * How many intersections have met a reference whose kinds are not known yet, as a part
 * or a member of one: a type built while it stays the same has none for `withRefKinds`
 * to build again.
 */
let metRefs = 0;

/** `metRefs`, read before and after a type is built. */
export const refsMet = (): number => metRefs;

const unkinded = (t: Ty): boolean => t.kind === "ref" && t.kinds === undefined;

const holdsRef = (t: Ty): boolean =>
	unkinded(t) || (t.kind === "union" && t.items.some(unkinded));

/**
 * Unions whose members are each of one kind meet kind by kind, the members of a kind
 * those of the others that it meets: `({ a?: A } | string) & ({ a: A } | { a?: never } | "")`
 * is `{ a: A } | { a?: never } | ""`. TypeScript does not read every type met with one of
 * another kind as `never`: `string & { a?: never }` admits every string. undefined where a
 * member is of no one kind, or none is a union.
 */
function meetByKind(items: Ty[]): Ty | undefined {
	if (!items.some((t) => t.kind === "union")) return undefined;
	// Each type's members, by kind in the order they come.
	const rows: Map<ValueKind, Ty[]>[] = [];
	for (const t of items) {
		const row = new Map<ValueKind, Ty[]>();
		for (const m of t.kind === "union" ? t.items : [t]) {
			const k = memberKinds(m);
			if (k?.length !== 1) return undefined;
			const kind = k[0] as ValueKind;
			const same = row.get(kind);
			if (same === undefined) row.set(kind, [m]);
			else same.push(m);
		}
		rows.push(row);
	}
	// Of kinds that all meet, each type is met as a whole.
	const kinds = new Set(rows.flatMap((row) => [...row.keys()]));
	if ([...kinds].every((a) => [...kinds].every((b) => meets(a, b))))
		return undefined;
	const [first, ...rest] = rows as [
		Map<ValueKind, Ty[]>,
		...Map<ValueKind, Ty[]>[],
	];
	// `integer` meets `number`: the whole numbers of a type of numbers.
	const meeting = (row: Map<ValueKind, Ty[]>, kind: ValueKind): Ty =>
		union([...row].flatMap(([k, ms]) => (meets(k, kind) ? ms : [])));
	return union(
		[...first].map(([kind, ms]) =>
			inter([union(ms), ...rest.map((row) => meeting(row, kind))]),
		),
	);
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
			props[i] = {
				...q,
				ty: inter([q.ty, p.ty]),
				optional: q.optional && p.optional,
				...(p.present ? { present: true } : {}),
				...(q.doc === undefined && p.doc !== undefined ? { doc: p.doc } : {}),
			};
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
export type ValueKind =
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
export function valueKind(t: Ty): ValueKind | undefined {
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
 * is some strings: it meets kinds as `string` does and stands for them,
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
		(kinds === undefined || ofKinds(kinds, m)) &&
		(!isLiteral(m) || literalSets.every((s) => s.has(valueKey(m)))) &&
		templates.every((t) =>
			admitsText(t, JSON.parse((m as { text: string }).text)),
		);
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

/** Whether a type of some strings admits a string: a template by its segments, a literal by its text. */
export function admitsText(t: Ty, s: string): boolean {
	const text = JSON.stringify(s);
	return (t.kind === "union" ? t.items : [t]).some((x) =>
		x.kind === "template"
			? inTemplate(x.seq, s)
			: x.kind === "lit" && x.text === text,
	);
}

/** A reference to a component schema. */
export type RefTy = Extract<Ty, { kind: "ref" }>;

export type TupleTy = Extract<Ty, { kind: "tuple" }>;

/**
 * How a tuple is written as the members of a union (see `emit`): its items up to the first
 * past `min` that admits no value, which ends the arrays, the rest where none does, and
 * `k`, where the items equal to the last (to the rest, where there is one) start, those
 * a closed tuple bounds by `length` and an open one leaves to the rest. The shorter
 * arrays are a tuple for each length from `min` to `k - 1`.
 */
export function tupleShape(t: TupleTy): {
	items: Ty[];
	rest: Ty | undefined;
	k: number;
} {
	const cut = t.items.findIndex(
		(item, i) => i >= t.min && item.kind === "never",
	);
	const items = cut === -1 ? t.items : t.items.slice(0, cut);
	const rest = cut === -1 ? t.rest : undefined;
	const last = rest ?? items[items.length - 1];
	let k = items.length;
	while (k > t.min && last !== undefined && equal(items[k - 1] as Ty, last))
		k--;
	return { items, rest, k };
}

/**
 * The items of the tuples a tuple is written with (`tupleShape`): one for each length from
 * `min` to `k`, where the equal items that end it start.
 */
export function writtenItems(t: TupleTy): number {
	const { k } = tupleShape(t);
	let n = 0;
	for (let length = t.min; length <= k; length++) n += length;
	return n;
}

/**
 * The kinds of value a type admits, where its form says so: `{ a: A }` objects,
 * `string | A[]` strings and arrays, a reference those `ref` gives it. `of` reads the
 * members of an intersection or union (`kindSet` remembers them).
 */
export function kindsWith(
	t: Ty,
	ref: (r: RefTy) => ValueKind[] | undefined,
	of: (u: Ty) => ValueKind[] | undefined = (u) => kindsWith(u, ref, of),
): ValueKind[] | undefined {
	if (t.kind === "inter") {
		// The kinds every member it says them of allows.
		const sets = t.items.map(of).filter((s) => s !== undefined);
		return sets.length === 0
			? undefined
			: sets.reduce((a, b) => a.filter((k) => b.some((o) => meets(k, o))));
	}
	if (t.kind === "ref") return ref(t);
	if (t.kind !== "union") return memberKinds(t);
	const kinds: ValueKind[] = [];
	for (const m of t.items) {
		const k = of(m);
		if (k === undefined) return undefined;
		kinds.push(...k);
	}
	return kinds;
}

/** `kindsWith`, a reference of the kinds it has (`withRefKinds`). */
const kindSet: (t: Ty) => ValueKind[] | undefined = remembered((t: Ty) =>
	kindsWith(
		t,
		(r) => r.kinds,
		(u) => kindSet(u),
	),
);

/** `kindSet` of a type that is no union. */
function memberKinds(m: Ty): ValueKind[] | undefined {
	if (m.kind === "inter" || m.kind === "ref") return kindSet(m);
	const k =
		kindsOf(m)?.[0] ??
		valueKind(m) ??
		(m.kind === "array"
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

/** The type for each kind of value, which `type` names. */
export const KIND_TY: Readonly<Record<ValueKind, Ty>> = {
	string: STRING,
	number: NUMBER,
	integer: INTEGER,
	boolean: BOOLEAN,
	null: NULL,
	object: RECORD,
	array: { kind: "array", elem: UNKNOWN },
};

/** Whether a `type` names a kind of value JSON Schema has. */
export const isValueKind = (k: unknown): k is ValueKind =>
	typeof k === "string" && Object.hasOwn(KIND_TY, k);

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

/**
 * A key literal types have alike where `equalValues` reads them as one value: a literal's
 * value, another type's structure.
 */
export const valueIdentity = (t: Ty): string =>
	t.kind === "lit" ? `lit${valueKey(t)}` : structure(t);

/** Whether two types of JSON values are the same value: literals by value (`1` and `1.0`), others by structure. */
export function equalValues(a: Ty, b: Ty): boolean {
	return a.kind === "lit" && b.kind === "lit"
		? valueKey(a) === valueKey(b)
		: equal(a, b);
}

/** The exact type of a JSON value: objects become object types with every key required, arrays become closed tuples. */
export function literal(v: Value): Ty {
	if (v === null) return NULL;
	if (Array.isArray(v)) return tuple(v.map(literal));
	if (v instanceof JsonObject) {
		// `{}` would admit any non-nullish value; an empty const object admits no keys.
		if (v.entries.length === 0) return { kind: "map", props: [], index: NEVER };
		return {
			kind: "object",
			props: v.entries.map(([k, x]) => prop(k, literal(x))),
		};
	}
	return lit(toJson(v as string | boolean | JsonNumber));
}

/**
 * Whether a value (`"a"`, `1.5`, `null`, an exact object) is of one of these kinds: a
 * whole number of `integer` too.
 */
export function ofKinds(kinds: readonly ValueKind[], m: Ty): boolean {
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
export function isWholeText(text: string): boolean {
	return !numberKey(text).includes("e-");
}
