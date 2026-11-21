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
import { type Ctx, child, DiagError, type RawPosition } from "./pointer.ts";
import { MAX_UNION, patternType } from "./template.ts";
import {
	array as arrayTy,
	BLOB,
	BOOLEAN,
	equalValues,
	INTEGER,
	inter,
	type Keyed,
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

/** Keywords that apply subschemas to the same value: they decide what `unevaluated*` see. */
const APPLICATORS = [
	"allOf",
	"oneOf",
	"anyOf",
	"$ref",
	"$dynamicRef",
	"if",
	"dependentSchemas",
];

/**
 * `unevaluatedProperties` / `unevaluatedItems` where no applicator evaluates anything:
 * then they are `additionalProperties` / `items`. undefined where they are not that.
 */
function unevaluated(v: JsonObject, key: string): Value | undefined {
	return APPLICATORS.every((k) => v.get(k) === undefined)
		? v.get(key)
		: undefined;
}

/**
 * Accepts a `$schema` or `jsonSchemaDialect` that names the dialect kanagata reads: JSON
 * Schema 2020-12, or the OAS dialect built on it. Another dialect's keywords mean other
 * things (draft-07's array `items`, `dependencies`), so it is an error.
 */
export function readDialect(at: string, id: Value): void {
	const text = String(id);
	if (
		OAS_DIALECTS.some((prefix) => text.startsWith(prefix)) ||
		text.replace(/#$/, "") === "https://json-schema.org/draft/2020-12/schema"
	)
		return;
	throw new DiagError(
		at,
		`${JSON.stringify(id)} is a dialect kanagata does not read: it reads JSON Schema 2020-12, the OAS dialect`,
	);
}

const OAS_DIALECTS = [
	"https://spec.openapis.org/oas/3.1/dialect/",
	"https://spec.openapis.org/oas/3.2/dialect/",
];

/** Converts a schema. */
export function schema(cx: Ctx, v: Value, at: string): Ty {
	if (v === true) return UNKNOWN;
	if (v === false) return NEVER;
	if (!(v instanceof JsonObject)) return UNKNOWN; // not a schema
	// A 3.0 Schema Object has no $schema.
	const dialect = v.get("$schema");
	if (dialect !== undefined && cx.refSiblings)
		readDialect(child(at, "$schema"), dialect);
	// This schema is where `raw` says; the schemas in it are elsewhere unless they say.
	const saved = cx.here;
	cx.here = cx.raw;
	try {
		return cx.inSchema(() =>
			cx.withRaw(undefined, () => {
				// A schema with $id is a resource: $refs inside it resolve against its URI.
				const id = v.str("$id");
				if (id !== undefined && cx.refSiblings)
					return cx.inResource(cx.baseOf(id), () => convert(cx, v, at));
				return convert(cx, v, at);
			}),
		);
	} finally {
		cx.here = saved;
	}
}

/**
 * Whether a schema has bytes where it is: a binary string as a body or a part, or a
 * part that is one for a multipart body; through `$ref` and composition too.
 */
function binaryAt(
	cx: Ctx,
	v: Value,
	pos: RawPosition,
	seen = new Set<string>(),
): boolean {
	if (!(v instanceof JsonObject)) return false;
	const r = v.str("$ref");
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target !== undefined && !seen.has(target.uri)) {
		seen.add(target.uri);
		if (cx.withBase(target.base, () => binaryAt(cx, target.value, pos, seen)))
			return true;
	}
	const inPlace = ["allOf", "oneOf", "anyOf"].flatMap((k) => {
		const m = v.get(k);
		return Array.isArray(m) ? m : [];
	});
	if (inPlace.some((m) => binaryAt(cx, m, pos, seen))) return true;
	if (pos === "parts") {
		const props = v.get("properties");
		const pp = v.get("patternProperties");
		return [
			...(props instanceof JsonObject ? props.entries.map(([, s]) => s) : []),
			...(pp instanceof JsonObject ? pp.entries.map(([, s]) => s) : []),
			v.get("additionalProperties"),
		].some((s) => s !== undefined && binaryAt(cx, s, "part", seen));
	}
	const t = v.get("type");
	if (
		(t === "string" || (Array.isArray(t) && t.includes("string"))) &&
		isBinaryString(v)
	)
		return true;
	if (pos !== "part") return false;
	const prefix = v.get("prefixItems");
	return [v.get("items"), ...(Array.isArray(prefix) ? prefix : [])].some(
		(s) => s !== undefined && binaryAt(cx, s, "part", seen),
	);
}

function convert(cx: Ctx, v: JsonObject, at: string): Ty {
	return parts(cx, v, at);
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
		// The target is the same value, this schema's keywords around it.
		const target = cx.withAround(v, () => reference(cx, r, at));
		// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they
		// are ignored, nullable among them unless loose.
		if (!cx.refSiblings) return loose ? union([target, NULL]) : target;
		out.push(...admitted([v], [target]));
	}
	// $dynamicRef is $ref, except where it reaches a $dynamicAnchor: then it reaches the
	// one of that name in the outermost resource the value was reached through.
	const dr = v.str("$dynamicRef");
	if (dr !== undefined) {
		const target = cx.locate(dr, at);
		const name = new URL(target.uri).hash.slice(1);
		const outer = cx.isDynamicAnchor(target.uri)
			? cx.dynamicTarget(name)
			: undefined;
		out.push(cx.withAround(v, () => reference(cx, outer ?? dr, at)));
	}
	const c = v.get("const");
	if (c !== undefined) out.push(literal(c));
	const e = v.get("enum");
	if (Array.isArray(e)) out.push(union(e.map(literal)));
	// Every member is the same object: a property one member leaves out of this view
	// stays out even where another member lists it as required.
	const group = leftOutKeys(cx, v);
	for (const k of cx.leftOutIn(v)) group.add(k);
	const allOf = v.get("allOf");
	if (Array.isArray(allOf)) {
		const members = membersIn(cx, v, allOf, group, child(at, "allOf"));
		out.push(...passing(cx, v, allOf, admitted(allOf, members)));
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
			cx,
			v,
			members,
			closedAmong(
				cx,
				members,
				admitted(members, membersIn(cx, v, members, group, child(at, key))),
			),
		);
		out.push(
			union(
				key === "oneOf"
					? shared(exclusive(cx, members, tys, child(at, key), group))
					: tys,
			),
		);
	}
	// A key present asks what its dependent schema asks: without the key, or that schema.
	const ds = v.get("dependentSchemas");
	if (ds instanceof JsonObject) {
		const members = ds.entries.map(([, s]) => s);
		const tys = membersIn(
			cx,
			v,
			members,
			group,
			child(at, "dependentSchemas"),
			ds.entries.map(([k]) => k),
		);
		ds.entries.forEach(([key], i) => {
			out.push(
				widen(
					cx,
					v,
					"object",
					union([
						{ kind: "object", props: [{ key, ty: NEVER, optional: true }] },
						tys[i] as Ty,
					]),
				),
			);
		});
	}
	// The value is as `then` says where `if` admits it, and as `else` says where it does
	// not: TypeScript can say so where it can say which values `if` does not admit.
	const cond = v.get("if");
	if (
		cond !== undefined &&
		(v.get("then") !== undefined || v.get("else") !== undefined)
	) {
		const not = refuted(cx, cond, [v, ...cx.around]);
		if (not === undefined)
			cx.warn(
				child(at, "if"),
				"if / then / else cannot be expressed in TypeScript; ignored",
			);
		else {
			const branches = [cond, v.get("then") ?? true, v.get("else") ?? true];
			const [i, t, e] = membersIn(cx, v, branches, group, at, [
				"if",
				"then",
				"else",
			]).map((ty, k) => anyKind(cx, v, branches[k] as Value, ty));
			// Each kind `if` does not admit meets `else` on its own, so that `else` reads as that kind.
			const nots = not.kind === "union" ? not.items : [not];
			out.push(
				union([
					inter([i as Ty, t as Ty]),
					...nots.map((n) => inter([n, e as Ty])),
				]),
			);
		}
	}
	out.push(...unevaluatedParts(cx, v, at));
	out.push(...keywordParts(cx, v, at, group));
	out.push(...arrayTargets(cx, out, at));
	// The schema's own keywords drop the literals (from const, enum, members) they reject,
	// and `not: { enum }` those it lists.
	const t = inter(out);
	const members = t.kind === "union" ? t.items : [t];
	const out$ = excluded(v) ?? [];
	const listed = (m: Ty) =>
		out$.some(
			(x) =>
				x.kind === m.kind &&
				(m.kind !== "lit" ||
					x === m ||
					(x as { text: string }).text === m.text),
		);
	// The keywords are read where there are literals to drop.
	const admits = members.some((m) => m.kind === "lit")
		? admitting(cx, v)
		: () => true;
	const keep = (m: Ty) => admits(m) && !listed(m);
	const kept = members.every(keep) ? t : union(members.filter(keep));
	// A value `not` lists that a member may admit other than by listing it (`string` for
	// "a", a reference) stays.
	if (out$.some((x) => members.some((m) => mayAdmit(m, x))))
		cx.warn(child(at, "not"), "not cannot be expressed in TypeScript; ignored");
	return loose ? union([kept, NULL]) : kept;
}

/**
 * The keys a closed object admits (`additionalProperties: false`, no
 * `patternProperties`): its declared properties. undefined when it is not closed.
 */
function closedKeys(v: JsonObject): Set<string> | undefined {
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
function passing(cx: Ctx, v: JsonObject, members: Value[], tys: Ty[]): Ty[] {
	return tys.map((ty, i) => {
		const m = members[i];
		if (!(m instanceof JsonObject) || !typeless(m)) return ty;
		return widen(cx, v, hasObjectKeywords(m) ? "object" : "array", ty);
	});
}

/** The kinds `type` names, and null where 3.0's `nullable: true` adds it; undefined without `type`. */
function typeKinds(cx: Ctx, v: JsonObject): string[] | undefined {
	const t = v.get("type");
	const kinds =
		typeof t === "string"
			? [t]
			: Array.isArray(t)
				? t.filter((k): k is string => typeof k === "string")
				: undefined;
	if (kinds === undefined) return undefined;
	return !cx.refSiblings && v.get("nullable") === true
		? [...kinds, "null"]
		: kinds;
}

/** `ty`, a constraint on values of `kind` only, with the other kinds `type` names, which pass it. */
function widen(cx: Ctx, v: JsonObject, kind: string, ty: Ty): Ty {
	const kinds = typeKinds(cx, v);
	if (kinds === undefined) return ty;
	return union([
		ty,
		...kinds.filter((k) => k !== kind && k in KIND).map((k) => KIND[k] as Ty),
	]);
}

/**
 * What `dependentRequired`, `propertyNames`, `contains` and `not` say that TypeScript
 * can, as parts of the schema; a warning where they say more.
 */
function keywordParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	left: ReadonlySet<string>,
): Ty[] {
	const parts: Ty[] = [];
	// A key present requires the keys it lists: it is absent, or they are all present.
	// A key left out of this view is required on the other side only.
	for (const [key, deps] of dependencies(v)) {
		const names = deps.filter((d) => !left.has(d));
		if (names.length === 0) continue;
		parts.push(
			widen(
				cx,
				v,
				"object",
				union([
					{ kind: "object", props: [{ key, ty: NEVER, optional: true }] },
					{
						kind: "object",
						props: names.map((n) => ({ ...prop(n, UNKNOWN), present: true })),
					},
				]),
			),
		);
	}
	const names = v.get("propertyNames");
	if (names === false)
		parts.push(
			widen(cx, v, "object", { kind: "map", props: [], index: NEVER }),
		);
	else if (
		names !== undefined &&
		keyNames(names) === undefined &&
		keyPattern(names) === undefined
	)
		cx.warn(
			child(at, "propertyNames"),
			"propertyNames cannot be expressed in TypeScript; ignored",
		);
	// contains requires from minContains (1 if not given) to maxContains items that match
	// it; TypeScript can say how many, and which where every item matches or, for none,
	// where it can say the values contains does not admit.
	const contains = v.get("contains");
	if (contains !== undefined) {
		const min = count(v, "minContains") ?? 1;
		const max = count(v, "maxContains");
		const none =
			max === 0
				? (negation(contains) ?? notContained(cx, v, contains as JsonObject))
				: undefined;
		const items = (n: number): Ty[] => Array.from({ length: n }, () => UNKNOWN);
		if (max !== undefined && min > max)
			parts.push(widen(cx, v, "array", NEVER));
		else if (negation(contains) === NEVER) {
			// Every item matches: the length is from min to max.
			if (max !== undefined)
				parts.push(
					widen(cx, v, "array", { kind: "tuple", items: items(max), min }),
				);
			else if (min > 0)
				parts.push(
					widen(cx, v, "array", {
						kind: "tuple",
						items: items(min),
						min,
						rest: UNKNOWN,
					}),
				);
		} else if (none !== undefined)
			parts.push(widen(cx, v, "array", arrayTy(none)));
		else {
			if (min > 0)
				parts.push(
					widen(cx, v, "array", {
						kind: "tuple",
						items: items(min),
						min,
						rest: UNKNOWN,
					}),
				);
			cx.warn(
				child(at, "contains"),
				"contains: which items match it cannot be expressed in TypeScript; only how many is typed",
			);
			if (max !== undefined)
				cx.warn(
					child(at, "maxContains"),
					"maxContains cannot be expressed in TypeScript; ignored",
				);
		}
	}
	const n = v.get("not");
	if (n !== undefined) {
		const t = negation(n);
		if (t !== undefined) parts.push(t);
		else if (excluded(v) === undefined)
			cx.warn(
				child(at, "not"),
				"not cannot be expressed in TypeScript; ignored",
			);
	}
	return parts;
}

/**
 * The values `not` leaves, where TypeScript can say them: none for a schema that admits
 * everything, the other kinds for `not: { type }`, the objects without a key for
 * `not: { required }`. undefined otherwise (`not: false` leaves everything: unknown).
 */
function negation(n: Value): Ty | undefined {
	if (n === false) return UNKNOWN;
	// true, and anything else read as a schema that admits every value.
	if (!(n instanceof JsonObject)) return NEVER;
	const keys = n.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	if (keys.length === 0) return NEVER;
	if (keys.length !== 1) return undefined;
	if (keys[0] === "type") return otherKinds(n.get("type"));
	const req = n.get("required");
	if (keys[0] === "required" && Array.isArray(req)) return lacking(req);
	return undefined;
}

/** The values of the kinds `type` does not name; undefined for `integer` without `number`. */
function otherKinds(t: Value | undefined): Ty | undefined {
	const named = Array.isArray(t) ? t : [t];
	// Without number, an integer is a number TypeScript cannot leave out.
	if (named.includes("integer") && !named.includes("number")) return undefined;
	return union(
		["string", "number", "boolean", "null", "array", "object"]
			.filter((k) => !named.includes(k))
			.map((k) => KIND[k] as Ty),
	);
}

/** The objects without one of these keys. */
function lacking(names: Value[]): Ty {
	return union(
		names
			.filter((r): r is string => typeof r === "string")
			.map((key) => ({
				kind: "object",
				props: [{ key, ty: NEVER, optional: true }],
			})),
	);
}

/**
 * The values `if` does not admit, where TypeScript can say them: the other kinds for
 * `type`, the objects without a key for `required`, and for `properties` the objects with
 * a property it does not admit: of the other kinds for one with `type`, or of the values
 * the schema and the schemas around it declare the property with (`enum`, `const`) that
 * it rejects. undefined for any other `if`.
 */
function refuted(cx: Ctx, cond: Value, around: Value[]): Ty | undefined {
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
		else if (k === "properties" && x instanceof JsonObject) {
			for (const [p, s] of x.entries) {
				const t = rejected(cx, s, declared(cx, around, p));
				if (t === undefined) return undefined;
				if (t.kind !== "never")
					terms.push({
						kind: "object",
						props: [{ key: p, ty: t, optional: false, present: true }],
					});
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
	const keys = s.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	if (keys.length === 0) return NEVER;
	if (values !== undefined) {
		const verdicts = values.map((x) => accepts(cx, s, x));
		if (verdicts.every((a) => a !== undefined))
			return union(values.filter((_, i) => !verdicts[i]).map(literal));
	}
	return keys.length === 1 && keys[0] === "type"
		? otherKinds(s.get("type"))
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
	for (const s of schemas) {
		meet(listed(cx, get(get(s, "properties"), key), new Set()));
		const allOf = get(s, "allOf");
		if (Array.isArray(allOf)) meet(declared(cx, allOf, key, seen));
		const r = str(s, "$ref");
		const target = r === undefined ? undefined : cx.tryLocate(r);
		if (target !== undefined && !seen.has(target.uri)) {
			seen.add(target.uri);
			meet(
				cx.withBase(target.base, () => declared(cx, [target.value], key, seen)),
			);
		}
	}
	return out;
}

/** The values a schema lists (`enum`, `const`, `type: boolean` or `null`), through its `$ref`. */
function listed(
	cx: Ctx,
	s: Value | undefined,
	seen: Set<string>,
): Value[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const r = s.str("$ref");
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target !== undefined && !seen.has(target.uri)) {
		seen.add(target.uri);
		const values = cx.withBase(target.base, () =>
			listed(cx, target.value, seen),
		);
		if (values !== undefined) return values;
	}
	const c = s.get("const");
	if (c !== undefined) return [c];
	const e = s.get("enum");
	if (Array.isArray(e)) return e;
	const t = s.get("type");
	if (t === "boolean") return [true, false];
	return t === "null" ? [null] : undefined;
}

/** Keywords `accepts` decides for a literal value. */
const VALUE_KEYWORDS = new Set([
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"format",
]);

/** Whether a schema admits a value; undefined where it says what this cannot decide. */
function accepts(cx: Ctx, s: JsonObject, x: Value): boolean | undefined {
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
		} else return undefined;
	}
	return admitting(cx, s)(t);
}

/** Whether a JSON value is of a kind `type` names. */
function isOfKind(x: Value, kind: string): boolean {
	if (x === null) return kind === "null";
	if (typeof x === "string") return kind === "string";
	if (typeof x === "boolean") return kind === "boolean";
	if (x instanceof JsonNumber)
		return (
			kind === "number" || (kind === "integer" && isWhole(decimal(x.text)))
		);
	return kind === (Array.isArray(x) ? "array" : "object");
}

/** Whether two JSON values are equal, numbers by value. */
function sameValue(a: Value, b: Value): boolean {
	return equalValues(literal(a), literal(b));
}

/**
 * A member's type as the values it admits: one with keywords of one kind only (no `type`)
 * admits every value of the other kinds too, of those the schema and the schemas around
 * it can be (their `type`s; any kind where none has one).
 */
function anyKind(cx: Ctx, v: JsonObject, m: Value, ty: Ty): Ty {
	if (!(m instanceof JsonObject) || !typeless(m)) return ty;
	return orOther(cx, v, hasObjectKeywords(m) ? "object" : "array", ty);
}

/**
 * `ty`, a constraint on values of `kind` only, with the values of the other kinds the
 * schema and the schemas around it can be (their `type`s; any kind where none has one).
 */
function orOther(cx: Ctx, v: JsonObject, kind: string, ty: Ty): Ty {
	return union([
		ty,
		...contextKinds(cx, v)
			.filter((k) => k !== kind)
			.map((k) => KIND[k] as Ty),
	]);
}

/** The kinds the schema and the schemas around it can be: those their `type`s all name; any where none has one. */
function contextKinds(cx: Ctx, v: JsonObject): string[] {
	let kinds = [
		"string",
		"number",
		"integer",
		"boolean",
		"null",
		"array",
		"object",
	];
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
 * What a schema evaluates for `unevaluatedProperties` / `unevaluatedItems` wherever it
 * matches: property names, `patternProperties`, every key (`all`), the first `length`
 * items or every item (`rest`); and what its `oneOf` / `anyOf` members, `if` / `then` /
 * `else` and dependent schemas evaluate where they match, `cond` (`branches`). `keys` are
 * the keys it names, which a type can leave out. `contains` evaluates the items it
 * matches, and an `else` where TypeScript cannot say which values `if` does not admit
 * evaluates where no type says (`undecided`).
 */
interface Evaluated {
	names: Set<string>;
	patterns: string[];
	all: boolean;
	length: number;
	rest: boolean;
	contains: boolean;
	undecided: boolean;
	keys: Set<string>;
	branches: { cond: Ty; ev: Evaluated }[];
}

const nothingEvaluated = (): Evaluated => ({
	names: new Set(),
	patterns: [],
	all: false,
	length: 0,
	rest: false,
	contains: false,
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
	a.contains ||= b.contains;
	a.undecided ||= b.undecided;
	for (const k of b.keys) a.keys.add(k);
	a.branches.push(...b.branches);
}

/**
 * What a schema evaluates (see `Evaluated`); its own `unevaluated*` too unless `top`, the
 * schema they are read for.
 */
function evaluates(
	cx: Ctx,
	s: Value,
	at: string,
	top: boolean,
	seen: Set<string>,
): Evaluated {
	const ev = nothingEvaluated();
	if (!(s instanceof JsonObject)) return ev;
	const r = s.str("$ref");
	if (r !== undefined) {
		const target = cx.locate(r, at);
		if (!seen.has(target.uri)) {
			seen.add(target.uri);
			evaluateBoth(
				ev,
				cx.withBase(target.base, () =>
					evaluates(cx, target.value, target.where, false, seen),
				),
			);
		}
		// In 3.0 the keywords next to $ref are ignored.
		if (!cx.refSiblings) return ev;
	}
	const props = s.get("properties");
	for (const [k] of props instanceof JsonObject ? props.entries : []) {
		ev.names.add(k);
		ev.keys.add(k);
	}
	const pp = s.get("patternProperties");
	if (pp instanceof JsonObject) ev.patterns.push(...pp.entries.map(([k]) => k));
	ev.all =
		s.get("additionalProperties") !== undefined ||
		(!top && s.get("unevaluatedProperties") !== undefined);
	const prefix = s.get("prefixItems");
	ev.length = Array.isArray(prefix) ? prefix.length : 0;
	ev.rest =
		s.get("items") !== undefined ||
		(!top && s.get("unevaluatedItems") !== undefined);
	ev.contains = s.get("contains") !== undefined;
	for (const k of requiredKeys(cx, s)) ev.keys.add(k);
	for (const [k, names] of dependencies(s)) {
		ev.keys.add(k);
		for (const n of names) ev.keys.add(n);
	}
	for (const k of keyNames(s.get("propertyNames")) ?? []) ev.keys.add(k);
	const group = leftOutKeys(cx, s);
	for (const k of cx.leftOutIn(s)) group.add(k);
	const allOf = s.get("allOf");
	for (const [i, m] of (Array.isArray(allOf) ? allOf : []).entries())
		evaluateBoth(
			ev,
			cx.withAround(s, () =>
				evaluates(cx, m, child(child(at, "allOf"), String(i)), false, seen),
			),
		);
	// A member, if or dependent schema evaluates where it matches.
	const branch = (cond: Ty, e: Evaluated): void => {
		for (const k of e.keys) ev.keys.add(k);
		ev.contains ||= e.contains;
		ev.undecided ||= e.undecided;
		ev.branches.push({ cond, ev: e });
	};
	const inner = (m: Value, where: string) =>
		cx.withAround(s, () => evaluates(cx, m, where, false, seen));
	for (const key of ["oneOf", "anyOf"]) {
		const members = s.get(key);
		if (!Array.isArray(members)) continue;
		const tys = membersIn(cx, s, members, group, child(at, key));
		for (const [i, m] of members.entries())
			branch(tys[i] as Ty, inner(m, child(child(at, key), String(i))));
	}
	const cond = s.get("if");
	if (cond !== undefined) {
		const then = s.get("then") ?? true;
		const otherwise = s.get("else") ?? true;
		const [i, t, e] = membersIn(cx, s, [cond, then, otherwise], group, at, [
			"if",
			"then",
			"else",
		]) as [Ty, Ty, Ty];
		// if and then evaluate where if admits the value; else where it does not.
		const both = inner(cond, child(at, "if"));
		evaluateBoth(both, inner(then, child(at, "then")));
		branch(inter([i, t]), both);
		const not = refuted(cx, cond, [s, ...cx.around]);
		if (not === undefined) ev.undecided ||= otherwise !== true;
		else branch(inter([not, e]), inner(otherwise, child(at, "else")));
	}
	const ds = s.get("dependentSchemas");
	for (const [k, d] of ds instanceof JsonObject ? ds.entries : [])
		branch(
			{
				kind: "object",
				props: [{ key: k, ty: UNKNOWN, optional: false, present: true }],
			},
			inner(d, child(child(at, "dependentSchemas"), k)),
		);
	return ev;
}

/** The conditions under which some branch of `ev` evaluates `key`. */
function evaluating(ev: Evaluated, key: string): Ty[] {
	return ev.branches.flatMap(({ cond, ev: e }) =>
		e.all || e.names.has(key) || e.patterns.some((p) => matches(p, key))
			? [cond]
			: evaluating(e, key).map((c) => inter([cond, c])),
	);
}

/** Each branch of `ev` that evaluates more items than `length`: its condition and how many, or every one. */
function evaluatingItems(
	ev: Evaluated,
	length: number,
): { cond: Ty; length: number; rest: boolean }[] {
	return ev.branches.flatMap(({ cond, ev: e }) => {
		const n = Math.max(length, e.length);
		const own = { cond, length: n, rest: e.rest };
		return [
			own,
			...evaluatingItems(e, n).map((x) => ({
				...x,
				cond: inter([cond, x.cond]),
			})),
		];
	});
}

/**
 * `unevaluatedProperties` / `unevaluatedItems` next to an applicator: a key the schema
 * names that nothing evaluates wherever it is present is absent or as the keyword says,
 * and items past those evaluated are as it says (none for `false`).
 */
function unevaluatedParts(cx: Ctx, v: JsonObject, at: string): Ty[] {
	const up = v.get("unevaluatedProperties");
	const ui = v.get("unevaluatedItems");
	const asked = (x: Value | undefined) => x !== undefined && x !== true;
	if (!asked(up) && !asked(ui)) return [];
	if (APPLICATORS.every((k) => v.get(k) === undefined)) return [];
	const ev = evaluates(cx, v, at, true, new Set());
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
		for (const s of cx.around) for (const k of namedKeys(cx, s)) ev.keys.add(k);
		for (const key of ev.keys) {
			if (ev.names.has(key) || ev.patterns.some((p) => matches(p, key)))
				continue;
			parts.push(
				orOther(
					cx,
					v,
					"object",
					union([
						{ kind: "object", props: [{ key, ty, optional: true }] },
						...evaluating(ev, key),
					]),
				),
			);
		}
	}
	if (asked(ui) && !ev.rest) {
		if (ev.contains) warn("unevaluatedItems", ui);
		else {
			const ty = schema(cx, ui as Value, child(at, "unevaluatedItems"));
			const upTo = (n: number): Ty =>
				ty.kind === "never"
					? { kind: "tuple", items: Array(n).fill(UNKNOWN), min: 0 }
					: n === 0
						? arrayTy(ty)
						: {
								kind: "tuple",
								items: Array(n).fill(UNKNOWN),
								min: 0,
								rest: ty,
							};
			parts.push(
				orOther(
					cx,
					v,
					"array",
					union([
						upTo(ev.length),
						...evaluatingItems(ev, ev.length).map((b) =>
							b.rest ? b.cond : inter([b.cond, upTo(b.length)]),
						),
					]),
				),
			);
		}
	}
	return parts;
}

/** `dependentRequired`: each key and the keys it requires. */
function dependencies(v: JsonObject): [string, string[]][] {
	const dr = v.get("dependentRequired");
	return (dr instanceof JsonObject ? dr.entries : []).map(([key, deps]) => [
		key,
		Array.isArray(deps)
			? deps.filter((d): d is string => typeof d === "string")
			: [],
	]);
}

/**
 * The items of an array none of whose items `contains` admits, where `items` lists their
 * values: those values `contains` rejects. undefined where it cannot tell for one of them,
 * or where `prefixItems` types the first items, which need not be values `items` lists.
 */
function notContained(
	cx: Ctx,
	v: JsonObject,
	contains: JsonObject,
): Ty | undefined {
	const values = listed(cx, v.get("items"), new Set());
	if (values === undefined || v.get("prefixItems") !== undefined)
		return undefined;
	const admitted = values.map((x) => accepts(cx, contains, x));
	if (admitted.includes(undefined)) return undefined;
	return union(values.filter((_, i) => admitted[i] === false).map(literal));
}

/** The values `not: { enum }` or `not: { const }` leave out; undefined for any other `not`. */
function excluded(v: JsonObject): Ty[] | undefined {
	const n = v.get("not");
	if (!(n instanceof JsonObject)) return undefined;
	const keys = n.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	if (keys.length !== 1) return undefined;
	const e = n.get("enum");
	if (keys[0] === "enum" && Array.isArray(e)) return e.map(literal);
	const c = n.get("const");
	return keys[0] === "const" && c !== undefined ? [literal(c)] : undefined;
}

/** The keys `propertyNames: { enum }` or `{ const }` allow; undefined for any other. */
function keyNames(names: Value | undefined): string[] | undefined {
	if (!(names instanceof JsonObject)) return undefined;
	const keys = names.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	if (keys.length !== 1) return undefined;
	const e = names.get("enum");
	const c = names.get("const");
	const values =
		keys[0] === "enum" && Array.isArray(e) ? e : keys[0] === "const" ? [c] : [];
	const strings = values.filter((x): x is string => typeof x === "string");
	return strings.length > 0 ? strings : undefined;
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

/**
 * Members, converted knowing the keys the group leaves out of this view. A member that
 * is only a `$ref` to a schema naming one of them is written out without it: the
 * reference's own view would have it.
 */
function membersIn(
	cx: Ctx,
	parent: JsonObject,
	members: Value[],
	group: ReadonlySet<string>,
	at: string,
	tokens: string[] = members.map((_, i) => String(i)),
): Ty[] {
	// Members are the same value, so they are where it is, and the parent's keywords apply to it too.
	const here = cx.here;
	return cx.withLeftOut(members, group, () =>
		members.map((m, i) =>
			cx.withAround(parent, () =>
				cx.withRaw(here, () => {
					const where = child(at, tokens[i] as string);
					const r = str(m, "$ref");
					if (
						r === undefined ||
						group.size === 0 ||
						!(m as JsonObject).entries.every(
							([k]) => k === "$ref" || isAnnotation(k),
						)
					)
						return schema(cx, m, where);
					const { value, base, uri, where: there } = cx.locate(r, where);
					const named = cx.withBase(base, () => namedKeys(cx, value));
					const own = cx.withBase(base, () => leftOutKeys(cx, value));
					if (!named.some((k) => group.has(k) && !own.has(k)) || !cx.enter(uri))
						return schema(cx, m, where);
					try {
						return cx.withBase(base, () =>
							cx.withLeftOut([value], group, () => schema(cx, value, there)),
						);
					} finally {
						cx.leave();
					}
				}),
			),
		),
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

/** Whether a type may admit a value (from `const` / `enum`) other than by listing it. */
function mayAdmit(m: Ty, x: Ty): boolean {
	const of = (kinds: string[], t: Ty) => kinds.includes(t.kind);
	const objects = ["object", "map", "record"];
	if (of(["lit", "null", "blob"], m)) return false;
	if (of(["string", "number", "integer", "boolean"], m)) return byKind(m, x);
	if (of(objects, m)) return of(objects, x);
	if (of(["array", "tuple"], m)) return x.kind === "tuple";
	return true;
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
function exclusive(
	cx: Ctx,
	members: Value[],
	tys: Ty[],
	at: string,
	left: ReadonlySet<string>,
): Ty[] {
	// A key left out of this view is required on the other side only.
	const keys = members.map((m, i) =>
		keysOnly(cx, m, child(at, String(i)))?.filter((k) => !left.has(k)),
	);
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
	return (
		[
			"properties",
			"patternProperties",
			"additionalProperties",
			"required",
		].some((k) => v.get(k) !== undefined) ||
		unevaluated(v, "unevaluatedProperties") !== undefined
	);
}

/** The type given by `type`, or inferred from object / array keywords; `unknown` when neither says anything. */
function own(cx: Ctx, v: JsonObject, at: string): Ty {
	const type = v.get("type");
	if (typeof type === "string") return typed(cx, v, type, at);
	if (Array.isArray(type))
		return union(type.map((t) => typed(cx, v, t as string, at)));
	if (hasObjectKeywords(v)) return object(cx, v, at);
	if (hasArrayKeywords(v)) return array(cx, v, at);
	// Keywords for strings and numbers without type constrain those kinds alone.
	const s = text(v);
	const n = numeric(cx, v, false);
	if (s === STRING && n === NUMBER) return UNKNOWN;
	return union(
		contextKinds(cx, v).map((k) =>
			k === "string"
				? s
				: k === "number"
					? n
					: k === "integer"
						? numeric(cx, v, true)
						: (KIND[k] as Ty),
		),
	);
}

/** Keywords that only apply to arrays and that the type reads; their presence implies `type: array`. */
function hasArrayKeywords(v: JsonObject): boolean {
	return (
		["items", "prefixItems", "minItems", "maxItems"].some(
			(k) => v.get(k) !== undefined,
		) || unevaluated(v, "unevaluatedItems") !== undefined
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
	// Where bytes are bytes, a schema with them is written out here: its named type,
	// which is the same wherever it is used, has text.
	const here = cx.here;
	if (here !== undefined) {
		const located = cx.locate(r, at);
		if (cx.withBase(located.base, () => binaryAt(cx, located.value, here)))
			return expand(cx, located, cx.componentKey(located.value));
	}
	if (r.startsWith(SCHEMA_PREFIX) && cx.inDocument && !cx.dynamicScope) {
		const rest = r.slice(SCHEMA_PREFIX.length);
		if (!rest.includes("/")) {
			const name = unescapeToken(rest);
			if (!cx.schemas.has(name))
				throw new DiagError(at, `$ref target not found: ${r}`);
			return ref(name, cx.mode);
		}
	}
	const located = cx.locate(r, at);
	const { value: target, base, uri } = located;
	// A named type is the target as reached from the document. Where a $dynamicRef in it
	// reaches another $dynamicAnchor from here, it is written out here.
	if (cx.dynamicScope && rescoped(cx, target, base))
		return expand(cx, located, cx.componentKey(target));
	// An $anchor, $id or file naming a component schema refers to that type (except
	// in the component's own definition, which is what defines it).
	const key = cx.componentKey(target);
	if (key !== undefined) {
		if (at !== child("#/components/schemas", key)) return ref(key, cx.mode);
	} else if (cx.isFile(base) || cx.isHoisted(uri)) {
		return ref(cx.hoist(target, located), cx.mode);
	}
	return expand(cx, located, key);
}

/**
 * Whether a `$dynamicRef` in a schema (through its `$ref`s) reaches another
 * `$dynamicAnchor` from where it is now than from the document, through its own resource.
 */
function rescoped(cx: Ctx, target: Value, base: string): boolean {
	for (const name of dynamicNames(cx, target, base, new Set()))
		if (
			cx.dynamicTarget(name, [...cx.scope, base]) !==
			cx.dynamicTarget(name, [base])
		)
			return true;
	return false;
}

/** The names of the `$dynamicAnchor`s the `$dynamicRef`s in a schema reach, through its `$ref`s. */
function dynamicNames(
	cx: Ctx,
	v: Value,
	base: string,
	seen: Set<string>,
): Set<string> {
	const out = new Set<string>();
	const walk = (x: Value, base: string): void => {
		if (Array.isArray(x)) {
			for (const y of x) walk(y, base);
			return;
		}
		if (!(x instanceof JsonObject)) return;
		const id = x.str("$id");
		const here =
			id === undefined ? base : cx.withBase(base, () => cx.baseOf(id));
		for (const key of ["$ref", "$dynamicRef"]) {
			const r = x.str(key);
			const target =
				r === undefined ? undefined : cx.withBase(here, () => cx.tryLocate(r));
			if (target === undefined) continue;
			if (key === "$dynamicRef" && cx.isDynamicAnchor(target.uri))
				out.add(new URL(target.uri).hash.slice(1));
			if (!seen.has(target.uri)) {
				seen.add(target.uri);
				walk(target.value, target.base);
			}
		}
		for (const [k, y] of x.entries)
			if (!["const", "enum", "default", "example", "examples"].includes(k))
				walk(y, here);
	};
	walk(v, base);
	return out;
}

/** A `$ref`'s target written out where it is used, in the position the `$ref` is in. */
function expand(
	cx: Ctx,
	located: ReturnType<Ctx["locate"]>,
	key: string | undefined,
): Ty {
	const { value: target, base, uri, where } = located;
	// A schema reached again while it is expanded inline is a cycle: a component is
	// its name, another schema gets one, as a schema in another file does.
	if (!cx.enter(uri)) return ref(key ?? cx.hoist(target, located), cx.mode);
	try {
		const t = cx.inResource(base, () =>
			cx.withRaw(cx.here, () => schema(cx, target, where)),
		);
		// It reached itself, so it has a name now: every view refers to it by that.
		return cx.isHoisted(uri) ? ref(cx.hoist(target, located), cx.mode) : t;
	} finally {
		cx.leave();
	}
}

function typed(cx: Ctx, v: JsonObject, t: string, at: string): Ty {
	switch (t) {
		case "string":
			// Bytes are a Blob as a body or a part; in JSON, a form or a parameter, text.
			return isBinaryString(v) && (cx.here === "body" || cx.here === "part")
				? BLOB
				: text(v);
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

/**
 * A string: `""` where its lengths admit only it (`maxLength: 0`), none where they admit
 * none, and the template literal types of its `pattern` where they say its strings.
 */
function text(v: JsonObject): Ty {
	const max = count(v, "maxLength");
	if (max !== undefined && (count(v, "minLength") ?? 0) > max) return NEVER;
	if (max === 0) return lit('""');
	const pattern = v.str("pattern");
	return (pattern === undefined ? undefined : patternType(pattern)) ?? STRING;
}

/**
 * `numeric`'s type for each schema object, read once: a schema is converted again for
 * each view and place it is reached from, and its values can be thousands.
 */
const numerics = new WeakMap<JsonObject, Map<string, Ty>>();

/**
 * A number (an integer if `integer`), or the values its bounds admit where they are
 * finitely many: the integers, or the multiples of `multipleOf`, between them, as long
 * as TypeScript builds their union.
 */
function numeric(cx: Ctx, v: JsonObject, integer: boolean): Ty {
	// The bounds read the same in a document: as 3.0's or as 3.1's.
	const key = `${integer} ${cx.refSiblings}`;
	let known = numerics.get(v);
	if (known === undefined) {
		known = new Map();
		numerics.set(v, known);
	}
	const ty = known.get(key) ?? valuesBetween(cx, v, integer);
	known.set(key, ty);
	return ty;
}

function valuesBetween(cx: Ctx, v: JsonObject, integer: boolean): Ty {
	const { low, high } = bounds(cx, v);
	const any = integer ? INTEGER : NUMBER;
	if (low === undefined || high === undefined) return any;
	const order = compare(low.at, high.at);
	if (order > 0 || (order === 0 && (low.open || high.open))) return NEVER;
	const m = v.get("multipleOf");
	const step =
		m instanceof JsonNumber && decimal(m.text).digits > 0n
			? decimal(m.text)
			: undefined;
	if (!integer && step === undefined)
		return order === 0 ? lit(low.text) : NUMBER;
	// The values are the whole multiples of a unit: the step, or for integers the least
	// integer that is a multiple of it (1 without one).
	const unit: Decimal = !integer
		? (step as Decimal)
		: step === undefined
			? { digits: 1n, scale: 0 }
			: {
					digits: step.digits / gcd(step.digits, 10n ** BigInt(step.scale)),
					scale: 0,
				};
	// From the least multiple above low to the greatest below high.
	const above = (b: Bound) => {
		const [x, u] = aligned(b.at, unit);
		const q = x / u + (x % u > 0n ? 1n : 0n);
		return q + (b.open && x % u === 0n ? 1n : 0n);
	};
	const below = (b: Bound) => {
		const [x, u] = aligned(b.at, unit);
		const q = x / u - (x % u < 0n ? 1n : 0n);
		return q - (b.open && x % u === 0n ? 1n : 0n);
	};
	const first = above(low);
	const last = below(high);
	if (first > last) return NEVER;
	if (last - first >= BigInt(MAX_UNION)) return any;
	const values: Ty[] = [];
	for (let k = first; k <= last; k++) {
		const value = lit(
			unit.scale === 0
				? (k * unit.digits).toString()
				: decimalText({ digits: k * unit.digits, scale: unit.scale }),
		);
		boundedBy.set(value, v);
		values.push(value);
	}
	// Distinct literals in order are a union as it is.
	return values.length === 1
		? (values[0] as Ty)
		: { kind: "union", items: values };
}

/** The schema whose bounds each of `valuesBetween`'s values comes from: they admit it already. */
const boundedBy = new WeakMap<Ty, JsonObject>();

function gcd(a: bigint, b: bigint): bigint {
	return b === 0n ? a : gcd(b, a % b);
}

/** A decimal as JSON writes it: `-1.25`, `3`. */
function decimalText(d: Decimal): string {
	const sign = d.digits < 0n ? "-" : "";
	const digits = (d.digits < 0n ? -d.digits : d.digits)
		.toString()
		.padStart(d.scale + 1, "0");
	const int = digits.slice(0, digits.length - d.scale);
	const frac = digits.slice(digits.length - d.scale).replace(/0+$/, "");
	return `${sign}${int}${frac === "" ? "" : `.${frac}`}`;
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
 * JavaScript cannot read admits every string. The keywords are read once, for the many
 * literals a schema can list.
 */
function admitting(cx: Ctx, v: JsonObject): (t: Ty) => boolean {
	const minLength = count(v, "minLength") ?? 0;
	const maxLength = count(v, "maxLength");
	const pattern = v.str("pattern");
	const { low, high } = bounds(cx, v);
	const m = v.get("multipleOf");
	const step = m instanceof JsonNumber ? decimal(m.text) : undefined;
	// Without these keywords, every value is admitted: an enum's thousands are not looked at.
	if (
		minLength === 0 &&
		maxLength === undefined &&
		pattern === undefined &&
		low === undefined &&
		high === undefined &&
		step === undefined
	)
		return () => true;
	const beyond = (n: Decimal, b: Bound | undefined, sign: number) => {
		if (b === undefined) return false;
		const order = compare(n, b.at) * sign;
		return order < 0 || (order === 0 && b.open);
	};
	return (t) => {
		if (t.kind !== "lit" || boundedBy.get(t) === v) return true;
		if (t.text.startsWith('"')) {
			const s = JSON.parse(t.text) as string;
			const length = [...s].length;
			if (length < minLength) return false;
			if (maxLength !== undefined && length > maxLength) return false;
			return pattern === undefined || matches(pattern, s);
		}
		if (t.text === "true" || t.text === "false") return true;
		const n = decimal(t.text);
		if (beyond(n, low, 1) || beyond(n, high, -1)) return false;
		return step === undefined || isMultiple(n, step);
	};
}

/** Patterns compiled once each; null for one JavaScript cannot read. */
const compiled = new Map<string, RegExp | null>();

/** Whether `s` matches an ECMA-262 pattern; true when JavaScript cannot read the pattern. */
function matches(pattern: string, s: string): boolean {
	let re = compiled.get(pattern);
	if (re === undefined) {
		try {
			re = new RegExp(pattern, "u");
		} catch {
			re = null;
		}
		compiled.set(pattern, re);
	}
	return re === null || re.test(s);
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
 * which TypeScript bounds only item by item.
 */
function array(cx: Ctx, v: JsonObject, at: string): Ty {
	// unevaluatedItems is items where nothing else evaluates the rest.
	const key = v.get("items") === undefined ? "unevaluatedItems" : "items";
	const items =
		key === "items" ? v.get("items") : unevaluated(v, "unevaluatedItems");
	const prefix = v.get("prefixItems");
	// The items of a part are parts: an array repeats the field.
	const part = cx.here === "part" ? "part" : undefined;
	const head = Array.isArray(prefix)
		? cx.withRaw(part, () => list(cx, prefix, child(at, "prefixItems")))
		: [];
	const rest =
		items === undefined
			? UNKNOWN
			: items === false && Array.isArray(prefix)
				? undefined
				: cx.withRaw(part, () => schema(cx, items, child(at, key)));
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
	const r = str(v, "$ref");
	// In 3.0 the keywords next to $ref are ignored; in 3.1 and 3.2 they and the target
	// are one schema.
	if (r === undefined || cx.refSiblings) {
		const props = get(v, "properties");
		if (props instanceof JsonObject)
			for (const [k, s] of props.entries) if (isLeftOut(cx, s)) keys.add(k);
		const allOf = get(v, "allOf");
		for (const m of Array.isArray(allOf) ? allOf : [])
			for (const k of leftOutKeys(cx, m, seen)) keys.add(k);
	}
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target === undefined || seen.has(target.uri)) return keys;
	seen.add(target.uri);
	// The target's own $refs resolve against the document it is in.
	for (const k of cx.withBase(target.base, () =>
		leftOutKeys(cx, target.value, seen),
	))
		keys.add(k);
	return keys;
}

function object(cx: Ctx, v: JsonObject, at: string): Ty {
	// A multipart body's properties are its parts.
	const part = cx.here === "parts" ? "part" : undefined;
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
			ty: cx.withRaw(part, () => schema(cx, s, child(base, key))),
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

	// unevaluatedProperties is additionalProperties where nothing else evaluates the rest.
	const apKey =
		v.get("additionalProperties") === undefined
			? "unevaluatedProperties"
			: "additionalProperties";
	const ap =
		apKey === "additionalProperties"
			? v.get(apKey)
			: unevaluated(v, "unevaluatedProperties");
	let additional: Ty | undefined;
	if (ap === false) additional = NEVER;
	else if (ap === true) additional = UNKNOWN;
	else if (ap !== undefined)
		additional = cx.withRaw(part, () => schema(cx, ap, child(at, apKey)));
	const pp = v.get("patternProperties");
	const patterns =
		pp instanceof JsonObject
			? pp.entries.map(
					([key, s]) =>
						[
							key,
							cx.withRaw(part, () =>
								schema(cx, s, child(child(at, "patternProperties"), key)),
							),
						] as const,
				)
			: [];

	// A property a pattern matches has both types.
	for (const p of props) {
		const matched = patterns
			.filter(([k]) => matches(k, p.key))
			.map(([, t]) => t);
		if (matched.length > 0) p.ty = inter([p.ty, ...matched]);
	}

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

	// propertyNames that lists the keys closes the object over them: a declared property
	// it does not list cannot be there, and one it lists but nothing declares has the
	// value the patterns or additionalProperties give it.
	const allowed = keyNames(v.get("propertyNames"));
	if (allowed !== undefined) {
		if (props.some((p) => !p.optional && !allowed.includes(p.key)))
			return NEVER;
		const kept = props.map((p) =>
			allowed.includes(p.key) ? p : { ...p, ty: NEVER },
		);
		for (const name of allowed) {
			if (left.has(name) || kept.some((p) => p.key === name)) continue;
			const matched = patterns
				.filter(([p]) => matches(p, name))
				.map(([, t]) => t);
			const ty = matched.length > 0 ? inter(matched) : (additional ?? UNKNOWN);
			if (ty.kind !== "never") kept.push({ key: name, ty, optional: true });
		}
		return counted(v, kept);
	}

	// Keys a pattern matches have its type whatever additionalProperties says. A pattern
	// whose keys template literal types say keys index signatures by them, and a key it
	// names is a property; another pattern's type joins the index signature by any string.
	const keyed: { pattern: string; key: Ty; ty: Ty }[] = [];
	const unwritten: Ty[] = [];
	const named = (name: string, ty: Ty) => {
		if (left.has(name) || props.some((p) => p.key === name)) return;
		if (ty.kind !== "never") props.push({ key: name, ty, optional: true });
	};
	for (const [pattern, ty] of patterns) {
		const keys = patternType(pattern);
		if (keys === undefined) unwritten.push(ty);
		else
			for (const key of keys.kind === "union" ? keys.items : [keys])
				if (key.kind === "lit") named(JSON.parse(key.text) as string, ty);
				else keyed.push({ pattern, key, ty });
	}
	// An index signature admits each property it applies to, `undefined` too for an optional one.
	const admitting = (ty: Ty, applies: (key: string) => boolean): Ty => {
		const own = props.filter((p) => applies(p.key));
		return union([
			ty,
			...own.map((p) => p.ty),
			...(own.some((p) => p.optional) ? [UNDEFINED] : []),
		]);
	};
	const byPattern: Keyed[] = keyed.map((k) => ({
		key: k.key,
		ty: admitting(k.ty, (key) => matches(k.pattern, key)),
	}));
	const everyType = [
		...unwritten,
		...keyed.map((k) => k.ty),
		...props.map((p) => p.ty),
	];

	// propertyNames: { pattern } keys the object by it: a property it does not admit cannot
	// be there, a key it names is a property, and the others index signatures by its templates.
	const names = keyPattern(v.get("propertyNames"));
	if (names !== undefined) {
		const pattern = (v.get("propertyNames") as JsonObject).str(
			"pattern",
		) as string;
		if (props.some((p) => !p.optional && !matches(pattern, p.key)))
			return NEVER;
		for (const p of props) if (!matches(pattern, p.key)) p.ty = NEVER;
		const rest: Keyed[] = [];
		for (const key of names.kind === "union" ? names.items : [names])
			if (key.kind === "lit")
				named(JSON.parse(key.text) as string, additional ?? UNKNOWN);
			else if (additional?.kind !== "never")
				rest.push({
					key,
					ty: admitting(
						union([additional ?? UNKNOWN, ...everyType]),
						() => true,
					),
				});
		if (byPattern.length === 0 && rest.length === 0) return counted(v, props);
		return { kind: "map", props, keyed: [...byPattern, ...rest] };
	}

	if (additional === undefined) {
		if (byPattern.length === 0)
			return props.length === 0 ? RECORD : { kind: "object", props };
		// Without properties, other keys have any value, as for an object without either.
		return props.length === 0
			? { kind: "map", props, keyed: byPattern, index: UNKNOWN }
			: { kind: "map", props, keyed: byPattern };
	}
	// `additionalProperties: false` closes the object; TypeScript can only say so
	// when there are no properties at all, but its counts can say which are present.
	if (
		additional.kind === "never" &&
		byPattern.length === 0 &&
		unwritten.length === 0
	)
		return counted(v, props);
	const index =
		additional.kind === "never" && unwritten.length === 0
			? undefined
			: admitting(union([additional, ...everyType]), () => true);
	return {
		kind: "map",
		props,
		...(byPattern.length === 0 ? {} : { keyed: byPattern }),
		...(index === undefined ? {} : { index }),
	};
}

/** The keys a `propertyNames` with only `pattern` admits, as template literal types; undefined for any other, or a pattern none says. */
function keyPattern(names: Value | undefined): Ty | undefined {
	if (!(names instanceof JsonObject)) return undefined;
	const keys = names.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	const pattern = names.str("pattern");
	return keys.length === 1 && pattern !== undefined
		? patternType(pattern)
		: undefined;
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
