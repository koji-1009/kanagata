import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerateError, generate } from "../../src/index.ts";

/** A 3.1 document with the given `components.schemas` body. */
const schemas = (body: string) =>
	`{"openapi":"3.1.0","components":{"schemas":{"Ok":{"type":"string"},${body}}}}`;

/** A 3.1 document with the given `paths` body. */
const paths = (body: string) => `{"openapi":"3.1.0","paths":{${body}}}`;

const MISSING = '{"$ref":"#/components/schemas/Missing"}';

function error(src: string): GenerateError {
	try {
		generate(src);
	} catch (e) {
		assert.ok(e instanceof GenerateError);
		return e;
	}
	assert.fail(`generated: ${src}`);
}

test("an error anywhere in the document stops generation and names its location", () => {
	const s = "#/components/schemas/S";
	const p = "#/paths/~1a/get";
	const cases: [string, string][] = [
		[schemas(`"S":{"allOf":[${MISSING}]}`), `${s}/allOf/0`],
		[schemas(`"S":{"anyOf":[${MISSING}]}`), `${s}/anyOf/0`],
		[
			schemas(
				`"S":{"oneOf":[{"type":"string"}],"properties":{"a":${MISSING}}}`,
			),
			`${s}/properties/a`,
		],
		[schemas(`"S":{"type":["array"],"items":${MISSING}}`), `${s}/items`],
		[schemas(`"S":{"prefixItems":[${MISSING}]}`), `${s}/prefixItems/0`],
		[
			schemas(`"S":{"prefixItems":[{"type":"string"}],"items":${MISSING}}`),
			`${s}/items`,
		],
		[schemas(`"S":{"$ref":"#/components/nowhere"}`), s],
		[paths(`"/a":{"$ref":"#/nowhere"}`), "#/paths/~1a"],
		[
			paths(`"/a":{"parameters":[{"$ref":"#/nowhere"}],"get":{}}`),
			"#/paths/~1a/parameters/0",
		],
		[
			paths(`"/a":{"get":{"parameters":[{"$ref":"#/nowhere"}]}}`),
			`${p}/parameters/0`,
		],
		[
			paths(
				`"/a":{"get":{"parameters":[{"name":"q","in":"query","schema":${MISSING}}]}}`,
			),
			`${p}/parameters/0/schema`,
		],
		[
			paths(`"/a":{"post":{"requestBody":{"$ref":"#/nowhere"}}}`),
			"#/paths/~1a/post/requestBody",
		],
		[
			paths(
				`"/a":{"post":{"requestBody":{"content":{"text/plain":{"schema":${MISSING}}}}}}`,
			),
			"#/paths/~1a/post/requestBody/content/text~1plain/schema",
		],
		[
			paths(`"/a":{"get":{"responses":{"200":{"$ref":"#/nowhere"}}}}`),
			`${p}/responses/200`,
		],
	];
	for (const [src, at] of cases) {
		const e = error(src);
		assert.equal(e.kind, "input");
		assert.equal(e.diag?.at, at, src);
		assert.ok(e.message.startsWith(`${at}: `), `${src}\n${e.message}`);
	}
});

test("a field OpenAPI requires, missing or of another kind, is an error at its object", () => {
	const p = "#/paths/~1a/get";
	const param = (fields: string) =>
		paths(`"/a":{"get":{"parameters":[${fields}]}}`);
	const cases: [string, string][] = [
		[param(`"q"`), `${p}/parameters/0: a parameter must be an object`],
		[
			param(`{"in":"query","schema":{}}`),
			`${p}/parameters/0: a parameter must have name and in`,
		],
		[
			param(`{"name":"q","in":1,"schema":{}}`),
			`${p}/parameters/0: a parameter must have name and in`,
		],
		[
			param(`{"name":"q","in":"query"}`),
			`${p}/parameters/0: a parameter must have schema or content`,
		],
		[
			param(`{"name":"q","in":"query","content":{}}`),
			`${p}/parameters/0/content: a parameter's content must have exactly one media type`,
		],
		[
			param(
				`{"name":"q","in":"query","content":{"application/json":{},"text/plain":{}}}`,
			),
			`${p}/parameters/0/content: a parameter's content must have exactly one media type`,
		],
		[
			param(`{"name":"q","in":"query","content":[]}`),
			`${p}/parameters/0/content: content must be an object`,
		],
		[
			paths(`"/a":{"get":{"responses":{"200":{"headers":{"X":true}}}}}`),
			`${p}/responses/200/headers/X: a header must be an object`,
		],
		[
			paths(
				`"/a":{"get":{"responses":{"200":{"headers":{"X":{"content":{}}}}}}}`,
			),
			`${p}/responses/200/headers/X/content: a header's content must have exactly one media type`,
		],
		[paths(`"/a":{"get":"x"}`), `${p}: an operation must be an object`],
		[paths(`"/a":{"get":null}`), `${p}: an operation must be an object`],
		[
			`{"openapi":"3.2.0","paths":{"/a":{"additionalOperations":[]}}}`,
			"#/paths/~1a/additionalOperations: additionalOperations must be an object",
		],
		[
			`{"openapi":"3.2.0","paths":{"/a":{"additionalOperations":{"COPY":1}}}}`,
			"#/paths/~1a/additionalOperations/COPY: an operation must be an object",
		],
		[
			paths(`"/a":{"get":{"servers":[{"description":"x"}]}}`),
			`${p}/servers/0: a server must have a url`,
		],
		[
			paths(`"/a":{"servers":["https://a.example"],"get":{}}`),
			"#/paths/~1a/servers/0: a server must have a url",
		],
		[paths(`"/a":[]`), "#/paths/~1a: a path item must be an object"],
		[
			paths(`"/a":{"post":{"requestBody":"x"}}`),
			"#/paths/~1a/post/requestBody: a request body must be an object",
		],
		[
			paths(`"/a":{"post":{"requestBody":{"description":"x"}}}`),
			"#/paths/~1a/post/requestBody: a request body must have content",
		],
		[
			paths(`"/a":{"post":{"requestBody":{"content":[]}}}`),
			"#/paths/~1a/post/requestBody/content: content must be an object",
		],
		[
			paths(`"/a":{"post":{"requestBody":{"content":{"text/plain":1}}}}`),
			"#/paths/~1a/post/requestBody/content/text~1plain: a media type must be an object",
		],
		[
			`{"openapi":"3.2.0","paths":{"/a":{"post":{"requestBody":{"content":{"text/plain":1}}}}}}`,
			"#/paths/~1a/post/requestBody/content/text~1plain: a media type must be an object",
		],
		[
			param(`{"name":"q","in":"query","content":{"text/plain":null}}`),
			`${p}/parameters/0/content/text~1plain: a media type must be an object`,
		],
		[
			paths(`"/a":{"get":{"responses":[]}}`),
			`${p}/responses: responses must be an object`,
		],
		[
			paths(`"/a":{"get":{"responses":{"200":"ok"}}}`),
			`${p}/responses/200: a response must be an object`,
		],
		[
			paths(`"/a":{"get":{"responses":{"200":{"headers":[]}}}}`),
			`${p}/responses/200/headers: headers must be an object`,
		],
		[
			paths(`"/a":{"get":{"parameters":{}}}`),
			`${p}/parameters: parameters must be an array`,
		],
		[
			paths(`"/a":{"parameters":"q","get":{}}`),
			"#/paths/~1a/parameters: parameters must be an array",
		],
		[
			paths(`"/a":{"get":{"servers":{}}}`),
			`${p}/servers: servers must be an array`,
		],
		[
			param(`{"name":"q","in":"query","required":"true","schema":{}}`),
			`${p}/parameters/0/required: required must be a boolean`,
		],
		[
			paths(
				`"/a":{"post":{"requestBody":{"required":1,"content":{"text/plain":{}}}}}`,
			),
			"#/paths/~1a/post/requestBody/required: required must be a boolean",
		],
		[
			paths(
				`"/a":{"get":{"responses":{"200":{"headers":{"X":{"required":null,"schema":{}}}}}}}`,
			),
			`${p}/responses/200/headers/X/required: required must be a boolean`,
		],
		[
			paths(`"/a":{"get":{"operationId":1}}`),
			`${p}/operationId: operationId must be a string`,
		],
	];
	for (const [src, message] of cases) {
		const e = error(src);
		assert.equal(e.kind, "input", src);
		assert.equal(e.message, message, src);
	}
});

test("a schema that reaches itself only through unions, intersections and references is an error", () => {
	const msg =
		"circular reference without an object, array or tuple in between, which TypeScript rejects";
	const s = (key: string) => `"#/components/schemas/${key}"`;
	const cases: [string, string][] = [
		[
			`"Self":{"$ref":${s("Self")}}`,
			`#/components/schemas/Self: ${msg}: Self → Self`,
		],
		[
			`"A":{"allOf":[{"$ref":${s("B")}}]},"B":{"anyOf":[{"type":"null"},{"$ref":${s("A")}}]}`,
			`#/components/schemas/A: ${msg}: A → B → A`,
		],
		[
			`"A":{"$ref":${s("B")},"description":"x"},"B":{"type":["string","null"]},"C":{"oneOf":[{"$ref":${s("A")}},{"allOf":[{"$ref":${s("C")}}]}]}`,
			`#/components/schemas/C: ${msg}: C → C`,
		],
	];
	for (const [body, message] of cases)
		assert.equal(error(schemas(body)).message, message, body);

	// TypeScript defers a reference inside an object, array or tuple type.
	const { code } = generate(
		schemas(
			`"Json":{"oneOf":[{"type":"string"},{"type":"array","items":{"$ref":${s("Json")}}},{"type":"object","additionalProperties":{"$ref":${s("Json")}}},{"prefixItems":[{"$ref":${s("Json")}}]}]}`,
		),
	);
	assert.match(code, /export type Json = string \| Json\[\] \| \{/);
});

test("error kinds and messages", () => {
	const json = error("{");
	assert.equal(json.kind, "json");
	assert.equal(json.message, "1:2: unexpected end of input");
	assert.equal(json.diag, undefined);

	// Input that does not start with `{` is YAML.
	const yaml = error("openapi: 3.1.0\npaths: [1\n");
	assert.equal(yaml.kind, "yaml");
	assert.match(yaml.message, /^\d+:\d+: \S/);
	assert.equal(yaml.diag, undefined);
	assert.match(
		generate("\u{FEFF} \t\r\n  openapi: 3.1.0\n").code,
		/export interface paths \{\}/,
	);

	const input = error('{"openapi":"2.0"}');
	assert.equal(input.kind, "input");
	assert.deepEqual(input.diag, {
		at: "#/openapi",
		msg: 'unsupported OpenAPI version "2.0" (3.0.x, 3.1.x or 3.2.x required)',
	});

	// Every kind is named GenerateError, which is what logs and String() show.
	for (const e of [json, yaml, input]) assert.equal(e.name, "GenerateError");
	assert.equal(String(json), "GenerateError: 1:2: unexpected end of input");
});

test("$refs within the document: pointers, anchors, ids; anything else is external", () => {
	const doc = (ref: string) =>
		`{"openapi":"3.1.0","components":{"schemas":{"S":{"$ref":${JSON.stringify(ref)}}},"x":{"$id":"urn:x","a":{"type":"string"}}}}`;
	const at = "#/components/schemas/S";
	assert.equal(
		error(doc("#missing")).message,
		`${at}: $ref target not found: #missing`,
	);
	assert.equal(
		error(doc("urn:x#/nope")).message,
		`${at}: $ref target not found: urn:x#/nope`,
	);
	assert.equal(
		error(doc("other.json#/a")).message,
		`${at}: external $ref, but the document's location is unknown: other.json#/a`,
	);
	assert.match(generate(doc("urn:x#/a")).code, /export type S = string;/);
	assert.match(
		generate(doc("urn:x")).code,
		/export type S = unknown;/,
		"the $id object has no schema keywords",
	);
});

test("external $refs are read through the source, relative to the file they are in", () => {
	const files: Record<string, string> = {
		"file:///api/openapi.json":
			'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"defs/a.json"}}}}',
		"file:///api/defs/a.json": '{"properties":{"b":{"$ref":"b.yaml#/B"}}}',
		"file:///api/defs/b.yaml": "B:\n  type: string\n",
	};
	const read: string[] = [];
	const source = {
		url: "file:///api/openapi.json",
		read: (url: string) => {
			read.push(url);
			const text = files[url];
			if (text === undefined) throw new Error("no such file");
			return text;
		},
	};
	const src = files[source.url] as string;
	assert.match(
		generate(src, source).code,
		/export type A = \{\n {2}b\?: B;\n\};\n\nexport type B = string;/,
	);
	assert.deepEqual(read, [
		"file:///api/defs/a.json",
		"file:///api/defs/b.yaml",
	]);

	// Each file is read once, however often it is referred to.
	read.length = 0;
	files["file:///api/openapi.json"] =
		'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"defs/a.json"},"C":{"$ref":"defs/a.json#/properties/b"}}}}';
	generate(files[source.url] as string, source);
	assert.deepEqual(read, [
		"file:///api/defs/a.json",
		"file:///api/defs/b.yaml",
	]);

	// A warning in another file is located in it.
	files["file:///api/openapi.json"] =
		'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"defs/m.yaml"}}}}';
	files["file:///api/defs/m.yaml"] = "<<: {}\ntype: string\n";
	assert.deepEqual(generate(files[source.url] as string, source).warnings, [
		{
			at: "defs/m.yaml#",
			msg: "<< merges mappings only in YAML 1.1; read as a key named <<",
		},
	]);

	// A document with no components.schemas, whose schemas are all in other files.
	files["file:///api/openapi.json"] =
		'{"openapi":"3.1.0","paths":{"/a":{"get":{"responses":{"200":{"description":"","content":{"application/json":{"schema":{"$ref":"defs/b.yaml#/B"}}}}}}}}}';
	assert.match(
		generate(files[source.url] as string, source).code,
		/"application\/json": B;/,
	);

	// A read failure names the file, relative to the document.
	files["file:///api/openapi.json"] =
		'{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"../shared/none.json"}}}}';
	assert.equal(
		error2(files[source.url] as string, source).message,
		"#/components/schemas/A: cannot read ../shared/none.json: no such file",
	);
});

test("readOnly reached through $refs inside another file resolves against that file", () => {
	const files: Record<string, string> = {
		"file:///api/openapi.yaml": [
			"openapi: 3.1.0",
			"components:",
			"  schemas:",
			"    A:",
			"      type: object",
			"      required: [id, name]",
			"      properties:",
			"        id: { $ref: 'defs/b.yaml#/X' }",
			"        name: { type: string }",
			"    B:",
			"      allOf: [{ $ref: 'defs/b.yaml#/Base' }]",
			"      required: [stamp]",
			"",
		].join("\n"),
		"file:///api/defs/b.yaml": [
			"X: { allOf: [{ $ref: '#/Y' }] }",
			"Y: { type: string, readOnly: true }",
			"Base: { allOf: [{ $ref: '#/Stamped' }] }",
			"Stamped: { properties: { stamp: { type: string, readOnly: true } } }",
			"",
		].join("\n"),
	};
	const source = {
		url: "file:///api/openapi.yaml",
		read: (url: string) => files[url] as string,
	};
	const code = generate(files[source.url] as string, source).code;
	assert.match(code, /export type AInput = \{\n {2}name: string;\n\};/);
	assert.match(
		code,
		/export type BInput = BaseInput & Record<string, unknown>;/,
	);
});

/** Like `error`, with a source for external $refs. */
function error2(
	src: string,
	source: { url: string; read: (url: string) => string },
): GenerateError {
	try {
		generate(src, source);
	} catch (e) {
		assert.ok(e instanceof GenerateError);
		return e;
	}
	assert.fail(`generated: ${src}`);
}

test("the YAML merge key is not YAML 1.2: it is a property named <<, with a warning", () => {
	const g = generate(
		"openapi: 3.1.0\ncomponents:\n  schemas:\n    B: &b { type: string }\n    A:\n      <<: *b\n      description: x\n",
	);
	assert.deepEqual(g.warnings, [
		{
			at: "#/components/schemas/A",
			msg: "<< merges mappings only in YAML 1.1; read as a key named <<",
		},
	]);
});

test("required in another allOf member does not bring a readOnly property back", () => {
	const src = schemas(
		[
			'"Stamped":{"properties":{"stamp":{"type":"string","readOnly":true}}}',
			'"Base":{"allOf":[{"$ref":"#/components/schemas/Stamped"}]}',
			'"B":{"allOf":[{"$ref":"#/components/schemas/Base"},{"type":"object","required":["stamp"]}]}',
			// The same, with the required member inside an allOf of its own.
			'"C":{"allOf":[{"$ref":"#/components/schemas/Base"},{"allOf":[{"type":"object","required":["stamp"]}]}]}',
		].join(","),
	);
	const { code } = generate(src);
	assert.match(
		code,
		/export type BInput = BaseInput & Record<string, unknown>;/,
	);
	assert.match(
		code,
		/export type CInput = BaseInput & Record<string, unknown>;/,
	);
});

test("in 3.0, keywords next to $ref are ignored without warnings", () => {
	const src =
		'{"openapi":"3.0.3","components":{"schemas":{"S":{"type":"string"},"R":{"$ref":"#/components/schemas/S","not":{}}}}}';
	assert.deepEqual(generate(src).warnings, []);
});

test("a warning raised in both views of a schema is reported once", () => {
	const src = schemas(
		`"S":{"type":"object","properties":{"id":{"type":"integer","readOnly":true},"x":{"not":{"type":"string"}}}}`,
	);
	assert.deepEqual(generate(src).warnings, [
		{
			at: "#/components/schemas/S/properties/x/not",
			msg: "not cannot be expressed in TypeScript; ignored",
		},
	]);
});

test("an operationId is declared once for the same operation, and is an error for another", () => {
	// A YAML alias is the node it names: the same operation, declared once.
	const aliased = generate(
		"openapi: 3.1.0\npaths:\n  /a: &a\n    get: { operationId: get, responses: {} }\n  /b: *a\n",
	).code;
	assert.equal(aliased.match(/^ {2}get: \{$/gm)?.length, 1, aliased);

	// Two Operation Objects are two operations, even written alike.
	const op = '{"get":{"operationId":"x","responses":{}}}';
	assert.equal(
		error(paths(`"/a":${op},"/b":${op}`)).message,
		`#/paths/~1b/get: operationId "x" is also #/paths/~1a/get's; OpenAPI requires it to be unique`,
	);

	// The same operation as a path's and a webhook's has two types, sent by either side.
	assert.equal(
		error(
			`{"openapi":"3.1.0","paths":{"/a":{"$ref":"#/components/pathItems/P"}},"webhooks":{"w":{"$ref":"#/components/pathItems/P"}},"components":{"pathItems":{"P":{"post":{"operationId":"p","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"id":{"type":"string","readOnly":true}}}}}}}}}}}`,
		).message,
		`#/webhooks/w/post: operation "p" is also #/paths/~1a/post, as a path's and a webhook's, whose types differ; operations["p"] has one type`,
	);
});

test("a YAML alias inside the node it names is an error", () => {
	assert.equal(
		error(
			"openapi: 3.1.0\ncomponents:\n  schemas:\n    A: &a\n      type: array\n      items: *a\n",
		).message,
		"#/components/schemas/A/items: alias *a is inside the node it names",
	);
});
