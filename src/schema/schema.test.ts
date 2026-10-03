import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "../ch/index"
import * as S from "../schema"

const Spans = S.defineTable("spans", {
	columns: {
		OrgId: CH.custom("LowCardinality(String)", CH.string.schema),
		Timestamp: S.column(CH.dateTime64, { codec: "Delta, ZSTD(1)" }),
		ServiceName: CH.string,
		Duration: S.column(CH.uint64, { default: 0 }),
		Day: S.column(CH.string, { materialized: ($) => CH.formatDateTime($.Timestamp, "%F") }),
	},
	engine: S.engine.mergeTree(),
	orderBy: ["OrgId", "ServiceName", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: S.ttlAfterDays("toDate(Timestamp)", 30),
	settings: { index_granularity: 8192 },
	indexes: [S.index("idx_duration", ($) => $.Duration, "minmax")],
	tenantColumn: "OrgId",
})

const ServiceCounts = S.defineTable("service_counts", {
	columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint64 },
	engine: S.engine.summingMergeTree(),
	orderBy: ["OrgId", "ServiceName"],
})

const ServiceCountsMv = S.materializedView("service_counts_mv", {
	to: ServiceCounts,
	as: CH.from(Spans)
		.select(($) => ({ OrgId: $.OrgId, ServiceName: $.ServiceName, Spans: CH.count() }))
		.groupBy("OrgId", "ServiceName"),
})

describe("defineTable", () => {
	it("is a Table the query builder accepts", () => {
		const { sql } = CH.compileUnsafe(
			CH.from(Spans).select("ServiceName").where(($) => [$.OrgId.eq("o")]),
			{},
		)
		expect(sql).toContain("FROM spans")
		expect(Spans.tenantColumn).toBe("OrgId")
	})

	it("renders its DDL", () => {
		const [table] = S.renderSchema(S.entitiesOf([Spans]))
		expect(table).toBe(
			[
				"CREATE TABLE IF NOT EXISTS spans",
				"(",
				"\tOrgId LowCardinality(String),",
				"\tTimestamp DateTime64 CODEC(Delta, ZSTD(1)),",
				"\tServiceName String,",
				"\tDuration UInt64 DEFAULT 0,",
				"\tDay String MATERIALIZED formatDateTime(Timestamp, '%F'),",
				"\tINDEX idx_duration Duration TYPE minmax GRANULARITY 1",
				")",
				"ENGINE = MergeTree()",
				"PARTITION BY toDate(Timestamp)",
				"ORDER BY (OrgId, ServiceName, Timestamp)",
				"TTL toDate(Timestamp) + toIntervalDay(30)",
				"SETTINGS index_granularity = 8192",
			].join("\n"),
		)
	})

	it("renders replicated engines and ON CLUSTER as options", () => {
		const [table] = S.renderSchema(S.entitiesOf([ServiceCounts]), { cluster: "main", replicated: {} })
		expect(table).toContain("CREATE TABLE IF NOT EXISTS service_counts ON CLUSTER main")
		expect(table).toContain(
			"ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/{database}/{table}', '{replica}')",
		)
	})

	it("rejects a MergeTree without a sorting key", () => {
		expect(() =>
			S.defineTable("bad", { columns: { a: CH.string }, engine: S.engine.mergeTree() }),
		).toThrow(/needs orderBy/)
	})

	it("rejects a non-identifier name", () => {
		expect(() =>
			S.defineTable("bad name", { columns: { a: CH.string }, engine: S.engine.null() }),
		).toThrow(/plain identifier/)
	})
})

describe("materializedView", () => {
	it("compiles its body with the DSL and records its source", () => {
		expect(ServiceCountsMv.ddl.sources).toEqual(["spans"])
		const ddl = S.renderCreateMaterializedView(ServiceCountsMv.ddl)
		expect(ddl).toMatch(/^CREATE MATERIALIZED VIEW IF NOT EXISTS service_counts_mv TO service_counts\nAS SELECT/)
		expect(ddl).toContain("count() AS Spans")
		expect(ddl).toMatch(/FROM spans\s+GROUP BY OrgId, ServiceName$/)
	})

	it("rejects at the type level an output column the target lacks", () => {
		const misfit = () =>
			// @ts-expect-error `Nope` is not a column of service_counts
			S.materializedView("bad_mv", {
				to: ServiceCounts,
				as: CH.from(Spans).select(($) => ({ OrgId: $.OrgId, Nope: $.ServiceName })),
			})
		expect(misfit).toBeTypeOf("function")
	})

	it("rejects a view whose target is not in the schema", () => {
		expect(() => S.entitiesOf([Spans, ServiceCountsMv])).toThrow(/not a table in this schema/)
	})
})

describe("snapshots", () => {
	it("hash the entities, independent of definition order and parents", async () => {
		const a = await Effect.runPromise(S.makeSnapshot(S.entitiesOf([Spans, ServiceCounts, ServiceCountsMv]), []))
		const b = await Effect.runPromise(
			S.makeSnapshot(S.entitiesOf([ServiceCountsMv, ServiceCounts, Spans]), ["parent"]),
		)
		expect(a.id).toBe(b.id)
		expect(a.id).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe("diffSchemas", () => {
	const base = S.entitiesOf([Spans, ServiceCounts, ServiceCountsMv])

	it("creates everything from nothing, tables before views", () => {
		const { ops } = S.diffSchemas([], base)
		expect(ops.map((op) => op.op)).toEqual(["create_table", "create_table", "create_view"])
	})

	it("is empty for an unchanged schema", () => {
		expect(S.diffSchemas(base, base)).toEqual({ ops: [], missingHints: [], unsupported: [] })
	})

	it("adds a column after its neighbour and recreates a changed view", () => {
		const Counts2 = S.defineTable("service_counts", {
			columns: { OrgId: CH.string, Env: S.column(CH.string, { default: "" }), ServiceName: CH.string, Spans: CH.uint64 },
			engine: S.engine.summingMergeTree(),
			orderBy: ["OrgId", "ServiceName"],
		})
		const Mv2 = S.materializedView("service_counts_mv", {
			to: Counts2,
			as: CH.from(Spans)
				.select(($) => ({ OrgId: $.OrgId, Env: CH.lit(""), ServiceName: $.ServiceName, Spans: CH.count() }))
				.groupBy("OrgId", "Env", "ServiceName"),
		})
		const { ops } = S.diffSchemas(base, S.entitiesOf([Spans, Counts2, Mv2]))
		expect(ops.map((op) => op.op)).toEqual(["drop_view", "add_column", "create_view"])
		expect(S.renderOp(ops[1]!)).toEqual([
			"ALTER TABLE service_counts ADD COLUMN IF NOT EXISTS Env String DEFAULT '' AFTER OrgId",
		])
	})

	it("asks before dropping data and orders view drops before table drops", () => {
		const without = S.entitiesOf([Spans])
		const unconfirmed = S.diffSchemas(base, without)
		expect(unconfirmed.missingHints).toEqual([
			{ type: "confirm_data_loss", kind: "table", entity: "service_counts" },
		])
		expect(unconfirmed.ops.map((op) => op.op)).toEqual(["drop_view"])

		const confirmed = S.diffSchemas(base, without, unconfirmed.missingHints)
		expect(confirmed.ops.map((op) => op.op)).toEqual(["drop_view", "drop_table"])
	})

	it("reports changes ALTER cannot make", () => {
		const Resorted = S.defineTable("service_counts", {
			columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint32 },
			engine: S.engine.summingMergeTree(),
			orderBy: ["ServiceName", "OrgId"],
		})
		const { unsupported } = S.diffSchemas(S.entitiesOf([ServiceCounts]), S.entitiesOf([Resorted]))
		expect(unsupported.map((u) => u.message)).toEqual([
			expect.stringContaining("ORDER BY"),
			expect.stringContaining("type UInt64 -> UInt32"),
		])
	})

	it("modifies TTL without materializing it", () => {
		const Shorter = S.defineTable("service_counts", {
			columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint64 },
			engine: S.engine.summingMergeTree(),
			orderBy: ["OrgId", "ServiceName"],
			ttl: "now() + toIntervalDay(1)",
		})
		const { ops } = S.diffSchemas(S.entitiesOf([ServiceCounts]), S.entitiesOf([Shorter]))
		expect(ops.flatMap((op) => S.renderOp(op))).toEqual([
			"ALTER TABLE service_counts MODIFY TTL now() + toIntervalDay(1) SETTINGS materialize_ttl_after_modify = 0",
		])
	})

	it("ignores settings that only changed key order", () => {
		const make = (settings: Record<string, number>) =>
			S.defineTable("ordered", { columns: { a: CH.string }, engine: S.engine.mergeTree(), orderBy: ["a"], settings })
		const before = S.entitiesOf([make({ index_granularity: 8192, merge_with_ttl_timeout: 3600 })])
		const after = S.entitiesOf([make({ merge_with_ttl_timeout: 3600, index_granularity: 8192 })])
		expect(S.diffSchemas(before, after).ops).toEqual([])
	})
})
