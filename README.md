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
	res.data.message; // typed as the 404 body; a status the document does not list (a gateway's 502) lands here too
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

`--loose-nullable` reads 3.0 `nullable: true` as "this schema or null" (see [Generated types](#generated-types)). Every option, the exit codes and messages, and `generate` as a library: [docs/cli.md](docs/cli.md).

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

- `api.get`, `api.post`, … take the path template and the operation's parameters and body; a method of `additionalOperations` (3.2) goes through `api.request("COPY", …)`.
- The result is `{ status, ok, data, response }`, a union over the statuses the operation documents: checking `status` or `ok` narrows `data`. In an operation with `default`, neither narrows to the success body alone: `default`'s `status` is `number` and its `ok` is `boolean`, so its `data` stays after `res.status === 200` and after `res.ok`. HTTP error statuses never throw.
- `kanagata init` copies the client's source into your project to edit as you like.

Config, call options, results, typing a wrapper, how requests are built, and errors: [docs/client.md](docs/client.md).

## Generated types

- Every schema in `components.schemas` is a named type; operations are `paths[path][method]`, `webhooks[name][method]` and `operations[operationId]`.
- Types follow what the schema accepts, not another generator's output.
- A schema with a `readOnly` / `writeOnly` property gets a second type for requests, `UserInput`.
- In 3.0, `nullable: true` adds `null` to the `type` next to it, as OpenAPI 3.0.3 says, so it takes no effect without `type`, next to `$ref`, or past an `enum` without `null`. Many documents mean "this schema or null" instead; `--loose-nullable` reads them that way.

Every rule, with `$ref` resolution and media types: [docs/types.md](docs/types.md).

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
