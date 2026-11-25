// The ClickHouse statement splitter (`splitTerminalClauses`, `maskLiteralsAndComments`).
//
//   statements split        a statement built as body + SETTINGS + FORMAT comes apart into
//                           exactly those three, wherever the keywords also appear as
//                           identifiers, inside strings, comments or subqueries
//   masking keeps offsets   masked text has the input's length and line breaks, and
//                           masking it again changes nothing
//   any text is safe        no input makes either function throw
//
// These run on effect-prop (../../effect-prop), not fast-check: the statement
// generator is a grammar, and coverage-guided search (V8 coverage of the built
// library) steers it into the splitter's branches. A failure prints a
// `PROP_REPLAY` value; rerun with it set and `-t` naming the property.
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { maskLiteralsAndComments, splitTerminalClauses } from "@maple-dev/effect-orm/sql"
import { Gen, Prop, Search } from "../../effect-prop/src/index"
import { Coverage } from "../../effect-prop/src/node"
import { prop } from "../../effect-prop/src/vitest"
import { config, runCount } from "./harness"

// A statement as the parts the splitter must give back

interface Statement {
	readonly body: string
	readonly settings: string | undefined
	readonly format: string | undefined
	/** The whole statement as written. */
	readonly text: string
}

const KEYWORD_NAMES = ["format", "settings", "FORMAT", "Settings"] as const
/** A name where an operand is expected: there a terminal keyword is an ordinary identifier. */
const operandName = Gen.weighted([5, Gen.element("a", "b", "total", "x1", "t.a")], [2, Gen.elements(KEYWORD_NAMES)])
const plainName = Gen.element("a", "b", "total", "x1", "all")
const quotedName = Gen.map(Gen.tuple(Gen.element("`", '"'), Gen.elements(["a b", "format", "SETTINGS x = 1", "FORMAT JSON", "it's"])), ([quote, name]) => `${quote}${name}${quote}`)

/** Text for inside a literal or a comment: full of what the splitter looks for. */
const noise = Gen.map(
	Gen.array(Gen.element("FORMAT JSON", "SETTINGS a = 1", ";", "(", ")", "--", "/*", "x", " ", "format", "é", "`", '"'), { maxLength: 4 }),
	(parts) => parts.join(""),
)
const stringLiteral = Gen.gen(function* () {
	const text = yield* Gen.map(Gen.tuple(noise, Gen.element("", "'", "\\")), ([n, extra]) => n + extra)
	// ClickHouse takes both a doubled quote and a backslash escape.
	const doubled = yield* Gen.boolean
	return `'${text.replace(/\\/g, "\\\\").replace(/'/g, doubled ? "''" : "\\'")}'`
})
const number = Gen.map(Gen.int(0, 999), String)

const expression: Gen.Gen<string> = Gen.recursive<string>(
	Gen.weighted([4, operandName], [2, number], [2, stringLiteral], [1, quotedName]),
	(self) =>
		Gen.oneOf(
			Gen.map(Gen.tuple(self, Gen.element("+", "-", "*", "/", "=", "<", "AND", "OR", "||"), self), ([l, op, r]) => `${l} ${op} ${r}`),
			// A column named like a clause keyword, as a left operand only: ending a body,
			// `SELECT limit FORMAT JSON` really is ambiguous, and the splitter reads LIMIT.
			Gen.map(Gen.tuple(Gen.element("offset", "limit", "t.offset"), Gen.element("*", "+", "="), self), ([l, op, r]) => `${l} ${op} ${r}`),
			Gen.map(Gen.tuple(Gen.element("count", "format", "sum", "toString"), Gen.array(self, { maxLength: 2 })), ([fn, args]) => `${fn}(${args.join(", ")})`),
			Gen.map(self, (inner) => `(${inner})`),
			// A subquery may carry its own terminal clauses: they are not the statement's.
			Gen.map(Gen.tuple(self, Gen.element("", " SETTINGS max_threads = 1", " FORMAT JSON", " SETTINGS a = 1 FORMAT CSV")), ([inner, tail]) => `(SELECT ${inner} FROM t${tail})`),
			Gen.map(Gen.tuple(self, self), ([when, then]) => `CASE WHEN ${when} THEN ${then} ELSE ${when} END`),
		),
	{ maxDepth: 3, label: "expression" },
)

const comment = Gen.oneOf(Gen.map(noise, (n) => `/* ${n.replace(/\*\//g, "")} */`), Gen.map(noise, (n) => `-- ${n}\n`))
/** Between two tokens: whitespace, sometimes with a comment in it. */
const gap = Gen.weighted([6, Gen.constant(" ")], [1, Gen.element("\n", "\t", "  ")], [1, Gen.map(comment, (c) => ` ${c} `)])

const list = (item: Gen.Gen<string>, max: number): Gen.Gen<string> => Gen.map(Gen.array(item, { minLength: 1, maxLength: max }), (items) => items.join(", "))
const selectItem = Gen.oneOf(
	Gen.element("*", "t.*", "count(*)"),
	expression,
	Gen.map(Gen.tuple(expression, Gen.oneOf(plainName, Gen.elements(KEYWORD_NAMES))), ([e, alias]) => `${e} AS ${alias}`),
	// An alias with no AS: `a * format JSON` is a product named JSON, not a FORMAT clause.
	Gen.map(Gen.tuple(expression, Gen.element("x", "JSON", "CSV")), ([e, alias]) => `${e} ${alias}`),
)
const ordering = Gen.map(Gen.tuple(expression, Gen.element("", " ASC", " DESC", " DESC NULLS LAST")), ([e, direction]) => `${e}${direction}`)

const body = Gen.gen(function* () {
	const parts: Array<string> = [`SELECT${(yield* Gen.weightedBoolean(0.15)) ? " DISTINCT" : ""}`, yield* list(selectItem, 3)]
	if (yield* Gen.boolean) parts.push("FROM", yield* Gen.oneOf(plainName, Gen.elements(KEYWORD_NAMES), Gen.constant("db.t FINAL")))
	else if (yield* Gen.weightedBoolean(0.2)) parts.push("UNION ALL SELECT", yield* list(selectItem, 2))
	if (yield* Gen.weightedBoolean(0.3)) parts.push("WHERE", yield* expression)
	if (yield* Gen.weightedBoolean(0.3)) parts.push("GROUP BY", yield* Gen.oneOf(list(expression, 2), Gen.constant("ALL")))
	if (yield* Gen.weightedBoolean(0.3)) parts.push("ORDER BY", yield* Gen.oneOf(list(ordering, 2), Gen.constant("ALL")))
	if (yield* Gen.weightedBoolean(0.3)) parts.push("LIMIT", yield* number, ...((yield* Gen.boolean) ? ["OFFSET", yield* number] : []))
	let text = parts[0]!
	for (const part of parts.slice(1)) text += (yield* gap) + part
	return text
})

const settingsClause = Gen.map(
	list(Gen.map(Gen.tuple(Gen.element("max_threads", "format_csv_delimiter", "output_format_json_quote_64bit_integers", "a"), Gen.element(" = ", "=", " =\n"), Gen.oneOf(number, stringLiteral)), ([key, eq, value]) => `${key}${eq}${value}`), 3),
	(entries) => `SETTINGS ${entries}`,
)
const formatClause = Gen.map(Gen.element("JSON", "JSONEachRow", "CSV", "TabSeparated", "Null"), (name) => `FORMAT ${name}`)
const space = Gen.element(" ", "\n", "  ", "\t")

const statement: Gen.Gen<Statement> = Gen.gen(function* () {
	const select = yield* body
	const settings = yield* Gen.option(settingsClause)
	const format = yield* Gen.option(formatClause)
	// The grammar puts SETTINGS first; the other order is accepted too.
	const clauses = [settings, format].filter((clause) => clause !== undefined)
	if (clauses.length === 2 && (yield* Gen.weightedBoolean(0.25))) clauses.reverse()
	let text = select
	for (const clause of clauses) text += (yield* space) + clause
	if (yield* Gen.weightedBoolean(0.3)) text += `${yield* Gen.element("", " ", "\n")};${yield* Gen.element("", " ", "\n")}`
	return { body: select, settings, format, text }
})

/** Text with no grammar at all: every character the two functions treat specially. */
const anyText = Gen.string({ char: Gen.weighted([3, Gen.charOf("'\"`\\-/*;()\n ")], [2, Gen.charOf("FORMATSETINGSab1=,")], [1, Gen.unicodeChar]), maxLength: 40 })
/** The words the splitter looks for, in no order: characters alone almost never spell `FORMAT`. */
const anyWords = Gen.map(
	Gen.array(Gen.element("FORMAT", "SETTINGS", "format", "ALL", "BY", "SELECT", "*", "=", "JSON", "a", "1", "(", ")", ";", ",", ".", "'", "`", "--", "/*", "*/", "\n"), { maxLength: 14 }),
	(words) => words.join(" "),
)
const hostile = Gen.oneOf(anyText, anyWords, Gen.map(statement, (s) => s.text))

/** The built library, and not the `dist/` of any dependency. */
const library = new URL("../../dist/", import.meta.url).href
// Fixed bugs are pinned as `examples`, which do not depend on the generator, so no regression files.
const guided = { search: Search.coverage, layer: Coverage.layer({ include: (url) => url.startsWith(library) }), seed: config.seed, testTimeout: 120_000, regressions: false as const }

/** The last word or symbol of a body, comments and literals aside: what the clause keyword follows. */
const lastToken = (body: string): string => /([A-Za-z_]\w*|\S)\s*$/.exec(maskLiteralsAndComments(body))?.[1]?.toUpperCase() ?? "nothing"

/** Whether `part` can be made from `text` by dropping characters: the splitter only ever removes. */
const comesFrom = (part: string, text: string): boolean => {
	let at = 0
	for (const ch of part) {
		at = text.indexOf(ch, at) + 1
		if (at === 0) return false
	}
	return true
}

describe("terminal clauses", () => {
	prop(
		"a statement splits into the body, SETTINGS and FORMAT it was built from",
		statement,
		({ body: expected, settings, format, text }) =>
			Effect.gen(function* () {
				const split = splitTerminalClauses(text)
				const got = { body: split.body.trimEnd(), settings: split.settings, format: split.format }
				const want = { body: expected.trimEnd(), settings, format }
				// One assertion, many causes: group by what the clause keyword came after.
				yield* Prop.signature(`${got.body.length > want.body.length ? "clause left in the body" : "body cut short"} after ${lastToken(expected)}`)
				expect(got, text).toEqual(want)
			}),
		{
			...guided,
			runs: runCount(3000),
			format: (s) => JSON.stringify(s.text),
			// Found by this property: `ALL` and `*` were always read as wanting an operand.
			examples: [
				{ body: "SELECT * ORDER BY ALL", settings: undefined, format: "FORMAT JSON", text: "SELECT * ORDER BY ALL FORMAT JSON" },
				{ body: "SELECT a GROUP BY ALL", settings: "SETTINGS a = 1", format: undefined, text: "SELECT a GROUP BY ALL SETTINGS a = 1" },
				{ body: "SELECT *", settings: undefined, format: "FORMAT JSON", text: "SELECT * FORMAT JSON" },
				// And the first fix read `*` as the wildcard after any keyword-named column.
				{ body: "SELECT offset * format JSON", settings: undefined, format: undefined, text: "SELECT offset * format JSON" },
			],
		},
	)

	prop(
		"masking keeps every offset and line break, and is idempotent",
		hostile,
		(text) => {
			const masked = maskLiteralsAndComments(text)
			if (masked.length !== text.length) throw new Error(`length ${text.length} became ${masked.length}`)
			for (let i = 0; i < text.length; i++) {
				// A line break stays one wherever it is; anything else is kept or blanked.
				const kept = masked[i] === text[i] || (masked[i] === " " && text[i] !== "\n")
				if (!kept) throw new Error(`offset ${i}: ${JSON.stringify(text[i])} became ${JSON.stringify(masked[i])}`)
			}
			if (maskLiteralsAndComments(masked) !== masked) throw new Error(`masking twice differs: ${JSON.stringify(masked)}`)
		},
		// Found in review: a line break inside a quoted string was blanked.
		{ ...guided, runs: runCount(3000), format: (s) => JSON.stringify(s), examples: ["'a\nb'", "`a\\\nb`"] },
	)

	prop(
		"no text makes the splitter throw, and what it returns comes from the text",
		hostile,
		(text) => {
			const split = splitTerminalClauses(text)
			for (const part of [split.body, split.settings, split.format]) {
				if (part !== undefined && !comesFrom(part, text)) throw new Error(`${JSON.stringify(part)} is not part of the input`)
			}
		},
		{ ...guided, runs: runCount(3000), format: (s) => JSON.stringify(s) },
	)
})
