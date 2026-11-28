// `oneOf`: a value only one member admits.
//
// A TypeScript union admits a value any member admits. Where TypeScript can say what a
// member does not admit, each member leaves out what another admits too: a literal or
// `null` two members list (`shared`), and among members that ask only for keys, the
// objects with all of another's (`exclusive`).

import { get, JsonObject, parse, stringsIn, type Value } from "./json.ts";
import { accepts, sameValue } from "./not.ts";
import type { Ctx } from "./pointer.ts";
import {
	absent,
	inter,
	literal,
	NEVER,
	type Prop,
	type Ty,
	UNKNOWN,
	union,
} from "./ty.ts";
import { asserted, isAnnotation, REFS, refsAndAnnotations } from "./vocab.ts";

/**
 * oneOf admits a value only one member admits, so a literal or `null` two members
 * admit is in neither. It is left out of the members that list it; one that admits it
 * by its kind (`string` for `"a"`) keeps it in their union, as TypeScript cannot leave
 * it out of that; `boolean` is `true | false`, which it can. A member counts a value
 * only where its schema (of `schemas`) says it admits it (`accepts`): its type admits
 * more where TypeScript cannot say what a keyword leaves out (an `if` it ignores).
 * Other members, refs among them, are not counted.
 */
export function shared(cx: Ctx, schemas: Value[], tys: Ty[]): Ty[] {
	const listed = (t: Ty): Ty[] => (t.kind === "union" ? t.items : [t]);
	// A literal or null by its text, so that each is counted once per member.
	const key = (m: Ty): string | undefined =>
		m.kind === "null" ? "null" : m.kind === "lit" ? `lit:${m.text}` : undefined;
	const values = tys
		.flatMap(listed)
		.filter((m) => m.kind === "lit" || m.kind === "null");
	const members = tys.map((t) => booleansListed(listed(t), values));
	// The members that list each value, and of those listed by two, the members whose
	// schema admits it.
	const count = (admitted: (i: number, m: Ty) => boolean) => {
		const counts = new Map<string, number>();
		for (const [i, ms] of members.entries())
			for (const [k, m] of new Map(ms.map((m) => [key(m), m])))
				if (k !== undefined && admitted(i, m))
					counts.set(k, (counts.get(k) ?? 0) + 1);
		return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
	};
	const listedTwice = count(() => true);
	if (listedTwice.size === 0) return tys;
	const drop = count((i, m) => {
		if (!listedTwice.has(key(m) as string)) return false;
		const s = schemas[i];
		const x = m.kind === "lit" ? parse(m.text) : null;
		return s instanceof JsonObject && accepts(cx, s, x) === true;
	});
	if (drop.size === 0) return tys;
	return members.map((ms) =>
		union(ms.filter((m) => !drop.has(key(m) as string))),
	);
}

/** `members`, `boolean` among them as `true` and `false` where `values` has one of them: TypeScript can leave either out. */
export function booleansListed(members: Ty[], values: readonly Ty[]): Ty[] {
	const isBoolean = (t: Ty) =>
		t.kind === "lit" && (t.text === "true" || t.text === "false");
	if (!values.some(isBoolean)) return members;
	return members.flatMap((m) =>
		m.kind === "boolean" ? [literal(true), literal(false)] : [m],
	);
}

/**
 * oneOf admits a value only one member admits. A member that asks nothing but some
 * keys (`{ required: [a] }`) does not admit exactly the objects without one of them.
 * So among such members, each lacks one of the keys each other requires: `b?: never`,
 * or `({ b?: never } | { c?: never })` for `required: [b, c]`, with `b?: unknown;
 * c?: unknown` so that an object literal with one of them is not excess. One that has
 * all of another's keys admits nothing. Other members stay as they are: TypeScript
 * cannot say what they do not admit. `declared` is the `properties` of the schema the
 * `oneOf` is in.
 */
export function exclusive(
	cx: Ctx,
	members: Value[],
	tys: Ty[],
	left: ReadonlySet<string>,
	declared: Value | undefined,
): Ty[] {
	// A key left out of this view is required on the other side only.
	const keys = members.map((m) =>
		keysOnly(cx, m, undefined, declared)?.filter((k) => !left.has(k)),
	);
	const without = (key: string, ty: Ty): Prop => ({ key, ty, optional: true });
	return tys.map((t, i) => {
		const own = keys[i];
		if (own === undefined) return t;
		// Each key another member requires: never here, or unknown where only one of several must lack.
		const others = new Map<string, Ty>();
		const either: Ty[] = [];
		const missing = keys.flatMap((other, j) =>
			j === i || other === undefined
				? []
				: [other.filter((k) => !own.includes(k))],
		);
		if (missing.some((m) => m.length === 0)) return NEVER;
		for (const m of missing)
			if (m.length === 1) others.set(m[0] as string, NEVER);
		for (const m of missing) {
			// It lacks one of them already where it lacks a key alone.
			if (m.some((k) => others.get(k) === NEVER)) continue;
			for (const k of m) if (!others.has(k)) others.set(k, UNKNOWN);
			either.push(union(m.map(absent)));
		}
		if (others.size === 0) return t;
		const props = [...others].map(([k, ty]) => without(k, ty));
		return inter([t, { kind: "object", props }, ...either]);
	});
}

/**
 * The keys a schema requires, when that is all it asks of an object: `required` (none
 * for an empty one), `type: object` and properties that admit any value or, in the
 * member itself, restate the property `declared` beside the `oneOf`, with annotations, an
 * object with one of them at least (none where `required` is absent); a `$ref` or
 * `$dynamicRef`, with annotations at most, to such a schema (see `Ctx.onlyTarget`); or in
 * 3.1 and 3.2, such keywords next to references to such schemas, which require their keys
 * too. One reached again on the way (`seen`), which is an error, is none.
 */
function keysOnly(
	cx: Ctx,
	s: Value,
	seen: ReadonlySet<string> = new Set(),
	declared?: Value,
): string[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	// The keys each reference's target requires; undefined where one requires more, or is
	// reached again on the way.
	const reached = (): string[] | undefined => {
		const each = cx.pathTargets(
			s,
			seen,
			(t, path) => keysOnly(cx, t.value, path),
			undefined,
		);
		return each.includes(undefined) ? undefined : (each as string[][]).flat();
	};
	// In 3.0 the keywords next to $ref are ignored.
	if (cx.onlyTarget(s) !== undefined) return reached();
	const allowed = s.entries.every(
		([k, x]) =>
			REFS.has(k) ||
			k === "required" ||
			isAnnotation(k) ||
			(k === "type" && x === "object") ||
			(k === "properties" &&
				x instanceof JsonObject &&
				x.entries.every(
					([key, ps]) =>
						admitsAnyValue(cx, ps) || restates(ps, get(declared, key)),
				)),
	);
	const keys = allowed ? reached() : undefined;
	// Annotations alone admit every value, not only objects.
	const object =
		cx.reached(s).length > 0 ||
		["required", "type", "properties"].some((k) => s.get(k) !== undefined);
	if (keys === undefined || !object) return undefined;
	const own = stringsIn(s.get("required"));
	// A key the target and the keywords next to it both require is one key.
	return [...new Set([...keys, ...own])];
}

/**
 * Whether a property schema of a `oneOf` member asks nothing its declaration beside the
 * `oneOf` (`declared`) does not: it has the same keywords with equal values, annotations
 * aside. Both are in the same schema resource, so equal references reach the same schema.
 * Fewer keywords may ask more, as `additionalProperties: false` without `properties`.
 */
function restates(s: Value, declared: Value | undefined): boolean {
	if (!(s instanceof JsonObject && declared instanceof JsonObject))
		return false;
	const within = (a: JsonObject, b: JsonObject) =>
		asserted(a).every((k) => {
			const x = b.get(k);
			return x !== undefined && sameValue(a.get(k) as Value, x);
		});
	return within(s, declared) && within(declared, s);
}

/**
 * Whether a schema admits every value: `true`, annotations alone, or a `$ref` or
 * `$dynamicRef` to such a schema next to them (next to anything, for a 3.0 `$ref`). A
 * schema reached again on the way (`seen`), which is an error, is not one.
 */
function admitsAnyValue(
	cx: Ctx,
	s: Value,
	seen: ReadonlySet<string> = new Set(),
): boolean {
	if (s === true) return true;
	if (!(s instanceof JsonObject)) return false;
	if (cx.readsSiblings(s) && !refsAndAnnotations(s)) return false;
	return cx
		.pathTargets(s, seen, (t, path) => admitsAnyValue(cx, t.value, path), false)
		.every(Boolean);
}
