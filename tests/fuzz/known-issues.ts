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

import { chKind } from "./model"
import type { Plan, UnionPlan } from "./plan"

export interface PlanInput {
	/** The target name (`dialects/*.ts`), or the dialect name for compile-only properties. */
	readonly target: string
	readonly plan: Plan
}

/** Every object in a plan, depth-first: plans are plain data, so this reaches every expression. */
const nodes = function* (value: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(value)) for (const item of value) yield* nodes(item)
	else if (value !== null && typeof value === "object") {
		yield value as Record<string, unknown>
		for (const item of Object.values(value)) yield* nodes(item)
	}
}

/** The conjuncts a WHERE list ANDs together, flattening nested ANDs. */
const conjuncts = (conds: ReadonlyArray<unknown>): Array<unknown> =>
	conds.flatMap((c: any) => (c?.k === "and" ? conjuncts(c.cs) : [c]))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const planIssues: ReadonlyArray<KnownIssue<PlanInput>> = [
	{
		id: "clickhouse-server-and-absorption",
		reason:
			"A ClickHouse 25.8 server bug, not the builder: `WHERE a AND ((b AND a) OR a)` or `a AND ((a OR a) OR a)` fails with " +
			"`Number of arguments for function \"and\" should be at least 2` — the common-expression rewrite leaves a " +
			"one-argument and(). `SETTINGS optimize_extract_common_expressions = 0` avoids it.",
		matches: ({ target, plan }) => {
			if (!target.startsWith("clickhouse")) return false
			const top = conjuncts(plan.where)
			const disjuncts = (c: any): Array<any> => (c?.k === "or" ? c.cs.flatMap(disjuncts) : [c])
			// Fails when every disjunct of a nested OR contains a top-level conjunct `w` (as `w`, or inside an AND):
			// `w AND ((x AND w) OR w)`, `w AND ((w OR w) OR w)`. `w AND (w OR w)` and `w AND ((x AND w) OR y)` run.
			return [...nodes(plan)].some(
				(node) =>
					node.k === "or" &&
					(node.cs as Array<any>).some((d) => d?.k === "or" || d?.k === "and") &&
					top.some((w) => disjuncts(node).every((d) => same(d, w) || (d?.k === "and" && conjuncts(d.cs).some((x) => same(x, w))))),
			)
		},
	},


]

export const knownPlanIssue = (input: PlanInput): string | undefined => firstMatch(planIssues, input)

// Unions (queries.fuzz.test.ts)

export interface UnionInput {
	readonly target: string
	readonly plan: UnionPlan
}

/** The expression a branch selects under `alias`. */
const selected = (branch: Plan, alias: string) => (branch.shape.k === "rows" ? branch.shape.select.find(([a]) => a === alias)?.[1] : undefined)

const unionIssues: ReadonlyArray<KnownIssue<UnionInput>> = [
	{
		id: "clickhouse-union-variant-order-by",
		reason:
			"On ClickHouse 26, a UNION ALL column whose branches have numeric types with no common supertype (`Id + 1` is " +
			"UInt64, `Id - 1` Int64; Int64 and Float64) becomes a Variant, and the union's ORDER BY on it fails with " +
			"`Data types Variant/Dynamic are not allowed in ORDER BY keys`. Fix: have compileUnion cast a numeric union " +
			"column to one type (e.g. Float64, or the widest signed type) when its branches' expressions differ.",
		matches: ({ target, plan }) =>
			target.startsWith("clickhouse") &&
			plan.orderBy.some(([alias]) => {
				const kinds = new Set(
					plan.branches.map((branch) => {
						const e = selected(branch, alias)
						return e === undefined || (e.k !== "num" && e.k !== "arith" && !(e.k === "col" && (e.col === "Id" || e.col === "Amount")))
							? "other"
							: `${chKind(e)}:${e.k === "col" ? e.col : e.k}`
					}),
				)
				return kinds.size > 1 && !kinds.has("other")
			}),
	},
]

export const knownUnionIssue = (input: UnionInput): string | undefined => firstMatch(unionIssues, input)
