import { describe, expect, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import * as CH from "./index"
import * as CHD from "../clickhouse"
import * as PG from "../postgres"

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

describe("tableSchemas", () => {
	it("select decodes a whole row from the wire, as a SELECT of every column does", () => {
		const { select } = CH.tableSchemas(Spans)
		const row = Schema.decodeUnknownSync(select)({
			OrgId: "o",
			Id: "7",
			At: "2026-01-01 00:00:00",
			Note: null,
			Day: "2026-01-01",
		})
		expect(row).toEqual({
			OrgId: "o",
			Id: 7,
			At: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
			Note: null,
			Day: "2026-01-01",
		})
	})

	it("insert makes defaulted and nullable columns optional and leaves computed ones out", () => {
		const { insert } = CH.tableSchemas(Spans)
		expect(Object.keys(insert.fields)).toEqual(["OrgId", "Id", "At", "Note"])
		const decode = Schema.decodeUnknownSync(insert)
		expect(decode({ OrgId: "o", At: "2026-01-01 00:00:00" })).toEqual({
			OrgId: "o",
			At: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
		})
		expect(decode({ OrgId: "o", At: "2026-01-01 00:00:00", Id: undefined, Note: null })).toEqual({
			OrgId: "o",
			At: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
			Id: undefined,
			Note: null,
		})
		expect(() => decode({ OrgId: "o" })).toThrow(/At/)
	})

	it("update makes every writable column optional and leaves computed ones out", () => {
		const { update } = CH.tableSchemas(Spans)
		expect(Object.keys(update.fields)).toEqual(["OrgId", "Id", "At", "Note"])
		const decode = Schema.decodeUnknownSync(update)
		expect(decode({})).toEqual({})
		expect(decode({ Id: "8", Note: null })).toEqual({ Id: 8, Note: null })
		expect(() => decode({ OrgId: null })).toThrow(/OrgId/)
	})

	it("json writes the select row in plain JSON and reads it back", () => {
		const { json } = CH.tableSchemas(Spans)
		const row = { OrgId: "o", Id: 7, At: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), Note: null, Day: "2026-01-01" }
		const encoded = Schema.encodeSync(json)(row)
		expect(encoded).toEqual({ OrgId: "o", Id: 7, At: "2026-01-01T00:00:00.000Z", Note: null, Day: "2026-01-01" })
		expect(Schema.decodeUnknownSync(json)(JSON.parse(JSON.stringify(encoded)))).toEqual(row)
	})

	it("jsonCreate and jsonUpdate read request bodies with the insert and update keys", () => {
		const { jsonCreate, jsonUpdate } = CH.tableSchemas(Spans)
		expect(Schema.decodeUnknownSync(jsonCreate)({ OrgId: "o", At: "2026-01-01T00:00:00.000Z", Note: null })).toEqual({
			OrgId: "o",
			At: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
			Note: null,
		})
		expect(() => Schema.decodeUnknownSync(jsonCreate)({ OrgId: "o" })).toThrow(/At/)
		expect(Schema.decodeUnknownSync(jsonUpdate)({ Note: "n" })).toEqual({ Note: "n" })
		expect(Schema.decodeUnknownSync(jsonUpdate)({ Day: "2026-01-01" })).toEqual({})
	})

	it("reads a Postgres table: identity and default columns are optional on insert, keys are the column keys", () => {
		const Requests = PG.table("requests", {
			columns: {
				id: PG.column(PG.int8, { identity: "always" }),
				orgId: PG.column(PG.text, { name: "org_id" }),
				createdAt: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
				body: PG.nullable(PG.jsonb<{ readonly path: string }>()),
			},
			primaryKey: ["id"],
		})
		const { insert, json } = PG.tableSchemas(Requests)
		expect(Schema.decodeUnknownSync(insert)({ orgId: "o" })).toEqual({ orgId: "o" })
		expect(() => Schema.decodeUnknownSync(insert)({})).toThrow(/orgId/)
		expect(
			Schema.encodeSync(json)({
				id: 1,
				orgId: "o",
				createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
				body: { path: "/" },
			}),
		).toEqual({ id: 1, orgId: "o", createdAt: "2026-01-01T00:00:00.000Z", body: { path: "/" } })
	})
})
