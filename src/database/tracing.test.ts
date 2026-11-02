// The client span `Database` opens per statement, checked on PGlite with a
// tracer that records spans, against the OpenTelemetry database conventions.
import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Tracer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as PG from "../postgres"
import { postgresDialect } from "../pg/dialect"
import * as Db from "../database"

const spans: Array<Tracer.NativeSpan> = []
const recording = Tracer.make({
	span(options) {
		const span = new Tracer.NativeSpan({ ...options, sampled: true })
		spans.push(span)
		return span
	},
})

const Live = Layer.effect(
	Db.Database,
	Effect.gen(function* () {
		return Db.fromSqlClient(yield* SqlClient.SqlClient, { dialect: postgresDialect })
	}),
).pipe(Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })))

const Items = PG.table("traced_items", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })

/** Runs `effect` traced, and returns the spans it opened, by name. */
const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		spans.length = 0
		const exit = yield* Effect.exit(Effect.withTracer(effect, recording))
		return { exit, spans: [...spans] }
	})

const dbSpan = (recorded: ReadonlyArray<Tracer.NativeSpan>) => {
	const span = recorded.find((s) => s.attributes.has("db.system.name") && !s.attributes.has("effect.sql.method"))
	assert(span !== undefined, `no statement span among ${recorded.map((s) => s.name).join(", ")}`)
	return span
}

layer(Live)("Database statement spans", (it) => {
	it.effect("creates the table", () =>
		Db.execute(Db.sql`CREATE TABLE traced_items (id int4 PRIMARY KEY, name text NOT NULL)`),
	)

	it.effect("names a SELECT after its operation and table, as a client span", () =>
		Effect.gen(function* () {
			const { exit, spans } = yield* traced(
				Db.run(PG.from(Items).select(($) => ({ name: $.name })).where(($) => [$.id.eq(PG.param.int("id"))]), { id: 1 }),
			)
			assert(Exit.isSuccess(exit))
			const span = dbSpan(spans)
			expect(span.name).toBe("SELECT traced_items")
			expect(span.kind).toBe("client")
			expect(Object.fromEntries(span.attributes)).toMatchObject({
				"db.system.name": "postgresql",
				"db.operation.name": "SELECT",
				"db.collection.name": "traced_items",
				"db.query.summary": "SELECT traced_items",
				"db.response.returned_rows": 0,
			})
			// Effect's own span runs inside it, carrying the query text.
			const execute = spans.find((s) => s.attributes.has("effect.sql.method"))
			assert(execute !== undefined)
			expect(Option.getOrUndefined(execute.parent)).toBe(span)
		}),
	)

	it.effect("names a write after its target table and counts RETURNING rows", () =>
		Effect.gen(function* () {
			const { exit, spans } = yield* traced(
				Db.run(PG.insertInto(Items).values({ id: 2, name: "two" }).returning(($) => ({ id: $.id }))),
			)
			assert(Exit.isSuccess(exit))
			const span = dbSpan(spans)
			expect(span.name).toBe("INSERT traced_items")
			expect(span.attributes.get("db.collection.name")).toBe("traced_items")
			expect(span.attributes.get("db.response.returned_rows")).toBe(1)
		}),
	)

	it.effect("leaves the table out when there is no single one", () =>
		Effect.gen(function* () {
			const inner = PG.from(Items).select(($) => ({ name: $.name }))
			const { spans } = yield* traced(Db.run(PG.fromQuery(inner, "sub").select(($) => ({ name: $.name }))))
			const span = dbSpan(spans)
			expect(span.name).toBe("SELECT")
			expect(span.attributes.has("db.collection.name")).toBe(false)
		}),
	)

	it.effect("takes the summary from withQuerySummary", () =>
		Effect.gen(function* () {
			const { spans } = yield* traced(
				Db.run(PG.from(Items).select(($) => ({ id: $.id }))).pipe(Db.withQuerySummary("items.list")),
			)
			const span = dbSpan(spans)
			expect(span.name).toBe("items.list")
			expect(span.attributes.get("db.query.summary")).toBe("items.list")
			expect(span.attributes.get("db.operation.name")).toBe("SELECT")
		}),
	)

	it.effect("records error.type from a DatabaseError's reason", () =>
		Effect.gen(function* () {
			const { exit, spans } = yield* traced(Db.execute(Db.sql`SELEKT 1`))
			assert(Exit.isFailure(exit))
			const span = dbSpan(spans)
			expect(span.attributes.get("error.type")).toBe("SqlSyntaxError")
			expect(span.status._tag).toBe("Ended")
		}),
	)
})

describe("collection", () => {
	it("is the FROM table, or the written table, and absent otherwise", () => {
		const select = PG.compileUnsafe(PG.from(Items).select(($) => ({ id: $.id })))
		expect(select.collection).toBe("traced_items")
		const write = PG.compileUnsafe(PG.deleteFrom(Items).where(($) => [$.id.eq(1)]))
		expect(write.collection).toBe("traced_items")
		const cte = PG.compileUnsafe(
			PG.from(PG.table("recent", { external: true, columns: { id: PG.int4 } }))
				.withCTE("recent", PG.from(Items).select(($) => ({ id: $.id })))
				.select(($) => ({ id: $.id })),
		)
		expect(cte.collection).toBeUndefined()
	})
})
