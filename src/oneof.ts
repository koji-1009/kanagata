// `oneOf`: a value only one member admits.
//
// A TypeScript union admits a value any member admits. Where TypeScript can say what a
// member does not admit, each member leaves out what another admits too: a literal or
// `null` two members list (`shared`), and among members that ask only for keys, the
// objects with all of another's (`exclusive`).

import { JsonObject, type Value } from "./json.ts";
import type { Ctx, Located } from "./pointer.ts";
import { isAnnotation, literal, onlyTarget, REFS } from "./schema.ts";
import { inter, NEVER, type Prop, type Ty, UNKNOWN, union } from "./ty.ts";

/**
 * oneOf admits a value only one member admits, so a literal or `null` two members
 * admit is in neither. It is left out of the members that list it; one that admits it
 * by its kind (`string` for `"a"`) keeps it in their union, as TypeScript cannot leave
 * it out of that; `boolean` is `true | false`, which it can. Other members, refs among
 * them, are not counted.
 */
export function shared(tys: Ty[]): Ty[] {
	const listed = (t: Ty): Ty[] => (t.kind === "union" ? t.items : [t]);
	const same = (a: Ty, b: Ty) =>
		a.kind === b.kind &&
		(a.kind !== "lit" || a.text === (b as { text: string }).text);
	const values = tys
		.flatMap(listed)
		.filter((m) => m.kind === "lit" || m.kind === "null");
	const members = tys.map((t) => booleansListed(listed(t), values));
	const out = new Set<Ty>();
	for (const value of values) {
		if (members.filter((ms) => ms.some((m) => same(m, value))).length > 1)
			out.add(value);
	}
	if (out.size === 0) return tys;
	const drop = [...out];
	return members.map((ms) =>
		union(ms.filter((m) => !drop.some((d) => same(m, d)))),
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
 * cannot say what they do not admit.
 */
export function exclusive(
	cx: Ctx,
	members: Value[],
	tys: Ty[],
	left: ReadonlySet<string>,
): Ty[] {
	// A key left out of this view is required on the other side only.
	const keys = members.map((m) => keysOnly(cx, m)?.filter((k) => !left.has(k)));
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
			either.push(
				union(m.map((k) => ({ kind: "object", props: [without(k, NEVER)] }))),
			);
		}
		if (others.size === 0) return t;
		const props = [...others].map(([k, ty]) => without(k, ty));
		return inter([t, { kind: "object", props }, ...either]);
	});
}

/**
 * The keys a schema requires, when that is all it asks of an object: `required` (none
 * for an empty one), `type: object` and properties that admit any value, with
 * annotations, an object with one of them at least (none where `required` is absent);
 * a `$ref` or `$dynamicRef`, with annotations at most, to such a schema (see
 * `onlyTarget`); or in 3.1 and 3.2, such keywords next to references to such schemas,
 * which require their keys too. One reached again on the way (`seen`), which is an
 * error, is none.
 */
function keysOnly(
	cx: Ctx,
	s: Value,
	seen: ReadonlySet<string> = new Set(),
): string[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	// The keys each reference's target requires; undefined where one requires more.
	const reached = (targets: readonly Located[]): string[] | undefined => {
		const keys: string[] = [];
		for (const target of targets) {
			if (seen.has(target.uri)) return undefined;
			const inner = cx.inTarget(target, () =>
				keysOnly(cx, target.value, new Set([...seen, target.uri])),
			);
			if (inner === undefined) return undefined;
			keys.push(...inner);
		}
		return keys;
	};
	// In 3.0 the keywords next to $ref are ignored.
	const only = onlyTarget(cx, s);
	if (only !== undefined) return reached([only]);
	const allowed = s.entries.every(
		([k, x]) =>
			REFS.has(k) ||
			k === "required" ||
			isAnnotation(k) ||
			(k === "type" && x === "object") ||
			(k === "properties" &&
				x instanceof JsonObject &&
				x.entries.every(([, ps]) => admitsAnyValue(cx, ps))),
	);
	const targets = cx.reached(s);
	const keys = allowed ? reached(targets) : undefined;
	// Annotations alone admit every value, not only objects.
	const object =
		targets.length > 0 ||
		["required", "type", "properties"].some((k) => s.get(k) !== undefined);
	if (keys === undefined || !object) return undefined;
	const req = s.get("required");
	const own = (Array.isArray(req) ? req : []).filter(
		(n): n is string => typeof n === "string",
	);
	// A key the target and the keywords next to it both require is one key.
	return [...new Set([...keys, ...own])];
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
	if (
		cx.readsSiblings(s) &&
		!s.entries.every(([k]) => REFS.has(k) || isAnnotation(k))
	)
		return false;
	return cx
		.reached(s)
		.every(
			(target) =>
				!seen.has(target.uri) &&
				cx.inTarget(target, () =>
					admitsAnyValue(cx, target.value, new Set([...seen, target.uri])),
				),
		);
}
