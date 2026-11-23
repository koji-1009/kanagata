// Paths, webhooks and operations → `Ty`.

import { isBinaryMedia, isFormMedia, isTextMedia, METHODS } from "./client.ts";
import { get, JsonObject, str, type Value } from "./json.ts";
import { type Ctx, child, DiagError } from "./pointer.ts";
import { doc, docText, schema } from "./schema.ts";
import {
	BLOB,
	lit,
	object,
	opRef,
	type Prop,
	prop,
	type Segment,
	STRING,
	type Ty,
	tuple,
	UNKNOWN,
	type View,
} from "./ty.ts";

const LOCATIONS = ["path", "query", "querystring", "header", "cookie"];

/** Header parameters OpenAPI says to ignore, in lower case. */
const RESERVED_HEADERS = ["accept", "content-type", "authorization"];

export interface Paths {
	paths: Prop[];
	/** Present only when the document has `webhooks` and is 3.1 or later. */
	webhooks?: Prop[];
	operations: Prop[];
	/** Operations with an operationId reached again, whose types `generate` compares. */
	again: Again[];
}

/**
 * An operation with an operationId reached again through a Path Item that paths or
 * webhooks share: `ty` is its type there, `first` the one `operations[id]` declares.
 */
export interface Again {
	id: string;
	ty: Ty;
	at: string;
	first: { ty: Ty; at: string };
}

/** A property with optional documentation. */
function documented(
	key: string,
	ty: Ty,
	optional: boolean,
	d: string | undefined,
): Prop {
	return d === undefined
		? { key, ty, optional }
		: { key, ty, optional, doc: d };
}

/**
 * `operations` by operationId: the Operation Object, its declaration, where it is, and
 * its types where it is reached again.
 */
type Operations = Map<
	string,
	{ op: JsonObject; prop: Prop; at: string; again: { ty: Ty; at: string }[] }
>;

/** `paths` and `webhooks`: both map names to Path Items, and share `operations`. */
export function paths(cx: Ctx, root: JsonObject): Paths {
	const operations: Operations = new Map();
	const out: Paths = {
		paths: pathItems(cx, root, "paths", operations),
		operations: [],
		again: [],
	};
	// `webhooks` is an OpenAPI 3.1 field, no field of a 3.0 document.
	const v30 = (root.get("openapi") as string).startsWith("3.0.");
	if (!v30 && root.get("webhooks") !== undefined)
		out.webhooks = pathItems(cx, root, "webhooks", operations);
	out.operations = [...operations.values()].map((o) => o.prop);
	out.again = [...operations].flatMap(([id, o]) =>
		o.again.map((a) => ({ id, ...a, first: { ty: o.prop.ty, at: o.at } })),
	);
	return out;
}

/**
 * Adds an operation with an operationId. A Path Item shared by `$ref` (or a YAML alias)
 * gives the same Operation Object again, which is declared once; another Operation
 * Object with the same operationId, which OpenAPI requires to be unique, is an error.
 * The same operation reached again can have another type (as a path's and a webhook's,
 * since the API sends a webhook's request; under paths with other path-level parameters)
 * but one `operations[id]`, so its type there is kept for `generate` to compare once the
 * components' second types are known.
 */
function addOperation(
	operations: Operations,
	id: string,
	op: JsonObject,
	prop: Prop,
	at: string,
): void {
	const known = operations.get(id);
	if (known === undefined) operations.set(id, { op, prop, at, again: [] });
	else if (known.op !== op)
		throw new DiagError(
			at,
			`operationId ${JSON.stringify(id)} is also ${known.at}'s; OpenAPI requires it to be unique`,
		);
	else known.again.push({ ty: prop.ty, at });
}

function pathItems(
	cx: Ctx,
	root: JsonObject,
	key: "paths" | "webhooks",
	operations: Operations,
): Prop[] {
	const entries = root.get(key);
	if (entries === undefined) return [];
	if (!(entries instanceof JsonObject))
		throw new DiagError(`#/${key}`, `${key} must be an object`);
	// Paths may have specification extensions; webhooks is a plain map of names.
	return pathItemsIn(
		cx,
		entries.entries.filter(([k]) => key === "webhooks" || !k.startsWith("x-")),
		`#/${key}`,
		key === "webhooks",
		operations,
	);
}

/**
 * Path Items by name (a path, a webhook's name, a callback's expression). Those the API
 * calls (`byApi`: webhooks, callbacks) are the other way round: the API sends the
 * request and reads the response.
 */
function pathItemsIn(
	cx: Ctx,
	entries: [string, Value][],
	at: string,
	byApi: boolean,
	operations: Operations,
): Prop[] {
	const out: Prop[] = [];
	for (const [path, rawItem] of entries) {
		const itemAt = child(at, path);
		const layers = itemLayers(cx, rawItem, itemAt);
		const ops = layers.flatMap((l) =>
			itemOperations(cx, l.item, itemAt).map(
				([m, o, a]) => [m, o, a, l.base] as const,
			),
		);
		ops.sort(([a], [b]) => methodOrder(a) - methodOrder(b));
		const methods: Prop[] = [];
		for (const [method, op, opAt, base] of ops) {
			// A webhook is called by the API: it sends the request and reads the response.
			const sent: View = byApi ? "read" : "write";
			// fetch cannot send a body with GET or HEAD (OpenAPI 3.0 has consumers ignore
			// one); a webhook's request is sent by the API, so it keeps its body.
			const body = byApi || (method !== "get" && method !== "head");
			const ty = cx.withBase(base, () =>
				operation(cx, operations, {
					layers,
					itemAt,
					op,
					at: opAt,
					sent,
					body,
					...(byApi ? {} : { path }),
				}),
			);
			const opDoc = doc(op);
			const id = op.get("operationId");
			if (id !== undefined && typeof id !== "string")
				throw new DiagError(
					child(opAt, "operationId"),
					"operationId must be a string",
				);
			if (id !== undefined && id !== "") {
				addOperation(
					operations,
					id,
					op,
					documented(id, ty, false, opDoc),
					opAt,
				);
				methods.push(prop(method, opRef(id)));
			} else {
				methods.push(documented(method, ty, false, opDoc));
			}
		}
		out.push(prop(path, object(methods)));
	}
	return out;
}

/** A Path Item object and the base URI of the document it is in. */
interface Layer {
	item: JsonObject;
	base: string;
}

/** Path Item fields that only describe it; kanagata reads neither. */
const DESCRIPTIVE = new Set(["$ref", "summary", "description"]);

/**
 * A Path Item and the Path Items its `$ref`s refer to, in turn: their fields are read
 * together, each under the base URI of its document. A field in two of them, whose
 * behaviour OpenAPI leaves undefined, is an error (descriptions and extensions aside).
 */
function itemLayers(cx: Ctx, raw: Value, itemAt: string): Layer[] {
	const layers: Layer[] = [];
	const seen = new Set<string>();
	let cur = raw;
	let base = cx.base;
	for (;;) {
		const item = objectAt(cur, itemAt, "a path item");
		for (const [k] of item.entries) {
			if (DESCRIPTIVE.has(k) || k.startsWith("x-")) continue;
			if (seen.has(k))
				throw new DiagError(
					child(itemAt, k),
					`${k} is both next to $ref and in the Path Item it refers to; OpenAPI leaves which one applies undefined`,
				);
			seen.add(k);
		}
		layers.push({ item, base });
		const r = item.str("$ref");
		if (r === undefined) return layers;
		const target = cx.withBase(base, () => cx.locate(r, itemAt));
		cur = target.value;
		base = target.base;
	}
}

/** Fixed methods in OpenAPI's order, then `additionalOperations` as written (a stable sort keeps them). */
function methodOrder(method: string): number {
	const i = (METHODS as readonly string[]).indexOf(method);
	return i < 0 ? METHODS.length : i;
}

/**
 * A Path Item's operations, keyed by method: its fixed fields in OpenAPI's order, then its
 * `additionalOperations`, whose keys are methods as they are sent (`COPY`). `query` and
 * `additionalOperations` are OpenAPI 3.2 fields.
 */
function itemOperations(
	cx: Ctx,
	item: JsonObject,
	itemAt: string,
): [method: string, op: JsonObject, at: string][] {
	const out: [string, JsonObject, string][] = [];
	for (const method of METHODS) {
		if (method === "query" && !cx.v32) continue;
		const op = item.get(method);
		const at = child(itemAt, method);
		if (op !== undefined)
			out.push([method, objectAt(op, at, "an operation"), at]);
	}
	const more = cx.v32 ? item.get("additionalOperations") : undefined;
	const moreAt = child(itemAt, "additionalOperations");
	if (more !== undefined && !(more instanceof JsonObject))
		throw new DiagError(moreAt, "additionalOperations must be an object");
	for (const [method, op] of more?.entries ?? []) {
		const at = child(moreAt, method);
		// OpenAPI forbids the method a fixed field sends (`POST` for `post`); the field's own
		// name would be that field in the declarations. Methods are case-sensitive, so
		// `Patch` is another method.
		const field = METHODS.find(
			(m) => method === m || method === m.toUpperCase(),
		);
		if (field !== undefined)
			throw new DiagError(
				at,
				`${method} is the Path Item's ${field} field, so additionalOperations must not have it`,
			);
		out.push([method, objectAt(op, at, "an operation"), at]);
	}
	return out;
}

/** A parameter, where it is, the base URI of the document it is in, and its JSDoc. */
type Param = [p: JsonObject, at: string, base: string, doc: string | undefined];

/**
 * The `description` next to a `$ref` to a parameter, request body or header, which
 * replaces the referenced one's in 3.1 and 3.2; 3.0 ignores a Reference Object's other fields.
 */
function refDescription(cx: Ctx, raw: Value): string | undefined {
	if (!cx.refSiblings || !(raw instanceof JsonObject)) return undefined;
	return raw.get("$ref") === undefined ? undefined : raw.str("description");
}

interface OperationAt {
	/** The Path Item, with those its `$ref`s refer to. */
	layers: Layer[];
	itemAt: string;
	op: JsonObject;
	at: string;
	/** The view of what the caller sends; the response is the other one. */
	sent: View;
	/** Whether the request can have a body, so `requestBody` is read. */
	body: boolean;
	/** The path template, for a path's operation (not a webhook's name or a callback's expression). */
	path?: string;
}

function operation(
	cx: Ctx,
	operations: Operations,
	{ layers, itemAt, op: o, at, sent, body: hasBody, path }: OperationAt,
): Ty {
	const fields: Prop[] = [];
	const received: View = sent === "write" ? "read" : "write";

	// The servers that serve this operation, in place of the document's: its own, or its
	// path item's (at most one layer has them). A webhook's request is sent by the API,
	// so it has none to choose.
	const servers =
		sent === "write"
			? (serverUrls(o, at) ??
				layers
					.map((l) => serverUrls(l.item, itemAt))
					.find((s) => s !== undefined))
			: undefined;
	if (servers !== undefined) fields.push(prop("servers", tuple(servers)));

	// Path-level parameters first; an operation parameter with the same in + name replaces it.
	const params: Param[] = [];
	for (const l of layers)
		cx.withBase(l.base, () => collectParams(cx, params, l.item, itemAt));
	collectParams(cx, params, o, at);
	// Each template expression names a path parameter (OpenAPI requires it), which the call fills in.
	for (const [, name] of (path ?? "").matchAll(/\{([^}]*)\}/g))
		if (!params.some(([p]) => p.str("in") === "path" && p.str("name") === name))
			throw new DiagError(
				at,
				`the path has {${name}}, which no path parameter declares; OpenAPI requires one for each`,
			);
	const groups: Prop[] = [];
	for (const loc of LOCATIONS) {
		// `in: querystring` is OpenAPI 3.2.
		if (loc === "querystring" && !cx.v32) continue;
		const props: Prop[] = [];
		for (const [p, pAt, base, pDoc] of params) {
			if (p.str("in") !== loc) continue;
			// OpenAPI requires a path parameter's required to be true: the path needs it.
			const required = booleanAt(p, pAt, "required");
			const optional = loc !== "path" && !required;
			const whole = loc === "querystring";
			const ty = cx.inMode(sent, () =>
				cx.withBase(base, () => paramType(cx, p, pAt, "parameter")),
			);
			// The whole query string (3.2) is one value; its name is not sent.
			if (whole) groups.push(documented(loc, ty, optional, pDoc));
			else props.push(documented(p.str("name") as string, ty, optional, pDoc));
		}
		if (props.length === 0) continue;
		groups.push({
			key: loc,
			ty: object(props),
			optional: props.every((p) => p.optional),
		});
	}
	if (groups.length > 0) fields.push(prop("parameters", object(groups)));

	const rawBody = o.get("requestBody");
	if (rawBody !== undefined && hasBody) {
		const bodyAt = child(at, "requestBody");
		const described = refDescription(cx, rawBody);
		cx.derefIn(rawBody, bodyAt, (value) => {
			const body = objectAt(value, bodyAt, "a request body");
			if (body.get("content") === undefined)
				throw new DiagError(bodyAt, "a request body must have content");
			// An empty content describes no representation: no body can be passed.
			const c = cx.inMode(sent, () => content(cx, body, bodyAt, false));
			fields.push(
				documented(
					"requestBody",
					object([
						prop("content", c.content ?? object([])),
						...(c.items === undefined ? [] : [prop("itemContent", c.items)]),
					]),
					!booleanAt(body, bodyAt, "required"),
					// A Request Body Object has no `deprecated`.
					docText(described ?? body.str("description")),
				),
			);
		});
	} else if (rawBody !== undefined) {
		// fetch sends no body with GET or HEAD, so the call cannot be the request a
		// required body asks for.
		const r = str(rawBody, "$ref");
		const body = r === undefined ? rawBody : cx.tryLocate(r)?.value;
		if (get(body, "required") === true)
			cx.warn(
				child(at, "requestBody"),
				"a required request body on GET or HEAD is left out: fetch cannot send one",
			);
	}

	const responses: Prop[] = [];
	const rs = o.get("responses");
	const base = child(at, "responses");
	const statuses =
		rs === undefined ? [] : objectAt(rs, base, "responses").entries;
	for (const [status, raw] of statuses) {
		if (status.startsWith("x-")) continue; // a specification extension, not a status
		const rAt = child(base, status);
		const parts = cx.derefIn(raw, rAt, (value) => {
			const r = objectAt(value, rAt, "a response");
			const parts: Prop[] = [];
			const h = cx.inMode(received, () => headers(cx, r, rAt));
			if (h !== undefined) parts.push(prop("headers", h));
			// The client reads a path's responses; a webhook's are the receiver's.
			const c = cx.inMode(received, () =>
				content(cx, r, rAt, received === "read"),
			);
			if (c.content !== undefined) parts.push(prop("content", c.content));
			if (c.items !== undefined) parts.push(prop("itemContent", c.items));
			return parts;
		});
		responses.push(prop(status, object(parts)));
	}
	fields.push(prop("responses", object(responses)));

	// Callbacks: requests the API sends to an expression's URL, typed as webhooks are.
	const callbacks = o.get("callbacks");
	if (callbacks !== undefined) {
		const cbAt = child(at, "callbacks");
		const named: Prop[] = [];
		for (const [name, raw] of objectAt(callbacks, cbAt, "callbacks").entries) {
			const nameAt = child(cbAt, name);
			const items = cx.derefIn(raw, nameAt, (value) =>
				pathItemsIn(
					cx,
					// A Callback Object may have specification extensions.
					objectAt(value, nameAt, "a callback").entries.filter(
						([k]) => !k.startsWith("x-"),
					),
					nameAt,
					true,
					operations,
				),
			);
			named.push(prop(name, object(items)));
		}
		fields.push(prop("callbacks", object(named)));
	}

	return object(fields);
}

/**
 * The URLs of a non-empty `servers`: a literal, or a template where a variable is the
 * values its `enum` lists (any string without one). A relative URL resolves against
 * where the document is served, which the types do not know: it is any URL that ends
 * the way it does (`/v2` is `` `${string}/v2` ``).
 */
function serverUrls(owner: JsonObject, ownerAt: string): Ty[] | undefined {
	const at = child(ownerAt, "servers");
	const servers = arrayAt(owner.get("servers"), at, "servers");
	if (servers.length === 0) return undefined;
	return servers.map((s, i) => {
		const url = s instanceof JsonObject ? s.str("url") : undefined;
		if (url === undefined)
			throw new DiagError(child(at, String(i)), "a server must have a url");
		return serverUrl(url, get(s, "variables"));
	});
}

function serverUrl(url: string, variables: Value | undefined): Ty {
	// A URL with a scheme is absolute; otherwise what is left past ./ and ../ ends it.
	const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
	const end = absolute
		? url
		: url.replace(/^(\.{1,2}\/)+/, "").replace(/^\//, "");
	if (!absolute && end === "") return STRING;
	const parts = end.split(/\{([^}]*)\}/);
	if (absolute && parts.length === 1) return lit(JSON.stringify(url));
	const text = (s: string) =>
		s.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
	const values = (name: string) => {
		const e = get(get(variables, name), "enum");
		return Array.isArray(e)
			? e.filter((x): x is string => typeof x === "string")
			: [];
	};
	const hole = (name: string) => {
		const vs = values(name);
		return vs.length === 0
			? "string"
			: vs.map((x) => JSON.stringify(x)).join(" | ");
	};
	const body = parts
		.map((p, j) => (j % 2 === 0 ? text(p) : `\${${hole(p)}}`))
		.join("");
	// A relative URL starts with whatever leads to where it ends.
	const lead = absolute ? "" : `\${${"string"}}/`;
	// The same strings as segments: the text, and each variable's values or any text.
	const seq: Segment[] = [
		...(absolute ? [] : [{ any: true as const }, { set: ["/"] }]),
		...parts.flatMap((p, j): Segment[] => {
			if (j % 2 === 0) return p === "" ? [] : [{ set: [p] }];
			const vs = values(p);
			return [vs.length === 0 ? { any: true } : { set: vs }];
		}),
	];
	return { kind: "template", text: `\`${lead}${body}\``, seq };
}

function collectParams(
	cx: Ctx,
	out: Param[],
	owner: JsonObject,
	ownerAt: string,
): void {
	const base = child(ownerAt, "parameters");
	arrayAt(owner.get("parameters"), base, "parameters").forEach((raw, i) => {
		const pAt = child(base, String(i));
		const described = refDescription(cx, raw);
		cx.derefIn(raw, pAt, (p) => collectParam(cx, out, p, pAt, described));
	});
}

/** Adds one parameter; header parameters OpenAPI reserves are left out, as it requires. */
function collectParam(
	cx: Ctx,
	out: Param[],
	value: Value,
	pAt: string,
	described: string | undefined,
): void {
	const p = objectAt(value, pAt, "a parameter");
	const name = p.str("name");
	const loc = p.str("in");
	if (name === undefined || loc === undefined)
		throw new DiagError(pAt, "a parameter must have name and in");
	if (loc === "header" && RESERVED_HEADERS.includes(asciiLower(name))) return;
	// Header names are case-insensitive, so `X-Id` replaces `x-id`; an operation has one
	// querystring, whose name is not sent.
	const same = (n: string) =>
		loc === "querystring" ||
		(loc === "header" ? asciiLower(n) === asciiLower(name) : n === name);
	// Collected parameters all have a name.
	const slot = out.findIndex(
		([q]) => q.str("in") === loc && same(q.str("name") as string),
	);
	// Its schema is converted later, against the document the parameter is in.
	const param: Param = [p, pAt, cx.base, doc(p, described)];
	if (slot >= 0) out[slot] = param;
	else out.push(param);
}

/** Lower-cases ASCII letters only, so non-ASCII names never match a reserved header. */
function asciiLower(s: string): string {
	return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The type of a parameter or header (`kind`): its `schema`, or the schema of its one
 * `content` media type; OpenAPI requires one of the two. A parameter's `content` is that
 * schema for application/x-www-form-urlencoded, which the client encodes as it does any
 * parameter; for any other media type it is the serialized text, a string, since the
 * client has no document to serialize the value by. A response header is read, not sent,
 * so it keeps the schema.
 */
function paramType(
	cx: Ctx,
	p: JsonObject,
	at: string,
	kind: "parameter" | "header",
): Ty {
	const s = p.get("schema");
	if (s !== undefined) return schema(cx, s, child(at, "schema"));
	const media = p.get("content");
	if (media === undefined)
		throw new DiagError(at, `a ${kind} must have schema or content`);
	const cAt = child(at, "content");
	const entries = objectAt(media, cAt, "content").entries;
	if (entries.length !== 1)
		throw new DiagError(
			cAt,
			`a ${kind}'s content must have exactly one media type`,
		);
	const [[mt, raw]] = entries as [[string, Value]];
	const mAt = child(cAt, mt);
	return mediaType(cx, raw, mAt, (m) => {
		const ty = schema(cx, m.get("schema") as Value, child(mAt, "schema"));
		const urlEncoded = essence(mt) === "application/x-www-form-urlencoded";
		return kind === "parameter" && !urlEncoded ? STRING : ty;
	});
}

/** The media type without parameters, in lower case, as the client compares it. */
function essence(mt: string): string {
	return (mt.split(";")[0] as string).trim().toLowerCase();
}

/**
 * Runs `f` on a Media Type Object, which may be a `$ref` in OpenAPI 3.2
 * (`components.mediaTypes`); before 3.2, `$ref` is no field of it.
 */
function mediaType<T>(
	cx: Ctx,
	raw: Value,
	at: string,
	f: (m: JsonObject) => T,
): T {
	const media = (m: Value) => f(objectAt(m, at, "a media type"));
	if (!cx.v32) return media(raw);
	return cx.derefIn(raw, at, media);
}

/** `v` as an object, or an error: `what` (`a response`) must be one. */
function objectAt(v: Value, at: string, what: string): JsonObject {
	if (v instanceof JsonObject) return v;
	throw new DiagError(at, `${what} must be an object`);
}

/** An array field (`servers`, `parameters`): its items, none when absent, or an error. */
function arrayAt(v: Value | undefined, at: string, key: string): Value[] {
	if (v === undefined) return [];
	if (Array.isArray(v)) return v;
	throw new DiagError(at, `${key} must be an array`);
}

/** A boolean field (`required`): false when absent, or an error. */
function booleanAt(owner: JsonObject, at: string, key: string): boolean {
	const v = owner.get(key);
	if (v === undefined || typeof v === "boolean") return v === true;
	throw new DiagError(child(at, key), `${key} must be a boolean`);
}

/** `{ Name: T }` for a response's `headers`; Content-Type is ignored, as OpenAPI requires. */
function headers(cx: Ctx, response: JsonObject, at: string): Ty | undefined {
	const declared = response.get("headers");
	if (declared === undefined) return undefined;
	const base = child(at, "headers");
	const props: Prop[] = [];
	for (const [name, raw] of objectAt(declared, base, "headers").entries) {
		if (name.toLowerCase() === "content-type") continue;
		const hAt = child(base, name);
		const described = refDescription(cx, raw);
		cx.derefIn(raw, hAt, (value) => {
			const h = objectAt(value, hAt, "a header");
			props.push(
				documented(
					name,
					paramType(cx, h, hAt, "header"),
					!booleanAt(h, hAt, "required"),
					doc(h, described),
				),
			);
		});
	}
	return props.length === 0 ? undefined : object(props);
}

/**
 * `{ "<media type>": T }` for a non-empty `content`, keeping every media type.
 * A binary media type is `Blob` and a text one `string` whatever its schema says, as is
 * a form the client reads (`clientReads`, a path's response): that is what the client
 * reads and sends. The schema is still converted so its errors are reported. The client
 * reads a sequential media type (`application/jsonl`, `text/event-stream`) whole, as these
 * rules say; its `itemSchema` (3.2) types each item, `{ "<media type>": Item }` in `items`.
 */
function content(
	cx: Ctx,
	owner: JsonObject,
	at: string,
	clientReads: boolean,
): { content?: Ty; items?: Ty } {
	const declared = owner.get("content");
	if (declared === undefined) return {};
	const base = child(at, "content");
	const media = objectAt(declared, base, "content");
	if (media.entries.length === 0) return {};
	const items: Prop[] = [];
	const props = media.entries.map(([mt, raw]) => {
		const mAt = child(base, mt);
		// Bytes are bytes in a body a wildcard names, which is sent as it is, and in
		// a multipart body's parts; elsewhere they are text in JSON or a form.
		const pos = mt.startsWith("multipart/")
			? "parts"
			: mt.includes("*")
				? "body"
				: undefined;
		const ty = mediaType(cx, raw, mAt, (m) => {
			const item = cx.v32 ? m.get("itemSchema") : undefined;
			if (item !== undefined)
				items.push(prop(mt, schema(cx, item, child(mAt, "itemSchema"))));
			const s = m.get("schema");
			return s === undefined
				? UNKNOWN
				: cx.withRaw(pos, () => schema(cx, s, child(mAt, "schema")));
		});
		const text = isTextMedia(mt) || (clientReads && isFormMedia(mt));
		return prop(mt, isBinaryMedia(mt) ? BLOB : text ? STRING : ty);
	});
	return items.length === 0
		? { content: object(props) }
		: { content: object(props), items: object(items) };
}
