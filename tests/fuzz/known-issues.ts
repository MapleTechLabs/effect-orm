// Bugs the fuzzer has found and nobody has fixed yet.
//
// Each entry recognises the inputs that reach one bug, so the suite stays green
// while it is open and the rest of the input space keeps being fuzzed. This file
// is the backlog: fix the bug, delete its entry, and run with `FUZZ_STRICT=1`
// to confirm nothing else matched it. An entry needs a reason a person can act on.
import { config } from "./harness"
import type { LiteralType } from "./values"

export interface KnownIssue<A> {
	readonly id: string
	readonly reason: string
	readonly matches: (input: A) => boolean
}

/** The first open issue `input` reaches, unless FUZZ_STRICT re-enabled it. */
const firstMatch = <A>(issues: ReadonlyArray<KnownIssue<A>>, input: A): string | undefined =>
	issues.find((issue) => !config.strict.has("1") && !config.strict.has(issue.id) && issue.matches(input))?.id

export type LiteralPath = "compare" | "select"
export interface LiteralInput {
	readonly literal: LiteralType
	readonly value: unknown
	readonly path: LiteralPath
}

const literalIssues: ReadonlyArray<KnownIssue<LiteralInput>> = []

/** The id of the open issue this input would hit, if any. */
export const knownLiteralIssue = (input: LiteralInput): string | undefined =>
	firstMatch(literalIssues, input)

// Hostile values (compile.fuzz.test.ts)

import type { HostileInput } from "./compile.fuzz.test"

const hostileIssues: ReadonlyArray<KnownIssue<HostileInput>> = []

export const knownHostileIssue = (input: HostileInput): string | undefined =>
	firstMatch(hostileIssues, input)

// Query plans (queries.fuzz.test.ts)

import { foldConstant } from "./model"
import type { Cond, Expr, Plan, UnionPlan } from "./plan"

export interface PlanInput {
	/** The target name (`dialects/*.ts`), or the dialect name for compile-only properties. */
	readonly target: string
	readonly plan: Plan
	/** Whether the plan runs on a database: a server bug only matters to properties that run it. */
	readonly executed: boolean
}

/** A `%` anywhere in the plan whose divisor folds to -2, -4, -8, …: the divisor is always the node's `r`. */
const negativePowerOfTwoModulo = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(negativePowerOfTwoModulo)
	if (value === null || typeof value !== "object") return false
	const e = value as Expr
	if (e.k === "arith" && e.op === "mod") {
		const d = foldConstant(e.r)
		if (d !== undefined && Number.isInteger(d) && d <= -2 && Number.isInteger(Math.log2(-d))) return true
	}
	return Object.values(value).some(negativePowerOfTwoModulo)
}

/** Every node of a plan (conditions, expressions, operands), depth first. */
const nodes = (value: unknown): ReadonlyArray<Record<string, unknown>> => {
	if (Array.isArray(value)) return value.flatMap(nodes)
	if (value === null || typeof value !== "object") return []
	return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)]
}

const readsJoinedColumn = (value: unknown): boolean => nodes(value).some((node) => node.k === "jcol")

/**
 * Whether a string expression can be `''` on some row. `OrgId` of orders never
 * is; every other column is in some fixture, and a joined one is for an
 * unmatched LEFT JOIN row where the target fills with defaults.
 */
const canBeEmpty = (e: Expr): boolean => {
	switch (e.k) {
		case "str":
			return e.v === ""
		case "col":
			return e.col !== "OrgId"
		case "jcol":
			return true
		case "coalesce":
			// `coalesce('', x)` is `''`: only NULL falls through.
			return canBeEmpty(e.e) || canBeEmpty(e.fallback)
		default:
			return false
	}
}

type MatchNode = Extract<Cond, { readonly k: "match" }>
const isContains = (node: Record<string, unknown>): node is MatchNode & Record<string, unknown> => node.k === "match" && node.op === "contains"

/**
 * `LIKE '%%'` or `ILIKE '%%'` over a column of the joined table: written out,
 * or built by `contains` from a needle that is empty when the query runs (an
 * empty string written in the plan is one `%`, see `textPattern`).
 */
const matchAllOverJoin = (value: unknown): boolean =>
	nodes(value).some((node) => {
		if (node.k === "like") return node.op !== "notLike" && node.pattern === "%%" && readsJoinedColumn(node.l)
		if (!isContains(node) || !readsJoinedColumn(node.l)) return false
		return node.needle.k === "param" ? node.needle.v === "" : node.needle.k === "expr" && canBeEmpty(node.needle.e)
	})

/**
 * An empty string matched against `'%%'` off the one path 26.2 gets right (a
 * column, or a materialized literal, against that pattern as a constant): an
 * empty literal against the pattern written out, or a `contains` whose needle
 * is read from a column, where both sides can be empty on the same row.
 */
const emptyAgainstMatchAll = (value: unknown): boolean =>
	nodes(value).some((node) => {
		if (node.k === "like") return node.pattern === "%%" && (node.l as Expr).k === "str" && canBeEmpty(node.l as Expr)
		// A literal haystack is written `materialize('…')`, or as an equality when it is empty: right either way.
		return isContains(node) && node.l.k !== "str" && node.needle.k === "expr" && node.needle.e.k !== "str" && canBeEmpty(node.needle.e) && canBeEmpty(node.l)
	})

/** `endsWith` of text that holds a NUL byte, written in the plan as a value, a param or a literal. */
const suffixHoldsNul = (value: unknown): boolean =>
	nodes(value).some((node) => {
		if (node.k !== "match" || node.op !== "endsWith") return false
		const needle = (node as unknown as MatchNode).needle
		const text = needle.k === "expr" ? (needle.e.k === "str" ? needle.e.v : undefined) : needle.k === "time" ? undefined : needle.v
		return typeof text === "string" && text.includes("\0")
	})

/** A string literal that ends in a NUL byte. */
const trailingNul = (value: unknown): boolean =>
	nodes(value).some((node) => node.k === "str" && typeof node.v === "string" && node.v.endsWith("\0"))

const fraction = (operand: unknown): boolean => {
	const v = (operand as { k?: string; v?: unknown }).v
	return typeof v === "number" && !Number.isInteger(v)
}
/** `x BETWEEN lo AND hi` with one bound a whole number and the other a fraction. */
const mixedBetween = (value: unknown): boolean =>
	nodes(value).some((node) => node.k === "between" && fraction(node.lo) !== fraction(node.hi))

/** A fraction written in the plan as the right side of a comparison or a bound of a BETWEEN: `Id = 0.75`. */
const fractionOperand = (value: unknown): boolean =>
	nodes(value).some((node) => (node.k === "cmp" && fraction(node.r)) || (node.k === "between" && (fraction(node.lo) || fraction(node.hi))))

const planIssues: ReadonlyArray<KnownIssue<PlanInput>> = [{
	id: "clickhouse-26.2-negative-power-of-two-modulo",
	// Server bug, not the builder's: on 26.2.19.43 a column % a constant -2^k is wrong for a negative
	// dividend — `SELECT (toInt64(number) - 5) % -2 FROM numbers(1)` is 1, not -1, and `% (0 - 2)` the
	// same. `% -3`, `% 2` and a constant dividend are right; 26.8 is right throughout. The target does
	// not know its server version, so this skips every ClickHouse target: delete it once CI drops 26.2.
	reason: "ClickHouse 26.2 computes a column % a negative power-of-two constant wrongly",
	matches: (input) => input.executed && input.target.startsWith("clickhouse") && negativePowerOfTwoModulo(input.plan),
}, {
	id: "mariadb-distinct-join-offset",
	// Server bug, not the builder's: MariaDB 11.4 counts OFFSET over a join's rows before DISTINCT
	// removes their duplicates, so `SELECT DISTINCT o.x FROM o JOIN c … LIMIT 10 OFFSET 1`, one
	// distinct row from two joined, returns it. MySQL returns none. The builder could write such a
	// query as `SELECT * FROM (SELECT DISTINCT …) d … OFFSET 1`, which MariaDB answers correctly.
	reason: "MariaDB applies OFFSET before DISTINCT over a join",
	matches: ({ executed, target, plan }) =>
		executed && target.startsWith("mariadb") && plan.join !== undefined && plan.shape.k === "rows" && plan.shape.distinct && (plan.shape.offset ?? 0) > 0,
}, {
	id: "clickhouse-26.2-left-join-like-match-all",
	// Server bug, not the builder's: 26.2.19.43 turns a LEFT JOIN into an INNER JOIN when the filter
	// is `c.Name LIKE '%%'` (what `contains` builds from an empty param), although an unmatched row's `''` matches it:
	// `SELECT … FROM o LEFT JOIN c ON … WHERE c.Name LIKE '%%'` loses the unmatched rows, on real
	// tables too. `LIKE '%'` and `'%%%'` are right, as is `query_plan_convert_outer_join_to_inner_join = 0`;
	// 26.8 is right throughout. Skips every ClickHouse target, like the entry above: delete it with 26.2.
	reason: "ClickHouse 26.2 drops a LEFT JOIN's unmatched rows under LIKE '%%' on the joined table",
	matches: ({ executed, target, plan }) => executed && target.startsWith("clickhouse") && plan.join === "left" && matchAllOverJoin(plan.where),
}, {
	id: "clickhouse-26.2-empty-like-match-all",
	// Server bug, not the builder's, and the cause of the entry above: on 26.2.19.43 an empty string
	// does not match `'%%'`. `SELECT '' LIKE '%%'` is 0, as is any empty constant on the left
	// (`concat('', '')`, `coalesce(NULL, '')`), and so is `materialize('') LIKE materialize('%%')`:
	// a pattern computed per row, which is what `a.contains(b)` builds when `b` is a column, wrong on
	// the rows where both are empty. Only a column, or the `materialize('…')` the builder writes for a
	// literal beside a computed pattern, against the constant `'%%'` is right, and so are `'%'`,
	// `'%%%'` and a non-empty string; `NOT LIKE` and `ILIKE` follow. 26.8 is right throughout. The
	// planner asks the same question of an unmatched LEFT JOIN row, which is how it loses those rows.
	// `position(a, b) > 0` is right on both versions. The builder leaves `lit('').like('%%')` a constant:
	// materializing it would cost every constant LIKE its folding, for a pattern nobody writes.
	reason: "ClickHouse 26.2 does not match an empty string against LIKE '%%'",
	matches: ({ executed, target, plan }) => executed && target.startsWith("clickhouse") && emptyAgainstMatchAll(plan),
}, {
	id: "clickhouse-26.2-like-suffix-nul",
	// Server bug, not the builder's: on 26.2.19.43 a LIKE pattern that is a suffix (`'%…'`) and holds
	// a NUL byte matches what it should not, for a column and a constant alike: `'org_1' LIKE '%\0'`,
	// `'ab' LIKE '%\0b'` and `'abc' LIKE '%b\0c'` are all true. A NUL in `'%…%'` or `'…%'` is
	// right, as is the function `endsWith('org_1', '\0')`; 26.8 is right throughout.
	reason: "ClickHouse 26.2 matches a LIKE suffix pattern that holds a NUL byte wrongly",
	matches: ({ executed, target, plan }) => executed && target.startsWith("clickhouse") && suffixHoldsNul(plan),
}, {
	id: "mariadb-order-by-trailing-nul",
	// Server limit, not the builder's: MariaDB 11.4 sorts a VARCHAR (a literal, a `CAST(… AS CHAR)`)
	// by a fixed-length key padded with NUL bytes, so under `utf8mb4_nopad_bin` `''`, `'\0'` and
	// `'\0\0'` tie in ORDER BY although `'' < '\0'` is true and a TEXT column sorts them apart.
	// MySQL 8.4 orders them. The model cannot say which of two tied rows comes first.
	reason: "MariaDB orders VARCHAR values that differ only in trailing NUL bytes as equal",
	matches: ({ executed, target, plan }) => executed && target.startsWith("mariadb") && plan.shape.orderBy.length > 0 && trailingNul(plan),
}, {
	id: "mysql-prepared-fraction-after-parameter-constant-column",
	// Server quirk, and only over this suite's fixture, like the entry below: on MySQL 8.4.11 a prepared
	// fraction is rounded when the column is a constant column of a CTE (`CAST(1 AS SIGNED)`) and a
	// predicate with a parameter of its own comes first. `OrgId = ? AND Id = ?` with `['org_1', 0.75]`
	// and `Amount > ? AND Id = ?` with `[0.5, 0.75]` both match Id 1; `<>`, `>`, `>=`, `<=`, `IN`,
	// `BETWEEN` and `NOT BETWEEN` go wrong the same way. The fraction's predicate alone or first, the
	// text protocol, a real INT or BIGINT column (18 prepared comparisons checked) and MariaDB 11.4 are
	// all right. The params of an earlier union branch come first too, so this skips every fraction.
	reason: "MySQL 8.4 rounds a prepared fraction that follows another predicate's parameter when the column is a constant",
	matches: ({ executed, target, plan }) => executed && target === "mysql" && fractionOperand(plan),
}, {
	id: "mysql-prepared-between-constant-column",
	// Server quirk, and only over this suite's fixture: a prepared `Amount BETWEEN ? AND ?` bound
	// with `[0, 98.75]` matches 99 when `Amount` is a constant column of a CTE (`CAST(99 AS SIGNED)`),
	// because MySQL 8.4 folds the comparison to integers once one bound is whole. The text protocol,
	// `[0.5, 98.75]`, and a real INT or BIGINT column on MySQL and MariaDB are all right.
	reason: "MySQL 8.4 rounds a fractional BETWEEN bound beside a whole one when the column is a constant",
	matches: ({ executed, target, plan }) => executed && target === "mysql" && mixedBetween(plan),
}]

export const knownPlanIssue = (input: PlanInput): string | undefined => firstMatch(planIssues, input)

// Unions (queries.fuzz.test.ts)

export interface UnionInput {
	readonly target: string
	readonly plan: UnionPlan
}

// Each branch is also checked against the plan issues above.
const unionIssues: ReadonlyArray<KnownIssue<UnionInput>> = [{
	id: "mariadb-order-by-trailing-nul",
	// The same limit as the plan entry, under the union's own ORDER BY.
	reason: "MariaDB orders VARCHAR values that differ only in trailing NUL bytes as equal",
	matches: ({ target, plan }) => target.startsWith("mariadb") && plan.orderBy.length > 0 && trailingNul(plan.branches),
}]

export const knownUnionIssue = (input: UnionInput): string | undefined => firstMatch(unionIssues, input)
