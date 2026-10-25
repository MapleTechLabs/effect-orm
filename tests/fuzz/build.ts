// A plan as builder calls, for any dialect.
//
// The builder is driven through its public, typed surface exactly as an
// application would; `any` here only erases the static types a random plan
// cannot have. Params are named up front from the plan's structure so that
// compiling the same plan twice resolves the same names to the same values.
import { DateTime, Effect, Exit } from "effect"
import type * as CH from "@maple-dev/effect-orm/clickhouse"
import type { CoreContext } from "../core-cases"
import type { FuzzDialect } from "./dialects/types"
import type { Agg, Cond, Expr, Operand, Plan } from "./plan"

const pad = (n: number, width = 2) => String(n).padStart(width, "0")
/** `YYYY-MM-DD hh:mm:ss.sss` in UTC: the string form a DateTime comparison accepts. */
export const timeString = (ms: number): string => {
	const d = new Date(ms)
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

/** Every param operand in the plan, in a fixed walk order, with the name it compiles as. */
const nameParams = (plan: Plan): { readonly names: Map<Operand, string>; readonly params: Record<string, unknown> } => {
	const names = new Map<Operand, string>()
	const params: Record<string, unknown> = { orgId: plan.orgId }
	const operand = (op: Operand) => {
		if (op.k === "expr") return expr(op.e)
		if (op.k !== "param") return
		const name = `p${names.size}`
		names.set(op, name)
		params[name] = op.kind === "dateTime" ? DateTime.makeUnsafe(op.v as number) : op.v
	}
	const expr = (e: Expr): void => {
		if (e.k === "arith") {
			expr(e.l)
			if (typeof e.r !== "number") expr(e.r)
		} else if (e.k === "coalesce") {
			expr(e.e)
			expr(e.fallback)
		}
	}
	const cond = (c: Cond): void => {
		switch (c.k) {
			case "cmp":
				expr(c.l)
				return operand(c.r)
			case "like":
			case "in":
				return expr(c.k === "like" ? c.l : c.e)
			case "null":
				return expr(c.e)
			case "between":
				expr(c.e)
				operand(c.lo)
				return operand(c.hi)
			case "and":
			case "or":
				return c.cs.forEach(cond)
			case "not":
				return cond(c.c)
		}
	}
	const agg = (a: Agg) => (a.k === "countIf" ? cond(a.c) : a.k === "count" ? undefined : expr(a.e))
	plan.where.forEach(cond)
	if (plan.shape.k === "rows") plan.shape.select.forEach(([, e]) => expr(e))
	else {
		plan.shape.keys.forEach(([, e]) => expr(e))
		plan.shape.aggs.forEach(([, a]) => agg(a))
		plan.shape.having.forEach((h) => agg(h.agg))
	}
	return { names, params }
}

export interface Built {
	readonly query: CH.CHQuery<any, any, any>
	readonly params: Record<string, unknown>
}

export const buildPlan = (dialect: FuzzDialect, ctx: CoreContext, plan: Plan): Built => {
	const { lit, param, and, or, not, rawCond, fromQuery } = dialect.module
	const { names, params } = nameParams(plan)

	const expr = ($: any, e: Expr): any => {
		switch (e.k) {
			case "col":
				return $[e.col]
			case "jcol":
				return $.c[e.col]
			case "num":
			case "str":
				return lit(e.v as never)
			case "arith":
				return expr($, e.l)[e.op](typeof e.r === "number" ? e.r : expr($, e.r))
			case "coalesce":
				return ctx.fn.coalesce(expr($, e.e), expr($, e.fallback))
		}
	}
	const operand = ($: any, op: Operand): any => {
		switch (op.k) {
			case "value":
				return op.v
			case "time":
				return op.form === "DateTime" ? DateTime.makeUnsafe(op.ms) : op.form === "Date" ? new Date(op.ms) : timeString(op.ms)
			case "param":
				return (param as any)[op.kind](names.get(op)!)
			case "expr":
				return expr($, op.e)
		}
	}
	const cond = ($: any, c: Cond): any => {
		switch (c.k) {
			case "cmp":
				return expr($, c.l)[c.op](operand($, c.r))
			case "like":
				return expr($, c.l)[c.op](c.pattern)
			case "null":
				return expr($, c.e)[c.op]()
			case "between":
				return expr($, c.e)[c.neg ? "notBetween" : "between"](operand($, c.lo), operand($, c.hi))
			case "in":
				return expr($, c.e)[c.neg ? "notIn" : "in_"](...c.values)
			case "and":
			case "or": {
				const parts = c.cs.map((x) => cond($, x))
				if (c.style === "fn") return (c.k === "and" ? and : or)(...parts)
				return parts.slice(1).reduce((acc, part) => acc[c.k](part), parts[0])
			}
			case "not":
				return not(cond($, c.c))
			case "const":
				return rawCond(c.v ? "1 = 1" : "1 = 0")
			case "tenant":
				return (c.side === "orders" ? $ : $.c).OrgId.eq(param.string("orgId"))
		}
	}
	const agg = ($: any, a: Agg): any => {
		switch (a.k) {
			case "count":
				return ctx.fn.count()
			case "countIf":
				return ctx.fn.countIf(cond($, a.c))
			case "sum":
			case "min":
			case "max":
				return ctx.fn[a.k](expr($, a.e))
		}
	}

	let q: any = ctx.from(ctx.orders)
	if (plan.join !== undefined) {
		q = q[plan.join === "inner" ? "innerJoin" : "leftJoin"](ctx.customers, "c", (o: any, c: any) =>
			o.Customer.eq(c.Name).and(o.OrgId.eq(c.OrgId)),
		)
	}
	const shape = plan.shape
	if (shape.k === "rows") {
		q = q.select(($: any) => Object.fromEntries(shape.select.map(([alias, e]) => [alias, expr($, e)])))
		if (shape.distinct) q = q.distinct()
	} else {
		q = q.select(($: any) => ({
			...Object.fromEntries(shape.keys.map(([alias, e]) => [alias, expr($, e)])),
			...Object.fromEntries(shape.aggs.map(([alias, a]) => [alias, agg($, a)])),
		}))
		if (shape.keys.length > 0) q = q.groupBy(...shape.keys.map(([alias]) => alias))
		if (shape.having.length > 0) q = q.having(($: any) => shape.having.map((h) => agg($, h.agg)[h.op](h.v)))
	}
	if (plan.where.length > 0) q = q.where(($: any) => plan.where.map((c) => cond($, c)))
	if (shape.orderBy.length > 0) q = q.orderBy(...shape.orderBy.map(([alias, dir]) => [alias, dir]))
	if (shape.limit !== undefined) q = q.limit(shape.limit)
	if (shape.offset !== undefined) q = q.offset(shape.offset)
	if (plan.crossTenant) q = q.crossTenant()
	if (plan.wrap === "all") q = fromQuery(q, "w").select()
	if (plan.wrap === "names") {
		const names = shape.k === "rows" ? shape.select.map(([alias]) => alias) : [...shape.keys, ...shape.aggs].map(([alias]) => alias)
		q = fromQuery(q, "w").select(...names)
	}
	return { query: q, params }
}

/**
 * The dialect's context over the plain tables, with no fixture CTEs.
 *
 * The fixture CTEs are bare SQL the builder cannot see into, and a CTE named
 * `orders` shadows the `orders` table, so a query compiled against them never
 * reports a meaningful tenant scope. Compiled here, the scope the builder
 * reports is the one a real application gets.
 */
export const scopeContext = (dialect: FuzzDialect): CoreContext => ({ ...dialect.context, from: (table) => dialect.module.from(table) as any })

export type Compiled =
	| { readonly _tag: "Compiled"; readonly compiled: CH.CompiledQuery<any> }
	| { readonly _tag: "Refused"; readonly error: string }
	| { readonly _tag: "Defect"; readonly error: string }
	| { readonly _tag: "Threw"; readonly error: string }

/**
 * Compile through the Effect API and classify the outcome. A typed
 * `QueryBuilderError` is `Refused`; a die is a `Defect`; an exception that
 * escapes `compile` — or the builder calls before it — is `Threw`.
 */
export const compilePlan = (dialect: FuzzDialect, ctx: CoreContext, plan: Plan): Compiled => {
	try {
		const { query, params } = buildPlan(dialect, ctx, plan)
		const exit = Effect.runSyncExit(dialect.module.compile(query, params))
		if (Exit.isSuccess(exit)) return { _tag: "Compiled", compiled: exit.value }
		const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
		return failure !== undefined
			? { _tag: "Refused", error: String((failure as any).error?.message ?? failure) }
			: { _tag: "Defect", error: String(exit.cause) }
	} catch (error) {
		return { _tag: "Threw", error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }
	}
}
