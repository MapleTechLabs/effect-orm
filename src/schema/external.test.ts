import { describe, expect, it } from "vitest"
import { expectTypeOf } from "expect-type"
import * as CH from "../clickhouse"
import * as PG from "../postgres"
import * as S from "../schema"

describe("external tables", () => {
	it("query like any table, with the name written verbatim", () => {
		const Numbers = CH.table("numbers(3)", { external: true, columns: { number: CH.uint64 } })
		const compiled = CH.compileUnsafe(CH.from(Numbers).select("number"))
		expect(compiled.sql).toContain("FROM numbers(3)")
	})

	it("allow no columns, for a FROM that only anchors constants", () => {
		const One = CH.table("system.one", { external: true, columns: {} })
		expect(CH.compileUnsafe(CH.from(One).select(() => ({ n: CH.lit(1) }))).sql).toContain("FROM system.one")
	})

	it("carry no DDL, so generate never sees them", () => {
		const Clicks = CH.table("clicks", { external: true, columns: { Url: CH.string } })
		const Views = PG.table("pg_stat_user_tables", { external: true, columns: { relname: PG.text } })
		expect(S.isSchemaObject(Clicks)).toBe(false)
		expect(S.isSchemaObject(Views)).toBe(false)
		expect("ddl" in Clicks).toBe(false)
	})

	it("keep column options for insert typing", () => {
		const Events = CH.table("events", {
			external: true,
			columns: {
				Name: CH.string,
				Status: CH.column(CH.uint16, { default: 200 }),
				Day: CH.column(CH.string, { materialized: "toString(toDate(now()))" }),
			},
			tenantColumn: "Name",
		})
		expect(Events.defaults).toEqual(["Status"])
		expect(Events.computed).toEqual(["Day"])
		expect(Events.tenantColumn).toBe("Name")
		expectTypeOf<CH.InsertRowOf<typeof Events>>().toEqualTypeOf<
			CH.InsertRow<{ readonly Name: CH.CHString; readonly Status: CH.CHUInt16; readonly Day: CH.CHString }, "Status", "Day">
		>()

		const Users = PG.table("users", {
			external: true,
			columns: { id: PG.column(PG.int8, { identity: "always" }), email: PG.text },
		})
		expect(Users.defaults).toEqual(["id"])
	})

	it("reject DDL options", () => {
		// @ts-expect-error an external table has no engine
		CH.table("t", { external: true, columns: { a: CH.string }, engine: CH.engine.memory() })
		// @ts-expect-error an external table has no primary key
		PG.table("t", { external: true, columns: { a: PG.text }, primaryKey: ["a"] })
	})
})
