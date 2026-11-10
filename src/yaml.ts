// YAML → the same `Value` the JSON parser produces: key order kept, numbers as written.

import {
	isAlias,
	isMap,
	isSeq,
	LineCounter,
	parseDocument,
	type Scalar,
	type YAMLError,
} from "yaml";
import { GenerateError } from "./error.ts";
import { isJsonNumber, JsonNumber, JsonObject, type Value } from "./json.ts";
import { child, type Diag } from "./pointer.ts";

/**
 * Parses a YAML 1.2 document (core schema). Syntax errors throw a GenerateError of
 * kind `yaml` with `line:col`; a merge key `<<` is added to `warnings`.
 */
export function parseYaml(src: string, warnings: Diag[]): Value {
	const lineCounter = new LineCounter();
	const doc = parseDocument(src, { keepSourceTokens: true, lineCounter });
	const [error] = doc.errors;
	if (error !== undefined) {
		// With a LineCounter, every error has a position.
		const [start] = error.linePos as NonNullable<YAMLError["linePos"]>;
		throw new GenerateError(
			"yaml",
			`${start.line}:${start.col}: ${firstLine(error.message)}`,
		);
	}

	const convert = (node: unknown, at: string): Value => {
		// An alias is a copy of the node anchored with its name.
		if (isAlias(node)) return convert(node.resolve(doc), at);
		if (isMap(node))
			return new JsonObject(
				node.items.map(({ key, value }): [string, Value] => {
					const k = key as Scalar;
					const name = keyText(k);
					if (name === "<<" && k.type === "PLAIN")
						warnings.push({
							at,
							msg: "<< merges mappings only in YAML 1.1; read as a key named <<",
						});
					return [name, convert(value, child(at, name))];
				}),
			);
		if (isSeq(node))
			return node.items.map((item, i) => convert(item, child(at, String(i))));
		return scalar(node as Scalar);
	};
	return convert(doc.contents, "#");
}

/** The part of a yaml error message before its position and source excerpt. */
function firstLine(message: string): string {
	return (message.split("\n")[0] as string).replace(
		/ at line \d+, column \d+:?$/,
		"",
	);
}

/** The text a scalar was written as (`1.50`, not 1.5). */
function source(node: Scalar): string {
	return (node.srcToken as { source: string }).source;
}

/** Mapping keys are strings in JSON: a key written `200` or `true` is that text. */
function keyText(key: Scalar): string {
	return typeof key.value === "string" ? key.value : source(key);
}

/** Numbers keep the notation they are written in when it is a JSON number; YAML-only forms (0x1F, 0o17) become the number they mean. */
function scalar(node: Scalar): Value {
	const { value } = node;
	if (typeof value !== "number") return value as Value;
	const written = source(node);
	return new JsonNumber(isJsonNumber(written) ? written : String(value));
}
