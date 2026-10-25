// Query semantics: random plans run on a real database and match the reference model.
//
// Each plan is compiled for the target dialect, executed over the core fixture,
// and its decoded rows compared with `model.ts`. On top of the row diff:
//
//   tenant soundness   a query that reports "single-tenant" read rows of one org only
//
// Every target in the registry (dialects/index.ts) runs; one whose database is
// not reachable here is skipped, not dropped, so the run says so.
import { afterAll, describe, expect, it } from "vitest"
import { compilePlan, scopeContext } from "./build"
import { closeAll, targets, type FuzzDialect, type FuzzTarget } from "./dialects"
import { FuzzFailure, property, skipKnown, withContext } from "./harness"
import { knownPlanIssue } from "./known-issues"
import { evaluate } from "./model"
import { nastyOptions, plainOptions, plan, type Plan } from "./plan"
import { normalize } from "./values"

afterAll(closeAll)

/** Rows in a form that compares across float summation order: non-integers to 12 significant digits. */
const canonical = (rows: ReadonlyArray<unknown>): Array<unknown> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(normalize(row) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(12)) : v]),
		),
	)
const sorted = (rows: Array<unknown>) => rows.map((r) => JSON.stringify(r)).sort()

const matchesModel = async (dialect: FuzzDialect, target: FuzzTarget, input: Plan) => {
	const known = knownPlanIssue({ target: target.name, plan: input })
	if (known !== undefined) skipKnown(known)
	const expected = evaluate(input, target.semantics)
	const result = compilePlan(dialect, dialect.context, input)
	if (result._tag !== "Compiled") throw new FuzzFailure(`a valid plan was not compiled (${result._tag})`, { error: result.error })
	const { compiled } = result
	// The scope a real application would get: the same plan over the plain tables.
	const scoped = compilePlan(dialect, scopeContext(dialect), input)
	const tenantScope = scoped._tag === "Compiled" ? scoped.compiled.tenantScope : undefined
	const outcome = await target.run(compiled)
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

describe("queries match the model", () => {
	for (const { dialect, target } of targets) {
		for (const [label, options] of [
			["plain strings", plainOptions(dialect)],
			["nasty strings", nastyOptions(dialect)],
		] as const) {
			const name = `plans match the model (${target.name}, ${label})`
			it.skipIf(!target.available)(name, () => property(name, plan(options), (input) => matchesModel(dialect, target, input), { runs: 100 }), 300_000)
		}
	}
})
