// Table Schemas
//
// The Effect Schemas of a table's rows, derived from its columns: what a
// `SELECT` of every column decodes, what an insert or an update takes, and the
// JSON forms of the same for an HTTP API. The names follow `Model.Class` in
// `effect/unstable/schema/Model`, so a `SqlModel` user finds the same variants.

import { Schema } from "effect"
import type { Table } from "./table"
import type { ColumnDefs, InferTS } from "./types"

/** A bare `string` means the table did not say, which is read as none. */
type Known<K extends string> = string extends K ? never : K

type Simplify<A> = { [K in keyof A]: A[K] } & {}

type NullableKeys<Cols extends ColumnDefs> = {
	[K in keyof Cols]: null extends InferTS<Cols[K]> ? K : never
}[keyof Cols] &
	string

type Writable<Cols extends ColumnDefs, Computed extends string> = Exclude<keyof Cols & string, Known<Computed>>
type Optional<Cols extends ColumnDefs, Defaulted extends string, Computed extends string> = Extract<
	Known<Defaulted> | NullableKeys<Cols>,
	Writable<Cols, Computed>
>

type SelectFields<Cols extends ColumnDefs> = { readonly [K in keyof Cols]: Cols[K]["schema"] }

type InsertFields<Cols extends ColumnDefs, Defaulted extends string, Computed extends string> = Simplify<
	{
		readonly [K in Exclude<Writable<Cols, Computed>, Optional<Cols, Defaulted, Computed>>]: Cols[K]["schema"]
	} & {
		readonly [K in Optional<Cols, Defaulted, Computed>]: Schema.optional<Cols[K]["schema"]>
	}
>

type UpdateFields<Cols extends ColumnDefs, Computed extends string> = {
	readonly [K in Writable<Cols, Computed>]: Schema.optional<Cols[K]["schema"]>
}

/** The row Schemas of a table value: `TableSchemas<typeof Spans>`. */
export type TableSchemas<T> =
	T extends Table<any, infer Cols, infer Defaulted, infer Computed>
		? {
				readonly select: Schema.Struct<SelectFields<Cols>>
				readonly insert: Schema.Struct<InsertFields<Cols, Defaulted, Computed>>
				readonly update: Schema.Struct<UpdateFields<Cols, Computed>>
				readonly json: Schema.toCodecJson<Schema.toType<Schema.Struct<SelectFields<Cols>>>>
				readonly jsonCreate: Schema.toCodecJson<Schema.toType<Schema.Struct<InsertFields<Cols, Defaulted, Computed>>>>
				readonly jsonUpdate: Schema.toCodecJson<Schema.toType<Schema.Struct<UpdateFields<Cols, Computed>>>>
			}
		: never

type AnyTable = Table<string, ColumnDefs, any, any>

export const tableSchemas = <T extends AnyTable>(table: T): TableSchemas<T> => {
	const computed = new Set<string>(table.computed ?? [])
	const defaulted = new Set<string>(table.defaults ?? [])
	const columns = Object.entries(table.columns)
	const writable = columns.filter(([key]) => !computed.has(key))
	const isOptional = (key: string, schema: Schema.Top) => defaulted.has(key) || Schema.is(schema)(null)
	const select = Object.fromEntries(columns.map(([key, column]) => [key, column.schema]))
	const insert = Object.fromEntries(
		writable.map(([key, column]) => [key, isOptional(key, column.schema) ? Schema.optional(column.schema) : column.schema]),
	)
	const update = Object.fromEntries(writable.map(([key, column]) => [key, Schema.optional(column.schema)]))
	const rows = { select: Schema.Struct(select), insert: Schema.Struct(insert), update: Schema.Struct(update) }
	const toJson = (schema: Schema.Struct<Schema.Struct.Fields>) => Schema.toCodecJson(Schema.toType(schema))
	return {
		...rows,
		json: toJson(rows.select),
		jsonCreate: toJson(rows.insert),
		jsonUpdate: toJson(rows.update),
	} as unknown as TableSchemas<T>
}
