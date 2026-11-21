// Schema Object → `Ty`.
//
// A schema is a conjunction: every keyword constrains the same value. Each group of
// keywords ($ref, const, enum, allOf, the schema's own type keywords, oneOf, anyOf)
// gives one part, and the parts are intersected; `inter` then simplifies the
// combinations TypeScript would print badly (`string & "a"` is `"a"`). Adding a
// keyword means adding a part here, not another special case.

import { isBinaryMedia } from "./client.ts";
import {
	escapeToken,
	get,
	JsonNumber,
	JsonObject,
	str,
	toJson,
	unescapeToken,
	type Value,
} from "./json.ts";
import { type Ctx, child, DiagError } from "./pointer.ts";
import {
	array as arrayTy,
	BLOB,
	BOOLEAN,
	INTEGER,
	inter,
	lit,
	NEVER,
	NULL,
	NUMBER,
	type Prop,
	prop,
	RECORD,
	ref,
	STRING,
	type Ty,
	tuple,
	UNDEFINED,
	UNKNOWN,
	union,
} from "./ty.ts";

const SCHEMA_PREFIX = "#/components/schemas/";

/** Keywords that change which values are valid but have no TypeScript form: ignored, with a warning. */
const IGNORED: [keyword: string, message: string][] = [
	["not", "not cannot be expressed in TypeScript; ignored"],
	["if", "if / then / else cannot be expressed in TypeScript; ignored"],
	[
		"dependentSchemas",
		"dependentSchemas cannot be expressed in TypeScript; ignored",
	],
	[
		"dependentRequired",
		"dependentRequired cannot be expressed in TypeScript; ignored",
	],
	["propertyNames", "propertyNames cannot be expressed in TypeScript; ignored"],
	["contains", "contains cannot be expressed in TypeScript; ignored"],
	[
		"unevaluatedProperties",
		"unevaluatedProperties cannot be expressed in TypeScript; ignored",
	],
	[
		"unevaluatedItems",
		"unevaluatedItems cannot be expressed in TypeScript; ignored",
	],
	["$dynamicRef", "$dynamicRef is not supported; ignored"],
];

/** Converts a schema. */
export function schema(cx: Ctx, v: Value, at: string): Ty {
	if (v === true) return UNKNOWN;
	if (v === false) return NEVER;
	if (!(v instanceof JsonObject)) return UNKNOWN; // not a schema
	// A schema with $id is a resource: $refs inside it resolve against its URI.
	const id = v.str("$id");
	if (id !== undefined && cx.refSiblings)
		return cx.withBase(cx.baseOf(id), () => convert(cx, v, at));
	return convert(cx, v, at);
}

function convert(cx: Ctx, v: JsonObject, at: string): Ty {
	const t = parts(cx, v, at);
	// In 3.0 the keywords next to $ref have no effect, so ignoring them is no news.
	if (cx.refSiblings || v.str("$ref") === undefined)
		for (const [keyword, message] of IGNORED)
			if (v.get(keyword) !== undefined) cx.warn(child(at, keyword), message);
	return t;
}

/**
 * JSDoc text from an object's `description` and `deprecated`; `description` may be one
 * that replaces the object's (next to the `$ref` that reached it, in 3.1 and 3.2).
 */
export function doc(
	v: JsonObject,
	description = v.str("description"),
): string | undefined {
	return docText(description, v.get("deprecated") === true);
}

/**
 * A schema's JSDoc: in 3.0 the keywords next to `$ref` are ignored, `deprecated` among
 * them; `description` is read there too (docs/types.md).
 */
export function schemaDoc(cx: Ctx, v: Value): string | undefined {
	if (!(v instanceof JsonObject)) return undefined;
	const siblings = cx.refSiblings || v.get("$ref") === undefined;
	return docText(
		v.str("description"),
		siblings && v.get("deprecated") === true,
	);
}

function docText(
	description: string | undefined,
	deprecated: boolean,
): string | undefined {
	const desc = description?.trim() || undefined;
	if (!deprecated) return desc;
	return desc === undefined ? "@deprecated" : `${desc}\n@deprecated`;
}

/**
 * `nullable: true` (3.0 only; 3.1 has no such keyword) adds `null` to the `type` next
 * to it, and only then; the other keywords still apply to `null` (OAS 3.0.3). With
 * `looseNullable` it adds `null` to whatever the rest of the schema gives (see docs/types.md).
 */
function parts(cx: Ctx, v: JsonObject, at: string): Ty {
	const nullable = !cx.refSiblings && v.get("nullable") === true;
	const loose = nullable && cx.looseNullable;
	const out: Ty[] = [];
	// A member that requires a key this closed object forbids admits no value.
	const closed = closedKeys(v);
	const admitted = (members: Value[], tys: Ty[]) =>
		closed === undefined
			? tys
			: tys.map((t, i) =>
					requiredKeys(cx, members[i] as Value).some((k) => !closed.has(k))
						? NEVER
						: t,
				);
	const r = v.str("$ref");
	if (r !== undefined) {
		const target = reference(cx, r, at);
		// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they
		// are ignored, nullable among them unless loose.
		if (!cx.refSiblings) return loose ? union([target, NULL]) : target;
		out.push(...admitted([v], [target]));
	}
	const c = v.get("const");
	if (c !== undefined) out.push(literal(c));
	const e = v.get("enum");
	if (Array.isArray(e)) out.push(union(e.map(literal)));
	const allOf = v.get("allOf");
	if (Array.isArray(allOf)) {
		// Every member is the same object: a property one member leaves out of this
		// view stays out even where another member lists it as required.
		const group = leftOutKeys(cx, v);
		for (const k of cx.leftOutIn(v)) group.add(k);
		const members = cx.withLeftOut(allOf, group, () =>
			list(cx, allOf, child(at, "allOf")),
		);
		out.push(...passing(v, allOf, admitted(allOf, members)));
	}
	// A closed object admits no key its $ref target or members have but it does not;
	// one without properties already says so (`{ [key: string]: never }`).
	const self =
		closed === undefined || closed.size === 0
			? own(cx, v, at)
			: forbid(own(cx, v, at), outsideKeys(cx, v, closed));
	const typedNull = nullable && !loose && v.get("type") !== undefined;
	out.push(typedNull ? union([self, NULL]) : self);
	// `discriminator` is not read: it must not change what the schema accepts (OAS 3.0.4, 3.1.1),
	// and a member is narrowed by the property only where the member itself fixes it.
	for (const key of ["oneOf", "anyOf"]) {
		const members = v.get(key);
		if (!Array.isArray(members)) continue;
		const tys = passing(
			v,
			members,
			closedAmong(
				cx,
				members,
				admitted(members, list(cx, members, child(at, key))),
			),
		);
		out.push(
			union(
				key === "oneOf"
					? shared(exclusive(cx, members, tys, child(at, key)))
					: tys,
			),
		);
	}
	out.push(...arrayTargets(cx, out, at));
	// The schema's own keywords drop the literals (from const, enum, members) they reject.
	const t = inter(out);
	const members = t.kind === "union" ? t.items : [t];
	const kept = members.every((m) => admitsLiteral(cx, v, m))
		? t
		: union(members.filter((m) => admitsLiteral(cx, v, m)));
	return loose ? union([kept, NULL]) : kept;
}

/**
 * The keys a closed object admits (`additionalProperties: false`, no
 * `patternProperties`): its declared properties. undefined when it is not closed.
 */
function closedKeys(v: JsonObject): Set<string> | undefined {
	if (v.get("additionalProperties") !== false) return undefined;
	if (v.get("patternProperties") !== undefined) return undefined;
	const props = v.get("properties");
	return new Set(
		props instanceof JsonObject ? props.entries.map(([k]) => k) : [],
	);
}

/**
 * The keys a schema requires: its own `required`, and those of the schema its `$ref`
 * reaches and of its `allOf` members.
 */
function requiredKeys(cx: Ctx, s: Value, seen = new Set<string>()): string[] {
	return keysOf(cx, s, seen, false);
}

/** The keys a schema names, as properties or as required, there or through `$ref` and `allOf`. */
function namedKeys(cx: Ctx, s: Value, seen = new Set<string>()): string[] {
	return keysOf(cx, s, seen, true);
}

function keysOf(
	cx: Ctx,
	s: Value,
	seen: Set<string>,
	properties: boolean,
): string[] {
	const req = get(s, "required");
	const keys = Array.isArray(req)
		? req.filter((n): n is string => typeof n === "string")
		: [];
	const props = get(s, "properties");
	if (properties && props instanceof JsonObject)
		keys.push(...props.entries.map(([k]) => k));
	const allOf = get(s, "allOf");
	for (const m of Array.isArray(allOf) ? allOf : [])
		keys.push(...keysOf(cx, m, seen, properties));
	const r = str(s, "$ref");
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target === undefined || seen.has(target.uri)) return keys;
	seen.add(target.uri);
	// The target's own $refs resolve against the document it is in.
	return [
		...keys,
		...cx.withBase(target.base, () =>
			keysOf(cx, target.value, seen, properties),
		),
	];
}

/**
 * The keys a closed object's `$ref` target (3.1, 3.2) and members name that it does not
 * declare: it admits none of them.
 */
function outsideKeys(cx: Ctx, v: JsonObject, closed: Set<string>): string[] {
	const named: string[] = [];
	const r = v.str("$ref");
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target !== undefined)
		named.push(...cx.withBase(target.base, () => namedKeys(cx, target.value)));
	for (const key of ["allOf", "oneOf", "anyOf"]) {
		const members = v.get(key);
		for (const m of Array.isArray(members) ? members : [])
			named.push(...namedKeys(cx, m));
	}
	return [...new Set(named)].filter((k) => !closed.has(k));
}

/** The keys a closed member admits: its own, or those of the closed schema its `$ref` alone reaches. */
function closedMember(cx: Ctx, s: Value): Set<string> | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const r = s.str("$ref");
	if (
		r === undefined ||
		!s.entries.every(([k]) => k === "$ref" || isAnnotation(k))
	)
		return closedKeys(s);
	const target = cx.tryLocate(r);
	return target?.value instanceof JsonObject
		? closedKeys(target.value)
		: undefined;
}

/**
 * The array types of the components among `out` that are arrays, where another array
 * meets them: the reference stays, and its type beside it lets the items read as it
 * says (`Tags & [unknown?]` is `Tags & [string?]`). TypeScript reads an item of an
 * intersection of arrays as one member's alone.
 */
function arrayTargets(cx: Ctx, out: Ty[], at: string): Ty[] {
	const isArray = (t: Ty) => t.kind === "array" || t.kind === "tuple";
	const arrays = out.filter(isArray).length;
	const refs = out.filter(
		(t): t is Extract<Ty, { kind: "ref" }> =>
			t.kind === "ref" && cx.schemas.has(t.schema),
	);
	if (refs.length + arrays < 2) return [];
	const targets: Ty[] = [];
	for (const t of refs) {
		const { value, base, uri, where } = cx.withBase(cx.documentBase, () =>
			cx.locate(SCHEMA_PREFIX + escapeToken(t.schema), at),
		);
		// Only an array schema has an array type.
		const type = get(value, "type");
		const array =
			type === "array" ||
			(type === undefined &&
				value instanceof JsonObject &&
				hasArrayKeywords(value));
		if (!array || !cx.enter(uri)) continue;
		try {
			const target = cx.withBase(base, () => schema(cx, value, where));
			if (isArray(target)) targets.push(target);
		} finally {
			cx.leave();
		}
	}
	return targets.length > 0 && targets.length + arrays > 1 ? targets : [];
}

/** The type of each value kind `type` names. */
const KIND: Record<string, Ty> = {
	string: STRING,
	number: NUMBER,
	integer: INTEGER,
	boolean: BOOLEAN,
	null: NULL,
	array: arrayTy(UNKNOWN),
	object: RECORD,
};

/**
 * A member without `type` whose keywords are all of one kind (`{ required: [a] }`,
 * `{ minItems: 1 }`) constrains only values of that kind. Where the schema's own `type`
 * (or `nullable: true`, 3.0) names other kinds, their values pass the member.
 */
function passing(v: JsonObject, members: Value[], tys: Ty[]): Ty[] {
	const t = v.get("type");
	const kinds = typeof t === "string" ? [t] : Array.isArray(t) ? t : undefined;
	if (kinds === undefined) return tys;
	if (v.get("nullable") === true && !kinds.includes("null")) kinds.push("null");
	return tys.map((ty, i) => {
		const m = members[i];
		if (!(m instanceof JsonObject) || !typeless(m)) return ty;
		const kind = hasObjectKeywords(m) ? "object" : "array";
		const others = kinds.filter(
			(k): k is string => typeof k === "string" && k !== kind && k in KIND,
		);
		return union([ty, ...others.map((k) => KIND[k] as Ty)]);
	});
}

/** Whether a schema says nothing but keywords of one kind, without `type`. */
function typeless(m: JsonObject): boolean {
	return (
		["type", "$ref", "const", "enum", "allOf", "oneOf", "anyOf"].every(
			(k) => m.get(k) === undefined,
		) &&
		(hasObjectKeywords(m) || hasArrayKeywords(m))
	);
}

/** A closed oneOf / anyOf member admits no key another member names. */
function closedAmong(cx: Ctx, members: Value[], tys: Ty[]): Ty[] {
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
function forbid(t: Ty, keys: string[]): Ty {
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
 * oneOf admits a value only one member admits, so a literal or `null` two members
 * admit is in neither. TypeScript can leave it out only where no member admits it by
 * its kind (`string` for `"a"`); other members, refs among them, are not counted.
 */
function shared(tys: Ty[]): Ty[] {
	const listed = (t: Ty): Ty[] => (t.kind === "union" ? t.items : [t]);
	const same = (a: Ty, b: Ty) =>
		a.kind === b.kind &&
		(a.kind !== "lit" || a.text === (b as { text: string }).text);
	const values = tys
		.flatMap(listed)
		.filter((m) => m.kind === "lit" || m.kind === "null");
	const out = new Set<Ty>();
	for (const value of values) {
		if (tys.some((t) => listed(t).some((m) => byKind(m, value)))) continue;
		if (tys.filter((t) => listed(t).some((m) => same(m, value))).length > 1)
			out.add(value);
	}
	if (out.size === 0) return tys;
	const drop = [...out];
	return tys.map((t) =>
		union(listed(t).filter((m) => !drop.some((d) => same(m, d)))),
	);
}

/** Whether a member admits a literal by its kind, not by listing it. */
function byKind(m: Ty, value: Ty): boolean {
	if (m.kind === "unknown") return true;
	if (value.kind !== "lit") return false;
	const text = value.text;
	if (text.startsWith('"')) return m.kind === "string";
	if (text === "true" || text === "false") return m.kind === "boolean";
	return (
		m.kind === "number" || (m.kind === "integer" && isWhole(decimal(text)))
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
function exclusive(cx: Ctx, members: Value[], tys: Ty[], at: string): Ty[] {
	const keys = members.map((m, i) => keysOnly(cx, m, child(at, String(i))));
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

/** Keywords that do not change which values are valid. */
const ANNOTATIONS = new Set([
	"title",
	"description",
	"$comment",
	"default",
	"example",
	"examples",
	"deprecated",
	"externalDocs",
	"xml",
]);

const isAnnotation = (k: string): boolean =>
	ANNOTATIONS.has(k) || k.startsWith("x-");

/**
 * The keys a schema requires, when that is all it asks of an object: a non-empty
 * `required`, with at most `type: object`, properties that admit any value and
 * annotations; or a `$ref`, with annotations at most, to such a schema.
 */
function keysOnly(cx: Ctx, s: Value, at: string): string[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const r = s.str("$ref");
	if (r !== undefined)
		return s.entries.every(([k]) => k === "$ref" || isAnnotation(k))
			? follow(cx, r, at, (t, where) => keysOnly(cx, t, where))
			: undefined;
	const props = child(at, "properties");
	const allowed = s.entries.every(
		([k, x]) =>
			k === "required" ||
			isAnnotation(k) ||
			(k === "type" && x === "object") ||
			(k === "properties" &&
				x instanceof JsonObject &&
				x.entries.every(([p, ps]) => admitsAnyValue(cx, ps, child(props, p)))),
	);
	const req = s.get("required");
	return allowed && Array.isArray(req) && req.length > 0
		? req.filter((n): n is string => typeof n === "string")
		: undefined;
}

/** Whether a schema admits every value: `true`, annotations alone, or a `$ref` to such a schema next to them. */
function admitsAnyValue(cx: Ctx, s: Value, at: string): boolean {
	if (s === true) return true;
	if (!(s instanceof JsonObject)) return false;
	if (!s.entries.every(([k]) => k === "$ref" || isAnnotation(k))) return false;
	const r = s.str("$ref");
	return (
		r === undefined ||
		follow(cx, r, at, (t, where) => admitsAnyValue(cx, t, where))
	);
}

/** `f` on the schema a `$ref` reaches, with the base URI of the document it is in. */
function follow<T>(
	cx: Ctx,
	r: string,
	at: string,
	f: (target: Value, where: string) => T,
): T {
	const { value, base, where } = cx.locate(r, at);
	return cx.withBase(base, () => f(value, where));
}

/** Keywords that only apply to objects; their presence implies `type: object`. */
function hasObjectKeywords(v: JsonObject): boolean {
	return [
		"properties",
		"patternProperties",
		"additionalProperties",
		"required",
	].some((k) => v.get(k) !== undefined);
}

/** The type given by `type`, or inferred from object / array keywords; `unknown` when neither says anything. */
function own(cx: Ctx, v: JsonObject, at: string): Ty {
	const type = v.get("type");
	if (typeof type === "string") return typed(cx, v, type, at);
	if (Array.isArray(type))
		return union(type.map((t) => typed(cx, v, t as string, at)));
	if (hasObjectKeywords(v)) return object(cx, v, at);
	if (hasArrayKeywords(v)) return array(cx, v, at);
	return UNKNOWN;
}

/** Keywords that only apply to arrays and that the type reads; their presence implies `type: array`. */
function hasArrayKeywords(v: JsonObject): boolean {
	return ["items", "prefixItems", "minItems", "maxItems"].some(
		(k) => v.get(k) !== undefined,
	);
}

function list(cx: Ctx, items: Value[], at: string): Ty[] {
	return items.map((item, i) => schema(cx, item, child(at, String(i))));
}

/** The exact type of a JSON value: objects become object types with every key required, arrays become closed tuples. */
function literal(v: Value): Ty {
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
 * A component schema becomes a reference (named when emitted), and so does a schema
 * in another file, under a key of its own; any other target is expanded inline.
 */
function reference(cx: Ctx, r: string, at: string): Ty {
	if (r.startsWith(SCHEMA_PREFIX) && cx.inDocument) {
		const rest = r.slice(SCHEMA_PREFIX.length);
		if (!rest.includes("/")) {
			const name = unescapeToken(rest);
			if (!cx.schemas.has(name))
				throw new DiagError(at, `$ref target not found: ${r}`);
			return ref(name, cx.mode);
		}
	}
	const located = cx.locate(r, at);
	const { value: target, base, uri, where } = located;
	// An $anchor, $id or file naming a component schema refers to that type (except
	// in the component's own definition, which is what defines it).
	const key = cx.componentKey(target);
	if (key !== undefined) {
		if (at !== child("#/components/schemas", key)) return ref(key, cx.mode);
	} else if (cx.isFile(base)) {
		return ref(cx.hoist(target, located), cx.mode);
	}
	if (!cx.enter(uri)) {
		cx.warn(at, `circular $ref expanded as unknown: ${r}`);
		return UNKNOWN;
	}
	try {
		return cx.withBase(base, () => schema(cx, target, where));
	} finally {
		cx.leave();
	}
}

function typed(cx: Ctx, v: JsonObject, t: string, at: string): Ty {
	switch (t) {
		case "string":
			return isBinaryString(v) ? BLOB : text(v);
		case "integer":
			return numeric(cx, v, true);
		case "number":
			return numeric(cx, v, false);
		case "boolean":
			return BOOLEAN;
		case "null":
			return NULL;
		case "array":
			return array(cx, v, at);
		case "object":
			return object(cx, v, at);
		default:
			return UNKNOWN; // a type JSON Schema does not have says nothing
	}
}

/** A string, unless its lengths admit only `""` (`maxLength: 0`) or none. */
function text(v: JsonObject): Ty {
	const max = count(v, "maxLength");
	if (max === undefined) return STRING;
	if ((count(v, "minLength") ?? 0) > max) return NEVER;
	return max === 0 ? lit('""') : STRING;
}

/** A number (an integer if `integer`), unless its bounds admit only one or none. */
function numeric(cx: Ctx, v: JsonObject, integer: boolean): Ty {
	const { low, high } = bounds(cx, v);
	if (low === undefined || high === undefined)
		return integer ? INTEGER : NUMBER;
	const order = compare(low.at, high.at);
	if (order > 0 || (order === 0 && (low.open || high.open))) return NEVER;
	if (!integer) return order === 0 ? lit(low.text) : NUMBER;
	// The integers between the bounds: from the least one above low to the greatest below high.
	const first = ceil(low.at) + (low.open && isWhole(low.at) ? 1n : 0n);
	const last = floor(high.at) - (high.open && isWhole(high.at) ? 1n : 0n);
	if (first > last) return NEVER;
	return first === last ? lit(first.toString()) : INTEGER;
}

/** A bound on numbers: its value, as written, and whether it is exclusive. */
interface Bound {
	at: Decimal;
	text: string;
	open: boolean;
}

/**
 * The tightest lower and upper bound. In 3.1 and 3.2 (JSON Schema 2020-12)
 * `exclusiveMinimum` / `exclusiveMaximum` are numbers; in 3.0 they are booleans that
 * make `minimum` / `maximum` exclusive.
 */
function bounds(cx: Ctx, v: JsonObject): { low?: Bound; high?: Bound } {
	const num = (key: string, open: boolean): Bound | undefined => {
		const n = v.get(key);
		return n instanceof JsonNumber
			? { at: decimal(n.text), text: n.text, open }
			: undefined;
	};
	const side = (inclusive: string, exclusive: string, sign: number) => {
		if (!cx.refSiblings) return num(inclusive, v.get(exclusive) === true);
		const closed = num(inclusive, false);
		const open = num(exclusive, true);
		if (open === undefined) return closed;
		// The exclusive one is tighter unless the inclusive one is past it.
		return closed !== undefined && compare(closed.at, open.at) * sign > 0
			? closed
			: open;
	};
	const low = side("minimum", "exclusiveMinimum", 1);
	const high = side("maximum", "exclusiveMaximum", -1);
	return {
		...(low === undefined ? {} : { low }),
		...(high === undefined ? {} : { high }),
	};
}

/**
 * Whether a literal is one of the values a schema's own keywords for its kind admit:
 * lengths and `pattern` for strings, bounds and `multipleOf` for numbers. A pattern
 * JavaScript cannot read admits every string.
 */
function admitsLiteral(cx: Ctx, v: JsonObject, t: Ty): boolean {
	if (t.kind !== "lit") return true;
	if (t.text.startsWith('"')) {
		const s = JSON.parse(t.text) as string;
		const length = [...s].length;
		if (length < (count(v, "minLength") ?? 0)) return false;
		const max = count(v, "maxLength");
		if (max !== undefined && length > max) return false;
		const pattern = v.str("pattern");
		return pattern === undefined || matches(pattern, s);
	}
	if (t.text === "true" || t.text === "false") return true;
	const n = decimal(t.text);
	const { low, high } = bounds(cx, v);
	const beyond = (b: Bound | undefined, sign: number) => {
		if (b === undefined) return false;
		const order = compare(n, b.at) * sign;
		return order < 0 || (order === 0 && b.open);
	};
	if (beyond(low, 1) || beyond(high, -1)) return false;
	const m = v.get("multipleOf");
	return !(m instanceof JsonNumber) || isMultiple(n, decimal(m.text));
}

/** Whether `s` matches an ECMA-262 pattern; true when JavaScript cannot read the pattern. */
function matches(pattern: string, s: string): boolean {
	try {
		return new RegExp(pattern, "u").test(s);
	} catch {
		return true;
	}
}

/** A JSON number exactly: `digits` × 10^-`scale`. */
interface Decimal {
	digits: bigint;
	scale: number;
}

function decimal(text: string): Decimal {
	// A JsonNumber's text is in JSON's grammar.
	const [, int = "", frac = "", exp = "0"] =
		/^(-?\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) as RegExpExecArray;
	const scale = frac.length - Number(exp);
	const digits = BigInt(int + frac);
	return scale >= 0
		? { digits, scale }
		: { digits: digits * 10n ** BigInt(-scale), scale: 0 };
}

/** a and b over one scale. */
function aligned(a: Decimal, b: Decimal): [bigint, bigint] {
	const scale = Math.max(a.scale, b.scale);
	return [
		a.digits * 10n ** BigInt(scale - a.scale),
		b.digits * 10n ** BigInt(scale - b.scale),
	];
}

function compare(a: Decimal, b: Decimal): number {
	const [x, y] = aligned(a, b);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether a is a whole multiple of m; a `multipleOf` that is not positive admits all. */
function isMultiple(a: Decimal, m: Decimal): boolean {
	const [x, y] = aligned(a, m);
	return y <= 0n || x % y === 0n;
}

const isWhole = (d: Decimal): boolean =>
	d.digits % 10n ** BigInt(d.scale) === 0n;

function floor(d: Decimal): bigint {
	const unit = 10n ** BigInt(d.scale);
	const q = d.digits / unit;
	return d.digits < 0n && d.digits % unit !== 0n ? q - 1n : q;
}

const ceil = (d: Decimal): bigint =>
	-floor({ digits: -d.digits, scale: d.scale });

/**
 * Raw bytes: `format: binary` (3.0), or a binary `contentMediaType` without a
 * `contentEncoding` (3.1; with base64 and the like it is text).
 */
function isBinaryString(v: JsonObject): boolean {
	if (v.str("format") === "binary") return true;
	const media = v.str("contentMediaType");
	return (
		media !== undefined &&
		v.get("contentEncoding") === undefined &&
		isBinaryMedia(media)
	);
}

/**
 * An array, or a tuple where `prefixItems`, `minItems` or `maxItems` say more: the first
 * `minItems` items are required, `prefixItems` types the first ones and `items` the rest
 * (absent means any; false, next to `prefixItems`, none), and `maxItems` closes the tuple,
 * which TypeScript bounds only by writing out every item.
 */
function array(cx: Ctx, v: JsonObject, at: string): Ty {
	const items = v.get("items");
	const prefix = v.get("prefixItems");
	const head = Array.isArray(prefix)
		? list(cx, prefix, child(at, "prefixItems"))
		: [];
	const rest =
		items === undefined
			? UNKNOWN
			: items === false && Array.isArray(prefix)
				? undefined
				: schema(cx, items, child(at, "items"));
	const min = count(v, "minItems") ?? 0;
	const max = count(v, "maxItems");
	if (max !== undefined && max < min) return NEVER;
	if (rest === undefined && min > head.length) return NEVER;
	if (!Array.isArray(prefix) && min === 0 && max === undefined)
		return arrayTy(rest as Ty);
	const length = max ?? Math.max(head.length, min);
	const written = Array.from(
		{ length: rest === undefined ? Math.min(length, head.length) : length },
		(_, i) => head[i] ?? (rest as Ty),
	);
	return max !== undefined || rest === undefined
		? { kind: "tuple", items: written, min }
		: { kind: "tuple", items: written, min, rest };
}

/** A count keyword (`minItems`, `maxItems`): a non-negative integer, or undefined. */
function count(v: JsonObject, key: string): number | undefined {
	const n = v.get(key);
	const value = n instanceof JsonNumber ? Number(n.text) : Number.NaN;
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A readOnly property is not sent and a writeOnly one is not returned, even when
 * required. The keyword counts on the property schema, or on a schema it reaches
 * through `$ref` or an `allOf` member (`{ allOf: [{ $ref }], description }`).
 */
function isLeftOut(cx: Ctx, s: Value, seen = new Set<string>()): boolean {
	if (!(s instanceof JsonObject)) return false;
	const r = s.str("$ref");
	// In 3.0 the keywords next to $ref are ignored; only the target counts.
	const siblings = r === undefined || cx.refSiblings;
	if (
		siblings &&
		s.get(cx.mode === "write" ? "readOnly" : "writeOnly") === true
	)
		return true;
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target !== undefined && !seen.has(target.uri)) {
		seen.add(target.uri);
		// The target's own $refs resolve against the document it is in.
		if (cx.withBase(target.base, () => isLeftOut(cx, target.value, seen)))
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
 * members, so that `required` next to `allOf` does not bring one back.
 */
function leftOutKeys(cx: Ctx, v: Value, seen = new Set<string>()): Set<string> {
	const keys = new Set<string>();
	const props = get(v, "properties");
	if (props instanceof JsonObject)
		for (const [k, s] of props.entries) if (isLeftOut(cx, s)) keys.add(k);
	const allOf = get(v, "allOf");
	for (const m of Array.isArray(allOf) ? allOf : []) {
		const r = str(m, "$ref");
		if (r === undefined) {
			for (const k of leftOutKeys(cx, m, seen)) keys.add(k);
			continue;
		}
		const target = cx.tryLocate(r);
		if (target === undefined || seen.has(target.uri)) continue;
		const { value, base, uri } = target;
		seen.add(uri);
		// The target's own $refs resolve against the document it is in.
		for (const k of cx.withBase(base, () => leftOutKeys(cx, value, seen)))
			keys.add(k);
	}
	return keys;
}

function object(cx: Ctx, v: JsonObject, at: string): Ty {
	const req = v.get("required");
	const required = Array.isArray(req)
		? req.filter((n) => typeof n === "string")
		: [];
	const declaredValue = v.get("properties");
	const declared =
		declaredValue instanceof JsonObject ? declaredValue.entries : [];
	const props: Prop[] = [];
	const base = child(at, "properties");
	const left = leftOutKeys(cx, v);
	for (const k of cx.leftOutIn(v)) left.add(k);
	for (const [key, s] of declared) {
		if (left.has(key)) continue;
		const p: Prop = {
			key,
			ty: schema(cx, s, child(base, key)),
			optional: !required.includes(key),
		};
		if (!p.optional) p.present = true;
		const d = schemaDoc(cx, s);
		if (d !== undefined) p.doc = d;
		props.push(p);
	}
	// A closed object admits only its declared properties, so requiring another admits nothing.
	const closed = closedKeys(v);
	if (closed !== undefined && required.some((n) => !closed.has(n)))
		return NEVER;
	// maxProperties 0 admits no keys: the empty object, or nothing if one is required.
	const max = v.get("maxProperties");
	if (max instanceof JsonNumber && Number(max.text) === 0)
		return required.some((n) => !left.has(n))
			? NEVER
			: { kind: "map", props: [], index: NEVER };

	const ap = v.get("additionalProperties");
	let additional: Ty | undefined;
	if (ap === false) additional = NEVER;
	else if (ap === true) additional = UNKNOWN;
	else if (ap !== undefined)
		additional = schema(cx, ap, child(at, "additionalProperties"));
	const pp = v.get("patternProperties");
	const patterns =
		pp instanceof JsonObject
			? pp.entries.map(
					([key, s]) =>
						[
							key,
							schema(cx, s, child(child(at, "patternProperties"), key)),
						] as const,
				)
			: [];

	// A required key without a property schema must be present, with the value the
	// patterns it matches admit, or else additionalProperties; any value without either.
	for (const name of required) {
		if (left.has(name) || props.some((p) => p.key === name)) continue;
		const matched = patterns
			.filter(([p]) => matches(p, name))
			.map(([, t]) => t);
		const ty = matched.length > 0 ? inter(matched) : (additional ?? UNKNOWN);
		if (ty.kind === "never") return NEVER;
		props.push({ ...prop(name, ty), present: true });
	}

	// Keys matching a pattern are allowed whatever additionalProperties says. TypeScript
	// cannot check the pattern, so their types join the index signature.
	if (patterns.length > 0 && additional !== undefined) {
		const types = patterns.map(([, t]) => t);
		additional = union(
			additional.kind === "never" ? types : [additional, ...types],
		);
	}

	if (additional === undefined)
		return props.length === 0 ? RECORD : { kind: "object", props };
	// `additionalProperties: false` closes the object; TypeScript can only say so
	// when there are no properties at all, but its counts can say which are present.
	if (additional.kind === "never") return counted(v, props);
	// The index signature must admit every declared property too.
	const members = [additional, ...props.map((p) => p.ty)];
	if (props.some((p) => p.optional)) members.push(UNDEFINED);
	return { kind: "map", props, index: union(members) };
}

/**
 * A closed object, its properties all it can have: `minProperties` requires that many
 * of them (a union over which), `maxProperties` leaves out the others.
 */
function counted(v: JsonObject, props: Prop[]): Ty {
	if (props.length === 0) return { kind: "map", props: [], index: NEVER };
	const optional = props.filter((p) => p.optional).map((p) => p.key);
	const present = props.length - optional.length;
	const min = count(v, "minProperties") ?? 0;
	const max = count(v, "maxProperties") ?? props.length;
	if (min > Math.min(max, props.length) || present > max) return NEVER;
	const variant = (f: (p: Prop) => Prop): Ty => ({
		kind: "object",
		props: props.map((p) => (p.optional ? f(p) : p)),
	});
	const parts: Ty[] = [];
	if (min > present)
		parts.push(
			union(
				subsets(optional, min - present).map((keys) =>
					variant((p) =>
						keys.includes(p.key) ? { ...p, optional: false, present: true } : p,
					),
				),
			),
		);
	if (max < props.length)
		parts.push(
			union(
				subsets(optional, max - present).map((keys) =>
					variant((p) => (keys.includes(p.key) ? p : { ...p, ty: NEVER })),
				),
			),
		);
	return parts.length === 0 ? { kind: "object", props } : inter(parts);
}

/** The subsets of `items` with `size` members, in order. */
function subsets<T>(items: T[], size: number): T[][] {
	if (size === 0) return [[]];
	return items.flatMap((item, i) =>
		subsets(items.slice(i + 1), size - 1).map((rest) => [item, ...rest]),
	);
}
