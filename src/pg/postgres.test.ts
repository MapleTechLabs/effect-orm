// The Postgres dialect against a real Postgres: PGlite (Postgres 17 compiled to
// WASM), in-process. Every query here is compiled by the builder and executed,
// so a test passes only if Postgres parses the SQL, binds the params, and the
// rows decode through the declared types.

import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import type { CompiledQuery } from "../ch/compile"
import * as CH from "../index"
import * as PG from "../postgres"

// PGlite 0.5 takes the session time zone from the host; the fixtures assume UTC.
const db = new PGlite({ postgresqlconf: "timezone = 'UTC'" })

const events = CH.table(
	"events",
	{
		OrgId: PG.text,
		Service: PG.text,
		Count: PG.int8,
		Timestamp: PG.timestamptz,
		Ok: PG.bool,
		Attrs: PG.jsonb(),
	},
	{ tenantColumn: "OrgId" },
)

const services = CH.table("app.services", { OrgId: PG.text, Service: PG.text, Team: PG.nullable(PG.text) }, { tenantColumn: "OrgId" })

const tricky = "it's \\ a __PARAM_string_orgId__ value"

beforeAll(async () => {
	await db.exec(`
		CREATE SCHEMA app;
		CREATE TABLE events ("OrgId" text, "Service" text, "Count" int8, "Timestamp" timestamptz, "Ok" boolean, "Attrs" jsonb);
		CREATE TABLE app.services ("OrgId" text, "Service" text, "Team" text);
		INSERT INTO events VALUES
			('org_1', 'api', 10, '2026-01-01T00:00:10Z', true,  '{"region": "eu"}'),
			('org_1', 'api', 20, '2026-01-01T00:04:59Z', false, '{"region": "eu"}'),
			('org_1', 'web', 5,  '2026-01-01T00:05:00Z', true,  '{"region": "us"}'),
			('org_1', $$${tricky}$$, 1, '2026-01-01T01:00:00Z', true, '{}'),
			('org_2', 'api', 99, '2026-01-01T00:00:00Z', true,  '{"region": "eu"}');
		INSERT INTO app.services VALUES ('org_1', 'api', 'core'), ('org_1', 'web', NULL);
	`)
})

afterAll(async () => {
	await db.close()
})

const run = async <O>(compiled: CompiledQuery<O>): Promise<ReadonlyArray<O>> => {
	const result = await db.query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])
	return Effect.runPromise(compiled.decodeRows(result.rows))
}

describe("postgres dialect", () => {
	it("aggregates per group with bound params, FILTER, and quoted identifiers", async () => {
		const query = CH.from(events)
			.select(($) => ({
				service: $.Service,
				events: PG.count(),
				failures: PG.countIf($.Ok.eq(false)),
				total: PG.sum($.Count),
				average: PG.avg($.Count),
			}))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.in_("api", "web")])
			.groupBy("service")
			.orderBy(["service", "asc"])
		const compiled = PG.compileUnsafe(query, { orgId: "org_1" })

		expect(compiled.sql).toContain(`"OrgId" = $1`)
		expect(compiled.parameters).toEqual(["org_1"])
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(await run(compiled)).toEqual([
			{ service: "api", events: 2, failures: 1, total: 30, average: 15 },
			{ service: "web", events: 1, failures: 0, total: 5, average: 5 },
		])
	})

	it("decodes timestamptz and buckets with dateBin and dateTrunc in UTC", async () => {
		const query = CH.from(events)
			.select(($) => ({
				bucket: PG.dateBin(300, $.Timestamp),
				hour: PG.dateTrunc("hour", $.Timestamp),
				events: PG.count(),
			}))
			.where(($) => [
				$.OrgId.eq("org_1"),
				$.Timestamp.gte(CH.param.dateTime("start")),
				$.Timestamp.lt(CH.param.dateTime("end")),
			])
			.groupBy("bucket", "hour")
			.orderBy(["bucket", "asc"])
		const rows = await run(
			PG.compileUnsafe(query, {
				start: new Date("2026-01-01T00:00:00Z"),
				end: DateTime.makeUnsafe("2026-01-01T00:30:00Z"),
			}),
		)
		expect(rows.map((row) => [DateTime.formatIso(row.bucket), DateTime.formatIso(row.hour), row.events])).toEqual([
			["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 2],
			["2026-01-01T00:05:00.000Z", "2026-01-01T00:00:00.000Z", 1],
		])
	})

	it("joins a schema-qualified table, reads a subquery, and nulls a missing join value", async () => {
		const perService = CH.from(events)
			.select(($) => ({ OrgId: $.OrgId, Service: $.Service, total: PG.sum($.Count) }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
			.groupBy("OrgId", "Service")
		const query = CH.fromQuery(perService, "per")
			.innerJoin(services, "s", (per, s) => per.Service.eq(s.Service).and(per.OrgId.eq(s.OrgId)))
			.select(($) => ({ service: $.Service, team: PG.coalesce($.s.Team, CH.lit("none")), total: $.total }))
			.orderBy(["service", "asc"])
		const compiled = PG.compileUnsafe(query, { orgId: "org_1" })
		expect(compiled.sql).toContain(`INNER JOIN "app"."services" AS "s"`)
		expect(await run(compiled)).toEqual([
			{ service: "api", team: "core", total: 30 },
			{ service: "web", team: "none", total: 5 },
		])
	})

	it("runs a CTE and an ordered union, which Postgres needs aliased", async () => {
		const recent = CH.table("recent", { OrgId: PG.text, Count: PG.int8 })
		const cte = CH.from(recent)
			.withCTE(
				"recent",
				CH.from(events)
					.select(($) => ({ OrgId: $.OrgId, Count: $.Count }))
					.where(($) => [$.OrgId.eq(CH.param.string("orgId"))]),
			)
			.select(($) => ({ total: PG.sum($.Count) }))
		expect(await run(PG.compileUnsafe(cte, { orgId: "org_1" }))).toEqual([{ total: 36 }])

		const branch = (org: string) =>
			CH.from(events)
				.select(($) => ({ org: $.OrgId, total: PG.sum($.Count) }))
				.where(($) => [$.OrgId.eq(CH.param.string(org))])
				.groupBy("org")
		const union = PG.compileUnionUnsafe(
			CH.unionAll(branch("first"), branch("second")).orderBy(["total", "desc"]),
			{ first: "org_1", second: "org_2" },
		)
		expect(union.parameters).toEqual(["org_1", "org_2"])
		expect(await run(union)).toEqual([
			{ org: "org_2", total: 99 },
			{ org: "org_1", total: 36 },
		])
	})

	// The value spells a placeholder and carries a quote and a backslash, and is
	// matched three ways: as a bound param, as a column literal, and through
	// LIKE. Each has to reach Postgres as data, not as SQL or as a placeholder.
	it("keeps quotes, backslashes and the param marker inside values", async () => {
		const byParam = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.eq(CH.param.string("service"))])
		expect(await run(PG.compileUnsafe(byParam, { orgId: "org_1", service: tricky }))).toEqual([{ count: 1 }])

		const byLiteral = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Service.eq(tricky), $.Service.like("it's \\\\%")])
		const compiled = PG.compileUnsafe(byLiteral, { orgId: "org_1" })
		expect(compiled.sql).toContain(`E'it''s \\\\ a \\x5F_PARAM_string_orgId__ value'`)
		expect(compiled.parameters).toEqual(["org_1"])
		expect(await run(compiled)).toEqual([{ count: 1 }])
	})

	it("binds booleans and compares jsonb", async () => {
		const query = CH.from(events)
			.select(($) => ({ region: PG.jsonText($.Attrs, "region"), regions: PG.arrayAgg($.Service) }))
			.where(($) => [
				$.OrgId.eq("org_1"),
				$.Ok.eq(CH.param.bool("ok")),
				$.Attrs.neq({ region: "us" }),
			])
			.groupBy("region")
			.orderBy(["region", "asc"])
		const compiled = PG.compileUnsafe(query, { ok: true })
		expect(compiled.parameters).toEqual([true])
		expect(await run(compiled)).toEqual([
			{ region: "eu", regions: ["api"] },
			{ region: null, regions: [tricky] },
		])
	})

	it("computes an interpolated percentile", async () => {
		const query = CH.from(events)
			.select(($) => ({ p50: PG.percentileCont(0.5, $.Count), lowest: PG.min($.Count) }))
			.where(($) => [$.OrgId.eq("org_1")])
		expect(await run(PG.compileUnsafe(query, {}))).toEqual([{ p50: 7.5, lowest: 1 }])
	})

	it("refuses FORMAT and fails a missing param before reaching Postgres", () => {
		const query = CH.from(events)
			.select(($) => ({ count: $.Count }))
			.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
		expect(() => PG.compileUnsafe(query.format("JSON"), { orgId: "o" })).toThrow(/no FORMAT clause/)
		expect(() => PG.compileUnsafe(query, {})).toThrow(/no value given for param 'orgId'/)
	})
})

describe("postgres group by", () => {
	// An alias that shadows an input column: Postgres would group a bare
	// `GROUP BY "Service"` by the raw column, splitting 'api' and 'API'.
	it("groups by the selected expression, not a same-named input column", async () => {
		await db.exec(`INSERT INTO events VALUES ('org_3', 'API', 1, now(), true, '{}'), ('org_3', 'api', 2, now(), true, '{}')`)
		const query = CH.from(events)
			.select(($) => ({ Service: PG.lower($.Service), total: PG.sum($.Count) }))
			.where(($) => [$.OrgId.eq("org_3")])
			.groupBy("Service")
		const compiled = PG.compileUnsafe(query, {})
		expect(compiled.sql).toContain("GROUP BY 1")
		expect(await run(compiled)).toEqual([{ Service: "api", total: 3 }])
	})
})
