// A plan as builder calls, for either dialect.
//
// The builder is driven through its public, typed surface exactly as an
// application would; `any` here only erases the static types a random plan
// cannot have. Params are named up front from the plan's structure so that
// compiling the same plan twice resolves the same names to the same values.
import { DateTime, Effect, Exit } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { CoreContext } from "../core-cases"
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

export const buildPlan = (ctx: CoreContext, plan: Plan): Built => {
	const { names, params } = nameParams(plan)

	const expr = ($: any, e: Expr): any => {
		switch (e.k) {
			case "col":
				return $[e.col]
			case "jcol":
				return $.c[e.col]
			case "num":
			case "str":
				return CH.lit(e.v as never)
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
				return (CH.param as any)[op.kind](names.get(op)!)
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
				if (c.style === "fn") return (c.k === "and" ? CH.and : CH.or)(...parts)
				return parts.slice(1).reduce((acc, part) => acc[c.k](part), parts[0])
			}
			case "not":
				return CH.not(cond($, c.c))
			case "const":
				return CH.rawCond(c.v ? "1 = 1" : "1 = 0")
			case "tenant":
				return (c.side === "orders" ? $ : $.c).OrgId.eq(CH.param.string("orgId"))
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
	if (plan.wrap === "all") q = CH.fromQuery(q, "w").select()
	if (plan.wrap === "names") {
		const names = shape.k === "rows" ? shape.select.map(([alias]) => alias) : [...shape.keys, ...shape.aggs].map(([alias]) => alias)
		q = CH.fromQuery(q, "w").select(...names)
	}
	return { query: q, params }
}

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
export const compilePlan = (ctx: CoreContext, plan: Plan): Compiled => {
	try {
		const { query, params } = buildPlan(ctx, plan)
		const compile = ctx.dialect === "clickhouse" ? CH.compile : PG.compile
		const exit = Effect.runSyncExit((compile as any)(query, params) as Effect.Effect<CH.CompiledQuery<any>, unknown>)
		if (Exit.isSuccess(exit)) return { _tag: "Compiled", compiled: exit.value }
		const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
		return failure !== undefined
			? { _tag: "Refused", error: String((failure as any).error?.message ?? failure) }
			: { _tag: "Defect", error: String(exit.cause) }
	} catch (error) {
		return { _tag: "Threw", error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }
	}
}
