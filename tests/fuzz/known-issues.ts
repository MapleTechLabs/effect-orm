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

import type { Plan, UnionPlan } from "./plan"

export interface PlanInput {
	/** The target name (`dialects/*.ts`), or the dialect name for compile-only properties. */
	readonly target: string
	readonly plan: Plan
}

const planIssues: ReadonlyArray<KnownIssue<PlanInput>> = [{
	id: "mariadb-distinct-join-offset",
	// Server bug, not the builder's: MariaDB 11.4 counts OFFSET over a join's rows before DISTINCT
	// removes their duplicates, so `SELECT DISTINCT o.x FROM o JOIN c … LIMIT 10 OFFSET 1`, one
	// distinct row from two joined, returns it. MySQL returns none. The builder could write such a
	// query as `SELECT * FROM (SELECT DISTINCT …) d … OFFSET 1`, which MariaDB answers correctly.
	reason: "MariaDB applies OFFSET before DISTINCT over a join",
	matches: ({ target, plan }) =>
		target.startsWith("mariadb") && plan.join !== undefined && plan.shape.k === "rows" && plan.shape.distinct && (plan.shape.offset ?? 0) > 0,
}]

export const knownPlanIssue = (input: PlanInput): string | undefined => firstMatch(planIssues, input)

// Unions (queries.fuzz.test.ts)

export interface UnionInput {
	readonly target: string
	readonly plan: UnionPlan
}

/** A `%` by a negative constant anywhere in the input's plans. */
const negativeModulo = (value: unknown): boolean =>
	Array.isArray(value) ? value.some(negativeModulo)
	: value !== null && typeof value === "object"
		? ((value as { k?: string; op?: string; r?: unknown }).k === "arith" && (value as { op?: string }).op === "mod" && typeof (value as { r?: unknown }).r === "number" && (value as { r: number }).r < 0)
			|| Object.values(value).some(negativeModulo)
		: false

const unionIssues: ReadonlyArray<KnownIssue<UnionInput>> = [{
	id: "clickhouse-26.2-union-negative-modulo",
	// Server bug, not the builder's: on 26.2, `SELECT A % -4 FROM t UNION ALL SELECT 0 FROM t` with A = -5
	// returns 3, not -1. 26.8 returns -1. Delete this entry once CI no longer runs 26.2.
	reason: "ClickHouse 26.2 computes % by a negative divisor wrongly under UNION ALL",
	matches: (input) => input.target.startsWith("clickhouse") && negativeModulo(input.plan),
}]

export const knownUnionIssue = (input: UnionInput): string | undefined => firstMatch(unionIssues, input)
