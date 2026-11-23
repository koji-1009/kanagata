// The keys of an object that schemas name, require or admit, and those a view leaves out.
//
// The schemas that apply to the same value are one object: a closed one admits no key the
// others name (`closedKeys`, `outsideKeys`, `closedAmong`). A readOnly property is not
// sent and a writeOnly one is not returned (`isLeftOut`): a key one schema leaves out of a
// view stays out where another requires it (`leftOutKeys`, `leftOutGroup`).

import { get, JsonObject, stringsIn, type Value } from "./json.ts";
import type { Ctx } from "./pointer.ts";
import { inter, neverProp, type Ty } from "./ty.ts";
import { additional } from "./unevaluated.ts";
import { branches, members } from "./vocab.ts";

/**
 * The keys a closed object admits (`additionalProperties: false`, no
 * `patternProperties`): its declared properties. undefined when it is not closed.
 */
export function closedKeys(v: JsonObject): Set<string> | undefined {
	if (additional(v)?.value !== false) return undefined;
	if (v.get("patternProperties") !== undefined) return undefined;
	const props = v.get("properties");
	return new Set(
		props instanceof JsonObject ? props.entries.map(([k]) => k) : [],
	);
}

/**
 * The keys a schema requires: its own `required`, and those of the schemas its `$ref`
 * and `$dynamicRef` reach and of its `allOf` members.
 */
export function requiredKeys(
	cx: Ctx,
	s: Value,
	seen = new Set<string>(),
): string[] {
	return keysOf(cx, s, seen, false);
}

/** The keys a schema names, as properties or as required, there or through `$ref`, `$dynamicRef` and `allOf`. */
export function namedKeys(
	cx: Ctx,
	s: Value,
	seen = new Set<string>(),
): string[] {
	return keysOf(cx, s, seen, true);
}

/**
 * The keys the schemas that apply to the value a schema is name, as properties or as
 * required: there, through `$ref`, and in its members, `if` / `then` / `else` and dependent
 * schemas, wherever they match.
 */
export function valueKeys(cx: Ctx, s: Value): string[] {
	return keysOf(cx, s, new Set(), true, true);
}

function keysOf(
	cx: Ctx,
	s: Value,
	seen: Set<string>,
	properties: boolean,
	everywhere = false,
): string[] {
	return cx.inOwnResource(s, () =>
		ownKeysOf(cx, s, seen, properties, everywhere),
	);
}

function ownKeysOf(
	cx: Ctx,
	s: Value,
	seen: Set<string>,
	properties: boolean,
	everywhere: boolean,
): string[] {
	const keys: string[] = [];
	// In 3.0 the keywords next to $ref are ignored; only the target counts.
	if (cx.readsSiblings(s)) {
		keys.push(...stringsIn(get(s, "required")));
		const props = get(s, "properties");
		if (properties && props instanceof JsonObject)
			keys.push(...props.entries.map(([k]) => k));
		const allOf = get(s, "allOf");
		const members = everywhere ? applied(s) : Array.isArray(allOf) ? allOf : [];
		for (const m of members)
			keys.push(...keysOf(cx, m, seen, properties, everywhere));
	}
	for (const reached of cx.eachTarget(s, seen, (t) =>
		keysOf(cx, t.value, seen, properties, everywhere),
	))
		keys.push(...reached);
	return keys;
}

/** The schemas that apply to the same value as a schema where they match: its members, `if` / `then` / `else` and dependent schemas. */
function applied(s: Value): Value[] {
	const ds = get(s, "dependentSchemas");
	return [
		...members(s),
		...branches(s),
		...(ds instanceof JsonObject ? ds.entries.map(([, d]) => d) : []),
	];
}

/**
 * The keys the schemas that apply to the same value as a closed object name (its `$ref`
 * and `$dynamicRef` targets in 3.1 and 3.2, members, `if` / `then` / `else`, dependent
 * schemas) that it does not declare: it admits none of them.
 */
export function outsideKeys(
	cx: Ctx,
	v: JsonObject,
	closed: Set<string>,
): string[] {
	return [...new Set(valueKeys(cx, v))].filter((k) => !closed.has(k));
}

/**
 * The keys a closed member admits: its own, or those of the closed schema its `$ref` or
 * `$dynamicRef` alone reaches (see `Ctx.onlyTarget`), through any number of them. One reached
 * again on the way (`seen`), which is an error, is not closed.
 */
function closedMember(
	cx: Ctx,
	s: Value,
	seen = new Set<string>(),
): Set<string> | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const target = cx.onlyTarget(s);
	if (target === undefined) return closedKeys(s);
	if (seen.has(target.uri)) return undefined;
	seen.add(target.uri);
	return cx.inTarget(target, () => closedMember(cx, target.value, seen));
}

/** `dependentRequired`: each key and the keys it requires. */
export function dependencies(v: JsonObject): [string, string[]][] {
	const dr = v.get("dependentRequired");
	return (dr instanceof JsonObject ? dr.entries : []).map(([key, deps]) => [
		key,
		stringsIn(deps),
	]);
}

/** A closed oneOf / anyOf member admits no key another member names. */
export function closedAmong(cx: Ctx, members: Value[], tys: Ty[]): Ty[] {
	const named = members.map((m) => namedKeys(cx, m));
	return tys.map((t, i) => {
		const keys = closedMember(cx, members[i] as Value);
		if (keys === undefined || keys.size === 0) return t;
		const others = named.flatMap((n, j) => (j === i ? [] : n));
		return forbid(
			t,
			[...new Set(others)].filter((k) => !keys.has(k)),
		);
	});
}

/** `t` without these keys: `k?: never`, in its own object type where it is one. */
export function forbid(t: Ty, keys: string[]): Ty {
	if (keys.length === 0) return t;
	const props = keys.map(neverProp);
	if (t.kind !== "object") return inter([t, { kind: "object", props }]);
	const have = new Set(t.props.map((p) => p.key));
	return {
		kind: "object",
		props: [...t.props, ...props.filter((p) => !have.has(p.key))],
	};
}

/**
 * A readOnly property is not sent and a writeOnly one is not returned, even when
 * required. The keyword counts on the property schema, or on a schema it reaches
 * through `$ref`, `$dynamicRef` or an `allOf` member (`{ allOf: [{ $ref }], description }`).
 */
function isLeftOut(cx: Ctx, s: Value, seen = new Set<string>()): boolean {
	if (!(s instanceof JsonObject)) return false;
	return cx.inOwnResource(s, () => leftOutHere(cx, s, seen));
}

function leftOutHere(cx: Ctx, s: JsonObject, seen: Set<string>): boolean {
	// In 3.0 the keywords next to $ref are ignored; only the target counts.
	const siblings = cx.readsSiblings(s);
	if (
		siblings &&
		s.get(cx.mode === "write" ? "readOnly" : "writeOnly") === true
	)
		return true;
	if (cx.eachTarget(s, seen, (t) => isLeftOut(cx, t.value, seen)).some(Boolean))
		return true;
	const allOf = s.get("allOf");
	return (
		siblings &&
		Array.isArray(allOf) &&
		allOf.some((m) => isLeftOut(cx, m, seen))
	);
}

/**
 * The properties left out of this view of the value a schema is: its own (`leftOutKeys`,
 * through its references unless `throughRef` is false), and those the other members of the
 * `allOf` it is in leave out (`Ctx.leftOutIn`). Every member is the same object: a property
 * one leaves out stays out where another lists it as required.
 */
export function leftOutGroup(
	cx: Ctx,
	v: Value,
	throughRef = true,
): Set<string> {
	const keys = leftOutKeys(cx, v, new Set(), throughRef);
	for (const k of cx.leftOutIn(v)) keys.add(k);
	return keys;
}

/**
 * The properties left out of this view: the schema's own, and those of its `allOf`
 * members, so that `required` next to `allOf` does not bring one back, and of its `$ref`
 * and `$dynamicRef` targets unless `throughRef` is false.
 */
export function leftOutKeys(
	cx: Ctx,
	v: Value,
	seen = new Set<string>(),
	throughRef = true,
): Set<string> {
	return cx.inOwnResource(v, () => leftOutKeysHere(cx, v, seen, throughRef));
}

function leftOutKeysHere(
	cx: Ctx,
	v: Value,
	seen: Set<string>,
	throughRef: boolean,
): Set<string> {
	const keys = new Set<string>();
	// In 3.0 the keywords next to $ref are ignored; in 3.1 and 3.2 they and the target
	// are one schema.
	if (cx.readsSiblings(v)) {
		const props = get(v, "properties");
		if (props instanceof JsonObject)
			for (const [k, s] of props.entries) if (isLeftOut(cx, s)) keys.add(k);
		const allOf = get(v, "allOf");
		for (const m of Array.isArray(allOf) ? allOf : [])
			for (const k of leftOutKeys(cx, m, seen)) keys.add(k);
	}
	if (!throughRef) return keys;
	for (const reached of cx.eachTarget(v, seen, (t) =>
		leftOutKeys(cx, t.value, seen),
	))
		for (const k of reached) keys.add(k);
	return keys;
}
