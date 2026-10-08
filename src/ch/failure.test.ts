import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit } from "effect"
import * as CH from "../clickhouse"
import * as PG from "../postgres"
import * as S from "../schema"
import { QueryBuilderDefect, QueryBuilderError } from "./errors"

const Events = CH.table("events", {
	columns: { Id: CH.string, Name: CH.string, Timestamp: CH.dateTime64 },
	engine: CH.engine.mergeTree(),
	orderBy: ["Id"],
})

const PgEvents = PG.table("events", { columns: { id: PG.text, score: PG.nullable(PG.float8) }, primaryKey: ["id"] })

describe("the builder never throws", () => {
	it("builds a bad query without throwing; compiling it reports the failure", () => {
		const build = () =>
			CH.from(Events)
				.select(($) => ({ matched: CH.sequenceMatch("'")($.Timestamp, $.Name.eq("a")), funnel: CH.windowFunnel(60)($.Timestamp) }))
				.where(($) => [$.Id.eq(CH.param.string("bad__name"))])
		expect(build).not.toThrow()
		expect(() => PG.from(PgEvents).select(($) => ({ p: PG.percentileCont(2, $.score) }))).not.toThrow()
	})

	it("fails a value it cannot use as a typed error", () => {
		const pageSize: number = -1
		const query = CH.from(Events).select(($) => ({ id: $.Id })).limit(pageSize)
		const error = Effect.runSync(Effect.flip(CH.compile(query)))
		expect(error).toBeInstanceOf(QueryBuilderError)
		expect(error.message).toMatch(/limit\(-1\)/)
	})

	it("dies on a misuse no input could fix", () => {
		const query = CH.from(Events).select(($) => ({ id: $.Id })).where(($) => [$.Id.eq(CH.param.string("bad__name"))])
		const exit = Effect.runSyncExit(CH.compile(query, { bad__name: "x" }))
		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(QueryBuilderDefect)
	})

	it("leaves no failure behind for the next compile when a callback throws", () => {
		const exploding = CH.from(Events).select(() => {
			throw new Error("boom")
		})
		expect(Exit.isFailure(Effect.runSyncExit(CH.compile(exploding)))).toBe(true)
		const fine = CH.from(Events).select(($) => ({ id: $.Id })).where(($) => [$.Id.eq("a")])
		expect(Effect.runSync(CH.compile(fine)).sql).toContain("FROM events")
	})

	it("records a definition's render failure as a schema problem", () => {
		const Broken = CH.table("broken", {
			columns: { score: CH.column(CH.float64, { default: Number.NaN }) },
			engine: CH.engine.mergeTree(),
			orderBy: [],
		})
		expect(Broken.problems.map((problem) => problem.message)).toEqual([expect.stringMatching(/NaN is not a valid value/)])
		expect(Effect.runSync(Effect.flip(S.entitiesOf([Broken]))).problems).toHaveLength(1)
	})
})
