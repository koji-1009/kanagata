# Generated types

- Every schema in `components.schemas` is a named type (`export type User = { … }`), referenced by name. Names are PascalCase, with `_` before one that would start with a digit; a taken or reserved name gets a number (`User2`). `export interface schemas` maps each original name to its type.
- Operations are `paths[path][method]`, `webhooks[name][method]` (3.1 and 3.2; every key is a name, `x-` ones included), and `operations[operationId]`. An Operation Object reached again through a Path Item that two paths share (a `$ref` or a YAML alias) is declared once there; another Operation Object with the same `operationId`, which OpenAPI requires to be unique, is an error, even when written alike. The same operation as a path's and a webhook's is an error too: the API sends a webhook's request, so it has two types, and `operations[operationId]` has one. The methods are the Path Item's fields in OpenAPI's order (`get` … `trace`, then `query`), then the keys of `additionalOperations` (3.2) as written (`COPY`). A key that is a fixed field's method (`POST`), which OpenAPI forbids, or its name (`post`) is an error; methods are case-sensitive, so `Patch` is another method. The fields OpenAPI 3.2 adds (`$self`, `query`, `additionalOperations`, `in: querystring`, a `$ref` as a media type, `itemSchema`) are read in 3.2 documents only.
- An `in: querystring` parameter (3.2) is `parameters.querystring`, without its name, which is not sent: the schema of its media type for `application/x-www-form-urlencoded`, `string` (the serialized text) for any other.
- A schema with a `readOnly` / `writeOnly` property (on it or on a schema it references) gets a second type for requests, `UserInput`.
- `description` and `deprecated` become JSDoc.
- Header parameters named `Accept`, `Content-Type` or `Authorization`, and a response header `Content-Type`, are ignored, as OpenAPI requires.
- A field OpenAPI requires is an error where it is missing: a parameter's `name` and `in`, a parameter's or header's `schema` or `content` (one of the two, and `content` with exactly one media type, as OpenAPI requires), a request body's `content` (an empty one describes no representation, so it is `content: {}`, which no body matches), a server's `url`. So is a path item, operation, parameter, request body, response, header, media type, `responses`, `headers` or `content` that is not an object, `parameters` or `servers` that is not an array, an `operationId` that is not a string, and a `required` that is not a boolean.
- An operation's `servers`, or its path item's, is `servers: ["https://uploads.example.com"]` in its type; a URL with variables (`{region}`) is `string`. A webhook has none, since the API sends its request.
- A `requestBody` on a GET or HEAD operation is left out: OpenAPI 3.0 has consumers ignore it, and fetch cannot send one. A webhook keeps it, since the API sends that request.

## `$ref`

- Resolved as JSON Schema 2020-12 does: JSON Pointers, `$anchor`s (`#node`), and the `$id`s the document declares, relative to the nearest `$id` (3.1 and 3.2).
- The document's `$self` (3.2), resolved against where it was read, is its base URI: relative `$ref`s in it resolve against `$self`, and a `$ref` to `$self` means the document (so does one to the URL it was read from). A `$self` that is not a URI reference is an error. With `$self: https://api.example.com/openapi.yaml`, `schemas/User.yaml` is `https://api.example.com/schemas/User.yaml`, which is not read (below).
- Parameters, request bodies, responses, headers, path items and media types (3.2) may be `$ref`s.
- Other files (`schemas/User.yaml`, `common.json#/Error`) resolve against the base URI where the `$ref` is: the file it is in, or the document's `$self`. Each is read once, JSON or YAML by its content, and known by where it is read: another file's `$self` is not read. URLs are not fetched.
- A schema in another file is a named type. A component that is only a `$ref` to it (with at most `title` and `description`) gives the name (`User: { $ref: schemas/User.yaml }`); otherwise it is named after the file (`Order.yaml` → `Order`) or the pointer's last token (`common.json#/Error` → `Error`), numbered when taken, and listed in `schemas`.
- A component that is only a `$ref` within the document names its target the same way; other targets within the document are expanded where they are used.
- A schema may refer to itself through an object, array or tuple (`next?: Node`). One that reaches itself without one in between, through `allOf`, `oneOf`, `anyOf` and `$ref` only (`Tree: { oneOf: [{ type: string }, { $ref: Tree }] }`, `A: { $ref: A }`), is an error: TypeScript rejects `type Tree = string | Tree`. A cycle among `$ref`s expanded inline becomes `unknown`, with a warning.

## Schemas

Types follow what the schema accepts, not another generator's output.

| Schema                                                                                                              | TypeScript                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`                                                                                                        | `unknown`                                                                                                                                                             |
| `false`                                                                                                             | `never`                                                                                                                                                               |
| `const`, `enum`                                                                                                     | literal types; objects and arrays become exact object and tuple types                                                                                                 |
| `allOf`, `oneOf` / `anyOf`, sibling `type` / object keywords                                                        | all intersected: `A & B & (C \| D)`                                                                                                                                   |
| `oneOf` members that only require keys                                                                              | each lacks the keys the others require; see [`oneOf`](#oneof)                                                                                                         |
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

## `oneOf`

`oneOf` admits a value exactly one member admits. TypeScript has no type for what a member does not admit, so the members are a union, which also admits a value two of them admit, except among members that only require keys: `required`, with at most `type: object`, properties that admit any value (`{}`, `true`, a `$ref` to one) and annotations, or a `$ref` to such a schema. Such a member does not admit exactly the objects that lack one of its keys, so each of them lacks the keys the others require.

- `oneOf: [{ required: [a] }, { required: [b] }]` is `{ a: {} | null } & { b?: never } | { b: {} | null } & { a?: never }`: `{ a, b }` is rejected.
- Lacking one of several keys: next to `{ required: [b, c] }`, `{ required: [a] }` is `{ a: {} | null } & { b?: unknown; c?: unknown } & ({ b?: never } | { c?: never })`. The keys are declared `unknown` so that an object literal with one of them is not rejected as excess.
- A member that requires all of another's keys admits nothing: next to `{ required: [a] }`, `{ required: [a, b] }` is `never`.
- Other members keep their overlaps: with `{ properties: { b: { type: number } }, required: [b] }`, `{ a: 1, b: "x" }` matches only `{ required: [a] }`, so `{ required: [a] }` cannot leave out `b`, and `{ a: 1, b: 1 }`, which both match, stays admitted.

## Content by media type

| Media type                                                 | Type                                    |
| ---------------------------------------------------------- | --------------------------------------- |
| JSON                                                       | its schema                              |
| `text/*`, XML                                              | `string`                                |
| forms (`application/x-www-form-urlencoded`, `multipart/*`) | request: its schema; response: `string` |
| any other (binary), not a wildcard                         | `Blob`                                  |

A sequential media type's `itemSchema` (3.2) is checked like a schema but types nothing: the client reads the content whole, by the rules above (`application/jsonl` is `Blob`, `text/event-stream` `string`). Read it item by item with `parseAs: "stream"`.

## `nullable` (3.0)

`nullable: true` reads as OpenAPI 3.0.3 says: it adds `null` to the `type` in the same schema, and the other keywords still apply to `null`.

- `{ type: string, nullable: true }` is `string | null`.
- Without `type` it takes no effect: `{ nullable: true, allOf: [{ $ref: User }] }` is `User`.
- Next to `$ref` it is ignored, like every keyword there in 3.0: `{ $ref: User, nullable: true }` is `User`.
- An `enum` or `const` that does not list `null` keeps it out: `{ type: string, enum: [a, b], nullable: true }` is `"a" | "b"`.
- `allOf`, `oneOf` and `anyOf` members must admit `null` too: `{ type: object, nullable: true, allOf: [{ $ref: User }] }` is `User & (Record<string, unknown> | null)`, which has `null` only if `User` does.

Many documents use these forms to mean "this schema or null" (Stripe and GitHub among them), and their servers return `null`. `--loose-nullable` (`generate(src, source, { looseNullable: true })`) reads them that way: `nullable: true` adds `null` to the whole schema, next to `$ref` and without `type` too. The examples above become `string | null`, `User | null`, `User | null`, `"a" | "b" | null` and `User & Record<string, unknown> | null`.
