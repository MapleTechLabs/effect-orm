// Query semantics: random plans run on a real database and match the reference model.
//
// Each plan is compiled for the target dialect, executed over the core fixture,
// and its decoded rows compared with `model.ts`. On top of the row diff:
//
//   tenant soundness   a query that reports "single-tenant" read rows of one org only
//
// Postgres (PGlite) always runs. ClickHouse runs twice when an endpoint is set,
// once per `join_use_nulls`, because that setting changes what a LEFT JOIN fills.
import { afterAll, describe, expect, it } from "vitest"
import type { CoreContext } from "../core-cases"
import { contexts, scopeContexts } from "./contexts"
import { compilePlan } from "./build"
import { clickhouseEndpoint, closePostgres, run, type Target } from "./db"
import { FuzzFailure, property, skipKnown, withContext } from "./harness"
import { knownPlanIssue } from "./known-issues"
import { evaluate } from "./model"
import { nastyOptions, plainOptions, plan, type Plan } from "./plan"
import { normalize } from "./values"

afterAll(closePostgres)

/** Rows in a form that compares across float summation order: non-integers to 12 significant digits. */
const canonical = (rows: ReadonlyArray<unknown>): Array<unknown> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(normalize(row) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(12)) : v]),
		),
	)
const sorted = (rows: Array<unknown>) => rows.map((r) => JSON.stringify(r)).sort()

const matchesModel = async (ctx: CoreContext, target: Target, input: Plan) => {
	const known = knownPlanIssue({ target, plan: input })
	if (known !== undefined) skipKnown(known)
	const expected = evaluate(input, target)
	const result = compilePlan(ctx, input)
	if (result._tag !== "Compiled") throw new FuzzFailure(`a valid plan was not compiled (${result._tag})`, { error: result.error })
	const { compiled } = result
	// The scope a real application would get: the same plan over the plain tables.
	const scoped = compilePlan(scopeContexts[ctx.dialect], input)
	const tenantScope = scoped._tag === "Compiled" ? scoped.compiled.tenantScope : undefined
	const outcome = await run(target, compiled)
	await withContext({ sql: compiled.sql, parameters: compiled.parameters, tenantScope, outcome, expected: expected.rows }, () => {
		expect(outcome._tag).toBe("Rows")
		if (outcome._tag !== "Rows") return
		const actual = canonical(outcome.rows)
		const want = canonical(expected.rows)
		if (expected.ordered) expect(actual).toEqual(want)
		else expect(sorted(actual)).toEqual(sorted(want))
		if (tenantScope === "single-tenant") {
			const foreign = [...expected.orgs].filter((org) => org !== input.orgId)
			expect(foreign, "a single-tenant query read another org's rows").toEqual([])
		}
	})
}

const targets: ReadonlyArray<Target> = clickhouseEndpoint ? ["postgres", "clickhouse", "clickhouse-join-nulls"] : ["postgres"]

describe("queries match the model", () => {
	for (const target of targets) {
		const ctx = contexts[target === "postgres" ? "postgres" : "clickhouse"]
		for (const [label, options] of [
			["plain strings", plainOptions],
			["nasty strings", nastyOptions(ctx.dialect)],
		] as const) {
			const name = `plans match the model (${target}, ${label})`
			it(name, () => property(name, plan(options), (input) => matchesModel(ctx, target, input), { runs: 100 }), 300_000)
		}
	}
})
