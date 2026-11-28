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
import { escapeToken, JsonObject, unescapeToken, type Value } from "./json.ts";
import {
	closedAmong,
	closedKeys,
	dependencies,
	forbid,
	leftOutGroup,
	leftOutKeys,
	namedKeys,
	outsideKeys,
	requiredKeys,
} from "./keys.ts";
import {
	anyKind,
	contextKinds,
	hasArrayKeywords,
	hasObjectKeywords,
	keywordKinds,
	keywordsOf,
	kindsOfMember,
	passed,
	passing,
	passingTarget,
	text,
	valueKinds,
	widen,
} from "./kinds.ts";
import {
	excluded,
	listed,
	mayAdmit,
	notContained,
	refuted,
	refutedPast,
} from "./not.ts";
import {
	admitting,
	boundsTooWide,
	containsBounds,
	count,
	numeric,
} from "./number.ts";
import {
	object,
	propertyKeys,
	propertyNamesParts,
	readsKeys,
} from "./object.ts";
import { booleansListed, exclusive, shared } from "./oneof.ts";
import { type Ctx, child, DiagError, type RawPosition } from "./pointer.ts";
import { wideForSize } from "./template.ts";
import {
	absent,
	array as arrayTy,
	BLOB,
	BOOLEAN,
	COMBINATIONS_LEFT_OUT,
	INTEGER,
	inter,
	KIND_TY,
	leavingOut,
	literal,
	MANY_ITEMS,
	MAX_ITEMS,
	MAX_VALUES,
	MAX_WRITTEN,
	manyNote,
	NEVER,
	NULL,
	NUMBER,
	present,
	ref,
	STRING,
	type TupleTy,
	type Ty,
	UNKNOWN,
	union,
	type ValueKind,
	valueIdentity,
	writtenItems,
} from "./ty.ts";
import {
	type Evaluation,
	evaluation,
	saying,
	unevaluated,
	unevaluatedParts,
} from "./unevaluated.ts";
import { CONDITIONAL, DATA, members, REFS, SUBSCHEMAS } from "./vocab.ts";

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
export function schema(cx: Ctx, written: Value, at: string): Ty {
	if (written === true) return UNKNOWN;
	if (written === false) return NEVER;
	if (!(written instanceof JsonObject)) return UNKNOWN; // not a schema
	const v = cx.schemaObject(written) as JsonObject;
	const dialect = v.get("$schema");
	if (dialect !== undefined) readDialect(child(at, "$schema"), dialect);
	// This schema is where `raw` says; the schemas in it are elsewhere unless they say.
	const saved = cx.here;
	cx.here = cx.raw;
	try {
		return cx.inSchema(() =>
			cx.withRaw(undefined, () => {
				// Most schemas are no resource of their own: they are read where they are.
				return cx.inOwnResource(v, () => convert(cx, v, at));
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
	return cx.inOwnResource(v, () => bytesIn(cx, v, pos, seen));
}

function bytesIn(
	cx: Ctx,
	v: JsonObject,
	pos: RawPosition,
	seen: Set<string>,
): boolean {
	if (
		cx
			.eachTarget(v, seen, (t) => binaryAt(cx, t.value, pos, seen))
			.some(Boolean)
	)
		return true;
	if (!cx.readsSiblings(v)) return false;
	if (members(v).some((m) => binaryAt(cx, m, pos, seen))) return true;
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

/**
 * Resolves the `$ref`s and `$dynamicRef`s of a schema kanagata reads but does not convert
 * (a `not` or an `if` / `then` / `else` it ignores, `contains`), in it and in the schemas
 * they reach but components (which are converted), so that one that does not resolve is
 * an error where it is, as in a schema converted.
 */
function resolveRefs(
	cx: Ctx,
	v: Value | undefined,
	at: string,
	seen = new Set<string>(),
): void {
	if (!(v instanceof JsonObject)) return;
	const follow = (r: string): void => {
		const target = cx.locate(r, at);
		if (seen.has(target.uri) || cx.componentKey(target.value) !== undefined)
			return;
		seen.add(target.uri);
		cx.inTarget(target, () =>
			resolveRefs(cx, target.value, target.where, seen),
		);
	};
	cx.inOwnResource(v, () => {
		const r = v.str("$ref");
		if (r !== undefined) follow(r);
		// In 3.0 the keywords next to $ref are ignored.
		if (!cx.readsSiblings(v)) return;
		const dr = v.str("$dynamicRef");
		if (dr !== undefined) follow(dr);
		for (const [k, x] of v.entries) {
			const here = child(at, k);
			const holds = SUBSCHEMAS.get(k);
			if (holds === "schema") resolveRefs(cx, x, here, seen);
			else if (holds === "list" && Array.isArray(x))
				x.forEach((s, i) => {
					resolveRefs(cx, s, child(here, String(i)), seen);
				});
			else if (holds === "map" && x instanceof JsonObject)
				for (const [name, s] of x.entries)
					resolveRefs(cx, s, child(here, name), seen);
		}
	});
}

/** Whether a schema's `if` / `then` / `else` ask anything: `if` and `then` or `else`. */
function conditional(v: JsonObject): boolean {
	return (
		v.get("if") !== undefined &&
		(v.get("then") !== undefined || v.get("else") !== undefined)
	);
}

/**
 * What the conversion of a schema reads for several of its parts, each once, when first
 * asked: the keys left out of this view for its group (`leftOutGroup`), the keys its
 * `propertyNames` admits (`propertyKeys`), and what it evaluates for its own
 * `unevaluated*` (`Evaluation`).
 */
export interface Reading {
	readonly left: () => ReadonlySet<string>;
	readonly keys: () => Ty | undefined;
	readonly evaluation: Evaluation;
}

function convert(cx: Ctx, v: JsonObject, at: string): Ty {
	const keys = {
		left: once(() => leftOutGroup(cx, v)),
		keys: once(() => propertyKeys(cx, v, at)),
	};
	const read: Reading = { ...keys, evaluation: evaluation(cx, v, at, keys) };
	// The schemas in it with `contains` read what its `unevaluatedItems` says of their items.
	const said = saying(cx, v, at, read.evaluation);
	return said === undefined
		? parts(cx, v, at, read)
		: cx.withSaid(v, said, () => parts(cx, v, at, read));
}

/** `f`, run when first asked, and remembered. */
function once<T>(f: () => T): () => T {
	let done = false;
	let value: T;
	return () => {
		if (!done) {
			value = f();
			done = true;
		}
		return value;
	};
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

/** JSDoc text from a description, and `@deprecated` where the object is deprecated. */
export function docText(
	description: string | undefined,
	deprecated = false,
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
	// The keys left out beside the target, and those it leaves out itself, which it is
	// written without anyway (`leftOutTarget` leaves them aside).
	const beside = leftOutGroup(cx, v);
	return cx.withAround(
		cx.readsSiblings(v) ? v : undefined,
		() => leftOutTarget(cx, ref, at, beside) ?? reference(cx, ref, at),
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

/**
 * `nullable: true` (3.0 only; 3.1 has no such keyword) adds `null` to the `type` next
 * to it, and only then; the other keywords still apply to `null` (OAS 3.0.3). With
 * `looseNullable` it adds `null` to whatever the rest of the schema gives (see docs/types.md).
 * An intersection built for it that leaves out unions past `MAX_COMBINATIONS` is noted
 * here; one built for a schema it applies, there.
 */
function parts(cx: Ctx, v: JsonObject, at: string, read: Reading): Ty {
	const [t, left] = leavingOut(() => ownParts(cx, v, at, read));
	if (left) cx.info(at, COMBINATIONS_LEFT_OUT);
	return t;
}

function ownParts(cx: Ctx, v: JsonObject, at: string, read: Reading): Ty {
	const nullable = !cx.refSiblings && v.get("nullable") === true;
	const loose = nullable && cx.looseNullable;
	const r = v.str("$ref");
	// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they are
	// ignored, nullable among them unless loose.
	if (r !== undefined && !cx.readsSiblings(v)) {
		const t = referenced(cx, v, r, at);
		return loose ? union([t, NULL]) : t;
	}
	const closed = closedKeys(v);
	const admitted = admittedBy(cx, closed);
	const group = read.left();
	// A closed object admits no key its $ref target or members have but it does not;
	// one without properties already says so (`{ [key: string]: never }`).
	const self =
		closed === undefined || closed.size === 0
			? () => own(cx, v, at, read)
			: () => forbid(own(cx, v, at, read), outsideKeys(cx, v, closed));
	const typedNull = nullable && !loose && v.get("type") !== undefined;
	const out = [
		...referenceParts(cx, v, at, admitted),
		...valueParts(v),
		...allOfParts(cx, v, at, group, admitted),
		typedNull ? union([self(), NULL]) : self(),
		...choiceParts(cx, v, at, group, admitted),
		...dependentParts(cx, v, at, group),
		...conditionalParts(cx, v, at, group),
		...unevaluatedParts(cx, v, at, read.evaluation),
		...keywordParts(cx, v, at, read),
	];
	out.push(...arrayTargets(cx, out, at));
	noteSizes(cx, v, at);
	const kept = withoutRejected(cx, v, at, inter(out));
	return loose ? union([kept, NULL]) : kept;
}

/**
 * Notes the keywords of a schema typed wider for their size: a pattern of more strings
 * and bounds of more values than `MAX_VALUES`, a `const` or `enum` value with an array of
 * more items than `MAX_ITEMS` (an array of their values; see `emit`).
 */
function noteSizes(cx: Ctx, v: JsonObject, at: string): void {
	const pattern = v.str("pattern");
	if (pattern !== undefined && wideForSize(pattern))
		cx.info(
			child(at, "pattern"),
			manyNote(MAX_VALUES, "strings", "typed wider"),
		);
	if (boundsTooWide(v))
		cx.info(at, manyNote(MAX_VALUES, "values", "typed as a number"));
	const long = (x: Value | undefined): boolean =>
		Array.isArray(x)
			? x.length > MAX_ITEMS || x.some(long)
			: x instanceof JsonObject && x.entries.some(([, y]) => long(y));
	const array = manyNote(MAX_ITEMS, "items", "typed as an array");
	if (long(v.get("const"))) cx.info(child(at, "const"), array);
	const e = v.get("enum");
	if (Array.isArray(e) && e.some(long)) cx.info(child(at, "enum"), array);
}

/** How members of a schema are met by its closed object (`closed`; see `parts`). */
type Admitted = (members: Value[], tys: Ty[]) => Ty[];

/**
 * A member that requires a key the closed object (`closed`) forbids admits no object: no
 * value, or its arrays where its `type` or its keywords say it can be one. (A member that
 * requires a key is an object.)
 */
function admittedBy(cx: Ctx, closed: Set<string> | undefined): Admitted {
	return (members, tys) =>
		closed === undefined
			? tys
			: tys.map((t, i) =>
					requiredKeys(cx, members[i] as Value).some((k) => !closed.has(k))
						? kindsOfMember(cx, members[i] as JsonObject).includes("array")
							? inter([t, KIND_TY.array])
							: NEVER
						: t,
				);
}

/**
 * What a schema's `$ref` and `$dynamicRef` reach (3.1, 3.2): the schema a reference reaches
 * applies to the value as an allOf member does, values of other kinds passing it
 * (`passingTarget`); a schema that is only one is its target.
 */
function referenceParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	admitted: Admitted,
): Ty[] {
	const out: Ty[] = [];
	const target = (to: string, t: Ty) => {
		const [met] = admitted([v], [t]) as [Ty];
		return cx.onlyTarget(v) === undefined
			? passingTarget(cx, v, cx.locate(to, at), met)
			: met;
	};
	const r = v.str("$ref");
	if (r !== undefined) out.push(target(r, referenced(cx, v, r, at)));
	// $dynamicRef is $ref, except where it reaches a $dynamicAnchor: then it reaches the
	// one of that name in the outermost resource the value was reached through.
	const dr = v.str("$dynamicRef");
	if (dr !== undefined) {
		const to = cx.dynamicAnchorOf(cx.locate(dr, at)) ?? dr;
		out.push(target(to, referenced(cx, v, to, at)));
	}
	return out;
}

/** The values `const` and `enum` list. */
function valueParts(v: JsonObject): Ty[] {
	const out: Ty[] = [];
	const c = v.get("const");
	if (c !== undefined) out.push(literal(c));
	const e = v.get("enum");
	if (Array.isArray(e)) out.push(union(e.map(literal)));
	return out;
}

/** The `allOf` members, values of the other kinds passing a member of some kinds only (`passing`). */
function allOfParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	group: ReadonlySet<string>,
	admitted: Admitted,
): Ty[] {
	const allOf = v.get("allOf");
	if (!Array.isArray(allOf)) return [];
	const members = membersIn(cx, v, allOf, group, child(at, "allOf"));
	return passing(cx, v, allOf, admitted(allOf, members));
}

/**
 * The union of the `oneOf` and of the `anyOf` members. `discriminator` is not read: it
 * must not change what the schema accepts (OAS 3.0.4, 3.1.1), and a member is narrowed by
 * the property only where the member itself fixes it.
 */
function choiceParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	group: ReadonlySet<string>,
	admitted: Admitted,
): Ty[] {
	const out: Ty[] = [];
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
					? shared(exclusive(cx, members, tys, group, v.get("properties")))
					: tys,
			),
		);
	}
	return out;
}

/** A key present asks what its dependent schema asks: without the key, or that schema. */
function dependentParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	group: ReadonlySet<string>,
): Ty[] {
	const ds = v.get("dependentSchemas");
	if (!(ds instanceof JsonObject)) return [];
	const tys = membersIn(
		cx,
		v,
		ds.entries.map(([, s]) => s),
		group,
		child(at, "dependentSchemas"),
		ds.entries.map(([k]) => k),
	);
	return ds.entries.map(([key], i) =>
		widen(cx, v, ["object"], union([absent(key), tys[i] as Ty])),
	);
}

/**
 * A note on each count of `cond` (an `if` or `not` whose values `refuted` says) whose
 * arrays left out are any array, past those kanagata writes a tuple of: its own, and
 * those of the schemas it leaves what they leave of, its `allOf` / `anyOf` / `oneOf`
 * members and the schemas its references reach, where they are.
 */
function countsPast(
	cx: Ctx,
	cond: Value,
	at: string,
	seen = new Set<string>(),
): void {
	if (!(cond instanceof JsonObject)) return;
	cx.inOwnResource(cond, () => {
		cx.eachTarget(cond, seen, (t) => countsPast(cx, t.value, t.where, seen));
		if (!cx.readsSiblings(cond)) return;
		for (const k of ["minItems", "maxItems"]) {
			const n = count(cond, k);
			if (n !== undefined && refutedPast(k, n))
				cx.info(child(at, k), MANY_ITEMS);
		}
		for (const key of ["allOf", "anyOf", "oneOf"]) {
			const members = cond.get(key);
			if (Array.isArray(members))
				for (const [i, m] of members.entries())
					countsPast(cx, m, child(child(at, key), String(i)), seen);
		}
	});
}

/**
 * The value is as `then` says where `if` admits it, and as `else` says where it does not.
 * Where TypeScript cannot say which values `if` does not admit, `else` is read for every
 * value, with a warning; without `else`, that asks nothing, and the warning says so.
 */
function conditionalParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	group: ReadonlySet<string>,
): Ty[] {
	if (!conditional(v)) return [];
	const cond = v.get("if") as Value;
	const said = refuted(cx, cond, [v, ...cx.around]);
	if (said !== undefined) countsPast(cx, cond, child(at, "if"));
	const otherwise = v.get("else") ?? true;
	if (said === undefined && otherwise === true) {
		cx.ifIgnored(child(at, "if"));
		for (const key of CONDITIONAL) resolveRefs(cx, v.get(key), child(at, key));
		return [];
	}
	if (said === undefined) cx.elseRead(child(at, "if"));
	const not = said ?? UNKNOWN;
	const branches = [cond, v.get("then") ?? true, v.get("else") ?? true];
	const [i, t, e] = membersIn(cx, v, branches, group, at, CONDITIONAL).map(
		(ty, k) => anyKind(cx, v, branches[k] as Value, ty),
	);
	// Each kind `if` does not admit meets `else` on its own, so that `else` reads as that kind.
	const nots = not.kind === "union" ? not.items : [not];
	return [
		union([inter([i as Ty, t as Ty]), ...nots.map((n) => inter([n, e as Ty]))]),
	];
}

/**
 * `t`, the schema's parts met, without the literals (from const, enum, members) its own
 * keywords reject, and those `not: { enum }` lists.
 */
function withoutRejected(cx: Ctx, v: JsonObject, at: string, t: Ty): Ty {
	// A not whose values left TypeScript says is one of the parts already (`notParts`).
	const n = v.get("not");
	if (n !== undefined && refuted(cx, n, [v, ...cx.around]) !== undefined)
		return t;
	const not = excluded(cx, v) ?? NOTHING_EXCLUDED;
	const out = not === NOTHING_EXCLUDED ? NO_TYS : not.map((x) => x.ty);
	const members = booleansListed(t.kind === "union" ? t.items : [t], out);
	const listed = (m: Ty) =>
		out.some(
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
	return kept;
}

/**
 * What most schemas, which have no `not`, exclude: one list for all of them. A list made
 * anew for each can be of another kind of array than those `withoutRejected` was
 * compiled for, and the engine then compiles it again.
 */
const NOTHING_EXCLUDED: readonly { ty: Ty; at: string }[] = [];
const NO_TYS: readonly Ty[] = [];

/** The array types a component admits, and the types of the other values it admits. */
type Arrays = { ty: Ty; rest: Ty[] };

/**
 * The types of the components among `out` that admit arrays, where an array meets
 * them: the reference stays, and its type beside it lets the items read as it says
 * (`Tags & ([] | [unknown])` is `Tags & ([] | [string])`). TypeScript reads an item of an
 * intersection of arrays as one member's alone. Where something there admits arrays
 * only, a component's other values (`null` of `string[] | null`) meet none of it: the
 * intersection leaves its arrays alone.
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
	return targets.map((t) => union([t.ty, ...t.rest]));
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
function namesArrays(
	cx: Ctx,
	v: Value,
	seen: ReadonlySet<string> = new Set(),
): boolean {
	if (!(v instanceof JsonObject)) return false;
	return cx.inOwnResource(v, () => ownNamesArrays(cx, v, seen));
}

function ownNamesArrays(
	cx: Ctx,
	v: JsonObject,
	seen: ReadonlySet<string>,
): boolean {
	const viaRef = cx
		.pathTargets(v, seen, (t, path) => namesArrays(cx, t.value, path))
		.some(Boolean);
	// In 3.0 the keywords next to $ref are ignored.
	if (viaRef || !cx.readsSiblings(v)) return viaRef;
	const type = v.get("type");
	if (type === "array" || (Array.isArray(type) && type.includes("array")))
		return true;
	if (valueKinds(v)?.includes("array") === true) return true;
	if (type === undefined && hasArrayKeywords(v)) return true;
	return members(v).some((m) => namesArrays(cx, m, seen));
}

/**
 * What `dependentRequired`, `propertyNames`, `contains` and `not` say that TypeScript
 * can, as parts of the schema; a warning where they say more.
 */
function keywordParts(cx: Ctx, v: JsonObject, at: string, read: Reading): Ty[] {
	return [
		...dependentRequiredParts(cx, v, read.left),
		...propertyNamesParts(cx, v, at, read.keys),
		...containsParts(cx, v, at),
		...notParts(cx, v, at),
	];
}

/**
 * A key present requires the keys its `dependentRequired` lists: it is absent, or they are
 * all present. A key left out of this view (`left`) is required on the other side only.
 */
function dependentRequiredParts(
	cx: Ctx,
	v: JsonObject,
	left: () => ReadonlySet<string>,
): Ty[] {
	const parts: Ty[] = [];
	for (const [key, deps] of dependencies(v)) {
		const names = deps.filter((d) => !left().has(d));
		if (names.length === 0) continue;
		parts.push(
			widen(
				cx,
				v,
				["object"],
				union([
					absent(key),
					{ kind: "object", props: names.map((n) => present(n, UNKNOWN)) },
				]),
			),
		);
	}
	return parts;
}

/**
 * contains requires from minContains (1 if not given) to maxContains items that match it;
 * TypeScript can say how many, and which where every item matches or, for none, where it
 * can say the values contains does not admit. An `unevaluatedItems: false` beside it may
 * say which, and then how many (see `saidHolders`).
 */
function containsParts(cx: Ctx, v: JsonObject, at: string): Ty[] {
	const parts: Ty[] = [];
	const contains = v.get("contains");
	if (contains !== undefined) {
		resolveRefs(cx, contains, child(at, "contains"));
		const { min, max } = containsBounds(v);
		const none = max === 0 ? notContained(cx, v, contains) : undefined;
		const items = (n: number): Ty[] => Array.from({ length: n }, () => UNKNOWN);
		// A count of more items than kanagata writes a tuple of is not typed, as in `array`.
		const fits = (key: string, n: number): boolean => {
			if (n <= MAX_ITEMS) return true;
			cx.info(child(at, key), MANY_ITEMS);
			return false;
		};
		// The arrays of min items or more.
		const atLeast = (): Ty =>
			fits("minContains", min)
				? { kind: "tuple", items: items(min), min, rest: UNKNOWN }
				: arrayTy(UNKNOWN);
		if (max !== undefined && min > max)
			parts.push(widen(cx, v, ["array"], NEVER));
		else if (refuted(cx, contains, []) === NEVER) {
			// Every item matches: the length is from min to max.
			if (max !== undefined && fits("maxContains", max))
				parts.push(
					widen(cx, v, ["array"], { kind: "tuple", items: items(max), min }),
				);
			else if (min > 0) parts.push(widen(cx, v, ["array"], atLeast()));
		} else if (none !== undefined) parts.push(widen(cx, v, ["array"], none));
		else {
			if (min > 0) parts.push(widen(cx, v, ["array"], atLeast()));
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
	return parts;
}

/**
 * The values `not` leaves, where TypeScript can say them (`refuted`); a warning where it
 * cannot, but for `not: { enum }`, which `withoutRejected` reads.
 */
function notParts(cx: Ctx, v: JsonObject, at: string): Ty[] {
	const n = v.get("not");
	if (n === undefined) return [];
	resolveRefs(cx, n, child(at, "not"));
	const t = refuted(cx, n, [v, ...cx.around]);
	if (t !== undefined) {
		countsPast(cx, n, child(at, "not"));
		return [t];
	}
	if (excluded(cx, v) === undefined)
		cx.warn(child(at, "not"), "not cannot be expressed in TypeScript; ignored");
	return [];
}

/** Members, converted knowing the keys the group leaves out of this view (see `leftOutTarget`). */
export function membersIn(
	cx: Ctx,
	parent: JsonObject,
	members: Value[],
	group: ReadonlySet<string>,
	at: string,
	tokens: readonly string[] = members.map((_, i) => String(i)),
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

/** The type given by `type`, or inferred from object / array keywords; `unknown` when neither says anything. */
function own(cx: Ctx, v: JsonObject, at: string, read: Reading): Ty {
	const type = v.get("type");
	if (typeof type === "string") return typed(cx, v, type, at, read);
	if (Array.isArray(type))
		return union(type.map((t) => typed(cx, v, t as string, at, read)));
	// Object and array keywords say the value is of the kinds its keywords are of, each as
	// its keywords and its members' say, unless a `type` in its `allOf` members says the
	// kinds: then those kinds, the keywords constraining their own. So does a `type` around
	// it, except for a member whose other kinds the schemas around it pass (`passing`,
	// `typelessKinds`): it is of its object and array kinds.
	// Keywords of no kind say none (most schemas without `type`: references, compositions).
	// Where they say some, the schemas its references reach say kinds of the value too.
	const of =
		keywordKinds(cx, v).length === 0
			? undefined
			: keywordsOf(cx, v, keywordKinds(cx, v, true));
	if (of !== undefined)
		return union(
			of.map((k) =>
				k === "object" || k === "array"
					? typed(cx, v, k, at, read)
					: passed(cx, v, k, [...cx.around]),
			),
		);
	if (hasObjectKeywords(v) || readsKeys(read.keys()))
		return object(cx, v, at, read);
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
						: KIND_TY[k as ValueKind],
		),
	);
}

function list(cx: Ctx, items: Value[], at: string): Ty[] {
	return items.map((item, i) => schema(cx, item, child(at, String(i))));
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
		const name = componentName(r.slice(SCHEMA_PREFIX.length));
		if (name !== undefined) {
			if (!cx.schemas.has(name))
				throw new DiagError(at, `$ref target not found: ${r}`);
			return ref(name, cx.mode);
		}
	}
	const located = cx.locate(r, at);
	const { value: target, base } = located;
	// A named type is the target as reached from the document. Where a $dynamicRef in it
	// reaches another $dynamicAnchor from here, it is written out here.
	if (cx.dynamicScope && rescoped(cx, target, base))
		return expand(cx, located, cx.componentKey(target));
	// An $anchor, $id or file naming a component schema refers to that type (except
	// in the component's own definition, which is what defines it).
	const key = cx.componentKey(target);
	if (key !== undefined) {
		if (at !== child("#/components/schemas", key)) return ref(key, cx.mode);
	} else if (cx.isFile(base) || cx.isHoisted(located)) {
		return ref(cx.hoist(target, located), cx.mode);
	}
	return expand(cx, located, key);
}

/**
 * The component the rest of a `#/components/schemas/…` `$ref` names: undefined where it
 * goes on into the component, or where its percent-encoding is malformed (`locate` says so).
 */
function componentName(rest: string): string | undefined {
	if (rest.includes("/")) return undefined;
	try {
		return unescapeToken(rest);
	} catch {
		return undefined;
	}
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
		const here = cx.ownResource(x) ?? base;
		for (const key of REFS) {
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
		for (const [k, y] of x.entries) if (!DATA.has(k)) walk(y, here);
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
		return cx.isHoisted(located) ? ref(cx.hoist(target, located), cx.mode) : t;
	} finally {
		cx.leave();
	}
}

function typed(
	cx: Ctx,
	v: JsonObject,
	t: string,
	at: string,
	read: Reading,
): Ty {
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
			return object(cx, v, at, read);
		default:
			return UNKNOWN; // a type JSON Schema does not have says nothing
	}
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

/** The lesser of two bounds, either of which may be none. */
const atMost = (a: number | undefined, b: number | undefined) =>
	a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * The most items an array of `uniqueItems: true` holds where its items past the `prefix`
 * ones list their values (`listed`): as many as those values, after the prefix items.
 * undefined for any other array.
 */
function distinctItems(
	cx: Ctx,
	v: JsonObject,
	items: Value | undefined,
	prefix: number,
): number | undefined {
	if (v.get("uniqueItems") !== true) return undefined;
	const values = listed(cx, items, new Set());
	if (values === undefined) return undefined;
	return prefix + new Set(values.map((x) => valueIdentity(literal(x)))).size;
}

/**
 * An array, or a tuple where `prefixItems`, `minItems` or `maxItems` say more: the first
 * `minItems` items are required, `prefixItems` types the first ones and `items` the rest
 * (absent means any; false, next to `prefixItems`, none), and `maxItems` closes the tuple,
 * which TypeScript bounds only item by item. Past `MAX_ITEMS` items, a count is not
 * typed, and `prefixItems` are an array of their types; past `MAX_WRITTEN` items in the
 * tuples of its lengths (`writtenItems`), the items past the required ones are a rest of
 * their types; each with a note.
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
	const minItems = count(v, "minItems") ?? 0;
	const maxItems = atMost(
		count(v, "maxItems"),
		rest === undefined ? undefined : distinctItems(cx, v, items, head.length),
	);
	if (maxItems !== undefined && maxItems < minItems) return NEVER;
	if (rest === undefined && minItems > head.length) return NEVER;
	if (head.length > MAX_ITEMS) {
		cx.info(
			child(at, "prefixItems"),
			manyNote(MAX_ITEMS, "items", "typed as an array of their types"),
		);
		return arrayTy(union(rest === undefined ? head : [...head, rest]));
	}
	// A count past them is not typed; a closed tuple ends within prefixItems.
	const many = (key: string, n: number | undefined): boolean => {
		const is = rest !== undefined && n !== undefined && n > MAX_ITEMS;
		if (is) cx.info(child(at, key), MANY_ITEMS);
		return is;
	};
	const min = many("minItems", minItems) ? 0 : minItems;
	// The bound uniqueItems gives where maxItems gives none, or a greater one.
	const maxKey = maxItems === count(v, "maxItems") ? "maxItems" : "uniqueItems";
	const max = many(maxKey, maxItems) ? undefined : maxItems;
	if (!Array.isArray(prefix) && min === 0 && max === undefined)
		return arrayTy(rest as Ty);
	const length = max ?? Math.max(head.length, min);
	const written = Array.from(
		{ length: rest === undefined ? Math.min(length, head.length) : length },
		(_, i) => head[i] ?? (rest as Ty),
	);
	const t: TupleTy =
		max !== undefined || rest === undefined
			? { kind: "tuple", items: written, min }
			: { kind: "tuple", items: written, min, rest };
	if (writtenItems(t) <= MAX_WRITTEN) return t;
	cx.info(
		child(at, "prefixItems"),
		manyNote(
			MAX_WRITTEN,
			"items in the tuples of its lengths",
			"those past the required ones typed as an array of their types",
		),
	);
	const optional = written.slice(min);
	return {
		kind: "tuple",
		items: written.slice(0, min),
		min,
		rest: union(rest === undefined ? optional : [...optional, rest]),
	};
}
