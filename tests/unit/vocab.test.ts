import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";
import { KEYWORDS } from "../../src/vocab.ts";

test("every keyword is classified once", () => {
	const names = KEYWORDS.map(([k]) => k);
	const repeated = names.filter((k, i) => names.indexOf(k) !== i);
	assert.deepEqual(repeated, []);
});

/** The modules that read schemas by their keywords (operation.ts and pointer.ts read OpenAPI fields too). */
const READERS = [
	"schema.ts",
	"kinds.ts",
	"keys.ts",
	"not.ts",
	"oneof.ts",
	"object.ts",
	"unevaluated.ts",
	"number.ts",
];

test("every keyword a schema reader names is classified", () => {
	const src = new URL("../../src/", import.meta.url);
	assert.deepEqual(
		READERS.filter((f) => !readdirSync(src).includes(f)),
		[],
		"the readers are there",
	);
	const known = new Set(KEYWORDS.map(([k]) => k));
	const named = new Set<string>();
	for (const file of READERS) {
		const text = readFileSync(new URL(file, src), "utf8");
		// `s.get("type")`, `get(s, "allOf")`, `count(v, "minItems")`, `unevaluated(v, "…")`.
		for (const m of text.matchAll(
			/(?:\.get|\.str|\bget|\bcount|\bunevaluated)\((?:\w+, )?"([^"]+)"\)/g,
		))
			named.add(m[1] as string);
	}
	assert.ok(named.size > 30, "the readers' keywords are found");
	assert.deepEqual(
		[...named].filter((k) => !known.has(k)),
		[],
	);
});
