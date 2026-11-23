// Kinds: which kinds of JSON value a schema is, and how values of the other kinds pass a
// member that constrains some kinds only.
//
// `type` names the kinds; without it, object and array keywords make a schema those kinds,
// with strings and numbers for their keywords among them (`keywordKinds`), and `const` /
// `enum` say the kinds of the values they list. A member without `type` whose keywords make
// it some kinds constrains only values of those kinds: values of the other kinds the schema
// is pass it as its keywords and its members' for them say (`passing`, `passed`).

import { JsonNumber, JsonObject, type Value } from "./json.ts";
import { excluded, negation, refuted } from "./not.ts";
import { count, numeric } from "./number.ts";
import { shared } from "./oneof.ts";
import type { Ctx, Located } from "./pointer.ts";
import { text } from "./schema.ts";
import {
	array as arrayTy,
	BOOLEAN,
	INTEGER,
	inter,
	NEVER,
	NULL,
	NUMBER,
	RECORD,
	STRING,
	type Ty,
	UNKNOWN,
	union,
} from "./ty.ts";
import { unevaluated } from "./unevaluated.ts";

/** The type of each value kind `type` names. */
export const KIND: Record<string, Ty> = {
	string: STRING,
	number: NUMBER,
	integer: INTEGER,
	boolean: BOOLEAN,
	null: NULL,
	array: arrayTy(UNKNOWN),
	object: RECORD,
};

/** The kinds of JSON value, `integer` among the numbers, in the order types are written. */
const ALL_KINDS = [
	"string",
	"number",
	"integer",
	"boolean",
	"null",
	"array",
	"object",
];

/**
 * The values of a kind as a schema's keywords for it say: its lengths and `pattern` for
 * strings, its bounds for numbers; any value of the kind for the others.
 */
function ofKind(cx: Ctx, s: JsonObject, kind: string): Ty {
	if (kind === "string") return text(s);
	if (kind === "number" || kind === "integer")
		return numeric(cx, s, kind === "integer");
	return KIND[kind] as Ty;
}

/**
 * The values of a kind that a member `typelessKinds` reads admits: every one for `true`
 * (and anything else read as a schema that admits every value), none for `false`;
 * otherwise those its keywords for the kind admit, its `$ref` target (that alone in 3.0)
 * and `$dynamicRef` target,
 * all its `allOf` members, one of its `anyOf` members and one of its `oneOf` members (a
 * literal or `null` two of them admit is in none; see `shared`), and, where TypeScript
 * can say them, those its `not` leaves (`negation`, `excluded`) and its `if` / `then` /
 * `else` admit (`refuted`). A `not` or `if` it cannot say is ignored, as the member's own
 * type ignores it, with a warning. `around` are the schemas `m` is a member of.
 */
export function passed(
	cx: Ctx,
	m: Value,
	kind: string,
	around: Value[],
	seen: ReadonlySet<string> = new Set(),
): Ty {
	if (!(m instanceof JsonObject))
		return m === false ? NEVER : (KIND[kind] as Ty);
	const uri = cx.ownResource(m);
	return uri === undefined
		? ownPassed(cx, m, kind, around, seen)
		: cx.inResource(uri, () => ownPassed(cx, m, kind, around, seen));
}

function ownPassed(
	cx: Ctx,
	m: JsonObject,
	kind: string,
	around: Value[],
	seen: ReadonlySet<string>,
): Ty {
	const inner = (n: Value, s = seen) => passed(cx, n, kind, [m, ...around], s);
	const parts: Ty[] = [];
	for (const target of cx.reached(m))
		if (!seen.has(target.uri))
			parts.push(
				cx.inTarget(target, () =>
					inner(target.value, new Set([...seen, target.uri])),
				),
			);
	// In 3.0 the keywords next to $ref are ignored.
	if (!cx.readsSiblings(m)) return inter(parts);
	const each = (key: string): Ty[] | undefined => {
		const members = m.get(key);
		return Array.isArray(members) ? members.map((n) => inner(n)) : undefined;
	};
	const any = each("anyOf");
	const one = each("oneOf");
	parts.push(
		ofKind(cx, m, kind),
		...(each("allOf") ?? []),
		...(any === undefined ? [] : [union(any)]),
		...(one === undefined ? [] : [union(shared(one))]),
	);
	const n = m.get("not");
	const left = n === undefined ? undefined : negation(n);
	if (left !== undefined) parts.push(left);
	// As `then` says where `if` admits the value, and as `else` says where it does not.
	const cond = m.get("if");
	const not =
		cond === undefined ||
		(m.get("then") === undefined && m.get("else") === undefined)
			? undefined
			: refuted(cx, cond, [m, ...around]);
	if (not !== undefined)
		parts.push(
			union([
				inter([inner(cond as Value), inner(m.get("then") ?? true)]),
				...(not.kind === "union" ? not.items : [not]).map((x) =>
					inter([x, inner(m.get("else") ?? true)]),
				),
			]),
		);
	const t = inter(parts);
	// `not: { enum }` and `not: { const }` leave out the literals they list.
	const out = excluded(m)?.map((x) => x.ty);
	if (out === undefined) return t;
	return union(
		(t.kind === "union" ? t.items : [t]).filter(
			(x) =>
				!out.some(
					(o) =>
						o.kind === x.kind &&
						(x.kind !== "lit" || (o as { text: string }).text === x.text),
				),
		),
	);
}

/**
 * A member without `type` whose object or array keywords (`{ required: [a] }`,
 * `{ minItems: 1 }`), or those of its members, make it those kinds constrains only values
 * of those kinds. Where the schema is of other kinds (its `type`, or `nullable: true` in
 * 3.0; `severalKinds` without `type`), their values pass the member as its keywords and
 * its members' for them say.
 */
export function passing(
	cx: Ctx,
	v: JsonObject,
	members: Value[],
	tys: Ty[],
): Ty[] {
	return tys.map((ty, i) => {
		const m = members[i] as Value;
		const kinds = typelessKinds(cx, m);
		return kinds.length === 0
			? ty
			: widen(cx, v, kinds, ty, (k) => passed(cx, m, k, [v, ...cx.around]));
	});
}

/**
 * The type `ty` of the schema a `$ref` or `$dynamicRef` of `v` reaches, `target`, which
 * applies to the same value as an `allOf` member does (3.1, 3.2): where it makes it some
 * kinds only (`typelessKinds`), the values of the other kinds the schema is pass it as its
 * keywords for them say (see `passing`).
 */
export function passingTarget(
	cx: Ctx,
	v: JsonObject,
	target: Located,
	ty: Ty,
): Ty {
	const kinds = cx.inTarget(target, () => typelessKinds(cx, target.value));
	return kinds.length === 0
		? ty
		: widen(cx, v, kinds, ty, (k) =>
				cx.inTarget(target, () =>
					passed(cx, target.value, k, [v, ...cx.around], new Set([target.uri])),
				),
			);
}

/**
 * The kinds `type` names, and null where 3.0's `nullable: true` adds it; every kind where
 * it names one JSON Schema does not have; undefined without `type`, or next to a 3.0
 * `$ref`, which ignores it.
 */
function typeKinds(cx: Ctx, v: JsonObject): string[] | undefined {
	if (!cx.readsSiblings(v)) return undefined;
	const t = v.get("type");
	const kinds =
		typeof t === "string"
			? [t]
			: Array.isArray(t)
				? t.filter((k): k is string => typeof k === "string")
				: undefined;
	if (kinds === undefined) return undefined;
	// A name JSON Schema does not have admits every value (see `typed`).
	if (kinds.some((k) => !Object.hasOwn(KIND, k))) return ALL_KINDS;
	return !cx.refSiblings && v.get("nullable") === true
		? [...kinds, "null"]
		: kinds;
}

/**
 * `ty`, a constraint on values of `kinds` only, with the other kinds the schema is (those
 * `type` names; without it, `saidKinds` or `severalKinds`), which pass it as `pass` says
 * (the keywords of the member or reference `ty` is of, and its members': `passed`), or as
 * the keywords of `v` for them say.
 */
export function widen(
	cx: Ctx,
	v: JsonObject,
	kinds: string[],
	ty: Ty,
	pass: (kind: string) => Ty = (k) => ofKind(cx, v, k),
): Ty {
	const named =
		typeKinds(cx, v) ?? saidKinds(cx, v, false) ?? severalKinds(cx, v);
	if (named === undefined) return ty;
	return union([ty, ...named.filter((k) => !kinds.includes(k)).map(pass)]);
}

/**
 * The kinds the keywords of a schema without `type` say it is, where they say several
 * (`keywordKinds`, with those of the schemas its references reach); undefined otherwise.
 */
function severalKinds(cx: Ctx, v: JsonObject): string[] | undefined {
	const kinds = keywordKinds(cx, v, true);
	return kinds.length > 1 ? kinds : undefined;
}

/**
 * A member's type as the values it admits: one whose object or array keywords, or those of
 * its members, make it those kinds (no `type`) admits the values of the other kinds too,
 * of those the schema and the schemas around it can be (their `type`s; any kind where none
 * has one), as its keywords and its members' for them say.
 */
export function anyKind(cx: Ctx, v: JsonObject, m: Value, ty: Ty): Ty {
	const kinds = typelessKinds(cx, m);
	return kinds.length === 0 ? ty : orOther(cx, v, kinds, ty, m);
}

/**
 * `ty`, a constraint on values of `kinds` only, with the values of the other kinds the
 * schema and the schemas around it can be (their `type`s; any kind where none has one),
 * as the keywords of `v` for them say, or as those of `m`, the member `ty` is of, and of
 * its members (`passed`).
 */
export function orOther(
	cx: Ctx,
	v: JsonObject,
	kinds: string[],
	ty: Ty,
	m?: Value,
): Ty {
	return union([
		ty,
		...contextKinds(cx, v)
			.filter((k) => !kinds.includes(k))
			.map((k) =>
				m === undefined
					? ofKind(cx, v, k)
					: passed(cx, m, k, [v, ...cx.around]),
			),
	]);
}

/** The kinds the schema and the schemas around it can be: those their `type`s all name; any where none has one. */
export function contextKinds(cx: Ctx, v: JsonObject): string[] {
	let kinds = ALL_KINDS;
	for (const s of [v, ...cx.around]) {
		const named = typeKinds(cx, s);
		if (named !== undefined)
			kinds = kinds.filter(
				(k) =>
					named.includes(k) || (k === "integer" && named.includes("number")),
			);
	}
	return kinds;
}

/**
 * The kinds a schema without `type` constrains where its keywords and those of the schemas
 * it applies (`$ref` target, `allOf` / `oneOf` / `anyOf` members, `if` / `then` / `else`)
 * make it those kinds (`ownKinds`), and none of them has `type`, `const` or `enum`; none
 * for any other.
 */
function typelessKinds(cx: Ctx, m: Value): string[] {
	const kinds = madeKinds(cx, m);
	return kinds !== undefined && kinds.all.size === kinds.made.size
		? [...kinds.made]
		: [];
}

/**
 * The kinds a schema's keywords and those of the schemas it applies make it (`made`: its
 * own, its `$ref` and `$dynamicRef` targets' and its members'), and those its `if` /
 * `then` / `else` add (`all`), which let the other kinds pass in its own type already;
 * undefined where one of them says more, or a reference reaches nothing (`typelessKinds`). `true`, and anything
 * else read as a schema that admits every value, makes no kind; nor does `false`, which
 * admits none (`passed`).
 */
function madeKinds(
	cx: Ctx,
	m: Value,
	seen: ReadonlySet<string> = new Set(),
): { made: Set<string>; all: Set<string> } | undefined {
	if (
		m instanceof JsonObject &&
		cx.readsSiblings(m) &&
		(m.get("type") !== undefined ||
			m.get("const") !== undefined ||
			m.get("enum") !== undefined)
	)
		return undefined;
	const kinds = { made: new Set<string>(), all: new Set<string>() };
	if (!(m instanceof JsonObject)) return kinds;
	const uri = cx.ownResource(m);
	return uri === undefined
		? ownMadeKinds(cx, m, seen, kinds)
		: cx.inResource(uri, () => ownMadeKinds(cx, m, seen, kinds));
}

function ownMadeKinds(
	cx: Ctx,
	m: JsonObject,
	seen: ReadonlySet<string>,
	kinds: { made: Set<string>; all: Set<string> },
): { made: Set<string>; all: Set<string> } | undefined {
	const add = (n: Value, made: boolean, s = seen): boolean => {
		const inner = madeKinds(cx, n, s);
		for (const k of inner?.all ?? []) kinds.all.add(k);
		if (made) for (const k of inner?.made ?? []) kinds.made.add(k);
		return inner !== undefined;
	};
	const refs =
		(m.get("$ref") === undefined ? 0 : 1) +
		(m.get("$dynamicRef") === undefined ? 0 : 1);
	const targets = cx.reached(m);
	// Each reference must reach its target; one seen on the way adds nothing.
	const read =
		targets.length === refs &&
		targets.every(
			(target) =>
				seen.has(target.uri) ||
				cx.inTarget(target, () =>
					add(target.value, true, new Set([...seen, target.uri])),
				),
		);
	if (!read) return undefined;
	// In 3.0 the keywords next to $ref are ignored.
	if (!cx.readsSiblings(m)) return kinds;
	for (const k of ownKinds(m)) {
		kinds.made.add(k);
		kinds.all.add(k);
	}
	const members = ["allOf", "oneOf", "anyOf"].flatMap((key) => {
		const ms = m.get(key);
		return Array.isArray(ms) ? ms : [];
	});
	const branches = ["if", "then", "else"].flatMap((key) => {
		const b = m.get(key);
		return b === undefined ? [] : [b];
	});
	return members.every((n) => add(n, true)) &&
		branches.every((n) => add(n, false))
		? kinds
		: undefined;
}

/**
 * The kinds a schema's keywords make it: object for `dependentRequired`,
 * `dependentSchemas`, `propertyNames` and those that make a value one; array for
 * `contains` and those that make a value one.
 */
function ownKinds(m: JsonObject): string[] {
	const kinds: string[] = [];
	if (
		hasObjectKeywords(m) ||
		["dependentRequired", "dependentSchemas", "propertyNames"].some(
			(k) => m.get(k) !== undefined,
		)
	)
		kinds.push("object");
	if (hasArrayKeywords(m) || m.get("contains") !== undefined)
		kinds.push("array");
	return kinds;
}

/** The kinds a member constrains: those its `type` names, or else `typelessKinds`. */
export function kindsOfMember(cx: Ctx, m: JsonObject): string[] {
	return typeKinds(cx, m) ?? typelessKinds(cx, m);
}

/** The keywords that say the kinds of a schema as its keywords for kinds do not. */
const SAYING = ["type", "const", "enum"];

/** The keywords that say what a schema is beyond its keywords for kinds. */
const TYPING = [...SAYING, "$ref", "$dynamicRef"];

/**
 * The kinds the keywords of a schema without `type` say it is, read with those of the
 * schemas it applies without `type`, `$ref`, `$dynamicRef`, `const` or `enum` (`allOf` /
 * `oneOf` / `anyOf` members, `if` / `then` / `else`, at any depth), which ask the same
 * value: where they make it an object or an array (`ownKinds`), those kinds, and strings
 * and numbers for their keywords among them. None otherwise: string and number keywords
 * alone say nothing of the kind. With `targets`, the schemas it applies through `$ref` and
 * `$dynamicRef` are read too, as those without are: the targets of its own and of those
 * schemas, and members that have references, where they have no `type`, `const` or `enum`
 * (one next to a 3.0 `$ref` is ignored).
 */
export function keywordKinds(
	cx: Ctx,
	v: JsonObject,
	targets = false,
): string[] {
	const kinds = new Set<string>();
	const seen = new Set<string>();
	const typeless = (m: Value | undefined): m is JsonObject =>
		m instanceof JsonObject &&
		(targets
			? !cx.readsSiblings(m) || SAYING.every((k) => m.get(k) === undefined)
			: TYPING.every((k) => m.get(k) === undefined));
	const read = (s: JsonObject) => {
		if (targets)
			for (const target of cx.reached(s)) {
				const t = target.value;
				if (seen.has(target.uri) || !typeless(t)) continue;
				seen.add(target.uri);
				cx.inTarget(target, () => read(t));
			}
		// In 3.0 the keywords next to $ref are ignored.
		if (!cx.readsSiblings(s)) return;
		const has = (keys: string[]) => keys.some((k) => s.get(k) !== undefined);
		for (const k of ownKinds(s)) kinds.add(k);
		if (has(["pattern", "minLength", "maxLength"])) kinds.add("string");
		if (
			has([
				"minimum",
				"maximum",
				"exclusiveMinimum",
				"exclusiveMaximum",
				"multipleOf",
			])
		)
			kinds.add("number").add("integer");
		for (const key of ["allOf", "oneOf", "anyOf"]) {
			const members = s.get(key);
			for (const m of Array.isArray(members) ? members : [])
				if (typeless(m)) read(m);
		}
		for (const key of ["if", "then", "else"]) {
			const b = s.get(key);
			if (typeless(b)) read(b);
		}
	};
	read(v);
	return kinds.has("object") || kinds.has("array") ? [...kinds] : [];
}

/**
 * The kinds the `type`s and `const` / `enum` of the schema (without `type`) and of the
 * schemas it applies allow, at any depth: its own `const` / `enum`, those of its `$ref` and
 * `$dynamicRef` targets and of each `allOf` member, and of every `oneOf` / `anyOf` member
 * together (none where one says none); with `around`, those of the schemas it is a member
 * of too. undefined where none of them says any.
 */
function saidKinds(
	cx: Ctx,
	v: JsonObject,
	around: boolean,
): string[] | undefined {
	const meet = (lists: string[][]): string[] | undefined =>
		lists.length === 0
			? undefined
			: ALL_KINDS.filter((k) =>
					lists.every(
						(n) => n.includes(k) || (k === "integer" && n.includes("number")),
					),
				);
	// What a schema's `type`s and `const` / `enum` say, and its targets' and members'.
	const says = (s: Value, seen: ReadonlySet<string>): string[] | undefined => {
		if (!(s instanceof JsonObject)) return undefined;
		const uri = cx.ownResource(s);
		return uri === undefined
			? saysHere(s, seen)
			: cx.inResource(uri, () => saysHere(s, seen));
	};
	const saysHere = (
		s: JsonObject,
		seen: ReadonlySet<string>,
	): string[] | undefined => {
		const named: string[][] = [];
		const add = (k: string[] | undefined) => {
			if (k !== undefined) named.push(k);
		};
		// The target is the same value; in 3.0 the keywords next to $ref are ignored.
		for (const target of cx.reached(s))
			if (!seen.has(target.uri))
				add(
					cx.inTarget(target, () =>
						says(target.value, new Set([...seen, target.uri])),
					),
				);
		if (!cx.readsSiblings(s)) return meet(named);
		add(typeKinds(cx, s));
		add(valueKinds(s));
		const allOf = s.get("allOf");
		for (const m of Array.isArray(allOf) ? allOf : []) add(says(m, seen));
		for (const key of ["oneOf", "anyOf"]) {
			const members = s.get(key);
			if (!Array.isArray(members)) continue;
			const each = members.map((m) => says(m, seen));
			if (each.every((k) => k !== undefined)) add([...new Set(each.flat())]);
		}
		return meet(named);
	};
	const named: string[][] = [];
	const own = says(v, new Set());
	if (own !== undefined) named.push(own);
	if (around)
		for (const s of cx.around)
			for (const t of [typeKinds(cx, s), valueKinds(s)])
				if (t !== undefined) named.push(t);
	return meet(named);
}

/** The kinds of the values `const` or `enum` lists, which say the kinds as `type` does; undefined without them. */
function valueKinds(v: JsonObject): string[] | undefined {
	const c = v.get("const");
	const values = c === undefined ? v.get("enum") : [c];
	if (!Array.isArray(values)) return undefined;
	return [
		...new Set(
			values.map((x) =>
				x === null
					? "null"
					: Array.isArray(x)
						? "array"
						: x instanceof JsonObject
							? "object"
							: x instanceof JsonNumber
								? "number"
								: typeof x === "string"
									? "string"
									: "boolean",
			),
		),
	];
}

/** Keywords that only apply to objects; their presence implies `type: object`. */
export function hasObjectKeywords(v: JsonObject): boolean {
	return (
		[
			"properties",
			"patternProperties",
			"additionalProperties",
			"required",
		].some((k) => v.get(k) !== undefined) ||
		unevaluated(v, "unevaluatedProperties") !== undefined ||
		// maxProperties 0 says what keys an object has (none); other counts admit every object.
		count(v, "maxProperties") === 0
	);
}

/**
 * The kinds a schema without `type` is of, its keywords being of the kinds `keyed`
 * (`own`); undefined where its keywords say one kind, as `own` reads them then.
 */
export function keywordsOf(
	cx: Ctx,
	v: JsonObject,
	keyed: string[],
): string[] | undefined {
	const passes = cx.around.length > 0 && typelessKinds(cx, v).length > 0;
	const said = saidKinds(cx, v, !passes);
	if (said !== undefined)
		return [
			...keyed.filter((k) => said.includes(k)),
			...said.filter((k) => !keyed.includes(k)),
		];
	const context = contextKinds(cx, v);
	const several = keyed.filter(
		(k) => k === "object" || k === "array" || (!passes && context.includes(k)),
	);
	return several.length > 1 ? several : undefined;
}

/** Keywords that only apply to arrays and that the type reads; their presence implies `type: array`. */
export function hasArrayKeywords(v: JsonObject): boolean {
	return (
		["items", "prefixItems", "minItems", "maxItems"].some(
			(k) => v.get(k) !== undefined,
		) || unevaluated(v, "unevaluatedItems") !== undefined
	);
}
