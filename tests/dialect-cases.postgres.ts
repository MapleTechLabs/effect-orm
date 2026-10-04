// Postgres function and type fixtures: every export of the `./postgres` entry is
// run here (or exempted in dialect-coverage.test.ts with a reason). Shared
// builder behaviour lives in core-cases.ts and runs on every dialect.
import { DateTime, Effect, Schema } from "effect"
import { expect } from "vitest"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import { postgresContext as ctx } from "./core-cases"

export interface PostgresCase {
	readonly id: string
	readonly covers: readonly string[]
	readonly build: () => CH.CompiledQuery<any>
	readonly expected: readonly unknown[]
}

const pg = (...names: string[]) => names.map((name) => `pg:${name}`)
const org = { orgId: "org_1" }
const orgOrders = () => ctx.from(ctx.orders).where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
const utc = (iso: string) => DateTime.makeUnsafe(iso)

// One row of every column type, read back through the declared codecs. The
// `*Text` columns are text on the server, so they decode from the string wire
// form a driver without type parsers sends.
const typed = PG.table("typed", {
	external: true,
	columns: {
	Text: PG.text,
	Uuid: PG.uuid,
	Bool: PG.bool,
	Int2: PG.int2,
	Int4: PG.int4,
	Int8: PG.int8,
	Int8Text: PG.int8,
	Float4: PG.float4,
	Float8: PG.float8,
	Numeric: PG.numeric,
	Exact: PG.custom("int8", Schema.Union([Schema.BigInt, Schema.BigIntFromString])),
	At: PG.timestamptz,
	AtText: PG.timestamptz,
	// Compared only: string-typed, for the dateTimeString and dateTimeSeconds params.
	AtString: PG.custom("timestamptz", Schema.String),
	Doc: PG.jsonb(Schema.Struct({ region: Schema.String })),
	Tags: PG.array(PG.text),
	Missing: PG.nullable(PG.int4),
	// A brand over int8, read from text: the base codec still parses the string.
	Branded: PG.brand(PG.int8, Schema.Number.pipe(Schema.brand("Count"))),
},
})
const typedRow = `SELECT
	'a''b'::text AS "Text",
	'00000000-0000-4000-8000-000000000001'::uuid AS "Uuid",
	true AS "Bool",
	2::int2 AS "Int2",
	4::int4 AS "Int4",
	8::int8 AS "Int8",
	'12'::text AS "Int8Text",
	0.5::float4 AS "Float4",
	0.25::float8 AS "Float8",
	1.125::numeric AS "Numeric",
	9007199254740993::int8 AS "Exact",
	'2026-01-01T00:00:00.25Z'::timestamptz AS "At",
	'2026-01-01 00:00:00.25+00'::text AS "AtText",
	'2026-01-01T00:00:00.25Z'::timestamptz AS "AtString",
	'{"region": "eu"}'::jsonb AS "Doc",
	'12'::text AS "Branded",
	ARRAY['x', 'y']::text[] AS "Tags",
	NULL::int4 AS "Missing"`
const typedRows = () => CH.from(typed).withCTE("typed", typedRow)

export const postgresCases: readonly PostgresCase[] = [
	{
		id: "aggregates",
		covers: pg("count", "countDistinct", "countIf", "sum", "sumIf", "avg", "min", "max", "percentileCont", "compileUnsafe"),
		build: () =>
			PG.compileUnsafe(
				orgOrders().select(($) => ({
					count: PG.count(),
					customers: PG.countDistinct($.Customer),
					paid: PG.countIf($.Status.eq("paid")),
					total: PG.sum($.Amount),
					paidTotal: PG.sumIf($.Amount, $.Status.eq("paid")),
					average: PG.avg($.Amount),
					smallest: PG.min($.Amount),
					largest: PG.max($.Amount),
					median: PG.percentileCont(0.5, $.Amount),
				})),
				org,
			),
		expected: [
			{ count: 4, customers: 3, paid: 2, total: 42, paidTotal: 30, average: 10.5, smallest: 5, largest: 20, median: 8.5 },
		],
	},
	{
		id: "aggregates-over-no-rows",
		covers: pg("arrayAgg"),
		build: () =>
			PG.compileUnsafe(
				ctx
					.from(ctx.orders)
					.select(($) => ({
						count: PG.count(),
						total: PG.sum($.Amount),
						average: PG.avg($.Amount),
						smallest: PG.min($.Amount),
						ids: PG.arrayAgg($.Id),
					}))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))]),
				{ orgId: "org_none" },
			),
		// Unlike ClickHouse's defaults, Postgres aggregates over nothing are NULL.
		expected: [{ count: 0, total: null, average: null, smallest: null, ids: null }],
	},
	{
		id: "array-agg",
		covers: pg("arrayAgg"),
		build: () =>
			PG.compileUnsafe(
				orgOrders()
					.select(($) => ({ customer: $.Customer, ids: PG.arrayAgg($.Id) }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Customer.eq("acme")])
					.groupBy("customer"),
				org,
			),
		expected: [{ customer: "acme", ids: [1, 2] }],
	},
	{
		id: "time",
		covers: pg("dateTrunc", "dateBin", "now"),
		build: () =>
			PG.compileUnsafe(
				orgOrders()
					.select(($) => ({ hour: PG.dateTrunc("hour", $.Created), bucket: PG.dateBin(1200, $.Created), orders: PG.count() }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Created.lt(PG.now())])
					.groupBy("hour", "bucket")
					.orderBy(["bucket", "asc"]),
				org,
			),
		expected: [
			{ hour: utc("2026-01-01T00:00:00Z"), bucket: utc("2026-01-01T00:00:00Z"), orders: 2 },
			{ hour: utc("2026-01-01T00:00:00Z"), bucket: utc("2026-01-01T00:20:00Z"), orders: 2 },
		],
	},
	{
		id: "strings",
		covers: pg("lower", "upper", "length", "coalesce"),
		build: () =>
			PG.compileUnsafe(
				orgOrders()
					.select(($) => ({
						lower: PG.lower(CH.lit("ACME")),
						upper: PG.upper($.Customer),
						length: PG.length($.Customer),
						note: PG.coalesce($.Note, CH.lit("none")),
					}))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Id.eq(3)]),
				org,
			),
		expected: [{ lower: "acme", upper: "GLOBEX", length: 6, note: "none" }],
	},
	{
		id: "types",
		covers: pg(
			"text",
			"uuid",
			"bool",
			"int2",
			"int4",
			"int8",
			"float4",
			"float8",
			"numeric",
			"custom",
			"brand",
			"timestamptz",
			"jsonb",
			"array",
			"nullable",
			"pgTimestampToIso",
		),
		build: () =>
			PG.compileUnsafe(
				typedRows().select(
					"Text",
					"Uuid",
					"Bool",
					"Int2",
					"Int4",
					"Int8",
					"Int8Text",
					"Float4",
					"Float8",
					"Numeric",
					"Exact",
					"At",
					"AtText",
					"Doc",
					"Tags",
					"Missing",
					"Branded",
				),
				{},
			),
		expected: [
			{
				Text: "a'b",
				Uuid: "00000000-0000-4000-8000-000000000001",
				Bool: true,
				Int2: 2,
				Int4: 4,
				Int8: 8,
				Int8Text: 12,
				Float4: 0.5,
				Float8: 0.25,
				Numeric: 1.125,
				Exact: 9007199254740993n,
				At: utc("2026-01-01T00:00:00.250Z"),
				AtText: utc("2026-01-01T00:00:00.250Z"),
				Doc: { region: "eu" },
				Tags: ["x", "y"],
				Missing: null,
				Branded: 12,
			},
		],
	},
	{
		id: "typed-literals",
		covers: pg("PgTimestampLiteral", "jsonText"),
		build: () =>
			PG.compileUnsafe(
				typedRows()
					.select(($) => ({ region: PG.jsonText($.Doc, "region"), absent: PG.jsonText($.Doc, "zone") }))
					.where(($) => [
						$.Text.eq("a'b"),
						$.Bool.eq(true),
						$.Int8.eq(8),
						$.Numeric.gt(1),
						$.At.eq(utc("2026-01-01T00:00:00.250Z")),
						$.At.gt(new Date("2025-12-31T23:59:59Z")),
						$.At.lt("2026-01-01 00:00:01"),
						$.AtString.gte(CH.param.dateTimeString("from")),
						// 00:00:00.9 floors to 00:00:00, so only a floored bound admits the 0.25s row.
						$.AtString.gte(CH.param.dateTimeSeconds("late")),
						$.AtString.lt(CH.param.dateTimeSeconds("to")),
						$.Doc.eq({ region: "eu" }),
						$.Uuid.in_("00000000-0000-4000-8000-000000000001"),
					]),
				{ from: "2026-01-01 00:00:00", late: new Date("2026-01-01T00:00:00.900Z"), to: new Date("2026-01-01T00:00:01.500Z") },
			),
		expected: [{ region: "eu", absent: null }],
	},
	{
		id: "compile-entry-points",
		covers: pg("compile", "postgresDialect"),
		build: () => {
			const query = orgOrders()
				.select(($) => ({ total: PG.sum($.Amount) }))
				.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
			// The root compile with an explicit dialect writes the same statement.
			const viaRoot = CH.compileUnsafe(query, org, { dialect: PG.postgresDialect })
			const viaEntry = Effect.runSync(PG.compile(query, org))
			expect(viaRoot.sql).toBe(viaEntry.sql)
			return viaEntry
		},
		expected: [{ total: 42 }],
	},
	{
		id: "compile-union-entry-points",
		covers: pg("compileUnion", "compileUnionUnsafe"),
		build: () => {
			const branch = (id: number) =>
				orgOrders()
					.select(($) => ({ id: $.Id }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Id.eq(id)])
			const union = CH.unionAll(branch(1), branch(3)).orderBy(["id", "desc"])
			const unsafe = PG.compileUnionUnsafe(union, org)
			const effect = Effect.runSync(PG.compileUnion(union, org))
			expect(unsafe.sql).toBe(effect.sql)
			return effect
		},
		expected: [{ id: 3 }, { id: 1 }],
	},
]
