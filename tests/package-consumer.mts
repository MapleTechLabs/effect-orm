// Copied into an isolated directory by check-package.ts. Nothing here may
// resolve dependencies or source files from Maple's workspace.
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm"
import * as F from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/types"
import * as Bench from "@maple-dev/effect-orm/benchmark"
import { makeHttpClient } from "@maple-dev/effect-orm/benchmark/http"
import { runCli } from "@maple-dev/effect-orm/benchmark/cli"
import * as SQL from "@maple-dev/effect-orm/sql"
import * as S from "@maple-dev/effect-orm/schema"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { defineConfig } from "@maple-dev/effect-orm/kit"

const events = CH.table("events", { id: T.uint64, name: T.string })
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
assert.equal(T.custom("String", Schema.String).sql, "String")
assert.equal(T.untyped("Tuple(String)").sql, "Tuple(String)")
const length = CH.defineFn<[CH.Expr<string>], number>("length", T.uint64)
assert.equal(SQL.compile(length(CH.lit("abc")).toFragment()), "length('abc')")
const invalid = Effect.runSync(Effect.exit(CH.compile(query, {})))
assert.equal(invalid._tag, "Failure")

const managed = S.defineTable("managed", {
	columns: { id: T.uint64, name: S.column(T.string, { default: "" }) },
	engine: S.engine.mergeTree(),
	orderBy: ["id"],
})
const counts = S.defineTable("counts", { columns: { name: T.string, n: T.uint64 }, engine: S.engine.summingMergeTree(), orderBy: ["name"] })
const countsMv = S.materializedView("counts_mv", {
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
	S.materializedView("bad_mv", { to: counts, as: CH.from(managed).select(($) => ({ missing: $.name })) })
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
