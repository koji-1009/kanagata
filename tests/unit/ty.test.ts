import assert from "node:assert/strict";
import { test } from "node:test";
import {
	array,
	BOOLEAN,
	INTEGER,
	inter,
	lit,
	NEVER,
	NULL,
	NUMBER,
	object,
	prop,
	RECORD,
	ref,
	STRING,
	type Ty,
	tuple,
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

test("union keeps intersection members", () => {
	const i = inter([schemaRef("A"), schemaRef("B")]);
	assert.deepEqual(union([i, NULL]), { kind: "union", items: [i, NULL] });
});
