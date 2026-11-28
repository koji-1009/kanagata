// The schema keywords kanagata reads, each classified once.
//
// Every list of keywords a reader asks for (the annotations, the keywords of a kind, the
// applicators and what they apply to, the places that hold data or names) is read from
// `KEYWORDS`, so a keyword is known the same way everywhere. A keyword not in it is one
// kanagata does not read; it says nothing to the types.

import { get, type JsonObject, type Value } from "./json.ts";

/** The kinds of value a keyword constrains; values of the other kinds pass it. */
type Kind = "string" | "number" | "object" | "array";

/** Where a keyword's value holds schemas: one, a list, or a map from names. */
type Holds = "schema" | "list" | "map";

/** What a keyword is to kanagata. */
export type Keyword =
	/**
	 * Says nothing of which values are valid: `format` among them, an annotation in JSON
	 * Schema (`binary` changes the type only where bytes are bytes). `data`: its value is
	 * data, not schemas.
	 */
	| { readonly is: "annotation"; readonly data?: true }
	/**
	 * Says which values are valid: of one kind (`kind`), the others passing it, or of any
	 * kind (`type`, `const`, `enum`; `data` for the values those two list). `makes`: a
	 * schema with it is of its kind, as `type` would say (`type` that object or array
	 * keywords read); or, for a member without `type`, it makes that member of its kind only
	 * (`member`; see `kinds.ts`).
	 */
	| {
			readonly is: "assertion";
			readonly kind?: Kind;
			readonly data?: true;
			readonly makes?: "type" | "member";
	  }
	/**
	 * Applies the schemas it holds to the value (`value`: the same value, as `allOf`), to
	 * its items, properties or keys. `conditional`: `if` / `then` / `else`, which apply
	 * together. Of a kind and `makes` as an assertion is.
	 */
	| {
			readonly is: "applicator";
			readonly to: "value" | "items" | "properties" | "keys";
			readonly holds: Holds;
			readonly kind?: Kind;
			readonly conditional?: true;
			readonly makes?: "type" | "member";
	  }
	/** Reaches another schema for the same value (see `Ctx.reached`). */
	| { readonly is: "reference" }
	/**
	 * Names a schema resource, an anchor or the dialect. `holds`: schemas by name that only
	 * references reach (`$defs`).
	 */
	| { readonly is: "identifier"; readonly holds?: "map" }
	/** Leaves a property out of one view of the value: as sent, or as returned. */
	| { readonly is: "view" }
	/** Says what a string's content is: bytes, or text in an encoding; `contentSchema` is not read. */
	| { readonly is: "content"; readonly holds?: "schema" }
	/** An OpenAPI field of a Schema Object: 3.0's `nullable`; `discriminator`, which is not read. */
	| { readonly is: "openapi" };

/**
 * A keyword's entry in `KEYWORDS`: what it is to kanagata, and whether an OpenAPI 3.0
 * Schema Object defines it (`oas30`; OAS 3.0.4, Schema Object). In a 3.0 document the
 * others say nothing (`NOT_IN_30`).
 */
type Entry = Keyword & { readonly oas30?: true };

/** Every keyword kanagata reads, in the order the readers go through those of one list. */
export const KEYWORDS: readonly (readonly [string, Entry])[] = [
	["title", { is: "annotation", oas30: true }],
	["description", { is: "annotation", oas30: true }],
	["$comment", { is: "annotation" }],
	["default", { is: "annotation", data: true, oas30: true }],
	["example", { is: "annotation", data: true, oas30: true }],
	["examples", { is: "annotation", data: true }],
	["deprecated", { is: "annotation", oas30: true }],
	["externalDocs", { is: "annotation", oas30: true }],
	["xml", { is: "annotation", oas30: true }],
	["format", { is: "annotation", oas30: true }],
	["type", { is: "assertion", oas30: true }],
	["const", { is: "assertion", data: true }],
	["enum", { is: "assertion", data: true, oas30: true }],
	["pattern", { is: "assertion", kind: "string", oas30: true }],
	["minLength", { is: "assertion", kind: "string", oas30: true }],
	["maxLength", { is: "assertion", kind: "string", oas30: true }],
	["minimum", { is: "assertion", kind: "number", oas30: true }],
	["maximum", { is: "assertion", kind: "number", oas30: true }],
	["exclusiveMinimum", { is: "assertion", kind: "number", oas30: true }],
	["exclusiveMaximum", { is: "assertion", kind: "number", oas30: true }],
	["multipleOf", { is: "assertion", kind: "number", oas30: true }],
	["required", { is: "assertion", kind: "object", makes: "type", oas30: true }],
	["dependentRequired", { is: "assertion", kind: "object", makes: "member" }],
	["minProperties", { is: "assertion", kind: "object", oas30: true }],
	["maxProperties", { is: "assertion", kind: "object", oas30: true }],
	["minItems", { is: "assertion", kind: "array", makes: "type", oas30: true }],
	["maxItems", { is: "assertion", kind: "array", makes: "type", oas30: true }],
	["minContains", { is: "assertion", kind: "array" }],
	["maxContains", { is: "assertion", kind: "array" }],
	["uniqueItems", { is: "assertion", kind: "array", oas30: true }],
	["$ref", { is: "reference", oas30: true }],
	["$dynamicRef", { is: "reference" }],
	["allOf", { is: "applicator", to: "value", holds: "list", oas30: true }],
	["oneOf", { is: "applicator", to: "value", holds: "list", oas30: true }],
	["anyOf", { is: "applicator", to: "value", holds: "list", oas30: true }],
	["not", { is: "applicator", to: "value", holds: "schema", oas30: true }],
	["if", { is: "applicator", to: "value", holds: "schema", conditional: true }],
	[
		"then",
		{ is: "applicator", to: "value", holds: "schema", conditional: true },
	],
	[
		"else",
		{ is: "applicator", to: "value", holds: "schema", conditional: true },
	],
	[
		"dependentSchemas",
		{
			is: "applicator",
			to: "value",
			holds: "map",
			kind: "object",
			makes: "member",
		},
	],
	[
		"properties",
		{
			is: "applicator",
			to: "properties",
			holds: "map",
			kind: "object",
			makes: "type",
			oas30: true,
		},
	],
	[
		"patternProperties",
		{
			is: "applicator",
			to: "properties",
			holds: "map",
			kind: "object",
			makes: "type",
		},
	],
	[
		"additionalProperties",
		{
			is: "applicator",
			to: "properties",
			holds: "schema",
			kind: "object",
			makes: "type",
			oas30: true,
		},
	],
	[
		"unevaluatedProperties",
		{ is: "applicator", to: "properties", holds: "schema", kind: "object" },
	],
	[
		"propertyNames",
		{
			is: "applicator",
			to: "keys",
			holds: "schema",
			kind: "object",
			makes: "member",
		},
	],
	[
		"items",
		{
			is: "applicator",
			to: "items",
			holds: "schema",
			kind: "array",
			makes: "type",
			oas30: true,
		},
	],
	[
		"prefixItems",
		{
			is: "applicator",
			to: "items",
			holds: "list",
			kind: "array",
			makes: "type",
		},
	],
	[
		"unevaluatedItems",
		{ is: "applicator", to: "items", holds: "schema", kind: "array" },
	],
	[
		"contains",
		{
			is: "applicator",
			to: "items",
			holds: "schema",
			kind: "array",
			makes: "member",
		},
	],
	["$id", { is: "identifier" }],
	["$anchor", { is: "identifier" }],
	["$dynamicAnchor", { is: "identifier" }],
	["$schema", { is: "identifier" }],
	["$defs", { is: "identifier", holds: "map" }],
	["definitions", { is: "identifier", holds: "map" }],
	["readOnly", { is: "view", oas30: true }],
	["writeOnly", { is: "view", oas30: true }],
	["contentMediaType", { is: "content" }],
	["contentEncoding", { is: "content" }],
	["contentSchema", { is: "content", holds: "schema" }],
	["nullable", { is: "openapi", oas30: true }],
	["discriminator", { is: "openapi", oas30: true }],
];

/** The keywords `KEYWORDS` classifies so, in its order. */
function keywords(f: (w: Entry, k: string) => boolean): string[] {
	return KEYWORDS.filter(([k, w]) => f(w, k)).map(([k]) => k);
}

const ANNOTATIONS = new Set(keywords((w) => w.is === "annotation"));

/** Whether a keyword says nothing of which values are valid: an annotation, or a specification extension. */
export const isAnnotation = (k: string): boolean =>
	ANNOTATIONS.has(k) || k.startsWith("x-");

/** The keywords whose values are data, not schemas: `default`, `const`, … */
export const DATA: ReadonlySet<string> = new Set(
	keywords((w) => "data" in w && w.data === true),
);

/** The keywords whose values map names to schemas, so their keys are names. */
export const NAME_MAPS: readonly string[] = keywords(
	(w) => "holds" in w && w.holds === "map",
);

/** The keywords that reach another schema for the same value. */
export const REFS: ReadonlySet<string> = new Set(
	keywords((w) => w.is === "reference"),
);

/** The keywords that say the kinds of a schema as its keywords for kinds do not: `type`, `const`, `enum`. */
export const SAYING: readonly string[] = keywords(
	(w) => w.is === "assertion" && w.kind === undefined,
);

/** The keywords that say what a schema is beyond its keywords for kinds: `SAYING` and the references. */
export const TYPING: readonly string[] = keywords(
	(w) => (w.is === "assertion" && w.kind === undefined) || w.is === "reference",
);

/** The assertions on values of a kind: `pattern`, `minLength`, … for `string`. */
export function assertions(kind: Kind): string[] {
	return keywords((w) => w.is === "assertion" && w.kind === kind);
}

/** The assertions and applicators on values of a kind, which values of other kinds pass: `required`, `properties`, … for `object`. */
export function onlyOf(kind: Kind): string[] {
	return keywords(
		(w) => (w.is === "assertion" || w.is === "applicator") && w.kind === kind,
	);
}

/** The keywords whose presence makes a schema of a kind, or a member without `type` of it only (`makes`). */
export function making(kind: Kind, makes: "type" | "member"): string[] {
	return keywords(
		(w) =>
			(w.is === "assertion" || w.is === "applicator") &&
			w.kind === kind &&
			w.makes === makes,
	);
}

/** The applicators to the same value with a list of schemas: `allOf`, `oneOf`, `anyOf`. */
export const MEMBERS: readonly string[] = keywords(
	(w) => w.is === "applicator" && w.to === "value" && w.holds === "list",
);

/** `if`, `then`, `else`. */
export const CONDITIONAL: readonly string[] = keywords(
	(w) => w.is === "applicator" && w.conditional === true,
);

/**
 * The keywords whose schemas evaluate the value for `unevaluatedProperties` /
 * `unevaluatedItems` (JSON Schema 2020-12, 11): the references, and the applicators to the
 * same value but `not`, which evaluates nothing, and `then` / `else`, which apply only
 * where `if` is beside them.
 */
export const EVALUATING: readonly string[] = keywords(
	(w, k) =>
		w.is === "reference" ||
		(w.is === "applicator" &&
			w.to === "value" &&
			k !== "not" &&
			(w.conditional !== true || k === "if")),
);

/** The keywords kanagata reads that hold schemas but `if` / `then` / `else`, by what they hold. */
export const SUBSCHEMAS: ReadonlyMap<string, Holds> = new Map(
	KEYWORDS.flatMap(([k, w]): [string, Holds][] =>
		w.is === "applicator" && w.conditional !== true ? [[k, w.holds]] : [],
	),
);

/**
 * The keywords kanagata reads for what they say that a 3.0 Schema Object does not define:
 * JSON Schema keywords OpenAPI 3.0 leaves unsupported. In a 3.0 document they say nothing,
 * as a keyword kanagata does not know says nothing (see `Ctx.schemaObject`). No other 3.0
 * object has a field of these names; the annotations, which say nothing anyway, are left
 * in (`examples` is a field of a 3.0 Parameter Object).
 */
export const NOT_IN_30: ReadonlySet<string> = new Set(
	keywords((w) => w.oas30 !== true && w.is !== "annotation"),
);

/** The keywords of a 3.0 Schema Object that hold schemas, by what they hold. */
export const SUBSCHEMAS_30: ReadonlyMap<string, Holds> = new Map(
	[...SUBSCHEMAS].filter(([k]) => !NOT_IN_30.has(k)),
);

/** The schemas of a schema's `allOf`, `oneOf` and `anyOf` (or those of `keys`), in order. */
export function members(
	s: Value | undefined,
	keys: readonly string[] = MEMBERS,
): Value[] {
	const out: Value[] = [];
	for (const key of keys) {
		const m = get(s, key);
		if (Array.isArray(m)) out.push(...m);
	}
	return out;
}

/** The `if`, `then` and `else` a schema has, in that order. */
export function branches(s: Value | undefined): Value[] {
	const out: Value[] = [];
	for (const key of CONDITIONAL) {
		const b = get(s, key);
		if (b !== undefined) out.push(b);
	}
	return out;
}

/** The keywords of a schema but its annotations. */
export function asserted(s: JsonObject): string[] {
	return s.entries.map(([k]) => k).filter((k) => !isAnnotation(k));
}

/** Whether a schema has no keyword but references and annotations. */
export function refsAndAnnotations(s: JsonObject): boolean {
	return s.entries.every(([k]) => REFS.has(k) || isAnnotation(k));
}
