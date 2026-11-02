import { Schema } from "effect"
import { makeExpr, type Condition, type Expr } from "../ch/expr"
import { schemaOf } from "../ch/define-fn"
import { builtins, type SqliteOnly } from "../ch/functions/builtin"
import { compile } from "../sql/sql-fragment"

// Each result carries `SqliteOnly`, as `builtins("sqlite", …)` refuses them for
// another dialect at compile: the type refuses them there too.
const aggregate = builtins("sqlite", "aggregate")
const scalar = builtins("sqlite", "scalar")
const sql = (expr: Expr<unknown> | Condition): string => compile(expr.toFragment())
const nullableNumber = Schema.NullOr(Schema.Finite)

export const count = (): Expr<number, SqliteOnly> => makeExpr(aggregate.lazy(() => "count(*)", "count"), Schema.Int)
export const countDistinct = <P>(expr: Expr<unknown, P>): Expr<number, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `count(DISTINCT ${sql(expr)})`, "count"), Schema.Int)
export const countIf = <P>(condition: Condition<P>): Expr<number, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `count(*) FILTER (WHERE ${sql(condition)})`, "count"), Schema.Int)
export const sum = <P>(expr: Expr<number | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `sum(${sql(expr)})`, "sum"), nullableNumber)
export const avg = <P>(expr: Expr<number | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(aggregate.lazy(() => `avg(${sql(expr)})`, "avg"), nullableNumber)
export const min = <A, P>(expr: Expr<A, P>): Expr<A | null, P | SqliteOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `min(${sql(expr)})`, "min"), schema === undefined ? undefined : Schema.NullOr(schema))
}
export const max = <A, P>(expr: Expr<A, P>): Expr<A | null, P | SqliteOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `max(${sql(expr)})`, "max"), schema === undefined ? undefined : Schema.NullOr(schema))
}
export const lower = <P>(expr: Expr<string | null, P>): Expr<string | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `lower(${sql(expr)})`, "lower"), Schema.NullOr(Schema.String))
export const upper = <P>(expr: Expr<string | null, P>): Expr<string | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `upper(${sql(expr)})`, "upper"), Schema.NullOr(Schema.String))
/** Text length in SQLite characters, or blob length in bytes. */
export const length = <P>(expr: Expr<string | Uint8Array | null, P>): Expr<number | null, P | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `length(${sql(expr)})`, "length"), Schema.NullOr(Schema.Int))
export const coalesce = <A, P1, P2>(first: Expr<A | null, P1>, fallback: Expr<A, P2>): Expr<A, P1 | P2 | SqliteOnly> =>
	makeExpr(scalar.lazy(() => `coalesce(${sql(first)}, ${sql(fallback)})`, "coalesce"), schemaOf<A>(fallback))
