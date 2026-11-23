// Object types: properties, index signatures, the keys `propertyNames` admits, and counts.
//
// `properties` and `required` give the properties; a `patternProperties` pattern whose keys
// template literal types say gives index signatures by them, and other patterns and
// `additionalProperties` the index signature by any string. `propertyNames` keys the object
// by the strings it admits (`propertyKeys`); `minProperties` / `maxProperties` count the
// properties of a closed object (`counted`).

import { JsonObject, type Value } from "./json.ts";
import { closedKeys, forbid, leftOutKeys, valueKeys } from "./keys.ts";
import { accepts } from "./not.ts";
import { count, matches } from "./number.ts";
import { type Ctx, child } from "./pointer.ts";
import { schema, schemaDoc } from "./schema.ts";
import {
	admits,
	includes,
	matching,
	meet,
	patternType,
	strings,
	type Template,
	templates,
} from "./template.ts";
import {
	inter,
	type Keyed,
	NEVER,
	type Prop,
	prop,
	RECORD,
	STRING,
	type Ty,
	UNDEFINED,
	UNKNOWN,
	union,
} from "./ty.ts";
import { unevaluated } from "./unevaluated.ts";

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
	// Its references are written out: a key is one of the strings their targets admit.
	const values = cx.withKeysRead(names, () =>
		cx.withRaw(undefined, () => schema(cx, names, child(at, "propertyNames"))),
	);
	return meetKeys(inter([STRING, values]));
}

/**
 * A type of keys: where TypeScript keeps the strings as an intersection, of the templates of
 * patterns (`allOf: [{ pattern: "^x-" }, { pattern: "-y$" }]`), the strings all of them
 * admit, as templates (see `meet`): `"x-y" | `x-${string}-y``. undefined where those are
 * too many to read.
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
				if (both === undefined) return undefined;
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
 * they say what that cannot decide, as the type of its keys says (a literal by its text, a
 * template as `admits` reads it).
 */
function keyAdmits(cx: Ctx, names: Value, keys: Ty): (key: string) => boolean {
	return (key) =>
		(names instanceof JsonObject ? accepts(cx, names, key) : undefined) ??
		keyTerms(keys).some((k) =>
			k.kind === "lit"
				? k.text === JSON.stringify(key)
				: admits(templateOf(k as Extract<Ty, { kind: "template" }>), key),
		);
}

/** The template a template literal type of keys is, as `object` compares templates: its segments. */
function templateOf(t: Extract<Ty, { kind: "template" }>): Template {
	return { seq: t.seq, key: t };
}

/** Whether `propertyNames` says which keys the object has, as the object type reads it. */
export function readsKeys(cx: Ctx, v: JsonObject, at: string): boolean {
	const keys = propertyKeys(cx, v, at);
	return keys !== undefined && keys.kind !== "string";
}

export function object(cx: Ctx, v: JsonObject, at: string): Ty {
	// A multipart body's properties are its parts.
	const part = cx.here === "parts" ? "part" : undefined;
	const req = v.get("required");
	const required = Array.isArray(req)
		? req.filter((n) => typeof n === "string")
		: [];
	const declaredValue = v.get("properties");
	const declared =
		declaredValue instanceof JsonObject ? declaredValue.entries : [];
	const props: Prop[] = [];
	const base = child(at, "properties");
	const left = leftOutKeys(cx, v);
	for (const k of cx.leftOutIn(v)) left.add(k);
	for (const [key, s] of declared) {
		if (left.has(key)) continue;
		const p: Prop = {
			key,
			ty: cx.withRaw(part, () => schema(cx, s, child(base, key))),
			optional: !required.includes(key),
		};
		if (!p.optional) p.present = true;
		const d = schemaDoc(cx, s);
		if (d !== undefined) p.doc = d;
		props.push(p);
	}
	// A closed object admits only its declared properties, so requiring another admits nothing.
	const closed = closedKeys(v);
	if (closed !== undefined && required.some((n) => !closed.has(n)))
		return NEVER;
	// maxProperties 0 admits no keys: the empty object, or nothing if one is required.
	if (count(v, "maxProperties") === 0)
		return required.some((n) => !left.has(n))
			? NEVER
			: { kind: "map", props: [], index: NEVER };

	// unevaluatedProperties is additionalProperties where nothing else evaluates the rest.
	const apKey =
		v.get("additionalProperties") === undefined
			? "unevaluatedProperties"
			: "additionalProperties";
	const ap =
		apKey === "additionalProperties"
			? v.get(apKey)
			: unevaluated(v, "unevaluatedProperties");
	let additional: Ty | undefined;
	if (ap === false) additional = NEVER;
	else if (ap === true) additional = UNKNOWN;
	else if (ap !== undefined)
		additional = cx.withRaw(part, () => schema(cx, ap, child(at, apKey)));
	const pp = v.get("patternProperties");
	const patterns =
		pp instanceof JsonObject
			? pp.entries.map(
					([key, s]) =>
						[
							key,
							cx.withRaw(part, () =>
								schema(cx, s, child(child(at, "patternProperties"), key)),
							),
						] as const,
				)
			: [];

	// A property a pattern matches has both types.
	for (const p of props) {
		const matched = patterns
			.filter(([k]) => matches(k, p.key))
			.map(([, t]) => t);
		if (matched.length > 0) p.ty = inter([p.ty, ...matched]);
	}

	// The value of a key without a property schema: what the patterns it matches admit,
	// or else additionalProperties; any value without either.
	const keyValue = (name: string): Ty => {
		const matched = patterns
			.filter(([p]) => matches(p, name))
			.map(([, t]) => t);
		return matched.length > 0 ? inter(matched) : (additional ?? UNKNOWN);
	};

	// A required key without a property schema must be present, with that value.
	for (const name of required) {
		if (left.has(name) || props.some((p) => p.key === name)) continue;
		const ty = keyValue(name);
		if (ty.kind === "never") return NEVER;
		props.push({ ...prop(name, ty), present: true });
	}

	// The keys the schemas that apply to the same value name, through it and the schemas it
	// is a member of, are keys of the same object, which its propertyNames asks of too:
	// those it does not admit cannot be there.
	const outside = (admits: (key: string) => boolean): string[] =>
		[...new Set([v, ...cx.around].flatMap((s) => valueKeys(cx, s)))].filter(
			(k) => !left.has(k) && !admits(k) && !props.some((p) => p.key === k),
		);
	// A closed object of these properties without them; one without properties it admits
	// a value of admits no key.
	const closedOver = (admits: (key: string) => boolean, kept: Prop[]): Ty => {
		const none = kept.every((p) => p.optional && p.ty.kind === "never");
		const t = counted(v, none ? [] : kept);
		return t.kind === "map" ? t : forbid(t, outside(admits));
	};

	// Keys a pattern matches have its type whatever additionalProperties says. A pattern
	// whose keys template literal types say keys index signatures by them, and a key it
	// names is a property; another pattern's type joins the index signature by any string.
	// Patterns of the same template are one index signature of both types.
	const keyed: { pattern: string; all: Template[]; t: Template; ty: Ty }[] = [];
	const unwritten: { pattern: string; ty: Ty }[] = [];
	// A key no value is admitted for is absent, which an open object says; a closed one
	// has no such key anyway (see `shut`).
	const absent = new Set<string>();
	const named = (name: string, ty: Ty) => {
		if (left.has(name) || props.some((p) => p.key === name)) return;
		if (ty.kind === "never") absent.add(name);
		props.push({ key: name, ty, optional: true });
	};
	const shut = () =>
		counted(
			v,
			props.filter((p) => !absent.has(p.key)),
		);
	// A pattern every key matches leaves additionalProperties no key: its type is every other key's.
	const everyKey: Ty[] = [];
	// A template without any text names its keys, as a literal does: TypeScript keys no
	// index signature by them. Each has the type of every pattern that matches it.
	const name = (t: Template) => {
		for (const key of strings(t) as string[]) named(key, keyValue(key));
	};
	for (const [pattern, ty] of patterns) {
		const keys = patternType(pattern);
		if (keys === undefined) unwritten.push({ pattern, ty });
		else if (keys.kind === "string") everyKey.push(ty);
		else {
			const all = templates(pattern);
			for (const t of all)
				if (strings(t) !== undefined) name(t);
				else keyed.push({ pattern, all, t, ty });
		}
	}
	if (everyKey.length > 0) additional = inter(everyKey);
	// The types of every pattern that matches all keys of a template: those of a template
	// that includes it, those of a pattern no template says where its machine says so (see
	// `matching`), and those of a pattern of every key.
	const types = (t: Template): Ty[] => [
		...keyed.filter((k) => k.all.some((o) => includes(o, t))).map((k) => k.ty),
		...unwritten
			.filter((u) => matching(u.pattern, t) === "within")
			.map((u) => u.ty),
		...everyKey,
	];
	const textOf = (key: Ty) => (key as { text: string }).text;
	// Patterns of the same template are one index signature of both types, which `types`
	// gives each of them.
	const signature = (out: Keyed[], key: Ty, ty: Ty): void => {
		if (!out.some((s) => textOf(s.key) === textOf(key))) out.push({ key, ty });
	};
	// A key has the type of every signature that applies to it, as TypeScript reads them, and
	// a narrower one's type is within a wider one's, as TypeScript requires.
	const exact = keyed.map((k) => inter(types(k.t)));
	// An index signature admits each property it applies to, `undefined` too for an optional one.
	const admitting = (ty: Ty, applies: (key: string) => boolean): Ty => {
		const own = props.filter((p) => applies(p.key));
		return union([
			ty,
			...own.map((p) => p.ty),
			...(own.some((p) => p.optional) ? [UNDEFINED] : []),
		]);
	};
	// Read once the properties are all there.
	const keyedSignatures = (): Keyed[] => {
		const out: Keyed[] = [];
		for (const [i, k] of keyed.entries())
			signature(out, k.t.key, admitting(exact[i] as Ty, within(k.t)));
		return out;
	};
	const allTypes = (): Ty[] => [
		...unwritten.map((u) => u.ty),
		...exact,
		...props.map((p) => p.ty),
	];

	// propertyNames keys the object by the strings it admits (see `propertyKeys`): a
	// property it does not admit cannot be there, a key it names is a property with the
	// value the patterns or additionalProperties give it, and the others index signatures
	// by its templates. Any string asks nothing.
	const keys = propertyKeys(cx, v, at);
	if (keys !== undefined && keys.kind !== "string") {
		const admits = keyAdmits(cx, v.get("propertyNames") as Value, keys);
		if (props.some((p) => !p.optional && !admits(p.key))) return NEVER;
		for (const p of props) if (!admits(p.key)) p.ty = NEVER;
		// The keys a template without any text names that its keywords admit (the lengths
		// beside a pattern, which the template does not carry).
		const nameAdmitted = (t: Template) => {
			for (const key of strings(t) as string[])
				if (admits(key)) named(key, keyValue(key));
		};
		for (const name of keyLiterals(keys)) named(name, keyValue(name));
		const own = keyTerms(keys)
			.flatMap((k) => (k.kind === "template" ? [templateOf(k)] : []))
			.filter((t) => {
				if (strings(t) === undefined) return true;
				nameAdmitted(t);
				return false;
			});
		// The object without the keys it names that no value is admitted for (see `shut`).
		const kept = () => props.filter((p) => !absent.has(p.key));
		// Where it names every key, those are the properties: no other key is admitted.
		if (own.length === 0) return closedOver(admits, kept());
		// A pattern's signature is by the keys propertyNames admits too: all of its own
		// where they are, else the keys each template of propertyNames shares with it,
		// written as templates (see `meet`). Where those are too many to read, it stays.
		const signatures: Keyed[] = [];
		for (const [i, k] of keyed.entries()) {
			const both = own.some((n) => includes(n, k.t))
				? [k.t]
				: own.map((n) => meet(n, k.t));
			if (both.some((m) => m === undefined))
				signature(signatures, k.t.key, admitting(exact[i] as Ty, within(k.t)));
			else
				for (const t of (both as (Template | Template[])[]).flat())
					if (t === k.t)
						signature(signatures, t.key, admitting(exact[i] as Ty, within(t)));
					else if (strings(t) !== undefined) nameAdmitted(t);
					else
						signature(signatures, t.key, admitting(inter(types(t)), within(t)));
		}
		// A template whose keys a pattern's include has that pattern's signature, and one a
		// pattern of every key, or one no template says, matches has their types:
		// additionalProperties applies to none of them.
		const others = [
			...unwritten.map((u) => u.ty),
			...signatures.map((s) => s.ty),
			...props.map((p) => p.ty),
		];
		const out = [...signatures];
		for (const t of own) {
			if (keyed.some((k) => k.all.some((o) => includes(o, t)))) continue;
			const all = types(t);
			if (all.length === 0 && additional?.kind === "never") continue;
			const ty =
				all.length > 0 ? inter(all) : union([additional ?? UNKNOWN, ...others]);
			signature(out, t.key, admitting(ty, within(t)));
		}
		if (out.length === 0) return closedOver(admits, kept());
		const forbidden = outside(admits).map((key) => ({
			key,
			ty: NEVER,
			optional: true,
		}));
		return { kind: "map", props: [...props, ...forbidden], keyed: out };
	}

	const byPattern = keyedSignatures();
	const everyType = allTypes();

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
		return shut();
	const index =
		additional.kind === "never" && unwritten.length === 0
			? undefined
			: admitting(union([additional, ...everyType]), () => true);
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
	const present = props.length - optional.length;
	const min = count(v, "minProperties") ?? 0;
	const max = count(v, "maxProperties") ?? props.length;
	if (min > Math.min(max, props.length) || present > max) return NEVER;
	const variant = (f: (p: Prop) => Prop): Ty => ({
		kind: "object",
		props: props.map((p) => (p.optional ? f(p) : p)),
	});
	const parts: Ty[] = [];
	if (min > present)
		parts.push(
			union(
				subsets(optional, min - present).map((keys) =>
					variant((p) =>
						keys.includes(p.key) ? { ...p, optional: false, present: true } : p,
					),
				),
			),
		);
	if (max < props.length)
		parts.push(
			union(
				subsets(optional, max - present).map((keys) =>
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
