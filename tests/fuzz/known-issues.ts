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
import type { Expr, Plan, UnionPlan } from "./plan"

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
}]

export const knownPlanIssue = (input: PlanInput): string | undefined => firstMatch(planIssues, input)

// Unions (queries.fuzz.test.ts)

export interface UnionInput {
	readonly target: string
	readonly plan: UnionPlan
}

// Each branch is also checked against the plan issues above.
const unionIssues: ReadonlyArray<KnownIssue<UnionInput>> = []

export const knownUnionIssue = (input: UnionInput): string | undefined => firstMatch(unionIssues, input)
