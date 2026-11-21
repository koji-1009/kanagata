# Generated types

- Every schema in `components.schemas` is a named type (`export type User = { … }`), referenced by name. Names are PascalCase, with `_` before one that would start with a digit, and `_` for one with no letter or digit (`-`); a taken or reserved name gets a number (`User2`). `export interface schemas` maps each original name to its type.
- Operations are `paths[path][method]`, `webhooks[name][method]` (3.1 and 3.2; see [Webhooks](#webhooks)), and `operations[operationId]`. An Operation Object reached again through a Path Item that two paths share (a `$ref` or a YAML alias) is declared once there; one with an `operationId` reached again where its type differs (a YAML alias of the Operation Object under paths with different path-level parameters; a path's and a webhook's, see [Webhooks](#webhooks)) is an error, since `operations[operationId]` has one type. Another Operation Object with the same `operationId`, which OpenAPI requires to be unique, is an error, even when written alike. The methods are the Path Item's fields in OpenAPI's order (`get` … `trace`, then `query`), then the keys of `additionalOperations` (3.2) as written (`COPY`). A key that is a fixed field's method (`POST`), which OpenAPI forbids, or its name (`post`) is an error; methods are case-sensitive, so `Patch` is another method. The fields OpenAPI 3.2 adds (`$self`, `query`, `additionalOperations`, `in: querystring`, a `$ref` as a media type, `itemSchema`) are read in 3.2 documents only.
- A parameter defined by `content` is the schema of its media type for `application/x-www-form-urlencoded`, which the client encodes as it does any parameter, and `string` for any other: the client has no document to serialize the value by, so the call passes the serialized text (`filter: JSON.stringify({ q: "a" })` for `application/json`). A response header defined by `content` keeps the schema.
- An `in: querystring` parameter (3.2) is `parameters.querystring`, without its name, which is not sent; it is defined by `content`, so it is typed as above.
- A schema with a `readOnly` / `writeOnly` property (on it or on a schema it references) gets a second type for what is sent to the API (a path's request, a webhook's responses), `UserInput`.
- A property left out of a view is left out of the whole schema it is in, whatever else lists it: a `required` next to it, next to its `$ref` (3.1, 3.2) or in an `allOf` / `oneOf` / `anyOf` member does not bring it back (`required` takes effect on the other side only, as OpenAPI says). A member that is a `$ref` to a schema with the property is written out without it, since the reference's view has it: `allOf: [{ $ref: Base }, { properties: { id: { readOnly: true } } }]` sends Base's properties but `id`.
- The `description` and `deprecated` of schemas, properties, operations, parameters, request bodies and headers become JSDoc; a response's and a path item's are not read. In 3.1 and 3.2, a `description` next to the `$ref` to a parameter, request body or header replaces the referenced one's, as OpenAPI says; 3.0 ignores a Reference Object's other fields.
- A path parameter is required whatever its `required` says (OpenAPI requires it to be `true`): the path cannot be built without it. Other parameters, request bodies and headers are required where `required` is `true`.
- Header parameters named `Accept`, `Content-Type` or `Authorization`, and a response header `Content-Type`, are ignored, as OpenAPI requires.
- A field OpenAPI requires is an error where it is missing: a parameter's `name` and `in`, a parameter's or header's `schema` or `content` (one of the two, and `content` with exactly one media type, as OpenAPI requires), a request body's `content` (an empty one describes no representation, so it is `content: {}`, which no body matches), a server's `url`. So is a path item, operation, parameter, request body, response, header, media type, `responses`, `headers` or `content` that is not an object, `parameters` or `servers` that is not an array, an `operationId` that is not a string, and a `required` that is not a boolean. These are checked where kanagata reads the field, so not in what it leaves out: a webhook's `servers`, a path item's `servers` next to an operation's own, a `requestBody` on a path's GET or HEAD.
- A parameter whose `in` is none of `path`, `query`, `header` and `cookie` (and `querystring` in 3.2) is left out.
- The `servers` of a path's operation, or of its path item, are `servers: ["https://uploads.example.com"]` in its type; a URL with variables (`{region}`) is `string`.
- A `requestBody` on a path's GET or HEAD operation is left out: OpenAPI 3.0 has consumers ignore it, and fetch cannot send one.

## Webhooks

A webhook (`webhooks`, 3.1 and 3.2) is a request the API sends to a receiver the API consumer implements, and the responses the API expects back. `webhooks` is read in 3.1 and 3.2 documents only: it is no field of OpenAPI 3.0. A webhook's types are a path operation's with the directions swapped:

- Its parameters and request body are the read view, and its responses (headers and content) the write view: `readOnly` properties are kept and `writeOnly` ones left out of the request, the other way round in the responses, so a schema with either is `User` in the request and `UserInput` in the responses.
- A form, in its request or its responses, is its schema: the client does not receive it, so it is not the text a path's form response is.
- It keeps a `requestBody` on GET and HEAD, since the API sends the request.
- It has no `servers`: the API sends its request, so there is none to choose.
- Every key of `webhooks` is a name, `x-` ones included.
- An operation with an `operationId` that is both a path's and a webhook's (in a Path Item they share) is an error where its two types are declared differently, as they are when it has a `readOnly` / `writeOnly` property or refers to a schema with one (`User` in one, `UserInput` in the other): `operations[operationId]` has one type.

A parameter or header defined by `content` is typed as a path's is (above). The client calls `paths` only (`createClient<paths>`): `webhooks` types the receiver you implement.

## `$ref`

- Resolved as JSON Schema 2020-12 does: JSON Pointers, `$anchor`s and `$dynamicAnchor`s (`#node`), and the `$id`s the document declares, relative to the nearest `$id` (3.1 and 3.2), a pointer's target too: the `$ref`s in a schema reached by a pointer into a schema with `$id` resolve against that `$id`.
- `$dynamicRef` is a `$ref` where no other `$dynamicAnchor` of its name can take the place of the one it reaches (a pointer, a plain `$anchor`, or the only `$dynamicAnchor` of the name). Otherwise which one applies depends on how the value was reached, which no type says: it is ignored, with a warning.
- The document's `$self` (3.2), resolved against where it was read, is its base URI: relative `$ref`s in it resolve against `$self`, and a `$ref` to `$self` means the document (so does one to the URL it was read from). A `$self` that is not a URI reference is an error. With `$self: https://api.example.com/openapi.yaml`, `schemas/User.yaml` is `https://api.example.com/schemas/User.yaml`, which is not read (below).
- Parameters, request bodies, responses, headers, path items and media types (3.2) may be `$ref`s.
- A Path Item's fields next to its `$ref` are read with those of the Path Item it refers to, each against the document it is in: `/pets: { $ref: …, post: … }` has the referenced `get` and this `post`, and `parameters` next to `$ref` apply to both. A field in both (`summary`, `description` and extensions aside) is an error, since OpenAPI leaves which one applies undefined.
- Other files (`schemas/User.yaml`, `common.json#/Error`) resolve against the base URI where the `$ref` is: the file it is in, or the document's `$self`. Each is read once, JSON or YAML by its content, and known by where it is read: another file's `$self` is not read. URLs are not fetched.
- A schema in another file is a named type. A component that is only a `$ref` to it (with at most `title` and `description`) gives the name (`User: { $ref: schemas/User.yaml }`), the first one when there are several; otherwise it is named after the file (`Order.yaml` → `Order`) or the pointer's last token (`common.json#/Error` → `Error`), numbered when taken, and listed in `schemas`.
- A component that is only a `$ref` within the document names its target the same way; other targets within the document are expanded where they are used.
- A schema may refer to itself through an object, array or tuple (`next?: Node`). One that reaches itself without one in between, through `allOf`, `oneOf`, `anyOf` and `$ref` only (`Tree: { oneOf: [{ type: string }, { $ref: Tree }] }`, `A: { $ref: A }`), is an error: TypeScript rejects `type Tree = string | Tree`. A schema expanded where it is used that reaches itself is named, as a schema in another file is: after the pointer's last token (`#/components/schemas/Tree/$defs/node` → `Node`), and listed in `schemas`.

## Schemas

Types follow what the schema accepts, not another generator's output.

| Schema                                                                                                              | TypeScript                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`, `{}`                                                                                                        | `unknown`                                                                                                                                                             |
| `false`                                                                                                             | `never`                                                                                                                                                               |
| `const`, `enum`                                                                                                     | literal types; objects and arrays become exact object and tuple types                                                                                                 |
| `allOf`, `oneOf` / `anyOf`, sibling `type` / object keywords                                                        | all intersected: `A & B & (C \| D)`                                                                                                                                   |
| a `oneOf` / `anyOf` member of a kind the other parts rule out                                                       | left out: `{ type: object, properties: …, oneOf: [{ $ref: Cat }, { type: string }] }` is `{ … } & Cat`                                                                |
| `oneOf` members that only require keys                                                                              | each lacks the keys the others require; see [`oneOf`](#oneof)                                                                                                         |
| `discriminator`                                                                                                     | not read (it must not change what is accepted, OAS 3.0.4 / 3.1.1); members narrow where they fix the property (`const`, `enum`)                                       |
| keywords next to `$ref`                                                                                             | intersected in 3.1 and 3.2; ignored in 3.0 (`readOnly` / `writeOnly`, `deprecated` and `nullable` too) except `description`; see [`nullable`](#nullable-30)           |
| `type: [...]`; `nullable: true` (3.0) next to `type`                                                                | union, with `null`; see [`nullable`](#nullable-30)                                                                                                                    |
| `type` with `const` / `enum`, and these with each other                                                             | the values all allow: `type: string, enum: ["a", 1]` is `"a"`; a contradiction is `never`                                                                             |
| `type: integer`                                                                                                     | `number`; non-integer `enum` / `const` values are dropped                                                                                                             |
| a `type` JSON Schema does not have (`file`)                                                                         | `unknown`, in a `type` array too, so `type: [string, file]` is `unknown`                                                                                              |
| `format: binary`; binary `contentMediaType` without `contentEncoding`                                               | `Blob`                                                                                                                                                                |
| `prefixItems`, `minItems`, `maxItems`                                                                               | a tuple where they say more than an array; see [Array length](#array-length)                                                                                          |
| `required` key without a property schema, or whose property schema admits any value (`{}`, `true`, a `$ref` to one) | `key: {} \| null` (any value but `undefined`; `Anything & ({} \| null)` for a reference), so another member's type for it holds: `{ a?: string } & { a: {} \| null }` |
| `required` key outside `properties` that `patternProperties` or `additionalProperties` types                        | the patterns' types it matches, or else `additionalProperties`: `{ a: string; [key: string]: string }`; a key nothing admits, `never`                                 |
| `additionalProperties`, `patternProperties`                                                                         | an index signature that also admits the declared properties (TypeScript cannot check the pattern)                                                                     |
| `additionalProperties: false` with no properties, `const: {}`, `maxProperties: 0`                                   | `{ [key: string]: never }`; with `maxProperties: 0` and a required key, `never`                                                                                       |
| `additionalProperties: false` (no `patternProperties`) and a required key outside `properties`                      | `never`, as is an `allOf` / `oneOf` / `anyOf` member next to it that requires one, or its `$ref` target (3.1, 3.2), through nested `allOf` too                        |
| `additionalProperties: false` (no `patternProperties`) and other keys its `$ref` target or members name             | `k?: never` for each; a closed `oneOf` / `anyOf` member gets `k?: never` for the keys the other members name                                                          |
| object without properties                                                                                           | `Record<string, unknown>`                                                                                                                                             |
| object keywords without `type`                                                                                      | an object (non-objects are never meant), but other kinds the parent's `type` names pass: `{ type: string, allOf: [{ properties: … }] }` is `string`                   |
| array keywords (`items`, `prefixItems`, `minItems`, `maxItems`) without `type`                                      | an array (non-arrays are never meant), so `{ minItems: 1 }` is `[unknown, ...unknown[]]`; other kinds the parent's `type` names pass, as for object keywords          |
| `readOnly` / `writeOnly` property                                                                                   | left out of what is sent to the API / what it sends                                                                                                                   |
| `if` / `then` / `else`, `dependentSchemas`, `unevaluated*` next to an applicator                                    | ignored, with a warning                                                                                                                                               |
| `not`, `dependentRequired`, `propertyNames`, `contains`, `unevaluated*` without an applicator                       | what TypeScript can say of them; see [Other keywords](#other-keywords)                                                                                                |
| `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`     | the `const` / `enum` values they reject are left out, and a string or number they admit one of (or none) is it; see [Values](#values)                                 |
| `minProperties`, `maxProperties` of a closed object (`additionalProperties: false`, no `patternProperties`)         | which properties are present: `minProperties: 1` with `a` and `b` is `{ a: A; b?: B } \| { a?: A; b: B }`; too many or too few, `never`                               |
| `format` (other than `binary`), `uniqueItems`, `minProperties`, `maxProperties` (other than 0) of an open object    | ignored, without a warning: the type admits every value they do, and more                                                                                             |

## Array length

An array is `T[]` until `prefixItems`, `minItems` or `maxItems` say more; then it is a tuple.

- The first `minItems` items are required: `{ items: string, minItems: 1 }` is `[string, ...string[]]`. `prefixItems` types the first items and `items` the rest (absent, any value; `false` next to `prefixItems`, no more items): `{ prefixItems: [string], items: number, minItems: 3 }` is `[string, number, number, ...number[]]`.
- `maxItems` closes the tuple, the items past `minItems` optional: `{ minItems: 1, maxItems: 2 }` is `[T, T?]`, `{ maxItems: 3 }` is `[T?, T?, T?]`, `{ prefixItems: [string], items: number, minItems: 1, maxItems: 3 }` is `[string, number?, number?]`, `{ prefixItems: [string, number], maxItems: 1 }` is `[string?]`, and `maxItems: 0` is `[]`.
- TypeScript bounds a length only by writing out every item, so every item is written, however many: `{ maxItems: 1000 }` is a tuple of 1000 optional items.
- `maxItems` below `minItems`, or `minItems` past `prefixItems` with `items: false`, admits no array: `never`.
- A `minItems` or `maxItems` that is not a non-negative integer is ignored.
- Arrays and tuples in `allOf` (or next to each other) meet item by item, since TypeScript reads an item of an intersection of arrays as one member's alone: `{ allOf: [{ type: array, items: string }, { minItems: 2 }] }` is `[string, string, ...string[]]`. So do the arrays in unions, member by member (`type: [string, array]` next to `oneOf: [{ type: string }, { type: array, items: string }]` is `string | string[]`), and the arrays of a property two object types share, which become one object type.
- A `$ref` to an array stays a reference, with its type beside it so that the items read as it says: `{ allOf: [{ $ref: Tags }, { maxItems: 1 }] }` is `Tags & [string?]` where `Tags` is `string[]`.

## Values

- `const` and `enum` values the schema's keywords for their kind reject are left out: `{ type: string, enum: [a, bbb], maxLength: 2 }` is `"a"`, and a `const` they reject is `never`. Lengths count characters (`"😀"` is one), `pattern` is an ECMA-262 pattern (one JavaScript cannot read leaves out nothing), and bounds and `multipleOf` compare decimal values (`0.3` is a multiple of `0.1`). A `multipleOf` that is not positive is not read.
- In 3.0, `exclusiveMinimum` / `exclusiveMaximum` are booleans that make `minimum` / `maximum` exclusive; in 3.1 and 3.2 they are bounds of their own, and the tighter one applies.
- `maxLength: 0` is `""`, and `minLength` above `maxLength` is `never`. Bounds that admit one number are it (`{ type: integer, minimum: 1.2, maximum: 2.5 }` is `2`), and bounds that admit none are `never`.
- Other lengths are `string` and other ranges `number`, an integer range too (`{ type: integer, minimum: 1, maximum: 100 }` is `number`).

## Other keywords

- `not: {}` (or `true`) is `never`, and `not: false` changes nothing. `not: { type }` leaves the other kinds: `{ type: [string, null], not: { type: "null" } }` is `string`. `not: { required: [a, b] }` is the objects without one of them: `{ a?: never } | { b?: never }`. `not: { enum }` and `not: { const }` leave out the values they list. Any other `not`, `not: { type: integer }` without `number`, and a value a member admits by its kind (`type: string` for `not: { const: "" }`) are ignored, with a warning: TypeScript has no type for what they leave.
- `dependentRequired: { a: [b] }` is `{ a?: never } | { b: … }`: without `a`, or with `b`.
- `propertyNames: false` admits no key. `propertyNames: { enum }` or `{ const }` lists the keys the object has, as `additionalProperties: false` would its properties: a declared property it does not list is `never`, a listed key nothing declares has the value `patternProperties` or `additionalProperties` gives it. Any other `propertyNames` is ignored, with a warning.
- `contains` asks for `minContains` items (1 when not given) that match it. The type says that many items, not which, with a warning: `{ items: string, contains: … }` is `[string, ...string[]]`.
- `unevaluatedProperties` and `unevaluatedItems` are `additionalProperties` and `items` where no applicator (`allOf`, `oneOf`, `anyOf`, `$ref`, `if`, `dependentSchemas`) evaluates anything; next to one they are ignored, with a warning.
- These constrain only objects (arrays, for `contains`), so the other kinds `type` names pass them: `{ type: [object, null], dependentRequired: … }` admits `null`.

## `oneOf`

`oneOf` admits a value exactly one member admits. TypeScript has no type for what a member does not admit, so the members are a union, which also admits a value two of them admit, except among members that only require keys: `required`, with at most `type: object`, properties that admit any value (`{}`, `true`, a `$ref` to one) and annotations, or a `$ref` to such a schema. Such a member does not admit exactly the objects that lack one of its keys, so each of them lacks the keys the others require.

A literal or `null` two members admit is left out: `oneOf: [{ type: [string, null] }, { type: [integer, null] }]` is `string | number`, and `oneOf: [{ enum: [a, b] }, { enum: [b, c] }]` is `"a" | "c"`. Where a member admits it by its kind (`type: string` for `"a"`, `{}` for `null`), it stays: TypeScript has no type for a kind but one of its values. A `$ref` member is not counted.

- `oneOf: [{ required: [a] }, { required: [b] }]` is `{ a: {} | null } & { b?: never } | { b: {} | null } & { a?: never }`: `{ a, b }` is rejected.
- Lacking one of several keys: next to `{ required: [b, c] }`, `{ required: [a] }` is `{ a: {} | null } & { b?: unknown; c?: unknown } & ({ b?: never } | { c?: never })`. The keys are declared `unknown` so that an object literal with one of them is not rejected as excess.
- A member that requires all of another's keys admits nothing: next to `{ required: [a] }`, `{ required: [a, b] }` is `never`.
- Other members keep their overlaps: with `{ properties: { b: { type: number } }, required: [b] }`, `{ a: 1, b: "x" }` matches only `{ required: [a] }`, so `{ required: [a] }` cannot leave out `b`, and `{ a: 1, b: 1 }`, which both match, stays admitted.

## Content by media type

| Media type                                                 | Type                                              |
| ---------------------------------------------------------- | ------------------------------------------------- |
| JSON                                                       | its schema                                        |
| `text/*`, XML                                              | `string`                                          |
| forms (`application/x-www-form-urlencoded`, `multipart/*`) | a path's response: `string`; otherwise its schema |
| `*/*`, `application/*`, which name no representation       | its schema                                        |
| any other (binary), other wildcards (`image/*`) included   | `Blob`                                            |

A sequential media type's `itemSchema` (3.2) is checked like a schema but types nothing: the client reads the content whole, by the rules above (`application/jsonl` is `Blob`, `text/event-stream` `string`). Read it item by item with `parseAs: "stream"`.

## `nullable` (3.0)

`nullable: true` reads as OpenAPI 3.0.3 says: it adds `null` to the `type` in the same schema, and the other keywords still apply to `null`.

- `{ type: string, nullable: true }` is `string | null`.
- Without `type` it takes no effect: `{ nullable: true, allOf: [{ $ref: User }] }` is `User`.
- Next to `$ref` it is ignored, like every keyword there in 3.0: `{ $ref: User, nullable: true }` is `User`.
- An `enum` or `const` that does not list `null` keeps it out: `{ type: string, enum: [a, b], nullable: true }` is `"a" | "b"`.
- `allOf`, `oneOf` and `anyOf` members must admit `null` too: `{ type: object, nullable: true, allOf: [{ $ref: User }] }` is `User & (Record<string, unknown> | null)`, which has `null` only if `User` does. A member without `type` that only has object or array keywords (`{ required: [a] }`) does not apply to `null`, so `null` passes it.

Many documents use these forms to mean "this schema or null" (Stripe and GitHub among them), and their servers return `null`. `--loose-nullable` (`generate(src, source, { looseNullable: true })`) reads them that way: `nullable: true` adds `null` to the whole schema, next to `$ref` and without `type` too. The examples above become `string | null`, `User | null`, `User | null`, `"a" | "b" | null` and `User & Record<string, unknown> | null`.
