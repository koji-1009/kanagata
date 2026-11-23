// The keys of an object that schemas name, require or admit, and those a view leaves out.
//
// The schemas that apply to the same value are one object: a closed one admits no key the
// others name (`closedKeys`, `outsideKeys`, `closedAmong`). A readOnly property is not
// sent and a writeOnly one is not returned (`isLeftOut`): a key one schema leaves out of a
// view stays out where another requires it (`leftOutKeys`, `leftOutTarget`).

import { get, JsonObject, type Value } from "./json.ts";
import type { Ctx } from "./pointer.ts";
import { onlyTarget, schema } from "./schema.ts";
import { inter, NEVER, type Prop, type Ty } from "./ty.ts";
import { unevaluated } from "./unevaluated.ts";

/**
 * The keys a closed object admits (`additionalProperties: false`, no
 * `patternProperties`): its declared properties. undefined when it is not closed.
 */
export function closedKeys(v: JsonObject): Set<string> | undefined {
	const ap =
		v.get("additionalProperties") ?? unevaluated(v, "unevaluatedProperties");
	if (ap !== false) return undefined;
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
	const uri = cx.ownResource(s);
	return uri === undefined
		? ownKeysOf(cx, s, seen, properties, everywhere)
		: cx.inResource(uri, () => ownKeysOf(cx, s, seen, properties, everywhere));
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
		const req = get(s, "required");
		if (Array.isArray(req))
			keys.push(...req.filter((n): n is string => typeof n === "string"));
		const props = get(s, "properties");
		if (properties && props instanceof JsonObject)
			keys.push(...props.entries.map(([k]) => k));
		const allOf = get(s, "allOf");
		const members = everywhere ? applied(s) : Array.isArray(allOf) ? allOf : [];
		for (const m of members)
			keys.push(...keysOf(cx, m, seen, properties, everywhere));
	}
	for (const target of cx.reached(s)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		keys.push(
			...cx.inTarget(target, () =>
				keysOf(cx, target.value, seen, properties, everywhere),
			),
		);
	}
	return keys;
}

/** The schemas that apply to the same value as a schema where they match: its members, `if` / `then` / `else` and dependent schemas. */
function applied(s: Value): Value[] {
	const out: Value[] = [];
	for (const key of ["allOf", "oneOf", "anyOf"]) {
		const members = get(s, key);
		if (Array.isArray(members)) out.push(...members);
	}
	for (const key of ["if", "then", "else"]) {
		const branch = get(s, key);
		if (branch !== undefined) out.push(branch);
	}
	const ds = get(s, "dependentSchemas");
	if (ds instanceof JsonObject) out.push(...ds.entries.map(([, d]) => d));
	return out;
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
 * `$dynamicRef` alone reaches (see `onlyTarget`).
 */
function closedMember(cx: Ctx, s: Value): Set<string> | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const target = onlyTarget(cx, s);
	if (target === undefined) return closedKeys(s);
	return target.value instanceof JsonObject
		? closedKeys(target.value)
		: undefined;
}

/** `dependentRequired`: each key and the keys it requires. */
export function dependencies(v: JsonObject): [string, string[]][] {
	const dr = v.get("dependentRequired");
	return (dr instanceof JsonObject ? dr.entries : []).map(([key, deps]) => [
		key,
		Array.isArray(deps)
			? deps.filter((d): d is string => typeof d === "string")
			: [],
	]);
}

/**
 * A `$ref`'s or `$dynamicRef`'s target written out without the keys the group leaves out
 * of this view, where it names one that it does not leave out itself: the reference's own
 * view would have it. Undefined where the reference stays.
 */
export function leftOutTarget(
	cx: Ctx,
	r: string,
	at: string,
	group: ReadonlySet<string>,
): Ty | undefined {
	if (group.size === 0) return undefined;
	const target = cx.locate(r, at);
	const { value, uri, where } = target;
	const named = cx.inTarget(target, () => namedKeys(cx, value));
	const own = cx.inTarget(target, () => leftOutKeys(cx, value));
	if (!named.some((k) => group.has(k) && !own.has(k)) || !cx.enter(uri))
		return undefined;
	try {
		return cx.inTarget(target, () =>
			cx.withLeftOut([value], group, () => schema(cx, value, where)),
		);
	} finally {
		cx.leave();
	}
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
	const props: Prop[] = keys.map((key) => ({ key, ty: NEVER, optional: true }));
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
	const uri = cx.ownResource(s);
	return uri === undefined
		? leftOutHere(cx, s, seen)
		: cx.inResource(uri, () => leftOutHere(cx, s, seen));
}

function leftOutHere(cx: Ctx, s: JsonObject, seen: Set<string>): boolean {
	// In 3.0 the keywords next to $ref are ignored; only the target counts.
	const ref = s.get("$ref");
	const siblings = cx.readsSiblings(s);
	if (
		siblings &&
		s.get(cx.mode === "write" ? "readOnly" : "writeOnly") === true
	)
		return true;
	for (const target of cx.reachedBy(
		s,
		typeof ref === "string" ? ref : undefined,
	)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		if (cx.inTarget(target, () => isLeftOut(cx, target.value, seen)))
			return true;
	}
	const allOf = s.get("allOf");
	return (
		siblings &&
		Array.isArray(allOf) &&
		allOf.some((m) => isLeftOut(cx, m, seen))
	);
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
	const uri = cx.ownResource(v);
	return uri === undefined
		? leftOutKeysHere(cx, v, seen, throughRef)
		: cx.inResource(uri, () => leftOutKeysHere(cx, v, seen, throughRef));
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
	const ref = get(v, "$ref");
	if (cx.readsSiblings(v)) {
		const props = get(v, "properties");
		if (props instanceof JsonObject)
			for (const [k, s] of props.entries) if (isLeftOut(cx, s)) keys.add(k);
		const allOf = get(v, "allOf");
		for (const m of Array.isArray(allOf) ? allOf : [])
			for (const k of leftOutKeys(cx, m, seen)) keys.add(k);
	}
	// Only an object has a reference.
	if (!throughRef || !(v instanceof JsonObject)) return keys;
	for (const target of cx.reachedBy(
		v,
		typeof ref === "string" ? ref : undefined,
	)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		for (const k of cx.inTarget(target, () =>
			leftOutKeys(cx, target.value, seen),
		))
			keys.add(k);
	}
	return keys;
}
