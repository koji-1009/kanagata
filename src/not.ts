// `not` and `if`: the values a schema leaves out or does not admit, where TypeScript can
// say them.
//
// TypeScript has no negated types: it says the values a schema does not admit only where
// they are of other kinds, objects without a key, arrays of other lengths, or literals of
// a list (`refuted`, `excluded`). Whether a schema admits a literal is decided
// by its keywords where they say (`accepts`).

import {
	get,
	JsonNumber,
	JsonObject,
	jsonKind,
	stringsIn,
	type Value,
} from "./json.ts";
import { admitting, count } from "./number.ts";
import type { Ctx } from "./pointer.ts";
import {
	absent,
	array as arrayTy,
	BOOLEAN,
	equalValues,
	inter,
	isValueKind,
	isWholeText,
	KIND_TY,
	literal,
	MAX_ITEMS,
	NEVER,
	NULL,
	NUMBER,
	ofKinds,
	present,
	STRING,
	type Ty,
	UNKNOWN,
	union,
	type ValueKind,
} from "./ty.ts";
import { asserted, assertions, isAnnotation, REFS } from "./vocab.ts";

/**
 * The values a schema admits, where its keywords say them exactly: every value for one
 * without keywords, none for `false`, and the values each of `type`, `required`, `enum`,
 * `const` and `not` (as `refuted` reads it) admits. undefined for any other keyword.
 */
function admitted(cx: Ctx, s: Value, parents: Value[]): Ty | undefined {
	if (s === false) return NEVER;
	if (!(s instanceof JsonObject)) return UNKNOWN;
	const parts: Ty[] = [];
	for (const [k, x] of s.entries) {
		if (isAnnotation(k)) continue;
		let t: Ty | undefined;
		if (k === "type")
			// A type JSON Schema does not have says nothing.
			t = union(
				(Array.isArray(x) ? x : [x]).map((n) =>
					isValueKind(n) ? KIND_TY[n] : UNKNOWN,
				),
			);
		else if (k === "required" && Array.isArray(x))
			// Values of the other kinds pass required.
			t = union([
				otherKinds("object") as Ty,
				{
					kind: "object",
					props: stringsIn(x).map((key) => present(key, UNKNOWN)),
				},
			]);
		else if (k === "enum" && Array.isArray(x)) t = union(x.map(literal));
		else if (k === "const") t = literal(x);
		else if (k === "not") t = refuted(cx, x, parents);
		if (t === undefined) return undefined;
		parts.push(t);
	}
	return inter(parts);
}

/**
 * The values of the kinds `type` does not name: none where it names one JSON Schema does
 * not have, which says nothing; undefined for `integer` without `number`.
 */
function otherKinds(t: Value | undefined): Ty | undefined {
	const named = Array.isArray(t) ? t : [t];
	if (!named.every(isValueKind)) return NEVER;
	// Without number, an integer is a number TypeScript cannot leave out.
	if (named.includes("integer") && !named.includes("number")) return undefined;
	const kinds: ValueKind[] = [
		"string",
		"number",
		"boolean",
		"null",
		"array",
		"object",
	];
	return union(kinds.filter((k) => !named.includes(k)).map((k) => KIND_TY[k]));
}

/**
 * The values a list of them leaves, where they are of kinds TypeScript lists every value
 * of: `null`, and booleans (the one not listed); the other kinds whole. undefined where a
 * value is of another kind, which no type leaves out of its kind.
 */
function unlisted(values: Value[]): Ty | undefined {
	if (!values.every((x) => x === null || typeof x === "boolean"))
		return undefined;
	const has = (x: Value) => values.some((y) => y === x);
	const booleans = [true, false].filter((b) => !has(b));
	return union([
		STRING,
		NUMBER,
		...(booleans.length === 2 ? [BOOLEAN] : booleans.map(literal)),
		...(has(null) ? [] : [NULL]),
		KIND_TY.array,
		KIND_TY.object,
	]);
}

/** The objects without one of these keys. */
function lacking(names: Value[]): Ty {
	return union(stringsIn(names).map(absent));
}

/**
 * Whether the arrays a `minItems` / `maxItems` of `n` leaves out (the shorter, the
 * longer) take a tuple of more items than kanagata writes: then they are any array.
 */
export const refutedPast = (k: string, n: number): boolean =>
	(k === "maxItems" ? n + 1 : n - 1) > MAX_ITEMS;

/**
 * The values a schema does not admit (those `not` leaves, those `if` refutes), where
 * TypeScript can say them: every value for `false`, none for a schema without keywords,
 * and otherwise what any of its keywords leaves: the other kinds for `type`, the objects
 * without a key for `required`, the shorter arrays for `minItems` and the longer for
 * `maxItems`, what X admits for `not: X`, for `properties` the objects with a property it
 * does not admit (`rejected`), what one member leaves for `allOf`, what every member
 * leaves for `anyOf`, and for `oneOf` that or what two members admit; what the schemas a
 * `$ref` or `$dynamicRef` reaches leave. `parents` are the schemas that read the same
 * value (the schema `not` or `if` is in, and those around it), which declare the values
 * of its properties. undefined where a keyword's are not said. Arrays of more items than
 * kanagata writes a tuple of are any array (`refutedPast`).
 */
export function refuted(
	cx: Ctx,
	cond: Value,
	parents: Value[],
	seen: ReadonlySet<string> = new Set(),
): Ty | undefined {
	if (cond === false) return UNKNOWN;
	// true, and anything else read as a schema that admits every value.
	if (!(cond instanceof JsonObject)) return NEVER;
	return cx.inOwnResource(cond, () => {
		// One reached again on the way to it is not said.
		const terms = [
			...cx.pathTargets(
				cond,
				seen,
				(t, path) => refuted(cx, t.value, parents, path),
				undefined,
			),
		];
		if (cx.readsSiblings(cond))
			for (const [k, x] of cond.entries)
				if (!isAnnotation(k) && !REFS.has(k))
					terms.push(leaves(cx, cond, k, x, parents, seen));
		return terms.every((t) => t !== undefined) ? union(terms) : undefined;
	});
}

/** What one keyword of a schema leaves (see `refuted`), where it is said. */
function leaves(
	cx: Ctx,
	s: JsonObject,
	k: string,
	x: Value,
	parents: Value[],
	seen: ReadonlySet<string>,
): Ty | undefined {
	if (k === "type") return otherKinds(x);
	if (k === "required" && Array.isArray(x)) return lacking(x);
	if (k === "minItems" || k === "maxItems") {
		// The arrays shorter or longer than it; a count that is none asks nothing.
		const n = count(s, k);
		if (n !== undefined && refutedPast(k, n)) return arrayTy(UNKNOWN);
		if (n !== undefined && k === "maxItems")
			return {
				kind: "tuple",
				items: Array(n + 1).fill(UNKNOWN),
				min: n + 1,
				rest: UNKNOWN,
			};
		return n !== undefined && n > 0
			? { kind: "tuple", items: Array(n - 1).fill(UNKNOWN), min: 0 }
			: NEVER;
	}
	if (k === "not") return admitted(cx, x, parents);
	if (k === "const") return unlisted([x]);
	if (k === "enum" && Array.isArray(x)) return unlisted(x);
	if (k === "properties" && x instanceof JsonObject) {
		const terms: Ty[] = [];
		for (const [p, ps] of x.entries) {
			const t = rejected(cx, ps, declared(cx, parents, p));
			if (t === undefined) return undefined;
			if (t.kind !== "never")
				terms.push({ kind: "object", props: [present(p, t)] });
		}
		return union(terms);
	}
	if ((k === "allOf" || k === "anyOf" || k === "oneOf") && Array.isArray(x)) {
		const each = x.map((m) => refuted(cx, m, parents, seen));
		if (!each.every((t) => t !== undefined)) return undefined;
		if (k === "allOf") return union(each);
		// A value fails anyOf where it fails every member, and oneOf there too, or where two admit it.
		if (k === "anyOf") return inter(each);
		const admits = x.map((m) => admitted(cx, m, parents));
		if (!admits.every((t) => t !== undefined)) return undefined;
		const both = admits.flatMap((a, i) =>
			admits.slice(i + 1).map((b) => inter([a, b])),
		);
		return union([inter(each), ...both]);
	}
	return undefined;
}

/** The values a property schema rejects among those it can be, where TypeScript can say them. */
function rejected(
	cx: Ctx,
	s: Value,
	values: Value[] | undefined,
): Ty | undefined {
	if (s === false) return UNKNOWN;
	if (!(s instanceof JsonObject)) return NEVER;
	const keys = asserted(s);
	if (keys.length === 0) return NEVER;
	if (values !== undefined) {
		const verdicts = values.map((x) => accepts(cx, s, x));
		if (verdicts.every((a) => a !== undefined))
			return union(values.filter((_, i) => !verdicts[i]).map(literal));
	}
	return refuted(cx, s, []);
}

/**
 * The values a property can have, where the schemas say a list of them (`enum`, `const`,
 * `type: boolean`): in these schemas, the `$ref`s they have and their `allOf` members.
 * undefined where none does.
 */
function declared(
	cx: Ctx,
	schemas: Value[],
	key: string,
	seen = new Set<string>(),
): Value[] | undefined {
	let out: Value[] | undefined;
	const meet = (values: Value[] | undefined) => {
		if (values === undefined) return;
		out =
			out === undefined
				? values
				: out.filter((x) => values.some((y) => sameValue(x, y)));
	};
	for (const s of schemas)
		cx.inOwnResource(s, () => {
			// Only `if` asks (3.1 and later), so the keywords next to a $ref are read.
			meet(listed(cx, get(get(s, "properties"), key), new Set()));
			const allOf = get(s, "allOf");
			if (Array.isArray(allOf)) meet(declared(cx, allOf, key, seen));
			for (const values of cx.eachTarget(s, seen, (t) =>
				declared(cx, [t.value], key, seen),
			))
				meet(values);
		});
	return out;
}

/**
 * The values a schema lists (`enum`, `const`, a `type` of `boolean` and `null` only), through
 * its `$ref` and `$dynamicRef`, or those its `oneOf` / `anyOf` members all list together
 * (`oneOf: [{ const: a, description }, …]`): a list every value it admits is in.
 */
export function listed(
	cx: Ctx,
	s: Value | undefined,
	seen: Set<string>,
): Value[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	return cx.inOwnResource(s, () => {
		for (const values of cx.eachTarget(s, seen, (t) =>
			listed(cx, t.value, seen),
		))
			if (values !== undefined) return values;
		const own = ownValues(s);
		if (own !== undefined) return own;
		for (const key of ["oneOf", "anyOf"]) {
			const members = s.get(key);
			if (!Array.isArray(members)) continue;
			const each = members.map((m) => listed(cx, m, seen));
			if (each.every((v) => v !== undefined)) return each.flat();
		}
		return undefined;
	});
}

/** The values a schema itself lists. */
function ownValues(s: JsonObject): Value[] | undefined {
	const c = s.get("const");
	if (c !== undefined) return [c];
	const e = s.get("enum");
	if (Array.isArray(e)) return e;
	const t = s.get("type");
	const named = Array.isArray(t) ? t : [t];
	return named.every((n) => n === "boolean" || n === "null")
		? named.flatMap((n) => (n === "boolean" ? [true, false] : [null]))
		: undefined;
}

/** Keywords `accepts` decides for a literal value (see `admitting`). */
const VALUE_KEYWORDS = new Set([
	...assertions("string"),
	...assertions("number"),
]);

/** Whether a schema admits a value; undefined where it says what this cannot decide. */
export function accepts(cx: Ctx, s: JsonObject, x: Value): boolean | undefined {
	const t = literal(x);
	for (const [k, y] of s.entries) {
		if (isAnnotation(k) || VALUE_KEYWORDS.has(k)) continue;
		if (k === "type") {
			const named = Array.isArray(y) ? y : [y];
			if (!named.some((n) => typeof n === "string" && isOfKind(x, n)))
				return false;
		} else if (k === "const") {
			if (!sameValue(x, y)) return false;
		} else if (k === "enum" && Array.isArray(y)) {
			if (!y.some((e) => sameValue(x, e))) return false;
		} else if (k === "not" && notOnly(y) instanceof JsonObject) {
			// not: { not: X } admits what X admits.
			const a = accepts(cx, notOnly(y) as JsonObject, x);
			if (a !== true) return a;
		} else return undefined;
	}
	return admitting(cx, s)(t);
}

/** Whether a JSON value is of a kind `type` names. */
function isOfKind(x: Value, kind: string): boolean {
	return (
		jsonKind(x) === kind ||
		(kind === "integer" && x instanceof JsonNumber && isWholeText(x.text))
	);
}

/** Whether two JSON values are equal, numbers by value. */
export function sameValue(a: Value, b: Value): boolean {
	return equalValues(literal(a), literal(b));
}

/**
 * The arrays none of whose items `contains` admits, where TypeScript can say it: of the
 * values `not` would leave, or, where `items` lists the values, of those `contains` rejects
 * past any `prefixItems` (whose items need not be values `items` lists). undefined where
 * it cannot tell.
 */
export function notContained(
	cx: Ctx,
	v: JsonObject,
	contains: Value,
): Ty | undefined {
	const left = refuted(cx, contains, []);
	if (left !== undefined) return arrayTy(left);
	// refuted reads every schema but an object.
	const s = contains as JsonObject;
	const values = listed(cx, v.get("items"), new Set());
	if (values === undefined) return undefined;
	const admitted = values.map((x) => accepts(cx, s, x));
	if (admitted.includes(undefined)) return undefined;
	const rest = union(
		values.filter((_, i) => admitted[i] === false).map(literal),
	);
	const prefix = v.get("prefixItems");
	return Array.isArray(prefix)
		? { kind: "tuple", items: prefix.map(() => UNKNOWN), min: 0, rest }
		: arrayTy(rest);
}

/**
 * The values `not: { enum }` or `not: { const }` leave out, each with where it is in
 * `not` (`enum/0`, `const`): those it lists that its keywords admit, where they decide
 * each (`accepts`; `not: { const: a, type: string }`). undefined for any other `not`.
 * `not: { not: { not: X } }` is `not: X`.
 */
export function excluded(
	cx: Ctx,
	v: JsonObject,
): { ty: Ty; at: string }[] | undefined {
	let n = v.get("not");
	let path = "";
	for (let x = notOnly(notOnly(n)); x !== undefined; x = notOnly(notOnly(n))) {
		n = x;
		path += "not/not/";
	}
	if (!(n instanceof JsonObject)) return undefined;
	const c = n.get("const");
	const e = n.get("enum");
	const values: [Value, string][] | undefined =
		c !== undefined
			? [[c, "const"]]
			: Array.isArray(e)
				? e.map((x, i) => [x, `enum/${i}`])
				: undefined;
	if (values === undefined) return undefined;
	const out: { ty: Ty; at: string }[] = [];
	for (const [x, at] of values) {
		const a = accepts(cx, n, x);
		if (a === undefined) return undefined;
		if (a) out.push({ ty: literal(x), at: `${path}${at}` });
	}
	return out;
}

/** X for a schema that has no keyword but `not: X`; undefined for any other. */
function notOnly(s: Value | undefined): Value | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const keys = asserted(s);
	return keys.length === 1 && keys[0] === "not" ? s.get("not") : undefined;
}

/** Whether a type may admit a value (from `const` / `enum`) other than by listing it. */
export function mayAdmit(m: Ty, x: Ty): boolean {
	const of = (kinds: string[], t: Ty) => kinds.includes(t.kind);
	const objects = ["object", "map", "record"];
	if (of(["lit", "null", "blob"], m)) return false;
	// A primitive admits the values of its kind.
	if (of(["string", "number", "integer", "boolean"], m))
		return ofKinds([m.kind as ValueKind], x);
	if (of(objects, m)) return of(objects, x);
	if (of(["array", "tuple"], m)) return x.kind === "tuple";
	return true;
}
