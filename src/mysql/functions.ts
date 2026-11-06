import { Schema } from "effect"
import { makeExpr, type Condition, type Expr } from "../ch/expr"
import { schemaOf } from "../ch/define-fn"
import { builtins, type MysqlOnly } from "../ch/functions/builtin"
import { CHNumber } from "../ch/types"
import { MysqlInteger } from "./types"
import { compile } from "../sql/sql-fragment"

// Each result carries `MysqlOnly`, as `builtins("mysql", …)` refuses them for
// another dialect at compile: the type refuses them there too.
const aggregate = builtins("mysql", "aggregate")
const scalar = builtins("mysql", "scalar")
const sql = (expr: Expr<unknown> | Condition): string => compile(expr.toFragment())
// SUM and AVG of integers are DECIMAL, which mysql2 sends as a string.
const nullableNumber = Schema.NullOr(CHNumber)
const integer = MysqlInteger

export const count = (): Expr<number, MysqlOnly> => makeExpr(aggregate.lazy(() => "COUNT(*)", "count"), integer)
export const countDistinct = <P>(expr: Expr<unknown, P>): Expr<number, P | MysqlOnly> =>
	makeExpr(aggregate.lazy(() => `COUNT(DISTINCT ${sql(expr)})`, "count"), integer)
export const countIf = <P>(condition: Condition<P>): Expr<number, P | MysqlOnly> =>
	makeExpr(aggregate.lazy(() => `COUNT(CASE WHEN ${sql(condition)} THEN 1 END)`, "count"), integer)
export const sum = <P>(expr: Expr<number | null, P>): Expr<number | null, P | MysqlOnly> =>
	makeExpr(aggregate.lazy(() => `SUM(${sql(expr)})`, "sum"), nullableNumber)
export const avg = <P>(expr: Expr<number | null, P>): Expr<number | null, P | MysqlOnly> =>
	makeExpr(aggregate.lazy(() => `AVG(${sql(expr)})`, "avg"), nullableNumber)
export const min = <A, P>(expr: Expr<A, P>): Expr<A | null, P | MysqlOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `MIN(${sql(expr)})`, "min"), schema === undefined ? undefined : Schema.NullOr(schema))
}
export const max = <A, P>(expr: Expr<A, P>): Expr<A | null, P | MysqlOnly> => {
	const schema = schemaOf<A>(expr)
	return makeExpr(aggregate.lazy(() => `MAX(${sql(expr)})`, "max"), schema === undefined ? undefined : Schema.NullOr(schema))
}
export const lower = <P>(expr: Expr<string | null, P>): Expr<string | null, P | MysqlOnly> =>
	makeExpr(scalar.lazy(() => `LOWER(${sql(expr)})`, "lower"), Schema.NullOr(Schema.String))
export const upper = <P>(expr: Expr<string | null, P>): Expr<string | null, P | MysqlOnly> =>
	makeExpr(scalar.lazy(() => `UPPER(${sql(expr)})`, "upper"), Schema.NullOr(Schema.String))
/** Text length in characters (`CHAR_LENGTH`; MySQL's `LENGTH` counts bytes). */
export const length = <P>(expr: Expr<string | null, P>): Expr<number | null, P | MysqlOnly> =>
	makeExpr(scalar.lazy(() => `CHAR_LENGTH(${sql(expr)})`, "length"), Schema.NullOr(integer))
export const coalesce = <A, P1, P2>(first: Expr<A | null, P1>, fallback: Expr<A, P2>): Expr<A, P1 | P2 | MysqlOnly> =>
	makeExpr(scalar.lazy(() => `COALESCE(${sql(first)}, ${sql(fallback)})`, "coalesce"), schemaOf<A>(fallback))
