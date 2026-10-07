// Tinybird column types: the `t` builder of `@tinybirdco/sdk`, over the
// ClickHouse column types. Each one carries the query column (`column`), the
// datafile modifiers, and the JSON row type Tinybird ingests (`InferRow`).

import type { Schema } from "effect"
import * as T from "../ch/types"

export const TypeId: unique symbol = Symbol.for("@maple-dev/effect-orm/tinybird/Type")
export type TypeId = typeof TypeId

export interface TypeModifiers {
	readonly defaultValue?: unknown
	readonly defaultExpression?: string
	readonly codec?: string
	readonly jsonPath?: string
}

type AnyColumn = T.CHType<string, any, any>

/**
 * A Tinybird column type. `Row` is the value in an ingested JSON row (a
 * `DateTime` is its string form); `Defaulted` records a `DEFAULT`, so an
 * insert may leave the column out.
 */
export interface TinybirdType<C extends AnyColumn = AnyColumn, Row = unknown, Defaulted extends boolean = boolean> {
	readonly [TypeId]: TypeId
	/** The query column this type declares: what the table's `columns` hold. */
	readonly column: C
	readonly modifiers: TypeModifiers
	readonly _row?: Row
	readonly _defaulted?: Defaulted
	nullable(): TinybirdType<T.CHNullable<C>, Row | null, Defaulted>
	lowCardinality(): TinybirdType<C, Row, Defaulted>
	default(value: Row): TinybirdType<C, Row, true>
	defaultExpr(expression: string): TinybirdType<C, Row, true>
	codec(codec: string): TinybirdType<C, Row, Defaulted>
	jsonPath(path: string): TinybirdType<C, Row, Defaulted>
	/** Narrows the query column (`T.brand`); the ingested row keeps its wire type. */
	brand<B>(schema: Schema.Codec<B, T.InferTS<C>>): TinybirdType<T.CHType<C["_tag"], B, T.InferEncoded<C>>, Row, Defaulted>
}

export type AnyTinybirdType = TinybirdType<AnyColumn, any, boolean>
export type RowOf<X> = X extends TinybirdType<any, infer Row, any> ? Row : never

const make = <C extends AnyColumn, Row, Defaulted extends boolean = false>(
	column: C,
	modifiers: TypeModifiers = {},
): TinybirdType<C, Row, Defaulted> => {
	const { defaultValue: _value, defaultExpression: _expression, ...rest } = modifiers
	return {
		[TypeId]: TypeId,
		column,
		modifiers,
		nullable: () => make<T.CHNullable<C>, Row | null, Defaulted>(T.nullable(column), modifiers),
		lowCardinality: () => make<C, Row, Defaulted>(T.lowCardinality(column), modifiers),
		default: (value) => make<C, Row, true>(column, { ...rest, defaultValue: value }),
		defaultExpr: (expression) => make<C, Row, true>(column, { ...rest, defaultExpression: expression.trim() }),
		codec: (codec) => make<C, Row, Defaulted>(column, { ...modifiers, codec }),
		jsonPath: (path) => make<C, Row, Defaulted>(column, { ...modifiers, jsonPath: path }),
		brand: (schema) => make(T.brand(column, schema), modifiers),
	}
}

export const isTinybirdType = (value: unknown): value is AnyTinybirdType =>
	typeof value === "object" && value !== null && TypeId in value

type AggregateRow<Args extends ReadonlyArray<AnyTinybirdType>> = Args extends readonly [infer First, ...Array<any>]
	? RowOf<First>
	: unknown

/** The `t` builder of `@tinybirdco/sdk`, for the types a ClickHouse column type exists for. */
export const t = {
	string: () => make<T.CHString, string>(T.string),
	bool: () => make<T.CHBool, boolean>(T.bool),
	uint8: () => make<T.CHUInt8, number>(T.uint8),
	uint16: () => make<T.CHUInt16, number>(T.uint16),
	uint32: () => make<T.CHUInt32, number>(T.uint32),
	uint64: () => make<T.CHUInt64, number>(T.uint64),
	int32: () => make<T.CHInt32, number>(T.int32),
	int64: () => make<T.CHInt64, number>(T.int64),
	float64: () => make<T.CHFloat64, number>(T.float64),
	/** Read and ingested as the string ClickHouse writes, as `@tinybirdco/sdk` types it. */
	dateTime: () => make<T.CHDateTimeString, string>(T.dateTimeString),
	dateTime64: (precision: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 3) =>
		make<T.CHDateTime64String, string>(T.precision(T.dateTime64String, precision)),
	array: <E extends AnyTinybirdType>(element: E) =>
		make<T.CHArray<E["column"]>, Array<RowOf<E>>>(T.array(element.column)),
	map: <K extends TinybirdType<T.CHType<string, string, any>, string, any>, V extends AnyTinybirdType>(
		key: K,
		value: V,
	) => make<T.CHMap<K["column"], V["column"]>, Record<RowOf<K>, RowOf<V>>>(T.map(key.column, value.column)),
	simpleAggregateFunction: <E extends AnyTinybirdType>(fn: string, type: E) =>
		make<E["column"], RowOf<E>>(T.simpleAggregateFunction(fn, type.column)),
	/** `fn` is written as-is, so it may carry parameters and leading argument types. */
	aggregateFunction: <const Args extends ReadonlyArray<AnyTinybirdType>>(fn: string, ...types: Args) =>
		make<T.CHType<"AggregateFunction", unknown, unknown>, AggregateRow<Args>>(
			T.aggregateState(fn, ...types.map((type) => type.column.sql)),
		),
} as const

/** The ClickHouse type a column is written as in a datafile, e.g. `LowCardinality(String)`. */
export const getTinybirdType = (type: AnyTinybirdType): string => type.column.sql

export const getModifiers = (type: AnyTinybirdType): TypeModifiers => type.modifiers
