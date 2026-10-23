// Compile-time properties: no database, so these run thousands of plans a second.
//
//   plans compile cleanly   a well-typed plan is never refused, and nothing throws
//   deterministic           compiling the same plan twice gives the same SQL and params
//   no leaked JS            no `undefined`, `[object …]`, `NaN` or `__PARAM_` in the SQL
//   placeholders line up    Postgres `$n` are exactly 1..parameters.length
//   tenant scope            `.crossTenant()` is always cross-tenant; a top-level tenant
//                           predicate on an unjoined query is always single-tenant
//   hostile values          any JS value where a value goes is compiled or refused with a
//                           typed QueryBuilderError — never a throw, never a defect
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { Effect, Exit } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { CoreContext } from "../core-cases"
import { scopeContexts as contexts } from "./contexts"
import { compilePlan } from "./build"
import { FuzzFailure, property, skipKnown } from "./harness"
import { knownHostileIssue, knownPlanIssue } from "./known-issues"
import { nastyOptions, ORDER_COLUMNS, plan, type OrderColumn, type Plan } from "./plan"

const stringsIn = (value: unknown): Array<string> =>
	typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : []

const serialize = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Date ? `Date(${v.getTime()})` : v))

const compiles = (ctx: CoreContext, input: Plan) => {
	const known = knownPlanIssue({ target: ctx.dialect, plan: input })
	if (known !== undefined) skipKnown(known)
	const first = compilePlan(ctx, input)
	if (first._tag !== "Compiled") throw new FuzzFailure(`a valid plan was not compiled (${first._tag})`, { error: first.error })
	const { compiled } = first
	const context = { sql: compiled.sql, parameters: serialize(compiled.parameters), tenantScope: compiled.tenantScope }
	const fail = (message: string): never => {
		throw new FuzzFailure(message, context)
	}

	const second = compilePlan(ctx, input)
	if (second._tag !== "Compiled" || second.compiled.sql !== compiled.sql || serialize(second.compiled.parameters) !== serialize(compiled.parameters)) {
		fail("compiling the same plan twice gave different output")
	}

	const strings = stringsIn(input)
	for (const token of ["undefined", "[object ", "NaN", "Infinity", "__PARAM_"]) {
		if (compiled.sql.includes(token) && !strings.some((s) => s.includes(token))) fail(`the SQL contains ${JSON.stringify(token)}`)
	}

	if (ctx.dialect === "postgres" && !strings.some((s) => s.includes("$"))) {
		const used = new Set([...compiled.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))
		const expected = Array.from({ length: compiled.parameters.length }, (_, i) => i + 1)
		if (used.size !== expected.length || !expected.every((n) => used.has(n))) {
			fail(`placeholders ${[...used].sort((a, b) => a - b).join(",")} do not match ${compiled.parameters.length} parameters`)
		}
	}

	if (input.crossTenant && compiled.tenantScope !== "cross-tenant") fail(".crossTenant() did not make the query cross-tenant")
	const pinned = input.where.some((c) => c.k === "tenant" && c.side === "orders")
	if (pinned && input.join === undefined && !input.crossTenant && compiled.tenantScope !== "single-tenant") {
		fail("a top-level tenant predicate on an unjoined query did not make it single-tenant")
	}
}

describe("compile properties", () => {
	for (const ctx of Object.values(contexts)) {
		const name = `plans compile cleanly (${ctx.dialect})`
		it(name, () => property(name, plan(nastyOptions(ctx.dialect)), (input) => compiles(ctx, input), { runs: 300 }), 120_000)
	}
})

// Hostile values

/** Values no column type accepts, plus near-misses that some do. */
const hostile: fc.Arbitrary<unknown> = fc.oneof(
	fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true }),
	fc.bigInt(),
	fc.constantFrom<unknown>(Number.NaN, Infinity, -Infinity, -0, 2 ** 53, 1e308, 5e-324, new Date(Number.NaN), Symbol("s"), () => 1, undefined, null, "", "2026-13-45 99:99:99", { _brand: "Expr" }, { _brand: "Expr", toFragment: 1 }),
)

type HostileSite = "lit" | "add" | "eq" | "neq" | "gt" | "in_" | "notIn" | "between" | "like" | "param.int" | "param.float" | "param.string" | "param.bool" | "param.dateTime" | "param.of" | "select"
export interface HostileInput {
	readonly dialect: "clickhouse" | "postgres"
	readonly column: OrderColumn
	readonly site: HostileSite
	readonly value: unknown
}

const hostileQuery = (ctx: CoreContext, input: HostileInput) => {
	const { site, value, column } = input
	const params: Record<string, unknown> = { orgId: "org_1", h: value }
	let q: any = ctx.from(ctx.orders)
	if (site === "select") return { query: q.select(() => ({ id: CH.lit(1), bad: value })), params }
	if (site === "lit") return { query: q.select(() => ({ id: CH.lit(value as never) })), params }
	if (site === "add") return { query: q.select(($: any) => ({ id: $.Amount.add(value) })), params }
	q = q.select(($: any) => ({ id: $.Id }))
	if (site.startsWith("param.")) {
		const kind = site.slice("param.".length)
		const marker = kind === "of" ? CH.param.of((ctx.orders as any).columns[column], "h") : (CH.param as any)[kind]("h")
		return { query: q.where(($: any) => [$[column].eq(marker)]), params }
	}
	return {
		query: q.where(($: any) => [site === "in_" || site === "notIn" ? $[column][site](value, value) : site === "between" ? $[column].between(value, value) : $[column][site](value)]),
		params,
	}
}

const hostileInput = (dialect: "clickhouse" | "postgres"): fc.Arbitrary<HostileInput> =>
	fc.record({
		dialect: fc.constant(dialect),
		column: fc.constantFrom(...(Object.keys(ORDER_COLUMNS) as OrderColumn[])),
		site: fc.constantFrom<HostileSite>("lit", "add", "eq", "neq", "gt", "in_", "notIn", "between", "like", "param.int", "param.float", "param.string", "param.bool", "param.dateTime", "param.of", "select"),
		value: hostile,
	})

const neverThrows = (ctx: CoreContext, input: HostileInput) => {
	const known = knownHostileIssue(input)
	if (known !== undefined) skipKnown(known)
	let exit: Exit.Exit<unknown, unknown>
	try {
		const { query, params } = hostileQuery(ctx, input)
		exit = Effect.runSyncExit(((ctx.dialect === "clickhouse" ? CH.compile : PG.compile) as any)(query, params))
	} catch (error) {
		throw new FuzzFailure("the builder threw instead of failing with a QueryBuilderError", {
			error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split("\n").slice(1, 6).join("\n")}` : String(error),
		})
	}
	if (Exit.isFailure(exit)) {
		// src/ch/errors.ts: a value a request could supply fails with a QueryBuilderError; what is only ever
		// written in source (the shape of a select record) may die with a QueryBuilderDefect. Nothing else.
		const sourceSite = input.site === "select"
		const typed = exit.cause.reasons.every((reason) => {
			const tag = String(((reason as any).error ?? (reason as any).defect)?._tag)
			return (reason._tag === "Fail" && tag.endsWith("QueryBuilderError")) || (sourceSite && reason._tag === "Die" && tag.endsWith("QueryBuilderDefect"))
		})
		if (!typed) throw new FuzzFailure("compile died or failed with something other than a QueryBuilderError", { cause: String(exit.cause) })
	}
	expect(true).toBe(true)
}

describe("hostile values", () => {
	for (const ctx of Object.values(contexts)) {
		const name = `hostile values are refused, never thrown (${ctx.dialect})`
		it(name, () => property(name, hostileInput(ctx.dialect), (input) => neverThrows(ctx, input), { runs: 500 }), 120_000)
	}
})
