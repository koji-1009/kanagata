// Schema Object → `Ty`.
//
// A schema is a conjunction: every keyword constrains the same value. Each group of
// keywords ($ref, const, enum, allOf, the schema's own type keywords, oneOf, anyOf)
// gives one part, and the parts are intersected; `inter` then simplifies the
// combinations TypeScript would print badly (`string & "a"` is `"a"`). Adding a
// keyword means adding a part here, not another special case.
//
// Here are the entry points, the parts, references and the types of each kind; what the
// parts read is beside it: kinds.ts (which kinds a schema is), keys.ts and object.ts
// (keys and object types), not.ts (`not` and `if`), oneof.ts, unevaluated.ts, number.ts.

import { isBinaryMedia } from "./client.ts";
import {
	escapeToken,
	type JsonNumber,
	JsonObject,
	toJson,
	unescapeToken,
	type Value,
} from "./json.ts";
import {
	closedAmong,
	closedKeys,
	dependencies,
	forbid,
	leftOutKeys,
	leftOutTarget,
	outsideKeys,
	requiredKeys,
} from "./keys.ts";
import {
	anyKind,
	contextKinds,
	hasArrayKeywords,
	hasObjectKeywords,
	KIND,
	keywordKinds,
	keywordsOf,
	kindsOfMember,
	passed,
	passing,
	widen,
} from "./kinds.ts";
import { excluded, mayAdmit, negation, notContained, refuted } from "./not.ts";
import { admitting, count, numeric } from "./number.ts";
import { keyTerms, object, propertyKeys, readsKeys } from "./object.ts";
import { booleansListed, exclusive, shared } from "./oneof.ts";
import {
	type Ctx,
	child,
	DiagError,
	type Located,
	type RawPosition,
} from "./pointer.ts";
import { patternType } from "./template.ts";
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
	prop,
	ref,
	STRING,
	type Ty,
	tuple,
	UNKNOWN,
	union,
} from "./ty.ts";
import { saying, unevaluated, unevaluatedParts } from "./unevaluated.ts";

const SCHEMA_PREFIX = "#/components/schemas/";

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
				// Most schemas are no resource of their own: they are read where they are.
				const uri = cx.ownResource(v);
				return uri === undefined
					? convert(cx, v, at)
					: cx.inResource(uri, () => convert(cx, v, at));
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
	const uri = cx.ownResource(v);
	return uri === undefined
		? bytesIn(cx, v, pos, seen)
		: cx.inResource(uri, () => bytesIn(cx, v, pos, seen));
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
	if (!cx.readsSiblings(v)) return false;
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
export const REFS = new Set(["$ref", "$dynamicRef"]);

function convert(cx: Ctx, v: JsonObject, at: string): Ty {
	// The schemas in it with `contains` read what its `unevaluatedItems` says of their items.
	const said = saying(cx, v, at);
	return said === undefined
		? parts(cx, v, at)
		: cx.withSaid(v, said, () => parts(cx, v, at));
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
	return docText(
		v.str("description"),
		cx.readsSiblings(v) && v.get("deprecated") === true,
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
 * What a `$ref` or `$dynamicRef` of `v` refers to: the same value, the keywords of `v`
 * around it, but in 3.0, which ignores them next to `$ref`.
 */
function referenced(cx: Ctx, v: JsonObject, ref: string, at: string): Ty {
	// The keys left out beside the target: those it leaves out itself it is written without anyway.
	const beside = leftOutKeys(cx, v, new Set(), false);
	for (const k of cx.leftOutIn(v)) beside.add(k);
	return cx.withAround(
		cx.readsSiblings(v) ? v : undefined,
		() => leftOutTarget(cx, ref, at, beside) ?? reference(cx, ref, at),
	);
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
	const r = v.str("$ref");
	if (r !== undefined) {
		const t = referenced(cx, v, r, at);
		// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they
		// are ignored, nullable among them unless loose.
		if (!cx.readsSiblings(v)) return loose ? union([t, NULL]) : t;
		out.push(...admitted([v], [t]));
	}
	// $dynamicRef is $ref, except where it reaches a $dynamicAnchor: then it reaches the
	// one of that name in the outermost resource the value was reached through.
	const dr = v.str("$dynamicRef");
	if (dr !== undefined) {
		const outer = cx.dynamicAnchorOf(cx.locate(dr, at));
		out.push(...admitted([v], [referenced(cx, v, outer ?? dr, at)]));
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
	const not = excluded(v) ?? NOTHING_EXCLUDED;
	const out$ = not === NOTHING_EXCLUDED ? NO_TYS : not.map((x) => x.ty);
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
 * What most schemas, which have no `not`, exclude: one list for all of them. A list made
 * anew for each can be of another kind of array than those `parts` was compiled for, and
 * the engine then compiles `parts` again.
 */
const NOTHING_EXCLUDED: readonly { ty: Ty; at: string }[] = [];
const NO_TYS: readonly Ty[] = [];

/**
 * What a schema that is only a reference reaches: one `$ref` or `$dynamicRef`, with
 * annotations at most (anything next to a 3.0 `$ref`, which is ignored). undefined for
 * any other schema.
 */
export function onlyTarget(cx: Ctx, s: JsonObject): Located | undefined {
	const targets = cx.reached(s);
	return targets.length === 1 &&
		(!cx.readsSiblings(s) ||
			s.entries.every(([k]) => REFS.has(k) || isAnnotation(k)))
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
	// Each part is an array or a reference at most: one part is never two of them.
	if (out.length < 2) return [];
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
	const uri = cx.ownResource(v);
	return uri === undefined
		? ownNamesArrays(cx, v, seen)
		: cx.inResource(uri, () => ownNamesArrays(cx, v, seen));
}

function ownNamesArrays(cx: Ctx, v: JsonObject, seen: Set<string>): boolean {
	let viaRef = false;
	for (const target of cx.reached(v))
		viaRef ||=
			!seen.has(target.uri) &&
			cx.inTarget(target, () =>
				namesArrays(cx, target.value, new Set([...seen, target.uri])),
			);
	// In 3.0 the keywords next to $ref are ignored.
	if (viaRef || !cx.readsSiblings(v)) return viaRef;
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
	// Reached again while it is read, it asks nothing more there (see `propertyKeys`): the
	// outer reading warns of what it cannot say.
	else if (names !== undefined && !cx.readsKeysOf(names)) {
		// The keys are the strings it admits; a type of strings says the lengths only by
		// the keys it names (and `""`), not by templates or `string`, nor a pattern no
		// template says (one every string matches is `string`, and asks nothing).
		const keys = propertyKeys(cx, v, at);
		// `true` has no keywords.
		const s = names instanceof JsonObject ? names : new JsonObject();
		const lengths = [
			...((count(s, "minLength") ?? 0) > 0 ? ["minLength"] : []),
			...(count(s, "maxLength") !== undefined ? ["maxLength"] : []),
		];
		const pattern = s.str("pattern");
		if (
			keys === undefined ||
			(keys.kind === "string" &&
				(lengths.length > 0 ||
					(pattern !== undefined && patternType(pattern) === undefined)))
		)
			cx.warn(
				child(at, "propertyNames"),
				"propertyNames cannot be expressed in TypeScript; ignored",
			);
		else if (keyTerms(keys).some((k) => k.kind === "template"))
			for (const key of lengths)
				cx.warn(
					child(child(at, "propertyNames"), key),
					`${key} cannot be expressed in TypeScript; ignored`,
				);
	}
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

/** Members, converted knowing the keys the group leaves out of this view (see `leftOutTarget`). */
export function membersIn(
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
 * Keywords that do not change which values are valid: `format` among them, an annotation
 * in JSON Schema (`binary` changes the type only where bytes are bytes; see `typed`).
 */
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
	"format",
]);

export const isAnnotation = (k: string): boolean =>
	ANNOTATIONS.has(k) || k.startsWith("x-");

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
	// Keywords of no kind say none (most schemas without `type`: references, compositions).
	const of = keyed.length === 0 ? undefined : keywordsOf(cx, v, keyed);
	if (of !== undefined)
		return union(
			of.map((k) =>
				k === "object" || k === "array"
					? typed(cx, v, k, at)
					: passed(cx, v, k, [...cx.around]),
			),
		);
	if (hasObjectKeywords(v) || readsKeys(cx, v, at)) return object(cx, v, at);
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

function list(cx: Ctx, items: Value[], at: string): Ty[] {
	return items.map((item, i) => schema(cx, item, child(at, String(i))));
}

/** The exact type of a JSON value: objects become object types with every key required, arrays become closed tuples. */
export function literal(v: Value): Ty {
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
	// Strings read for keys are what the target admits, not a named type (see `propertyKeys`).
	if (cx.readingKeys) {
		const located = cx.locate(r, at);
		return expand(cx, located, cx.componentKey(located.value));
	}
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
export function text(v: JsonObject): Ty {
	const max = count(v, "maxLength");
	if (max !== undefined && (count(v, "minLength") ?? 0) > max) return NEVER;
	if (max === 0) return lit('""');
	const pattern = v.str("pattern");
	return (pattern === undefined ? undefined : patternType(pattern)) ?? STRING;
}

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
