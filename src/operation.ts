// Paths, webhooks and operations → `Ty`.

import { isBinaryMedia, isFormMedia, isTextMedia, METHODS } from "./client.ts";
import { JsonObject, type Value } from "./json.ts";
import { type Ctx, child, DiagError } from "./pointer.ts";
import { doc, schema } from "./schema.ts";
import {
	BLOB,
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

/** `paths` and `webhooks`: both map names to Path Items, and share `operations`. */
export function paths(cx: Ctx, root: JsonObject): Paths {
	const operations: Prop[] = [];
	const out: Paths = {
		paths: pathItems(cx, root, "paths", operations),
		operations,
	};
	if (root.get("webhooks") !== undefined)
		out.webhooks = pathItems(cx, root, "webhooks", operations);
	return out;
}

function pathItems(
	cx: Ctx,
	root: JsonObject,
	key: "paths" | "webhooks",
	operations: Prop[],
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
			const item = value as JsonObject;
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
				const id = op.str("operationId");
				if (id !== undefined && id !== "") {
					operations.push(documented(id, ty, false, opDoc));
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
		if (op !== undefined) out.push([method, operationObject(op, at), at]);
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
		out.push([method, operationObject(op, at), at]);
	}
	return out;
}

function operationObject(op: Value, at: string): JsonObject {
	if (op instanceof JsonObject) return op;
	throw new DiagError(at, "an operation must be an object");
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
			const optional = loc !== "path" && p.get("required") !== true;
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
			const body = value as JsonObject;
			const c = cx.inMode(sent, () => content(cx, body, bodyAt)) as Ty;
			fields.push(
				documented(
					"requestBody",
					object([prop("content", c)]),
					body.get("required") !== true,
					doc(body),
				),
			);
		});
	}

	const responses: Prop[] = [];
	const rs = o.get("responses") as JsonObject | undefined;
	const base = child(at, "responses");
	for (const [status, raw] of rs?.entries ?? []) {
		if (status.startsWith("x-")) continue; // a specification extension, not a status
		const rAt = child(base, status);
		const parts = cx.derefIn(raw, rAt, (r) => {
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
	const servers = owner.get("servers");
	if (!Array.isArray(servers) || servers.length === 0) return undefined;
	return servers.map((s, i) => {
		const url = s instanceof JsonObject ? s.str("url") : undefined;
		if (url === undefined)
			throw new DiagError(
				child(child(ownerAt, "servers"), String(i)),
				"a server must have a url",
			);
		return url.includes("{") ? STRING : lit(JSON.stringify(url));
	});
}

function collectParams(
	cx: Ctx,
	out: Param[],
	owner: JsonObject,
	ownerAt: string,
): void {
	const list = owner.get("parameters");
	if (!Array.isArray(list)) return;
	const base = child(ownerAt, "parameters");
	list.forEach((raw, i) => {
		const pAt = child(base, String(i));
		cx.derefIn(raw, pAt, (p) => collectParam(cx, out, p, pAt));
	});
}

/** Adds one parameter; header parameters OpenAPI reserves are left out, as it requires. */
function collectParam(cx: Ctx, out: Param[], value: Value, pAt: string): void {
	if (!(value instanceof JsonObject))
		throw new DiagError(pAt, "a parameter must be an object");
	const p = value;
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
	const first = media instanceof JsonObject ? media.entries[0] : undefined;
	if (first === undefined)
		throw new DiagError(cAt, "content must have a media type");
	const [mt, raw] = first;
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
	if (!cx.v32) return f(raw as JsonObject);
	return cx.derefIn(raw, at, (m) => f(m as JsonObject));
}

/** `{ Name: T }` for a response's `headers`; Content-Type is ignored, as OpenAPI requires. */
function headers(cx: Ctx, response: Value, at: string): Ty | undefined {
	const declared = (response as JsonObject).get("headers") as
		| JsonObject
		| undefined;
	if (declared === undefined) return undefined;
	const base = child(at, "headers");
	const props: Prop[] = [];
	for (const [name, raw] of declared.entries) {
		if (name.toLowerCase() === "content-type") continue;
		const hAt = child(base, name);
		cx.derefIn(raw, hAt, (h) => {
			if (!(h instanceof JsonObject))
				throw new DiagError(hAt, "a header must be an object");
			props.push(
				documented(
					name,
					paramType(cx, h, hAt, "header"),
					h.get("required") !== true,
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
function content(cx: Ctx, owner: Value, at: string): Ty | undefined {
	const media = (owner as JsonObject).get("content") as JsonObject | undefined;
	if (media === undefined || media.entries.length === 0) return undefined;
	const base = child(at, "content");
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
