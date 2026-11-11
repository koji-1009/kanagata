// Type tests for client.ts, checked by `tsc -p tests/ts`. Nothing here runs.
// The schemas are the hand-written expectations in tests/spec.

import {
	type Client,
	createClient,
	type Method,
	type ParseAs,
} from "../../src/client.ts";
import type * as AnyOf from "../spec/anyof/expected";
import type * as Basic from "../spec/basic/expected";
import type * as Api from "../spec/client/expected";
import type * as Composition from "../spec/composition-with-type/expected";
import type * as Missing from "../spec/object-required-optional/expected";
import type * as Cookies from "../spec/params-header-cookie/expected";
import type * as Derived from "../spec/read-write-allof/expected";
import type * as ReadWrite from "../spec/read-write-only/expected";
import type * as RefSiblings from "../spec/ref-siblings-31/expected";
import type * as AnyRef from "../spec/required-any-ref/expected";
import type * as NoResponses from "../spec/responses-missing/expected";
import type * as Servers from "../spec/servers/expected";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
/** The type argument is the assertion: its `extends true` constraint is what tsc checks. */
function expectType<_T extends true>(): void {}

declare const basic: Client<Basic.paths>;
declare const api: Client<Api.paths>;

export async function paths(): Promise<void> {
	// @ts-expect-error fetch rejects TRACE, so the client has no trace
	basic.trace;
	await basic.get("/users/{id}", { path: { id: 1 } });
	// @ts-expect-error unknown path
	await basic.get("/users");
	// @ts-expect-error method not defined for the path
	await basic.post("/users/{id}", { path: { id: 1 } });
	// @ts-expect-error path parameters are required
	await basic.delete("/users/{id}");
	// @ts-expect-error wrong parameter type
	await basic.get("/users/{id}", { path: { id: "1" } });
	// @ts-expect-error unknown parameter
	await basic.get("/users/{id}", { path: { id: 1, extra: true } });
}

export async function narrowing(): Promise<void> {
	const res = await basic.get("/users/{id}", { path: { id: 1 } });
	if (res.status === 200) {
		expectType<Equal<typeof res.data, Basic.User>>();
		expectType<Equal<typeof res.ok, true>>();
	} else {
		expectType<Equal<typeof res.status, 404>>();
		expectType<Equal<typeof res.data, Basic.Error>>();
		expectType<Equal<typeof res.ok, false>>();
	}
	expectType<Equal<typeof res.response, Response>>();
}

export async function statusRanges(): Promise<void> {
	const res = await api.get("/things/{id}", { path: { id: 1 } });
	if (res.status === 404) {
		// 404 also matches the "2XX" and "4XX" entries (status: number); 200 is excluded.
		expectType<Equal<typeof res.data, string | Api.Problem>>();
	}
	if (res.ok) {
		// 200 and "2XX" are ok: true.
		expectType<Equal<typeof res.data, Api.Thing | string>>();
	} else {
		// 404 and "4XX" are ok: false.
		expectType<Equal<typeof res.data, Api.Problem>>();
	}

	const del = await api.delete("/things/{id}", { path: { id: 1 } });
	// default covers every undocumented status, 2xx included, so its ok is fetch's: boolean.
	if (del.ok) {
		expectType<Equal<typeof del.data, undefined | Api.Problem>>();
	} else {
		expectType<Equal<typeof del.data, Api.Problem>>();
		expectType<Equal<typeof del.status, number>>();
	}
	if (del.status === 204) {
		// default (status: number) also matches 204.
		expectType<Equal<typeof del.data, undefined | Api.Problem>>();
	}

	const head = await api.head("/things/{id}", { path: { id: 1 } });
	expectType<Equal<typeof head.data, undefined>>();
}

export async function optionalInit(): Promise<void> {
	// Nothing required: the second argument can be omitted.
	await api.put("/items");
	await api.put("/items", { body: { name: "x" } });
	await api.put("/items", { body: "plain text", contentType: "text/plain" });
	// @ts-expect-error a non-JSON body needs its contentType
	await api.put("/items", { body: "plain text" });
	// @ts-expect-error the body must match the chosen media type
	await api.put("/items", { body: { name: "x" }, contentType: "text/plain" });
	// @ts-expect-error a media type the operation does not accept
	await api.put("/items", { body: "x", contentType: "text/csv" });
	// @ts-expect-error a required body cannot be omitted
	await api.post("/items");
	// @ts-expect-error a required body cannot be omitted
	await api.post("/items", {});
	await api.post("/items", { body: { name: "x" } });
	// @ts-expect-error wrong body type
	await api.post("/items", { body: { name: 1 } });
}

export async function forms(): Promise<void> {
	const form = new FormData();
	// A FormData or URLSearchParams says its own media type.
	await api.put("/items/{id}/image", { path: { id: "1" }, body: form });
	await api.put("/items/{id}/image", {
		path: { id: "1" },
		body: { file: new Blob([]) },
		contentType: "multipart/form-data",
	});
	// @ts-expect-error an object for a multipart operation needs contentType, or it would be sent as JSON
	await api.put("/items/{id}/image", {
		path: { id: "1" },
		body: { file: new Blob([]) },
	});
	// @ts-expect-error FormData only for multipart operations
	await api.post("/items", { body: form });

	await api.post("/forms", {
		body: { q: "x" },
		contentType: "application/x-www-form-urlencoded",
	});
	await api.post("/forms", { body: new URLSearchParams({ q: "x" }) });
	// @ts-expect-error an object for a URL-encoded operation needs contentType
	await api.post("/forms", { body: { q: "x" } });
}

export async function readWriteViews(): Promise<void> {
	const rw = {} as Client<ReadWrite.paths>;
	// The request body is the write view: password is required, id may not be sent.
	const res = await rw.post("/users", { body: { name: "a", password: "p" } });
	// @ts-expect-error password is required when sending
	await rw.post("/users", { body: { name: "a" } });
	// @ts-expect-error id is readOnly
	await rw.post("/users", { body: { name: "a", password: "p", id: 1 } });
	// The response is the read view: id is there, password is not.
	expectType<Equal<typeof res.data, ReadWrite.User>>();
	expectType<
		Equal<"password" extends keyof ReadWrite.User ? true : false, false>
	>();
}

export async function cookies(): Promise<void> {
	const c = {} as Client<Cookies.paths>;
	await c.get("/me", {
		header: { "x-version": "1" },
		cookie: { session: "s" },
	});
	// @ts-expect-error cookie values follow the schema
	await c.get("/me", { header: { "x-version": "1" }, cookie: { session: 1 } });
}

interface DefaultOnly {
	"/d": {
		get: {
			responses: {
				default: { content: { "application/json": { n: number } } };
			};
		};
	};
}

export async function defaultAlone(): Promise<void> {
	// default alone: ok is boolean, as it is next to a success.
	const res = await createClient<DefaultOnly>({
		baseUrl: "https://api.test",
	}).get("/d");
	expectType<Equal<typeof res.ok, boolean>>();
}

interface ParamPaths {
	"/p": {
		post: {
			requestBody: {
				content: { "application/json; charset=utf-8": { a: number } };
			};
			responses: { 204: Record<never, never> };
		};
	};
}

interface FormParamPaths {
	"/multipart": {
		post: {
			requestBody: {
				content: { "multipart/form-data; charset=utf-8": { a: string } };
			};
			responses: { 204: Record<never, never> };
		};
	};
	"/urlencoded": {
		post: {
			requestBody: {
				content: {
					"application/x-www-form-urlencoded; charset=utf-8": { a: string };
				};
			};
			responses: { 204: Record<never, never> };
		};
	};
}

export async function mediaTypeParameters(): Promise<void> {
	const p = createClient<ParamPaths>({ baseUrl: "https://api.test" });
	// A JSON media type with parameters is still JSON: contentType may be left out.
	await p.post("/p", { body: { a: 1 } });
	// So is a form media type with parameters, for a FormData or URLSearchParams.
	const f = createClient<FormParamPaths>({ baseUrl: "https://api.test" });
	await f.post("/multipart", { body: new FormData() });
	await f.post("/urlencoded", { body: new URLSearchParams() });
	await f.post("/multipart", {
		body: { a: "x" },
		contentType: "multipart/form-data; charset=utf-8",
	});
	// @ts-expect-error an object for a form needs contentType, or it would be sent as JSON
	await f.post("/urlencoded", { body: { a: "x" } });
}

interface AnyBodyPaths {
	"/any": {
		post: {
			requestBody: { content: { "application/json": unknown } };
			responses: { 204: Record<never, never> };
		};
	};
}

export async function requiredBodyOfAnyValue(): Promise<void> {
	const a = createClient<AnyBodyPaths>({ baseUrl: "https://api.test" });
	await a.post("/any", { body: null });
	await a.post("/any", { body: 0 });
	// @ts-expect-error an undefined body is no body, and this one is required
	await a.post("/any", { body: undefined });
	// @ts-expect-error a required body cannot be omitted
	await a.post("/any", {});
}

interface ServerPaths {
	"/assets": {
		post: {
			servers: [
				"https://uploads.example.com",
				"https://uploads-eu.example.com",
			];
			responses: { 204: Record<never, never> };
		};
	};
	"/items": {
		get: { responses: { 204: Record<never, never> } };
		post: { responses: { 204: Record<never, never> } };
	};
}

export async function operationServers(): Promise<void> {
	const s = createClient<ServerPaths>({ baseUrl: "https://api.example.com" });
	// An operation that declares servers is served there, not by the client's baseUrl.
	await s.post("/assets", { baseUrl: "https://uploads.example.com" });
	await s.post("/assets", { baseUrl: "https://uploads-eu.example.com" });
	// @ts-expect-error its server must be given
	await s.post("/assets");
	// @ts-expect-error only a server it declares
	await s.post("/assets", { baseUrl: "https://api.example.com" });
	// Other operations go to the client's baseUrl.
	await s.get("/items");
	// @ts-expect-error an operation without servers takes no baseUrl
	await s.get("/items", { baseUrl: "https://uploads.example.com" });
}

export async function generatedServers(): Promise<void> {
	// The servers the declarations give, as the generator writes them.
	const g = createClient<Servers.paths>({ baseUrl: "https://api.example.com" });
	await g.post("/uploads", { baseUrl: "https://uploads-eu.example.com" });
	await g.put("/uploads", { baseUrl: "https://files.example.com/" });
	// @ts-expect-error the operation's own servers replace its path item's
	await g.put("/uploads", { baseUrl: "https://uploads.example.com" });
	// A URL with variables is any string.
	await g.get("/regional", { baseUrl: "https://eu.example.com" });
	await g.get("/plain");
}

export async function unionAcrossServers(
	path: "/assets" | "/items",
): Promise<void> {
	const s = createClient<ServerPaths>({ baseUrl: "https://api.example.com" });
	// No one init serves both: /assets needs its server, which is wrong for /items.
	// @ts-expect-error
	await s.post(path, { baseUrl: "https://uploads.example.com" });
	// @ts-expect-error
	await s.post(path);
}

interface UnionPaths {
	"/a": {
		get: {
			parameters: { query?: { q?: string } };
			responses: { 200: { content: { "application/json": string } } };
		};
	};
	"/b/{id}": {
		get: {
			parameters: { path: { id: string } };
			responses: { 200: { content: { "application/json": number } } };
		};
	};
}

export async function unionOfPaths(path: "/a" | "/b/{id}"): Promise<void> {
	const u = createClient<UnionPaths>({ baseUrl: "https://api.test" });
	// One init serves whichever path is called, so it holds what every one needs.
	// @ts-expect-error "/b/{id}" needs its path parameter
	await u.get(path);
	// @ts-expect-error "/b/{id}" needs its path parameter
	await u.get(path, {});
	const res = await u.get(path, { path: { id: "1" }, query: { q: "x" } });
	expectType<Equal<typeof res.data, string | number>>();
	// @ts-expect-error unknown keys are still rejected
	await u.get(path, { path: { id: "1" }, other: 1 });
	// A single path needs only its own.
	await u.get("/a");
}

interface PlusJsonPaths {
	"/jsonapi": {
		post: {
			requestBody: {
				content: { "application/vnd.api+json": { data: string } };
			};
			responses: { 204: Record<never, never> };
		};
	};
	"/patch": {
		patch: {
			requestBody: {
				content: {
					"application/json": { full: string };
					"application/merge-patch+json": { partial?: string };
				};
			};
			responses: { 204: Record<never, never> };
		};
	};
}

interface WildcardPaths {
	"/upload": {
		post: {
			requestBody: { content: { "*/*": Blob | string } };
			responses: { 204: Record<never, never> };
		};
	};
}

export async function wildcard(): Promise<void> {
	const w = createClient<WildcardPaths>({ baseUrl: "https://api.test" });
	// A wildcard is named as the operation declares it; no content-type is set for it.
	await w.post("/upload", { body: new Blob([]), contentType: "*/*" });
	// @ts-expect-error the media type is not application/json, so contentType must name it
	await w.post("/upload", { body: "x" });
	// @ts-expect-error the body follows the media type's schema
	await w.post("/upload", { body: 1, contentType: "*/*" });
}

export async function plusJson(): Promise<void> {
	const p = createClient<PlusJsonPaths>({ baseUrl: "https://api.test" });
	// Left out, contentType is application/json; another JSON media type must be named.
	await p.post("/jsonapi", {
		body: { data: "x" },
		contentType: "application/vnd.api+json",
	});
	// @ts-expect-error it would be sent as application/json, which the operation does not take
	await p.post("/jsonapi", { body: { data: "x" } });
	await p.patch("/patch", { body: { full: "f" } });
	await p.patch("/patch", {
		body: { partial: "p" },
		contentType: "application/merge-patch+json",
	});
	// @ts-expect-error without contentType the body is application/json's
	await p.patch("/patch", { body: { partial: "p" } });
}

export async function binary(): Promise<void> {
	await api.put("/files/{name}", {
		path: { name: "a" },
		body: new Blob([]),
		contentType: "application/octet-stream",
	});
	// Every raw body the client sends as it is.
	await api.put("/files/{name}", {
		path: { name: "a" },
		body: new Uint8Array([1]),
		contentType: "application/octet-stream",
	});
	await api.put("/files/{name}", {
		path: { name: "a" },
		body: new ArrayBuffer(1),
		contentType: "application/octet-stream",
	});
	await api.put("/files/{name}", {
		path: { name: "a" },
		body: new ReadableStream<Uint8Array>(),
		contentType: "application/octet-stream",
	});
	await api.put("/files/{name}", {
		path: { name: "a" },
		// @ts-expect-error binary bodies are Blobs
		body: "text",
		contentType: "application/octet-stream",
	});
	const res = await api.get("/files/{name}", { path: { name: "a" } });
	expectType<Equal<typeof res.data, Blob>>();
}

export async function parseAs(): Promise<void> {
	const auto = await api.get("/events");
	expectType<Equal<typeof auto.data, string>>();
	const stream = await api.get("/events", { parseAs: "stream" });
	expectType<Equal<typeof stream.data, ReadableStream<Uint8Array> | null>>();
	const text = await api.get("/things/{id}", {
		path: { id: 1 },
		parseAs: "text",
	});
	expectType<Equal<typeof text.data, string>>();
	const buffer = await api.get("/files/{name}", {
		path: { name: "a" },
		parseAs: "arrayBuffer",
	});
	expectType<Equal<typeof buffer.data, ArrayBuffer>>();
	const blob = await api.get("/events", { parseAs: "blob" });
	expectType<Equal<typeof blob.data, Blob>>();
	const json = await api.post("/items", {
		body: { name: "x" },
		parseAs: "json",
	});
	expectType<Equal<typeof json.data, Api.Item>>();
	// @ts-expect-error unknown parseAs
	await api.get("/events", { parseAs: "xml" });
}

interface JsonParsePaths {
	"/mixed": {
		get: {
			responses: {
				200: {
					content: {
						"application/json": { a: number };
						"application/vnd.x+json; v=1": { b: number };
						"text/plain": string;
					};
				};
				201: { content: { "application/octet-stream": Blob } };
				202: { content: { "*/*": { c: number } } };
				203: { content: { "application/*": { d: number } } };
				204: Record<never, never>;
			};
		};
	};
}

export async function parseAsJson(): Promise<void> {
	const j = createClient<JsonParsePaths>({ baseUrl: "https://api.test" });
	// JSON is parsed whatever the content-type says: JSON and wildcard media types keep
	// their schema; text, binary and form ones are unknown; no content is undefined.
	const res = await j.get("/mixed", { parseAs: "json" });
	if (res.status === 200) expectType<Equal<typeof res.data, unknown>>();
	if (res.status === 201) expectType<Equal<typeof res.data, unknown>>();
	if (res.status === 202) expectType<Equal<typeof res.data, { c: number }>>();
	if (res.status === 203) expectType<Equal<typeof res.data, { d: number }>>();
	if (res.status === 204) expectType<Equal<typeof res.data, undefined>>();
	const thing = await api.get("/things/{id}", {
		path: { id: 1 },
		parseAs: "json",
	});
	if (thing.status === 404)
		// 404 also matches "2XX" (text/plain, so unknown) and "4XX" (problem+json).
		expectType<Equal<typeof thing.data, unknown>>();
}

interface JsonOnlyPaths {
	"/j": {
		get: {
			responses: {
				200: {
					content: {
						"application/json": { a: number };
						"application/vnd.x+json; v=1": { b: number };
					};
				};
			};
		};
	};
}

export async function parseAsJsonKeepsJsonSchemas(): Promise<void> {
	const j = createClient<JsonOnlyPaths>({ baseUrl: "https://api.test" });
	const res = await j.get("/j", { parseAs: "json" });
	expectType<Equal<typeof res.data, { a: number } | { b: number }>>();
}

interface NoBodyPaths {
	"/n": {
		head: {
			responses: { 200: { content: { "application/json": { a: number } } } };
		};
		delete: {
			responses: {
				204: { content: { "application/json": { a: number } } };
				205: { content: { "application/json": { a: number } } };
				304: { content: { "application/json": { a: number } } };
			};
		};
		get: {
			responses: { 200: { content: { "application/json": { a: number } } } };
		};
	};
}

export async function noBody(): Promise<void> {
	const n = createClient<NoBodyPaths>({ baseUrl: "https://api.test" });
	// fetch gives HEAD and 204, 205, 304 responses no body, whatever the document declares.
	const head = await n.head("/n");
	expectType<Equal<typeof head.data, undefined>>();
	const del = await n.delete("/n");
	expectType<Equal<typeof del.data, undefined>>();
	// parseAs reads that empty body as it says.
	const text = await n.head("/n", { parseAs: "text" });
	expectType<Equal<typeof text.data, string>>();
	const json = await n.delete("/n", { parseAs: "json" });
	expectType<Equal<typeof json.data, undefined>>();
	const stream = await n.head("/n", { parseAs: "stream" });
	expectType<Equal<typeof stream.data, ReadableStream<Uint8Array> | null>>();
	// The same content on a GET 200 is read.
	const get = await n.get("/n");
	expectType<Equal<typeof get.data, { a: number }>>();
}

export async function noResponses(): Promise<void> {
	const none = createClient<NoResponses.paths>({ baseUrl: "https://api.test" });
	// Nothing documented: whatever comes back, typed as fetch gives it.
	const res = await none.get("/a");
	expectType<Equal<typeof res.status, number>>();
	expectType<Equal<typeof res.ok, boolean>>();
	expectType<Equal<typeof res.data, unknown>>();
	expectType<Equal<typeof res.response, Response>>();
	const text = await none.get("/a", { parseAs: "text" });
	expectType<Equal<typeof text.data, string>>();
}

export function config(): void {
	createClient<Api.paths>({
		baseUrl: "https://api.test",
		arrayFormat: "pipe",
		fetch: (input, init) => {
			const request = new Request(input, init);
			request.headers.set("authorization", "Bearer t");
			return fetch(request);
		},
		onData: (data, call) => {
			expectType<Equal<typeof data, unknown>>();
			expectType<Equal<typeof call.method, Method>>();
			expectType<Equal<typeof call.path, string>>();
			expectType<Equal<typeof call.status, number>>();
			expectType<Equal<typeof call.parseAs, ParseAs | undefined>>();
			return data;
		},
	});
}

export async function fetchOptions(): Promise<void> {
	createClient<Api.paths>({
		baseUrl: "https://api.test",
		credentials: "include",
		cache: "no-store",
	});
	await api.get("/events", { credentials: "omit", keepalive: true });
	// @ts-expect-error the client sets the method
	await api.get("/events", { method: "POST" });
	// @ts-expect-error not a credentials mode
	await api.get("/events", { credentials: "always" });
}

export async function perCallArrayFormat(): Promise<void> {
	await api.get("/orgs/{org}/items", {
		path: { org: "o" },
		query: { limit: 1, tags: ["a", "b"] },
		header: { "x-version": "1" },
		arrayFormat: "comma",
	});
}

export async function parameters(): Promise<void> {
	// query is required because `limit` is; header because `x-version` is.
	const res = await api.get("/orgs/{org}/items", {
		path: { org: "o" },
		query: { limit: 10, tags: ["a"], filter: { q: "x" } },
		header: { "x-version": "1" },
	});
	if (res.status === 200) expectType<Equal<typeof res.data, Api.Item[]>>();
	await api.get("/orgs/{org}/items", {
		path: { org: "o" },
		// @ts-expect-error query.limit is required
		query: {},
		header: { "x-version": "1" },
	});
	await api.get("/orgs/{org}/items", {
		path: { org: "o" },
		query: { limit: 1 },
		// @ts-expect-error header x-version must be "1" | "2"
		header: { "x-version": "3" },
	});
	// Optional query and header can be left out; path stays required.
	await api.post("/orgs/{org}/items", { path: { org: "o" } });
	// @ts-expect-error path is required
	await api.post("/orgs/{org}/items");
	await api.post("/orgs/{org}/items", {
		path: { org: "o" },
		query: { "dry-run": true },
		header: { "x-trace": "t" },
		headers: { authorization: "Bearer t" },
		signal: AbortSignal.timeout(1000),
	});
}

export function requiredOfAnyValue(
	o: Composition.O,
	p: Composition.P,
	ext: RefSiblings.Ext,
	derived: Derived.DerivedInput,
): void {
	// A key another member requires reads as the type its property schema gives.
	expectType<Equal<typeof o.a, string>>();
	expectType<Equal<typeof p.a, string>>();
	expectType<Equal<typeof ext.id, string>>();
	expectType<Equal<typeof derived.name, string>>();
	// @ts-expect-error a is required
	const missing: Composition.O = {};
	// @ts-expect-error a must be a string
	const wrong: Composition.O = { a: 1 };
	// One of the anyOf members must hold.
	const phone: AnyOf.Contact = { phone: "1" };
	// @ts-expect-error neither email nor phone
	const neither: AnyOf.Contact = {};
	// Without a property schema, or with one that admits anything, the key admits any
	// value but must be present.
	const any: Missing.User = { id: 1, missing: null, anything: [1] };
	// @ts-expect-error missing is required
	const absent: Missing.User = { id: 1, anything: 1 };
	// @ts-expect-error a required key cannot be undefined, which JSON cannot carry
	const undef: Missing.User = { id: 1, missing: 1, anything: undefined };
	void [missing, wrong, phone, neither, any, absent, undef];
}

export function requiredRefOfAnyValue(
	narrowed: AnyRef.Narrowed,
	box: AnyRef.Box,
): void {
	// A $ref to a schema of any value is any value too: any JSON value, not undefined.
	type AnyJson = NonNullable<unknown> | null;
	expectType<Equal<typeof narrowed.a, string>>();
	expectType<Equal<typeof box.a, AnyJson>>();
	expectType<Equal<typeof box.b, AnyJson>>();
	expectType<Equal<typeof box.n, AnyJson>>();
	expectType<Equal<typeof box.both, AnyJson>>();
	const ok: AnyRef.Box = { a: 1, b: [], c: "c", n: null, both: "x" };
	// @ts-expect-error a required key cannot be undefined
	const undef: AnyRef.Box = { a: undefined, b: 1, c: "c", n: null, both: 1 };
	void ok;
	void undef;
}
