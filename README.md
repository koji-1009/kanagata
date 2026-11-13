# kanagata

TypeScript types from an OpenAPI 3.0 / 3.1 / 3.2 document (JSON or YAML), and a typed `fetch` client for them.

- `kanagata generate` writes one `.d.ts` file.
- `createClient` from `kanagata/client` is one function over `fetch`, with no imports: the path, query, header and cookie parameters and the body are checked against the operation, and the result is a union per status code.

## Quick start

```sh
pnpm add -D kanagata
pnpm kanagata generate openapi.yaml -o src/api/schema.d.ts
```

```ts
import { createClient } from "kanagata/client";
import type { paths, User } from "./api/schema";

const api = createClient<paths>({ baseUrl: "https://api.example.com" });

const res = await api.get("/users/{id}", { path: { id: 1 } });
if (res.status === 200) {
	const user: User = res.data;
} else {
	res.data.message; // the 404 body
}
```

Run `generate` again after upgrading kanagata: the types and the client come from the same version.

## Install

- The CLI needs Node 24 or later (`engines`). Its one dependency is [`yaml`](https://github.com/eemeli/yaml), which has none.
- The client needs only the Fetch API (with `URL`, `FormData`, `Blob`, `ReadableStream`) and ES2022.
- The package is ES modules only.
- A dev dependency is enough when the app is bundled. Put kanagata in `dependencies` when `kanagata/client` is loaded from `node_modules` at run time: a Node server installed without dev dependencies, or a library you publish.

## CLI

```sh
kanagata generate openapi.yaml -o src/api/schema.d.ts          # write a file
kanagata generate openapi.json -o src/api/schema.d.ts --check  # CI: exit 1 if the file is stale
kanagata generate - < openapi.yaml > src/api/schema.d.ts       # stdin to stdout
kanagata init -o src/api/client.ts                             # copy the client into your project
```

| Option             | Meaning                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `-o <path>`        | output file (`generate`: stdout; `init`: `./client.ts`)                                            |
| `--check`          | `generate`: compare with the `-o` file instead of writing                                          |
| `--loose-nullable` | `generate`: in 3.0, read `nullable: true` as "this schema or null"; see [`nullable`](#nullable-30) |
| `--force`          | `init`: overwrite an existing file                                                                 |

- **Exit codes:** 0 success, 1 `--check` found a difference, 2 an error (document, command line, or file I/O), 3 a bug in kanagata (stack on stderr).
- **Messages** go to stderr as `location: message` or `location: warning: message`. The location is `line:col` for JSON and YAML syntax, a JSON Pointer otherwise, and starts with the file's path relative to the document for other files (`schemas/User.yaml#/properties/id`, `common.json:3:5`).
- **stdin** (`-`) has no location, so it cannot `$ref` other files.
- **Format:** a document that starts with `{` is JSON, anything else YAML 1.2. A key repeated in one object is an error in both.
- **YAML:** numbers keep their notation when it is a JSON number (`1.50` stays `1.50`); YAML-only forms become the number they mean (`0x1F` is `31`). An alias is a copy of its node. The merge key `<<` is YAML 1.1, so it is an ordinary key, with a warning.

## Client

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

### Config (`createClient`)

| Key            | Meaning                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `baseUrl`      | absolute (`https://api.example.com/v1`) or relative (`/api`, `""`); see below                              |
| `fetch`        | `(request) => Promise<Response>` in place of the global `fetch`; wrap it for auth, retries, logging, tests |
| `headers`      | an object, or a function (sync or async) called on every request                                           |
| `arrayFormat`  | arrays in queries and URL-encoded bodies: `repeat` (default), `brackets`, `comma`, `space`, `pipe`         |
| `objectFormat` | objects in queries and URL-encoded bodies: `deepObject` (default), `json`                                  |
| `onData`       | `(data, call) => value` (sync or async): receives every parsed body; return the value to use, or throw     |
| fetch options  | `credentials`, `cache`, `mode`, `redirect`, `keepalive`, `signal`, …                                       |

### Call options

| Key                                 | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `baseUrl`                           | required for an operation that declares `servers`: one of them, used in place of the config's |
| `path`, `query`, `header`, `cookie` | the parameters the operation declares                                                         |
| `querystring`                       | the operation's `in: querystring` parameter (3.2), the whole query; see Details               |
| `body`, `contentType`               | the request body and which of the operation's media types it is                               |
| `parseAs`                           | `json`, `text`, `blob`, `arrayBuffer` or `stream`: read the response this way                 |
| `headers`                           | headers for this call                                                                         |
| `arrayFormat`, `objectFormat`       | override the client's                                                                         |
| fetch options                       | as in the config; a call's win. The client sets `method`, `headers` and `body` itself         |

### Result

`{ status, ok, data, response }`, a union over the statuses the operation documents. `ResultOf<paths, "get", "/users/{id}">` is its type for `api.get("/users/{id}", …)`, `ResultOf<paths, "COPY", "/files/{name}">` for `api.request("COPY", "/files/{name}", …)`, and `ResultOf<paths, "get", "/users/{id}", "text">` with `parseAs: "text"`. `Result<Operation, ParseAs, Method>` is the same by operation; without the method, a HEAD result keeps the declared body.

- **`data`** is parsed by the response's content-type: JSON, text, or `Blob` for binary types. An empty body gives `undefined`. fetch gives HEAD responses and 204, 205 and 304 no body, so their `data` is typed `undefined` whatever the document declares. A status that declares `content` but sends none also gives `undefined`; check for it in `onData`.
  - The content-type the server sends decides, not the document: content typed by a wildcard (`*/*`) is typed by its schema but read as whatever arrives, and a response without a content-type is text (`parseAs: "blob"` keeps its bytes).
  - `data` is read once the whole body has arrived; for a stream that stays open (`text/event-stream`), use `parseAs: "stream"`.
- **`parseAs`** reads the body its way for one call and types `data` to match: `text` a string, `blob` a `Blob`, `arrayBuffer` an `ArrayBuffer`, `stream` the body (`null` when there is none), `json` the parsed JSON (`undefined` when empty), typed by the schemas of JSON and wildcard media types and `unknown` for the others.
- **`ok`** is fetch's: `true` for 2xx. For `default` (every status the operation does not list, 2xx included) it is `boolean`; narrow by `status` or `ok`.
- **Undocumented statuses:** list them with `default` or a range (`4XX`, `5XX`) in the document and they are typed. A status outside the document is still returned, in the branch the types call unreachable. An operation that documents no responses gives `status: number`, `ok: boolean` and `data: unknown`.
- **Response headers** are typed in the declarations (`responses[200].headers`); read them from `res.response.headers`.

### Wrapping a call

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

### Details

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
- **Parameters:** the delimiters `[`, `]` and `|` are percent-encoded, as OpenAPI requires (`filter%5Bname%5D=n`, `ids=1%7C2`). An object or array inside an array is JSON, in every `arrayFormat`. Path, header and cookie parameters take the same values: arrays `1,2`, objects `x,1,y,2`. Undefined and null are left out, and so is an empty array. A missing path parameter, or one of `""`, `.` or `..` (the URL would reach another endpoint), throws `PathParameterError` before anything is sent; see Errors.
- **`querystring`** is the whole query, after any other: for `application/x-www-form-urlencoded` an object, encoded as `query` is (`foo=a%20%2B%20b&bar=true`); for any other media type the text that media type serializes to (`JSON.stringify(value)` for JSON), percent-encoded as one value (`%7B%22n%22%3A1%7D`), as OpenAPI 3.2's examples show.
- **Errors:** HTTP error statuses never throw; network failures are fetch's own errors. A path parameter the URL cannot carry throws `PathParameterError`, a `TypeError` with `parameter` (its name) and `value`, before `config.fetch` is called; a server passing on a client's value can answer 404 for it (`e instanceof PathParameterError`), apart from fetch's network errors, which are `TypeError`s too. A body that is not valid JSON where its content-type or `parseAs: "json"` says JSON (HTML sent as JSON) throws `ResponseBodyError`, which carries the response and the text. An error thrown by `config.headers`, `config.fetch` or `onData` rejects the call as it is. The client's own errors are named as their classes (`e.name` is `"PathParameterError"`, `"ResponseBodyError"`), so logs tell them apart.
- **`config.fetch`** receives the built `Request`; what it returns is read. A request body can be sent once, so a retrying wrapper sends a `request.clone()` taken before the first attempt.
- **`onData`'s `call`** has `method` (the function's name, `get`, or the method given to `request`, `COPY`), `path` (the template, `/users/{id}`), `status`, `parseAs`, `request` and `response`. Plug a zod or valibot schema in here; `data` stays typed by the OpenAPI schema.

### Owning the client

`kanagata init -o src/api/client.ts` copies the client's source (one TypeScript file, no imports, stamped with the kanagata version) into your project; import it from there instead of `kanagata/client` and edit it as you like. After upgrading kanagata, refresh it with `kanagata init -o src/api/client.ts --force` and reapply your edits: the generated types follow the media type rules of the client of the same version.

## Library API

```ts
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GenerateError, generate } from "kanagata";

const file = "openapi.yaml";
try {
	const { code, warnings } = generate(readFileSync(file, "utf8"), {
		url: pathToFileURL(file).href,
		read: (url) => readFileSync(new URL(url), "utf8"),
	});
	for (const w of warnings) console.warn(`${w.at}: ${w.msg}`);
	// code: the .d.ts text
} catch (e) {
	if (e instanceof GenerateError)
		console.error(e.message); // e.kind: "json" | "yaml" | "input"
	else throw e;
}
```

`generate(src, source?, options?)` returns `{ code, warnings }` and throws `GenerateError` (`e.name` is `"GenerateError"` for every `kind`). `source` is the document's absolute URL and `read(url)`, which returns the text of a file a `$ref` points to; without it, `$ref`s to other files are errors. `options` is `{ looseNullable?: boolean }`, as `--loose-nullable`.

## Output

- Every schema in `components.schemas` is a named type (`export type User = { … }`), referenced by name. Names are PascalCase, with `_` before one that would start with a digit; a taken or reserved name gets a number (`User2`). `export interface schemas` maps each original name to its type.
- Operations are `paths[path][method]`, `webhooks[name][method]` (3.1 and 3.2; every key is a name, `x-` ones included), and `operations[operationId]`. The methods are the Path Item's fields in OpenAPI's order (`get` … `trace`, then `query`), then the keys of `additionalOperations` (3.2) as written (`COPY`). A key that is a fixed field's method (`POST`), which OpenAPI forbids, or its name (`post`) is an error; methods are case-sensitive, so `Patch` is another method. The fields OpenAPI 3.2 adds (`$self`, `query`, `additionalOperations`, `in: querystring`, a `$ref` as a media type, `itemSchema`) are read in 3.2 documents only.
- An `in: querystring` parameter (3.2) is `parameters.querystring`, without its name, which is not sent: the schema of its media type for `application/x-www-form-urlencoded`, `string` (the serialized text) for any other.
- A schema with a `readOnly` / `writeOnly` property (on it or on a schema it references) gets a second type for requests, `UserInput`.
- `description` and `deprecated` become JSDoc.
- Header parameters named `Accept`, `Content-Type` or `Authorization`, and a response header `Content-Type`, are ignored, as OpenAPI requires.
- An operation's `servers`, or its path item's, is `servers: ["https://uploads.example.com"]` in its type; a URL with variables (`{region}`) is `string`. A webhook has none, since the API sends its request.
- A `requestBody` on a GET or HEAD operation is left out: OpenAPI 3.0 has consumers ignore it, and fetch cannot send one. A webhook keeps it, since the API sends that request.

### `$ref`

- Resolved as JSON Schema 2020-12 does: JSON Pointers, `$anchor`s (`#node`), and the `$id`s the document declares, relative to the nearest `$id` (3.1 and 3.2).
- The document's `$self` (3.2), resolved against where it was read, is its base URI: relative `$ref`s in it resolve against `$self`, and a `$ref` to `$self` means the document (so does one to the URL it was read from). A `$self` that is not a URI reference is an error. With `$self: https://api.example.com/openapi.yaml`, `schemas/User.yaml` is `https://api.example.com/schemas/User.yaml`, which is not read (below).
- Parameters, request bodies, responses, headers, path items and media types (3.2) may be `$ref`s.
- Other files (`schemas/User.yaml`, `common.json#/Error`) resolve against the base URI where the `$ref` is: the file it is in, or the document's `$self`. Each is read once, JSON or YAML by its content, and known by where it is read: another file's `$self` is not read. URLs are not fetched.
- A schema in another file is a named type. A component that is only a `$ref` to it (with at most `title` and `description`) gives the name (`User: { $ref: schemas/User.yaml }`); otherwise it is named after the file (`Order.yaml` → `Order`) or the pointer's last token (`common.json#/Error` → `Error`), numbered when taken, and listed in `schemas`.
- A component that is only a `$ref` within the document names its target the same way; other targets within the document are expanded where they are used.
- A schema may refer to itself through an object, array or tuple (`next?: Node`). A cycle among `$ref`s expanded inline becomes `unknown`, with a warning.

### Schemas

Types follow what the schema accepts, not another generator's output.

| Schema                                                                                                              | TypeScript                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`                                                                                                        | `unknown`                                                                                                                                                             |
| `false`                                                                                                             | `never`                                                                                                                                                               |
| `const`, `enum`                                                                                                     | literal types; objects and arrays become exact object and tuple types                                                                                                 |
| `allOf`, `oneOf` / `anyOf`, sibling `type` / object keywords                                                        | all intersected: `A & B & (C \| D)`                                                                                                                                   |
| `discriminator`                                                                                                     | not read (it must not change what is accepted, OAS 3.0.4 / 3.1.1); members narrow where they fix the property (`const`, `enum`)                                       |
| keywords next to `$ref`                                                                                             | intersected in 3.1 and 3.2; ignored in 3.0 (`readOnly` / `writeOnly` and `nullable` too) except `description`; see [`nullable`](#nullable-30)                         |
| `type: [...]`; `nullable: true` (3.0) next to `type`                                                                | union, with `null`; see [`nullable`](#nullable-30)                                                                                                                    |
| `type` with `const` / `enum`, and these with each other                                                             | the values all allow: `type: string, enum: ["a", 1]` is `"a"`; a contradiction is `never`                                                                             |
| `type: integer`                                                                                                     | `number`; non-integer `enum` / `const` values are dropped                                                                                                             |
| `format: binary`; binary `contentMediaType` without `contentEncoding`                                               | `Blob`                                                                                                                                                                |
| `prefixItems`                                                                                                       | tuple; items past `minItems` are optional, `items` gives the rest                                                                                                     |
| `required` key without a property schema, or whose property schema admits any value (`{}`, `true`, a `$ref` to one) | `key: {} \| null` (any value but `undefined`; `Anything & ({} \| null)` for a reference), so another member's type for it holds: `{ a?: string } & { a: {} \| null }` |
| `additionalProperties`, `patternProperties`                                                                         | an index signature that also admits the declared properties (TypeScript cannot check the pattern)                                                                     |
| `additionalProperties: false` with no properties, `const: {}`, `maxProperties: 0`                                   | `{ [key: string]: never }`; with `maxProperties: 0` and a required key, `never`                                                                                       |
| `additionalProperties: false` (no `patternProperties`) and a required key outside `properties`                      | `never`, as is an `allOf` / `oneOf` / `anyOf` member next to it that requires one                                                                                     |
| object without properties                                                                                           | `Record<string, unknown>`                                                                                                                                             |
| object keywords without `type`                                                                                      | an object (non-objects are never meant), so `{ type: "string", allOf: [{ properties: … }] }` is `never`                                                               |
| `readOnly` / `writeOnly` property                                                                                   | left out of what is sent / what is returned                                                                                                                           |
| `not`, `if` / `then` / `else`, `dependentSchemas`, `unevaluated*`, `$dynamicRef`                                    | ignored, with a warning                                                                                                                                               |

Content by media type:

| Media type                                                 | Type                                    |
| ---------------------------------------------------------- | --------------------------------------- |
| JSON                                                       | its schema                              |
| `text/*`, XML                                              | `string`                                |
| forms (`application/x-www-form-urlencoded`, `multipart/*`) | request: its schema; response: `string` |
| any other (binary), not a wildcard                         | `Blob`                                  |

A sequential media type's `itemSchema` (3.2) is checked like a schema but types nothing: the client reads the content whole, by the rules above (`application/jsonl` is `Blob`, `text/event-stream` `string`). Read it item by item with `parseAs: "stream"`.

### `nullable` (3.0)

`nullable: true` reads as OpenAPI 3.0.3 says: it adds `null` to the `type` in the same schema, and the other keywords still apply to `null`.

- `{ type: string, nullable: true }` is `string | null`.
- Without `type` it takes no effect: `{ nullable: true, allOf: [{ $ref: User }] }` is `User`.
- Next to `$ref` it is ignored, like every keyword there in 3.0: `{ $ref: User, nullable: true }` is `User`.
- An `enum` or `const` that does not list `null` keeps it out: `{ type: string, enum: [a, b], nullable: true }` is `"a" | "b"`.
- `allOf`, `oneOf` and `anyOf` members must admit `null` too: `{ type: object, nullable: true, allOf: [{ $ref: User }] }` is `User & (Record<string, unknown> | null)`, which has `null` only if `User` does.

Many documents use these forms to mean "this schema or null" (Stripe and GitHub among them), and their servers return `null`. `--loose-nullable` (`generate(src, source, { looseNullable: true })`) reads them that way: `nullable: true` adds `null` to the whole schema, next to `$ref` and without `type` too. The examples above become `string | null`, `User | null`, `User | null`, `"a" | "b" | null` and `User & Record<string, unknown> | null`.

## Not supported

- Runtime validation (use `onData`), middleware (wrap `config.fetch`), per-operation functions, framework bindings, mocks.
- Per-parameter `style` / `explode` / `encoding`: a server parses every query and form the same way, so one `arrayFormat` / `objectFormat` per client (or per call) matches it.
- Fetching `$ref`s over the network; finding another file by its `$self` (3.2), since files are read by where they are; Swagger 2.0.
- Pathological inputs: a schema that is directly itself (`A: { $ref: A }`), looping `$ref`s or YAML aliases, nesting thousands of levels deep, or exponential expansion may crash (exit code 3) or not finish.

## Development

```sh
pnpm install
pnpm test
```

[AGENTS.md](AGENTS.md) covers the layout, commands and how to make changes.

## License

[MIT](LICENSE)
