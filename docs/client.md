# Client

```ts
const api = createClient<paths>({
	baseUrl: "https://api.example.com",
	fetch: (request) => {
		request.headers.set("authorization", `Bearer ${token}`); // keeps the other headers
		return fetch(request);
	},
});

await api.put("/files/{name}", {
	path: { name: "a.png" },
	body: file,
	contentType: "image/png",
});

const events = await api.get("/events", { parseAs: "stream" }); // events.data: ReadableStream | null
```

`api.get`, `api.post`, … (one per HTTP method of the Path Item, `query` included, but `trace`, which fetch rejects; the declarations still type trace operations) take the path template and an object of options, which is optional when nothing in it is required. A required body cannot be `undefined`, even when its schema admits any value. A union of path templates takes options that hold what every one of them needs.

A method of `additionalOperations` (3.2) is called through `api.request`, named as the document writes it, which is how it is sent: `api.request("COPY", "/files/{name}", { path: { name: "a.png" } })`. fetch rejects CONNECT, TRACE and TRACK, and sends DELETE, GET, HEAD, OPTIONS, POST and PUT in upper case whatever their case (`Post` as POST), so `request` does not take them.

## Config (`createClient`)

| Key            | Meaning                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `baseUrl`      | absolute (`https://api.example.com/v1`) or relative (`/api`, `""`); see [Details](#details)                |
| `fetch`        | `(request) => Promise<Response>` in place of the global `fetch`; wrap it for auth, retries, logging, tests |
| `headers`      | an object, or a function (sync or async) called on every request                                           |
| `arrayFormat`  | arrays in queries and URL-encoded bodies: `repeat` (default), `brackets`, `comma`, `space`, `pipe`         |
| `objectFormat` | objects in queries and URL-encoded bodies: `deepObject` (default), `json`                                  |
| `onData`       | `(data, call) => value` (sync or async): receives every parsed body; return the value to use, or throw     |
| fetch options  | `credentials`, `cache`, `mode`, `redirect`, `keepalive`, `signal`, …                                       |

## Call options

| Key                                 | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `baseUrl`                           | required for an operation that declares `servers`: one of them, used in place of the config's |
| `path`, `query`, `header`, `cookie` | the parameters the operation declares                                                         |
| `querystring`                       | the operation's `in: querystring` parameter (3.2), the whole query; see [Details](#details)   |
| `body`, `contentType`               | the request body and which of the operation's media types it is                               |
| `parseAs`                           | `json`, `text`, `blob`, `arrayBuffer` or `stream`: read the response this way                 |
| `headers`                           | headers for this call                                                                         |
| `arrayFormat`, `objectFormat`       | override the client's                                                                         |
| fetch options                       | as in the config; a call's win. The client sets `method`, `headers` and `body` itself         |

## Result

`{ status, ok, data, response }`, a union over the statuses the operation documents. `ResultOf<paths, "get", "/users/{id}">` is its type for `api.get("/users/{id}", …)`, `ResultOf<paths, "COPY", "/files/{name}">` for `api.request("COPY", "/files/{name}", …)`, and `ResultOf<paths, "get", "/users/{id}", "text">` with `parseAs: "text"`. `Result<Operation, ParseAs, Method>` is the same by operation; without the method, a HEAD result keeps the declared body.

- **`data`** is parsed by the response's content-type: JSON, text, or `Blob` for binary types. An empty body gives `undefined`. fetch gives HEAD responses and 204, 205 and 304 no body, so their `data` is typed `undefined` whatever the document declares. A status that declares `content` but sends none also gives `undefined`; check for it in `onData`.
  - The content-type the server sends decides, not the document: content typed by a wildcard (`*/*`) is typed by its schema but read as whatever arrives, and a response without a content-type is text (`parseAs: "blob"` keeps its bytes).
  - `data` is read once the whole body has arrived; for a stream that stays open (`text/event-stream`), use `parseAs: "stream"`.
- **`parseAs`** reads the body its way for one call and types `data` to match: `text` a string, `blob` a `Blob`, `arrayBuffer` an `ArrayBuffer`, `stream` the body (`null` when there is none), `json` the parsed JSON (`undefined` when empty), typed by the schemas of JSON and wildcard media types and `unknown` for the others.
- **`ok`** is fetch's: `true` for 2xx. For `default` (every status the operation does not list, 2xx included) it is `boolean`; narrow by `status` or `ok`.
- **Undocumented statuses:** list them with `default` or a range (`4XX`, `5XX`) in the document and they are typed. A status outside the document is still returned, in the branch the types call unreachable. An operation that documents no responses gives `status: number`, `ok: boolean` and `data: unknown`.
- **Response headers** are typed in the declarations (`responses[200].headers`); read them from `res.response.headers`.

## Wrapping a call

`PathsOf<paths, "get">` (the path templates with that method), `ArgsOf<paths, "get", Path, ParseAs>` (the arguments after the path) and `ResultOf` type a function that wraps a call, with no assertion. TypeScript cannot infer `parseAs` through the spread, so the call names its type arguments:

```ts
import type { ArgsOf, ParseAs, PathsOf, ResultOf } from "kanagata/client";

async function get<
	Path extends PathsOf<paths, "get">,
	A extends ParseAs | undefined = undefined,
>(
	path: Path,
	...args: ArgsOf<paths, "get", Path, A>
): Promise<ResultOf<paths, "get", Path, A>> {
	const res = await api.get<Path, A>(path, ...args);
	log(path, res.status);
	return res;
}
```

For `api.request`, the method takes the place of `"get"`: `ArgsOf<paths, "COPY", Path>`.

`OkResult<R>` and `NotOkResult<R>` are the results `if (res.ok)` leaves on each side. `default` is on both, since it covers an undocumented 2xx; `Extract<R, { ok: true }>` would drop it. A wrapper that throws the others returns `OkResult<…>["data"]`:

```ts
import type { ArgsOf, OkResult, PathsOf, ResultOf } from "kanagata/client";

async function getOk<Path extends PathsOf<paths, "get">>(
	path: Path,
	...args: ArgsOf<paths, "get", Path>
): Promise<OkResult<ResultOf<paths, "get", Path>>["data"]> {
	const res = await api.get(path, ...args);
	if (!res.ok) throw res; // NotOkResult<ResultOf<paths, "get", Path>>
	return res.data;
}
```

## Details

- **baseUrl:** a relative one resolves on every call as fetch resolves it: against the page's base URL, or the worker's location. Where there is neither (Node), it throws a TypeError. `""` is the origin of the page's base URL. Its own query is kept, before the call's. An operation that declares `servers` (or whose path item does) is served there, not by the document's servers, so its call names one of them as `baseUrl`; other operations take the config's and cannot be given one.
- **Headers:** the config's `headers`, then the call's header parameters, then its cookie parameters, then its `headers`; a later one replaces an earlier one of the same name. Cookie parameters go in the `cookie` header, which browsers do not let fetch set. A `Date` is sent as its ISO string.
- **content-type** comes from the body, never from the config's `headers` (with or without a body); one in the call's `headers` replaces it, except for a multipart body made from an object or a `FormData`, which needs its boundary.
- **Request bodies:** a value is sent as JSON (strings included), URL-encoded, or as `FormData`, by its media type; text and binary bodies as they are.
  - `contentType` may be left out for `application/json` (which is then sent) and for a `FormData` or `URLSearchParams`, with or without media type parameters. Other JSON types (`application/merge-patch+json`) must be named.
  - A binary body is a `Blob`, `ArrayBuffer`, typed array or `ReadableStream`.
  - A wildcard (`*/*`, `application/*`) names no media type: a string, `Blob` or other raw body is sent with its own content-type, and any other value as JSON with `application/json`.
  - A URL-encoded or multipart value that is not a raw body must be an object; otherwise a TypeError. A `Blob` cannot be URL-encoded, in a body or a query; that is a TypeError too.
  - Multipart fields: an array repeats the field, a `Blob` is a file, a `Date` its ISO string, another object JSON. Another multipart type (`multipart/mixed`, `multipart/related`) gets the same named parts under its own type.
  - A raw body (string, `Blob`, `URLSearchParams`, …) is sent as it is for form media types too.
- **Parameters:** the delimiters `[`, `]` and `|` are percent-encoded, as OpenAPI requires (`filter%5Bname%5D=n`, `ids=1%7C2`). An object or array inside an array is JSON, in every `arrayFormat`. Path, header and cookie parameters take the same values: arrays `1,2`, objects `x,1,y,2`. Undefined and null are left out, and so is an empty array. A parameter defined by `content` with a media type other than `application/x-www-form-urlencoded` is typed `string`, the text its media type serializes to, which is sent as any string is: as it is in a header, percent-encoded in the URL and in a cookie ([Generated types](types.md)). A missing path parameter, or one of `""`, `.` or `..` (the URL would reach another endpoint), throws `PathParameterError` before anything is sent; see Errors.
- **`querystring`** is the whole query, after any other: for `application/x-www-form-urlencoded` an object, encoded as `query` is (`foo=a%20%2B%20b&bar=true`); for any other media type the text that media type serializes to (`JSON.stringify(value)` for JSON), percent-encoded as one value (`%7B%22n%22%3A1%7D`), as OpenAPI 3.2's examples show.
- **Errors:** HTTP error statuses never throw; network failures are fetch's own errors. A path parameter the URL cannot carry throws `PathParameterError`, a `TypeError` with `parameter` (its name) and `value`, before `config.fetch` is called; a server passing on a client's value can answer 404 for it (`e instanceof PathParameterError`), apart from fetch's network errors, which are `TypeError`s too. A body that is not valid JSON where its content-type or `parseAs: "json"` says JSON (HTML sent as JSON) throws `ResponseBodyError`, which carries the response and the text. An error thrown by `config.headers`, `config.fetch` or `onData` rejects the call as it is. The client's own errors are named as their classes (`e.name` is `"PathParameterError"`, `"ResponseBodyError"`), so logs tell them apart.
- **`config.fetch`** receives the built `Request`; what it returns is read. A request body can be sent once, so a retrying wrapper sends a `request.clone()` taken before the first attempt.
- **`onData`'s `call`** has `method` (the function's name, `get`, or the method given to `request`, `COPY`), `path` (the template, `/users/{id}`), `status`, `parseAs`, `request` and `response`. Plug a zod or valibot schema in here; `data` stays typed by the OpenAPI schema.

## Owning the client

`kanagata init -o src/api/client.ts` copies the client's source (one TypeScript file, no imports, stamped with the kanagata version) into your project; import it from there instead of `kanagata/client` and edit it as you like. After upgrading kanagata, refresh it with `kanagata init -o src/api/client.ts --force` and reapply your edits: the generated types follow the media type rules of the client of the same version.
