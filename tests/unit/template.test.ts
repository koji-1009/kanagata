// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are TypeScript template literal types as printed, not JavaScript templates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { patternType, within } from "../../src/template.ts";
import type { Ty } from "../../src/ty.ts";

/** The type a pattern is, as printed: `string`, string literals and templates joined by ` | `. */
function printed(pattern: string): string | undefined {
	const t = patternType(pattern);
	if (t === undefined) return undefined;
	const members: Ty[] = t.kind === "union" ? t.items : [t];
	return members
		.map((m) => (m.kind === "string" ? "string" : (m as { text: string }).text))
		.join(" | ");
}

const DIGITS = '"0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"';

test("fixed text, anchored or not", () => {
	assert.equal(printed("^abc$"), '"abc"');
	assert.equal(printed("^abc"), "`abc${string}`");
	assert.equal(printed("abc$"), "`${string}abc`");
	assert.equal(printed("abc"), "`${string}abc${string}`");
	assert.equal(printed(""), "string", "any text is string");
	assert.equal(printed("^$"), '""');
});

test("alternatives have their own anchors; groups and their kinds", () => {
	assert.equal(printed("^a$|^b$"), '"a" | "b"');
	assert.equal(printed("^(?:a|b)c$"), '"ac" | "bc"');
	assert.equal(printed("^(?<n>a)$"), '"a"');
	assert.equal(printed("^()$"), '""');
	assert.equal(printed("^(?=a)"), undefined, "lookahead");
	assert.equal(printed("^(?!a)"), undefined, "negative lookahead");
	assert.equal(printed("(?<=a)b"), undefined, "lookbehind");
	assert.equal(printed("(?<!a)b"), undefined, "negative lookbehind");
	assert.equal(printed("a$b"), undefined, "$ before the end");
	assert.equal(printed("a^b"), undefined, "^ after the start");
	assert.equal(printed("^(a$)"), undefined, "$ in a group");
});

test("quantifiers: finite ones are written out, any text is ${string} beside other text and string alone", () => {
	assert.equal(printed("^ab?$"), '"a" | "ab"');
	assert.equal(printed("^ab??$"), '"a" | "ab"', "lazy");
	assert.equal(printed("^a{2}$"), '"aa"');
	assert.equal(printed("^a{1,2}?$"), '"a" | "aa"');
	assert.equal(printed("^a{2,}$"), undefined, "no upper bound");
	assert.equal(printed("^a*$"), undefined);
	assert.equal(printed("^a+$"), undefined);
	assert.equal(printed("^a[\\s\\S]*$"), "`a${string}`");
	assert.equal(
		printed("^a[\\s\\S]*?"),
		"`a${string}`",
		"any text twice is once",
	);
	assert.equal(printed("^[^]*z$"), "`${string}z`");
	assert.equal(printed("^[\\s\\S]*$"), "string", "any text alone is string");
	assert.equal(printed("[\\s\\S]*"), "string");
	assert.equal(
		printed("^a$|^[^]*$"),
		"string",
		"string admits the other alternatives",
	);
	assert.equal(printed("^[\\s\\S]+$"), undefined, "at least one character");
	assert.equal(printed("^[\\s\\S]?$"), undefined);
	assert.equal(printed("^[\\s\\S]{2}$"), undefined);
	assert.equal(printed("^a[\\s\\S]b$"), undefined, "one character");
	assert.equal(printed("^.*$"), undefined, ". leaves out line breaks");
});

test("escapes", () => {
	assert.equal(printed("^\\.\\/\\$\\^$"), '"./$^"');
	assert.equal(printed("^\\t\\n\\v\\f\\r$"), '"\\t\\n\\u000b\\f\\r"');
	assert.equal(printed("^\\0$"), '"\\u0000"');
	assert.equal(printed("^\\cJ$"), '"\\n"');
	assert.equal(printed("^\\x41\\u0042\\u{1F600}$"), '"AB😀"');
	assert.equal(printed("^\\d$"), `\`\${${DIGITS}}\``);
	assert.equal(printed("^\\w$")?.split(" | ").length, 63);
	assert.equal(printed("^\\s$")?.split(" | ").length, 25);
	assert.equal(printed("^\\D$"), undefined);
	assert.equal(printed("\\bword"), undefined, "word boundary");
	assert.equal(printed("\\Bword"), undefined);
	assert.equal(printed("^(a)\\1$"), undefined, "back reference");
	assert.equal(printed("^\\p{L}$"), undefined);
});

test("classes", () => {
	assert.equal(printed("^[ab]$"), '`${"a" | "b"}`');
	assert.equal(printed("^[a-c]$"), '`${"a" | "b" | "c"}`');
	assert.equal(printed("^[-a]$"), '`${"-" | "a"}`');
	assert.equal(printed("^[a-]$"), '`${"a" | "-"}`');
	assert.equal(printed("^[\\-\\]\\b]$"), '`${"-" | "]" | "\\b"}`');
	assert.equal(printed("^[\\d_]$"), `\`\${"_" | ${DIGITS}}\``);
	assert.equal(printed("^[\\D]$"), undefined, "a negated class escape alone");
	assert.equal(printed("^[\\w\\W]*$"), "string");
	assert.equal(printed("^[^a]$"), undefined, "a negated class");
	assert.equal(printed("^[^\\d]$"), undefined);
	assert.equal(printed("^[^/]*$"), undefined, "any number of a negated class");
	assert.equal(
		printed("^ab[\\s\\S\\u{10000}-\\u{286A0}]*$"),
		"`ab${string}`",
		"any character, a range of more characters than a union holds beside it",
	);
	assert.equal(
		printed("^[^\\u{0}-\\u{1869F}]$"),
		undefined,
		"a negated class with such a range",
	);
});

test("templates write text a template would read as a string", () => {
	assert.equal(printed("^`a"), '`${"`"}a${string}`');
	assert.equal(printed("^\\\\a"), '`${"\\\\"}a${string}`');
	assert.equal(printed("^\\$\\{a\\}"), '`${"$"}{a}${string}`');
	assert.equal(printed("^a\\nb"), '`a${"\\n"}b${string}`');
	assert.equal(printed("^[ab]c"), '`${"a" | "b"}c${string}`');
});

test("no more strings than TypeScript builds into a union", () => {
	assert.equal(
		printed("^\\d{4}$"),
		`\`\${${DIGITS}}\${${DIGITS}}\${${DIGITS}}\${${DIGITS}}\``,
	);
	assert.equal(printed("^\\d{5}$"), undefined, "100,000 in a quantifier");
	assert.equal(
		printed("^\\d\\d\\d\\d\\d$"),
		undefined,
		"100,000 in a sequence",
	);
	assert.equal(
		printed("^\\d{4}[0-8]$|^\\d{4}9$"),
		undefined,
		"100,000 in alternatives",
	);
	assert.equal(printed("^[a-z]{1,4}$"), undefined, "more than that in a range");
	assert.equal(
		printed("^[\\u{0}-\\u{1869E}]$")?.split(" | ").length,
		99_999,
		"a range of 99,999",
	);
	assert.equal(
		printed("^[\\u{0}-\\u{1869F}]$"),
		undefined,
		"a range of 100,000",
	);
	assert.equal(
		printed("^[\\u{0}-\\u{EA5F}\\u{10000}-\\u{1EA5F}]$"),
		undefined,
		"two ranges of 60,000",
	);
});

test("a pattern JavaScript cannot read is no type", () => {
	assert.equal(patternType("^(a"), undefined);
	assert.equal(patternType("^a{"), undefined);
	assert.equal(patternType("^\\-$"), undefined, "\\- outside a class");
});

test("the templates of a pattern whose strings another pattern all matches", () => {
	assert.deepEqual(within("^x-a", "^x-"), ["`x-a${string}`"]);
	assert.deepEqual(
		within("^x-[\\s\\S]*", "^x-"),
		["`x-${string}`"],
		"the same",
	);
	assert.deepEqual(within("^x-[ab]", "^x-[a-c]"), [
		'`x-${"a" | "b"}${string}`',
	]);
	assert.deepEqual(within("^x-", "^x-a"), [], "any text is not a");
	assert.deepEqual(within("^x-b", "^x-a"), []);
	assert.deepEqual(within("^x-", "-y$"), [], "some strings of both");
	assert.deepEqual(within("^x-", "^x-[\\s\\S]*z"), [], "z after any text");
	assert.deepEqual(
		within("^b$|^x-", "^[bx]"),
		["`x-${string}`"],
		"templates only, not the keys a pattern names",
	);
});

test("templates keep the pattern they are from", () => {
	assert.deepEqual(patternType("^a"), {
		kind: "template",
		text: "`a${string}`",
		pattern: "^a",
	});
});
