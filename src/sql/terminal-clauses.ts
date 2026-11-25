// Terminal clauses of a ClickHouse statement: `SETTINGS` and `FORMAT`.
//
// Both are statement *terminators* — legal only at the very end of a top-level
// statement, never inside a subquery. Anything that rewrites a statement (adding
// a settings clause, nesting a query inside `SELECT * FROM (…)`, picking a wire
// format) has to know where the body ends and the terminal clauses begin, and a
// trailing-anchored regex gets that wrong the moment two clauses are present or
// the keyword also appears as an identifier.

/**
 * Blank out comments and string/identifier literals, preserving every offset so
 * matches against the masked text index the original.
 *
 * Newlines survive so line-oriented checks still work.
 */
export function maskLiteralsAndComments(sql: string): string {
	return maskSql(sql)
}

const maskSql = (sql: string, markLiterals = false): string => {
	let out = ""
	let i = 0
	const blank = (count: number) => {
		out += " ".repeat(count)
	}
	while (i < sql.length) {
		const ch = sql[i]
		const next = sql[i + 1]

		if (ch === "-" && next === "-") {
			const nl = sql.indexOf("\n", i)
			const end = nl === -1 ? sql.length : nl
			blank(end - i)
			i = end
			continue
		}
		if (ch === "/" && next === "*") {
			const close = sql.indexOf("*/", i + 2)
			const end = close === -1 ? sql.length : close + 2
			for (let j = i; j < end; j++) out += sql[j] === "\n" ? "\n" : " "
			i = end
			continue
		}
		if (ch === "'" || ch === "`" || ch === '"') {
			const quote = ch
			if (markLiterals) out += "?"
			else blank(1)
			i++
			while (i < sql.length) {
				const c = sql[i]
				if (c === "\\") {
					blank(Math.min(2, sql.length - i))
					i += 2
					continue
				}
				blank(1)
				i++
				if (c === quote) break
			}
			continue
		}

		out += ch
		i++
	}
	return out
}

export interface TerminalClauses {
	/** Everything up to the first terminal clause, with any trailing `;` removed. */
	readonly body: string
	/** The `SETTINGS …` clause verbatim, or undefined. */
	readonly settings: string | undefined
	/** The `FORMAT …` clause verbatim, or undefined. */
	readonly format: string | undefined
}

type Candidate = { readonly start: number; readonly kind: "settings" | "format" }

const TERMINAL_KEYWORD_RE = /\b(SETTINGS|FORMAT)\b/gi

/** The last word or symbol of a text. */
const LAST_TOKEN_RE = /([a-zA-Z_]\w*|[^\s])\s*$/
const OPERAND_KEYWORD_RE =
	/^(?:SELECT|DISTINCT|AS|FROM|JOIN|BY|WHERE|PREWHERE|HAVING|QUALIFY|ON|AND|OR|NOT|WHEN|THEN|ELSE|WITH|IN|BETWEEN|LIKE|ILIKE|LIMIT|OFFSET)$/i
const OPERAND_SYMBOL_RE = /^[,.+/%<>=!|&^(-]$/
/** A name, or the `?` that marks a quoted one. */
const IDENTIFIER_RE = /^(?:[a-zA-Z_]\w*|\?)$/

/** The last `count` words or symbols before `end`, nearest first. */
const tokensBefore = (text: string, end: number, count: number): Array<string> => {
	const tokens: Array<string> = []
	let rest = text.slice(0, end)
	while (tokens.length < count) {
		const match = LAST_TOKEN_RE.exec(rest)
		if (match === null) break
		tokens.push(match[1])
		rest = rest.slice(0, match.index)
	}
	return tokens
}

/**
 * Whether an operand must follow `token`, the nearest of the tokens before a
 * keyword. Two tokens read both ways and need the ones before them:
 *
 * - `ALL` wants an operand only as a set quantifier: `SELECT ALL x`, `UNION
 *   ALL SELECT`. Anywhere else it is one: `GROUP BY ALL`, `ORDER BY ALL`,
 *   `PARTITION ALL`, a column or table named `all`.
 * - `*` is the wildcard, a complete operand, where a select item starts
 *   (`SELECT *`, `, *`, `count(*)`) and after a qualifier (`t.*`). Anywhere
 *   else it multiplies: `a * b`, `t.offset * b`.
 */
const expectsOperandAfter = ([token, earlier, before]: ReadonlyArray<string | undefined>): boolean => {
	if (token === undefined) return true
	if (/^ALL$/i.test(token)) return earlier !== undefined && /^(?:SELECT|UNION|INTERSECT|EXCEPT)$/i.test(earlier)
	if (token === "*") {
		const wildcard =
			earlier === undefined || /^(?:SELECT|DISTINCT|ALL|[,(])$/i.test(earlier) || (earlier === "." && before !== undefined && IDENTIFIER_RE.test(before))
		return !wildcard
	}
	return OPERAND_KEYWORD_RE.test(token) || OPERAND_SYMBOL_RE.test(token)
}

/** Paren nesting depth at each offset of the masked text. */
const depthsOf = (masked: string): Int32Array => {
	const depths = new Int32Array(masked.length)
	let depth = 0
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i]
		if (ch === ")") depth = Math.max(0, depth - 1)
		depths[i] = depth
		if (ch === "(") depth++
	}
	return depths
}

/**
 * A candidate only counts as a terminal clause if the whole tail from its start
 * parses as a chain of terminal clauses — which is what separates the `FORMAT`
 * in `SELECT 1 FORMAT JSON` from the column in `SELECT format FROM t`.
 */
const clauseIsWellFormed = (kind: Candidate["kind"], segment: string): boolean =>
	kind === "format" ? /^FORMAT\s+\w+\s*$/i.test(segment) : /^SETTINGS\s+\w+\s*=/i.test(segment)

/**
 * Split a single ClickHouse statement into its body and terminal clauses.
 *
 * Tolerates either clause order — the grammar puts `SETTINGS` before `FORMAT`,
 * but `FORMAT … SETTINGS …` is still accepted by older servers and appears in
 * hand-written SQL. A trailing semicolon is dropped.
 */
export function splitTerminalClauses(sql: string): TerminalClauses {
	const terminator = /;\s*$/.exec(maskLiteralsAndComments(sql))
	const trimmed = terminator ? sql.slice(0, terminator.index) + sql.slice(terminator.index + 1) : sql
	const masked = maskLiteralsAndComments(trimmed)
	const marked = maskSql(trimmed, true)
	const depths = depthsOf(masked)

	const candidates: Array<Candidate> = []
	TERMINAL_KEYWORD_RE.lastIndex = 0
	let match: RegExpExecArray | null = TERMINAL_KEYWORD_RE.exec(masked)
	while (match !== null) {
		// A terminal clause follows a complete expression/table, never a place that
		// still needs an operand. In `SELECT format JSON`, FORMAT is the column.
		if (depths[match.index] === 0 && !expectsOperandAfter(tokensBefore(marked, match.index, 3))) {
			candidates.push({
				start: match.index,
				kind: match[1].toLowerCase() === "format" ? "format" : "settings",
			})
		}
		match = TERMINAL_KEYWORD_RE.exec(masked)
	}

	// Walk boundaries right-to-left, keeping the earliest one whose whole tail is
	// a well-formed chain with at most one clause of each kind.
	let boundary = -1
	const seen = new Set<Candidate["kind"]>()
	for (let i = candidates.length - 1; i >= 0; i--) {
		const candidate = candidates[i]
		const end = i + 1 < candidates.length ? candidates[i + 1].start : trimmed.length
		if (seen.has(candidate.kind)) break
		if (!clauseIsWellFormed(candidate.kind, masked.slice(candidate.start, end))) break
		seen.add(candidate.kind)
		boundary = candidate.start
	}

	if (boundary === -1) return { body: trimmed, settings: undefined, format: undefined }

	const tail = candidates.filter((candidate) => candidate.start >= boundary)
	const clauseText = (index: number) => {
		const start = tail[index].start
		const end = index + 1 < tail.length ? tail[index + 1].start : trimmed.length
		return trimmed.slice(start, end).trim()
	}

	let settings: string | undefined
	let format: string | undefined
	for (let i = 0; i < tail.length; i++) {
		if (tail[i].kind === "settings") settings = clauseText(i)
		else format = clauseText(i)
	}

	return { body: trimmed.slice(0, boundary).trimEnd(), settings, format }
}
