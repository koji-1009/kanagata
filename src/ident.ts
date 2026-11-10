// Identifier rules for property keys and generated type names.

/**
 * Names a schema type must not take: the global types the output refers to. A type
 * name starts with an upper-case letter or `_` (see `typeNames`), so it can never be
 * a type keyword (`string`, `never`, …) or a generated declaration (`paths`, …).
 */
const RESERVED = ["Blob", "Record"];

/** Whether `s` can be written as a property key without quotes. Reserved words are fine as property names. */
export function isIdent(s: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/** Whether `s` is a canonical non-negative integer that can be a numeric key (`200`). */
export function isNumericKey(s: string): boolean {
	return s.length <= 15 && /^(0|[1-9][0-9]*)$/.test(s);
}

/** Letters and digits that may appear in an identifier (`²` is a digit but may not). */
const WORD = /^[\p{Alphabetic}\p{N}]$/u;
const ID_CONTINUE = /^\p{ID_Continue}$/u;

/**
 * Converts a schema name to PascalCase. Characters that are not letters or digits
 * allowed in an identifier separate words; the first letter of each word is
 * upper-cased, the rest kept.
 */
export function pascalCase(s: string): string {
	let out = "";
	let upper = true;
	for (const c of s) {
		if (WORD.test(c) && ID_CONTINUE.test(c)) {
			out += upper ? c.toUpperCase() : c;
			upper = false;
		} else {
			upper = true;
		}
	}
	return out;
}

/**
 * Assigns a unique TypeScript type name to every schema.
 *
 * The name is the PascalCase form of the schema name; one that is empty or starts
 * with a digit gets a `_` prefix. Every schema whose name is free takes it first,
 * in input order; the others then get the smallest numeric suffix (from 2) that
 * is still free. So `User2` keeps its name even if `user` and `User` come first.
 */
export function typeNames(schemas: readonly string[]): string[] {
	const bases = schemas.map((s) => {
		const base = pascalCase(s);
		// A name must start with a letter: digits (of any script) and an empty name get `_`.
		return /^\p{ID_Start}/u.test(base) ? base : `_${base}`;
	});
	return claim(bases, new Set(RESERVED));
}

/**
 * Names for the write views of schemas: `<name>Input`, or the smallest numeric
 * suffix that is free when another declaration already has that name.
 */
export function inputNames(
	names: readonly string[],
	taken: readonly string[],
): string[] {
	return claim(
		names.map((n) => `${n}Input`),
		new Set([...RESERVED, ...taken]),
	);
}

/** Free names first, in order; the others get the smallest free numeric suffix from 2. */
function claim(bases: readonly string[], taken: Set<string>): string[] {
	const names = bases.map((base) => {
		if (taken.has(base)) return undefined;
		taken.add(base);
		return base;
	});
	return names.map((name, i) => {
		if (name !== undefined) return name;
		let n = 2;
		while (taken.has(`${bases[i]}${n}`)) n++;
		const unique = `${bases[i]}${n}`;
		taken.add(unique);
		return unique;
	});
}
