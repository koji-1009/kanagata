// Paths, webhooks and operations → `Ty`.

import { isBinaryMedia, isFormMedia, isTextMedia, METHODS } from "./client.ts";
import { JsonObject, type Value } from "./json.ts";
import { type Ctx, child, DiagError } from "./pointer.ts";
import { doc, schema } from "./schema.ts";
import {
	BLOB,
	equal,
	lit,
	object,
	opRef,
	type Prop,
	prop,
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
	/** Present only when the document has `webhooks` (3.1 and later). */
	webhooks?: Prop[];
	operations: Prop[];
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

/** `operations` by operationId: the Operation Object, its declaration, and where it is. */
type Operations = Map<string, { op: JsonObject; prop: Prop; at: string }>;

/** `paths` and `webhooks`: both map names to Path Items, and share `operations`. */
export function paths(cx: Ctx, root: JsonObject): Paths {
	const operations: Operations = new Map();
	const out: Paths = {
		paths: pathItems(cx, root, "paths", operations),
		operations: [],
	};
	if (root.get("webhooks") !== undefined)
		out.webhooks = pathItems(cx, root, "webhooks", operations);
	out.operations = [...operations.values()].map((o) => o.prop);
	return out;
}

/**
 * Adds an operation with an operationId. A Path Item shared by `$ref` (or a YAML alias)
 * gives the same Operation Object again, which is declared once; another Operation
 * Object with the same operationId, which OpenAPI requires to be unique, is an error.
 * The same operation as a path's and a webhook's has two types (the API sends a
 * webhook's request) but one `operations[id]`, which TypeScript cannot declare twice.
 */
function addOperation(
	operations: Operations,
	id: string,
	op: JsonObject,
	prop: Prop,
	at: string,
): void {
	const known = operations.get(id);
	if (known === undefined) operations.set(id, { op, prop, at });
	else if (known.op !== op)
		throw new DiagError(
			at,
			`operationId ${JSON.stringify(id)} is also ${known.at}'s; OpenAPI requires it to be unique`,
		);
	else if (!equal(known.prop.ty, prop.ty))
		throw new DiagError(
			at,
			`operation ${JSON.stringify(id)} is also ${known.at}, as a path's and a webhook's, whose types differ; operations[${JSON.stringify(id)}] has one type`,
		);
}

function pathItems(
	cx: Ctx,
	root: JsonObject,
	key: "paths" | "webhooks",
	operations: Operations,
): Prop[] {
	const out: Prop[] = [];
	const entries = root.get(key);
	if (entries === undefined) return out;
	if (!(entries instanceof JsonObject))
		throw new DiagError(`#/${key}`, `${key} must be an object`);
	for (const [path, rawItem] of entries.entries) {
		// Paths may have specification extensions; webhooks is a plain map of names.
		if (key === "paths" && path.startsWith("x-")) continue;
		const itemAt = child(`#/${key}`, path);
		const methods = cx.derefIn(rawItem, itemAt, (value) => {
			const item = objectAt(value, itemAt, "a path item");
			const methods: Prop[] = [];
			for (const [method, op, opAt] of itemOperations(cx, item, itemAt)) {
				// A webhook is called by the API: it sends the request and reads the response.
				const sent: View = key === "webhooks" ? "read" : "write";
				// fetch cannot send a body with GET or HEAD (OpenAPI 3.0 has consumers ignore
				// one); a webhook's request is sent by the API, so it keeps its body.
				const body =
					key === "webhooks" || (method !== "get" && method !== "head");
				const ty = operation(cx, { item, itemAt, op, at: opAt, sent, body });
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
			return methods;
		});
		out.push(prop(path, object(methods)));
	}
	return out;
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

/** A parameter, where it is, and the base URI of the document it is in. */
type Param = [p: JsonObject, at: string, base: string];

interface OperationAt {
	item: JsonObject;
	itemAt: string;
	op: JsonObject;
	at: string;
	/** The view of what the caller sends; the response is the other one. */
	sent: View;
	/** Whether the request can have a body, so `requestBody` is read. */
	body: boolean;
}

function operation(
	cx: Ctx,
	{ item, itemAt, op: o, at, sent, body: hasBody }: OperationAt,
): Ty {
	const fields: Prop[] = [];
	const received: View = sent === "write" ? "read" : "write";

	// The servers that serve this operation, in place of the document's: its own, or its
	// path item's. A webhook's request is sent by the API, so it has none to choose.
	const servers =
		sent === "write"
			? (serverUrls(o, at) ?? serverUrls(item, itemAt))
			: undefined;
	if (servers !== undefined) fields.push(prop("servers", tuple(servers)));

	// Path-level parameters first; an operation parameter with the same in + name replaces it.
	const params: Param[] = [];
	collectParams(cx, params, item, itemAt);
	collectParams(cx, params, o, at);
	const groups: Prop[] = [];
	for (const loc of LOCATIONS) {
		// `in: querystring` is OpenAPI 3.2.
		if (loc === "querystring" && !cx.v32) continue;
		const props: Prop[] = [];
		for (const [p, pAt, base] of params) {
			if (p.str("in") !== loc) continue;
			const optional = loc !== "path" && !booleanAt(p, pAt, "required");
			const whole = loc === "querystring";
			const ty = cx.inMode(sent, () =>
				cx.withBase(base, () => paramType(cx, p, pAt, "parameter", whole)),
			);
			// The whole query string (3.2) is one value; its name is not sent.
			if (whole) groups.push(documented(loc, ty, optional, doc(p)));
			else
				props.push(documented(p.str("name") as string, ty, optional, doc(p)));
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
		cx.derefIn(rawBody, bodyAt, (value) => {
			const body = objectAt(value, bodyAt, "a request body");
			if (body.get("content") === undefined)
				throw new DiagError(bodyAt, "a request body must have content");
			// An empty content describes no representation: no body can be passed.
			const c = cx.inMode(sent, () => content(cx, body, bodyAt)) ?? object([]);
			fields.push(
				documented(
					"requestBody",
					object([prop("content", c)]),
					!booleanAt(body, bodyAt, "required"),
					doc(body),
				),
			);
		});
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
			const c = cx.inMode(received, () => content(cx, r, rAt));
			if (c !== undefined) parts.push(prop("content", c));
			return parts;
		});
		responses.push(prop(status, object(parts)));
	}
	fields.push(prop("responses", object(responses)));

	return object(fields);
}

/**
 * The URLs of a non-empty `servers`, as literals; a URL with variables (`{region}`) is
 * any string, since TypeScript cannot check the template.
 */
function serverUrls(owner: JsonObject, ownerAt: string): Ty[] | undefined {
	const at = child(ownerAt, "servers");
	const servers = arrayAt(owner.get("servers"), at, "servers");
	if (servers.length === 0) return undefined;
	return servers.map((s, i) => {
		const url = s instanceof JsonObject ? s.str("url") : undefined;
		if (url === undefined)
			throw new DiagError(child(at, String(i)), "a server must have a url");
		return url.includes("{") ? STRING : lit(JSON.stringify(url));
	});
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
		cx.derefIn(raw, pAt, (p) => collectParam(cx, out, p, pAt));
	});
}

/** Adds one parameter; header parameters OpenAPI reserves are left out, as it requires. */
function collectParam(cx: Ctx, out: Param[], value: Value, pAt: string): void {
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
	const param: Param = [p, pAt, cx.base];
	if (slot >= 0) out[slot] = param;
	else out.push(param);
}

/** Lower-cases ASCII letters only, so non-ASCII names never match a reserved header. */
function asciiLower(s: string): string {
	return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The type of a parameter or header (`kind`): its `schema`, or the schema of its one
 * `content` media type; OpenAPI requires one of the two. A querystring (`whole`) is that
 * schema for application/x-www-form-urlencoded, which the client URL-encodes; for any
 * other media type it is the serialized text, a string.
 */
function paramType(
	cx: Ctx,
	p: JsonObject,
	at: string,
	kind: "parameter" | "header",
	whole = false,
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
		return whole && !urlEncoded ? STRING : ty;
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
		cx.derefIn(raw, hAt, (value) => {
			const h = objectAt(value, hAt, "a header");
			props.push(
				documented(
					name,
					paramType(cx, h, hAt, "header"),
					!booleanAt(h, hAt, "required"),
					doc(h),
				),
			);
		});
	}
	return props.length === 0 ? undefined : object(props);
}

/**
 * `{ "<media type>": T }` for a non-empty `content`, keeping every media type.
 * A binary media type is `Blob` and a text one `string` whatever its schema says, as is
 * a form in a response (read view): that is what the client reads and sends. The schema
 * is still converted so its errors are reported, and so is `itemSchema` (3.2): the client
 * reads a sequential media type (`application/jsonl`, `text/event-stream`) whole, as these
 * rules say, not item by item.
 */
function content(cx: Ctx, owner: JsonObject, at: string): Ty | undefined {
	const declared = owner.get("content");
	if (declared === undefined) return undefined;
	const base = child(at, "content");
	const media = objectAt(declared, base, "content");
	if (media.entries.length === 0) return undefined;
	return object(
		media.entries.map(([mt, raw]) => {
			const mAt = child(base, mt);
			const ty = mediaType(cx, raw, mAt, (m) => {
				const items = cx.v32 ? m.get("itemSchema") : undefined;
				if (items !== undefined) schema(cx, items, child(mAt, "itemSchema"));
				const s = m.get("schema");
				return s === undefined ? UNKNOWN : schema(cx, s, child(mAt, "schema"));
			});
			const text = isTextMedia(mt) || (cx.mode === "read" && isFormMedia(mt));
			return prop(mt, isBinaryMedia(mt) ? BLOB : text ? STRING : ty);
		}),
	);
}
