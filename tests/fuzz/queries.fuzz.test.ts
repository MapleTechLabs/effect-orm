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
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { compilePlan, compileUnionPlan, scopeContext, type Compiled } from "./build"
import { closeAll, targets, type FuzzDialect, type FuzzTarget } from "./dialects"
import { FuzzFailure, property, Skip, skipKnown, withContext } from "./harness"
import { knownPlanIssue, knownUnionIssue } from "./known-issues"
import { evaluate, evaluateUnion, type ModelResult } from "./model"
import { nastyOptions, plainOptions, plan, unionPlan, type Plan, type UnionPlan } from "./plan"
import { normalize } from "./values"
import { fixture, fixtureContext, type Fixture } from "./fixtures"

afterAll(closeAll)

/** Rows in a form that compares across float summation order: non-integers to 12 significant digits. */
const canonical = (rows: ReadonlyArray<unknown>): Array<unknown> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(normalize(row) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(12)) : v]),
		),
	)
const sorted = (rows: Array<unknown>) => rows.map((r) => JSON.stringify(r)).sort()

const matchesModel = (dialect: FuzzDialect, target: FuzzTarget, input: Plan, data?: Fixture) => {
	const known = knownPlanIssue({ target: target.name, plan: input })
	if (known !== undefined) skipKnown(known)
	return checkRows(target, input.orgId, evaluate(input, target.semantics, data), compilePlan(dialect, data === undefined ? dialect.context : fixtureContext(dialect, data), input), compilePlan(dialect, scopeContext(dialect), input), input.where)
}

const unionMatchesModel = (dialect: FuzzDialect, target: FuzzTarget, input: UnionPlan, data?: Fixture) => {
	const knownUnion = knownUnionIssue({ target: target.name, plan: input })
	if (knownUnion !== undefined) skipKnown(knownUnion)
	for (const branch of input.branches) {
		const known = knownPlanIssue({ target: target.name, plan: branch })
		if (known !== undefined) skipKnown(known)
	}
	return checkRows(
		target,
		input.orgId,
		evaluateUnion(input, target.semantics, data),
		compileUnionPlan(dialect, data === undefined ? dialect.context : fixtureContext(dialect, data), input),
		compileUnionPlan(dialect, scopeContext(dialect), input),
		input.branches.map((branch) => branch.where),
	)
}

/** Run what compiled and compare its rows with the model's; `scoped` is the same input over the plain tables. */
const checkRows = async (target: FuzzTarget, orgId: string, expected: ModelResult, result: Compiled, scoped: Compiled, where: unknown) => {
	if (result._tag !== "Compiled") throw new FuzzFailure(`a valid plan was not compiled (${result._tag})`, { error: result.error })
	const { compiled } = result
	// The scope a real application would get: the same plan over the plain tables.
	if (scoped._tag !== "Compiled") throw new FuzzFailure(`a valid plan over tenant tables was not compiled (${scoped._tag})`, { error: scoped.error })
	const tenantScope = scoped.compiled.tenantScope
	const outcome = await target.run(compiled)
	await withContext({ sql: compiled.sql, parameters: compiled.parameters, tenantScope, outcome, expected: expected.rows }, () => {
		expect(outcome._tag).toBe("Rows")
		if (outcome._tag !== "Rows") return
		const actual = canonical(outcome.rows)
		const want = canonical(expected.rows)
		if (expected.ordered) expect(actual).toEqual(want)
		else expect(sorted(actual)).toEqual(sorted(want))
		if (tenantScope === "single-tenant") {
			// The tenant is the `orgId` param, unless the plan also constrains OrgId itself (`OrgId IN ('org_2')`
			// pins the query to org_2): then it is single-tenant by that, and any one org is right.
			const pinnedElsewhere = /"col":"OrgId"/.test(JSON.stringify(where))
			const foreign = pinnedElsewhere ? [...expected.orgs].slice(1) : [...expected.orgs].filter((org) => org !== orgId)
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

// Keep the original fixed-data properties and pinned inputs; these inputs shrink data and plans together.
describe("generated fixture queries", () => {
	for (const { dialect, target } of targets) {
		for (const [label, data, join] of [
			["empty orders", { orders: [], customers: [] }, undefined],
			["empty inner join", { orders: [{ OrgId: "org_1", Id: 1, Customer: "acme", Amount: 0, Status: "paid", Note: null, Created: Date.UTC(2026, 0, 1) }], customers: [] }, "inner"],
		] as const) {
			it(`constant division is excluded over ${label} (${target.name})`, () => {
				const input: Plan = {
					orgId: "org_1", join, where: [], wrap: false, crossTenant: false,
					shape: { k: "rows", select: [["id", { k: "col", col: "Id" }], ["bad", { k: "arith", op: "div", l: { k: "num", v: 1 }, r: 0 }]], distinct: false, orderBy: [] },
				}
				expect(() => evaluate(input, target.semantics, data)).toThrow(Skip)
				expect(() => evaluate(input, target.semantics, data)).toThrow("division by zero")
			})
		}
		it.skipIf(!target.available)(`empty generated tables (${target.name})`, () => matchesModel(dialect, target, {
			orgId: "org_1", where: [], shape: { k: "rows", select: [["id", { k: "col", col: "Id" }]], distinct: false, orderBy: [] }, wrap: false, crossTenant: false,
		}, { orders: [], customers: [] }))
		it.skipIf(!target.available)(`duplicate generated join keys page deterministically (${target.name})`, () => matchesModel(dialect, target, {
			orgId: "org_1", join: "left", where: [], shape: { k: "rows", select: [["id", { k: "col", col: "Id" }], ["tier", { k: "jcol", col: "Tier" }]], distinct: false,
				orderBy: [["id", "asc"], ["tier", "asc"]], offset: 1, limit: 2 }, wrap: false, crossTenant: false,
		}, {
			orders: [{ OrgId: "org_1", Id: 1, Customer: "acme", Amount: 0, Status: "paid", Note: null, Created: Date.UTC(2026, 0, 1) }],
			customers: ["silver", "bronze", "gold"].map((Tier) => ({ OrgId: "org_1", Name: "acme", Tier })),
		}))
		const options = { ...plainOptions(dialect), depth: 3 }
		const plansName = `generated fixtures: query results agree (${target.name})`
		it.skipIf(!target.available)(plansName, () => property(plansName, fc.record({ fixture, plan: plan(options) }),
			(input) => matchesModel(dialect, target, input.plan, input.fixture), { runs: 100 }), 300_000)
		const unionsName = `generated fixtures: union results agree (${target.name})`
		it.skipIf(!target.available)(unionsName, () => property(unionsName, fc.record({ fixture, plan: unionPlan(options) }),
			(input) => unionMatchesModel(dialect, target, input.plan, input.fixture), { runs: 60 }), 300_000)
	}
})
