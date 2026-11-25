// In OpenAPI 3.0 the keywords next to a schema's `$ref` are ignored, all but `description`
// (docs/types.md). So keywords written next to every schema `$ref` of a 3.0 spec case, of
// each kind in turn, change neither its declarations nor its warnings.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { generate, type Options } from "../../src/index.ts";
import { JsonObject, parse, toJson, type Value } from "../../src/json.ts";
import { parseYaml } from "../../src/yaml.ts";

const SPEC = join(import.meta.dirname, "..", "spec");

/** Keywords written next to every schema `$ref`, one set at a time. */
const SIBLINGS = [
	'{"type":"string","format":"binary"}',
	'{"type":"integer","maximum":1,"exclusiveMaximum":true}',
	'{"type":"object","nullable":true}',
	'{"nullable":true}',
	'{"required":["zz"]}',
	'{"properties":{"zz":{"enum":["q"]}},"additionalProperties":false}',
	'{"enum":["zz"]}',
	'{"pattern":"^z","minLength":2}',
	'{"minItems":1,"items":{"type":"string"}}',
	'{"allOf":[{"required":["zz"]}]}',
	'{"readOnly":true}',
	'{"writeOnly":true}',
	'{"deprecated":true}',
].map((s) => parse(s) as JsonObject);

/** Where a value is: in the document, a schema, a map of names to schemas, or data. */
type Place = "document" | "schema" | "names" | "data";

/** Keywords whose values are data, not schemas. */
const DATA = new Set(["example", "examples", "default", "const", "enum"]);

/** Keywords whose values map names to schemas. */
const NAMES = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
]);

/** Where the member `key` of an object at `place` is. */
function placeOf(place: Place, key: string): Place {
	if (place === "names") return "schema";
	if (place === "document")
		return key === "schema" || key === "itemSchema"
			? "schema"
			: key === "schemas"
				? "names"
				: "document";
	return DATA.has(key) ? "data" : NAMES.has(key) ? "names" : "schema";
}

/** `v` with `extra` next to every schema `$ref` in it, counted in `count`. */
function inject(
	v: Value,
	place: Place,
	extra: JsonObject,
	count: { n: number },
): Value {
	if (place === "data") return v;
	if (Array.isArray(v)) return v.map((x) => inject(x, place, extra, count));
	if (!(v instanceof JsonObject)) return v;
	const entries = v.entries.map(([k, x]): [string, Value] => [
		k,
		inject(x, placeOf(place, k), extra, count),
	]);
	if (place === "schema" && typeof v.get("$ref") === "string") {
		count.n++;
		for (const e of extra.entries)
			if (v.get(e[0]) === undefined) entries.push(e);
	}
	return new JsonObject(entries);
}

/** A value as JSON text, numbers as written. */
function text(v: Value): string {
	if (Array.isArray(v)) return `[${v.map(text).join(",")}]`;
	if (v instanceof JsonObject)
		return `{${v.entries.map(([k, x]) => `${JSON.stringify(k)}:${text(x)}`).join(",")}}`;
	return toJson(v);
}

test("in 3.0, keywords next to a schema's $ref change no spec case's declarations or warnings", () => {
	let refs = 0;
	for (const name of readdirSync(SPEC).sort()) {
		const dir = join(SPEC, name);
		const file = ["input.json", "input.yaml"]
			.map((f) => join(dir, f))
			.find((f) => existsSync(f));
		if (file === undefined) continue;
		const src = readFileSync(file, "utf8");
		const doc = file.endsWith(".json") ? parse(src) : parseYaml(src, []);
		if (!String((doc as JsonObject).get("openapi")).startsWith("3.0."))
			continue;
		const optionsFile = join(dir, "options.json");
		const options: Options = existsSync(optionsFile)
			? JSON.parse(readFileSync(optionsFile, "utf8"))
			: {};
		const source = {
			url: pathToFileURL(file).href,
			read: (url: string) => readFileSync(fileURLToPath(url), "utf8"),
		};
		const expected = readFileSync(join(dir, "expected.d.ts"), "utf8");
		const warnFile = join(dir, "expected.warn");
		const warn = existsSync(warnFile) ? readFileSync(warnFile, "utf8") : "";
		for (const extra of SIBLINGS) {
			// With looseNullable, `nullable` next to `$ref` is read (docs/types.md).
			if (options.looseNullable && extra.get("nullable") !== undefined)
				continue;
			const count = { n: 0 };
			const injected = text(inject(doc, "document", extra, count));
			if (count.n === 0) break;
			refs += count.n;
			const g = generate(injected, source, options);
			const label = `${name} with ${text(extra)}`;
			assert.equal(g.code, expected, label);
			assert.equal(
				g.warnings.map((w) => `${w.at}: ${w.msg}\n`).join(""),
				warn,
				label,
			);
		}
	}
	assert.ok(refs > 0, "no schema $ref in the 3.0 spec cases");
});
