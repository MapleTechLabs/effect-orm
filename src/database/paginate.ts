// Keyset (cursor) pagination over a built query.
//
// A page is the query with a seek added: `WHERE (a, b) > (?, ?)` from the
// cursor, `ORDER BY a, b` and `LIMIT n + 1`. The extra row says whether there is
// a next page and is not returned. The cursor holds the last row's key values,
// encoded through the key columns' own schemas, so reading one back is a
// decode: a cursor the caller changed is an `InvalidCursor`, not bad SQL.
//
// Unlike OFFSET, the database seeks to the cursor through an index on the key
// instead of reading and dropping every earlier row, and a row inserted ahead
// of the cursor does not shift later pages. See docs/database.md#pagination.

import { Effect, Option, Schema } from "effect"
import { selectExprsOf, selectRecordOf, type CompiledQueryDecodeError } from "../ch/compile"
import { QueryBuilderDefect, QueryBuilderError } from "../ch/errors"
import { and, isExprLike, makeCond, operandOf, or, type Condition, type Expr, type ParamsSatisfied } from "../ch/expr"
import type { CHQuery } from "../ch/query"
import type { QueryParams } from "../ch/union"
import { compile, known } from "../sql/sql-fragment"
import { Database, type RowOf, type RunCheck } from "./database"
import { InvalidCursor, type DatabaseError } from "./errors"

export type KeysetDirection = "asc" | "desc"

/**
 * An output alias that can be part of a keyset: one that is never NULL. A NULL
 * key has no place in `(a, b) > (?, ?)`, so the rows holding one would be
 * skipped or repeated.
 */
export type KeysetColumn<Row> = {
	[K in keyof Row & string]-?: null extends Row[K] ? never : undefined extends Row[K] ? never : K
}[keyof Row & string]

/** The sort key of a page: one or more selected aliases, each with its direction. */
export type KeysetOrder<Row> = readonly [
	readonly [KeysetColumn<Row>, KeysetDirection],
	...ReadonlyArray<readonly [KeysetColumn<Row>, KeysetDirection]>,
]

export interface PaginateOptions<Row> {
	/**
	 * The sort key. Together its columns must be unique, so end it with a unique
	 * column (the primary key) as a tiebreaker: rows that tie on the whole key
	 * can be skipped at a page boundary. `paginate` cannot check this.
	 */
	readonly orderBy: KeysetOrder<Row>
	/** The `nextCursor` of the previous page; leave out for the first page. */
	readonly after?: string | undefined
	/** Rows per page: a positive integer. */
	readonly limit: number
}

export interface Page<Row> {
	readonly rows: ReadonlyArray<Row>
	/** The cursor for the next page, or `none` when this page is the last. */
	readonly nextCursor: Option.Option<string>
}

const defect = (message: string) => Effect.die(new QueryBuilderDefect({ message: `paginate: ${message}` }))

/**
 * The cursor: base64url of `{ k, v }`, where `k` names the sort key and `v`
 * holds the key values in their JSON form. A cursor for another sort key fails
 * on `k`, so it cannot seek on the wrong columns.
 */
const cursorCodec = (sortKey: string, schemas: ReadonlyArray<Schema.Top>) =>
	Schema.StringFromBase64Url.pipe(
		Schema.decodeTo(
			Schema.fromJsonString(
				Schema.toCodecJson(
					Schema.Struct({
						k: Schema.Literal(sortKey),
						v: Schema.Tuple(schemas.map((schema) => Schema.toType(schema))),
					}),
				),
			),
		),
	) as unknown as Schema.Codec<{ readonly k: string; readonly v: ReadonlyArray<unknown> }, string>

const after = (expr: Expr<any, any>, direction: KeysetDirection, value: unknown): Condition =>
	direction === "asc" ? expr.gt(value) : expr.lt(value)

/**
 * The rows after `values` in the order of `exprs`. With one direction it is a
 * row comparison, `(a, b) > (x, y)`, which both dialects compare in order and
 * Postgres serves from an index on `(a, b)`. With mixed directions it is
 * `a >= x AND (a > x OR (a = x AND b < y))`: the leading bound keeps the seek
 * on the index's first column.
 */
const seek = (
	exprs: ReadonlyArray<Expr<any, any>>,
	directions: ReadonlyArray<KeysetDirection>,
	values: ReadonlyArray<unknown>,
): Condition => {
	if (exprs.length === 1) return after(exprs[0]!, directions[0]!, values[0])
	if (directions.every((direction) => direction === directions[0])) {
		return makeCond(
			known(() => {
				const left = exprs.map((expr) => compile(expr.toFragment())).join(", ")
				const right = exprs.map((expr, i) => compile(operandOf(expr, values[i]))).join(", ")
				return `(${left}) ${directions[0] === "asc" ? ">" : "<"} (${right})`
			}),
		)
	}
	const first = directions[0] === "asc" ? exprs[0]!.gte(values[0]) : exprs[0]!.lte(values[0])
	const branches = exprs.map(
		(expr, i) => and(...exprs.slice(0, i).map((prefix, j) => prefix.eq(values[j])), after(expr, directions[i]!, values[i]))!,
	)
	return and(first, or(...branches))
}

/**
 * One page of `query`, in `orderBy` order, after the `after` cursor.
 *
 * The query keeps its own `where`; `paginate` adds the seek and replaces its
 * `orderBy` and `limit`. A query with `offset`, `groupBy`, `having` or
 * `distinctOn` is refused: a keyset seeks over rows, not over groups.
 */
export const paginate = <Q extends CHQuery<any, any, any, any>, const Given extends object = {}>(
	query: Q & RunCheck<Q> & ParamsSatisfied<QueryParams<Q>, Given>,
	options: PaginateOptions<RowOf<Q>>,
	params?: Given,
): Effect.Effect<
	Page<RowOf<Q>>,
	InvalidCursor | DatabaseError | QueryBuilderError | CompiledQueryDecodeError,
	Database
> =>
	Effect.gen(function* () {
		const state = query._state
		const orderBy: ReadonlyArray<readonly [string, KeysetDirection]> = options.orderBy
		if (orderBy.length === 0) return yield* defect("orderBy needs at least one key")
		if (state.offsetValue !== undefined) return yield* defect("the cursor replaces offset(); remove it")
		if (state.groupByKeys.length > 0 || state.havingFn !== undefined) {
			return yield* defect("a keyset pages over rows; a query with groupBy or having is not supported")
		}
		if (Array.isArray(state.distinct)) return yield* defect("distinctOn sets its own ORDER BY; it cannot be paged by a keyset")
		if (!Number.isInteger(options.limit) || options.limit < 1) {
			return yield* new QueryBuilderError({
				code: "InvalidArguments",
				message: `paginate: limit must be a positive integer, not ${String(options.limit)}`,
			})
		}

		const selected = selectExprsOf(query) ?? {}
		const keys = orderBy.map(([key]) => key)
		if (new Set(keys).size !== keys.length) return yield* defect("orderBy names a key twice")
		const schemas: Array<Schema.Top> = []
		for (const key of keys) {
			const expr = selected[key]
			if (!isExprLike(expr)) return yield* defect(`${JSON.stringify(key)} is not a selected alias`)
			if (expr.schema === undefined) return yield* defect(`${JSON.stringify(key)} has no type, so its cursor value cannot be encoded`)
			schemas.push(expr.schema)
		}
		const sortKey = orderBy.map(([key, direction]) => `${key} ${direction}`).join(",")
		const codec = cursorCodec(sortKey, schemas)

		const from =
			options.after === undefined
				? undefined
				: yield* Schema.decodeUnknownEffect(codec)(options.after).pipe(
						Effect.mapError((cause) => new InvalidCursor({ message: "paginate: the cursor is not one this query wrote", cause })),
					)

		const keyExprs = ($: any): ReadonlyArray<Expr<any, any>> => {
			const record = selectRecordOf(state, $) ?? {}
			return keys.map((key) => record[key])
		}
		const directions = orderBy.map(([, direction]) => direction)
		const paged = query
			.where(($) => [from === undefined ? undefined : seek(keyExprs($), directions, from.v)])
			.orderBy(($) => keyExprs($).map((expr, i) => [expr, directions[i]!] as const))
			.limit(options.limit + 1)

		const db = yield* Database
		const rows = (yield* db.run(paged as any, params)) as ReadonlyArray<RowOf<Q>>
		if (rows.length <= options.limit) return { rows, nextCursor: Option.none() }
		const page = rows.slice(0, options.limit)
		const last = page[page.length - 1] as Record<string, unknown>
		const cursor = yield* Schema.encodeEffect(codec)({ k: sortKey, v: keys.map((key) => last[key]) }).pipe(Effect.orDie)
		return { rows: page, nextCursor: Option.some(cursor) }
	})
