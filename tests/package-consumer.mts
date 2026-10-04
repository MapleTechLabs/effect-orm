// Copied into an isolated directory by check-package.ts. Nothing here may
// resolve dependencies or source files from Maple's workspace.
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as F from "@maple-dev/effect-orm/expr"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { makeHttpClient } from "@maple-dev/effect-orm/benchmark/http"
import { runCli } from "@maple-dev/effect-orm/benchmark/cli"
import * as SQL from "@maple-dev/effect-orm/sql"
import * as S from "@maple-dev/effect-orm/schema"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import * as Db from "@maple-dev/effect-orm/database"
import { defineConfig } from "@maple-dev/effect-orm/kit"

const events = CH.table("events", { external: true, columns: { id: CH.uint64, name: CH.string } })
const query = CH.from(events)
	.select(($) => ({ id: CH.toString($.id), name: F.lower_($.name) }))
	.where(($) => [$.name.eq(CH.param.string("name"))])
const compiled = await Effect.runPromise(CH.compile(query, { name: "O'Reilly" }))
assert.match(compiled.sql, /FROM events/)
assert.equal(compiled.rowSchemaSource, "derived")
const rows = await Effect.runPromise(compiled.decodeRows([{ id: "18446744073709551615", name: "maple" }]))
const typed: readonly { readonly id: string; readonly name: string }[] = rows
assert.equal(typed[0]?.id, "18446744073709551615")
assert.deepEqual(await Effect.runPromise(compiled.encodeRows(rows)), rows)
assert.equal(SQL.compile(SQL.str("O'Reilly")), "'O\\'Reilly'")
assert.equal(CH.custom("String", Schema.String).sql, "String")
assert.equal(CH.untyped("Tuple(String)").sql, "Tuple(String)")
const length = CH.defineFn<[CH.Expr<string>], number>("length", CH.uint64)
assert.equal(SQL.compile(length(CH.lit("abc")).toFragment()), "length('abc')")
// @ts-expect-error -- a missing param is a type error too; this checks the runtime failure
const invalid = Effect.runSync(Effect.exit(CH.compile(query, {})))
assert.equal(invalid._tag, "Failure")

const managed = CH.table("managed", {
	columns: { id: CH.uint64, name: CH.column(CH.string, { default: "" }) },
	engine: CH.engine.mergeTree(),
	orderBy: ["id"],
})
const counts = CH.table("counts", { columns: { name: CH.string, n: CH.uint64 }, engine: CH.engine.summingMergeTree(), orderBy: ["name"] })
const countsMv = CH.materializedView("counts_mv", {
	to: counts,
	as: CH.from(managed).select(($) => ({ name: $.name, n: CH.count() })).groupBy("name"),
})
assert.match(CH.compileUnsafe(CH.from(managed).select("name"), {}).sql, /FROM managed/)
const created = S.diffSchemas([], S.entitiesOf([managed, counts, countsMv]))
assert.deepEqual(created.ops.map((op) => op.op), ["create_table", "create_table", "create_view"])
assert.match(created.ops.flatMap((op) => S.renderOp(op)).join("\n"), /name String DEFAULT ''/)
const loaded = await Effect.runPromise(
	Migrate.fromRecord({ "20260101000000_init": { kind: "ops", migration: JSON.stringify({ version: "1", ops: created.ops }) } }),
)
assert.equal(Migrate.stepsOf(loaded[0]!).length, 3)
assert.equal(defineConfig({ schema: "./schema.ts", out: "./migrations" }).out, "./migrations")

// Compile-only negative assertions verify that published declarations retain
// column checking and inferred row types.
const checkTypes = () => {
	// @ts-expect-error an unknown column must not typecheck
	CH.from(events).select("missing")
	// @ts-expect-error the selected ID is a string after toString
	const id: number = rows[0]!.id
	void id
	// @ts-expect-error a view output column the target table lacks must not typecheck
	CH.materializedView("bad_mv", { to: counts, as: CH.from(managed).select(($) => ({ missing: $.name })) })
}
void checkTypes
console.log("Isolated tarball imports, types, compilation and codecs passed")

const suite = await Effect.runPromise(
	Bench.defineSuite({
		name: "consumer",
		dataset: "snapshot",
		cases: [
			Bench.query({
				id: "events/name",
				inputs: { name: "Maple" },
				compile: (inputs) => CH.compile(query, inputs),
				results: "unordered",
			}),
		],
	}),
)
assert.equal(suite.samples[0]?.id, "events/name")
assert.match(suite.samples[0]!.sampleSql, /Maple/)
assert.equal(
	await Effect.runPromise(makeHttpClient({ url: "http://localhost:8123" }).target),
	"http://localhost:8123",
)
assert.equal(typeof runCli, "function")

assert.equal(typeof Db.fromSqlClient, "function")
assert.equal(Db.isContention(new Db.DatabaseError({ message: "x", sql: "", reason: "SerializationError", cause: undefined })), true)
