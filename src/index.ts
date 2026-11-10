// Generate TypeScript declarations from OpenAPI 3.0 / 3.1 (JSON or YAML).

import { type Decl, render } from "./emit.ts";
import { GenerateError } from "./error.ts";
import { inputNames, typeNames } from "./ident.ts";
import { get, JsonObject, parse, type Value } from "./json.ts";
import { paths } from "./operation.ts";
import { Ctx, child, type Diag, DiagError, type Hoisted } from "./pointer.ts";
import { doc, schema } from "./schema.ts";
import { equal, type Prop, prop, ref, refs, type Ty, type View } from "./ty.ts";
import { parseYaml } from "./yaml.ts";

export { GenerateError } from "./error.ts";
export type { Diag } from "./pointer.ts";

/** Generated declarations and the warnings raised on the way. */
export interface Generated {
	code: string;
	warnings: Diag[];
}

/** Where the document is, so that `$ref`s to other files can be followed. */
export interface Source {
	/** The document's absolute URL, such as a `file:` URL; relative `$ref`s resolve against it. */
	url: string;
	/** The text of the document at an absolute URL; throws, with a message saying why, when it cannot be read. */
	read: (url: string) => string;
}

/** Text that starts with `{` (or is blank) is JSON; anything else is YAML. */
function parseText(src: string, warnings: Diag[]): Value {
	return /^﻿?\s*(\{|$)/.test(src) ? parse(src) : parseYaml(src, warnings);
}

/**
 * Converts an OpenAPI document (JSON or YAML) to a `.d.ts` file. With a `source`,
 * `$ref`s to other files are read through it. Throws GenerateError.
 */
export function generate(src: string, source?: Source): Generated {
	const read: Diag[] = [];
	const root = parseText(src, read);
	if (!(root instanceof JsonObject))
		throw new DiagError("#", "an OpenAPI document is an object");
	checkVersion(root);

	const s = get(root.get("components"), "schemas");
	if (s !== undefined && !(s instanceof JsonObject)) {
		throw new DiagError("#/components/schemas", "schemas must be an object");
	}
	const schemas = s?.entries ?? [];
	const cx: Ctx = new Ctx(
		root,
		new Set(schemas.map(([k]) => k)),
		(root.get("openapi") as string).startsWith("3.1."),
		source && {
			url: source.url,
			load: (url) => loadText(cx, url, source.read(url)),
		},
	);

	const p = paths(cx, root);

	// Every component schema, then every schema from another file that got a key (the
	// list grows as they are converted), named, in both views; the write view gets its
	// own declaration only where the two differ (readOnly / writeOnly here or in a reference).
	const converted: Converted[] = schemas.map(([key, value]) => {
		const at = child("#/components/schemas", key);
		return {
			key,
			value,
			at,
			read: cx.inMode("read", () => schema(cx, value, at)),
			write: cx.inMode("write", () => schema(cx, value, at)),
		};
	});
	for (let i = 0; i < cx.hoisted.length; i++) {
		const { key, value, base, where } = cx.hoisted[i] as Hoisted;
		const view = (mode: View) =>
			cx.withBase(base, () => cx.inMode(mode, () => schema(cx, value, where)));
		converted.push({
			key,
			value,
			at: where,
			read: view("read"),
			write: view("write"),
		});
	}
	const names = typeNames(converted.map((c) => c.key));
	// typeNames gives one name per key, in order
	const components: Component[] = converted.map((c, i) => ({
		...c,
		name: names[i] as string,
	}));
	const differing = differingViews(components);
	const withInput = components.filter((c) => differing.has(c.key));
	const inputs = inputNames(
		withInput.map((c) => c.name),
		names,
	);
	const readName = new Map(components.map((c) => [c.key, c.name]));
	const writeName = new Map(
		withInput.map((c, j) => [c.key, inputs[j] as string]),
	);
	const name = (key: string, view: View) =>
		(view === "write" ? writeName.get(key) : undefined) ??
		(readName.get(key) as string);

	const decls: Decl[] = [];
	const index: Prop[] = [];
	for (const c of components) {
		const d = doc(c.value);
		const decl = (n: string, ty: Ty): Decl =>
			d === undefined ? { name: n, ty } : { name: n, ty, doc: d };
		index.push(prop(c.key, ref(c.key)));
		decls.push(decl(c.name, c.read));
		const w = writeName.get(c.key);
		if (w !== undefined) decls.push(decl(w, c.write));
	}

	const code = render({ ...p, schemas: index, decls }, name);
	return { code, warnings: [...read, ...cx.warnings] };
}

/** Parses another document; its problems are located in that file (`defs/a.yaml:3:1`, `defs/a.yaml#/b`). */
function loadText(cx: Ctx, url: string, text: string): Value {
	const file = cx.where(url);
	const warnings: Diag[] = [];
	try {
		const doc = parseText(text, warnings);
		for (const w of warnings) cx.warn(`${file}${w.at}`, w.msg);
		return doc;
	} catch (e) {
		// The parsers throw only syntax errors, located by line and column.
		const err = e as GenerateError;
		throw new GenerateError(err.kind, `${file}:${err.message}`);
	}
}

interface Converted {
	key: string;
	value: Value;
	/** Where it is defined, for messages. */
	at: string;
	read: Ty;
	write: Ty;
}

interface Component extends Converted {
	name: string;
}

/**
 * The schemas whose read and write views differ: in their own conversion (ignoring
 * which view their references point to), or through a schema they reference.
 */
function differingViews(components: readonly Component[]): Set<string> {
	const differing = new Set(
		components.filter((c) => !equal(c.read, c.write, false)).map((c) => c.key),
	);
	const referrers = new Map<string, string[]>();
	for (const c of components)
		for (const r of refs(c.write)) {
			const list = referrers.get(r) ?? [];
			list.push(c.key);
			referrers.set(r, list);
		}
	// The closure over "is referred to by": a Set's iteration visits what is added during it.
	for (const key of differing)
		for (const r of referrers.get(key) ?? []) differing.add(r);
	return differing;
}

function checkVersion(root: JsonObject): void {
	const v = root.get("openapi");
	if (typeof v === "string") {
		if (v.startsWith("3.0.") || v.startsWith("3.1.")) return;
		throw new DiagError(
			"#/openapi",
			`unsupported OpenAPI version ${JSON.stringify(v)} (3.0.x or 3.1.x required)`,
		);
	}
	if (v !== undefined)
		throw new DiagError("#/openapi", "openapi must be a string");
	if (root.get("swagger") !== undefined) {
		throw new DiagError(
			"#/swagger",
			"Swagger 2.0 is not supported (convert it to OpenAPI 3.x first)",
		);
	}
	throw new DiagError("#", "missing openapi version field");
}
