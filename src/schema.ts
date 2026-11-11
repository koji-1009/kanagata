// Schema Object → `Ty`.
//
// A schema is a conjunction: every keyword constrains the same value. Each group of
// keywords ($ref, const, enum, allOf, the schema's own type keywords, oneOf, anyOf)
// gives one part, and the parts are intersected; `inter` then simplifies the
// combinations TypeScript would print badly (`string & "a"` is `"a"`). Adding a
// keyword means adding a part here, not another special case.

import { isBinaryMedia } from "./client.ts";
import {
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

/** JSDoc text from `description` and `deprecated`. */
export function doc(v: Value): string | undefined {
	if (!(v instanceof JsonObject)) return undefined;
	const desc = v.str("description")?.trim() || undefined;
	const deprecated = v.get("deprecated") === true;
	if (!deprecated) return desc;
	return desc === undefined ? "@deprecated" : `${desc}\n@deprecated`;
}

/**
 * `nullable: true` (3.0 only; 3.1 has no such keyword) adds `null` to whatever the rest
 * of the schema gives, as documents mean it (see README).
 */
function parts(cx: Ctx, v: JsonObject, at: string): Ty {
	const nullable = !cx.refSiblings && v.get("nullable") === true;
	const out: Ty[] = [];
	const r = v.str("$ref");
	if (r !== undefined) {
		const target = reference(cx, r, at);
		// In 3.1 (JSON Schema 2020-12) the keywords next to $ref apply too; in 3.0 they
		// are ignored, except nullable.
		if (!cx.refSiblings) return nullable ? union([target, NULL]) : target;
		out.push(target);
	}
	const c = v.get("const");
	if (c !== undefined) out.push(literal(c));
	const e = v.get("enum");
	if (Array.isArray(e)) out.push(union(e.map(literal)));
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
	const allOf = v.get("allOf");
	if (Array.isArray(allOf)) {
		// Every member is the same object: a property one member leaves out of this
		// view stays out even where another member lists it as required.
		const group = leftOutKeys(cx, v);
		for (const k of cx.leftOutIn(v)) group.add(k);
		const members = cx.withLeftOut(allOf, group, () =>
			list(cx, allOf, child(at, "allOf")),
		);
		out.push(...admitted(allOf, members));
	}
	out.push(own(cx, v, at));
	// `discriminator` is not read: it must not change what the schema accepts (OAS 3.0.4, 3.1.1),
	// and a member is narrowed by the property only where the member itself fixes it.
	for (const key of ["oneOf", "anyOf"]) {
		const members = v.get(key);
		if (Array.isArray(members))
			out.push(union(admitted(members, list(cx, members, child(at, key)))));
	}
	return nullable ? union([inter(out), NULL]) : inter(out);
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

/** The keys a schema requires: its own `required`, and those of the schema its `$ref` reaches. */
function requiredKeys(cx: Ctx, s: Value): string[] {
	const req = get(s, "required");
	const own = Array.isArray(req)
		? req.filter((n): n is string => typeof n === "string")
		: [];
	const r = str(s, "$ref");
	const target = r === undefined ? undefined : cx.tryLocate(r);
	if (target === undefined) return own;
	// The target's own $refs resolve against the document it is in.
	return [
		...own,
		...cx.withBase(target.base, () => requiredKeys(cx, target.value)),
	];
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
	if (v.get("items") !== undefined || v.get("prefixItems") !== undefined)
		return array(cx, v, at);
	return UNKNOWN;
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
			return isBinaryString(v) ? BLOB : STRING;
		case "integer":
			return INTEGER;
		case "number":
			return NUMBER;
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

function array(cx: Ctx, v: JsonObject, at: string): Ty {
	const items = v.get("items");
	const prefix = v.get("prefixItems");
	if (!Array.isArray(prefix)) {
		return arrayTy(
			items === undefined ? UNKNOWN : schema(cx, items, child(at, "items")),
		);
	}
	// prefixItems: items past minItems may be missing; `items` describes the rest
	// (absent means any, false means none).
	const tupleItems = list(cx, prefix, child(at, "prefixItems"));
	const minItems = v.get("minItems");
	const n = minItems instanceof JsonNumber ? Number(minItems.text) : 0;
	const min = Number.isInteger(n) && n > 0 ? Math.min(n, tupleItems.length) : 0;
	if (items === false) return { kind: "tuple", items: tupleItems, min };
	const rest =
		items === undefined ? UNKNOWN : schema(cx, items, child(at, "items"));
	return { kind: "tuple", items: tupleItems, min, rest };
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
		const d = doc(s);
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
	// A required key without a property schema must be present with any value.
	for (const name of required) {
		if (!left.has(name) && !props.some((p) => p.key === name))
			props.push({ ...prop(name, UNKNOWN), present: true });
	}

	const ap = v.get("additionalProperties");
	let additional: Ty | undefined;
	if (ap === false) additional = NEVER;
	else if (ap === true) additional = UNKNOWN;
	else if (ap !== undefined)
		additional = schema(cx, ap, child(at, "additionalProperties"));

	// Keys matching a pattern are allowed whatever additionalProperties says. TypeScript
	// cannot check the pattern, so their types join the index signature.
	const pp = v.get("patternProperties");
	const patterns =
		pp instanceof JsonObject
			? pp.entries.map(([key, s]) =>
					schema(cx, s, child(child(at, "patternProperties"), key)),
				)
			: [];
	if (patterns.length > 0 && additional !== undefined) {
		additional = union(
			additional.kind === "never" ? patterns : [additional, ...patterns],
		);
	}

	if (additional === undefined)
		return props.length === 0 ? RECORD : { kind: "object", props };
	// `additionalProperties: false` closes the object; TypeScript can only say so
	// when there are no properties at all.
	if (additional.kind === "never" && props.length > 0)
		return { kind: "object", props };
	// The index signature must admit every declared property too.
	const members = [additional, ...props.map((p) => p.ty)];
	if (props.some((p) => p.optional)) members.push(UNDEFINED);
	return { kind: "map", props, index: union(members) };
}
