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

const literalIssues: ReadonlyArray<KnownIssue<LiteralInput>> = [
	{
		id: "ch-array-literal-untyped",
		reason:
			"An array literal is written without a cast, so ClickHouse infers its element type from the values: " +
			"`[0, 4294967296]` is Array(UInt64), and comparing it with an Array(Nullable(Int64)) column is " +
			"ILLEGAL_TYPE_OF_ARGUMENT. CAST(… AS <column type>) would fix it.",
		matches: ({ literal, value, path }) =>
			literal.dialect === "clickhouse" &&
			path === "compare" &&
			literal.type.sql === "Array(Nullable(Int64))" &&
			Array.isArray(value) &&
			value.every((n) => n === null || n >= 0) &&
			value.some((n) => n !== null && n >= 2 ** 32),
	},
	{
		id: "pg-untyped-select-param",
		reason:
			"A param in a Postgres SELECT list is bound untyped (`$1 AS \"p\"`), so the server infers `text` and a " +
			"boolean comes back as `'false'`, an array as `'{…}'`, neither of which the column's codec decodes. " +
			"Writing `$1::<type>` would fix it.",
		matches: ({ literal, path }) =>
			literal.dialect === "postgres" && path === "select" && (literal.type.sql === "boolean" || literal.type._tag === "Array"),
	},
]

/** The id of the open issue this input would hit, if any. */
export const knownLiteralIssue = (input: LiteralInput): string | undefined =>
	firstMatch(literalIssues, input)

// Hostile values (compile.fuzz.test.ts)

import type { HostileInput } from "./compile.fuzz.test"

const hostileIssues: ReadonlyArray<KnownIssue<HostileInput>> = [




]

export const knownHostileIssue = (input: HostileInput): string | undefined =>
	firstMatch(hostileIssues, input)

// Query plans (queries.fuzz.test.ts)

import type { Target } from "./db"
import type { Plan } from "./plan"

export interface PlanInput {
	readonly target: Target
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
			"A ClickHouse 25.8 server bug, not the builder: `WHERE a AND ((b AND a) OR a)` fails with " +
			"`Number of arguments for function \"and\" should be at least 2` — the common-expression rewrite leaves a " +
			"one-argument and(). `SETTINGS optimize_extract_common_expressions = 0` avoids it.",
		matches: ({ target, plan }) => {
			if (target === "postgres") return false
			const top = conjuncts(plan.where)
			return [...nodes(plan)].some(
				(node) =>
					node.k === "or" &&
					top.some(
						(w) =>
							(node.cs as Array<any>).some((d) => same(d, w)) &&
							(node.cs as Array<any>).some((d) => d?.k === "and" && conjuncts(d.cs).some((x) => same(x, w))),
					),
			)
		},
	},
	{
		id: "pg-fraction-bound-to-integer",
		reason:
			"On Postgres a comparison value is bound as a parameter, and the server types it from the integer side: " +
			"`\"Amount\" > $1` with 9.75 fails `invalid input syntax for type bigint`. ClickHouse inlines the literal " +
			"and compares correctly. The builder accepts the value (int8's codec is any finite number).",
		matches: ({ target, plan }) =>
			target === "postgres" &&
			[...nodes(plan)].some((node) => node.k === "value" && typeof node.v === "number" && !Number.isInteger(node.v)),
	},
	{
		id: "fromquery-select-all",
		reason:
			"`CH.fromQuery(q, alias).select()` is typed as selecting every column, but a subquery source has no column " +
			"list to expand, so compile dies with QueryBuilderDefect `select() is required`. `select(...names)` works.",
		matches: ({ plan }) => plan.wrap === "all",
	},
]

export const knownPlanIssue = (input: PlanInput): string | undefined => firstMatch(planIssues, input)
