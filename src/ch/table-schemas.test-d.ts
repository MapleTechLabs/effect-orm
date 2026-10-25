// Type-level tests: the row Schemas of a table

import { type DateTime, Schema } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import * as CHD from "../clickhouse"

const Spans = CHD.table("spans", {
	columns: {
		OrgId: CH.string,
		Id: CHD.column(CH.uint64, { default: 0 }),
		At: CH.dateTime,
		Note: CH.nullable(CH.string),
		Day: CHD.column(CH.string, { materialized: "toString(toDate(At))" }),
	},
	engine: CHD.engine.mergeTree(),
	orderBy: ["OrgId", "At"],
})

const schemas = CH.tableSchemas(Spans)

// select is the whole decoded row, as SelectRowOf names it.
expectTypeOf<typeof schemas.select.Type>().toEqualTypeOf<CH.SelectRowOf<typeof Spans>>()

// insert: defaulted and nullable columns optional, computed ones absent.
expectTypeOf<typeof schemas.insert.Type>().toEqualTypeOf<{
	readonly OrgId: string
	readonly At: DateTime.Utc
	readonly Id?: number | undefined
	readonly Note?: string | null | undefined
}>()

// A decoded insert row is a row `values` takes.
declare const created: typeof schemas.insert.Type
CH.insertInto(Spans).values(created)

// update: every writable column optional.
expectTypeOf<typeof schemas.update.Type>().toEqualTypeOf<{
	readonly OrgId?: string | undefined
	readonly Id?: number | undefined
	readonly At?: DateTime.Utc | undefined
	readonly Note?: string | null | undefined
}>()
declare const patch: typeof schemas.update.Type & { readonly Id: number }
CH.update(Spans).set(patch).allRows()

// The json variants keep the row types and encode to JSON.
expectTypeOf<typeof schemas.json.Type>().toEqualTypeOf<CH.SelectRowOf<typeof Spans>>()
expectTypeOf<typeof schemas.json.Encoded>().toEqualTypeOf<Schema.Json>()
expectTypeOf<typeof schemas.jsonCreate.Type>().toEqualTypeOf<typeof schemas.insert.Type>()
expectTypeOf<typeof schemas.jsonUpdate.Type>().toEqualTypeOf<typeof schemas.update.Type>()

// The select Schema's wire side is what the database sends.
expectTypeOf<typeof schemas.select.Encoded.Id>().toEqualTypeOf<number | string>()

// A table written with the bare `table` and no options: every non-null column required.
const Plain = CH.table("plain", { A: CH.string, B: CH.nullable(CH.uint32) })
expectTypeOf<CH.TableSchemas<typeof Plain>["insert"]["Type"]>().toEqualTypeOf<{
	readonly A: string
	readonly B?: number | null | undefined
}>()

// A computed column is not part of an insert row.
// @ts-expect-error Day is computed
const withDay: typeof schemas.insert.Type = { OrgId: "o", At: {} as DateTime.Utc, Day: "2026-01-01" }
