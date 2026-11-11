// Runtime tests for client.ts. The fetch is replaced so each test can inspect the
// Request the client built. Type-checked by the root tsconfig.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type ClientConfig,
	createClient,
	type DataCall,
	type Method,
	type ParseAs,
	PathParameterError,
	type RequestOptions,
	ResponseBodyError,
} from "../../src/client.ts";

interface Recorder {
	requests: Request[];
	/** The i-th request sent; fails the test if there was none. */
	request(i: number): Request;
	fetch: NonNullable<ClientConfig["fetch"]>;
}

function recorder(
	respond: (req: Request) => Response = () =>
		new Response(null, { status: 204 }),
): Recorder {
	const requests: Request[] = [];
	return {
		requests,
		request: (i) => {
			const req = requests[i];
			assert.ok(req, `request ${i} was not sent`);
			return req;
		},
		fetch: async (req) => {
			requests.push(req);
			return respond(req);
		},
	};
}

// The runtime does not depend on the schema type, so these tests call it through the
// untyped shape it has at runtime: any path, any init. Types are tested in types.test.ts.
interface LooseInit extends RequestOptions {
	baseUrl?: string;
	path?: Record<string, unknown>;
	query?: Record<string, unknown>;
	querystring?: unknown;
	header?: Record<string, unknown>;
	cookie?: Record<string, unknown>;
	body?: unknown;
	contentType?: string;
	parseAs?: ParseAs;
}
interface LooseResult {
	status: number;
	ok: boolean;
	data: unknown;
	response: Response;
}
type LooseClient = Record<
	Exclude<Method, "trace">,
	(path: string, init?: LooseInit) => Promise<LooseResult>
> & {
	request: (
		method: string,
		path: string,
		init?: LooseInit,
	) => Promise<LooseResult>;
};

function loose(config: ClientConfig): LooseClient {
	return createClient<unknown>(config) as unknown as LooseClient;
}

function client(rec: Recorder, extra: Partial<ClientConfig> = {}): LooseClient {
	return loose({ baseUrl: "https://api.test/v1/", fetch: rec.fetch, ...extra });
}

test("the client has a function per method fetch sends, which leaves out TRACE, and request for the others", async () => {
	const rec = recorder();
	const api = client(rec);
	const fixed = [
		"get",
		"put",
		"post",
		"delete",
		"options",
		"head",
		"patch",
		"query",
	] as const;
	assert.deepEqual(Object.keys(api), [...fixed, "request"]);
	for (const method of fixed) await api[method]("/m");
	assert.deepEqual(
		rec.requests.map((r) => r.method),
		["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "QUERY"],
	);
	assert.throws(() => new Request("https://api.test", { method: "TRACE" }));
});

test("request sends a method of additionalOperations as written, with its options", async () => {
	const rec = recorder();
	await client(rec).request("COPY", "/files/{name}", {
		path: { name: "a b" },
		header: { destination: "/b" },
		body: "x",
		contentType: "text/plain",
	});
	const req = rec.request(0);
	assert.equal(req.method, "COPY");
	assert.equal(req.url, "https://api.test/v1/files/a%20b");
	assert.equal(req.headers.get("destination"), "/b");
	assert.equal(await req.text(), "x");
	// fetch normalizes only the methods it knows; another is sent in its own case.
	const calls: string[] = [];
	await client(rec, {
		onData: (data, call) => {
			calls.push(call.method);
			return data;
		},
	}).request("Purge", "/m");
	assert.equal(rec.request(1).method, "Purge");
	assert.deepEqual(calls, ["Purge"]);
});

test("a QUERY request has a body", async () => {
	const rec = recorder();
	await client(rec).query("/search", { body: { q: "x" } });
	assert.equal(rec.request(0).method, "QUERY");
	assert.equal(await rec.request(0).text(), '{"q":"x"}');
});

test("querystring is the whole query: an object URL-encoded as a query, a string percent-encoded as one value", async () => {
	const rec = recorder();
	const api = client(rec);
	// OpenAPI 3.2's examples: a form, JSON text, a JSONPath.
	await api.get("/foo", { querystring: { foo: "a + b", bar: true } });
	await api.get("/foo", {
		querystring: JSON.stringify({ numbers: [1, 2], flag: null }),
	});
	await api.get("/foo", { querystring: "$.a.b[1:1]" });
	await api.get("/foo", {
		querystring: { ids: [1, 2] },
		arrayFormat: "comma",
	});
	await api.get("/foo", { querystring: undefined });
	await api.get("/foo", { querystring: "" });
	assert.deepEqual(
		rec.requests.map((r) => new URL(r.url).search),
		[
			"?foo=a%20%2B%20b&bar=true",
			"?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D",
			"?%24.a.b%5B1%3A1%5D",
			"?ids=1,2",
			"",
			"",
		],
	);
	// After the base URL's own query.
	await loose({
		baseUrl: "https://api.test/v1?key=k",
		fetch: rec.fetch,
	}).get("/foo", { querystring: "s" });
	assert.equal(rec.request(6).url, "https://api.test/v1/foo?key=k&s");
});

test("path parameters are substituted and encoded", async () => {
	const rec = recorder();
	await client(rec).get("/files/{name}/parts/{n}", {
		path: { name: "a/b c", n: 2 },
	});
	assert.equal(
		rec.request(0).url,
		"https://api.test/v1/files/a%2Fb%20c/parts/2",
	);
	assert.equal(rec.request(0).method, "GET");
});

test("path parameter arrays and objects use the simple style", async () => {
	const rec = recorder();
	await client(rec).get("/a/{ids}/b/{point}", {
		path: { ids: [1, "x y"], point: { x: 1, y: 2 } },
	});
	assert.equal(new URL(rec.request(0).url).pathname, "/v1/a/1,x%20y/b/x,1,y,2");
});

test("a missing path parameter throws PathParameterError, a TypeError", async () => {
	const rec = recorder();
	for (const init of [{ path: {} }, { path: { name: null } }, undefined]) {
		await assert.rejects(client(rec).get("/files/{name}", init), (e) => {
			assert.ok(e instanceof PathParameterError);
			assert.ok(e instanceof TypeError);
			assert.equal(e.name, "PathParameterError");
			assert.equal(e.message, "missing path parameter: name");
			assert.equal(e.parameter, "name");
			assert.equal(e.value, init?.path.name);
			return true;
		});
	}
	assert.equal(rec.requests.length, 0);
});

test("a path parameter that would change the path throws PathParameterError, a TypeError", async () => {
	const rec = recorder();
	// The URL parser resolves `.` and `..` segments (encoded or not), and `""` empties one.
	for (const name of [".", "..", "", []]) {
		await assert.rejects(
			client(rec).get("/files/{name}/meta", { path: { name } }),
			(e) => {
				assert.ok(e instanceof PathParameterError);
				assert.ok(e instanceof TypeError);
				assert.equal(e.name, "PathParameterError");
				assert.equal(
					e.message,
					`path parameter name would change the path: ${JSON.stringify(name)}`,
				);
				assert.equal(e.parameter, "name");
				assert.equal(e.value, name);
				return true;
			},
		);
	}
	assert.equal(rec.requests.length, 0);
	// Dots inside a segment are fine.
	await client(rec).get("/files/{name}/meta", { path: { name: "a..b" } });
	assert.equal(rec.request(0).url, "https://api.test/v1/files/a..b/meta");
});

test("query skips undefined and null, repeats arrays by default", async () => {
	const rec = recorder();
	await client(rec).get("/q", {
		query: { a: 1, b: undefined, c: null, ids: [1, 2], s: "x y" },
	});
	assert.equal(new URL(rec.request(0).url).search, "?a=1&ids=1&ids=2&s=x%20y");
});

test("a Date is its ISO string in path, header and cookie parameters and multipart fields", async () => {
	const rec = recorder();
	const when = new Date("2026-11-10T00:00:00Z");
	await client(rec).post("/d/{when}", {
		path: { when },
		header: { "x-when": when },
		cookie: { when },
		body: { when },
		contentType: "multipart/form-data",
	});
	const req = rec.request(0);
	assert.equal(new URL(req.url).pathname, "/v1/d/2026-11-10T00%3A00%3A00.000Z");
	assert.equal(req.headers.get("x-when"), "2026-11-10T00:00:00.000Z");
	assert.equal(req.headers.get("cookie"), "when=2026-11-10T00%3A00%3A00.000Z");
	assert.equal((await req.formData()).get("when"), "2026-11-10T00:00:00.000Z");
});

test("query arrays in brackets format", async () => {
	const rec = recorder();
	await client(rec, { arrayFormat: "brackets" }).get("/q", {
		query: { ids: [1, 2] },
	});
	assert.equal(new URL(rec.request(0).url).search, "?ids%5B%5D=1&ids%5B%5D=2");
});

test("nested objects use deepObject, its brackets percent-encoded, and dates use ISO strings", async () => {
	const rec = recorder();
	const when = new Date("2026-11-09T00:00:00Z");
	await client(rec).get("/q", {
		query: { filter: { name: "n", tag: ["a", "b"], skip: null }, since: when },
	});
	assert.equal(
		new URL(rec.request(0).url).search,
		// OpenAPI requires [ and ] percent-encoded (3.1.1, Appendix E).
		"?filter%5Bname%5D=n&filter%5Btag%5D=a&filter%5Btag%5D=b&since=2026-11-09T00%3A00%3A00.000Z",
	);
});

test("query arrays joined by comma, space or pipe; per-call arrayFormat wins", async () => {
	const rec = recorder();
	const query = {
		ids: [1, "a b", null, 3],
		when: [new Date("2026-11-10T00:00:00Z")],
		none: [],
	};
	await client(rec, { arrayFormat: "comma" }).get("/q", { query });
	await client(rec, { arrayFormat: "space" }).get("/q", { query });
	await client(rec, { arrayFormat: "pipe" }).get("/q", { query });
	await client(rec, { arrayFormat: "pipe" }).get("/q", {
		query: { ids: [1, 2] },
		arrayFormat: "repeat",
	});
	const search = rec.requests.map((r) => new URL(r.url).search);
	assert.deepEqual(search, [
		"?ids=1,a%20b,3&when=2026-11-10T00%3A00%3A00.000Z",
		"?ids=1%20a%20b%203&when=2026-11-10T00%3A00%3A00.000Z",
		// | is percent-encoded too, as OpenAPI's pipeDelimited example has it.
		"?ids=1%7Ca%20b%7C3&when=2026-11-10T00%3A00%3A00.000Z",
		"?ids=1&ids=2",
	]);
});

test("no query string when nothing is set", async () => {
	const rec = recorder();
	await client(rec).get("/q", { query: { a: undefined } });
	assert.equal(rec.request(0).url, "https://api.test/v1/q");
});

test("headers layer config, header parameters, then per-call headers", async () => {
	const rec = recorder();
	const api = client(rec, {
		headers: { a: "config", b: "config", c: "config" },
	});
	await api.get("/h", {
		header: { b: "param", c: "param", d: 1, e: undefined },
		headers: { c: "call" },
	});
	const h = rec.request(0).headers;
	assert.equal(h.get("a"), "config");
	assert.equal(h.get("b"), "param");
	assert.equal(h.get("c"), "call");
	assert.equal(h.get("d"), "1");
	assert.equal(h.has("e"), false);
});

test("header parameters use the simple style for arrays and objects", async () => {
	const rec = recorder();
	await client(rec).get("/h", {
		header: { "x-ids": [1, 2], "x-point": { x: 1, y: 2 } },
	});
	assert.equal(rec.request(0).headers.get("x-ids"), "1,2");
	assert.equal(rec.request(0).headers.get("x-point"), "x,1,y,2");
});

test("undefined and null are left out of arrays and objects in the simple style, as in queries", async () => {
	const rec = recorder();
	await client(rec).get("/h/{ids}", {
		path: { ids: [1, null, 2] },
		header: {
			"x-ids": [1, null, undefined, "b"],
			"x-o": { a: 1, b: null },
			"x-empty": [],
		},
	});
	assert.equal(rec.request(0).url, "https://api.test/v1/h/1,2");
	assert.equal(rec.request(0).headers.get("x-ids"), "1,b");
	assert.equal(rec.request(0).headers.get("x-o"), "a,1");
	// An empty array is left out, as in queries.
	assert.equal(rec.request(0).headers.has("x-empty"), false);
});

test("a form body that is not an object throws TypeError", async () => {
	const rec = recorder();
	for (const contentType of [
		"multipart/form-data",
		"multipart/mixed",
		"application/x-www-form-urlencoded",
	]) {
		await assert.rejects(client(rec).post("/f", { body: null, contentType }), {
			name: "TypeError",
			message: `a ${contentType} body must be an object: null`,
		});
	}
	assert.equal(rec.requests.length, 0);
});

test("objects and arrays inside query arrays are JSON in every arrayFormat", async () => {
	const rec = recorder();
	const query = { f: [{ a: 1 }, [2, 3], 4] };
	await client(rec, { arrayFormat: "comma" }).get("/q", { query });
	await client(rec).get("/q", { query });
	await client(rec, { arrayFormat: "brackets" }).get("/q", { query });
	assert.deepEqual(
		rec.requests.map((r) => new URL(r.url).search),
		[
			"?f=%7B%22a%22%3A1%7D,%5B2%2C3%5D,4",
			"?f=%7B%22a%22%3A1%7D&f=%5B2%2C3%5D&f=4",
			"?f%5B%5D=%7B%22a%22%3A1%7D&f%5B%5D=%5B2%2C3%5D&f%5B%5D=4",
		],
	);
	// So in URL-encoded bodies, which are serialized the same way.
	await client(rec).post("/f", {
		body: { items: [{ price: "p1" }, { price: "p2" }] },
		contentType: "application/x-www-form-urlencoded",
	});
	assert.equal(
		await rec.request(3).text(),
		"items=%7B%22price%22%3A%22p1%22%7D&items=%7B%22price%22%3A%22p2%22%7D",
	);
	// A Blob is not text in any array.
	await assert.rejects(
		client(rec, { arrayFormat: "comma" }).get("/q", {
			query: { f: [new Blob(["x"])] },
		}),
		{ name: "TypeError", message: "a Blob cannot be URL-encoded: f" },
	);
	assert.equal(rec.requests.length, 4);
});

test("a baseUrl with a query keeps it, and the path goes before it", async () => {
	const rec = recorder();
	await loose({ baseUrl: "https://api.test/v1/?key=k", fetch: rec.fetch }).get(
		"/x/{id}",
		{
			path: { id: 1 },
			query: { q: 1 },
		},
	);
	assert.equal(rec.request(0).url, "https://api.test/v1/x/1?key=k&q=1");
	await loose({ baseUrl: "https://api.test/?key=k", fetch: rec.fetch }).get(
		"/x",
	);
	assert.equal(rec.request(1).url, "https://api.test/x?key=k");
});

test("a call's baseUrl (an operation's own server) replaces the client's", async () => {
	const rec = recorder();
	await client(rec).post("/repos/{id}/assets", {
		baseUrl: "https://uploads.test/?key=k",
		path: { id: 1 },
		query: { name: "a.zip" },
	});
	await client(rec).get("/r");
	assert.equal(
		rec.request(0).url,
		"https://uploads.test/repos/1/assets?key=k&name=a.zip",
	);
	assert.equal(rec.request(1).url, "https://api.test/v1/r");
});

test("a relative baseUrl resolves against the page on every call, as fetch does", async () => {
	const rec = recorder();
	const page = globalThis as { document?: unknown; location?: unknown };
	const api = loose({ baseUrl: "/api/?key=k", fetch: rec.fetch });
	await assert.rejects(api.get("/x"), {
		name: "TypeError",
		message:
			'baseUrl "/api/?key=k" is not a URL (a relative one needs a page to resolve against)',
	});
	// A forgotten scheme parses as the scheme `localhost:`, which has no origin.
	await assert.rejects(
		loose({ baseUrl: "localhost:3000/api", fetch: rec.fetch }).get("/x"),
		{
			name: "TypeError",
			message:
				'baseUrl "localhost:3000/api" has no origin: write its scheme (https://…)',
		},
	);
	try {
		page.location = { href: "https://app.test/a/b" };
		await assert.rejects(
			loose({ baseUrl: "https://[", fetch: rec.fetch }).get("/x"),
			{ name: "TypeError", message: 'baseUrl "https://[" is not a URL' },
		);
		await api.get("/x/{id}", { path: { id: 1 }, query: { q: 1 } });
		assert.equal(rec.request(0).url, "https://app.test/api/x/1?key=k&q=1");
		page.location = { href: "https://other.test/" };
		await loose({ baseUrl: "v2", fetch: rec.fetch }).get("/x");
		assert.equal(rec.request(1).url, "https://other.test/v2/x");
		// The document's base URL (a <base> element) is what fetch resolves against.
		page.document = { baseURI: "https://base.test/app/" };
		await loose({ baseUrl: "v2", fetch: rec.fetch }).get("/x");
		assert.equal(rec.request(2).url, "https://base.test/app/v2/x");
		// "" is the page's origin, as in fetch("" + path); not the page itself.
		page.document = { baseURI: "https://app.test/a/b/page?tab=1" };
		await loose({ baseUrl: "", fetch: rec.fetch }).get("/users");
		assert.equal(rec.request(3).url, "https://app.test/users");
	} finally {
		delete page.location;
		delete page.document;
	}
});

test("config.headers as a function is evaluated on every call", async () => {
	const rec = recorder();
	let n = 0;
	const api = client(rec, { headers: async () => ({ "x-n": String(++n) }) });
	await api.get("/h");
	await api.get("/h");
	assert.deepEqual(
		rec.requests.map((r) => r.headers.get("x-n")),
		["1", "2"],
	);
});

test("JSON bodies get content-type application/json", async () => {
	const rec = recorder();
	await client(rec).post("/b", { body: { a: 1 } });
	const req = rec.request(0);
	assert.equal(req.method, "POST");
	assert.equal(req.headers.get("content-type"), "application/json");
	assert.equal(await req.text(), '{"a":1}');
});

test("a wildcard contentType (*/*, application/*) is not a content-type: the body decides, a value goes as JSON", async () => {
	const rec = recorder();
	await client(rec).post("/a", { body: { a: 1 }, contentType: "*/*" });
	assert.equal(rec.request(0).headers.get("content-type"), "application/json");
	assert.equal(await rec.request(0).text(), '{"a":1}');
	await client(rec).post("/a", {
		body: new Blob(["x"], { type: "image/png" }),
		contentType: "application/*",
	});
	assert.equal(rec.request(1).headers.get("content-type"), "image/png");
	// A string is sent as it is, as for any media type that is not JSON.
	await client(rec).post("/a", { body: "hello", contentType: "*/*" });
	assert.equal(await rec.request(2).text(), "hello");
	assert.equal(
		rec.request(2).headers.get("content-type"),
		"text/plain;charset=UTF-8",
	);
});

test("contentType: an object body is URL-encoded", async () => {
	const rec = recorder();
	const when = new Date("2026-11-10T00:00:00Z");
	await client(rec).post("/f", {
		body: {
			q: "a b",
			n: 1,
			tags: ["x", "y"],
			when,
			meta: { k: 1 },
			skip: undefined,
			none: null,
		},
		contentType: "application/x-www-form-urlencoded",
	});
	const req = rec.request(0);
	assert.equal(
		req.headers.get("content-type"),
		"application/x-www-form-urlencoded",
	);
	assert.equal(
		await req.text(),
		"q=a%20b&n=1&tags=x&tags=y&when=2026-11-10T00%3A00%3A00.000Z&meta%5Bk%5D=1",
	);
	await assert.rejects(
		client(rec).post("/f", {
			body: { file: new Blob(["x"]) },
			contentType: "application/x-www-form-urlencoded",
		}),
		TypeError,
	);
	assert.equal(rec.requests.length, 1);
});

test("URL-encoded bodies follow arrayFormat and objectFormat, like queries", async () => {
	const rec = recorder();
	const body = {
		address: { city: "Tokyo", lines: ["1", "2"] },
		expand: ["a", "b"],
	};
	const contentType = "application/x-www-form-urlencoded";
	await client(rec).post("/f", { body, contentType });
	await client(rec, { arrayFormat: "brackets" }).post("/f", {
		body,
		contentType,
	});
	await client(rec, { objectFormat: "json" }).post("/f", { body, contentType });
	await client(rec, { objectFormat: "json" }).post("/f", {
		body,
		contentType,
		objectFormat: "deepObject",
	});
	assert.deepEqual(await Promise.all(rec.requests.map((r) => r.text())), [
		"address%5Bcity%5D=Tokyo&address%5Blines%5D=1&address%5Blines%5D=2&expand=a&expand=b",
		"address%5Bcity%5D=Tokyo&address%5Blines%5D%5B%5D=1&address%5Blines%5D%5B%5D=2&expand%5B%5D=a&expand%5B%5D=b",
		"address=%7B%22city%22%3A%22Tokyo%22%2C%22lines%22%3A%5B%221%22%2C%222%22%5D%7D&expand=a&expand=b",
		"address%5Bcity%5D=Tokyo&address%5Blines%5D=1&address%5Blines%5D=2&expand=a&expand=b",
	]);
});

test("objectFormat json sends query objects as JSON too", async () => {
	const rec = recorder();
	await client(rec, { objectFormat: "json" }).get("/q", {
		query: { filter: { q: "x" } },
	});
	assert.equal(
		new URL(rec.request(0).url).search,
		"?filter=%7B%22q%22%3A%22x%22%7D",
	);
});

test("contentType: an object body becomes FormData for multipart", async () => {
	const rec = recorder();
	await client(rec).post("/f", {
		body: {
			caption: "hi",
			file: new Blob(["img"], { type: "image/png" }),
			tags: ["a", "b"],
			meta: { k: 1 },
			skip: null,
		},
		contentType: "multipart/form-data",
		headers: { "content-type": "multipart/form-data" }, // dropped too: fetch adds the boundary
	});
	const req = rec.request(0);
	assert.match(
		req.headers.get("content-type") ?? "",
		/^multipart\/form-data; boundary=/,
	);
	const form = await req.formData();
	assert.equal(form.get("caption"), "hi");
	const file = form.get("file");
	assert.ok(file instanceof Blob);
	assert.equal(await file.text(), "img");
	assert.deepEqual(form.getAll("tags"), ["a", "b"]);
	assert.equal(form.get("meta"), '{"k":1}');
	assert.equal(form.has("skip"), false);

	await client(rec).post("/f", {
		body: { caption: "p" },
		contentType: "Multipart/Form-Data; charset=utf-8",
	});
	assert.equal(
		(await rec.request(1).formData()).get("caption"),
		"p",
		"parameters and case do not matter",
	);
	rec.requests.pop();

	const own = new FormData();
	own.set("caption", "mine");
	await client(rec).post("/f", {
		body: own,
		contentType: "multipart/form-data",
	});
	assert.match(
		rec.request(1).headers.get("content-type") ?? "",
		/^multipart\/form-data; boundary=/,
	);
	assert.equal((await rec.request(1).formData()).get("caption"), "mine");
});

test("contentType: an object body for another multipart type is sent as its named parts", async () => {
	const rec = recorder();
	await client(rec).post("/f", {
		body: {
			id: "1",
			file: new Blob(["img"], { type: "image/png" }),
			meta: { k: 1 },
		},
		contentType: "multipart/mixed",
		headers: { "content-type": "multipart/mixed" }, // dropped: the boundary is needed
	});
	const req = rec.request(0);
	const type = req.headers.get("content-type") ?? "";
	const boundary = /^multipart\/mixed; boundary=(.+)$/.exec(type)?.[1];
	assert.ok(boundary, type);
	// The parts are those of multipart/form-data: named, by the same field rules.
	const parts = await new Response(await req.blob(), {
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
	}).formData();
	assert.equal(parts.get("id"), "1");
	const file = parts.get("file");
	assert.ok(file instanceof Blob);
	assert.equal(await file.text(), "img");
	assert.equal(parts.get("meta"), '{"k":1}');
});

test("a raw body is sent as it is for form media types too", async () => {
	const rec = recorder();
	const api = client(rec);
	for (const type of ["multipart/form-data", "multipart/related"]) {
		await api.post("/f", {
			body: new Blob(["--b\r\n...--b--"]),
			contentType: type,
			headers: { "content-type": `${type}; boundary=b` },
		});
	}
	await api.post("/f", {
		body: "a=1&b=2",
		contentType: "application/x-www-form-urlencoded",
	});
	await api.post("/f", {
		body: new URLSearchParams({ a: "1" }),
		contentType: "application/x-www-form-urlencoded",
	});
	for (const [i, type] of [
		"multipart/form-data",
		"multipart/related",
	].entries()) {
		assert.equal(await rec.request(i).text(), "--b\r\n...--b--", type);
		assert.equal(
			rec.request(i).headers.get("content-type"),
			`${type}; boundary=b`,
		);
	}
	assert.equal(await rec.request(2).text(), "a=1&b=2");
	assert.equal(
		rec.request(2).headers.get("content-type"),
		"application/x-www-form-urlencoded",
	);
	assert.equal(await rec.request(3).text(), "a=1");
});

test("contentType: JSON media types are stringified, others sent as is", async () => {
	const rec = recorder();
	const api = client(rec);
	await api.post("/b", {
		body: { a: 1 },
		contentType: "application/merge-patch+json",
	});
	await api.post("/b", { body: "hello", contentType: "text/plain" });
	await api.post("/b", {
		body: new Blob(["bin"]),
		contentType: "application/octet-stream",
	});
	await api.post("/b", {
		body: { a: 1 },
		contentType: "application/json",
		headers: { "content-type": "application/json; charset=utf-8" },
	});
	assert.equal(
		rec.request(0).headers.get("content-type"),
		"application/merge-patch+json",
	);
	assert.equal(await rec.request(0).text(), '{"a":1}');
	assert.equal(rec.request(1).headers.get("content-type"), "text/plain");
	assert.equal(await rec.request(1).text(), "hello");
	assert.equal(
		rec.request(2).headers.get("content-type"),
		"application/octet-stream",
	);
	assert.equal(await rec.request(2).text(), "bin");
	assert.equal(
		rec.request(3).headers.get("content-type"),
		"application/json; charset=utf-8",
		"an explicit header is kept",
	);
});

test("a string body for a JSON media type is JSON, not raw text", async () => {
	const rec = recorder();
	await client(rec).patch("/b", { body: "hello" });
	await client(rec).patch("/b", {
		body: "hi",
		contentType: "application/merge-patch+json",
	});
	assert.equal(rec.request(0).headers.get("content-type"), "application/json");
	assert.equal(await rec.request(0).text(), '"hello"');
	assert.equal(await rec.request(1).text(), '"hi"');
});

test("typed arrays are sent as bytes", async () => {
	const rec = recorder();
	await client(rec).post("/b", {
		body: new Uint8Array([104, 105]),
		contentType: "application/octet-stream",
	});
	assert.equal(await rec.request(0).text(), "hi");
});

test("without contentType an object body is JSON, even if a form content-type header is set", async () => {
	const rec = recorder();
	await client(rec).post("/b", {
		body: { a: 1 },
		headers: { "content-type": "application/x-www-form-urlencoded" },
	});
	assert.equal(await rec.request(0).text(), '{"a":1}');
	assert.equal(
		rec.request(0).headers.get("content-type"),
		"application/x-www-form-urlencoded",
		"a per-call header is the caller's choice",
	);
});

test("a content-type in the client's headers is never sent", async () => {
	const rec = recorder();
	const api = client(rec, {
		headers: { "content-type": "application/json", "x-kept": "1" },
	});
	await api.get("/f");
	await api.delete("/f");
	for (const req of rec.requests) {
		assert.equal(req.headers.has("content-type"), false, req.method);
		assert.equal(req.headers.get("x-kept"), "1");
	}
});

test("the body decides content-type over a content-type in the client's headers", async () => {
	const rec = recorder();
	const api = client(rec, { headers: { "content-type": "application/json" } });
	await api.put("/f", { body: new Blob(["png"]), contentType: "image/png" });
	const form = new FormData();
	form.set("a", "1");
	await api.post("/f", { body: form });
	await api.post("/f", { body: new URLSearchParams({ a: "1" }) });
	assert.equal(rec.request(0).headers.get("content-type"), "image/png");
	assert.match(
		rec.request(1).headers.get("content-type") ?? "",
		/^multipart\/form-data; boundary=/,
	);
	assert.equal((await rec.request(1).formData()).get("a"), "1");
	assert.match(
		rec.request(2).headers.get("content-type") ?? "",
		/^application\/x-www-form-urlencoded/,
	);
});

test("strings, Blob, URLSearchParams and ArrayBuffer are sent as is", async () => {
	const rec = recorder();
	const api = client(rec);
	await api.post("/b", { body: "raw", contentType: "text/plain" });
	await api.post("/b", { body: new Blob(["blob"], { type: "text/x-blob" }) });
	await api.post("/b", { body: new URLSearchParams({ a: "1" }) });
	await api.post("/b", { body: new TextEncoder().encode("buf").buffer });
	assert.equal(await rec.request(0).text(), "raw");
	assert.equal(rec.request(1).headers.get("content-type"), "text/x-blob");
	assert.equal(await rec.request(2).text(), "a=1");
	assert.equal(await rec.request(3).text(), "buf");
});

test("ReadableStream bodies are streamed", async () => {
	const rec = recorder();
	const stream = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("streamed"));
			c.close();
		},
	});
	await client(rec).post("/b", { body: stream });
	assert.equal(await rec.request(0).text(), "streamed");
});

test("JSON responses are parsed, including +json", async () => {
	const json = (type: string) => () =>
		new Response('{"ok":1}', {
			status: 200,
			headers: { "content-type": type },
		});
	for (const type of [
		"application/json",
		"application/json; charset=utf-8",
		"application/problem+json",
	]) {
		const res = await client(recorder(json(type))).get("/r");
		assert.deepEqual(res.data, { ok: 1 }, type);
		assert.equal(res.status, 200);
		assert.equal(res.ok, true);
		assert.ok(res.response instanceof Response);
	}
});

test("other responses are text", async () => {
	const rec = recorder(
		() => new Response("hello", { headers: { "content-type": "text/plain" } }),
	);
	assert.equal((await client(rec).get("/r")).data, "hello");
});

test("binary responses are Blobs; XML and other text types are text", async () => {
	const respond =
		(type: string, body = "bytes") =>
		() =>
			new Response(body, { headers: { "content-type": type } });
	for (const type of [
		"application/octet-stream",
		"image/png",
		"Application/PDF; version=1.7",
	]) {
		const data = (await client(recorder(respond(type))).get("/r")).data;
		assert.ok(data instanceof Blob, type);
		assert.equal(await data.text(), "bytes", type);
	}
	for (const type of [
		"application/xml",
		"application/atom+xml",
		"text/csv",
		"*/*",
		"application/*",
	]) {
		assert.equal(
			(await client(recorder(respond(type))).get("/r")).data,
			"bytes",
			type,
		);
	}
	const empty = await client(
		recorder(respond("application/octet-stream", "")),
	).get("/r");
	assert.equal(empty.data, undefined);
});

test("cookie parameters are sent in the cookie header", async () => {
	const rec = recorder();
	await client(rec).get("/c", {
		cookie: {
			session: "a b;c",
			n: 1,
			ids: [1, null, undefined, "x,y"],
			point: { x: 1, y: "a b", z: null },
			empty: [],
			skip: undefined,
			none: null,
		},
	});
	// The values path and header parameters take, each part encoded.
	assert.equal(
		rec.request(0).headers.get("cookie"),
		"session=a%20b%3Bc; n=1; ids=1,x%2Cy; point=x,1,y,a%20b",
	);
	await client(rec).get("/c", { cookie: { skip: undefined } });
	assert.equal(rec.request(1).headers.has("cookie"), false);
	await client(rec).get("/c", {
		cookie: { a: "1" },
		headers: { cookie: "b=2" },
	});
	assert.equal(
		rec.request(2).headers.get("cookie"),
		"b=2",
		"per-call headers win",
	);
});

test("a response without content-type is text", async () => {
	const rec = recorder(() => new Response(new TextEncoder().encode("bytes")));
	const res = await client(rec).get("/r");
	assert.equal(res.response.headers.get("content-type"), null);
	assert.equal(res.data, "bytes");
});

test("the global fetch is used when config.fetch is not given", async (t) => {
	const rec = recorder();
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	globalThis.fetch = (input, init) => rec.fetch(new Request(input, init));
	await loose({ baseUrl: "https://api.test" }).get("/r");
	assert.equal(rec.request(0).url, "https://api.test/r");
});

test("204, 205, 304, HEAD and empty bodies give undefined", async () => {
	assert.equal((await client(recorder()).get("/r")).data, undefined);
	// fetch gives these statuses a null body; a content-type does not make one.
	for (const status of [205, 304]) {
		const rec = recorder(
			() =>
				new Response(null, {
					status,
					headers: { "content-type": "application/octet-stream" },
				}),
		);
		assert.equal((await client(rec).get("/r")).data, undefined, `${status}`);
	}
	const head = recorder(
		() =>
			new Response(null, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	const res = await client(head).head("/r");
	assert.equal(head.request(0).method, "HEAD");
	assert.equal(res.data, undefined);
	const empty = recorder(
		() =>
			new Response("", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	assert.equal((await client(empty).get("/r")).data, undefined);
});

test("HTTP errors do not throw", async () => {
	for (const status of [404, 500]) {
		const rec = recorder(
			() =>
				new Response('{"message":"no"}', {
					status,
					headers: { "content-type": "application/json" },
				}),
		);
		const res = await client(rec).get("/r");
		assert.equal(res.status, status);
		assert.equal(res.ok, false);
		assert.deepEqual(res.data, { message: "no" });
	}
});

test("an error from config.headers rejects the call as it is, before fetch", async () => {
	const rec = recorder();
	const failure = new Error("no token");
	const api = client(rec, {
		headers: async () => {
			throw failure;
		},
	});
	await assert.rejects(api.get("/r"), (e) => e === failure);
	assert.equal(rec.requests.length, 0);
});

test("network failures propagate", async () => {
	const failing: typeof fetch = async () => {
		throw new TypeError("network down");
	};
	const api = loose({ baseUrl: "https://api.test", fetch: failing });
	await assert.rejects(api.get("/r"), /network down/);
});

test("parseAs reads the body as asked", async () => {
	const respond = () =>
		new Response('{"a":1}', {
			headers: { "content-type": "application/octet-stream" },
		});
	const api = client(recorder(respond));
	assert.deepEqual((await api.get("/r", { parseAs: "json" })).data, { a: 1 });
	assert.equal((await api.get("/r", { parseAs: "text" })).data, '{"a":1}');
	const blob = (await api.get("/r", { parseAs: "blob" })).data;
	assert.ok(blob instanceof Blob);
	assert.equal(await blob.text(), '{"a":1}');
	const buffer = (await api.get("/r", { parseAs: "arrayBuffer" })).data;
	assert.ok(buffer instanceof ArrayBuffer);
	assert.equal(new TextDecoder().decode(buffer), '{"a":1}');
	const stream = (await api.get("/r", { parseAs: "stream" })).data;
	assert.ok(stream instanceof ReadableStream);
	assert.equal(await new Response(stream).text(), '{"a":1}');
});

test("parseAs json and stream on an empty body", async () => {
	const api = client(recorder());
	assert.equal((await api.get("/r", { parseAs: "json" })).data, undefined);
	assert.equal((await api.get("/r", { parseAs: "stream" })).data, null);
});

test("a fetch that wraps another sees the built request, and its response is read (the README's example)", async () => {
	const rec = recorder(
		() =>
			new Response('"ok"', { headers: { "content-type": "application/json" } }),
	);
	const token = "t";
	const api = client(rec, {
		fetch: (request) => {
			request.headers.set("authorization", `Bearer ${token}`); // keeps the other headers
			return rec.fetch(request);
		},
	});
	const res = await api.post("/b", {
		body: { a: 1 },
		header: { "x-trace": "1" },
	});
	assert.equal(res.data, "ok");
	const sent = rec.request(0);
	assert.equal(sent.headers.get("authorization"), "Bearer t");
	assert.equal(sent.headers.get("content-type"), "application/json");
	assert.equal(sent.headers.get("x-trace"), "1");
	assert.equal(await sent.text(), '{"a":1}');
});

test("a body that does not parse as its content-type says throws with the response", async () => {
	const api = client(
		recorder(
			() =>
				new Response("<html>bad gateway</html>", {
					status: 502,
					headers: { "content-type": "application/json" },
				}),
		),
	);
	await assert.rejects(api.get("/r"), (e: unknown) => {
		assert.ok(e instanceof ResponseBodyError);
		assert.equal(e.name, "ResponseBodyError");
		assert.equal(e.response.status, 502);
		assert.equal(e.text, "<html>bad gateway</html>");
		return true;
	});
	const parseAs = client(recorder(() => new Response("nope", { status: 200 })));
	await assert.rejects(
		parseAs.get("/r", { parseAs: "json" }),
		ResponseBodyError,
	);
});

test("onData runs for bodies that are empty too", async () => {
	const seen: unknown[] = [];
	const api = client(recorder(), {
		onData: (data: unknown, call: DataCall) => {
			seen.push([call.status, data]);
			return data;
		},
	});
	await api.delete("/r");
	assert.deepEqual(seen, [[204, undefined]]);
});

test("cookie parameters replace a cookie header from the config", async () => {
	const rec = recorder();
	await client(rec, { headers: { cookie: "from=config" } }).get("/c", {
		cookie: { a: "1" },
	});
	assert.equal(rec.request(0).headers.get("cookie"), "a=1");
});

test("onData sees every parsed body with its call and can replace or reject it", async () => {
	const rec = recorder(
		() =>
			new Response('{"id":"7"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	const seen: unknown[] = [];
	const api = client(rec, {
		onData: async (data: unknown, call: DataCall) => {
			seen.push({
				...call,
				response: call.response instanceof Response,
				request: call.request instanceof Request,
			});
			if (call.path === "/bad/{id}")
				throw new TypeError("does not match the schema");
			return { id: Number((data as { id: string }).id) };
		},
	});
	const res = await api.get("/users/{id}", {
		path: { id: 7 },
		parseAs: "json",
	});
	assert.deepEqual(res.data, { id: 7 });
	assert.deepEqual(seen, [
		{
			method: "get",
			path: "/users/{id}",
			status: 200,
			parseAs: "json",
			response: true,
			request: true,
		},
	]);
	await assert.rejects(
		api.get("/bad/{id}", { path: { id: 1 } }),
		/does not match the schema/,
	);
	assert.equal((seen[1] as { parseAs?: string }).parseAs, undefined);
});

test("the signal is passed to fetch", async () => {
	const rec = recorder();
	const controller = new AbortController();
	await client(rec).get("/r", { signal: controller.signal });
	controller.abort();
	assert.equal(rec.request(0).signal.aborted, true);
});

test("fetch's own options pass through, per client and per call; the call's win", async () => {
	const rec = recorder();
	const api = client(rec, {
		credentials: "include",
		cache: "no-store",
		redirect: "manual",
	});
	await api.get("/r", { cache: "reload", keepalive: true });
	const sent = rec.request(0);
	assert.equal(sent.credentials, "include");
	assert.equal(sent.cache, "reload");
	assert.equal(sent.redirect, "manual");
	assert.equal(sent.keepalive, true);
});

test("an option left undefined for a call keeps the client's", async () => {
	const rec = recorder();
	// JavaScript callers can pass undefined, which exactOptionalPropertyTypes rejects.
	const init: Record<string, unknown> = { credentials: undefined };
	await client(rec, { credentials: "include" }).get("/r", init as LooseInit);
	assert.equal(rec.request(0).credentials, "include");
});

test("the client's signal aborts its calls", async () => {
	const rec = recorder();
	const controller = new AbortController();
	await client(rec, { signal: controller.signal }).get("/r");
	controller.abort();
	assert.equal(rec.request(0).signal.aborted, true);
});

test("method, headers and body come from the call, not from fetch options", async () => {
	const rec = recorder();
	const api = client(rec, {
		body: "x",
		method: "PUT",
	} as Partial<ClientConfig>);
	await api.get("/r", { method: "DELETE", body: undefined } as LooseInit);
	const sent = rec.request(0);
	assert.equal(sent.method, "GET");
	assert.equal(sent.body, null);
});
