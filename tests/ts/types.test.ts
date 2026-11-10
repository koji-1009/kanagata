// Type tests for client.ts, checked by `tsc -p tests/ts`. Nothing here runs.
// The schemas are the hand-written expectations in tests/spec/basic and tests/spec/client.

import {
	type Client,
	createClient,
	type Method,
	type ParseAs,
} from "../../src/client.ts";
import type * as Basic from "../spec/basic/expected";
import type * as Api from "../spec/client/expected";
import type * as Cookies from "../spec/params-header-cookie/expected";
import type * as ReadWrite from "../spec/read-write-only/expected";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
/** The type argument is the assertion: its `extends true` constraint is what tsc checks. */
function expectType<_T extends true>(): void {}

declare const basic: Client<Basic.paths>;
declare const api: Client<Api.paths>;

export async function paths(): Promise<void> {
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

export async function mediaTypeParameters(): Promise<void> {
	const p = createClient<ParamPaths>({ baseUrl: "https://api.test" });
	// A JSON media type with parameters is still JSON: contentType may be left out.
	await p.post("/p", { body: { a: 1 } });
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
