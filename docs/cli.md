# CLI and library API

## CLI

```sh
kanagata generate openapi.yaml -o src/api/schema.d.ts          # write a file
kanagata generate openapi.json -o src/api/schema.d.ts --check  # CI: exit 1 if the file is stale
kanagata generate - < openapi.yaml > src/api/schema.d.ts       # stdin to stdout
kanagata init -o src/api/client.ts                             # copy the client into your project
```

| Option             | Meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `-o <path>`        | output file (`generate`: stdout; `init`: `./client.ts`)                                                    |
| `--check`          | `generate`: compare with the `-o` file instead of writing                                                  |
| `--loose-nullable` | `generate`: in 3.0, read `nullable: true` as "this schema or null"; see [`nullable`](types.md#nullable-30) |
| `--force`          | `init`: overwrite an existing file                                                                         |

- **Exit codes:** 0 success, 1 `--check` found a difference, 2 an error (document, command line, or file I/O), 3 a bug in kanagata (stack on stderr).
- **Messages** go to stderr as `location: message` or `location: warning: message`. The location is `line:col` for JSON and YAML syntax, a JSON Pointer otherwise, and starts with the file's path relative to the document for other files (`schemas/User.yaml#/properties/id`, `common.json:3:5`).
- **stdin** (`-`) has no location, so it cannot `$ref` other files.
- **Format:** a document that starts with `{` is JSON, anything else YAML 1.2. A key repeated in one object is an error in both.
- **YAML:** numbers keep their notation when it is a JSON number (`1.50` stays `1.50`); YAML-only forms become the number they mean (`0x1F` is `31`). An alias is the node it names, not a copy, so a Path Item shared by an alias is one Path Item (its operations are declared once); an alias inside the node it names is an error. The merge key `<<` is YAML 1.1, so it is an ordinary key, with a warning.

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
