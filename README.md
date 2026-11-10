# kanagata

From an OpenAPI 3.0 / 3.1 document (JSON or YAML), kanagata makes two things, and only these:

- **Types:** `kanagata generate` turns the document into one `.d.ts` file of TypeScript types.
- **A typed call:** `createClient` from `kanagata/client`, one function over `fetch` with no imports, typed by those types: path, query, header and body are checked against the operation, and the result is a discriminated union per status code.

The client hands you fetch's own `Request` and `Response`. Anything around them (auth, retries, caching, framework bindings, runtime validation, mocks) is yours to add with plain fetch; `onData` receives every parsed body for validation.
The CLI's one dependency is [`yaml`](https://github.com/eemeli/yaml), which has none. A document split into files is read through its `$ref`s; URLs are not fetched, and Swagger 2.0 is not read.

## Install

```sh
pnpm add -D kanagata   # or npm install -D kanagata
```

The CLI requires Node 26 or later (`engines`, which also applies where kanagata is a production dependency). The client needs only the Fetch API and its companions (`URL`, `FormData`, `Blob`, `ReadableStream`), and is ES2022 syntax.
The package is ES modules only.
A dev dependency is enough where the app is bundled, as the bundler copies the client in. kanagata goes in `dependencies` where the client is loaded from `node_modules` at run time: a Node server installed without dev dependencies, or a library you publish that imports `kanagata/client`.
After upgrading kanagata, run `generate` again: the types and the client come from the same version.

## Usage

```sh
kanagata generate openapi.yaml -o src/api/schema.d.ts   # or openapi.json

# CI: fail when the checked-in file is stale
kanagata generate openapi.json -o src/api/schema.d.ts --check

# stdin to stdout
kanagata generate - < openapi.yaml > src/api/schema.d.ts
```

Without `-o`, `generate` writes to stdout; `-` reads the document from stdin, which has no location, so it cannot refer to other files.
Exit codes: 0 success, 1 `--check` found a difference, 2 an error (in the document, in the command line, or in reading or writing a file), 3 a bug in kanagata (reported on stderr with its stack).
Errors go to stderr as `location: message`, and warnings as `location: warning: message`, where the location is `line:col` for JSON and YAML syntax and a JSON Pointer otherwise.
A document that starts with `{` is read as JSON, anything else as YAML 1.2. From YAML, numbers keep the notation they are written in (`1.50` stays `1.50`) when it is a JSON number; YAML-only forms become the number they mean (`0x1F` is `31`). The merge key `<<` belongs to YAML 1.1, so it is a key like any other, with a warning. An alias is a copy of the node it names. A key repeated in one object is an error in JSON as in YAML.

```ts
import { createClient } from "kanagata/client";
import type { paths, User } from "./schema";

const api = createClient<paths>({ baseUrl: "https://api.example.com" });

const res = await api.get("/users/{id}", { path: { id: 1 } });
if (res.status === 200) {
	const user: User = res.data;
} else {
	res.data.message; // the 404 body
}
```

### Client

- **baseUrl:** absolute (`https://api.example.com/v1`), or relative (`/api`), which resolves on every call as fetch resolves a relative URL: against the page's base URL in a browser, the worker's location in a worker; where there is neither (Node), a relative one throws a TypeError naming it. `""` is the page's origin, as in `fetch("" + path)`. Its own query is kept, before the call's.
- **Parameters:** `path`, `query`, `header` and `cookie`, as the operation declares them. Cookies go in the `cookie` header, which browsers do not let fetch set; given, they replace a `cookie` header from the config. A `Date` is sent as its ISO string.
- **Headers:** the config's `headers` (an object, or a function called on every request), then the call's header parameters, then the call's `headers`; a later one replaces an earlier one of the same name.
- **Bodies:** `body` with `contentType` naming one of the operation's media types; the body's type follows the choice. `contentType` may be left out for `application/json`, which is what is sent then, and for a `FormData` or `URLSearchParams`; another JSON media type (`application/merge-patch+json`) must be named; a wildcard (`*/*`, `application/*`) names no media type, so no content-type is set for it: a string, `Blob` or other raw body carries its own, and any other value goes as JSON. A value is sent as JSON (strings included), URL-encoded, or as `FormData` by its media type; text and binary bodies as they are.
- **Statuses:** the result is a union over the statuses the operation documents; the document is the contract. Cover the statuses you do not list one by one with `default` or a range (`4XX`, `5XX`), as OpenAPI provides, and they are typed too. `ok` is fetch's: `true` for a 2xx status. For `default`, which covers every status the operation does not list, 2xx included, it is `boolean`; narrow by `status` or `ok` together with what you know of the API. A status outside the document is the server breaking the contract: the client still returns it, in the branch the types call unreachable.
- **Responses:** `data` is parsed by the response's content-type (JSON, text, or `Blob` for binary types), and is `undefined` for an empty body (204, HEAD, or any status that sends none), as a response without `content` is typed; `parseAs: "json" | "text" | "blob" | "arrayBuffer" | "stream"` overrides that for one call and changes `data`'s type. Response headers are typed in the declarations (`responses[200].headers`); read them from `res.response.headers`.
- **Queries and URL-encoded bodies:** arrays by `arrayFormat` (`repeat` by default, `brackets`, `comma`, `space`, `pipe`) and objects by `objectFormat` (`deepObject` by default, `json`), per client or per call; an object inside a joined array (`comma`, `space`, `pipe`) is JSON. A URL-encoded or multipart body must be an object, and a URL-encoded one cannot hold a `Blob`: either throws a TypeError. The `style` / `explode` / `encoding` a document declares per parameter are deliberately not supported: a server parses every query and form the same way (that is how its framework works), so one setting per client matches it. Path and header parameters use the simple style (`1,2`), leaving out undefined and null as queries do; a path parameter of `""`, `.` or `..` throws, since URLs resolve those and the request would reach another endpoint.
- **fetch options:** fetch's own options (`credentials`, `cache`, `mode`, `redirect`, `keepalive`, `signal`, …) go in the client's config or in a call, and a call's win; the client sets `method`, `headers` and `body`.
- **fetch:** the client builds a `Request` and hands it to `fetch` (the global one, or `config.fetch`); what that returns is the response it reads. Auth, retries and logging go in a `config.fetch` that wraps the global one; the client has no middleware of its own. As anywhere with fetch, a request body can be sent once: a wrapper that retries sends a `request.clone()` taken before the first attempt.
- **Errors:** HTTP error statuses never throw; network failures are fetch's own errors. A body that is not what its content-type says (an HTML page sent as JSON) throws `ResponseBodyError`, which carries the response and the text.
- **Runtime validation:** not built in. `onData(data, call)` receives every parsed body with `call.method`, `call.path` (the template, such as `/users/{id}`) and `call.status`; return the value to use, or throw. Plug a zod or valibot schema in there.

```ts
const api = createClient<paths>({
	baseUrl: "https://api.example.com",
	fetch: (input, init) => {
		const request = new Request(input, init);
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

### Owning the client

To change the client itself, copy it into your project: `kanagata init -o src/api/client.ts` writes its source (one TypeScript file with no imports), stamped with the kanagata version, and you import it from there instead of `kanagata/client`.
After upgrading kanagata, refresh the copy (`kanagata init --force`, then reapply your edits): the generated types follow the media type rules of the client of the same version.

## Output

Every schema in `components.schemas` becomes a named type (`export type User = { … }`), referenced by name everywhere.
Names are the PascalCase form of the schema name; a name that is taken or reserved gets a numeric suffix (`User2`), and `export interface schemas` maps each original schema name to its type.
Operations are reachable as `paths[path][method]` (and `webhooks[name][method]` for 3.1 webhooks, where every key is a name, `x-` ones included) and, when they have an `operationId`, as `operations[id]`.
`$ref`s resolve as JSON Schema 2020-12 does: JSON Pointers, `$anchor`s (`#node`) and the `$id`s the document declares, relative to the nearest `$id` (in 3.1), and other files (`schemas/User.yaml`, `common.json#/Error`), relative to the file the `$ref` is in. Each file is read once, JSON or YAML by its content; URLs are not fetched.
A schema in another file is a named type, like a component: a component that is only a `$ref` to it names it (`User: { $ref: schemas/User.yaml }` makes every `$ref` to that file `User`); otherwise it is named after its file (`Order.yaml` → `Order`) or the last token of the pointer into it (`common.json#/Error` → `Error`), with a number when the name is taken (`Order2`), and listed in `schemas` under that key. A component that is only a `$ref` within the document names its target the same way; other targets within the document are expanded where they are used.
Problems in another file are located by its path relative to the document (`schemas/User.yaml#/properties/id`, `common.json:3:5`).

Types follow what the schema accepts, not another generator's output:

| Schema                                                                                  | TypeScript                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`                                                                            | `unknown`                                                                                                                                                                        |
| `false`                                                                                 | `never`                                                                                                                                                                          |
| `const`, `enum`                                                                         | literal types (objects and arrays become exact object and tuple types)                                                                                                           |
| `allOf`, `oneOf` / `anyOf`, and sibling `type` / object keywords                        | all parts intersected: `A & B & (C \| D)`                                                                                                                                        |
| `discriminator` on `oneOf` / `anyOf`                                                    | not read: it must not change what the schema accepts (OAS 3.0.4, 3.1.1), so the type is the union as written; members narrow by the property where they fix it (`const`, `enum`) |
| keywords next to `$ref`                                                                 | applied (intersected) in 3.1; in 3.0 ignored (`readOnly` and `writeOnly` too) except `nullable` and `description`                                                                |
| `type: [...]`, `nullable: true` (3.0)                                                   | union, with `null`                                                                                                                                                               |
| `format: binary`; a binary `contentMediaType` without `contentEncoding` (3.1)           | `Blob`                                                                                                                                                                           |
| `type` next to `const` / `enum`, and these with each other                              | the values all of them allow: `type: string, enum: ["a", 1]` is `"a"`; `type: [string, null]` with `type: string` is `string`; a contradiction is `never`                        |
| content of a binary media type (not JSON, text, XML, forms or a wildcard)               | `Blob`, which the client returns for it                                                                                                                                          |
| content of `text/*` or XML                                                              | `string`, which the client reads and sends                                                                                                                                       |
| response content of a form (`application/x-www-form-urlencoded`, `multipart/*`)         | `string`, which the client returns for it (a request body of a form is typed by its schema)                                                                                      |
| `type: integer`                                                                         | `number`; `enum` / `const` values that are not whole numbers are dropped                                                                                                         |
| `prefixItems`                                                                           | tuple; items past `minItems` are optional, `items` gives the rest                                                                                                                |
| `required` key without a property schema                                                | `key: unknown`                                                                                                                                                                   |
| `additionalProperties`                                                                  | index signature that also admits the declared properties                                                                                                                         |
| `additionalProperties: false` with no properties, `const: {}`                           | `{ [key: string]: never }`                                                                                                                                                       |
| `patternProperties`                                                                     | their types join the index signature (TypeScript cannot check the pattern)                                                                                                       |
| object without properties                                                               | `Record<string, unknown>`                                                                                                                                                        |
| `properties` / `required` / `additionalProperties` / `patternProperties` without `type` | an object; JSON Schema would also accept non-objects there, which TypeScript users never mean, so `{ type: "string", allOf: [{ properties: … }] }` is `never`                    |
| `if` / `then` / `else`, `dependentSchemas`, `unevaluated*`, `$dynamicRef`               | ignored with a warning                                                                                                                                                           |
| `readOnly` / `writeOnly` property (on it or on the schema it references)                | left out of what is sent / what is returned; a schema that has one (or references one) gets a second type for requests, `UserInput`                                              |
| `not`                                                                                   | ignored with a warning                                                                                                                                                           |

Header parameters named `Accept`, `Content-Type` or `Authorization` are ignored, as OpenAPI requires.

A schema may refer to itself through an object, array or tuple (`next?: Node`), which is a recursive type. A cycle among `$ref`s expanded inline becomes `unknown`, with a warning.

kanagata is written for documents as APIs publish them, not for inputs built to be pathological: a schema that is directly its own type (`A: { $ref: A }`), `$ref`s or YAML aliases that loop, nesting thousands of levels deep, or definitions that expand exponentially are not guarded against, and may crash it (exit code 3) or not finish.

`nullable: true` (3.0; 3.1 has no such keyword) adds `null` to the schema, even when it has no `type`, as in `{ "nullable": true, "allOf": [{ "$ref": … }] }`, and even next to an `enum` that does not list `null`.
OpenAPI 3.0.3 says `nullable` only takes effect next to `type` and does not override `enum`, which would make those schemas non-nullable; but documents use both patterns to mean "this schema or null" (`nullable` without `type`: Stripe 633 times, GitHub 148), and their servers do return `null`.
Following the letter would hide those nulls from the types, so kanagata follows the intent.

The library API is `generate(src, source?)` from `kanagata`: it returns `{ code, warnings }` and throws `GenerateError` (with `kind` `json`, `yaml` or `input`). `source` is `{ url, read }`: the document's absolute URL (a `file:` URL for a file), and `read(url)`, which returns the text of a file a `$ref` points to; without it, `$ref`s to other files are errors.

## Development

```sh
pnpm install
pnpm test
```

Sources are TypeScript run directly by Node (type stripping) in development and compiled to `dist/` for publishing. The specification is `tests/spec/<name>/`: hand-written inputs and the declarations they must produce. [AGENTS.md](AGENTS.md) describes the layout, the commands and how changes are made (for people and AI agents alike).

## License

[MIT](LICENSE)
