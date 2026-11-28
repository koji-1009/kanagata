// Object types: properties, index signatures, the keys `propertyNames` admits, and counts.
//
// `properties` and `required` give the properties; a `patternProperties` pattern whose keys
// template literal types say gives index signatures by them, and other patterns and
// `additionalProperties` the index signature by any string. `propertyNames` keys the object
// by the strings it admits (`propertyKeys`); `minProperties` / `maxProperties` count the
// properties of a closed object (`counted`).

import { JsonObject, stringsIn, type Value } from "./json.ts";
import { closedKeys, forbid, valueKeys } from "./keys.ts";
import { widen } from "./kinds.ts";
import { accepts } from "./not.ts";
import { count, matches } from "./number.ts";
import { type Ctx, child } from "./pointer.ts";
import { type Reading, schema, schemaDoc } from "./schema.ts";
import {
	admits,
	includes,
	keyCount,
	matchesAll,
	meet,
	patternType,
	strings,
	type Template,
	templates,
	tooManyStrings,
} from "./template.ts";
import {
	admitsText,
	inter,
	type Keyed,
	MAX_KEYS,
	MAX_VALUES,
	manyNote,
	NEVER,
	neverProp,
	type Prop,
	present,
	RECORD,
	type Segment,
	STRING,
	type Ty,
	UNDEFINED,
	UNKNOWN,
	union,
} from "./ty.ts";
import { additional as additionalKeys } from "./unevaluated.ts";
import { asserted } from "./vocab.ts";

/** The note for keys of more strings than kanagata writes a union of. */
const MANY_KEYS = manyNote(MAX_VALUES, "keys", "typed by any string");

/** The note for index signatures by more keys than kanagata keys an object type by. */
const MANY_KEYED = manyNote(
	MAX_KEYS,
	"keys of index signatures",
	"typed by any string",
);

/**
 * The keys an object's `propertyNames` admits: every key is a string it must admit, so
 * they are the strings its schema admits, as the schema reads for strings (`string` for
 * any key, literals for keys it names, template literal types, `never` for none).
 * undefined without `propertyNames`, or where its strings are a type that is none of
 * these (an intersection TypeScript keeps, a reference to a schema being read).
 */
export function propertyKeys(
	cx: Ctx,
	v: JsonObject,
	at: string,
): Ty | undefined {
	const names = v.get("propertyNames");
	if (names === undefined) return undefined;
	// Reached again while it is read, it keys an object inside the value read, whose
	// strings that reading says; here it asks nothing more.
	if (cx.readsKeysOf(names)) return STRING;
	// Any string but some: those are no keys (see `object`).
	if (namesLeftOut(names) !== undefined) return STRING;
	// Its references are written out: a key is one of the strings their targets admit.
	const values = cx.withKeysRead(names, () =>
		cx.withRaw(undefined, () => schema(cx, names, child(at, "propertyNames"))),
	);
	return meetKeys(inter([STRING, values]));
}

/**
 * The keys a `propertyNames` of any string but some leaves out: `{ not: { enum: [id, type] } }`
 * or `{ not: { const: id } }`, with `type: string` at most beside it. undefined for any other.
 */
function namesLeftOut(names: Value): string[] | undefined {
	if (!(names instanceof JsonObject)) return undefined;
	const keys = asserted(names);
	const n = names.get("not");
	if (
		!keys.includes("not") ||
		!keys.every((k) => k === "not" || k === "type") ||
		(keys.includes("type") && names.get("type") !== "string") ||
		!(n instanceof JsonObject)
	)
		return undefined;
	const [only, ...more] = asserted(n);
	const listed =
		more.length > 0
			? undefined
			: only === "const"
				? [n.get("const")]
				: only === "enum"
					? n.get("enum")
					: undefined;
	return Array.isArray(listed) && listed.every((x) => typeof x === "string")
		? listed
		: undefined;
}

/**
 * What `propertyNames` says that TypeScript can, as parts of the schema beside its object
 * type, which reads its keys (`keys`, from `propertyKeys`): `false` admits no key; a
 * warning where it says more than its keys' type does.
 */
export function propertyNamesParts(
	cx: Ctx,
	v: JsonObject,
	at: string,
	keys: () => Ty | undefined,
): Ty[] {
	const names = v.get("propertyNames");
	if (names === false)
		return [widen(cx, v, ["object"], { kind: "map", props: [], index: NEVER })];
	// Reached again while it is read, it asks nothing more there (see `propertyKeys`): the
	// outer reading warns of what it cannot say.
	if (names === undefined || cx.readsKeysOf(names)) return [];
	// The keys are the strings it admits; a type of strings says the lengths only by the
	// keys it names (and `""`, and those of a template without any text), not by other
	// templates or `string`, nor a pattern no template says (one every string matches is
	// `string`, and asks nothing).
	const read = keys();
	// `true` has no keywords.
	const s = names instanceof JsonObject ? names : new JsonObject();
	const lengths = [
		...((count(s, "minLength") ?? 0) > 0 ? ["minLength"] : []),
		...(count(s, "maxLength") !== undefined ? ["maxLength"] : []),
	];
	const pattern = s.str("pattern");
	// A pattern of more strings than kanagata writes is noted where it is (see `noteSizes`).
	if (
		read === undefined ||
		(read.kind === "string" &&
			(lengths.length > 0 ||
				(pattern !== undefined &&
					patternType(pattern) === undefined &&
					!tooManyStrings(pattern))))
	)
		cx.warn(
			child(at, "propertyNames"),
			"propertyNames cannot be expressed in TypeScript; ignored",
		);
	else if (
		keyTerms(read).some(
			(k) => k.kind === "template" && strings(templateOf(k)) === undefined,
		)
	)
		for (const key of lengths)
			cx.warn(
				child(child(at, "propertyNames"), key),
				`${key} cannot be expressed in TypeScript; ignored`,
			);
	return [];
}

/**
 * A type of keys: where TypeScript keeps the strings as an intersection, of the templates of
 * patterns (`allOf: [{ pattern: "^x-" }, { pattern: "-y$" }]`), the strings all of them
 * admit, as templates (see `meet`): `"x-y" | `x-${string}-y``. undefined where those are
 * too many to read. They are no more strings than kanagata writes: about as many as the
 * combinations of the intersection, `MAX_COMBINATIONS` at most.
 */
function meetKeys(keys: Ty): Ty | undefined {
	if (keys.kind !== "inter") return keys;
	const [first, ...rest] = keys.items.map((item) =>
		keyTerms(item).map((t) =>
			templateOf(t as Extract<Ty, { kind: "template" }>),
		),
	);
	let met = first as Template[];
	for (const terms of rest) {
		const next: Template[] = [];
		for (const a of met)
			for (const b of terms) {
				const both = meet(a, b);
				if (!Array.isArray(both)) return undefined;
				next.push(...both);
			}
		met = next;
	}
	return union(met.map((t) => t.key));
}

/** The members of a type of keys: none for `never`. */
export function keyTerms(keys: Ty): Ty[] {
	return keys.kind === "union"
		? keys.items
		: keys.kind === "never"
			? []
			: [keys];
}

/** The keys a type of keys names one by one. */
export function keyLiterals(keys: Ty | undefined): string[] {
	return (keys === undefined ? [] : keyTerms(keys)).flatMap((k) =>
		k.kind === "lit" ? [JSON.parse(k.text) as string] : [],
	);
}

/**
 * Whether a `propertyNames` admits a key: as its keywords decide for the string, or, where
 * they say what that cannot decide, as the type of its keys says (`admitsText`).
 */
function keyAdmits(cx: Ctx, names: Value, keys: Ty): (key: string) => boolean {
	return (key) =>
		(names instanceof JsonObject ? accepts(cx, names, key) : undefined) ??
		admitsText(keys, key);
}

/** The template a template literal type of keys is, as `object` compares templates: its segments. */
function templateOf(t: Extract<Ty, { kind: "template" }>): Template {
	return { seq: t.seq, key: t };
}

/** Whether the keys `propertyNames` admits (`propertyKeys`) say which keys the object has, as the object type reads them. */
export function readsKeys(keys: Ty | undefined): boolean {
	return keys !== undefined && keys.kind !== "string";
}

/** A property being built, which `object` narrows before the type is made. */
type PropDraft = { -readonly [K in keyof Prop]: Prop[K] };

/** A pattern whose keys template literal types say, by one of its templates (`all`). */
interface KeyedPattern {
	readonly pattern: string;
	readonly all: readonly Template[];
	readonly t: Template;
	readonly ty: Ty;
}

/**
 * An object type being built (see `object`): its properties so far, which its steps add to
 * and narrow, and what the keys without a property schema are.
 */
interface Draft {
	readonly cx: Ctx;
	readonly v: JsonObject;
	/** The keys left out of this view (`leftOutGroup`). */
	readonly left: ReadonlySet<string>;
	readonly props: PropDraft[];
	/** The type of the other keys: `additionalProperties`, or the patterns' every key matches. */
	additional: Ty | undefined;
	/** Each `patternProperties` pattern, with its type. */
	readonly patterns: readonly (readonly [string, Ty])[];
	/**
	 * Keys no value is admitted for: absent, which an open object says; a closed one has no
	 * such key anyway (see `shut`).
	 */
	readonly absent: Set<string>;
	/** The patterns whose keys template literal types say, by template (see `sortPatterns`). */
	readonly keyed: KeyedPattern[];
	/** The patterns no template says. */
	readonly unwritten: { readonly pattern: string; readonly ty: Ty }[];
	/** The types of the patterns every key matches. */
	readonly everyKey: Ty[];
	/** The type of each of `keyed`'s index signatures (see `sortPatterns`). */
	exact: Ty[];
	/** Where the schema is, for notes. */
	readonly at: string;
}

/** The object type of a schema, whose conversion reads `read`. */
export function object(
	cx: Ctx,
	v: JsonObject,
	at: string,
	read: Pick<Reading, "left" | "keys">,
): Ty {
	// A multipart body's properties are its parts.
	const part = cx.here === "parts" ? "part" : undefined;
	const required = stringsIn(v.get("required"));
	const left = read.left();
	const props = declaredProps(cx, v, at, part, required, left);
	// A closed object admits only its declared properties, so requiring another admits nothing.
	const closed = closedKeys(v);
	if (closed !== undefined && required.some((n) => !closed.has(n)))
		return NEVER;
	// maxProperties 0 admits no keys: the empty object, or nothing if one is required.
	if (count(v, "maxProperties") === 0)
		return required.some((n) => !left.has(n))
			? NEVER
			: { kind: "map", props: [], index: NEVER };
	const d: Draft = {
		cx,
		v,
		left,
		props,
		additional: additionalType(cx, v, at, part),
		patterns: patternTypes(cx, v, at, part),
		absent: new Set(),
		keyed: [],
		unwritten: [],
		everyKey: [],
		exact: [],
		at,
	};
	// A property a pattern matches has both types.
	for (const p of props) {
		const matched = d.patterns
			.filter(([k]) => matches(k, p.key))
			.map(([, t]) => t);
		if (matched.length > 0) p.ty = inter([p.ty, ...matched]);
	}
	// The keys propertyNames leaves out of any string are none, as `properties: { k: false }` is.
	for (const name of namesLeftOut(v.get("propertyNames") as Value) ?? []) {
		if (required.includes(name)) return NEVER;
		const p = props.find((q) => q.key === name);
		if (p !== undefined) p.ty = NEVER;
		else props.push({ key: name, ty: NEVER, optional: true });
		d.absent.add(name);
	}
	// A required key without a property schema must be present, with that value.
	for (const name of required) {
		if (taken(d, name)) continue;
		const ty = keyValue(d, name);
		if (ty.kind === "never") return NEVER;
		props.push(present(name, ty));
	}
	sortPatterns(d);
	// propertyNames keys the object by the strings it admits (see `propertyKeys`); any
	// string asks nothing.
	const keys = read.keys();
	return keys !== undefined && keys.kind !== "string"
		? keyedObject(d, keys)
		: patternObject(d);
}

/** The properties `properties` declares, but those left out of this view (`left`). */
function declaredProps(
	cx: Ctx,
	v: JsonObject,
	at: string,
	part: "part" | undefined,
	required: readonly string[],
	left: ReadonlySet<string>,
): PropDraft[] {
	const declared = v.get("properties");
	const base = child(at, "properties");
	const props: PropDraft[] = [];
	for (const [key, s] of declared instanceof JsonObject
		? declared.entries
		: []) {
		if (left.has(key)) continue;
		const p: PropDraft = {
			key,
			ty: cx.withRaw(part, () => schema(cx, s, child(base, key))),
			optional: !required.includes(key),
		};
		if (!p.optional) p.present = true;
		const doc = schemaDoc(cx, s);
		if (doc !== undefined) p.doc = doc;
		props.push(p);
	}
	return props;
}

/** What `additionalProperties`, or `unevaluatedProperties` where it is that, says the other keys are. */
function additionalType(
	cx: Ctx,
	v: JsonObject,
	at: string,
	part: "part" | undefined,
): Ty | undefined {
	const extra = additionalKeys(v);
	if (extra === undefined) return undefined;
	if (extra.value === false) return NEVER;
	if (extra.value === true) return UNKNOWN;
	return cx.withRaw(part, () => schema(cx, extra.value, child(at, extra.key)));
}

/** Each `patternProperties` pattern, with its type. */
function patternTypes(
	cx: Ctx,
	v: JsonObject,
	at: string,
	part: "part" | undefined,
): (readonly [string, Ty])[] {
	const pp = v.get("patternProperties");
	if (!(pp instanceof JsonObject)) return [];
	return pp.entries.map(
		([key, s]) =>
			[
				key,
				cx.withRaw(part, () =>
					schema(cx, s, child(child(at, "patternProperties"), key)),
				),
			] as const,
	);
}

/** Whether the object has a property at this key already, or leaves the key out of this view. */
function taken(d: Draft, key: string): boolean {
	return d.left.has(key) || d.props.some((p) => p.key === key);
}

/**
 * The value of a key without a property schema: what the patterns it matches admit, or
 * else additionalProperties; any value without either.
 */
function keyValue(d: Draft, name: string): Ty {
	const matched = d.patterns
		.filter(([p]) => matches(p, name))
		.map(([, t]) => t);
	return matched.length > 0 ? inter(matched) : (d.additional ?? UNKNOWN);
}

/**
 * Adds an optional property a pattern or `propertyNames` names, where the object has none
 * at its key; a key no value is admitted for is absent (see `Draft.absent`).
 */
function named(d: Draft, name: string, ty: Ty): void {
	if (taken(d, name)) return;
	if (ty.kind === "never") d.absent.add(name);
	d.props.push({ key: name, ty, optional: true });
}

/**
 * Names the keys of a template without any text that `admits` admits (the lengths beside
 * a pattern, which the template does not carry, for `propertyNames`), each with the type
 * of every pattern that matches it: TypeScript keys no index signature by them.
 */
function nameAll(
	d: Draft,
	t: Template,
	admits: (key: string) => boolean,
): void {
	for (const key of strings(t) as string[])
		if (admits(key)) named(d, key, keyValue(d, key));
}

/**
 * Sorts the patterns by what says their keys. Keys a pattern matches have its type whatever
 * additionalProperties says. A pattern whose keys template literal types say keys index
 * signatures by them (`keyed`), and a key a template without any text names is a property;
 * a pattern every key matches leaves additionalProperties no key: its type is every other
 * key's; another pattern's type joins the index signature by any string (`unwritten`). A
 * key has the type of every signature that applies to it, as TypeScript reads them, and a
 * narrower one's type is within a wider one's, as TypeScript requires (`exact`).
 */
function sortPatterns(d: Draft): void {
	const keying = d.patterns.map(([pattern]) => {
		const keys = patternType(pattern);
		return keys === undefined || keys.kind === "string"
			? []
			: templates(pattern).filter((t) => strings(t) === undefined);
	});
	// Past the keys kanagata keys an object type by, no template says them.
	const over = keyTotal(keying.flat().map((t) => t.key)) > MAX_KEYS;
	if (over) d.cx.info(child(d.at, "patternProperties"), MANY_KEYED);
	for (const [i, [pattern, ty]] of d.patterns.entries()) {
		const keys = patternType(pattern);
		if (tooManyStrings(pattern))
			d.cx.info(child(child(d.at, "patternProperties"), pattern), MANY_KEYS);
		if (keys === undefined || (over && (keying[i] as Template[]).length > 0))
			d.unwritten.push({ pattern, ty });
		else if (keys.kind === "string") d.everyKey.push(ty);
		else {
			const all = templates(pattern);
			for (const t of all)
				if (strings(t) !== undefined) nameAll(d, t, () => true);
				else d.keyed.push({ pattern, all, t, ty });
		}
	}
	if (d.everyKey.length > 0) d.additional = inter(d.everyKey);
	d.exact = d.keyed.map((k) => inter(types(d, k.t)));
}

/**
 * The types of every pattern that matches all keys of a template: those of a template that
 * includes it, those of a pattern no template says where its machine says so (see
 * `matchesAll`), and those of a pattern of every key.
 */
function types(d: Draft, t: Template): Ty[] {
	return [
		...d.keyed
			.filter((k) => k.all.some((o) => includes(o, t)))
			.map((k) => k.ty),
		...d.unwritten.filter((u) => matchesAll(u.pattern, t)).map((u) => u.ty),
		...d.everyKey,
	];
}

const textOf = (key: Ty) => (key as { text: string }).text;

/** The keys template literal types make, each type once (see `MAX_KEYS`). */
function keyTotal(keys: readonly Ty[]): number {
	const each = new Map(keys.map((k) => [textOf(k), k]));
	let n = 0;
	for (const k of each.values()) n += keyCount(k as { seq: Segment[] });
	return n;
}

/**
 * Adds an index signature where none is by its key: patterns of the same template are one
 * index signature of both types, which `types` gives each of them.
 */
function signature(out: Keyed[], key: Ty, ty: Ty): void {
	if (!out.some((s) => textOf(s.key) === textOf(key))) out.push({ key, ty });
}

/** An index signature's type, which admits each property it applies to, `undefined` too for an optional one. */
function signatureType(
	d: Draft,
	ty: Ty,
	applies: (key: string) => boolean,
): Ty {
	const own = d.props.filter((p) => applies(p.key));
	return union([
		ty,
		...own.map((p) => p.ty),
		...(own.some((p) => p.optional) ? [UNDEFINED] : []),
	]);
}

/**
 * The keys the schemas that apply to the same value name, through it and the schemas it is
 * a member of, which its `propertyNames` does not admit: keys of the same object, which
 * cannot be there.
 */
function outside(d: Draft, admits: (key: string) => boolean): string[] {
	const { cx, v } = d;
	return [
		...new Set([v, ...cx.around].flatMap((s) => valueKeys(cx, s))),
	].filter(
		(k) => !d.left.has(k) && !admits(k) && !d.props.some((p) => p.key === k),
	);
}

/** The properties but the keys no value is admitted for (see `Draft.absent`). */
function kept(d: Draft): PropDraft[] {
	return d.props.filter((p) => !d.absent.has(p.key));
}

/**
 * A closed object of its properties but those no value is admitted for, without the keys
 * `propertyNames` does not admit (`outside`); one without properties it admits a value of
 * admits no key.
 */
function closedOver(d: Draft, admits: (key: string) => boolean): Ty {
	const props = kept(d);
	const none = props.every((p) => p.optional && p.ty.kind === "never");
	const t = counted(d.v, none ? [] : props);
	return t.kind === "map" ? t : forbid(t, outside(d, admits));
}

/**
 * The object type `propertyNames` keys by the strings it admits (`keys`): a property it
 * does not admit cannot be there, a key it names is a property with the value the patterns
 * or additionalProperties give it, and the others index signatures by its templates.
 */
function keyedObject(d: Draft, keys: Ty): Ty {
	const admits = keyAdmits(d.cx, d.v.get("propertyNames") as Value, keys);
	if (d.props.some((p) => !p.optional && !admits(p.key))) return NEVER;
	for (const p of d.props) if (!admits(p.key)) p.ty = NEVER;
	for (const name of keyLiterals(keys)) named(d, name, keyValue(d, name));
	const own = keyTerms(keys)
		.flatMap((k) => (k.kind === "template" ? [templateOf(k)] : []))
		.filter((t) => {
			if (strings(t) === undefined) return true;
			nameAll(d, t, admits);
			return false;
		});
	// Where it names every key, those are the properties: no other key is admitted.
	if (own.length === 0) return closedOver(d, admits);
	// A pattern's signature is by the keys propertyNames admits too: all of its own where
	// they are, else the keys each template of propertyNames shares with it, written as
	// templates (see `meet`). Where those are too many to read, or more strings than
	// kanagata writes, it stays.
	const signatures: Keyed[] = [];
	for (const [i, k] of d.keyed.entries()) {
		const both = own.some((n) => includes(n, k.t))
			? [k.t]
			: own.map((n) => meet(n, k.t));
		if (both.some((m) => m === "many"))
			d.cx.info(
				child(child(d.at, "patternProperties"), k.pattern),
				manyNote(MAX_VALUES, "keys", "typed by the pattern's keys"),
			);
		if (both.some((m) => m === undefined || m === "many"))
			signature(
				signatures,
				k.t.key,
				signatureType(d, d.exact[i] as Ty, within(k.t)),
			);
		else
			for (const t of (both as (Template | Template[])[]).flat())
				if (t === k.t)
					signature(
						signatures,
						t.key,
						signatureType(d, d.exact[i] as Ty, within(t)),
					);
				else if (strings(t) !== undefined) nameAll(d, t, admits);
				else
					signature(
						signatures,
						t.key,
						signatureType(d, inter(types(d, t)), within(t)),
					);
	}
	// A template whose keys a pattern's include has that pattern's signature, and one a
	// pattern of every key, or one no template says, matches has their types:
	// additionalProperties applies to none of them.
	const others = [
		...d.unwritten.map((u) => u.ty),
		...signatures.map((s) => s.ty),
		...d.props.map((p) => p.ty),
	];
	const out = [...signatures];
	for (const t of own) {
		if (d.keyed.some((k) => k.all.some((o) => includes(o, t)))) continue;
		const all = types(d, t);
		if (all.length === 0 && d.additional?.kind === "never") continue;
		const ty =
			all.length > 0 ? inter(all) : union([d.additional ?? UNKNOWN, ...others]);
		signature(out, t.key, signatureType(d, ty, within(t)));
	}
	if (out.length === 0) return closedOver(d, admits);
	const props = [...d.props, ...outside(d, admits).map(neverProp)];
	if (keyTotal(out.map((s) => s.key)) <= MAX_KEYS)
		return { kind: "map", props, keyed: out };
	// Past the keys kanagata keys an object type by, any key has their types.
	d.cx.info(child(d.at, "propertyNames"), MANY_KEYED);
	return {
		kind: "map",
		props,
		index: signatureType(d, union(out.map((s) => s.ty)), () => true),
	};
}

/** The object type of the properties, the patterns and additionalProperties. */
function patternObject(d: Draft): Ty {
	const { props, additional, unwritten } = d;
	const byPattern: Keyed[] = [];
	for (const [i, k] of d.keyed.entries())
		signature(
			byPattern,
			k.t.key,
			signatureType(d, d.exact[i] as Ty, within(k.t)),
		);
	if (additional === undefined) {
		if (byPattern.length === 0)
			return props.length === 0 ? RECORD : { kind: "object", props };
		// Without properties, other keys have any value, as for an object without either.
		return props.length === 0
			? { kind: "map", props, keyed: byPattern, index: UNKNOWN }
			: { kind: "map", props, keyed: byPattern };
	}
	// `additionalProperties: false` closes the object; TypeScript can only say so
	// when there are no properties at all, but its counts can say which are present.
	if (
		additional.kind === "never" &&
		byPattern.length === 0 &&
		unwritten.length === 0
	)
		return counted(d.v, kept(d));
	const index =
		additional.kind === "never" && unwritten.length === 0
			? undefined
			: signatureType(
					d,
					union([
						additional,
						...unwritten.map((u) => u.ty),
						...d.exact,
						...props.map((p) => p.ty),
					]),
					() => true,
				);
	return {
		kind: "map",
		props,
		...(byPattern.length === 0 ? {} : { keyed: byPattern }),
		...(index === undefined ? {} : { index }),
	};
}

/**
 * The properties a template's index signature applies to: those whose key it admits.
 * Outside `object`, which would make the closure on every call.
 */
const within = (t: Template) => (key: string) => admits(t, key);

/**
 * A closed object, its properties all it can have: `minProperties` requires that many
 * of them (a union over which), `maxProperties` leaves out the others.
 */
function counted(v: JsonObject, props: Prop[]): Ty {
	if (props.length === 0) return { kind: "map", props: [], index: NEVER };
	const optional = props.filter((p) => p.optional).map((p) => p.key);
	const required = props.length - optional.length;
	const min = count(v, "minProperties") ?? 0;
	const max = count(v, "maxProperties") ?? props.length;
	if (min > Math.min(max, props.length) || required > max) return NEVER;
	const variant = (f: (p: Prop) => Prop): Ty => ({
		kind: "object",
		props: props.map((p) => (p.optional ? f(p) : p)),
	});
	const parts: Ty[] = [];
	if (min > required)
		parts.push(
			union(
				subsets(optional, min - required).map((keys) =>
					variant((p) =>
						keys.includes(p.key) ? { ...p, optional: false, present: true } : p,
					),
				),
			),
		);
	if (max < props.length)
		parts.push(
			union(
				subsets(optional, max - required).map((keys) =>
					variant((p) => (keys.includes(p.key) ? p : { ...p, ty: NEVER })),
				),
			),
		);
	return parts.length === 0 ? { kind: "object", props } : inter(parts);
}

/** The subsets of `items` with `size` members, in order. */
function subsets<T>(items: T[], size: number): T[][] {
	if (size === 0) return [[]];
	return items.flatMap((item, i) =>
		subsets(items.slice(i + 1), size - 1).map((rest) => [item, ...rest]),
	);
}
