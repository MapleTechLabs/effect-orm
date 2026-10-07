import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as CH from "../clickhouse"
import * as S from "../schema"
import * as TB from "../tinybird"
import { t } from "../tinybird"

const OrgId = Schema.String.pipe(Schema.brand("OrgId"))

const events = TB.defineDatasource("events", {
	description: "Raw events.",
	schema: {
		OrgId: TB.column(t.string().lowCardinality().brand(OrgId), { jsonPath: "$.org_id" }),
		Timestamp: t.dateTime64(9),
		Kind: t.string().lowCardinality().default("click"),
		Attributes: t.map(t.string().lowCardinality(), t.string()),
		Tags: t.array(t.string()).jsonPath("$.tags[:]"),
		Score: t.float64().nullable(),
		Items: t.array(t.string()).defaultExpr("arrayMap(k -> lower(k), mapKeys(Attributes))"),
		Body: t.string().codec("ZSTD(1)"),
	},
	engine: TB.engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: "OrgId, toStartOfHour(Timestamp), Kind",
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
	indexes: [{ name: "idx_kind", expr: "Kind", type: "set(100)", granularity: 4 }],
	forwardQuery: "SELECT *\n  FROM events",
	tenantColumn: "OrgId",
})

const hourly = TB.defineDatasource("events_hourly", {
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		Calls: t.simpleAggregateFunction("sum", t.uint64()),
		Latency: t.aggregateFunction("quantilesTDigestWeighted(0.5, 0.95), UInt64", t.uint32()),
	},
	engine: TB.engine.aggregatingMergeTree({ sortingKey: ["OrgId", "Hour"], ttl: "Hour + INTERVAL 1 DAY" }),
})

const hourlyMv = TB.defineMaterializedView("events_hourly_mv", {
	description: "Rolls events up by hour.",
	datasource: hourly,
	nodes: [
		TB.node({
			name: "events_hourly_node",
			sql: `
        SELECT OrgId, toStartOfHour(Timestamp) AS Hour
        FROM events
      `,
		}),
	],
	deploymentMethod: "alter",
})

describe("datafiles", () => {
	it("writes a datasource as the SDK does", () => {
		expect(TB.generateDatasource(events).content).toBe(
			[
				"DESCRIPTION >",
				"    Raw events.",
				"",
				"SCHEMA >",
				"    OrgId LowCardinality(String) `json:$.org_id`,",
				"    Timestamp DateTime64(9) `json:$.Timestamp`,",
				"    Kind LowCardinality(String) `json:$.Kind` DEFAULT 'click',",
				"    Attributes Map(LowCardinality(String), String) `json:$.Attributes`,",
				"    Tags Array(String) `json:$.tags[:]`,",
				"    Score Nullable(Float64) `json:$.Score`,",
				"    Items Array(String) `json:$.Items` DEFAULT arrayMap(k -> lower(k), mapKeys(Attributes)),",
				"    Body String `json:$.Body` CODEC(ZSTD(1))",
				"",
				'ENGINE "MergeTree"',
				'ENGINE_PARTITION_KEY "toDate(Timestamp)"',
				'ENGINE_SORTING_KEY "OrgId, toStartOfHour(Timestamp), Kind"',
				'ENGINE_TTL "toDate(Timestamp) + INTERVAL 30 DAY"',
				"",
				"INDEXES >",
				"    idx_kind Kind TYPE set(100) GRANULARITY 4",
				"",
				"FORWARD_QUERY >",
				"    SELECT *",
				"      FROM events",
			].join("\n"),
		)
	})

	it("leaves json paths out and writes aggregate types", () => {
		expect(TB.generateDatasource(hourly).content).toBe(
			[
				"SCHEMA >",
				"    OrgId LowCardinality(String),",
				"    Hour DateTime,",
				"    Calls SimpleAggregateFunction(sum, UInt64),",
				"    Latency AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)",
				"",
				'ENGINE "AggregatingMergeTree"',
				'ENGINE_SORTING_KEY "OrgId, Hour"',
				'ENGINE_TTL "Hour + INTERVAL 1 DAY"',
			].join("\n"),
		)
	})

	it("writes Null and ReplacingMergeTree engines", () => {
		const ingest = TB.defineDatasource("ingest", { schema: { OrgId: t.string() }, engine: TB.engine.null() })
		const latest = TB.defineDatasource("latest", {
			schema: { OrgId: t.string(), Version: t.uint64() },
			engine: TB.engine.replacingMergeTree({ sortingKey: ["OrgId"], ver: "Version" }),
		})
		expect(TB.generateDatasource(ingest).content).toBe("SCHEMA >\n    OrgId String `json:$.OrgId`\n\nENGINE Null")
		expect(TB.generateDatasource(latest).content).toContain('ENGINE_SORTING_KEY "OrgId"\nENGINE_VER "Version"')
	})

	it("writes a materialized view pipe", () => {
		expect(TB.generatePipe(hourlyMv).content).toBe(
			[
				"DESCRIPTION >",
				"    Rolls events up by hour.",
				"",
				"NODE events_hourly_node",
				"SQL >",
				"    SELECT OrgId, toStartOfHour(Timestamp) AS Hour",
				"            FROM events",
				"",
				"TYPE MATERIALIZED",
				"DATASOURCE events_hourly",
				"DEPLOYMENT_METHOD alter",
			].join("\n"),
		)
	})

	it("collects a project from module namespaces in export order", () => {
		const project = TB.buildProject({ b: hourly, a: events, view: hourlyMv, other: 1 }, { again: events })
		expect(project.datasources.map((d) => d.name)).toEqual(["events_hourly", "events"])
		expect(project.pipes.map((p) => p.name)).toEqual(["events_hourly_mv"])
	})
})

describe("a datasource is a table", () => {
	it("is queried with its branded tenant column", () => {
		const { sql } = CH.compileUnsafe(
			CH.from(events)
				.select("Kind", "Timestamp")
				.where(($) => [$.OrgId.eq(CH.param.of(events.columns.OrgId, "orgId"))]),
			{ orgId: OrgId.make("org_1") },
		)
		expect(sql).toContain("FROM events")
		expect(events.tenantColumn).toBe("OrgId")
		expectTypeOf<CH.InferTS<typeof events.columns.OrgId>>().toEqualTypeOf<typeof OrgId.Type>()
		expectTypeOf<CH.InferTS<typeof events.columns.Timestamp>>().toEqualTypeOf<string>()
	})

	it("renders ClickHouse DDL", () => {
		const [table] = S.renderSchema(S.entitiesOf([events]))
		expect(table).toContain("\tOrgId LowCardinality(String),")
		expect(table).toContain("\tKind LowCardinality(String) DEFAULT 'click',")
		expect(table).toContain("\tBody String CODEC(ZSTD(1)),")
		expect(table).toContain("ORDER BY (OrgId, toStartOfHour(Timestamp), Kind)")
		expect(table).toContain("TTL toDate(Timestamp) + INTERVAL 30 DAY")
	})

	it("infers the ingested JSON row", () => {
		type Row = TB.InferRow<typeof events>
		expectTypeOf<Row["OrgId"]>().toEqualTypeOf<string>()
		expectTypeOf<Row["Timestamp"]>().toEqualTypeOf<string>()
		expectTypeOf<Row["Score"]>().toEqualTypeOf<number | null>()
		expectTypeOf<Row["Attributes"]>().toEqualTypeOf<Record<string, string>>()
		expectTypeOf<Row["Tags"]>().toEqualTypeOf<Array<string>>()
		type Rollup = TB.InferRow<typeof hourly>
		expectTypeOf<Rollup["Calls"]>().toEqualTypeOf<number>()
		expectTypeOf<Rollup["Latency"]>().toEqualTypeOf<number>()
	})

	it("reads column metadata", () => {
		expect(TB.getColumnJsonPath(events.options.schema.OrgId)).toBe("$.org_id")
		expect(TB.getColumnJsonPath(events.options.schema.Tags)).toBe("$.tags[:]")
		expect(TB.getTinybirdType(TB.getColumnType(events.options.schema.Score))).toBe("Nullable(Float64)")
		expect(TB.isDatasourceDefinition(events)).toBe(true)
		expect(TB.isDatasourceDefinition(hourlyMv)).toBe(false)
	})
})
