// `$ref` resolution (JSON Pointers, `$anchor`s, `$id`s, other files), conversion state, and diagnostics.

import { GenerateError } from "./error.ts";
import {
	escapeToken,
	get,
	JsonObject,
	pointer,
	str,
	unescapeToken,
	type Value,
} from "./json.ts";
import type { View } from "./ty.ts";

/**
 * A problem at a location in the input: a JSON Pointer (`#/paths/~1users/get`), after
 * the file's path relative to the document for another file (`schemas/User.yaml#/id`).
 */
export interface Diag {
	at: string;
	msg: string;
}

/** The warnings on an `if` TypeScript cannot say the values it does not admit of (see `Ctx.ifIgnored`). */
const IF_IGNORED =
	"if / then / else cannot be expressed in TypeScript; ignored";
const THEN_READ =
	"if / then cannot be expressed in TypeScript; then is read only for the properties and items it evaluates";

/** A fatal problem at a location in the document. */
export class DiagError extends GenerateError {
	declare readonly diag: Diag;

	constructor(at: string, msg: string) {
		super("input", `${at}: ${msg}`, { at, msg });
	}
}

/** The base URI of the document itself: a placeholder no `$id` can collide with by accident. */
const DOCUMENT = "https://kanagata.invalid/document";

/** Keywords whose values are data. */
const DATA = new Set(["example", "examples", "default", "const", "enum"]);

/** Keywords whose values map names to schemas or other objects, so their keys are names. */
const NAME_MAPS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"schemas",
	"paths",
	"webhooks",
]);

/**
 * The keywords kanagata reads for what they say that an OpenAPI 3.0 Schema Object does not
 * define (OAS 3.0.4, Schema Object): JSON Schema keywords 3.0 leaves unsupported. In a 3.0
 * document they say nothing, as a keyword kanagata does not know says nothing. No other
 * 3.0 object has a field of these names.
 */
const NOT_IN_30 = new Set([
	"const",
	"if",
	"then",
	"else",
	"prefixItems",
	"contains",
	"minContains",
	"maxContains",
	"unevaluatedItems",
	"patternProperties",
	"unevaluatedProperties",
	"propertyNames",
	"dependentRequired",
	"dependentSchemas",
	"$id",
	"$anchor",
	"$dynamicRef",
	"$dynamicAnchor",
	"$schema",
	"$defs",
	"definitions",
	"contentMediaType",
	"contentEncoding",
	"contentSchema",
]);

/** The keywords of a 3.0 Schema Object that hold schemas: one, a list, or a map from names. */
const SUBSCHEMAS_30 = new Map<string, "schema" | "list" | "map">([
	["allOf", "list"],
	["oneOf", "list"],
	["anyOf", "list"],
	["not", "schema"],
	["items", "schema"],
	["properties", "map"],
	["additionalProperties", "schema"],
]);

function withoutFragment(url: URL): string {
	return url.href.slice(0, url.href.length - url.hash.length).replace(/#$/, "");
}

/** A percent-encoded path segment, decoded. */
function decodePath(segment: string): string {
	return decodeURIComponent(segment);
}

/**
 * Why a `$ref`, `$id` or `$self` is no URI reference: a URL does not parse from it (against
 * `base`), or its percent-encoding does not decode, as UTF-8, to the file path or JSON
 * Pointer it spells (`%zz`, `%FF`). undefined for a URI reference.
 */
function notUriReference(s: string, base: string): string | undefined {
	if (!URL.canParse(s, base)) return "is not a URI reference";
	return decodes(s) ? undefined : "has a malformed percent-encoding";
}

/** Whether a URI's percent-encoding decodes, as UTF-8. */
export function decodes(uri: string): boolean {
	try {
		decodeURIComponent(uri);
		return true;
	} catch {
		return false;
	}
}

interface Index {
	/** The document's schema resources (`$id`); another file's are known inside it alone (`Ctx.#idsIn`). */
	ids: Map<string, Value>;
	anchors: Map<string, Value>;
	/** The `$dynamicAnchor`s, by resource and name (`https://example.com/tree#node`). */
	dynamic: Set<string>;
	/** The absolute URI of each schema with an `$id`, resolved against the schemas around it. */
	resources: Map<Value, string>;
	/** Whether a `$dynamicRef` is anywhere in the documents read. */
	dynamicRefs: boolean;
}

/**
 * Adds the schema resources (`$id`) in `doc` to `ids` and its `$anchor`s to the index, by
 * absolute URI. Values of `example`, `default`, `const` and `enum` are data, not schemas,
 * unless the key names a property (in `properties`, `$defs`, …).
 */
function indexIds(
	index: Index,
	ids: Map<string, Value>,
	doc: Value,
	base: string,
): void {
	const walk = (v: Value, base: string, names: boolean): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x, base, false);
			return;
		}
		if (!(v instanceof JsonObject)) return;
		let here = base;
		const id = v.str("$id");
		// An $id that is not a URI cannot be referred to.
		if (id !== undefined && notUriReference(id, base) === undefined) {
			here = withoutFragment(new URL(id, base));
			if (!ids.has(here)) ids.set(here, v);
			if (!index.resources.has(v)) index.resources.set(v, here);
		}
		// A $dynamicAnchor is a plain-name fragment too (JSON Schema 2020-12, 8.2.2).
		for (const key of ["$anchor", "$dynamicAnchor"]) {
			const anchor = v.str(key);
			if (anchor !== undefined && !index.anchors.has(`${here}#${anchor}`))
				index.anchors.set(`${here}#${anchor}`, v);
		}
		const dynamic = v.str("$dynamicAnchor");
		if (dynamic !== undefined) index.dynamic.add(`${here}#${dynamic}`);
		if (v.get("$dynamicRef") !== undefined) index.dynamicRefs = true;
		for (const [k, x] of v.entries) {
			if (!names && DATA.has(k)) continue;
			walk(x, here, !names && NAME_MAPS.has(k));
		}
	};
	walk(doc, base, false);
}

/**
 * Runs `f` with each of `keys` mapped to `value` in `map`, then restores what each was. A
 * schema can be read again while it is read (a YAML alias is one object wherever it is,
 * and a `$ref` can reach a schema being read), and the inner reading leaves the outer
 * one's entry as it found it.
 */
function withEntries<K, V, T>(
	map: Map<K, V>,
	keys: readonly K[],
	value: V,
	f: () => T,
): T {
	const saved = keys.map((k) => map.get(k));
	for (const k of keys) map.set(k, value);
	try {
		return f();
	} finally {
		keys.forEach((k, i) => {
			const old = saved[i];
			if (old === undefined) map.delete(k);
			else map.set(k, old);
		});
	}
}

/** Appends a token to a JSON Pointer. */
export function child(at: string, token: string): string {
	return `${at}/${escapeToken(token)}`;
}

/** Where the document is, and how to load another document a `$ref` points to. */
export interface Location {
	/** The document's absolute URL; relative `$ref`s resolve against it. */
	url: string;
	/** The parsed document at an absolute URL (no fragment). Throws GenerateError for a document that does not parse, any other error when it cannot be read. */
	load: (url: string) => Value;
}

/** What a `$ref` reaches: the value, the base URI it lives under, and where it is, for messages. */
export interface Located {
	value: Value;
	base: string;
	uri: string;
	where: string;
}

/** Where a schema is read: the base URI its `$ref`s resolve against, and the dynamic scope. */
export interface Place {
	base: string;
	scope: readonly string[];
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** What a schema without a reference reaches. */
const NONE: readonly Located[] = [];

/** Schema keywords a component may have next to `$ref` and still be another name for its target. */
const ALIAS_KEYS = new Set(["$ref", "$dynamicRef", "description", "title"]);

/** Where bytes are bytes: a raw body, a multipart body (whose properties are its parts), a part. */
export type RawPosition = "body" | "parts" | "part";

/** A schema in another file that no component names, given a key of its own as if it were one. */
export interface Hoisted {
	key: string;
	value: Value;
	/** The base URI of the document it is in. */
	base: string;
	/** Where it is, for messages. */
	where: string;
}

/** Conversion state shared by every stage. */
export class Ctx {
	readonly root: Value;
	/** The document's URL: from its Location, or a placeholder when it has none. */
	readonly documentUrl: string;
	/** The document's base URI: its `$self` (3.2), resolved against its URL, or the URL. */
	readonly documentBase: string;
	/** Whether the document is OpenAPI 3.2, whose fields (`$self`, `query`, …) are read. */
	readonly v32: boolean;
	readonly #load: ((url: string) => Value) | undefined;
	/** `$ref`s being expanded inline, for cycle detection. */
	readonly #stack: string[] = [];
	/** Keys of `#/components/schemas`. */
	readonly schemas: ReadonlySet<string>;
	/** Warnings in the order first raised; the same schema converted for both views warns once. */
	readonly #warnings = new Map<string, Diag>();
	/** The `if`s (`…/if`) whose `then` an `unevaluated*` reads for what it evaluates (`thenRead`). */
	readonly #thenRead = new Set<string>();
	/**
	 * Which view a schema is converted for: `read` (responses) leaves out writeOnly
	 * properties, `write` (request bodies, parameters) leaves out readOnly ones.
	 */
	mode: View = "read";
	/** Whether keywords next to `$ref` apply (OpenAPI 3.1) or are ignored (3.0); see `readsSiblings`. */
	readonly refSiblings: boolean;
	/** Whether 3.0 `nullable: true` means "this schema or null" instead of adding `null` to `type`. */
	readonly looseNullable: boolean;
	/** Schemas from other files that got a key, in the order they were first referred to. */
	readonly hoisted: Hoisted[] = [];
	/**
	 * Hoisted keys by the schema, whichever URI reaches it (a pointer into its file, or the
	 * file's `$id`).
	 */
	readonly #hoistedKeys = new Map<Value, string>();
	readonly #hoistedNames = new Set<string>();

	/**
	 * The key of a schema in another file that no component names: the file name
	 * without its extension (`Order.yaml` → `Order`), or the last token of the pointer
	 * into it (`common.json#/Error` → `Error`); a key that is taken gets a number.
	 */
	hoist(
		value: Value,
		target: { base: string; uri: string; where: string },
	): string {
		const known = this.#hoistedKeys.get(value);
		if (known !== undefined) return known;
		const url = new URL(target.uri);
		const fragment = url.hash.slice(1);
		const file = decodePath(url.pathname.split("/").pop() as string);
		// The pointer resolved, so its tokens decode.
		const name =
			fragment === ""
				? file.replace(/\.(json|ya?ml)$/i, "")
				: (unescapeToken(fragment.split("/").pop() as string) as string);
		const taken = (k: string) =>
			this.schemas.has(k) || this.#hoistedNames.has(k);
		let key = name;
		for (let n = 2; taken(key); n++) key = `${name}${n}`;
		this.#hoistedKeys.set(value, key);
		this.#hoistedNames.add(key);
		this.hoisted.push({ key, value, base: target.base, where: target.where });
		return key;
	}

	constructor(
		root: Value,
		schemas: ReadonlySet<string>,
		refSiblings: boolean,
		location: Location | undefined,
		looseNullable: boolean,
	) {
		this.root = root;
		this.schemas = schemas;
		this.refSiblings = refSiblings;
		this.looseNullable = looseNullable;
		this.documentUrl =
			location === undefined
				? DOCUMENT
				: withoutFragment(new URL(location.url));
		this.#load = location?.load;
		this.v32 = str(root, "openapi")?.startsWith("3.2.") === true;
		const self = this.v32 ? get(root, "$self") : undefined;
		if (
			self !== undefined &&
			(typeof self !== "string" ||
				notUriReference(self, this.documentUrl) !== undefined)
		)
			throw new DiagError("#/$self", "$self must be a URI reference");
		this.documentBase =
			self === undefined
				? this.documentUrl
				: withoutFragment(new URL(self, this.documentUrl));
		this.base = this.documentBase;
	}

	/**
	 * Whether a schema's keywords apply: everywhere in 3.1 and 3.2, and in 3.0 where it has
	 * no `$ref`, next to which they are ignored (but `description`; see `schemaDoc`). Every
	 * reader of a schema's keywords asks this, and then reads its `$ref` target alone.
	 */
	readsSiblings(s: Value): boolean {
		return this.refSiblings || get(s, "$ref") === undefined;
	}

	/** Each schema `schemaObject` read in a 3.0 document, and each it gave, to what it gives. */
	readonly #read30 = new Map<Value, Value>();

	/**
	 * A Schema Object as the document's version defines it: in 3.1 and 3.2 as written; in
	 * 3.0 without the keywords a 3.0 Schema Object does not define (`NOT_IN_30`), in it and
	 * in the schemas it holds, so that no reader sees them. A schema without them is itself,
	 * and one with them always gives the same schema, so schemas stay matched by identity
	 * (`componentKey`). Every schema is read through this: the document's (`schema`), the
	 * components (`componentKey`), and every `$ref` target.
	 */
	schemaObject(v: Value): Value {
		if (this.refSiblings || !(v instanceof JsonObject)) return v;
		const known = this.#read30.get(v);
		if (known !== undefined) return known;
		let changed = false;
		const entries: [string, Value][] = [];
		for (const [k, x] of v.entries) {
			const read = NOT_IN_30.has(k) ? undefined : this.#held(k, x);
			if (read !== x) changed = true;
			if (read !== undefined) entries.push([k, read]);
		}
		const out = changed ? new JsonObject(entries) : v;
		this.#read30.set(v, out);
		this.#read30.set(out, out);
		return out;
	}

	/** The value of a 3.0 schema's keyword `k`, the schemas it holds read by `schemaObject`. */
	#held(k: string, x: Value): Value {
		const holds = SUBSCHEMAS_30.get(k);
		if (holds === "schema") return this.schemaObject(x);
		if (holds === "list" && Array.isArray(x)) {
			const out = x.map((s) => this.schemaObject(s));
			return out.every((s, i) => s === x[i]) ? x : out;
		}
		if (holds === "map" && x instanceof JsonObject) {
			const out = x.entries.map(([name, s]): [string, Value] => [
				name,
				this.schemaObject(s),
			]);
			return out.every(([, s], i) => s === (x.entries[i] as [string, Value])[1])
				? x
				: new JsonObject(out);
		}
		return x;
	}

	warn(at: string, msg: string): void {
		const key = `${at}\n${msg}`;
		if (!this.#warnings.has(key)) this.#warnings.set(key, { at, msg });
	}

	/**
	 * Warns that the `if` / `then` / `else` whose `if` is at `at` is ignored: TypeScript has
	 * no type for the values `if` does not admit. Where an `unevaluated*` reads its `then`
	 * for what it evaluates (`thenRead`), the warning says that `then` is read for that only.
	 */
	ifIgnored(at: string): void {
		this.warn(at, IF_IGNORED);
	}

	/** Records that an `unevaluated*` reads the `then` of the `if` at `at` for what it evaluates (see `ifIgnored`). */
	thenRead(at: string): void {
		this.#thenRead.add(at);
	}

	get warnings(): Diag[] {
		return [...this.#warnings.values()].map((w) =>
			w.msg === IF_IGNORED && this.#thenRead.has(w.at)
				? { at: w.at, msg: THEN_READ }
				: w,
		);
	}

	/**
	 * Where the schema converted next is: a raw body (a wildcard media type), a multipart
	 * body's parts, or one part. A binary string is a `Blob` there, and text elsewhere
	 * (inside JSON, a form, a parameter).
	 */
	raw: RawPosition | undefined = undefined;
	/** Where the schema being converted is: `raw` when its conversion began. */
	here: RawPosition | undefined = undefined;

	/** Converts with `raw` as the position of the next schema, then restores it. */
	withRaw<T>(pos: RawPosition | undefined, f: () => T): T {
		const saved = this.raw;
		this.raw = pos;
		try {
			return f();
		} finally {
			this.raw = saved;
		}
	}

	/**
	 * The schemas around the one being converted whose keywords apply to the same value:
	 * it is their member (`allOf`, `if`, …) or `$ref` target, innermost last. A property's
	 * or item's schema is another value, with none around it.
	 */
	around: readonly JsonObject[] = [];
	/** What `around` is for the schema converted next. */
	#nextAround: readonly JsonObject[] | undefined;

	/**
	 * Converts with `parent` (none if undefined) around the schema converted next, after
	 * the schemas around the one being converted, then restores.
	 */
	withAround<T>(parent: JsonObject | undefined, f: () => T): T {
		const saved = this.#nextAround;
		this.#nextAround =
			parent === undefined ? this.around : [...this.around, parent];
		try {
			return f();
		} finally {
			this.#nextAround = saved;
		}
	}

	/** Converts a schema with what `withAround` gave it, or nothing, around it. */
	inSchema<T>(f: () => T): T {
		const saved = this.around;
		this.around = this.#nextAround ?? [];
		this.#nextAround = undefined;
		try {
			return f();
		} finally {
			this.around = saved;
		}
	}

	/**
	 * The `propertyNames` schemas being read for the strings they admit, which are an
	 * object's keys: their references are written out rather than named.
	 */
	readonly #keysRead = new Map<Value, true>();

	/** Whether a `propertyNames` is being read for its keys. */
	get readingKeys(): boolean {
		return this.#keysRead.size > 0;
	}

	/** Whether this `propertyNames` is being read already: its reading reached itself. */
	readsKeysOf(names: Value): boolean {
		return this.#keysRead.has(names);
	}

	/** Reads a `propertyNames` for its keys, then restores. */
	withKeysRead<T>(names: Value, f: () => T): T {
		return withEntries(this.#keysRead, [names], true, f);
	}

	/** Properties left out of the current view by the other members of the `allOf` a schema is in. */
	readonly #leftOut = new Map<Value, ReadonlySet<string>>();

	leftOutIn(v: Value): ReadonlySet<string> {
		return this.#leftOut.get(v) ?? NO_KEYS;
	}

	/** Converts `allOf` members knowing the properties the group leaves out. */
	withLeftOut<T>(
		members: readonly Value[],
		keys: ReadonlySet<string>,
		f: () => T,
	): T {
		return withEntries(this.#leftOut, members, keys, f);
	}

	/**
	 * The schemas with `contains` whose matching items the type of a schema being converted
	 * says (by its `unevaluatedItems: false`), by that schema; read when first asked for.
	 */
	readonly #said = new Map<JsonObject, () => ReadonlySet<JsonObject>>();

	/** Whether the type of the schema being converted or of one around it says which items match `holder`'s `contains`. */
	containsSaid(holder: JsonObject): boolean {
		return [holder, ...this.around].some(
			(s) => this.#said.get(s)?.().has(holder) === true,
		);
	}

	/** Converts `s` knowing the schemas with `contains` whose matching items its type says. */
	withSaid<T>(
		s: JsonObject,
		holders: () => ReadonlySet<JsonObject>,
		f: () => T,
	): T {
		return withEntries(this.#said, [s], holders, f);
	}

	/** Converts in the given view, then restores the previous one. */
	inMode<T>(mode: View, f: () => T): T {
		const saved = this.mode;
		this.mode = mode;
		try {
			return f();
		} finally {
			this.mode = saved;
		}
	}

	/**
	 * The base URI `$ref`s resolve against: the document, another document a `$ref`
	 * led to, or the `$id` of the schema resource being converted (JSON Schema 2020-12).
	 */
	base: string;

	/** Whether `$ref`s resolve against the document itself (not another file, nor inside a schema with `$id`). */
	get inDocument(): boolean {
		return this.base === this.documentBase;
	}

	/**
	 * How a location is written in messages: a JSON Pointer in the document (`#/a`), a
	 * path relative to it for another file (`defs/a.yaml#/b`), the URI otherwise.
	 */
	where(resource: string, fragment?: string): string {
		const hash = fragment === undefined ? "" : `#${fragment}`;
		if (resource === this.documentBase) return hash;
		const url = new URL(resource);
		const doc = new URL(this.documentUrl);
		if (url.protocol !== "file:" || doc.protocol !== "file:")
			return `${resource}${hash}`;
		const from = doc.pathname.split("/").slice(0, -1).map(decodePath);
		const to = url.pathname.split("/").map(decodePath);
		let same = 0;
		while (same < from.length && from[same] === to[same]) same++;
		const up = from.slice(same).map(() => "..");
		return `${[...up, ...to.slice(same)].join("/")}${hash}`;
	}

	/** Converts with `base` as the base URI, then restores the previous one. */
	withBase<T>(base: string, f: () => T): T {
		const saved = this.base;
		this.base = base;
		try {
			return f();
		} finally {
			this.base = saved;
		}
	}

	/**
	 * The schema resources a value was reached through, outermost first, after the
	 * document's own (JSON Schema 2020-12's dynamic scope): `$dynamicRef` reads it.
	 */
	scope: readonly string[] = [];

	/** Converts in a schema resource: with its base URI, and in the dynamic scope. */
	inResource<T>(base: string, f: () => T): T {
		const saved = this.scope;
		if (base !== (this.scope[this.scope.length - 1] ?? this.documentBase))
			this.scope = [...this.scope, base];
		// Read where it is already (nearly every schema of a document without `$id`), nothing changes.
		else if (base === this.base) return f();
		try {
			return this.withBase(base, f);
		} finally {
			this.scope = saved;
		}
	}

	/** Where a schema is read now: the base URI and the dynamic scope, to read another there later. */
	get place(): Place {
		return { base: this.base, scope: this.scope };
	}

	/** Reads where `place` says (see `place`), then restores where it was. */
	inPlace<T>(place: Place, f: () => T): T {
		const saved = this.scope;
		this.scope = place.scope;
		try {
			return this.withBase(place.base, f);
		} finally {
			this.scope = saved;
		}
	}

	/**
	 * The `$dynamicAnchor` of this name a `$dynamicRef` reaches in a dynamic scope: the
	 * outermost resource's, the document's first; undefined where none has one.
	 */
	dynamicTarget(name: string, scope = this.scope): string | undefined {
		const dynamic = this.#ids().dynamic;
		return [this.documentBase, ...scope]
			.map((r) => `${r}#${name}`)
			.find((uri) => dynamic.has(uri));
	}

	/** Whether the document has `$dynamicAnchor`s and a value is reached through a resource of its own. */
	get dynamicScope(): boolean {
		return this.#ids().dynamic.size > 0 && this.scope.length > 0;
	}

	/** Whether a URI names a `$dynamicAnchor`. */
	isDynamicAnchor(uri: string): boolean {
		return this.#ids().dynamic.has(uri);
	}

	/**
	 * The base URI inside a schema with `$id`: its `$id` resolved against the schemas
	 * around it, wherever the schema is reached from. undefined for a schema without
	 * one, or whose `$id` is not a URI.
	 */
	resourceOf(v: Value): string | undefined {
		return this.#ids().resources.get(v);
	}

	// How a schema is looked through to the schemas it applies to the same value. Every
	// reader of a schema goes through these, so that they all reach the same schemas.
	// They are read for nearly every schema, most of which have no `$id` and no reference,
	// so that case allocates nothing.

	/**
	 * The resource a schema is read in, its own (`$id`, 3.1 and 3.2), where it is one;
	 * undefined otherwise. Reading it inside it already changes nothing (`inOwnResource`).
	 */
	ownResource(v: Value): string | undefined {
		return this.#ids().resources.get(v);
	}

	/**
	 * Reads a schema in its own resource: one with `$id` (3.1, 3.2) is one, and `$ref`s
	 * inside it resolve against its URI. Reading it inside it already changes nothing.
	 */
	inOwnResource<T>(v: Value, f: () => T): T {
		const uri = this.ownResource(v);
		return uri === undefined ? f() : this.inResource(uri, f);
	}

	/**
	 * What a `$dynamicRef` reaches from its target where that is a `$dynamicAnchor`: the
	 * one of that name in the outermost resource the value was reached through. undefined
	 * where it reaches its target, as a `$ref` does.
	 */
	dynamicAnchorOf(target: Located): string | undefined {
		return this.isDynamicAnchor(target.uri)
			? this.dynamicTarget(new URL(target.uri).hash.slice(1))
			: undefined;
	}

	/**
	 * The schemas a schema's `$ref` and `$dynamicRef` reach, where they are found: the
	 * conversion reports one that is not.
	 */
	reached(s: Value): readonly Located[] {
		return s instanceof JsonObject ? this.reachedBy(s, s.str("$ref")) : NONE;
	}

	/** `reached` for a reader that has read the schema's `$ref` (`r`, where it is a string) already. */
	reachedBy(s: JsonObject, r: string | undefined): readonly Located[] {
		// Without a $dynamicRef in the documents, only the $ref counts.
		if (!this.#ids().dynamicRefs) {
			const target = r === undefined ? undefined : this.tryLocate(r);
			return target === undefined ? NONE : [target];
		}
		const targets: Located[] = [];
		const target = r === undefined ? undefined : this.tryLocate(r);
		if (target !== undefined) targets.push(target);
		const dr = s.str("$dynamicRef");
		const found = dr === undefined ? undefined : this.tryLocate(dr);
		if (found !== undefined) {
			const outer = this.dynamicAnchorOf(found);
			targets.push(outer === undefined ? found : this.locate(outer, ""));
		}
		return targets;
	}

	/** Reads a schema a reference reaches where it is: in the resource it is in, and its own. */
	inTarget<T>(target: Located, f: () => T): T {
		const own = this.ownResource(target.value);
		return own === undefined
			? this.inResource(target.base, f)
			: this.inResource(target.base, () => this.inResource(own, f));
	}

	/**
	 * Resolves a `$ref` against the current base URI: a JSON Pointer (`#/components/…`),
	 * an `$anchor` (`#node`), an `$id` the document declares, or another document,
	 * optionally followed by a pointer into it (`defs/a.yaml#/b`). Returns the value,
	 * the base URI it lives under, and where it is, for messages.
	 */
	locate(r: string, at: string): Located {
		const found = this.#found(r, at);
		if (found instanceof GenerateError) throw found;
		return found;
	}

	/** `locate`, or undefined where the document keeps it from finding the target (the conversion reports why, where it is). */
	tryLocate(r: string): Located | undefined {
		const found = this.#found(r, "");
		return found instanceof GenerateError ? undefined : found;
	}

	/**
	 * What a `$ref` reaches, or the document's error that keeps it from being found, located
	 * at `at`; any other error is kanagata's, and is thrown.
	 */
	#found(r: string, at: string): Located | GenerateError {
		// What a $ref reaches from a base never changes: it is found once.
		const key = `${this.base} ${r}`;
		const known = this.#located.get(key);
		if (known !== undefined) return known;
		const found = this.#find(r, at);
		if (!(found instanceof GenerateError)) this.#located.set(key, found);
		return found;
	}

	readonly #located = new Map<string, Located>();

	#find(r: string, at: string): Located | GenerateError {
		const why = notUriReference(r, this.base);
		if (why !== undefined) return new DiagError(at, `$ref ${why}: ${r}`);
		const url = new URL(r, this.base);
		const fragment = url.hash.slice(1);
		// A reference by the URL the document was read from still means the document.
		const named = withoutFragment(url);
		const resource = named === this.documentUrl ? this.documentBase : named;
		const index = this.#ids();
		// The file the $ref is in declares the resource, or the document does, or it is a file.
		const doc =
			resource === this.documentBase
				? this.root
				: (this.#idsIn.get(this.base)?.get(resource) ??
					index.ids.get(resource) ??
					this.#files.get(resource) ??
					this.#read(resource, r, at));
		if (doc instanceof GenerateError) return doc;
		// A plain name is an $anchor in the resource the document is: a file whose root has an
		// $id is that resource (3.1, 3.2), so its $refs resolve against the $id.
		const anchored = fragment !== "" && !fragment.startsWith("/");
		const scope = anchored ? (this.ownResource(doc) ?? resource) : resource;
		const value = anchored
			? index.anchors.get(`${scope}#${fragment}`)
			: pointer(doc, `#${fragment}`);
		if (value === undefined)
			return new DiagError(at, `$ref target not found: ${r}`);
		return {
			// A schema as its version defines it; no other object has the keywords it leaves out.
			value: this.schemaObject(value),
			base: fragment.startsWith("/")
				? this.#within(doc, fragment, resource)
				: scope,
			uri: `${scope}#${fragment}`,
			where: this.where(resource, fragment),
		};
	}

	/**
	 * The base URI at a JSON Pointer into a document: the nearest `$id` on the way
	 * (3.1, 3.2), whose relative `$ref`s resolve against it, or the document's.
	 */
	#within(doc: Value, fragment: string, resource: string): string {
		if (!this.refSiblings) return resource;
		let base = resource;
		let cur: Value | undefined = doc;
		// The pointer resolved, so every token names a member or an index.
		for (const raw of fragment.slice(1).split("/")) {
			const id = str(cur, "$id");
			if (id !== undefined && notUriReference(id, base) === undefined)
				base = withoutFragment(new URL(id, base));
			const token = unescapeToken(raw);
			cur = Array.isArray(cur) ? cur[Number(token)] : get(cur, token);
		}
		return base;
	}

	/** Whether a schema a reference reaches is hoisted. */
	isHoisted(target: { value: Value }): boolean {
		return this.#hoistedKeys.has(target.value);
	}

	/**
	 * Loads another document, once, and indexes its `$id`s and `$anchor`s. It is known by
	 * the URL it is read from: kanagata reads files, so another document's `$self` is not
	 * read, and its `$id`s are known inside it alone, whatever files were read before.
	 * The error where it cannot be read or parsed.
	 */
	#read(resource: string, r: string, at: string): Value | GenerateError {
		if (this.#load === undefined)
			return new DiagError(
				at,
				`external $ref, but the document's location is unknown: ${r}`,
			);
		let doc: Value;
		try {
			doc = this.#load(resource);
		} catch (e) {
			if (e instanceof GenerateError) return e;
			return new DiagError(
				at,
				`cannot read ${this.where(resource)}: ${(e as Error).message}`,
			);
		}
		const ids = new Map<string, Value>();
		if (this.refSiblings) indexIds(this.#ids(), ids, doc, resource);
		for (const uri of [resource, ...ids.keys()])
			if (!this.#idsIn.has(uri)) this.#idsIn.set(uri, ids);
		this.#files.set(resource, doc);
		return doc;
	}

	/** Other files, by the URL each is read from. */
	readonly #files = new Map<string, Value>();

	/** The schema resources (`$id`) of the file each base URI in another file is in: its URL, or a resource it declares. */
	readonly #idsIn = new Map<string, Map<string, Value>>();

	/** Whether a base URI is in another file: its URL, or a schema resource (`$id`) it declares. */
	isFile(base: string): boolean {
		return this.#idsIn.has(base);
	}

	#index?: Index;

	/**
	 * Every schema resource (`$id`) and `$anchor` in the document, by absolute URI, found on
	 * first use; other files add their `$anchor`s as they load, and keep their `$id`s apart.
	 */
	#ids(): Index {
		if (this.#index !== undefined) return this.#index;
		const index: Index = {
			ids: new Map(),
			anchors: new Map(),
			dynamic: new Set(),
			resources: new Map(),
			dynamicRefs: false,
		};
		// A 3.0 Schema Object has none of them (`NOT_IN_30`).
		if (this.refSiblings)
			indexIds(index, index.ids, this.root, this.documentBase);
		this.#index = index;
		return index;
	}

	#own?: Map<Value, string>;
	#aliases?: Map<Value, string>;

	/**
	 * The key in `components.schemas` of a schema object, so references to it stay
	 * named: the component itself, or the target of a component that is only a `$ref` or a
	 * `$dynamicRef`, as read from the document (with at most `title` and `description`, or
	 * anything next to a 3.0 `$ref`, which is ignored; a schema kept in another file,
	 * `User: { $ref: schemas/User.yaml }`). Schemas are matched by identity.
	 */
	componentKey(v: Value): string | undefined {
		if (this.#own === undefined) {
			const schemas = get(get(this.root, "components"), "schemas");
			const entries = schemas instanceof JsonObject ? schemas.entries : [];
			this.#own = new Map();
			for (const [key, raw] of entries) {
				const s = this.schemaObject(raw);
				if (!this.#own.has(s)) this.#own.set(s, key);
			}
		}
		const own = this.#own.get(v);
		if (own !== undefined) return own;
		if (this.#aliases === undefined) {
			const aliases = new Map<Value, string>();
			this.#aliases = aliases;
			const saved = this.scope;
			this.scope = [];
			try {
				for (const [s, key] of this.#own) {
					if (
						!(s instanceof JsonObject) ||
						(this.readsSiblings(s) &&
							!s.entries.every(([k]) => ALIAS_KEYS.has(k)))
					)
						continue;
					// A target that does not resolve is reported where the component is converted.
					const targets = this.withBase(this.documentBase, () =>
						this.reached(s),
					);
					if (targets.length !== 1) continue;
					const { value } = targets[0] as Located;
					if (!aliases.has(value)) aliases.set(value, key);
				}
			} finally {
				this.scope = saved;
			}
		}
		return this.#aliases.get(v);
	}

	/**
	 * Follows `$ref`s (parameters, request bodies, responses, path items) to the value,
	 * then runs `f` on it with the base URI of the document it is in.
	 */
	derefIn<T>(v: Value, at: string, f: (value: Value) => T): T {
		let cur = v;
		let base = this.base;
		for (let r = str(cur, "$ref"); r !== undefined; r = str(cur, "$ref")) {
			const ref = r;
			const target = this.withBase(base, () => this.locate(ref, at));
			cur = target.value;
			base = target.base;
		}
		const value = cur;
		return this.withBase(base, () => f(value));
	}

	/** Marks `r` as being expanded. Returns false if it already is (a cycle). */
	enter(r: string): boolean {
		if (this.#stack.includes(r)) return false;
		this.#stack.push(r);
		return true;
	}

	leave(): void {
		this.#stack.pop();
	}
}
