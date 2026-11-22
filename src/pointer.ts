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

function withoutFragment(url: URL): string {
	return url.href.slice(0, url.href.length - url.hash.length).replace(/#$/, "");
}

/** A percent-encoded path segment, decoded. */
function decodePath(segment: string): string {
	return decodeURIComponent(segment);
}

interface Index {
	ids: Map<string, Value>;
	anchors: Map<string, Value>;
	/** The `$dynamicAnchor`s, by resource and name (`https://example.com/tree#node`). */
	dynamic: Set<string>;
}

/**
 * Adds the schema resources (`$id`) and `$anchor`s in `doc` to the index, by absolute
 * URI. Values of `example`, `default`, `const` and `enum` are data, not schemas, unless
 * the key names a property (in `properties`, `$defs`, …).
 */
function indexIds(index: Index, doc: Value, base: string): void {
	const walk = (v: Value, base: string, names: boolean): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x, base, false);
			return;
		}
		if (!(v instanceof JsonObject)) return;
		let here = base;
		const id = v.str("$id");
		// An $id that is not a URI cannot be referred to.
		if (id !== undefined && URL.canParse(id, base)) {
			here = withoutFragment(new URL(id, base));
			if (!index.ids.has(here)) index.ids.set(here, v);
		}
		// A $dynamicAnchor is a plain-name fragment too (JSON Schema 2020-12, 8.2.2).
		for (const key of ["$anchor", "$dynamicAnchor"]) {
			const anchor = v.str(key);
			if (anchor !== undefined && !index.anchors.has(`${here}#${anchor}`))
				index.anchors.set(`${here}#${anchor}`, v);
		}
		const dynamic = v.str("$dynamicAnchor");
		if (dynamic !== undefined) index.dynamic.add(`${here}#${dynamic}`);
		for (const [k, x] of v.entries) {
			if (!names && DATA.has(k)) continue;
			walk(x, here, !names && NAME_MAPS.has(k));
		}
	};
	walk(doc, base, false);
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
interface Located {
	value: Value;
	base: string;
	uri: string;
	where: string;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** Schema keywords a component may have next to `$ref` and still be another name for its target. */
const ALIAS_KEYS = new Set(["$ref", "description", "title"]);

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
	/**
	 * Which view a schema is converted for: `read` (responses) leaves out writeOnly
	 * properties, `write` (request bodies, parameters) leaves out readOnly ones.
	 */
	mode: View = "read";
	/** Whether keywords next to `$ref` apply (OpenAPI 3.1) or are ignored (3.0). */
	readonly refSiblings: boolean;
	/** Whether 3.0 `nullable: true` means "this schema or null" instead of adding `null` to `type`. */
	readonly looseNullable: boolean;
	/** Schemas from other files that got a key, in the order they were first referred to. */
	readonly hoisted: Hoisted[] = [];
	/** Hoisted keys by the URI of the schema. */
	readonly #hoistedKeys = new Map<string, string>();
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
		// By location, not by value: two equal `true` schemas are two schemas.
		const known = this.#hoistedKeys.get(target.uri);
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
		this.#hoistedKeys.set(target.uri, key);
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
			(typeof self !== "string" || !URL.canParse(self, this.documentUrl))
		)
			throw new DiagError("#/$self", "$self must be a URI reference");
		this.documentBase =
			self === undefined
				? this.documentUrl
				: withoutFragment(new URL(self, this.documentUrl));
		this.base = this.documentBase;
	}

	warn(at: string, msg: string): void {
		const key = `${at}\n${msg}`;
		if (!this.#warnings.has(key)) this.#warnings.set(key, { at, msg });
	}

	get warnings(): Diag[] {
		return [...this.#warnings.values()];
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

	/** Converts with `parent` around the schema converted next, then restores. */
	withAround<T>(parent: JsonObject, f: () => T): T {
		const saved = this.#nextAround;
		this.#nextAround = [...this.around, parent];
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
		for (const m of members) this.#leftOut.set(m, keys);
		try {
			return f();
		} finally {
			for (const m of members) this.#leftOut.delete(m);
		}
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
		try {
			return this.withBase(base, f);
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

	/** The base URI inside a schema with `$id`, resolved against the current one. */
	baseOf(id: string): string {
		return withoutFragment(new URL(id, this.base));
	}

	/**
	 * Resolves a `$ref` against the current base URI: a JSON Pointer (`#/components/…`),
	 * an `$anchor` (`#node`), an `$id` the document declares, or another document,
	 * optionally followed by a pointer into it (`defs/a.yaml#/b`). Returns the value,
	 * the base URI it lives under, and where it is, for messages.
	 */
	locate(r: string, at: string): Located {
		// What a $ref reaches from a base never changes: it is found once.
		const key = `${this.base} ${r}`;
		let found = this.#located.get(key);
		if (found === undefined) {
			found = this.#find(r, at);
			this.#located.set(key, found);
		}
		return found;
	}

	readonly #located = new Map<string, Located>();

	#find(r: string, at: string): Located {
		const url = new URL(r, this.base);
		const fragment = url.hash.slice(1);
		// A reference by the URL the document was read from still means the document.
		const named = withoutFragment(url);
		const resource = named === this.documentUrl ? this.documentBase : named;
		const index = this.#ids();
		const doc =
			resource === this.documentBase
				? this.root
				: (index.ids.get(resource) ?? this.#read(resource, r, at));
		const value =
			fragment === "" || fragment.startsWith("/")
				? pointer(doc, `#${fragment}`)
				: index.anchors.get(`${resource}#${fragment}`);
		if (value === undefined)
			throw new DiagError(at, `$ref target not found: ${r}`);
		return {
			value,
			base: fragment.startsWith("/")
				? this.#within(doc, fragment, resource)
				: resource,
			uri: `${resource}#${fragment}`,
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
			if (id !== undefined && URL.canParse(id, base))
				base = withoutFragment(new URL(id, base));
			const token = unescapeToken(raw);
			cur = Array.isArray(cur) ? cur[Number(token)] : get(cur, token);
		}
		return base;
	}

	/** Whether a schema is hoisted, by its URI. */
	isHoisted(uri: string): boolean {
		return this.#hoistedKeys.has(uri);
	}

	/**
	 * Loads another document, once, and indexes its `$id`s and `$anchor`s. It is known by
	 * the URL it is read from: kanagata reads files, so another document's `$self` is not read.
	 */
	#read(resource: string, r: string, at: string): Value {
		if (this.#load === undefined)
			throw new DiagError(
				at,
				`external $ref, but the document's location is unknown: ${r}`,
			);
		let doc: Value;
		try {
			doc = this.#load(resource);
		} catch (e) {
			if (e instanceof GenerateError) throw e;
			throw new DiagError(
				at,
				`cannot read ${this.where(resource)}: ${(e as Error).message}`,
			);
		}
		const index = this.#ids();
		index.ids.set(resource, doc);
		indexIds(index, doc, resource);
		this.#files.add(resource);
		return doc;
	}

	readonly #files = new Set<string>();

	/** Whether a base URI is another file (not the document, nor an `$id` resource). */
	isFile(base: string): boolean {
		return this.#files.has(base);
	}

	/** `locate`, or undefined where it would fail (the conversion reports the failure). */
	tryLocate(r: string): Located | undefined {
		try {
			return this.locate(r, "");
		} catch {
			return undefined;
		}
	}

	#index?: Index;

	/** Every schema resource (`$id`) and `$anchor` in the document, by absolute URI, found on first use; other documents add theirs as they load. */
	#ids(): Index {
		if (this.#index !== undefined) return this.#index;
		const index: Index = {
			ids: new Map(),
			anchors: new Map(),
			dynamic: new Set(),
		};
		indexIds(index, this.root, this.documentBase);
		this.#index = index;
		return index;
	}

	#own?: Map<Value, string>;
	#aliases?: Map<Value, string>;

	/**
	 * The key in `components.schemas` of a schema object, so references to it stay
	 * named: the component itself, or the target of a component that is only a `$ref`
	 * (with at most `title` and `description`; a schema kept in another file,
	 * `User: { $ref: schemas/User.yaml }`). Schemas are
	 * matched by identity.
	 */
	componentKey(v: Value): string | undefined {
		if (this.#own === undefined) {
			const schemas = get(get(this.root, "components"), "schemas");
			const entries = schemas instanceof JsonObject ? schemas.entries : [];
			this.#own = new Map();
			for (const [key, s] of entries)
				if (!this.#own.has(s)) this.#own.set(s, key);
		}
		const own = this.#own.get(v);
		if (own !== undefined) return own;
		if (this.#aliases === undefined) {
			const aliases = new Map<Value, string>();
			this.#aliases = aliases;
			for (const [s, key] of this.#own) {
				const r = str(s, "$ref");
				if (
					r === undefined ||
					!(s as JsonObject).entries.every(([k]) => ALIAS_KEYS.has(k))
				)
					continue;
				// A target that does not resolve is reported where the component is converted.
				const target = this.withBase(
					this.documentBase,
					() => this.tryLocate(r)?.value,
				);
				if (target !== undefined && !aliases.has(target))
					aliases.set(target, key);
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
