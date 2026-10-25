// ClickHouse columns declared under a key other than their database name:
// `orgId: CH.column(CH.string, { name: "org_id" })`. The DDL, every statement
// and the tenant scope write the database name; rows decode under the key.
// tests/column-names.clickhouse.test.ts runs the same table on a live server.

import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CH from "../clickhouse"
import * as S from "../schema"

const Requests = CH.table("requests", {
	columns: {
		orgId: CH.column(CH.string, { name: "org_id" }),
		at: CH.column(CH.dateTime, { name: "created_at", defaultExpr: "now()" }),
		route: CH.string,
		status: CH.column(CH.uint16, { name: "status_code", default: 200 }),
		hour: CH.column(CH.dateTime, { name: "created_hour", materialized: ($) => CH.toStartOfHour($.at) }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["orgId", "route", "at"],
	primaryKey: ["orgId", "route"],
	partitionBy: ($) => CH.toStartOfHour($.at),
	indexes: [CH.index("idx_status", ($) => $.status, "minmax")],
	tenantColumn: "orgId",
})

describe("ClickHouse column names", () => {
	it("writes the database names into the DDL and keeps keys out of it", () => {
		const [ddl] = S.renderSchema(Effect.runSync(S.entitiesOf([Requests])))
		expect(ddl).toContain("\torg_id String,")
		expect(ddl).toContain("\tcreated_at DateTime DEFAULT now(),")
		expect(ddl).toContain("\tstatus_code UInt16 DEFAULT 200,")
		expect(ddl).toContain("\tcreated_hour DateTime MATERIALIZED toStartOfHour(created_at),")
		expect(ddl).toContain("INDEX idx_status status_code TYPE minmax")
		expect(ddl).toContain("PARTITION BY toStartOfHour(created_at)")
		expect(ddl).toContain("ORDER BY (org_id, route, created_at)")
		expect(ddl).toContain("PRIMARY KEY (org_id, route)")
		expect(ddl).not.toMatch(/\b(orgId|at|status|hour)\b/)
	})
})

describe("ClickHouse statements over renamed columns", () => {
	it("selects, filters, orders and scopes by the database names and reads rows under the keys", async () => {
		const compiled = CH.compileUnsafe(
			CH.from(Requests)
				.select(($) => ({ orgId: $.orgId, route: $.route, status: $.status, hour: $.hour }))
				.where(($) => [$.orgId.eq(CH.param.string("orgId")), $.status.gte(500)])
				.orderBy(($) => [[$.at, "desc"]]),
			{ orgId: "o1" },
		)
		expect(compiled.sql).toContain("requests.org_id AS orgId")
		expect(compiled.sql).toContain("requests.status_code AS status")
		expect(compiled.sql).toContain("requests.created_hour AS hour")
		expect(compiled.sql).toContain("WHERE requests.org_id = 'o1'")
		expect(compiled.sql).toContain("ORDER BY requests.created_at DESC")
		expect(compiled.tenantScope).toBe("single-tenant")
		const rows = await Effect.runPromise(
			compiled.decodeRows([{ orgId: "o1", route: "/a", status: 503, hour: "2026-01-01 10:00:00" }]),
		)
		expect(rows.map((row) => [row.orgId, row.route, row.status])).toEqual([["o1", "/a", 503]])
	})

	it("inserts, updates and deletes by the database names", () => {
		const insert = CH.compileUnsafe(CH.insertInto(Requests).values({ orgId: "o1", route: "/a", status: 201 }))
		expect(insert.sql).toContain("INSERT INTO requests (org_id, route, status_code)")
		const update = CH.compileUnsafe(
			CH.update(Requests).set({ status: 500 }).where(($) => [$.orgId.eq("o1"), $.route.eq("/a")]),
		)
		expect(update.sql).toContain("status_code = 500")
		expect(update.sql).toContain("org_id = 'o1'")
		expect(update.tenantScope).toBe("single-tenant")
		const remove = CH.compileUnsafe(CH.deleteFrom(Requests).where(($) => [$.orgId.eq("o1")]))
		expect(remove.sql).toContain("org_id = 'o1'")
		expect(remove.sql).not.toMatch(/\borgId\b/)
	})

	it("leaves a renamed column without a default required on insert", () => {
		// @ts-expect-error route has no default, and orgId's name gives it none
		CH.insertInto(Requests).values({ route: "/a" })
		CH.insertInto(Requests).values({ orgId: "o1", route: "/a" })
		// @ts-expect-error hour is MATERIALIZED, so an insert may not write it
		CH.insertInto(Requests).values({ orgId: "o1", route: "/a", hour: new Date() })
	})
})

describe("materialized views and renamed columns", () => {
	const Counts = CH.table("route_counts", {
		columns: { orgId: CH.string, route: CH.string, hits: CH.uint64 },
		engine: CH.engine.summingMergeTree(),
		orderBy: ["orgId", "route"],
	})

	it("reads a renamed source column by its database name", () => {
		const view = CH.materializedView("route_counts_mv", {
			to: Counts,
			as: CH.from(Requests)
				.select(($) => ({ orgId: $.orgId, route: $.route, hits: CH.count() }))
				.groupBy("orgId", "route"),
		})
		expect(view.problems).toEqual([])
		expect(view.ddl.select).toContain("requests.org_id AS orgId")
	})

	it("records a problem for a target with renamed columns, which the view would miss", () => {
		const Renamed = CH.table("route_counts_renamed", {
			columns: { orgId: CH.column(CH.string, { name: "org_id" }), route: CH.string, hits: CH.uint64 },
			engine: CH.engine.summingMergeTree(),
			orderBy: ["orgId", "route"],
		})
		const view = CH.materializedView("route_counts_renamed_mv", {
			to: Renamed,
			as: CH.from(Requests)
				.select(($) => ({ orgId: $.orgId, route: $.route, hits: CH.count() }))
				.groupBy("orgId", "route"),
		})
		expect(view.problems.map((problem) => problem.message)).toEqual([
			"route_counts_renamed renames orgId to org_id; a materialized view writes its output by database name, so give the target column no name",
		])
	})
})

describe("ClickHouse casing", () => {
	it("names each column without a name by drizzle's snake_case rule", () => {
		const Cased = CH.table("cased", {
			casing: "snake_case",
			columns: {
				orgId: CH.string,
				OrgName: CH.string,
				HTTPStatus: CH.uint16,
				userID: CH.string,
				address2: CH.string,
				already_snake: CH.string,
				renamed: CH.column(CH.string, { name: "kept" }),
			},
			engine: CH.engine.mergeTree(),
			orderBy: ["orgId"],
		})
		expect(Cased.ddl.columns.map((column) => column.name)).toEqual([
			"org_id",
			"org_name",
			"http_status",
			"user_id",
			"address2",
			"already_snake",
			"kept",
		])
		expect(CH.compileUnsafe(CH.from(Cased).select("HTTPStatus")).sql).toContain("cased.http_status AS HTTPStatus")
	})
})
