// `unevaluatedProperties` / `unevaluatedItems`: what the schemas beside them evaluate.
//
// Where nothing next to them evaluates, they are `additionalProperties` / `items`
// (`unevaluated`). Next to an applicator, what each schema that applies to the value
// evaluates where it matches is read (`evaluates`): a key the schema names that nothing
// evaluates is absent or as the keyword says, and the items past those evaluated are as it
// says, in each case of what evaluates them (`itemCases`). With `unevaluatedItems: false`
// it can say which items match a `contains` beside it, and then how many (`saying`).

import { JsonObject, type Value } from "./json.ts";
import { dependencies, leftOutGroup, namedKeys, requiredKeys } from "./keys.ts";
import { orOther } from "./kinds.ts";
import { accepts, listed, negation, refuted } from "./not.ts";
import { containsBounds, count, matches } from "./number.ts";
import { keyLiterals, propertyKeys } from "./object.ts";
import { type Ctx, child, type Place } from "./pointer.ts";
import { membersIn, schema } from "./schema.ts";
import { MAX_UNION } from "./template.ts";
import {
	array as arrayTy,
	equal,
	inter,
	NEVER,
	present,
	type Ty,
	UNKNOWN,
	union,
} from "./ty.ts";
import { EVALUATING, isAnnotation } from "./vocab.ts";

/**
 * `unevaluatedProperties` / `unevaluatedItems` where nothing next to them evaluates: then
 * they are `additionalProperties` / `items`. undefined where they are not that.
 */
export function unevaluated(v: JsonObject, key: string): Value | undefined {
	const x = v.get(key);
	if (x === undefined) return undefined;
	const evaluating = key === "unevaluatedItems" ? EVALUATING_ITEMS : EVALUATING;
	return evaluating.every((k) => v.get(k) === undefined) ? x : undefined;
}

/**
 * What the keys without a property schema are, and the keyword that says it:
 * `additionalProperties`, or else `unevaluatedProperties` where it is that (`unevaluated`);
 * undefined without either.
 */
export function additional(
	v: JsonObject,
): { key: string; value: Value } | undefined {
	const ap = v.get("additionalProperties");
	if (ap !== undefined) return { key: "additionalProperties", value: ap };
	const up = unevaluated(v, "unevaluatedProperties");
	return up === undefined
		? undefined
		: { key: "unevaluatedProperties", value: up };
}

/** The keywords next to `unevaluatedItems` that evaluate for it: `contains` evaluates the items it matches. */
const EVALUATING_ITEMS = [...EVALUATING, "contains"];

/**
 * The most cases of what evaluates the items (`itemCases`) read where branches have
 * `contains`: each set of them is one, so they double with each such branch. They are
 * members of one union, kept to as many as a union kanagata builds (`MAX_UNION`); time
 * grows with them about in proportion (65,536 take about 3 s).
 */
const MAX_CASES = MAX_UNION;

/**
 * What a schema evaluates for `unevaluatedProperties` / `unevaluatedItems` wherever it
 * matches: property names, `patternProperties`, every key (`all`), the first `length`
 * items or every item (`rest`), the items the `contains` of the schemas in `contained`
 * match; and what its `oneOf` / `anyOf` members (of `group`), `if` / `then` / `else` and
 * dependent schemas evaluate where they match, `cond` (`branches`). `keys` are the keys it names,
 * which a type can leave out. An `else` where TypeScript cannot say which values `if`
 * does not admit evaluates where no type says (`undecided`).
 */
interface Evaluated {
	names: Set<string>;
	patterns: string[];
	all: boolean;
	length: number;
	rest: boolean;
	contained: Holder[];
	undecided: boolean;
	keys: Set<string>;
	branches: { cond: () => Ty; ev: Evaluated; group: Value[] | undefined }[];
}

/** A schema with `contains`, where it is and where it is read (see `Ctx.place`). */
interface Holder {
	schema: JsonObject;
	at: string;
	place: Place;
}

const nothingEvaluated = (): Evaluated => ({
	names: new Set(),
	patterns: [],
	all: false,
	length: 0,
	rest: false,
	contained: [],
	undecided: false,
	keys: new Set(),
	branches: [],
});

/** Adds what `b` evaluates to `a`. */
function evaluateBoth(a: Evaluated, b: Evaluated): void {
	for (const n of b.names) a.names.add(n);
	a.patterns.push(...b.patterns);
	a.all ||= b.all;
	a.length = Math.max(a.length, b.length);
	a.rest ||= b.rest;
	a.contained.push(...b.contained);
	a.undecided ||= b.undecided;
	for (const k of b.keys) a.keys.add(k);
	a.branches.push(...b.branches);
}

/** Whether a schema evaluates a property or an item somewhere, itself or where a branch matches. */
function evaluatesAny(e: Evaluated): boolean {
	return (
		e.names.size > 0 ||
		e.patterns.length > 0 ||
		e.all ||
		e.length > 0 ||
		e.rest ||
		e.contained.length > 0 ||
		e.branches.length > 0
	);
}

/** `f`, run where it is read now (see `Ctx.place`) when first asked, and remembered. */
function later<T>(cx: Ctx, f: () => T): () => T {
	const place = cx.place;
	let value: T | undefined;
	return () => {
		value ??= cx.inPlace(place, f);
		return value;
	};
}

/**
 * What a schema evaluates for its own `unevaluated*` (`evaluates`) and the cases of what
 * evaluates its items (`itemCases`), each read once, when first asked: its type's parts and
 * the schemas with `contains` it says both read them.
 */
export interface Evaluation {
	readonly evaluated: () => Evaluated;
	readonly cases: () => ReturnType<typeof itemCases>;
}

/** The keys the conversion of a schema reads for its parts (see `Reading` in schema.ts). */
interface Keys {
	readonly left: () => ReadonlySet<string>;
	readonly keys: () => Ty | undefined;
}

/** `Evaluation` of the schema `v` at `at`, whose conversion reads `own`. */
export function evaluation(
	cx: Ctx,
	v: JsonObject,
	at: string,
	own: Keys,
): Evaluation {
	let ev: Evaluated | undefined;
	let cases: { read: ReturnType<typeof itemCases> } | undefined;
	const evaluated = () => {
		ev ??= evaluates(cx, v, at, own, new Set());
		return ev;
	};
	return {
		evaluated,
		cases: () => {
			cases ??= { read: itemCases(evaluated()) };
			return cases.read;
		},
	};
}

/**
 * What a schema evaluates (see `Evaluated`); its own `unevaluated*` too unless it is the
 * schema they are read for, whose conversion reads its keys (`own`). The conditions are
 * converted when asked for.
 */
function evaluates(
	cx: Ctx,
	s: Value,
	at: string,
	own: Keys | undefined,
	seen: ReadonlySet<string>,
): Evaluated {
	const top = own !== undefined;
	const ev = nothingEvaluated();
	if (!(s instanceof JsonObject)) return ev;
	// What a member evaluates, in its own resource.
	const inner = (m: Value, where: string) =>
		cx.inOwnResource(m, () => evaluates(cx, m, where, undefined, seen));
	// A schema reached again inside itself evaluates nothing more; reached again
	// elsewhere, in another member, it evaluates there too.
	for (const e of cx.pathTargets(s, seen, (t, path) =>
		evaluates(cx, t.value, t.where, undefined, path),
	))
		evaluateBoth(ev, e);
	const props = s.get("properties");
	for (const [k] of props instanceof JsonObject ? props.entries : []) {
		ev.names.add(k);
		ev.keys.add(k);
	}
	const pp = s.get("patternProperties");
	if (pp instanceof JsonObject) ev.patterns.push(...pp.entries.map(([k]) => k));
	// Added to what the $ref target evaluates.
	ev.all ||=
		s.get("additionalProperties") !== undefined ||
		(!top && s.get("unevaluatedProperties") !== undefined);
	const prefix = s.get("prefixItems");
	ev.length = Math.max(ev.length, Array.isArray(prefix) ? prefix.length : 0);
	ev.rest ||=
		s.get("items") !== undefined ||
		(!top && s.get("unevaluatedItems") !== undefined);
	// With maxContains 0 no item matches contains, so it evaluates none.
	if (s.get("contains") !== undefined && count(s, "maxContains") !== 0)
		ev.contained.push({ schema: s, at, place: cx.place });
	for (const k of requiredKeys(cx, s)) ev.keys.add(k);
	for (const [k, names] of dependencies(s)) {
		ev.keys.add(k);
		for (const n of names) ev.keys.add(n);
	}
	const keys = own === undefined ? propertyKeys(cx, s, at) : own.keys();
	for (const k of keyLiterals(keys)) ev.keys.add(k);
	const group = own === undefined ? leftOutGroup(cx, s) : own.left();
	const allOf = s.get("allOf");
	// Members are the same value: the schema's keywords apply to it too.
	const member = (m: Value, where: string) =>
		cx.withAround(s, () => inner(m, where));
	for (const [i, m] of (Array.isArray(allOf) ? allOf : []).entries())
		evaluateBoth(ev, member(m, child(child(at, "allOf"), String(i))));
	// A member, if or dependent schema evaluates where it matches.
	const branch = (cond: () => Ty, e: Evaluated, group?: Value[]): void => {
		for (const k of e.keys) ev.keys.add(k);
		ev.undecided ||= e.undecided;
		ev.branches.push({ cond, ev: e, group });
	};
	for (const key of ["oneOf", "anyOf"]) {
		const members = s.get(key);
		if (!Array.isArray(members)) continue;
		const tys = later(cx, () =>
			membersIn(cx, s, members, group, child(at, key)),
		);
		for (const [i, m] of members.entries())
			branch(
				() => tys()[i] as Ty,
				member(m, child(child(at, key), String(i))),
				members,
			);
	}
	const cond = s.get("if");
	if (cond !== undefined) {
		const then = s.get("then") ?? true;
		const otherwise = s.get("else") ?? true;
		const not = refuted(cx, cond, [s, ...cx.around]);
		const tys = later(
			cx,
			() =>
				membersIn(cx, s, [cond, then, otherwise], group, at, [
					"if",
					"then",
					"else",
				]) as [Ty, Ty, Ty],
		);
		// if and then evaluate where if admits the value; else where it does not.
		const both = member(cond, child(at, "if"));
		const thenEv = member(then, child(at, "then"));
		evaluateBoth(both, thenEv);
		branch(() => inter([tys()[0], tys()[1]]), both);
		if (not !== undefined)
			branch(
				() => inter([not, tys()[2]]),
				member(otherwise, child(at, "else")),
			);
		else if (otherwise !== true) ev.undecided = true;
		// Without else, then is read where it evaluates, though no type says where if fails.
		else if (evaluatesAny(thenEv)) cx.thenRead(child(at, "if"));
	}
	const ds = s.get("dependentSchemas");
	for (const [k, d] of ds instanceof JsonObject ? ds.entries : [])
		branch(
			() => ({
				kind: "object",
				props: [present(k, UNKNOWN)],
			}),
			member(d, child(child(at, "dependentSchemas"), k)),
		);
	return ev;
}

/** The conditions under which some branch of `ev` evaluates `key`. */
function evaluating(ev: Evaluated, key: string): Ty[] {
	return ev.branches.flatMap(({ cond, ev: e }) =>
		e.all || e.names.has(key) || e.patterns.some((p) => matches(p, key))
			? [cond()]
			: evaluating(e, key).map((c) => inter([cond(), c])),
	);
}

/**
 * What evaluates the items where `cond` holds: the first `length`, or every one (`rest`),
 * and those the `contains` of the schemas in `contained` match.
 */
interface ItemsEvaluated {
	cond: () => Ty;
	length: number;
	rest: boolean;
	contained: Holder[];
}

/**
 * A branch and what evaluates the items where it matches: whether it is one of the
 * schema's own (`top`, not a member's), and the `oneOf` / `anyOf` members the top branch
 * it is in is one of (`group`; undefined for `if` / `then` / `else` and dependent schemas).
 */
interface BranchItems extends ItemsEvaluated {
	top: boolean;
	group: Value[] | undefined;
}

/** A case of what evaluates the items: the branches that match in it (`parts`). */
interface ItemsCase extends ItemsEvaluated {
	parts: BranchItems[];
}

/** Each branch of `ev` and what evaluates the items where it matches, with what the branches it is in evaluate. */
function evaluatingItems(
	ev: Evaluated,
	length: number,
	contained: Holder[],
	top = true,
	group: Value[] | undefined = undefined,
): BranchItems[] {
	return ev.branches.flatMap((b) => {
		const n = Math.max(length, b.ev.length);
		const c = [...contained, ...b.ev.contained];
		const g = top ? b.group : group;
		const own = { cond: b.cond, length: n, rest: b.ev.rest, contained: c };
		return [
			{ ...own, top, group: g },
			...evaluatingItems(b.ev, n, c, false, g).map((x) => ({
				...x,
				cond: () => inter([b.cond(), x.cond()]),
			})),
		];
	});
}

/**
 * What evaluates the items of a value `ev` is read for, in each case that can be: where
 * it matches, and where each set of branches whose `contains` evaluates (which can match
 * together) and one other branch matches. A branch that evaluates a prefix or every item
 * needs no other such branch beside it: the longest is enough. undefined where branches
 * with `contains` make more than `MAX_CASES` cases.
 */
function itemCases(
	ev: Evaluated,
): { branches: BranchItems[]; cases: ItemsCase[] } | undefined {
	const branches = evaluatingItems(ev, ev.length, []);
	const counting = branches.filter((b) => b.contained.length > 0);
	const others = branches.filter((b) => b.contained.length === 0);
	const size = 2 ** counting.length * (others.length + 1);
	if (counting.length > 0 && size > MAX_CASES) return undefined;
	const both = (a: ItemsCase, b: BranchItems): ItemsCase => ({
		cond: () => inter([a.cond(), b.cond()]),
		length: Math.max(a.length, b.length),
		rest: a.rest || b.rest,
		contained: [...a.contained, ...b.contained],
		parts: [...a.parts, b],
	});
	let cases: ItemsCase[] = [
		{
			cond: () => UNKNOWN,
			length: ev.length,
			rest: ev.rest,
			contained: ev.contained,
			parts: [],
		},
	];
	for (const b of counting) cases = [...cases, ...cases.map((c) => both(c, b))];
	return {
		branches,
		cases: cases.flatMap((c) => [c, ...others.map((b) => both(c, b))]),
	};
}

/** `holders`, each schema once. */
function distinctHolders(holders: Holder[]): Holder[] {
	const seen = new Set<JsonObject>();
	const out: Holder[] = [];
	for (const h of holders) {
		if (seen.has(h.schema)) continue;
		seen.add(h.schema);
		out.push(h);
	}
	return out;
}

/**
 * The one schema whose `contains` every item past those evaluated matches in this case of
 * `unevaluatedItems: false`: where it alone evaluates them. undefined where none does.
 */
function soleHolder(c: Omit<ItemsEvaluated, "cond">): Holder | undefined {
	const holders = distinctHolders(c.contained);
	return !c.rest && holders.length === 1 ? holders[0] : undefined;
}

const isHolder = (c: ItemsEvaluated, h: JsonObject): boolean =>
	c.contained.some((x) => x.schema === h);

/** Whether `contains` asks no more than one matching item, so a value fails it only where none matches. */
function asksOne(h: JsonObject): boolean {
	const { min, max } = containsBounds(h);
	return min <= 1 && max === undefined;
}

/**
 * The schemas with `contains` whose matching items the type of `v` says, its
 * `unevaluatedItems` being `false`, read when first asked for; undefined where it says none.
 */
export function saying(
	cx: Ctx,
	v: JsonObject,
	at: string,
	e: Evaluation,
): (() => ReadonlySet<JsonObject>) | undefined {
	if (v.get("unevaluatedItems") !== false) return undefined;
	const ev = e.evaluated();
	const read = ev.undecided || ev.rest ? undefined : e.cases();
	if (read === undefined) return undefined;
	return later(cx, () => saidHolders(cx, v, at, ev, read.branches, read.cases));
}

/**
 * The schemas with `contains` whose matching items the type says, with `unevaluatedItems:
 * false` (see `unevaluatedItems`). One the value always has (of `v`, its `$ref` target, its
 * `allOf` members): where it alone evaluates the items past those evaluated in every case,
 * and whether each item before them matches is told. One a branch has, where nothing else
 * evaluates the items unless a branch does: where it alone evaluates every item in every
 * case it is in; or where it asks for one matching item at most, it is in a `oneOf` /
 * `anyOf` member of the schema whose members alone evaluate the items, and in every case
 * it is in, the others evaluate as many items without it and, where the one `contains`
 * left evaluates every item (and so is counted), it asks for one matching item at most.
 * Then a value that matches none of its items evaluates the same without it.
 */
function saidHolders(
	cx: Ctx,
	v: JsonObject,
	at: string,
	ev: Evaluated,
	branches: BranchItems[],
	cases: ItemsCase[],
): ReadonlySet<JsonObject> {
	const sole = (c: ItemsEvaluated, h: Holder): boolean =>
		soleHolder(c)?.schema === h.schema &&
		prefixMarks(cx, v, at, h, c.length) !== undefined;
	const always = new Set(ev.contained.map((h) => h.schema));
	const evaluating = branches.filter(
		(b) => b.length > 0 || b.rest || b.contained.length > 0,
	);
	// What evaluates the items in a case without the branches the holder is in.
	const without = (c: ItemsCase, h: JsonObject): boolean => {
		const parts = c.parts.filter((p) => !isHolder(p, h));
		const length = Math.max(ev.length, ...parts.map((p) => p.length));
		// Not every item by the value itself (ev.rest), whose cases are read only then.
		const rest = parts.some((p) => p.rest);
		if (length !== c.length || rest !== c.rest) return false;
		const other = soleHolder({
			length,
			rest,
			contained: [...ev.contained, ...parts.flatMap((p) => p.contained)],
		});
		// Past items evaluated otherwise, the one left is not counted (see `prefixMarks`).
		return other === undefined || length > 0 || asksOne(other.schema);
	};
	const said = distinctHolders(cases.flatMap((c) => c.contained)).filter(
		(h) => {
			const within = cases.filter((c) => isHolder(c, h.schema));
			if (always.has(h.schema)) return within.every((c) => sole(c, h));
			if (ev.length > 0 || ev.contained.length > 0) return false;
			// Without items of its own (above), the holder is sole only where no items precede those it evaluates.
			if (within.every((c) => sole(c, h))) return true;
			const group = branches.find((b) => b.top && isHolder(b, h.schema))?.group;
			return (
				asksOne(h.schema) &&
				group !== undefined &&
				evaluating.every((b) => b.group === group) &&
				within.every((c) => without(c, h.schema))
			);
		},
	);
	// The schema's own contains with maxContains 0 evaluates no item: the type says that none
	// matches where the items are the schema's own prefix items alone, each told not to.
	const none =
		v.get("contains") !== undefined &&
		count(v, "maxContains") === 0 &&
		cases.every(
			(c) =>
				!c.rest &&
				c.contained.length === 0 &&
				prefixMarks(
					cx,
					v,
					at,
					{ schema: v, at, place: cx.place },
					c.length,
				)?.every((m) => !m) === true,
		);
	return new Set([...said.map((h) => h.schema), ...(none ? [v] : [])]);
}

/**
 * Whether each of the first `length` items matches the holder's `contains`, where that is
 * told: by the schema's own `prefixItems` (whose items are those of the type), as their
 * types meet nowhere, as every value it lists is or is not admitted, or as `contains`
 * admits every value or says only a kind that the prefix item's type is within.
 * undefined where some is not told.
 */
function prefixMarks(
	cx: Ctx,
	v: JsonObject,
	at: string,
	h: Holder,
	length: number,
): boolean[] | undefined {
	// The length is the schema's own prefixItems' at least, which it evaluates too.
	const own = v.get("prefixItems");
	const prefix = Array.isArray(own) ? own : [];
	if (prefix.length < length) return undefined;
	const c = h.schema.get("contains") as Value;
	if (negation(c) === NEVER) return prefix.map(() => true);
	const item = containsTy(cx, h);
	const marks = prefix.map((p, i): boolean | undefined => {
		const ty = schema(cx, p, child(child(at, "prefixItems"), String(i)));
		const met = inter([ty, item]);
		if (met.kind === "never") return false;
		// negation reads every schema but an object and false (whose type meets nothing) as admitting all.
		const s = c as JsonObject;
		const verdicts = listed(cx, p, new Set())?.map((x) => accepts(cx, s, x));
		if (verdicts?.every((x) => x === true)) return true;
		if (verdicts?.every((x) => x === false)) return false;
		const kindOnly = s.entries.every(([k]) => k === "type" || isAnnotation(k));
		return kindOnly && equal(met, ty) ? true : undefined;
	});
	return marks.every((m) => m !== undefined) ? (marks as boolean[]) : undefined;
}

/**
 * The arrays whose matching items are from `min` to `max` (no bound if undefined), where
 * the items the `marks` say match it before every item past them does, which are `item`.
 */
function containsCount(
	item: Ty,
	marks: boolean[],
	min: number,
	max: number | undefined,
): Ty {
	const length = marks.length;
	// Of the first n items, within the prefix.
	const matching = (n: number) => marks.slice(0, n).filter(Boolean).length;
	const at = (i: number) => (i < length ? UNKNOWN : item);
	// The fewest items with min matching: within the prefix, or past it one by one.
	let lo = 0;
	while (lo < length && matching(lo) < min) lo++;
	lo += Math.max(0, min - matching(lo));
	if (max === undefined) {
		const n = Math.max(length, lo);
		return n === 0
			? arrayTy(item)
			: {
					kind: "tuple",
					items: Array.from({ length: n }, (_, i) => at(i)),
					min: lo,
					rest: item,
				};
	}
	// The most items with max matching at most.
	let hi = length;
	while (matching(hi) > max) hi--;
	if (hi === length) hi += max - matching(length);
	return {
		kind: "tuple",
		items: Array.from({ length: hi }, (_, i) => at(i)),
		min: lo,
	};
}

/** The type of a holder's `contains`: an item it matches. */
function containsTy(cx: Ctx, h: Holder): Ty {
	return cx.inPlace(h.place, () =>
		schema(cx, h.schema.get("contains") as Value, child(h.at, "contains")),
	);
}

/**
 * `unevaluatedProperties` / `unevaluatedItems` next to an applicator: a key the schema
 * names that nothing evaluates wherever it is present is absent or as the keyword says,
 * and items past those evaluated are as it says (none for `false`).
 */
export function unevaluatedParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	e: Evaluation,
): Ty[] {
	// Where nothing next to them evaluates, they are additionalProperties / items (`unevaluated`).
	const next = (key: string) =>
		unevaluated(v, key) === undefined ? v.get(key) : undefined;
	const up = next("unevaluatedProperties");
	const ui = next("unevaluatedItems");
	const asked = (x: Value | undefined) => x !== undefined && x !== true;
	if (!asked(up) && !asked(ui)) return [];
	const ev = e.evaluated();
	const warn = (key: string, x: Value | undefined) => {
		if (asked(x))
			cx.warn(
				child(at, key),
				`${key} next to an applicator cannot be expressed in TypeScript; ignored`,
			);
	};
	if (ev.undecided) {
		warn("unevaluatedProperties", up);
		warn("unevaluatedItems", ui);
		return [];
	}
	const parts: Ty[] = [];
	if (asked(up) && !ev.all) {
		const ty = schema(cx, up as Value, child(at, "unevaluatedProperties"));
		// The schemas this one is a member of name keys of the same object, which it does not evaluate.
		const keys = new Set(ev.keys);
		for (const s of cx.around) for (const k of namedKeys(cx, s)) keys.add(k);
		for (const key of keys) {
			if (ev.names.has(key) || ev.patterns.some((p) => matches(p, key)))
				continue;
			parts.push(
				orOther(
					cx,
					v,
					["object"],
					union([
						{ kind: "object", props: [{ key, ty, optional: true }] },
						...evaluating(ev, key),
					]),
				),
			);
		}
	}
	const read = asked(ui) && !ev.rest ? e.cases() : undefined;
	if (asked(ui) && !ev.rest && read === undefined) warn("unevaluatedItems", ui);
	if (read !== undefined) {
		const ty = schema(cx, ui as Value, child(at, "unevaluatedItems"));
		parts.push(
			orOther(
				cx,
				v,
				["array"],
				union(
					read.cases.map((c) =>
						c.rest
							? c.cond()
							: inter([
									c.cond(),
									unevaluatedItems(cx, v, at, c, ui as Value, ty),
								]),
					),
				),
			),
		);
	}
	return parts;
}

/**
 * The arrays `unevaluatedItems` admits in one case of what evaluates the items: past those
 * evaluated, an item matches a `contains` there or is of the keyword's type `ty`. Where one
 * `contains` alone evaluates them and the keyword admits none, every item past them matches
 * it; where it is told which items before them match it too (`prefixMarks`), its
 * `minContains` and `maxContains` bound the length.
 */
function unevaluatedItems(
	cx: Ctx,
	v: JsonObject,
	at: string,
	c: ItemsEvaluated,
	ui: Value,
	ty: Ty,
): Ty {
	const sole = ui === false ? soleHolder(c) : undefined;
	const marks =
		sole === undefined ? undefined : prefixMarks(cx, v, at, sole, c.length);
	if (sole !== undefined && marks !== undefined) {
		const { min, max } = containsBounds(sole.schema);
		if (max !== undefined && max < min) return NEVER;
		return containsCount(containsTy(cx, sole), marks, min, max);
	}
	const rest = union([
		...distinctHolders(c.contained).map((h) => containsTy(cx, h)),
		ty,
	]);
	if (rest.kind === "never")
		return { kind: "tuple", items: Array(c.length).fill(UNKNOWN), min: 0 };
	return c.length === 0
		? arrayTy(rest)
		: {
				kind: "tuple",
				items: Array(c.length).fill(UNKNOWN),
				min: 0,
				rest,
			};
}
