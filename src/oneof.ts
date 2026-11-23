// `oneOf`: a value only one member admits.
//
// A TypeScript union admits a value any member admits. Where TypeScript can say what a
// member does not admit, each member leaves out what another admits too: a literal or
// `null` two members list (`shared`), and among members that ask only for keys, the
// objects with all of another's (`exclusive`).

import { JsonObject, type Value } from "./json.ts";
import type { Ctx } from "./pointer.ts";
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
		for (const [j, other] of keys.entries()) {
			if (j === i || other === undefined) continue;
			const missing = other.filter((k) => !own.includes(k));
			if (missing.length === 0) return NEVER;
			if (missing.length === 1) {
				others.set(missing[0] as string, NEVER);
				continue;
			}
			for (const k of missing) if (!others.has(k)) others.set(k, UNKNOWN);
			either.push(
				union(
					missing.map((k) => ({ kind: "object", props: [without(k, NEVER)] })),
				),
			);
		}
		if (others.size === 0) return t;
		const props = [...others].map(([k, ty]) => without(k, ty));
		return inter([t, { kind: "object", props }, ...either]);
	});
}

/**
 * The keys a schema requires, when that is all it asks of an object: a non-empty
 * `required`, with at most `type: object`, properties that admit any value and
 * annotations; or a `$ref` or `$dynamicRef`, with annotations at most, to such a schema.
 */
function keysOnly(cx: Ctx, s: Value): string[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const target = onlyTarget(cx, s);
	if (target !== undefined)
		return cx.inTarget(target, () => keysOnly(cx, target.value));
	const allowed = s.entries.every(
		([k, x]) =>
			k === "required" ||
			isAnnotation(k) ||
			(k === "type" && x === "object") ||
			(k === "properties" &&
				x instanceof JsonObject &&
				x.entries.every(([, ps]) => admitsAnyValue(cx, ps))),
	);
	const req = s.get("required");
	return allowed && Array.isArray(req) && req.length > 0
		? req.filter((n): n is string => typeof n === "string")
		: undefined;
}

/**
 * Whether a schema admits every value: `true`, annotations alone, or a `$ref` or
 * `$dynamicRef` to such a schema next to them.
 */
function admitsAnyValue(cx: Ctx, s: Value): boolean {
	if (s === true) return true;
	if (!(s instanceof JsonObject)) return false;
	if (!s.entries.every(([k]) => REFS.has(k) || isAnnotation(k))) return false;
	return cx
		.reached(s)
		.every((target) =>
			cx.inTarget(target, () => admitsAnyValue(cx, target.value)),
		);
}
