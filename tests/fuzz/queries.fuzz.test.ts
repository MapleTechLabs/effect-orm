// Query semantics: random plans run on a real database and match the reference model.
//
// Each plan is compiled for the target dialect, executed over the core fixture,
// and its decoded rows compared with `model.ts`. On top of the row diff:
//
//   tenant soundness   a query that reports "single-tenant" read rows of one org only
//
// Unions are fuzzed the same way: `unionAll` of row plans, each branch with its
// own ORDER BY and LIMIT, under the union's own ORDER BY, LIMIT and OFFSET.
//
// Every target in the registry (dialects/index.ts) runs; one whose database is
// not reachable here is skipped, not dropped, so the run says so.
import { afterAll, describe, expect, it } from "vitest"
import { compilePlan, compileUnionPlan, scopeContext, type Compiled } from "./build"
import { closeAll, targets, type FuzzDialect, type FuzzTarget } from "./dialects"
import { FuzzFailure, property, skipKnown, withContext } from "./harness"
import { knownPlanIssue, knownUnionIssue } from "./known-issues"
import { evaluate, evaluateUnion, type ModelResult } from "./model"
import { nastyOptions, plainOptions, plan, unionPlan, type Plan, type UnionPlan } from "./plan"
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

const matchesModel = (dialect: FuzzDialect, target: FuzzTarget, input: Plan) => {
	const known = knownPlanIssue({ target: target.name, plan: input })
	if (known !== undefined) skipKnown(known)
	return checkRows(target, input.orgId, evaluate(input, target.semantics), compilePlan(dialect, dialect.context, input), compilePlan(dialect, scopeContext(dialect), input))
}

const unionMatchesModel = (dialect: FuzzDialect, target: FuzzTarget, input: UnionPlan) => {
	const knownUnion = knownUnionIssue({ target: target.name, plan: input })
	if (knownUnion !== undefined) skipKnown(knownUnion)
	for (const branch of input.branches) {
		const known = knownPlanIssue({ target: target.name, plan: branch })
		if (known !== undefined) skipKnown(known)
	}
	return checkRows(
		target,
		input.orgId,
		evaluateUnion(input, target.semantics),
		compileUnionPlan(dialect, dialect.context, input),
		compileUnionPlan(dialect, scopeContext(dialect), input),
	)
}

/** Run what compiled and compare its rows with the model's; `scoped` is the same input over the plain tables. */
const checkRows = async (target: FuzzTarget, orgId: string, expected: ModelResult, result: Compiled, scoped: Compiled) => {
	if (result._tag !== "Compiled") throw new FuzzFailure(`a valid plan was not compiled (${result._tag})`, { error: result.error })
	const { compiled } = result
	// The scope a real application would get: the same plan over the plain tables.
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
			const foreign = [...expected.orgs].filter((org) => org !== orgId)
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

describe("unions match the model", () => {
	for (const { dialect, target } of targets) {
		for (const [label, options] of [
			["plain strings", plainOptions(dialect)],
			["nasty strings", nastyOptions(dialect)],
		] as const) {
			const name = `unions match the model (${target.name}, ${label})`
			it.skipIf(!target.available)(name, () => property(name, unionPlan(options), (input) => unionMatchesModel(dialect, target, input), { runs: 60 }), 300_000)
		}
	}
})
