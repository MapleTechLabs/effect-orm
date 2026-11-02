// The reference model: what a plan's rows should be, computed in JS over the fixture.
//
// This is the oracle that does not trust the builder. It evaluates a `Plan`
// directly — SQL three-valued logic, the join, grouping, ordering, paging — so a
// query that runs cleanly but answers wrong (a lost parenthesis, a negation
// applied to the wrong side, NULL handled like a value) shows up as a row diff.
//
// Where the databases genuinely differ, the model reads the target's
// `Semantics` (dialects/types.ts) rather than its name, so a new dialect states
// its rules instead of patching this file.
// Inputs the model cannot judge raise `skip` with a reason.
import { coreFixture, type Fixture, type Order, type Customer } from "./fixtures"
import type { Semantics } from "./dialects/types"
import { skip } from "./harness"
import type { Agg, ArithOp, Cond, Expr, Operand, Plan, UnionPlan } from "./plan"

type V = number | string | null
type Bool = boolean | null

interface Row {
	readonly o: Order
	/** The joined customer; `undefined` for an unmatched LEFT JOIN row. */
	readonly c?: Customer
}

interface Env {
	readonly sem: Semantics
	readonly plan: Plan
	readonly joined: boolean
}

const isTime = (e: Expr) => e.k === "col" && e.col === "Created"

/**
 * An integer expression's ClickHouse signedness. ClickHouse keeps unsigned
 * types through `+` and `*` (`Id` is UInt32, a non-negative literal UInt8) and
 * computes `%` across a signed and an unsigned operand in ways no other
 * database does (`-7 % toUInt32(3)` is 0), so the model declines those.
 */
type ChKind = "unsigned" | "signed" | "float"
export const chKind = (e: Expr | number): ChKind => {
	if (typeof e === "number") return !Number.isInteger(e) ? "float" : e >= 0 ? "unsigned" : "signed"
	switch (e.k) {
		case "col":
			return e.col === "Id" ? "unsigned" : "signed"
		case "num":
			return chKind(e.v)
		case "arith": {
			const l = chKind(e.l)
			const r = chKind(e.r)
			if (e.op === "div" || l === "float" || r === "float") return "float"
			if (e.op === "sub") return "signed"
			return l === "unsigned" && r === "unsigned" ? "unsigned" : "signed"
		}
		default:
			return "signed"
	}
}

// Expressions

/**
 * Arithmetic as the SQL text parses it. A chain is not parenthesised —
 * documented in docs/expressions.md ("Arithmetic does not parenthesise"), it
 * follows SQL precedence, not call order — while an argument keeps its own
 * parentheses. So the model flattens the receiver chain to the token sequence
 * the SQL contains, keeps each argument whole, and re-parses with `*` `/` `%`
 * binding tighter than `+` `-`, both left-associative.
 */
const parsed = new WeakSet<Expr>()
const flatten = (e: Expr): Array<Expr | ArithOp> =>
	e.k === "arith" ? [...flatten(e.l), e.op, typeof e.r === "number" ? ({ k: "num", v: e.r } as Expr) : e.r] : [e]
const asParsed = (e: Expr & { k: "arith" }): Expr => {
	const tokens = flatten(e)
	const node = (op: ArithOp, l: Expr, r: Expr): Expr => {
		const made: Expr = { k: "arith", op, l, r }
		parsed.add(made)
		return made
	}
	const terms: Array<Expr> = []
	const ops: Array<ArithOp> = []
	let current = tokens[0] as Expr
	for (let i = 1; i < tokens.length; i += 2) {
		const op = tokens[i] as ArithOp
		const operand = tokens[i + 1] as Expr
		if (op === "mul" || op === "div" || op === "mod") current = node(op, current, operand)
		else {
			terms.push(current)
			ops.push(op)
			current = operand
		}
	}
	terms.push(current)
	return ops.reduce((acc, op, j) => node(op, acc, terms[j + 1]!), terms[0]!)
}

const evalExpr = (env: Env, row: Row, e: Expr): V => {
	switch (e.k) {
		case "col":
			return row.o[e.col]
		case "jcol":
			if (row.c !== undefined) return row.c[e.col]
			// e.g. ClickHouse with join_use_nulls=0 fills a missing row with column defaults.
			return env.sem.missingJoinColumn === "default" ? "" : null
		case "num":
		case "str":
			return e.v
		case "coalesce":
			return evalExpr(env, row, e.e) ?? evalExpr(env, row, e.fallback)
		case "arith": {
			if (!parsed.has(e)) return evalExpr(env, row, asParsed(e))
			const l = evalExpr(env, row, e.l) as number | null
			const r = typeof e.r === "number" ? e.r : (evalExpr(env, row, e.r) as number | null)
			if (l === null || r === null) return null
			switch (e.op) {
				case "add":
					return l + r
				case "sub":
					return l - r
				case "mul":
					return l * r
				case "div":
					if (r === 0) skip("division by zero")
					// `/` is float division on ClickHouse, integer division of two Postgres integers.
					return env.sem.integerDivision === "truncate" ? Math.trunc(l / r) : l / r
				case "mod":
					if (r === 0) skip("division by zero")
					if (env.sem.modulo === "integer" && [chKind(e.l), chKind(e.r)].includes("float")) skip("% casting a float operand to an integer")
					if (env.sem.modulo === "clickhouse") {
						const kinds = new Set([chKind(e.l), chKind(e.r)])
						if (kinds.has("unsigned") && kinds.has("signed")) skip("ClickHouse % across signed and unsigned")
						// Not IEEE fmod: `3 % (27 / 99)` is 0 on ClickHouse, 2.2e-16 by fmod.
						if (kinds.has("float")) skip("ClickHouse % of a float")
					}
					// Both databases truncate towards zero, like JS `%`.
					return l % r
			}
		}
	}
}

/** Strings compare by UTF-8 bytes on every target (ClickHouse always, Postgres under the C collation). */
const encoder = new TextEncoder()
const compareStrings = (a: string, b: string): number => {
	const x = encoder.encode(a)
	const y = encoder.encode(b)
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
	return x.length - y.length
}
const compare = (a: number | string, b: number | string): number =>
	typeof a === "number" && typeof b === "number" ? a - b : compareStrings(String(a), String(b))

const evalOperand = (env: Env, row: Row, op: Operand): V => {
	switch (op.k) {
		case "value":
			return op.v
		case "time":
			return op.ms
		case "param":
			return op.v
		case "expr":
			return evalExpr(env, row, op.e)
	}
}

// Conditions (three-valued)

const not3 = (b: Bool): Bool => (b === null ? null : !b)
const and3 = (bs: ReadonlyArray<Bool>): Bool => (bs.includes(false) ? false : bs.includes(null) ? null : true)
const or3 = (bs: ReadonlyArray<Bool>): Bool => (bs.includes(true) ? true : bs.includes(null) ? null : false)

const likeRegex = (pattern: string, caseInsensitive: boolean): RegExp => {
	let source = ""
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!
		if (ch === "\\") {
			const next = pattern[i + 1]
			if (next === undefined) skip("LIKE pattern ends in an escape")
			source += next!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			i++
		} else if (ch === "%") source += "[\\s\\S]*"
		else if (ch === "_") source += "[\\s\\S]"
		else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
	}
	return new RegExp(`^${source}$`, caseInsensitive ? "iu" : "u")
}

const evalCond = (env: Env, row: Row, c: Cond): Bool => {
	switch (c.k) {
		case "const":
			return c.v
		case "tenant": {
			const org = c.side === "orders" ? row.o.OrgId : row.c?.OrgId ?? (env.sem.missingJoinColumn === "default" ? "" : null)
			return org === null ? null : org === env.plan.orgId
		}
		case "not":
			return not3(evalCond(env, row, c.c))
		case "and":
			return and3(c.cs.map((x) => evalCond(env, row, x)))
		case "or":
			return or3(c.cs.map((x) => evalCond(env, row, x)))
		case "null": {
			const isNull = evalExpr(env, row, c.e) === null
			return c.op === "isNull" ? isNull : !isNull
		}
		case "cmp": {
			const l = evalExpr(env, row, c.l)
			const r = evalOperand(env, row, c.r)
			if (l === null || r === null) return null
			const d = compare(l, r)
			switch (c.op) {
				case "eq":
					return d === 0
				case "neq":
					return d !== 0
				case "gt":
					return d > 0
				case "gte":
					return d >= 0
				case "lt":
					return d < 0
				case "lte":
					return d <= 0
			}
		}
		case "like": {
			const l = evalExpr(env, row, c.l) as string | null
			if (l === null) return null
			// Case folding beyond ASCII and `_` over multi-byte text differ between the two; not modelled.
			if (/[^\x00-\x7f]/.test(l)) skip("LIKE over non-ASCII text")
			const matched = likeRegex(c.pattern, c.op === "ilike" || env.sem.likeIgnoresCase).test(l)
			return c.op === "notLike" ? !matched : matched
		}
		case "between": {
			const e = evalExpr(env, row, c.e)
			const lo = evalOperand(env, row, c.lo)
			const hi = evalOperand(env, row, c.hi)
			const inside = and3([e === null || lo === null ? null : compare(e, lo) >= 0, e === null || hi === null ? null : compare(e, hi) <= 0])
			return c.neg ? not3(inside) : inside
		}
		case "in": {
			// An empty list is written `1 = 0` / `1 = 1`: constant, whatever the left side is.
			if (c.values.length === 0) return c.neg
			const e = evalExpr(env, row, c.e)
			if (e === null) return null
			const found = c.values.some((v) => compare(e, v) === 0)
			return c.neg ? !found : found
		}
	}
}

// Queries

const sourceRows = (env: Env, fixture: Fixture): ReadonlyArray<Row> =>
	fixture.orders.flatMap((o): Array<Row> => {
		if (env.plan.join === undefined) return [{ o }]
		const matches = fixture.customers.filter((c) => c.OrgId === o.OrgId && c.Name === o.Customer)
		if (matches.length > 0) return matches.map((c) => ({ o, c }))
		return env.plan.join === "left" ? [{ o }] : []
	})

type OutRow = Record<string, V>

const nullsFirst = (sem: Semantics, dir: "asc" | "desc") => sem.nulls[dir] === "first"

const sortRows = (env: Env, rows: Array<OutRow>, orderBy: ReadonlyArray<readonly [string, "asc" | "desc"]>) =>
	rows.sort((a, b) => {
		for (const [alias, dir] of orderBy) {
			const x = a[alias] ?? null
			const y = b[alias] ?? null
			if (x === null && y === null) continue
			if (x === null || y === null) {
				const first = nullsFirst(env.sem, dir)
				return (x === null) === first ? -1 : 1
			}
			const d = compare(x, y)
			if (d !== 0) return dir === "asc" ? d : -d
		}
		return 0
	})

const page = <A>(rows: ReadonlyArray<A>, shape: { readonly limit?: number | undefined; readonly offset?: number | undefined }): ReadonlyArray<A> => {
	const start = shape.offset ?? 0
	return rows.slice(start, shape.limit === undefined ? undefined : start + shape.limit)
}

const outValue = (e: Expr, v: V): V => (v !== null && isTime(e) ? `@${new Date(v as number).toISOString()}` : v)

const evalAgg = (env: Env, rows: ReadonlyArray<Row>, agg: Agg, global: boolean): V => {
	switch (agg.k) {
		case "count":
			return rows.length
		case "countIf":
			return rows.filter((row) => evalCond(env, row, agg.c) === true).length
		default: {
			const values = rows.map((row) => evalExpr(env, row, agg.e)).filter((v): v is number => v !== null)
			if (values.length === 0) return global && env.sem.emptyAggregate === "unmodelled" ? skip("aggregate over no rows") : null
			if (agg.k === "sum") return values.reduce((a, b) => a + b, 0)
			return agg.k === "min" ? Math.min(...values) : Math.max(...values)
		}
	}
}

export interface ModelResult {
	readonly rows: ReadonlyArray<OutRow>
	/** Whether the plan fixes row order, so rows compare as a list rather than a multiset. */
	readonly ordered: boolean
	/** The orgs of every source row that reached the result: the tenant oracle's evidence. */
	readonly orgs: ReadonlySet<string>
}

/** Every arithmetic node in the plan: plans are plain data, so a walk reaches all of them. */
const ariths = (value: unknown): Array<Expr> => {
	if (Array.isArray(value)) return value.flatMap(ariths)
	if (value === null || typeof value !== "object") return []
	const own = (value as Expr).k === "arith" ? [value as Expr] : []
	return [...own, ...Object.values(value).flatMap(ariths)]
}

/** Constant folding is independent of relation cardinality, including an empty join. */
const constant = (expr: Expr): boolean => {
	switch (expr.k) {
		case "num":
		case "str": return true
		case "arith": return constant(expr.l) && (typeof expr.r === "number" || constant(expr.r))
		case "coalesce": return constant(expr.e) && constant(expr.fallback)
		default: return false
	}
}

export const evaluate = (plan: Plan, sem: Semantics, fixture: Fixture = coreFixture): ModelResult => {
	const env: Env = { sem, plan, joined: plan.join !== undefined }
	// A database may evaluate any expression on any row — or fold a constant one at plan time — before
	// filtering decides it was not needed. So a division by zero anywhere is a division by zero.
	const all = ariths(plan)
	// A constant expression never reads this row. Reuse a real fixture row so the evaluator
	// can check folded subexpressions even when the input fixture or its inner join is empty.
	const constantRow: Row = { o: coreFixture.orders[0]! }
	for (const e of all) if (constant(e)) evalExpr(env, constantRow, e)
	for (const row of sourceRows(env, fixture)) for (const e of all) evalExpr(env, row, e)
	const filtered = sourceRows(env, fixture).filter((row) => and3(plan.where.map((c) => evalCond(env, row, c))) === true)
	const orgs = new Set(filtered.flatMap((row) => [row.o.OrgId, ...(row.c ? [row.c.OrgId] : [])]))
	const shape = plan.shape

	let rows: Array<OutRow>
	if (shape.k === "rows") {
		rows = filtered.map((row) => Object.fromEntries(shape.select.map(([alias, e]) => [alias, outValue(e, evalExpr(env, row, e))])))
		if (shape.distinct) {
			const seen = new Set<string>()
			rows = rows.filter((row) => {
				const key = JSON.stringify(row)
				return seen.has(key) ? false : (seen.add(key), true)
			})
		}
	} else {
		const groups = new Map<string, Array<Row>>()
		if (shape.keys.length === 0) groups.set("", [...filtered])
		for (const row of shape.keys.length === 0 ? [] : filtered) {
			const key = JSON.stringify(shape.keys.map(([, e]) => evalExpr(env, row, e)))
			groups.set(key, [...(groups.get(key) ?? []), row])
		}
		rows = [...groups.values()]
			.filter((group) =>
				shape.having.every((h) => {
					const v = evalAgg(env, group, h.agg, false)
					return v !== null && evalCond(env, group[0]!, { k: "cmp", op: h.op, l: { k: "num", v: v as number }, r: { k: "value", v: h.v } }) === true
				}),
			)
			.map((group) => ({
				...Object.fromEntries(shape.keys.map(([alias, e]) => [alias, outValue(e, evalExpr(env, group[0]!, e))])),
				...Object.fromEntries(shape.aggs.map(([alias, agg]) => [alias, evalAgg(env, group, agg, shape.keys.length === 0)])),
			}))
	}

	const uniqueKeys = shape.k === "rows" ? (plan.join === undefined ? ["id"] : shape.select.map(([alias]) => alias)) : shape.keys.map(([alias]) => alias)
	const total = uniqueKeys.length > 0 && uniqueKeys.every((key) => shape.orderBy.some(([alias]) => alias === key))
	sortRows(env, rows, shape.orderBy)
	return { rows: page(rows, shape), ordered: total && !plan.wrap, orgs }
}

/**
 * A union: each branch's rows (its own ORDER BY and LIMIT applied first),
 * concatenated, then the union's ORDER BY, LIMIT and OFFSET. Rows compare as
 * a list only when the union orders by every alias.
 */
export const evaluateUnion = (plan: UnionPlan, sem: Semantics, fixture: Fixture = coreFixture): ModelResult => {
	const parts = plan.branches.map((branch) => evaluate(branch, sem, fixture))
	const rows = parts.flatMap((part) => [...part.rows])
	const first = plan.branches[0]!
	const aliases = first.shape.k === "rows" ? first.shape.select.map(([alias]) => alias) : []
	sortRows({ sem, plan: first, joined: false }, rows, plan.orderBy)
	const total = plan.orderBy.length > 0 && aliases.every((alias) => plan.orderBy.some(([key]) => key === alias))
	return { rows: page(rows, plan), ordered: total, orgs: new Set(parts.flatMap((part) => [...part.orgs])) }
}
