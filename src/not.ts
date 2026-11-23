// `not` and `if`: the values a schema leaves out or does not admit, where TypeScript can
// say them.
//
// TypeScript has no negated types: it says the values a schema does not admit only where
// they are of other kinds, objects without a key, arrays of other lengths, or literals of
// a list (`negation`, `refuted`, `excluded`). Whether a schema admits a literal is decided
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
	equalValues,
	inter,
	isValueKind,
	isWholeText,
	KIND_TY,
	literal,
	NEVER,
	ofKinds,
	present,
	type Ty,
	UNKNOWN,
	union,
	type ValueKind,
} from "./ty.ts";
import { asserted, assertions, isAnnotation } from "./vocab.ts";

/**
 * The values `not` leaves, where TypeScript can say them: none for a schema that admits
 * everything, the other kinds for `not: { type }`, the objects without a key for
 * `not: { required }`, and what X admits for `not: { not: X }`. undefined otherwise
 * (`not: false` leaves everything: unknown).
 */
export function negation(n: Value): Ty | undefined {
	if (n === false) return UNKNOWN;
	// true, and anything else read as a schema that admits every value.
	if (!(n instanceof JsonObject)) return NEVER;
	const keys = asserted(n);
	if (keys.length === 0) return NEVER;
	if (keys.length !== 1) return undefined;
	if (keys[0] === "type") return otherKinds(n.get("type"));
	if (keys[0] === "not") return admitted(n.get("not") as Value);
	const req = n.get("required");
	if (keys[0] === "required" && Array.isArray(req)) return lacking(req);
	return undefined;
}

/**
 * The values a schema admits, where its keywords say them exactly: every value for one
 * without keywords, none for `false`, and the values each of `type`, `required`, `enum`,
 * `const` and `not` (as `negation` reads it) admits. undefined for any other keyword.
 */
function admitted(s: Value): Ty | undefined {
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
		else if (k === "not") t = negation(x);
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

/** The objects without one of these keys. */
function lacking(names: Value[]): Ty {
	return union(stringsIn(names).map(absent));
}

/**
 * The values `if` does not admit, where TypeScript can say them: the other kinds for
 * `type`, the objects without a key for `required`, the shorter arrays for `minItems` and
 * the longer for `maxItems`, and for `properties` the objects with
 * a property it does not admit: of the other kinds for one with `type`, or of the values
 * the schemas `if` is in (`parents`: the schema and those around it) declare the property
 * with (`enum`, `const`) that it rejects. undefined for any other `if`.
 */
export function refuted(
	cx: Ctx,
	cond: Value,
	parents: Value[],
): Ty | undefined {
	if (cond === false) return UNKNOWN;
	if (!(cond instanceof JsonObject)) return NEVER;
	const terms: Ty[] = [];
	for (const [k, x] of cond.entries) {
		if (isAnnotation(k)) continue;
		if (k === "type") {
			const t = otherKinds(x);
			if (t === undefined) return undefined;
			terms.push(t);
		} else if (k === "required" && Array.isArray(x)) terms.push(lacking(x));
		else if (k === "minItems" || k === "maxItems") {
			// The arrays shorter or longer than it; a count that is none asks nothing.
			const n = count(cond, k);
			if (n !== undefined && k === "maxItems")
				terms.push({
					kind: "tuple",
					items: Array(n + 1).fill(UNKNOWN),
					min: n + 1,
					rest: UNKNOWN,
				});
			else if (n !== undefined && n > 0)
				terms.push({
					kind: "tuple",
					items: Array(n - 1).fill(UNKNOWN),
					min: 0,
				});
		} else if (k === "not") {
			const t = admitted(x);
			if (t === undefined) return undefined;
			terms.push(t);
		} else if (k === "properties" && x instanceof JsonObject) {
			for (const [p, s] of x.entries) {
				const t = rejected(cx, s, declared(cx, parents, p));
				if (t === undefined) return undefined;
				if (t.kind !== "never")
					terms.push({ kind: "object", props: [present(p, t)] });
			}
		} else return undefined;
	}
	return union(terms);
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
	return keys.length === 1 && (keys[0] === "type" || keys[0] === "not")
		? negation(s)
		: undefined;
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
			// In 3.0 the keywords next to $ref are ignored; only the target counts.
			if (cx.readsSiblings(s)) {
				meet(listed(cx, get(get(s, "properties"), key), new Set()));
				const allOf = get(s, "allOf");
				if (Array.isArray(allOf)) meet(declared(cx, allOf, key, seen));
			}
			for (const values of cx.eachTarget(s, seen, (t) =>
				declared(cx, [t.value], key, seen),
			))
				meet(values);
		});
	return out;
}

/** The values a schema lists (`enum`, `const`, `type: boolean` or `null`), through its `$ref` and `$dynamicRef`. */
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
		return ownValues(s);
	});
}

/** The values a schema itself lists. */
function ownValues(s: JsonObject): Value[] | undefined {
	const c = s.get("const");
	if (c !== undefined) return [c];
	const e = s.get("enum");
	if (Array.isArray(e)) return e;
	const t = s.get("type");
	if (t === "boolean") return [true, false];
	return t === "null" ? [null] : undefined;
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
function sameValue(a: Value, b: Value): boolean {
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
	const leaves = negation(contains);
	if (leaves !== undefined) return arrayTy(leaves);
	// negation reads every schema but an object.
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
 * `not` (`enum/0`, `const`); undefined for any other `not`. `not: { not: { not: X } }`
 * is `not: X`.
 */
export function excluded(v: JsonObject): { ty: Ty; at: string }[] | undefined {
	let n = v.get("not");
	let path = "";
	for (let x = notOnly(notOnly(n)); x !== undefined; x = notOnly(notOnly(n))) {
		n = x;
		path += "not/not/";
	}
	if (!(n instanceof JsonObject)) return undefined;
	const keys = asserted(n);
	if (keys.length !== 1) return undefined;
	const e = n.get("enum");
	if (keys[0] === "enum" && Array.isArray(e))
		return e.map((x, i) => ({ ty: literal(x), at: `${path}enum/${i}` }));
	const c = n.get("const");
	return keys[0] === "const" && c !== undefined
		? [{ ty: literal(c), at: `${path}const` }]
		: undefined;
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
