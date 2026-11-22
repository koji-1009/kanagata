import assert from "node:assert/strict";
import { test } from "node:test";
import {
	array,
	BOOLEAN,
	equal,
	INTEGER,
	inter,
	lit,
	NEVER,
	NULL,
	NUMBER,
	object,
	opRef,
	type Prop,
	prop,
	RECORD,
	ref,
	STRING,
	type Ty,
	tuple,
	UNDEFINED,
	UNKNOWN,
	union,
} from "../../src/ty.ts";

const schemaRef = (schema: string) => ref(schema);

test("type keywords narrow sets of values", () => {
	const ab = union([lit('"a"'), lit("1"), lit("true"), NULL]);
	assert.deepEqual(inter([STRING, ab]), lit('"a"'));
	assert.deepEqual(inter([ab, union([NUMBER, NULL])]), union([lit("1"), NULL]));
	assert.deepEqual(inter([BOOLEAN, ab]), lit("true"));
	assert.equal(inter([STRING, lit("1")]), NEVER, "no value of that kind");
	const obj = object([prop("a", lit("1"))]);
	assert.deepEqual(inter([RECORD, obj]), obj);
	assert.deepEqual(
		inter([array(UNKNOWN), tuple([lit("1")])]),
		tuple([lit("1")]),
	);
	assert.equal(inter([array(UNKNOWN), obj]), NEVER);
	// every kind type must allow the value
	assert.deepEqual(inter([union([STRING, NUMBER]), STRING, ab]), lit('"a"'));
	// sets narrowed to the same values are one (normalizing again changes nothing)
	assert.deepEqual(inter([lit('"a"'), ab, STRING]), lit('"a"'));
	// kind types meet: what every one of them allows (integer within number)
	assert.equal(inter([INTEGER, NUMBER]), INTEGER);
	assert.equal(inter([NUMBER, INTEGER]), INTEGER, "in either order");
	assert.equal(inter([STRING, INTEGER]), NEVER);
	assert.equal(inter([union([STRING, NULL]), STRING]), STRING);
	assert.equal(inter([STRING, NUMBER]), NEVER);
	assert.deepEqual(
		inter([
			union([STRING, NUMBER, NULL]),
			union([NUMBER, NULL]),
			union([INTEGER, STRING]),
		]),
		INTEGER,
	);
	assert.deepEqual(inter([union([RECORD, NULL]), RECORD]), RECORD);
	// sets of values meet each other, numbers by value
	assert.deepEqual(
		inter([lit('"a"'), union([lit('"a"'), lit('"b"')])]),
		lit('"a"'),
	);
	assert.equal(inter([lit('"a"'), lit('"b"')]), NEVER);
	assert.deepEqual(inter([union([lit("1"), lit("2")]), lit("1.0")]), lit("1"));
	assert.deepEqual(inter([union([lit("0"), NULL]), NULL]), NULL);
	// zero is one value, whatever its sign or notation
	assert.deepEqual(inter([union([lit("0"), lit("1")]), lit("-0.0")]), lit("0"));
	assert.deepEqual(
		inter([union([lit("-0"), lit("2")]), lit("0e5")]),
		lit("-0"),
	);
	assert.deepEqual(
		inter([
			union([lit('"a"'), lit('"b"'), lit("1")]),
			union([lit('"b"'), lit('"c"'), lit("2")]),
			STRING,
		]),
		lit('"b"'),
	);
	// a value is kept only if every kind type allows it
	assert.equal(inter([NULL, STRING]), NEVER);
	// other parts stay
	const a = schemaRef("A");
	assert.deepEqual(inter([STRING, ab, a]), {
		kind: "inter",
		items: [lit('"a"'), a],
	});
});

test("narrowing leaves other intersections alone", () => {
	const a = schemaRef("A");
	assert.deepEqual(inter([STRING, a]), { kind: "inter", items: [STRING, a] });
	assert.deepEqual(inter([lit('"a"'), a]), {
		kind: "inter",
		items: [lit('"a"'), a],
	});
	assert.deepEqual(inter([STRING, union([lit('"a"'), a])]), {
		kind: "inter",
		items: [STRING, union([lit('"a"'), a])],
	});
});

test("arrays and tuples meet item by item", () => {
	assert.deepEqual(
		inter([array(STRING), tuple([union([lit('"a"'), lit("1")])])]),
		tuple([lit('"a"')]),
	);
	// a required item no value meets admits nothing
	assert.equal(inter([array(STRING), tuple([lit("1")])]), NEVER);
	// an optional one only shortens the tuple
	assert.deepEqual(
		inter([
			array(STRING),
			{ kind: "tuple", items: [STRING, lit("1")], min: 1 },
		]),
		{ kind: "tuple", items: [STRING, NEVER], min: 1 },
	);
});

test("a union drops the members another member rules out by kind", () => {
	const a = object([prop("a", STRING)]);
	const cat = schemaRef("Cat");
	assert.deepEqual(inter([a, union([cat, STRING])]), {
		kind: "inter",
		items: [a, cat],
	});
	// integer is a number
	assert.equal(inter([INTEGER, union([a, NUMBER])]), INTEGER);
	assert.equal(inter([NUMBER, union([a, INTEGER])]), INTEGER);
	// a member whose kind is not plain stays
	assert.deepEqual(inter([a, union([cat, NULL])]), {
		kind: "inter",
		items: [a, cat],
	});
});

test("union flattens and removes duplicates", () => {
	const t = union([STRING, union([NULL, NUMBER]), NULL, STRING]);
	assert.deepEqual(t, { kind: "union", items: [STRING, NULL, NUMBER] });
});

test("union keeps tuples that differ in their items, minimum or rest", () => {
	const items = [tuple([STRING]), tuple([NUMBER])];
	assert.deepEqual(union(items), { kind: "union", items });
	const optional: Ty = { kind: "tuple", items: [STRING], min: 0 };
	assert.deepEqual(union([tuple([STRING]), optional]), {
		kind: "union",
		items: [tuple([STRING]), optional],
	});
	const rest: Ty = { kind: "tuple", items: [STRING], min: 1, rest: NUMBER };
	const otherRest: Ty = {
		kind: "tuple",
		items: [STRING],
		min: 1,
		rest: STRING,
	};
	assert.deepEqual(union([tuple([STRING]), rest, otherRest]), {
		kind: "union",
		items: [tuple([STRING]), rest, otherRest],
	});
	assert.deepEqual(union([rest, tuple([STRING])]), {
		kind: "union",
		items: [rest, tuple([STRING])],
	});
	assert.equal(union([rest, { ...rest }]), rest, "equal tuples are one");
});

test("union keeps references to the two views of a schema apart", () => {
	const views = [ref("A"), ref("A", "write")];
	assert.deepEqual(union(views), { kind: "union", items: views });
});

test("union drops never and absorbs unknown", () => {
	assert.equal(union([NEVER, STRING]), STRING);
	assert.equal(union([STRING, UNKNOWN]), UNKNOWN);
	assert.equal(union([]), NEVER);
	assert.equal(union([NEVER]), NEVER);
});

test("a union drops literals its primitive members already admit", () => {
	assert.equal(union([STRING, lit('""')]), STRING);
	assert.deepEqual(union([lit('""'), NUMBER, lit("1"), lit("true")]), {
		kind: "union",
		items: [lit('""'), NUMBER, lit("true")],
	});
	assert.equal(union([lit("true"), BOOLEAN, lit("false")]), BOOLEAN);
});

test("a union drops the object and array types Record and unknown[] admit", () => {
	const a = object([prop("a", STRING)]);
	const closed: Ty = { kind: "map", props: [], index: NEVER };
	assert.equal(union([a, closed, RECORD]), RECORD);
	assert.deepEqual(union([tuple([STRING]), array(STRING), array(UNKNOWN)]), {
		kind: "array",
		elem: UNKNOWN,
	});
	assert.deepEqual(union([a, array(UNKNOWN)]), {
		kind: "union",
		items: [a, array(UNKNOWN)],
	});
});

test("unions of one member of each kind meet kind by kind", () => {
	const a = object([prop("a", STRING)]);
	assert.deepEqual(
		inter([union([a, lit('""')]), union([lit('""'), RECORD])]),
		union([a, lit('""')]),
	);
	// A member of no one kind, two of one kind, or many members leave them as they are.
	const refOrNull = union([schemaRef("A"), NULL]);
	assert.equal(inter([refOrNull, union([STRING, NULL])]).kind, "inter");
	const twoObjects = union([
		inter([schemaRef("A"), a]),
		inter([schemaRef("B"), object([prop("b", STRING)])]),
		NULL,
	]);
	assert.equal(inter([twoObjects, union([RECORD, NULL])]).kind, "inter");
	const many = union([
		...["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => lit(`"${s}"`)),
		schemaRef("A"),
	]);
	assert.equal(inter([many, union([STRING, schemaRef("B")])]).kind, "inter");
});

test("union of a single member", () => {
	assert.deepEqual(union([lit("1")]), lit("1"));
	assert.deepEqual(union([lit("1"), lit("1")]), lit("1"));
});

test("intersection flattens and removes duplicates", () => {
	const a = schemaRef("A");
	const b = schemaRef("B");
	assert.deepEqual(inter([a, inter([b, a]), UNKNOWN]), {
		kind: "inter",
		items: [a, b],
	});
});

test("intersection with never and unknown", () => {
	assert.equal(inter([STRING, NEVER]), NEVER);
	assert.equal(inter([UNKNOWN, STRING]), STRING);
	assert.equal(inter([]), UNKNOWN);
});

test("operation references are equal by their operation", () => {
	assert.equal(equal(opRef("a"), opRef("a")), true);
	assert.equal(equal(opRef("a"), opRef("b")), false);
	const both = [opRef("a"), opRef("b")];
	assert.deepEqual(union(both), { kind: "union", items: both });
	assert.equal(union([opRef("a"), opRef("a")]).kind, "opRef");
});

test("union keeps intersection members", () => {
	const i = inter([schemaRef("A"), schemaRef("B")]);
	assert.deepEqual(union([i, NULL]), { kind: "union", items: [i, NULL] });
});

test("union keeps members that differ in structure and removes equal ones", () => {
	const field = (p: Partial<Prop>): Ty =>
		object([{ key: "a,b", ty: STRING, optional: true, ...p }]);
	const differing: Ty[] = [
		field({}),
		field({ optional: false }),
		field({ present: true }),
		field({ doc: "x" }),
		field({ ty: NUMBER }),
		field({ key: "a" }),
		{ kind: "map", props: [], index: STRING },
		{ kind: "map", props: [], index: NUMBER },
		array(STRING),
		array(tuple([STRING])),
		inter([schemaRef("A"), schemaRef("B")]),
	];
	assert.deepEqual(union(differing), { kind: "union", items: differing });
	const copies = differing.map((t) => ({ ...t }));
	assert.deepEqual(union([...differing, ...copies]), {
		kind: "union",
		items: differing,
	});
	// Many members, literals and others, are told apart the same.
	const many = Array.from({ length: 20 }, (_, i) => [
		lit(String(i)),
		tuple([lit(String(i))]),
	]).flat();
	const again = many.map((t) => ({ ...t }));
	assert.deepEqual(union([...many, ...again]), { kind: "union", items: many });
});

test("many members are told apart by their keys as one by one, every kind", () => {
	const id = prop("id", STRING);
	const name = prop("name", STRING);
	const x: Ty = { kind: "template", text: "`x-a`" };
	const distinctOnes: Ty[] = [
		lit('"a"'),
		{ kind: "template", text: "`t`" },
		ref("A"),
		ref("A", "write"),
		opRef("x"),
		opRef("y"),
		NULL,
		UNDEFINED,
		object([id, name]),
		object([id]),
		object([]),
		object([
			{ key: "id", ty: STRING, optional: true, present: true, doc: "An id" },
		]),
		{ kind: "map", props: [], index: NEVER },
		{ kind: "map", props: [], keyed: [{ key: x, ty: STRING }] },
		{
			kind: "map",
			props: [id, name],
			index: STRING,
			keyed: [{ key: x, ty: NUMBER }],
		},
		array(STRING),
		{ kind: "tuple", items: [STRING], min: 1, rest: NUMBER },
		{ kind: "inter", items: [schemaRef("B"), object([id])] },
		tuple([union([lit('"x"'), lit('"y"')])]),
		lit("1"),
	];
	const equalOnes: Ty[] = [
		object([name, id]),
		{
			kind: "map",
			props: [name, id],
			index: STRING,
			keyed: [{ key: x, ty: NUMBER }],
		},
		{ kind: "inter", items: [object([id]), schemaRef("B")] },
		tuple([{ kind: "union", items: [lit('"y"'), lit('"x"')] }]),
		...distinctOnes.map((t) => ({ ...t })),
	];
	assert.deepEqual(union([...distinctOnes, ...equalOnes]), {
		kind: "union",
		items: distinctOnes,
	});
});

test("an object type's properties, a map's signatures and the members of a union or intersection are sets: the first order stays", () => {
	const ab = object([prop("id", STRING), prop("name", STRING)]);
	const ba = object([prop("name", STRING), prop("id", STRING)]);
	assert.equal(union([ab, ba]), ab);
	const lookup = schemaRef("Lookup");
	const first: Ty = { kind: "inter", items: [lookup, ab] };
	assert.equal(union([first, { kind: "inter", items: [ba, lookup] }]), first);
	const x: Ty = { kind: "template", text: "`x-a`" };
	const y: Ty = { kind: "template", text: "`y-a`" };
	const map: Ty = {
		kind: "map",
		props: [prop("id", STRING), prop("name", STRING)],
		keyed: [
			{ key: x, ty: STRING },
			{ key: y, ty: NUMBER },
		],
	};
	const reordered: Ty = {
		kind: "map",
		props: [prop("name", STRING), prop("id", STRING)],
		keyed: [
			{ key: y, ty: NUMBER },
			{ key: x, ty: STRING },
		],
	};
	assert.equal(union([map, reordered]), map);
	const xy = object([prop("a", union([lit('"x"'), lit('"y"')]))]);
	const yx = object([prop("a", union([lit('"y"'), lit('"x"')]))]);
	assert.equal(union([xy, yx]), xy);
});

test("members compared one by one read properties and members in any order", () => {
	const p = (key: string, ty: Ty = STRING) => prop(key, ty);
	const two = (a: Ty, b: Ty) => union([a, b]);
	const isOne = (a: Ty, b: Ty) => assert.equal(two(a, b), a);
	const areTwo = (a: Ty, b: Ty) =>
		assert.deepEqual(two(a, b), { kind: "union", items: [a, b] });
	// Another property at a key, a key the other lacks, a key one lacks past others out of order.
	areTwo(object([p("a"), p("b")]), object([p("a", NUMBER), p("b")]));
	areTwo(object([p("a"), p("b")]), object([p("c"), p("b")]));
	areTwo(object([p("a"), p("b"), p("c")]), object([p("b"), p("a"), p("d")]));
	areTwo(object([p("a"), p("b")]), object([p("b", NUMBER), p("a")]));
	isOne(object([p("a"), p("b"), p("c")]), object([p("c"), p("b"), p("a")]));
	// Unions inside, few members and many, in another order or with another member.
	const lits = (n: number, from = 0) =>
		Array.from({ length: n }, (_, i) => lit(String(i + from)));
	const many = union(lits(20));
	isOne(tuple([many]), tuple([{ kind: "union", items: lits(20).reverse() }]));
	areTwo(tuple([many]), tuple([union(lits(20, 1))]));
	const swapped = [lit("1"), lit("0"), ...lits(17, 2), lit("99")];
	areTwo(tuple([many]), tuple([{ kind: "union", items: swapped }]));
	const few = union(lits(3));
	isOne(tuple([few]), tuple([{ kind: "union", items: lits(3).reverse() }]));
	areTwo(tuple([few]), tuple([union(lits(3, 1))]));
	areTwo(tuple([few]), tuple([union(lits(4))]));
	const fewSwapped: Ty = {
		kind: "union",
		items: [lit("1"), lit("0"), lit("5")],
	};
	areTwo(tuple([few]), tuple([fewSwapped]));
});
