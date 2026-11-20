import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "../clickhouse"
import * as S from "../schema"

const problemsOf = (object: { readonly problems: ReadonlyArray<S.DefinitionProblem> }): string =>
	object.problems.map((problem) => problem.message).join("; ")

const Spans = CH.table("spans", {
	columns: {
		OrgId: CH.custom("LowCardinality(String)", CH.string.schema),
		Timestamp: CH.column(CH.dateTime64, { codec: "Delta, ZSTD(1)" }),
		ServiceName: CH.string,
		Duration: CH.column(CH.uint64, { default: 0 }),
		Day: CH.column(CH.string, { materialized: ($) => CH.formatDateTime($.Timestamp, "%F") }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "ServiceName", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: CH.ttlAfterDays("toDate(Timestamp)", 30),
	settings: { index_granularity: 8192 },
	indexes: [CH.index("idx_duration", ($) => $.Duration, "minmax")],
	tenantColumn: "OrgId",
})

const ServiceCounts = CH.table("service_counts", {
	columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "ServiceName"],
})

const ServiceCountsMv = CH.materializedView("service_counts_mv", {
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
		const [table] = S.renderSchema(Effect.runSync(S.entitiesOf([Spans])))
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
		const [table] = S.renderSchema(Effect.runSync(S.entitiesOf([ServiceCounts])), { cluster: "main", replicated: {} })
		expect(table).toContain("CREATE TABLE IF NOT EXISTS service_counts ON CLUSTER main")
		expect(table).toContain(
			"ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/{database}/{table}', '{replica}')",
		)
	})

	it("renders storage-only wrappers without changing the column's query type", () => {
		const Rollup = CH.table("rollup", {
			columns: {
				OrgId: CH.lowCardinality(CH.string),
				Env: CH.nullable(CH.lowCardinality(CH.string)),
				At: CH.precision(CH.dateTime64String, 9),
				Calls: CH.simpleAggregateFunction("sum", CH.uint64),
			},
			engine: CH.engine.aggregatingMergeTree(),
			orderBy: ["OrgId"],
		})
		const [table] = S.renderSchema(Effect.runSync(S.entitiesOf([Rollup])))
		expect(table).toContain("\tOrgId LowCardinality(String),")
		expect(table).toContain("\tEnv LowCardinality(Nullable(String)),")
		expect(table).toContain("\tAt DateTime64(9),")
		expect(table).toContain("\tCalls SimpleAggregateFunction(sum, UInt64)")
		expect(Rollup.columns.OrgId._tag).toBe("String")
		expect(Rollup.columns.Calls._tag).toBe("UInt64")
	})

	it("rejects a MergeTree without a sorting key", () => {
		expect(problemsOf(CH.table("bad", { columns: { a: CH.string }, engine: CH.engine.mergeTree() }))).toMatch(/needs orderBy/)
	})

	it("never throws, and fails entitiesOf with every problem at once", () => {
		const bad = CH.table("bad name", { columns: { a: CH.string }, engine: CH.engine.mergeTree() })
		const error = Effect.runSync(Effect.flip(S.entitiesOf([bad])))
		expect(error._tag).toBe("@maple-dev/effect-orm/SchemaDefinitionError")
		expect(error.problems.map((problem) => problem.message)).toEqual([
			'"bad name" is not a plain identifier ([A-Za-z_][A-Za-z0-9_]*)',
			"MergeTree needs orderBy (use [] for ORDER BY tuple())",
		])
	})

	it("rejects a non-identifier name", () => {
		expect(problemsOf(CH.table("bad name", { columns: { a: CH.string }, engine: CH.engine.null() }))).toMatch(/plain identifier/)
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
			CH.materializedView("bad_mv", {
				to: ServiceCounts,
				as: CH.from(Spans).select(($) => ({ OrgId: $.OrgId, Nope: $.ServiceName })),
			})
		expect(misfit).toBeTypeOf("function")
	})

	it("rejects a view whose target is not in the schema", () => {
		expect(Effect.runSync(Effect.flip(S.entitiesOf([Spans, ServiceCountsMv]))).message).toMatch(/not a table in this schema/)
	})
})

describe("snapshots", () => {
	it("hash the entities, independent of definition order and parents", async () => {
		const a = await Effect.runPromise(S.makeSnapshot(Effect.runSync(S.entitiesOf([Spans, ServiceCounts, ServiceCountsMv])), []))
		const b = await Effect.runPromise(
			S.makeSnapshot(Effect.runSync(S.entitiesOf([ServiceCountsMv, ServiceCounts, Spans])), ["parent"]),
		)
		expect(a.id).toBe(b.id)
		expect(a.id).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe("diffSchemas", () => {
	const base = Effect.runSync(S.entitiesOf([Spans, ServiceCounts, ServiceCountsMv]))

	it("creates everything from nothing, tables before views", () => {
		const { ops } = S.diffSchemas([], base)
		expect(ops.map((op) => op.op)).toEqual(["create_table", "create_table", "create_view"])
	})

	it("is empty for an unchanged schema", () => {
		expect(S.diffSchemas(base, base)).toEqual({ ops: [], missingHints: [], unsupported: [] })
	})

	// A column named for a word the builder quotes elsewhere (`top`) is written bare in the
	// table's own expressions, as every release has: quoting it would change the snapshot, and
	// `generate` would rebuild the index and re-declare the column.
	it("writes a table's index and MATERIALIZED expressions as it always has", () => {
		const Tops = CH.table("tops", {
			columns: { OrgId: CH.string, top: CH.uint64, shown: CH.column(CH.string, { materialized: ($) => CH.toString($.top) }) },
			engine: CH.engine.mergeTree(),
			orderBy: ["OrgId", "top"],
			indexes: [CH.index("idx_top", ($) => $.top, "minmax")],
		})
		const sql = S.renderSchema(Effect.runSync(S.entitiesOf([Tops]))).join("\n")
		expect(sql).toContain("shown String MATERIALIZED toString(top)")
		expect(sql).toContain("INDEX idx_top top TYPE minmax")
		expect(sql).toContain("ORDER BY (OrgId, top)")
		expect(sql).not.toContain("`")
	})

	// 1.0 quotes a few words (`top`, `all`, `null`, …) as select keys, which earlier releases wrote
	// bare. A snapshot from before differs from the schema by those backticks alone, and that is
	// not a changed view.
	it("does not recreate a view whose only change is the quoting of a plain name", () => {
		const Tops = CH.table("tops", { columns: { OrgId: CH.string, top: CH.uint64, all: CH.uint64 }, engine: CH.engine.summingMergeTree(), orderBy: ["OrgId"] })
		const TopsMv = CH.materializedView("tops_mv", {
			to: Tops,
			as: CH.from(Spans).select(($) => ({ OrgId: $.OrgId, top: CH.max($.Duration), all: CH.count() })).groupBy("OrgId"),
		})
		const now = Effect.runSync(S.entitiesOf([Spans, Tops, TopsMv]))
		const view = now.find((entity) => entity.kind === "materialized_view")!
		expect(view.select).toContain("AS `top`")
		const before = now.map((entity) => (entity.kind === "materialized_view" ? { ...entity, select: entity.select.replaceAll("`", "") } : entity))
		expect(before).not.toEqual(now)
		expect(S.diffSchemas(before, now).ops).toEqual([])
		// A different body is still a different view.
		const changed = now.map((entity) => (entity.kind === "materialized_view" ? { ...entity, select: entity.select.replace("count()", "sum(1)") } : entity))
		expect(S.diffSchemas(before, changed).ops.map((op) => op.op)).toEqual(["drop_view", "create_view"])
	})

	it("adds a column after its neighbour and recreates a changed view", () => {
		const Counts2 = CH.table("service_counts", {
			columns: { OrgId: CH.string, Env: CH.column(CH.string, { default: "" }), ServiceName: CH.string, Spans: CH.uint64 },
			engine: CH.engine.summingMergeTree(),
			orderBy: ["OrgId", "ServiceName"],
		})
		const Mv2 = CH.materializedView("service_counts_mv", {
			to: Counts2,
			as: CH.from(Spans)
				.select(($) => ({ OrgId: $.OrgId, Env: CH.lit(""), ServiceName: $.ServiceName, Spans: CH.count() }))
				.groupBy("OrgId", "Env", "ServiceName"),
		})
		const { ops } = S.diffSchemas(base, Effect.runSync(S.entitiesOf([Spans, Counts2, Mv2])))
		expect(ops.map((op) => op.op)).toEqual(["drop_view", "add_column", "create_view"])
		expect(S.renderOp(ops[1]!)).toEqual([
			"ALTER TABLE service_counts ADD COLUMN IF NOT EXISTS Env String DEFAULT '' AFTER OrgId",
		])
	})

	it("asks before dropping data and orders view drops before table drops", () => {
		const without = Effect.runSync(S.entitiesOf([Spans]))
		const unconfirmed = S.diffSchemas(base, without)
		expect(unconfirmed.missingHints).toEqual([
			{ type: "confirm_data_loss", kind: "table", entity: "service_counts" },
		])
		expect(unconfirmed.ops.map((op) => op.op)).toEqual(["drop_view"])

		const confirmed = S.diffSchemas(base, without, unconfirmed.missingHints)
		expect(confirmed.ops.map((op) => op.op)).toEqual(["drop_view", "drop_table"])
	})

	it("reports changes ALTER cannot make", () => {
		const Resorted = CH.table("service_counts", {
			columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint32 },
			engine: CH.engine.summingMergeTree(),
			orderBy: ["ServiceName", "OrgId"],
		})
		const { unsupported } = S.diffSchemas(Effect.runSync(S.entitiesOf([ServiceCounts])), Effect.runSync(S.entitiesOf([Resorted])))
		expect(unsupported.map((u) => u.message)).toEqual([
			expect.stringContaining("ORDER BY"),
			expect.stringContaining("type UInt64 -> UInt32"),
		])
	})

	it("modifies TTL without materializing it", () => {
		const Shorter = CH.table("service_counts", {
			columns: { OrgId: CH.string, ServiceName: CH.string, Spans: CH.uint64 },
			engine: CH.engine.summingMergeTree(),
			orderBy: ["OrgId", "ServiceName"],
			ttl: "now() + toIntervalDay(1)",
		})
		const { ops } = S.diffSchemas(Effect.runSync(S.entitiesOf([ServiceCounts])), Effect.runSync(S.entitiesOf([Shorter])))
		expect(ops.flatMap((op) => S.renderOp(op))).toEqual([
			"ALTER TABLE service_counts MODIFY TTL now() + toIntervalDay(1) SETTINGS materialize_ttl_after_modify = 0",
		])
	})

	it("ignores settings that only changed key order", () => {
		const make = (settings: Record<string, number>) =>
			CH.table("ordered", { columns: { a: CH.string }, engine: CH.engine.mergeTree(), orderBy: ["a"], settings })
		const before = Effect.runSync(S.entitiesOf([make({ index_granularity: 8192, merge_with_ttl_timeout: 3600 })]))
		const after = Effect.runSync(S.entitiesOf([make({ merge_with_ttl_timeout: 3600, index_granularity: 8192 })]))
		expect(S.diffSchemas(before, after).ops).toEqual([])
	})
})

describe("backfill", () => {
	const spec: S.BackfillSpec = {
		target: "totals",
		columns: ["OrgId", "Count"],
		from: "events",
		timeColumn: "Timestamp",
		select: "OrgId, count()",
		where: "OrgId != ''",
		groupBy: "OrgId",
	}
	const day = 86_400

	it("renders the whole source, or one window on the raw column", () => {
		expect(S.renderBackfill(spec)).toBe(
			"INSERT INTO totals (OrgId, Count)\nSELECT OrgId, count()\nFROM events\nWHERE (OrgId != '')\nGROUP BY OrgId",
		)
		expect(S.renderBackfill(spec, { from: day, to: 2 * day })).toBe(
			[
				"INSERT INTO totals (OrgId, Count)",
				"SELECT OrgId, count()",
				"FROM events",
				`WHERE (OrgId != '') AND Timestamp >= toDateTime(${day}) AND Timestamp < toDateTime(${2 * day})`,
				"GROUP BY OrgId",
				"SETTINGS prefer_column_name_to_alias = 1",
			].join("\n"),
		)
	})

	it("windows on the epoch, so a moved lower bound keeps the same windows", () => {
		expect(S.backfillWindows(spec, day + 5, 3 * day)).toEqual([
			{ from: day, to: 2 * day },
			{ from: 2 * day, to: 3 * day },
			{ from: 3 * day, to: 4 * day },
		])
		const weekly = { ...spec, windowDays: 7 }
		expect(S.backfillWindows(weekly, 8 * day, 9 * day)).toEqual([{ from: 7 * day, to: 14 * day }])
		expect(S.backfillWindows(spec, 0, 0)).toEqual([])
	})

	it("is labelled and never generated", () => {
		expect(S.labelOf({ op: "backfill", backfill: spec })).toBe("backfill")
	})
})

