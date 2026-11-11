// The one error type generation throws.

import type { Diag } from "./pointer.ts";

/**
 * A fatal input error. `kind` is `json` (not valid JSON), `yaml` (not valid YAML) or
 * `input` (the document cannot be converted: unsupported version, a `$ref` whose
 * target is missing or cannot be read, …). The message is
 * `location: message`, where the location is `line:col` or a JSON Pointer.
 */
export class GenerateError extends Error {
	// Also the name of the internal subclasses, which are GenerateErrors to the caller.
	override readonly name = "GenerateError";
	readonly kind: "json" | "yaml" | "input";
	/** The JSON Pointer and message, for `input` errors. */
	readonly diag?: Diag;

	constructor(kind: "json" | "yaml" | "input", message: string, diag?: Diag) {
		super(message);
		this.kind = kind;
		if (diag !== undefined) this.diag = diag;
	}
}
