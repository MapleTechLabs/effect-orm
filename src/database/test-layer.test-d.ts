// Type-level tests: `layerTest` needs nothing and gives both services.

import { Effect, Layer } from "effect"
import { expectTypeOf } from "expect-type"
import * as CH from "../ch/index"
import * as PG from "../postgres"
import * as Db from "../database"

const Live = Db.layerTest({ dialect: PG.postgresDialect })
expectTypeOf(Live).toEqualTypeOf<Layer.Layer<Db.Database | Db.TestDatabase>>()

// Rows from `run` keep the query's row type; the layer removes only `Database`.
const Items = CH.table("t", { id: PG.int4, note: PG.text })
const rows = Db.run(PG.from(Items).select("id", "note")).pipe(Effect.provide(Live))
expectTypeOf(rows).toEqualTypeOf<
	Effect.Effect<
		ReadonlyArray<{ readonly id: number; readonly note: string }>,
		Db.DatabaseError | CH.QueryBuilderError | CH.CompiledQueryDecodeError
	>
>()

// A reply is rows or a driver error, nothing else.
// @ts-expect-error -- a bare row is not a reply
Effect.flatMap(Db.TestDatabase.asEffect(), (test) => test.reply({ id: 1 }))
