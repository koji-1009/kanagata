import assert from "node:assert/strict";
import { test } from "node:test";
import {
	escapeToken,
	get,
	JsonNumber,
	JsonObject,
	ParseError,
	parse,
	pointer,
	str,
	unescapeToken,
	type Value,
} from "../../src/json.ts";

const n = (text: string) => new JsonNumber(text);
const obj = (...entries: [string, Value][]) => new JsonObject(entries);

/** Line and column of the parse error for `src`. */
function err(src: string): [number, number] {
	const e = parseError(src);
	return [e.line, e.col];
}

function parseError(src: string): ParseError {
	try {
		parse(src);
	} catch (e) {
		assert.ok(e instanceof ParseError);
		return e;
	}
	assert.fail(`parsed: ${src}`);
}

/** A JSON `\u` escape, built at run time so the source never contains one. */
const esc = (hex: string) => `\\u${hex}`;

test("all value kinds", () => {
	const v = parse(
		'{"n":null,"t":true,"f":false,"i":1,"s":"x","a":[1,"y"],"o":{}}',
	);
	assert.deepEqual(
		v,
		obj(
			["n", null],
			["t", true],
			["f", false],
			["i", n("1")],
			["s", "x"],
			["a", [n("1"), "y"]],
			["o", obj()],
		),
	);
});

test("keeps key order, including integer-like keys", () => {
	const v = parse('{"b":1,"200":2,"a":3,"0":4}') as JsonObject;
	assert.deepEqual(
		v.entries.map(([k]) => k),
		["b", "200", "a", "0"],
	);
});

test("a key repeated in an object is an error at the repeat, as in YAML", () => {
	assert.throws(() => parse('{"a":1,\n "b":2, "a":3}'), {
		message: '2:9: duplicate key "a"',
	});
	// The same key in different objects is fine.
	assert.equal((parse('{"a":{"a":1}}') as JsonObject).entries.length, 1);
});

test("string escapes", () => {
	const v = parse(
		`"\\" \\\\ \\/ \\b \\f \\n \\r \\t ${esc("00e9")} ${esc("3042")}"`,
	);
	assert.equal(v, '" \\ / \b \f \n \r \t é あ');
});

test("surrogate pair", () => {
	assert.equal(parse(`"${esc("d83d")}${esc("de00")}"`), "\u{1F600}");
	assert.equal(parse(`"${esc("D83D")}${esc("DE00")}"`), "\u{1F600}");
});

test("invalid escapes", () => {
	let e = parseError('"\\q"');
	assert.deepEqual([e.col, e.msg], [2, "invalid escape sequence"]);
	e = parseError('"\\');
	assert.deepEqual([e.col, e.msg], [3, "unexpected end of input in string"]);
});

test("syntax errors", () => {
	const cases: [string, [number, number], string][] = [
		["", [1, 1], "unexpected end of input"],
		["   ", [1, 4], "unexpected end of input"],
		["[", [1, 2], "unexpected end of input"],
		["{1:2}", [1, 2], 'unexpected character "1"'],
		['{"a" 1}', [1, 6], "expected ':'"],
		['{"a"', [1, 5], "unexpected end of input"],
		['{"a":1 "b":2}', [1, 8], "expected ',' or '}'"],
		['{"a":1', [1, 7], "unexpected end of input"],
		["[1 2]", [1, 4], "expected ',' or ']'"],
		['"abc', [1, 5], "unexpected end of input in string"],
		["tru", [1, 1], 'unexpected character "t"'],
		["@", [1, 1], 'unexpected character "@"'],
		["[1,\n  2,\n]", [3, 1], "trailing comma"],
		// errors inside nested values propagate unchanged
		['{"a":tru}', [1, 6], 'unexpected character "t"'],
		['{"\\q":1}', [1, 3], "invalid escape sequence"],
		['["\\q"]', [1, 3], "invalid escape sequence"],
		["[[1,]]", [1, 5], "trailing comma"],
	];
	for (const [src, [line, col], msg] of cases) {
		const e = parseError(src);
		assert.deepEqual(
			[e.line, e.col, e.msg],
			[line, col, msg],
			JSON.stringify(src),
		);
	}
});

test("error message", () => {
	assert.equal(parseError("[1,]").message, "1:4: trailing comma");
});

test("byte order mark is skipped", () => {
	assert.deepEqual(parse("\u{FEFF}{}"), obj());
});

test("accessors", () => {
	const v = parse('{"s":"x","n":1}');
	assert.equal(str(v, "s"), "x");
	assert.equal(str(v, "n"), undefined);
	assert.equal(str(v, "missing"), undefined);
	assert.equal(str(null, "s"), undefined);
	assert.equal(get(null, "s"), undefined);
	assert.deepEqual(get(v, "n"), n("1"));
});

test("pointer into a scalar or with bad syntax", () => {
	const v = parse('{"a":1,"l":[true]}');
	assert.equal(pointer(v, "#/a/b"), undefined);
	assert.equal(pointer(v, "#a"), undefined);
	assert.equal(pointer(v, "#/l/x"), undefined);
	assert.equal(pointer(v, "#/l/"), undefined);
	assert.equal(pointer(v, "#/l/0"), true);
	assert.equal(pointer(v, "#/l/5"), undefined); // out of range
});

test("number notation is kept", () => {
	for (const text of [
		"-0",
		"1.50",
		"1e10",
		"-1.25E-3",
		"0",
		"12345678901234567890",
		"1e+2",
	]) {
		assert.deepEqual(parse(text), n(text), text);
	}
});

test("invalid numbers", () => {
	for (const text of ["01", "1.", ".5", "-", "1e", "+1", "-a"]) {
		assert.throws(() => parse(text), ParseError, text);
	}
});

test("raw control character", () => {
	assert.deepEqual(err('"a\tb"'), [1, 3]);
	assert.deepEqual(err('"a\nb"'), [1, 3]);
});

test("columns count characters, not UTF-16 units", () => {
	assert.deepEqual(err('"あ" x'), [1, 5]);
	assert.deepEqual(err('"\u{1F600}" x'), [1, 5]);
});

test("trailing garbage", () => {
	assert.deepEqual(err("{} x"), [1, 4]);
});

test("pointer unescaping", () => {
	const v = parse('{"a/b":{"c~d":{"e/f":[10,20]}}}');
	assert.deepEqual(pointer(v, "#/a~1b/c~0d/e%2Ff/1"), n("20"));
	assert.deepEqual(pointer(v, "/a~1b/c~0d/e~1f/0"), n("10"));
	assert.equal(pointer(v, "#"), v);
	assert.equal(pointer(v, "#/missing"), undefined);
	assert.equal(pointer(v, "#/a~1b/c~0d/e~1f/01"), undefined);
});

test("pointer with percent-encoded UTF-8", () => {
	const v = parse('{"{id}":1,"é":2}');
	assert.deepEqual(pointer(v, "#/%7Bid%7D"), n("1"));
	assert.deepEqual(pointer(v, "#/%C3%A9"), n("2"));
});

test("escape token round trip", () => {
	assert.equal(escapeToken("/users/{id}"), "~1users~1{id}");
	assert.equal(escapeToken("a~b"), "a~0b");
	assert.equal(unescapeToken("~01"), "~1");
});
