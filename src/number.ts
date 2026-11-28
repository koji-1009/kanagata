// Numbers: the values a schema's numeric keywords admit, read exactly.
//
// A JSON number is read as the decimal it writes (`digits` × 10^-`scale`), never as a
// float, so bounds and `multipleOf` compare exactly and count keywords are whole by their
// exact value. Bounds that admit finitely many values give their union of literals; the
// literals a schema lists are checked against its keywords for their kind (`admitting`).

import { JsonNumber, type JsonObject } from "./json.ts";
import type { Ctx } from "./pointer.ts";
import { regex } from "./template.ts";
import {
	INTEGER,
	isWholeText,
	lit,
	MAX_VALUES,
	NEVER,
	NUMBER,
	type Ty,
	valueKind,
} from "./ty.ts";

/**
 * `numeric`'s type for each schema object, read once: a schema is converted again for
 * each view and place it is reached from, and its values can be thousands.
 */
const numerics = new WeakMap<
	JsonObject,
	[number: Ty | undefined, integer: Ty | undefined]
>();

/** The schemas whose bounds admit more values than kanagata writes a union of (`MAX_VALUES`). */
const manyValues = new WeakSet<JsonObject>();

/** Whether a schema's bounds, read, admit more values than kanagata writes: its type is the kind. */
export const boundsTooWide = (v: JsonObject): boolean => manyValues.has(v);

/**
 * A number (an integer if `integer`), or the values its bounds admit where they are
 * finitely many: the integers, or the multiples of `multipleOf`, between them, up to
 * `MAX_VALUES` of them.
 */
export function numeric(cx: Ctx, v: JsonObject, integer: boolean): Ty {
	// A schema object is of one document, whose bounds read one way: as 3.0's or as 3.1's.
	let known = numerics.get(v);
	if (known === undefined) {
		known = [undefined, undefined];
		numerics.set(v, known);
	}
	const i = integer ? 1 : 0;
	let ty = known[i];
	if (ty === undefined) {
		ty = valuesBetween(cx, v, integer);
		known[i] = ty;
	}
	return ty;
}

function valuesBetween(cx: Ctx, v: JsonObject, integer: boolean): Ty {
	const { low, high } = bounds(cx, v);
	const any = integer ? INTEGER : NUMBER;
	if (low === undefined || high === undefined) return any;
	const order = compare(low.at, high.at);
	if (order > 0 || (order === 0 && (low.open || high.open))) return NEVER;
	const m = v.get("multipleOf");
	const step =
		m instanceof JsonNumber && decimal(m.text).digits > 0n
			? decimal(m.text)
			: undefined;
	if (!integer && step === undefined)
		return order === 0 ? lit(low.text) : NUMBER;
	// The values are the whole multiples of a unit: the step, or for integers the least
	// integer that is a multiple of it (1 without one).
	const unit: Decimal = !integer
		? (step as Decimal)
		: step === undefined
			? { digits: 1n, scale: 0 }
			: {
					digits: step.digits / gcd(step.digits, 10n ** BigInt(step.scale)),
					scale: 0,
				};
	// From the least multiple above low to the greatest below high.
	const above = (b: Bound) => {
		const [x, u] = aligned(b.at, unit);
		const q = x / u + (x % u > 0n ? 1n : 0n);
		return q + (b.open && x % u === 0n ? 1n : 0n);
	};
	const below = (b: Bound) => {
		const [x, u] = aligned(b.at, unit);
		const q = x / u - (x % u < 0n ? 1n : 0n);
		return q - (b.open && x % u === 0n ? 1n : 0n);
	};
	const first = above(low);
	const last = below(high);
	if (first > last) return NEVER;
	if (last - first >= BigInt(MAX_VALUES)) {
		manyValues.add(v);
		return any;
	}
	const values: Ty[] = [];
	for (let k = first; k <= last; k++) {
		const value = lit(
			unit.scale === 0
				? (k * unit.digits).toString()
				: decimalText({ digits: k * unit.digits, scale: unit.scale }),
		);
		boundedBy.set(value, v);
		values.push(value);
	}
	// Distinct literals in order are a union as it is.
	return values.length === 1
		? (values[0] as Ty)
		: { kind: "union", items: values };
}

/** The schema whose bounds each of `valuesBetween`'s values comes from: they admit it already. */
const boundedBy = new WeakMap<Ty, JsonObject>();

function gcd(a: bigint, b: bigint): bigint {
	return b === 0n ? a : gcd(b, a % b);
}

/** A decimal as JSON writes it: `-1.25`, `3`. */
function decimalText(d: Decimal): string {
	const sign = d.digits < 0n ? "-" : "";
	const digits = (d.digits < 0n ? -d.digits : d.digits)
		.toString()
		.padStart(d.scale + 1, "0");
	const int = digits.slice(0, digits.length - d.scale);
	const frac = digits.slice(digits.length - d.scale).replace(/0+$/, "");
	return `${sign}${int}${frac === "" ? "" : `.${frac}`}`;
}

/** A bound on numbers: its value, as written, and whether it is exclusive. */
interface Bound {
	at: Decimal;
	text: string;
	open: boolean;
}

/**
 * The tightest lower and upper bound. In 3.1 and 3.2 (JSON Schema 2020-12)
 * `exclusiveMinimum` / `exclusiveMaximum` are numbers; in 3.0 they are booleans that
 * make `minimum` / `maximum` exclusive.
 */
function bounds(cx: Ctx, v: JsonObject): { low?: Bound; high?: Bound } {
	const num = (key: string, open: boolean): Bound | undefined => {
		const n = v.get(key);
		return n instanceof JsonNumber
			? { at: decimal(n.text), text: n.text, open }
			: undefined;
	};
	const side = (inclusive: string, exclusive: string, sign: number) => {
		if (!cx.refSiblings) return num(inclusive, v.get(exclusive) === true);
		const closed = num(inclusive, false);
		const open = num(exclusive, true);
		if (open === undefined) return closed;
		// The exclusive one is tighter unless the inclusive one is past it.
		return closed !== undefined && compare(closed.at, open.at) * sign > 0
			? closed
			: open;
	};
	const low = side("minimum", "exclusiveMinimum", 1);
	const high = side("maximum", "exclusiveMaximum", -1);
	return {
		...(low === undefined ? {} : { low }),
		...(high === undefined ? {} : { high }),
	};
}

/**
 * Whether a literal is one of the values a schema's own keywords for its kind admit:
 * lengths and `pattern` for strings, bounds and `multipleOf` for numbers. A pattern
 * JavaScript cannot read admits every string. The keywords are read once, for the many
 * literals a schema can list.
 */
export function admitting(cx: Ctx, v: JsonObject): (t: Ty) => boolean {
	const minLength = count(v, "minLength") ?? 0;
	const maxLength = count(v, "maxLength");
	const pattern = v.str("pattern");
	const { low, high } = bounds(cx, v);
	const m = v.get("multipleOf");
	const step = m instanceof JsonNumber ? decimal(m.text) : undefined;
	// Without these keywords, every value is admitted: an enum's thousands are not looked at.
	if (
		minLength === 0 &&
		maxLength === undefined &&
		pattern === undefined &&
		low === undefined &&
		high === undefined &&
		step === undefined
	)
		return () => true;
	const beyond = (n: Decimal, b: Bound | undefined, sign: number) => {
		if (b === undefined) return false;
		const order = compare(n, b.at) * sign;
		return order < 0 || (order === 0 && b.open);
	};
	return (t) => {
		if (t.kind !== "lit" || boundedBy.get(t) === v) return true;
		const kind = valueKind(t);
		if (kind === "string") {
			const s = JSON.parse(t.text) as string;
			const length = [...s].length;
			if (length < minLength) return false;
			if (maxLength !== undefined && length > maxLength) return false;
			return pattern === undefined || matches(pattern, s);
		}
		if (kind === "boolean") return true;
		const n = decimal(t.text);
		if (beyond(n, low, 1) || beyond(n, high, -1)) return false;
		return step === undefined || isMultiple(n, step);
	};
}

/** Whether `s` matches an ECMA-262 pattern; true when JavaScript cannot read the pattern. */
export function matches(pattern: string, s: string): boolean {
	const re = regex(pattern);
	return re === null || re.test(s);
}

/** A JSON number exactly: `digits` × 10^-`scale`. */
interface Decimal {
	digits: bigint;
	scale: number;
}

function decimal(text: string): Decimal {
	// A JsonNumber's text is in JSON's grammar.
	const [, int = "", frac = "", exp = "0"] =
		/^(-?\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) as RegExpExecArray;
	const scale = frac.length - Number(exp);
	const digits = BigInt(int + frac);
	return scale >= 0
		? { digits, scale }
		: { digits: digits * 10n ** BigInt(-scale), scale: 0 };
}

/** a and b over one scale. */
function aligned(a: Decimal, b: Decimal): [bigint, bigint] {
	const scale = Math.max(a.scale, b.scale);
	return [
		a.digits * 10n ** BigInt(scale - a.scale),
		b.digits * 10n ** BigInt(scale - b.scale),
	];
}

function compare(a: Decimal, b: Decimal): number {
	const [x, y] = aligned(a, b);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether a is a whole multiple of m; a `multipleOf` that is not positive admits all. */
function isMultiple(a: Decimal, m: Decimal): boolean {
	const [x, y] = aligned(a, m);
	return y <= 0n || x % y === 0n;
}

/**
 * How many items a schema's `contains` asks to match: from `minContains` (1 if not given)
 * to `maxContains` (no bound if not given).
 */
export function containsBounds(s: JsonObject): {
	min: number;
	max: number | undefined;
} {
	return { min: count(s, "minContains") ?? 1, max: count(s, "maxContains") };
}

/** A count keyword (`minItems`, `maxItems`): a non-negative integer, or undefined. */
export function count(v: JsonObject, key: string): number | undefined {
	const n = v.get(key);
	// Whole by its exact value (`1e-400` is not), and one a JavaScript number holds.
	const value =
		n instanceof JsonNumber && isWholeText(n.text)
			? Number(n.text)
			: Number.NaN;
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}
