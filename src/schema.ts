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
	toJson,
	unescapeToken,
	type Value,
} from "./json.ts";
import {
	type Ctx,
	child,
	DiagError,
	type Located,
	type Place,
	type RawPosition,
} from "./pointer.ts";
import {
	MAX_UNION,
	patternType,
	relation,
	strings,
	within,
} from "./template.ts";
import {
	array as arrayTy,
	BLOB,
	BOOLEAN,
	equal,
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
 * `unevaluatedProperties` / `unevaluatedItems` where nothing next to them evaluates: then
 * they are `additionalProperties` / `items`. undefined where they are not that.
 */
function unevaluated(v: JsonObject, key: string): Value | undefined {
	const x = v.get(key);
	if (x === undefined) return undefined;
	const evaluating =
		key === "unevaluatedItems" ? ITEM_APPLICATORS : APPLICATORS;
	return evaluating.every((k) => v.get(k) === undefined) ? x : undefined;
}

/** The keywords next to `unevaluatedItems` that evaluate for it: `contains` evaluates the items it matches. */
const ITEM_APPLICATORS = [...APPLICATORS, "contains"];

/**
 * The most cases of what evaluates the items (`itemCases`) read where branches have
 * `contains`: each set of them is one, so they double with each such branch. They are
 * members of one union, kept to as many as a union kanagata builds (`MAX_UNION`); time
 * grows with them about in proportion (65,536 take about 3 s).
 */
const MAX_CASES = MAX_UNION;

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
			cx.withRaw(undefined, () =>
				cx.inOwnResource(v, () => convert(cx, v, at)),
			),
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
	return cx.inOwnResource(v, () => bytesIn(cx, v, pos, seen));
}

function bytesIn(
	cx: Ctx,
	v: JsonObject,
	pos: RawPosition,
	seen: Set<string>,
): boolean {
	for (const target of cx.reached(v)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		if (cx.inTarget(target, () => binaryAt(cx, target.value, pos, seen)))
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

/** The keywords that reach another schema for the same value (see `Ctx.reached`). */
const REFS = new Set(["$ref", "$dynamicRef"]);

function convert(cx: Ctx, v: JsonObject, at: string): Ty {
	// The schemas in it with `contains` read what its `unevaluatedItems` says of their items.
	return cx.withSaid(v, saying(cx, v, at), () => parts(cx, v, at));
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
	// A member that requires a key this closed object forbids admits no object: no value,
	// or its arrays where its `type` or its keywords say it can be one. (A member that
	// requires a key is an object.)
	const closed = closedKeys(v);
	const admitted = (members: Value[], tys: Ty[]) =>
		closed === undefined
			? tys
			: tys.map((t, i) =>
					requiredKeys(cx, members[i] as Value).some((k) => !closed.has(k))
						? kindsOfMember(cx, members[i] as JsonObject).includes("array")
							? inter([t, KIND.array as Ty])
							: NEVER
						: t,
				);
	// The target is the same value, this schema's keywords around it.
	const target = (ref: string) => {
		// The keys left out beside the target: those it leaves out itself it is written without anyway.
		const beside = leftOutKeys(cx, v, new Set(), false);
		for (const k of cx.leftOutIn(v)) beside.add(k);
		return cx.withAround(
			v,
			() => leftOutTarget(cx, ref, at, beside) ?? reference(cx, ref, at),
		);
	};
	const r = v.str("$ref");
	if (r !== undefined) {
		const t = target(r);
		// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they
		// are ignored, nullable among them unless loose.
		if (!cx.refSiblings) return loose ? union([t, NULL]) : t;
		out.push(...admitted([v], [t]));
	}
	// $dynamicRef is $ref, except where it reaches a $dynamicAnchor: then it reaches the
	// one of that name in the outermost resource the value was reached through.
	const dr = v.str("$dynamicRef");
	if (dr !== undefined) {
		const outer = cx.dynamicAnchorOf(cx.locate(dr, at));
		out.push(...admitted([v], [target(outer ?? dr)]));
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
			union(key === "oneOf" ? shared(exclusive(cx, members, tys, group)) : tys),
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
					["object"],
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
	const not = excluded(v) ?? [];
	const out$ = not.map((x) => x.ty);
	const members = booleansListed(t.kind === "union" ? t.items : [t], out$);
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
	// "a", a reference) stays in that member: `not` is ignored where it leaves out nothing,
	// and for those values where it leaves out others.
	const stay = not.filter((x) => members.some((m) => mayAdmit(m, x.ty)));
	if (stay.length > 0 && !members.some(listed))
		cx.warn(child(at, "not"), "not cannot be expressed in TypeScript; ignored");
	else
		for (const x of stay)
			cx.warn(
				`${child(at, "not")}/${x.at}`,
				"not: leaving out this value cannot be expressed in TypeScript; ignored",
			);
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
 * The keys a schema requires: its own `required`, and those of the schemas its `$ref`
 * and `$dynamicRef` reach and of its `allOf` members.
 */
function requiredKeys(cx: Ctx, s: Value, seen = new Set<string>()): string[] {
	return keysOf(cx, s, seen, false);
}

/** The keys a schema names, as properties or as required, there or through `$ref`, `$dynamicRef` and `allOf`. */
function namedKeys(cx: Ctx, s: Value, seen = new Set<string>()): string[] {
	return keysOf(cx, s, seen, true);
}

function keysOf(
	cx: Ctx,
	s: Value,
	seen: Set<string>,
	properties: boolean,
): string[] {
	return cx.inOwnResource(s, () => ownKeysOf(cx, s, seen, properties));
}

function ownKeysOf(
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
	for (const target of cx.reached(s)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		keys.push(
			...cx.inTarget(target, () => keysOf(cx, target.value, seen, properties)),
		);
	}
	return keys;
}

/**
 * The keys a closed object's `$ref` and `$dynamicRef` targets (3.1, 3.2) and members
 * name that it does not declare: it admits none of them.
 */
function outsideKeys(cx: Ctx, v: JsonObject, closed: Set<string>): string[] {
	const named: string[] = [];
	for (const target of cx.reached(v))
		named.push(...cx.inTarget(target, () => namedKeys(cx, target.value)));
	for (const key of ["allOf", "oneOf", "anyOf"]) {
		const members = v.get(key);
		for (const m of Array.isArray(members) ? members : [])
			named.push(...namedKeys(cx, m));
	}
	return [...new Set(named)].filter((k) => !closed.has(k));
}

/** The keys a closed member admits: its own, or those of the closed schema its `$ref` or `$dynamicRef` alone reaches. */
function closedMember(cx: Ctx, s: Value): Set<string> | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	const target = onlyTarget(cx, s);
	if (target === undefined) return closedKeys(s);
	return target.value instanceof JsonObject
		? closedKeys(target.value)
		: undefined;
}

/**
 * What a schema that is only a reference reaches: one `$ref` or `$dynamicRef`, with
 * annotations at most. undefined for any other schema.
 */
function onlyTarget(cx: Ctx, s: JsonObject): Located | undefined {
	const targets = cx.reached(s);
	return targets.length === 1 &&
		s.entries.every(([k]) => REFS.has(k) || isAnnotation(k))
		? targets[0]
		: undefined;
}

/** The array types a component admits, and the types of the other values it admits. */
type Arrays = { ty: Ty; rest: Ty[] };

/**
 * The types of the components among `out` that admit arrays, where an array meets
 * them: the reference stays, and its type beside it lets the items read as it says
 * (`Tags & [unknown?]` is `Tags & [string?]`). TypeScript reads an item of an
 * intersection of arrays as one member's alone. Where something there admits arrays
 * only, a component's other values (`null` of `string[] | null`) meet none of it, and
 * its arrays alone are put beside it.
 */
function arrayTargets(cx: Ctx, out: Ty[], at: string): Ty[] {
	const isArray = (t: Ty) => t.kind === "array" || t.kind === "tuple";
	const arrays = out.filter(
		(t) => isArray(t) || (t.kind === "union" && t.items.some(isArray)),
	);
	const refs = out.filter(
		(t): t is Extract<Ty, { kind: "ref" }> =>
			t.kind === "ref" && cx.schemas.has(t.schema),
	);
	if (refs.length + arrays.length < 2) return [];
	const targets: Arrays[] = [];
	for (const t of refs) {
		const target = arrayOf(cx, t.schema, at);
		if (target !== undefined) targets.push(target);
	}
	if (targets.length + arrays.length < 2) return [];
	const only = arrays.some(isArray) || targets.some((t) => t.rest.length === 0);
	return targets.map((t) => (only ? t.ty : union([t.ty, ...t.rest])));
}

/** The arrays of a component that names arrays, through the components it is a `$ref` to. */
function arrayOf(cx: Ctx, name: string, at: string): Arrays | undefined {
	const located = cx.withBase(cx.documentBase, () =>
		cx.locate(SCHEMA_PREFIX + escapeToken(name), at),
	);
	const { value, uri, where } = located;
	// Only a schema that names arrays has array types; others are not converted for them.
	if (!cx.inTarget(located, () => namesArrays(cx, value)) || !cx.enter(uri))
		return undefined;
	try {
		return arraysIn(
			cx,
			cx.inTarget(located, () => schema(cx, value, where)),
			at,
		);
	} finally {
		cx.leave();
	}
}

/** The arrays of a type: an array or tuple, those of a component it refers to, or those among a union's members. */
function arraysIn(cx: Ctx, t: Ty, at: string): Arrays | undefined {
	if (t.kind === "array" || t.kind === "tuple") return { ty: t, rest: [] };
	if (t.kind === "ref" && cx.schemas.has(t.schema))
		return arrayOf(cx, t.schema, at);
	if (t.kind !== "union") return undefined;
	const arrays: Ty[] = [];
	const rest: Ty[] = [];
	for (const m of t.items) {
		const found = arraysIn(cx, m, at);
		if (found === undefined) rest.push(m);
		else {
			arrays.push(found.ty);
			rest.push(...found.rest);
		}
	}
	return arrays.length === 0 ? undefined : { ty: union(arrays), rest };
}

/**
 * Whether a schema names arrays, so that its type may have array types: by a `type` that
 * names `array`, `const` / `enum` with an array, array keywords without `type`, a `$ref`
 * or `$dynamicRef` to such a schema, or an `allOf`, `oneOf` or `anyOf` member that is one.
 */
function namesArrays(cx: Ctx, v: Value, seen = new Set<string>()): boolean {
	if (!(v instanceof JsonObject)) return false;
	return cx.inOwnResource(v, () => ownNamesArrays(cx, v, seen));
}

function ownNamesArrays(cx: Ctx, v: JsonObject, seen: Set<string>): boolean {
	const viaRef = cx
		.reached(v)
		.some(
			(target) =>
				!seen.has(target.uri) &&
				cx.inTarget(target, () =>
					namesArrays(cx, target.value, new Set([...seen, target.uri])),
				),
		);
	// In 3.0 the keywords next to $ref are ignored.
	if (viaRef || (v.get("$ref") !== undefined && !cx.refSiblings)) return viaRef;
	const type = v.get("type");
	if (type === "array" || (Array.isArray(type) && type.includes("array")))
		return true;
	const c = v.get("const");
	const values = c === undefined ? v.get("enum") : [c];
	if (Array.isArray(values) && values.some((x) => Array.isArray(x)))
		return true;
	if (type === undefined && hasArrayKeywords(v)) return true;
	return ["allOf", "oneOf", "anyOf"].some((k) => {
		const members = v.get(k);
		return (
			Array.isArray(members) && members.some((m) => namesArrays(cx, m, seen))
		);
	});
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
function passed(
	cx: Ctx,
	m: Value,
	kind: string,
	around: Value[],
	seen: ReadonlySet<string> = new Set(),
): Ty {
	if (!(m instanceof JsonObject))
		return m === false ? NEVER : (KIND[kind] as Ty);
	return cx.inOwnResource(m, () => ownPassed(cx, m, kind, around, seen));
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
	if (m.get("$ref") !== undefined && !cx.refSiblings) return inter(parts);
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
function passing(cx: Ctx, v: JsonObject, members: Value[], tys: Ty[]): Ty[] {
	return tys.map((ty, i) => {
		const m = members[i] as Value;
		const kinds = typelessKinds(cx, m);
		return kinds.length === 0 ? ty : widen(cx, v, kinds, ty, m);
	});
}

/**
 * The kinds `type` names, and null where 3.0's `nullable: true` adds it; every kind where
 * it names one JSON Schema does not have; undefined without `type`.
 */
function typeKinds(cx: Ctx, v: JsonObject): string[] | undefined {
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
 * `type` names; without it, `severalKinds`), which pass it as the keywords of `v` for them
 * say, or as those of `m`, the member `ty` is of, and of its members (`passed`).
 */
function widen(cx: Ctx, v: JsonObject, kinds: string[], ty: Ty, m?: Value): Ty {
	const named = typeKinds(cx, v) ?? saidKinds(cx, v, false) ?? severalKinds(v);
	if (named === undefined) return ty;
	return union([
		ty,
		...named
			.filter((k) => !kinds.includes(k))
			.map((k) =>
				m === undefined
					? ofKind(cx, v, k)
					: passed(cx, m, k, [v, ...cx.around]),
			),
	]);
}

/** The kinds the keywords of a schema without `type` say it is, where they say several (`keywordKinds`); undefined otherwise. */
function severalKinds(v: JsonObject): string[] | undefined {
	const kinds = keywordKinds(v);
	return kinds.length > 1 ? kinds : undefined;
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
				["object"],
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
			widen(cx, v, ["object"], { kind: "map", props: [], index: NEVER }),
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
	// where it can say the values contains does not admit. An `unevaluatedItems: false`
	// beside it may say which, and then how many (see `saidHolders`).
	const contains = v.get("contains");
	if (contains !== undefined) {
		const min = count(v, "minContains") ?? 1;
		const max = count(v, "maxContains");
		const none = max === 0 ? notContained(cx, v, contains) : undefined;
		const items = (n: number): Ty[] => Array.from({ length: n }, () => UNKNOWN);
		if (max !== undefined && min > max)
			parts.push(widen(cx, v, ["array"], NEVER));
		else if (negation(contains) === NEVER) {
			// Every item matches: the length is from min to max.
			if (max !== undefined)
				parts.push(
					widen(cx, v, ["array"], { kind: "tuple", items: items(max), min }),
				);
			else if (min > 0)
				parts.push(
					widen(cx, v, ["array"], {
						kind: "tuple",
						items: items(min),
						min,
						rest: UNKNOWN,
					}),
				);
		} else if (none !== undefined) parts.push(widen(cx, v, ["array"], none));
		else {
			if (min > 0)
				parts.push(
					widen(cx, v, ["array"], {
						kind: "tuple",
						items: items(min),
						min,
						rest: UNKNOWN,
					}),
				);
			// minContains 0 without maxContains asks nothing; the type of the schema with the
			// unevaluatedItems that says which items match says how many.
			if ((min > 0 || max !== undefined) && !cx.containsSaid(v)) {
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
 * `not: { required }`, and what X admits for `not: { not: X }`. undefined otherwise
 * (`not: false` leaves everything: unknown).
 */
function negation(n: Value): Ty | undefined {
	if (n === false) return UNKNOWN;
	// true, and anything else read as a schema that admits every value.
	if (!(n instanceof JsonObject)) return NEVER;
	const keys = n.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
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
					typeof n === "string" && Object.hasOwn(KIND, n)
						? (KIND[n] as Ty)
						: UNKNOWN,
				),
			);
		else if (k === "required" && Array.isArray(x))
			// Values of the other kinds pass required.
			t = union([
				otherKinds("object") as Ty,
				{
					kind: "object",
					props: x
						.filter((r): r is string => typeof r === "string")
						.map((key) => ({ ...prop(key, UNKNOWN), present: true })),
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
	if (!named.every((k) => typeof k === "string" && Object.hasOwn(KIND, k)))
		return NEVER;
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
 * `type`, the objects without a key for `required`, the shorter arrays for `minItems` and
 * the longer for `maxItems`, and for `properties` the objects with
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
			meet(listed(cx, get(get(s, "properties"), key), new Set()));
			const allOf = get(s, "allOf");
			if (Array.isArray(allOf)) meet(declared(cx, allOf, key, seen));
			for (const target of cx.reached(s)) {
				if (seen.has(target.uri)) continue;
				seen.add(target.uri);
				meet(
					cx.inTarget(target, () => declared(cx, [target.value], key, seen)),
				);
			}
		});
	return out;
}

/** The values a schema lists (`enum`, `const`, `type: boolean` or `null`), through its `$ref` and `$dynamicRef`. */
function listed(
	cx: Ctx,
	s: Value | undefined,
	seen: Set<string>,
): Value[] | undefined {
	if (!(s instanceof JsonObject)) return undefined;
	return cx.inOwnResource(s, () => {
		for (const target of cx.reached(s)) {
			if (seen.has(target.uri)) continue;
			seen.add(target.uri);
			const values = cx.inTarget(target, () => listed(cx, target.value, seen));
			if (values !== undefined) return values;
		}
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
 * A member's type as the values it admits: one whose object or array keywords, or those of
 * its members, make it those kinds (no `type`) admits the values of the other kinds too,
 * of those the schema and the schemas around it can be (their `type`s; any kind where none
 * has one), as its keywords and its members' for them say.
 */
function anyKind(cx: Ctx, v: JsonObject, m: Value, ty: Ty): Ty {
	const kinds = typelessKinds(cx, m);
	return kinds.length === 0 ? ty : orOther(cx, v, kinds, ty, m);
}

/**
 * `ty`, a constraint on values of `kinds` only, with the values of the other kinds the
 * schema and the schemas around it can be (their `type`s; any kind where none has one),
 * as the keywords of `v` for them say, or as those of `m`, the member `ty` is of, and of
 * its members (`passed`).
 */
function orOther(
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
function contextKinds(cx: Ctx, v: JsonObject): string[] {
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
 * What a schema evaluates (see `Evaluated`); its own `unevaluated*` too unless `top`, the
 * schema they are read for. The conditions are converted when asked for.
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
	// What a schema in its own resource evaluates, a member or the target of a reference.
	const inner = (m: Value, where: string) =>
		cx.inOwnResource(m, () => evaluates(cx, m, where, false, seen));
	// A schema reached again inside itself evaluates nothing more; reached again
	// elsewhere, in another member, it evaluates there too.
	for (const target of cx.reached(s)) {
		if (seen.has(target.uri)) continue;
		seen.add(target.uri);
		evaluateBoth(
			ev,
			cx.inTarget(target, () => inner(target.value, target.where)),
		);
		seen.delete(target.uri);
	}
	// In 3.0 the keywords next to $ref are ignored.
	if (s.get("$ref") !== undefined && !cx.refSiblings) return ev;
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
	for (const k of keyNames(s.get("propertyNames")) ?? []) ev.keys.add(k);
	const group = leftOutKeys(cx, s);
	for (const k of cx.leftOutIn(s)) group.add(k);
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
		evaluateBoth(both, member(then, child(at, "then")));
		branch(() => inter([tys()[0], tys()[1]]), both);
		const not = refuted(cx, cond, [s, ...cx.around]);
		if (not === undefined) ev.undecided ||= otherwise !== true;
		else
			branch(
				() => inter([not, tys()[2]]),
				member(otherwise, child(at, "else")),
			);
	}
	const ds = s.get("dependentSchemas");
	for (const [k, d] of ds instanceof JsonObject ? ds.entries : [])
		branch(
			() => ({
				kind: "object",
				props: [{ key: k, ty: UNKNOWN, optional: false, present: true }],
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
const asksOne = (h: JsonObject): boolean =>
	(count(h, "minContains") ?? 1) <= 1 && count(h, "maxContains") === undefined;

/**
 * The schemas with `contains` whose matching items the type of `v` says, its
 * `unevaluatedItems` being `false`, read when first asked for; undefined where it says none.
 */
function saying(
	cx: Ctx,
	v: JsonObject,
	at: string,
): (() => ReadonlySet<JsonObject>) | undefined {
	if (v.get("unevaluatedItems") !== false) return undefined;
	const ev = evaluates(cx, v, at, true, new Set());
	const read = ev.undecided || ev.rest ? undefined : itemCases(ev);
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
		const rest = ev.rest || parts.some((p) => p.rest);
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
			if (within.every((c) => c.length === 0 && sole(c, h))) return true;
			const group = branches.find((b) => b.top && isHolder(b, h.schema))?.group;
			return (
				asksOne(h.schema) &&
				group !== undefined &&
				evaluating.every((b) => b.group === group) &&
				within.every((c) => without(c, h.schema))
			);
		},
	);
	return new Set(said.map((h) => h.schema));
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
	const own = v.get("prefixItems");
	const prefix = Array.isArray(own) ? own.slice(0, length) : [];
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
	const matching = (n: number) =>
		marks.slice(0, n).filter(Boolean).length + Math.max(0, n - length);
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
function unevaluatedParts(cx: Ctx, v: JsonObject, at: string): Ty[] {
	// Where nothing next to them evaluates, they are additionalProperties / items (`unevaluated`).
	const next = (key: string) =>
		unevaluated(v, key) === undefined ? v.get(key) : undefined;
	const up = next("unevaluatedProperties");
	const ui = next("unevaluatedItems");
	const asked = (x: Value | undefined) => x !== undefined && x !== true;
	if (!asked(up) && !asked(ui)) return [];
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
					["object"],
					union([
						{ kind: "object", props: [{ key, ty, optional: true }] },
						...evaluating(ev, key),
					]),
				),
			);
		}
	}
	const read = asked(ui) && !ev.rest ? itemCases(ev) : undefined;
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
		const min = count(sole.schema, "minContains") ?? 1;
		const max = count(sole.schema, "maxContains");
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
 * The arrays none of whose items `contains` admits, where TypeScript can say it: of the
 * values `not` would leave, or, where `items` lists the values, of those `contains` rejects
 * past any `prefixItems` (whose items need not be values `items` lists). undefined where
 * it cannot tell.
 */
function notContained(cx: Ctx, v: JsonObject, contains: Value): Ty | undefined {
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
function excluded(v: JsonObject): { ty: Ty; at: string }[] | undefined {
	let n = v.get("not");
	let path = "";
	for (let x = notOnly(notOnly(n)); x !== undefined; x = notOnly(notOnly(n))) {
		n = x;
		path += "not/not/";
	}
	if (!(n instanceof JsonObject)) return undefined;
	const keys = n.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
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
	const keys = s.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
	return keys.length === 1 && keys[0] === "not" ? s.get("not") : undefined;
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
	const kinds = { made: new Set<string>(), all: new Set<string>() };
	if (!(m instanceof JsonObject)) return kinds;
	if (["type", "const", "enum"].some((k) => m.get(k) !== undefined))
		return undefined;
	return cx.inOwnResource(m, () => ownMadeKinds(cx, m, seen, kinds));
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
	const refs = [...REFS].filter((k) => m.get(k) !== undefined);
	const targets = cx.reached(m);
	// Each reference must reach its target; one seen on the way adds nothing.
	const read =
		targets.length === refs.length &&
		targets.every(
			(target) =>
				seen.has(target.uri) ||
				cx.inTarget(target, () =>
					add(target.value, true, new Set([...seen, target.uri])),
				),
		);
	if (!read) return undefined;
	// In 3.0 the keywords next to $ref are ignored.
	if (m.get("$ref") !== undefined && !cx.refSiblings) return kinds;
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
function kindsOfMember(cx: Ctx, m: JsonObject): string[] {
	return typeKinds(cx, m) ?? typelessKinds(cx, m);
}

/** Whether a schema is an object without `type`, `$ref`, `$dynamicRef`, `const` or `enum`. */
function isTypeless(m: Value | undefined): m is JsonObject {
	return (
		m instanceof JsonObject &&
		["type", ...REFS, "const", "enum"].every((k) => m.get(k) === undefined)
	);
}

/**
 * The kinds the keywords of a schema without `type` say it is, read with those of the
 * schemas it applies without `type`, `$ref`, `const` or `enum` (`allOf` / `oneOf` /
 * `anyOf` members, `if` / `then` / `else`, at any depth), which ask the same value: where
 * they make it an object or an array (`ownKinds`), those kinds, and strings and numbers
 * for their keywords among them. None otherwise: string and number keywords alone say
 * nothing of the kind.
 */
function keywordKinds(v: JsonObject): string[] {
	const kinds = new Set<string>();
	const read = (s: JsonObject) => {
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
				if (isTypeless(m)) read(m);
		}
		for (const key of ["if", "then", "else"]) {
			const b = s.get(key);
			if (isTypeless(b)) read(b);
		}
	};
	read(v);
	return kinds.has("object") || kinds.has("array") ? [...kinds] : [];
}

/**
 * The kinds the schema's `const` / `enum` and the `type`s and `const` / `enum` of its
 * members allow, at any depth: those of each `allOf` member, of its `$ref` and `$dynamicRef` targets, and of
 * every `oneOf` / `anyOf` member together (none where one says none); with `around`,
 * those of the schemas it is a member of too. undefined where none of them says any.
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
	// What a schema's `const` / `enum` and `type`s say (`self`: its own `type` and its `$ref`
	// and `$dynamicRef` targets' too), and its members'.
	const says = (
		s: Value,
		self: boolean,
		seen: ReadonlySet<string>,
	): string[] | undefined => {
		if (!(s instanceof JsonObject)) return undefined;
		return cx.inOwnResource(s, () => {
			const named: string[][] = [];
			const add = (k: string[] | undefined) => {
				if (k !== undefined) named.push(k);
			};
			if (self) {
				// The target is the same value; in 3.0 the keywords next to $ref are ignored.
				for (const target of cx.reached(s))
					if (!seen.has(target.uri))
						add(
							cx.inTarget(target, () =>
								says(target.value, true, new Set([...seen, target.uri])),
							),
						);
				if (s.get("$ref") !== undefined && !cx.refSiblings) return meet(named);
				add(typeKinds(cx, s));
			}
			add(valueKinds(s));
			const allOf = s.get("allOf");
			for (const m of Array.isArray(allOf) ? allOf : [])
				add(says(m, true, seen));
			for (const key of ["oneOf", "anyOf"]) {
				const members = s.get(key);
				if (!Array.isArray(members)) continue;
				const each = members.map((m) => says(m, true, seen));
				if (each.every((k) => k !== undefined)) add([...new Set(each.flat())]);
			}
			return meet(named);
		});
	};
	const named: string[][] = [];
	const own = says(v, false, new Set());
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

/** Members, converted knowing the keys the group leaves out of this view (see `leftOutTarget`). */
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
				cx.withRaw(here, () => schema(cx, m, child(at, tokens[i] as string))),
			),
		),
	);
}

/**
 * A `$ref`'s or `$dynamicRef`'s target written out without the keys the group leaves out
 * of this view, where it names one that it does not leave out itself: the reference's own
 * view would have it. Undefined where the reference stays.
 */
function leftOutTarget(
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
 * admit is in neither. It is left out of the members that list it; one that admits it
 * by its kind (`string` for `"a"`) keeps it in their union, as TypeScript cannot leave
 * it out of that; `boolean` is `true | false`, which it can. Other members, refs among
 * them, are not counted.
 */
function shared(tys: Ty[]): Ty[] {
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
function booleansListed(members: Ty[], values: Ty[]): Ty[] {
	const isBoolean = (t: Ty) =>
		t.kind === "lit" && (t.text === "true" || t.text === "false");
	if (!values.some(isBoolean)) return members;
	return members.flatMap((m) =>
		m.kind === "boolean" ? [literal(true), literal(false)] : [m],
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

/** Keywords that only apply to objects; their presence implies `type: object`. */
function hasObjectKeywords(v: JsonObject): boolean {
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

/** The type given by `type`, or inferred from object / array keywords; `unknown` when neither says anything. */
function own(cx: Ctx, v: JsonObject, at: string): Ty {
	const type = v.get("type");
	if (typeof type === "string") return typed(cx, v, type, at);
	if (Array.isArray(type))
		return union(type.map((t) => typed(cx, v, t as string, at)));
	// Object and array keywords say the value is of the kinds its keywords are of, each as
	// its keywords and its members' say, unless a `type` in its `allOf` members says the
	// kinds: then those kinds, the keywords constraining their own. So does a `type` around
	// it, except for a member whose other kinds the schemas around it pass (`passing`,
	// `typelessKinds`): it is of its object and array kinds.
	const keyed = keywordKinds(v);
	const passes = cx.around.length > 0 && typelessKinds(cx, v).length > 0;
	const said = keyed.length === 0 ? undefined : saidKinds(cx, v, !passes);
	const context = contextKinds(cx, v);
	const several = keyed.filter(
		(k) => k === "object" || k === "array" || (!passes && context.includes(k)),
	);
	const of =
		said !== undefined
			? [
					...keyed.filter((k) => said.includes(k)),
					...said.filter((k) => !keyed.includes(k)),
				]
			: several.length > 1
				? several
				: undefined;
	if (of !== undefined)
		return union(
			of.map((k) =>
				k === "object" || k === "array"
					? typed(cx, v, k, at)
					: passed(cx, v, k, [...cx.around]),
			),
		);
	if (hasObjectKeywords(v)) return object(cx, v, at);
	if (hasArrayKeywords(v)) return array(cx, v, at);
	// Keywords for strings and numbers without type constrain those kinds alone.
	const s = text(v);
	const n = numeric(cx, v, false);
	const kinds = contextKinds(cx, v);
	// The integers between the bounds say more where integers, not numbers, are a kind there.
	if (
		s === STRING &&
		n === NUMBER &&
		(kinds.includes("number") || numeric(cx, v, true) === INTEGER)
	)
		return UNKNOWN;
	return union(
		kinds.map((k) =>
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
		if (cx.inTarget(located, () => binaryAt(cx, located.value, here)))
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
		const here = cx.resourceOf(x) ?? base;
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
	// Whole by its exact value (`1e-400` is not), and one a JavaScript number holds.
	const value =
		n instanceof JsonNumber && isWhole(decimal(n.text))
			? Number(n.text)
			: Number.NaN;
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A readOnly property is not sent and a writeOnly one is not returned, even when
 * required. The keyword counts on the property schema, or on a schema it reaches
 * through `$ref`, `$dynamicRef` or an `allOf` member (`{ allOf: [{ $ref }], description }`).
 */
function isLeftOut(cx: Ctx, s: Value, seen = new Set<string>()): boolean {
	if (!(s instanceof JsonObject)) return false;
	return cx.inOwnResource(s, () => {
		// In 3.0 the keywords next to $ref are ignored; only the target counts.
		const siblings = s.get("$ref") === undefined || cx.refSiblings;
		if (
			siblings &&
			s.get(cx.mode === "write" ? "readOnly" : "writeOnly") === true
		)
			return true;
		for (const target of cx.reached(s)) {
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
	});
}

/**
 * The properties left out of this view: the schema's own, and those of its `allOf`
 * members, so that `required` next to `allOf` does not bring one back, and of its `$ref`
 * and `$dynamicRef` targets unless `throughRef` is false.
 */
function leftOutKeys(
	cx: Ctx,
	v: Value,
	seen = new Set<string>(),
	throughRef = true,
): Set<string> {
	return cx.inOwnResource(v, () => {
		const keys = new Set<string>();
		// In 3.0 the keywords next to $ref are ignored; in 3.1 and 3.2 they and the target
		// are one schema.
		if (get(v, "$ref") === undefined || cx.refSiblings) {
			const props = get(v, "properties");
			if (props instanceof JsonObject)
				for (const [k, s] of props.entries) if (isLeftOut(cx, s)) keys.add(k);
			const allOf = get(v, "allOf");
			for (const m of Array.isArray(allOf) ? allOf : [])
				for (const k of leftOutKeys(cx, m, seen)) keys.add(k);
		}
		for (const target of throughRef ? cx.reached(v) : []) {
			if (seen.has(target.uri)) continue;
			seen.add(target.uri);
			for (const k of cx.inTarget(target, () =>
				leftOutKeys(cx, target.value, seen),
			))
				keys.add(k);
		}
		return keys;
	});
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
	if (count(v, "maxProperties") === 0)
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

	// The value of a key without a property schema: what the patterns it matches admit,
	// or else additionalProperties; any value without either.
	const keyValue = (name: string): Ty => {
		const matched = patterns
			.filter(([p]) => matches(p, name))
			.map(([, t]) => t);
		return matched.length > 0 ? inter(matched) : (additional ?? UNKNOWN);
	};

	// A required key without a property schema must be present, with that value.
	for (const name of required) {
		if (left.has(name) || props.some((p) => p.key === name)) continue;
		const ty = keyValue(name);
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
			const ty = keyValue(name);
			if (ty.kind !== "never") kept.push({ key: name, ty, optional: true });
		}
		return counted(v, kept);
	}

	// Keys a pattern matches have its type whatever additionalProperties says. A pattern
	// whose keys template literal types say keys index signatures by them, and a key it
	// names is a property; another pattern's type joins the index signature by any string.
	// Patterns of the same template are one index signature of both types.
	const keyed: { pattern: string; key: Ty; text: string; tys: Ty[] }[] = [];
	const unwritten: { pattern: string; ty: Ty }[] = [];
	const named = (name: string, ty: Ty) => {
		if (left.has(name) || props.some((p) => p.key === name)) return;
		if (ty.kind !== "never") props.push({ key: name, ty, optional: true });
	};
	// A pattern every key matches leaves additionalProperties no key: its type is every other key's.
	const everyKey: Ty[] = [];
	// A template without any text names its keys, as a literal does: TypeScript keys no
	// index signature by them. Each has the type of every pattern that matches it.
	for (const [pattern, ty] of patterns) {
		const keys = patternType(pattern);
		if (keys === undefined) unwritten.push({ pattern, ty });
		else if (keys.kind === "string") everyKey.push(ty);
		else
			for (const key of keys.kind === "union" ? keys.items : [keys]) {
				const text = (key as { text: string }).text;
				const finite =
					key.kind === "lit"
						? [JSON.parse(text) as string]
						: strings(pattern, text);
				if (finite !== undefined)
					for (const name of finite) named(name, keyValue(name));
				else {
					const same = keyed.find((k) => k.text === text);
					if (same === undefined) keyed.push({ pattern, key, text, tys: [ty] });
					else same.tys.push(ty);
				}
			}
	}
	if (everyKey.length > 0) additional = inter(everyKey);
	// The patterns whose keys include all of a template's: each of its keys has their types.
	// Whether a pattern no template says matches all of them is not read.
	const including = (pattern: string, text: string | undefined) =>
		keyed.filter((k) => within(pattern, k.pattern).includes(text as string));
	const types = (pattern: string, text: string): Ty[] => [
		...including(pattern, text).flatMap((h) => h.tys),
		...everyKey,
	];
	// A key has the type of every signature that applies to it, as TypeScript reads them, and
	// a narrower one's type is within a wider one's, as TypeScript requires.
	const exact = keyed.map((k) => inter(types(k.pattern, k.text)));
	// An index signature admits each property it applies to, `undefined` too for an optional one.
	const admitting = (ty: Ty, applies: (key: string) => boolean): Ty => {
		const own = props.filter((p) => applies(p.key));
		return union([
			ty,
			...own.map((p) => p.ty),
			...(own.some((p) => p.optional) ? [UNDEFINED] : []),
		]);
	};
	// Read once the properties are all there.
	const keyedSignatures = (): Keyed[] =>
		keyed.map((k, i) => ({
			key: k.key,
			ty: admitting(exact[i] as Ty, (key) => matches(k.pattern, key)),
		}));
	const allTypes = (): Ty[] => [
		...unwritten.map((u) => u.ty),
		...exact,
		...props.map((p) => p.ty),
	];

	// propertyNames: { pattern } keys the object by it: a property it does not admit cannot
	// be there, a key it names is a property with the value the patterns or
	// additionalProperties give it, and the others index signatures by its templates.
	const names = keyPattern(v.get("propertyNames"));
	if (names !== undefined) {
		const pattern = (v.get("propertyNames") as JsonObject).str(
			"pattern",
		) as string;
		if (props.some((p) => !p.optional && !matches(pattern, p.key)))
			return NEVER;
		for (const p of props) if (!matches(pattern, p.key)) p.ty = NEVER;
		const keys = names.kind === "union" ? names.items : [names];
		const templates: Ty[] = [];
		for (const key of keys) {
			const text = (key as { text?: string }).text as string;
			const finite =
				key.kind === "lit"
					? [JSON.parse(text) as string]
					: strings(pattern, text);
			if (finite === undefined) templates.push(key);
			else for (const name of finite) named(name, keyValue(name));
		}
		// Where it names every key, those are the properties: no other key is admitted.
		if (templates.length === 0) return counted(v, props);
		// A pattern's signature keeps the keys propertyNames admits, where the templates say
		// which: all of them, those of its templates within the pattern's, or none.
		const signatures: Keyed[] = [];
		const add = (key: Ty, ty: Ty): void => {
			const text = (key as { text: string }).text;
			if (!signatures.some((s) => (s.key as { text: string }).text === text))
				signatures.push({ key, ty });
		};
		for (const [i, k] of keyed.entries()) {
			const applies = (key: string) => matches(k.pattern, key);
			const texts = templates.map((t) => (t as { text: string }).text);
			const how = within(k.pattern, pattern).includes(k.text)
				? []
				: texts.map((t) => relation([pattern, t], [k.pattern, k.text]));
			if (how.length === 0 || how.includes("meets"))
				add(k.key, admitting(exact[i] as Ty, applies));
			else
				for (const [j, t] of texts.entries())
					if (how[j] === "within")
						add(
							templates[j] as Ty,
							admitting(inter(types(pattern, t)), applies),
						);
		}
		// A template whose keys a pattern's include has that pattern's signature, and one a
		// pattern of every key matches has its type: additionalProperties applies to neither.
		const others = [
			...unwritten.map((u) => u.ty),
			...signatures.map((s) => s.ty),
			...props.map((p) => p.ty),
		];
		const rest = templates.flatMap((key): Keyed[] => {
			const text = (key as { text?: string }).text as string;
			if (including(pattern, text).length > 0) return [];
			const all = types(pattern, text);
			if (all.length === 0 && additional?.kind === "never") return [];
			const ty =
				all.length > 0 ? inter(all) : union([additional ?? UNKNOWN, ...others]);
			return [{ key, ty: admitting(ty, () => true) }];
		});
		if (signatures.length === 0 && rest.length === 0) return counted(v, props);
		return { kind: "map", props, keyed: [...signatures, ...rest] };
	}

	const byPattern = keyedSignatures();
	const everyType = allTypes();

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
