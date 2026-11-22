// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are TypeScript template literal types as printed, not JavaScript templates.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	admits,
	includes,
	matching,
	meet,
	patternType,
	relation,
	strings,
	type Template,
	templates,
} from "../../src/template.ts";
import { inter, lit, NEVER, type Ty } from "../../src/ty.ts";

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
	assert.equal(printed("^a[\\s\\S]{0,}$"), undefined, "{0,}, not *");
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

/** The one template of a pattern without alternatives. */
const one = (pattern: string): Template => templates(pattern)[0] as Template;

test("the templates of a pattern, one for each alternative", () => {
	assert.deepEqual(
		templates("^b$|^x-").map((t) => (t.key as { text: string }).text),
		['"b"', "`x-${string}`"],
	);
});

test("whether a template admits every string another does", () => {
	assert.equal(includes(one("^x-"), one("^x-a")), true);
	assert.equal(includes(one("^x-"), one("^x-[\\s\\S]*")), true, "the same");
	assert.equal(includes(one("^x-[a-c]"), one("^x-[ab]")), true);
	assert.equal(includes(one("^x-a"), one("^x-")), false, "any text is not a");
	assert.equal(includes(one("^x-a"), one("^x-b")), false);
	assert.equal(includes(one("^x-[\\s\\S]*z"), one("^x-")), false);
});

test("whether a template admits a string", () => {
	assert.equal(admits(one("^x-[\\s\\S]*-y$"), "x-a-y"), true);
	assert.equal(
		admits(one("^x-[\\s\\S]*-y$"), "x-y"),
		false,
		"not by the pattern",
	);
	assert.equal(admits(one("^x-[ab]$"), "x-b"), true);
});

test("how the strings of one template stand to another's", () => {
	const ab = one("^[ab]$");
	assert.equal(relation(one("^x-a"), one("^x-")), "within");
	assert.equal(relation(one("^x-"), one("^x-a")), "meets", "some of both");
	assert.equal(relation(one("^x-"), one("-y$")), "meets");
	assert.equal(relation(one("^x-"), one("^y-")), "apart");
	assert.equal(relation(ab, one("^[bc]$")), "meets");
	assert.equal(relation(ab, one("^[cd]$")), "apart");
	const abz = one("^[ab][\\s\\S]*z$");
	assert.equal(relation(abz, ab), "apart", "z after the one character");
	assert.equal(relation(ab, abz), "apart");
});

test("the strings of a template without any text", () => {
	assert.deepEqual(strings(one("^x-[ab]$")), ["x-a", "x-b"]);
	assert.equal(strings(one("^x-")), undefined, "any text");
});

/** The keys of the templates `meet` gives, as printed. */
function met(a: string, b: string): string[] | undefined {
	return meet(one(a), one(b))?.map((t) => (t.key as { text: string }).text);
}

test("the strings two templates admit, as templates", () => {
	assert.deepEqual(met("^x-", "-y$"), ['"x-y"', "`x-${string}-y`"]);
	assert.deepEqual(
		met("^x-a", "^x-"),
		["`x-a${string}`"],
		"one within the other",
	);
	assert.deepEqual(met("^x-", "^y-"), [], "none");
	assert.deepEqual(met("^[ab]", "^[bc]"), ["`b${string}`"]);
	assert.deepEqual(
		met("a", "b"),
		["`${string}a${string}b${string}`", "`${string}b${string}a${string}`"],
		"each order",
	);
	assert.deepEqual(met("^a$", "a"), ['"a"'], "text within any text");
	assert.equal(
		met(`a${"[\\s\\S]*a".repeat(6)}`, `b${"[\\s\\S]*b".repeat(6)}`),
		undefined,
		"too many ways to line them up",
	);
});

test("whether a pattern that is a regular expression matches all strings of a template", () => {
	assert.equal(matching("^[a-z-]+$", one("^x-[ab]$")), "within");
	assert.equal(matching("^[a-z-]+$", one("^x-")), "meets");
	assert.equal(matching("^[0-9]+$", one("^x-")), "apart");
	assert.equal(matching("^x-.+", one("^x-a")), "within", "anything after it");
	assert.equal(
		matching("^x-.+$", one("^x-a")),
		"meets",
		". is not a line break",
	);
	assert.equal(matching("^x-[\\s\\S]+", one("^x-a")), "within");
	assert.equal(matching("^(?:x-|y-)", one("^y-")), "within", "a group");
	assert.equal(matching("^(?<p>x)-", one("^x-")), "within", "a named group");
	assert.equal(matching("^x-a?b*c{0,2}d{0,}", one("^x-")), "within");
	assert.equal(matching("^x-a{2}", one("^x-aa")), "within");
	assert.equal(matching("^x-[^a]", one("^x-b")), "within", "a negated class");
	assert.equal(matching("^x-[^a]", one("^x-a")), "apart");
	assert.equal(matching("^x-\\D", one("^x-a")), "within");
	assert.equal(matching("^x-[\\d\\-]", one("^x-1")), "within");
	assert.equal(matching("^x-[0-9]", one("^x-1")), "within");
	assert.equal(matching("^x\\.y$", one("^x\\.y$")), "within", "an escape");
	assert.equal(matching("x$", one("^ax$")), "within", "anywhere");
	assert.equal(matching("x$", one("^ax")), "meets");
	assert.equal(matching("^a|b$", one("^a")), "within");
	assert.equal(matching("^(?=x)", one("^x")), undefined, "a lookahead");
	assert.equal(matching("\\bx", one("^x")), undefined, "a word boundary");
	assert.equal(matching("^(a$)", one("^a")), undefined, "$ in a group");
	assert.equal(matching("a$b", one("^a")), undefined, "$ before the end");
	assert.equal(matching("a^", one("^a")), undefined, "^ after the start");
	assert.equal(matching("^(a", one("^a")), undefined, "not a pattern");
	assert.equal(
		matching("^[a-z]{1,6000}$", one("^a")),
		undefined,
		"more states than read",
	);
	assert.equal(
		matching("^[ab]*a[ab]{14}$", one("^[\\s\\S]*$")),
		undefined,
		"more pairs of states than read",
	);
});

test("a template type admits the literals next to it by its own segments, one meet gives too", () => {
	const [, xy] = meet(one("^x-"), one("-y$")) as Template[];
	const t = (xy as Template).key;
	assert.equal((t as { text: string }).text, "`x-${string}-y`");
	assert.deepEqual(inter([t, lit('"x-a-y"')]), lit('"x-a-y"'));
	assert.equal(inter([t, lit('"x-a"')]), NEVER, "x-a is no string of it");
	assert.equal(inter([lit('"x-y"'), t]), NEVER, "nor x-y");
});

test("template types keep their segments", () => {
	assert.deepEqual(patternType("^a"), {
		kind: "template",
		text: "`a${string}`",
		seq: [{ set: ["a"] }, { any: true }],
	});
});
