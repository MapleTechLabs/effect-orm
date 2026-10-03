# Schema and migrations

The query builder works with tables you manage elsewhere. If you would rather keep the schema
in TypeScript too, three entry points add that, all opt-in:

| Entry                              | Runs where         | What it does                                                                  |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `@maple-dev/effect-orm/schema`     | anywhere, pure     | `defineTable` / `materializedView`, DDL rendering, snapshots, the diff        |
| `@maple-dev/effect-orm/kit`        | Node or Bun        | `generate` and `check` over a migrations folder; the `effect-orm` command     |
| `@maple-dev/effect-orm/migrate`    | anywhere Effect runs | applies migrations through a driver you provide, `status`, `verify`        |

ClickHouse only, for now. The model follows drizzle-kit (a committed snapshot per migration,
an offline `generate`, data-loss confirmations by prompt or by hints), and the runtime is
built for a database without transactions.

## Defining tables

`defineTable` returns a `Table`, so every query API accepts it. Columns are the usual column
types, or `S.column(type, options)` for a default, a codec, or a comment. Keys, TTL, defaults,
and index expressions are SQL strings or DSL callbacks.

```ts title="migrations-schema.ts"
import * as CH from "@maple-dev/effect-orm"
import * as S from "@maple-dev/effect-orm/schema"

export const Requests = S.defineTable("requests", {
	columns: {
		OrgId: CH.custom("LowCardinality(String)", CH.string.schema),
		Timestamp: CH.dateTime,
		Route: CH.string,
		Status: S.column(CH.uint16, { default: 200 }),
	},
	engine: S.engine.mergeTree(),
	orderBy: ["OrgId", "Route", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: S.ttlAfterDays("toDate(Timestamp)", 30),
	indexes: [S.index("idx_status", ($) => $.Status, "set(100)")],
	tenantColumn: "OrgId",
})

export const RoutesHourly = S.defineTable("routes_hourly", {
	columns: { OrgId: CH.string, Hour: CH.dateTime, Route: CH.string, Requests: CH.uint64 },
	engine: S.engine.summingMergeTree(),
	orderBy: ["OrgId", "Hour", "Route"],
})

// The body is a DSL query. An output column the target lacks, or of another
// type, is a type error here rather than a failed insert later.
export const RoutesHourlyMv = S.materializedView("routes_hourly_mv", {
	to: RoutesHourly,
	as: CH.from(Requests)
		.select(($) => ({ OrgId: $.OrgId, Hour: CH.toStartOfHour($.Timestamp), Route: $.Route, Requests: CH.count() }))
		.groupBy("OrgId", "Hour", "Route"),
})

export const ddl = S.renderSchema(S.entitiesOf([Requests, RoutesHourly, RoutesHourlyMv]))
```

A definition that cannot become DDL (a MergeTree without `orderBy`, a name that is not a plain
identifier, a view writing to a table outside the schema) throws `SchemaDefinitionDefect` when
the module loads. `CH.dateTime64` renders as `DateTime64`, which ClickHouse reads as
`DateTime64(3)`; declare another precision with `CH.custom`.

Write engines as the plain family. Replicated engines and `ON CLUSTER` are render options
(`{ replicated: {}, cluster: "main" }`), so one schema serves a single server, a cluster, and
ClickHouse Cloud.

## Generating migrations

Create `effect-orm.config.ts`:

```ts
import { defineConfig } from "@maple-dev/effect-orm/kit"

export default defineConfig({
	schema: "./src/schema.ts",
	out: "./migrations",
})
```

Then `effect-orm generate --name add_status` (with Bun, or Node with type stripping) imports the
schema modules, diffs them against the newest snapshot in `out`, and writes
`migrations/<YYYYMMDDHHMMSS>_add_status/` holding `migration.json` and `snapshot.json`. It never
connects to a database. The plan it prints labels each statement:

- `metadata`: a schema change with no data rewrite.
- `ingest gap`: a materialized view is dropped and recreated. Inserts in between are not
  materialized by it. A view's body is fixed at creation, so this is the only way to change one.
- `destructive`: a table or column is dropped.

Drops need confirmation. In a terminal, `generate` asks. Without one, it exits with status 2,
writes nothing, and prints the hints to pass back:

```sh
effect-orm generate --hints '[{"type":"confirm_data_loss","kind":"column","entity":"requests.Route"}]'
```

Changes ClickHouse cannot make with `ALTER` (engine, sorting key, partition key, primary key,
column type) are reported and nothing is written. They need a table rebuild, which `generate`
does not write yet. Renames are not detected yet either: a rename reads as a drop plus an add,
and the drop asks for confirmation, so it never loses data silently.

`effect-orm generate --custom` writes an empty `migration.sql` for statements you write by hand
(separate them with a line holding `--> statement-breakpoint`). Its snapshot copies its parent's.

`effect-orm check` validates the folder: every snapshot id matches its contents, every parent
exists and sorts earlier, and branches merged from different pull requests touch different
tables. Independent branches are fine: the next `generate` records both as parents. Branches that
change the same table conflict; delete one migration and generate it again on top of the other.
Run `check` in CI.

## Applying migrations

The library opens no connection. Give it a `MigrationDriver`, usually built from the
`SqlClient` you query with. ClickHouse DDL has to go through the client's `asCommand`.

```ts title="migrations-run.ts"
import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect, Layer } from "effect"
import * as Migrate from "@maple-dev/effect-orm/migrate"

const Driver = Layer.effect(
	Migrate.MigrationDriver,
	Effect.gen(function* () {
		const sql = yield* ClickhouseClient.ClickhouseClient
		return Migrate.fromSqlClient(sql, { command: sql.asCommand })
	}),
)

export const program = Effect.gen(function* () {
	const migrations = yield* Migrate.fromRecord({
		"20261003120000_init": {
			kind: "sql",
			migration: "CREATE TABLE IF NOT EXISTS t (x UInt8) ENGINE = MergeTree ORDER BY x",
		},
	})
	const applied = yield* Migrate.run({ migrations, strict: true })
	const { drift } = yield* Migrate.verify(migrations)
	return { applied, drift }
}).pipe(
	Effect.provide(Driver),
	Effect.provide(ClickhouseClient.layer({ url: "http://localhost:8123" })),
)
```

`Migrate.fromFileSystem(dir)` reads a migrations folder through Effect's `FileSystem`; add a
`driver` layer to the config and the CLI runs `effect-orm migrate`, `status`, and `verify`.

How a run behaves:

- **Order** follows the snapshots' parent links, then names.
- **Pending** means not in the ledger, by name. An applied migration's hash is checked; with
  `strict` a changed file fails with `MigrateHashMismatch`, otherwise it logs a warning.
- **Each statement is journaled** in `_effect_orm_migration_steps` after it finishes, and the
  migration row in `_effect_orm_migrations` is written last. A run that fails partway leaves
  the migration `partial`; the next run skips the finished statements and resumes. A finished
  statement whose SQL has since changed fails the run with `MigrateStepChanged` instead of being
  skipped: edit only the failed statement and those after it.
- **Uncertain statements are never repeated.** `started` is journaled before a statement runs. If
  the process dies, or the `done` row cannot be written, the statement may or may not have run, and
  the next run stops there with `MigrateStepUncertain` (status `uncertain`). Check the database,
  then record what happened: `Migrate.resolveStep` or `effect-orm resolve <migration> <step>
  --ran | --not-ran`. A statement the server rejected is journaled `failed` and simply runs again.
- **A lease** in `_effect_orm_migration_lease` stops a second run while one is active. It is best
  effort: two runs starting in the same instant can both proceed. Serialize deploys if that
  matters.
- **No rollback.** Write a new migration. Prefer expand, then contract: add the new shape, move
  readers, and drop the old shape in a later migration.

`Migrate.verify` compares the database with the snapshot of the **last applied** migration, so a
database that is behind is reported as behind (`status`), not as drifted. The server normalizes
both sides (`formatQuery`, `defaultValueOfTypeName`). It checks tables, engine family, keys,
columns, skipping indexes, and view targets and bodies; it does not check TTL, codecs, settings,
or comments yet. `effect-orm verify` exits 3 when it finds drift.

_(Effect's own `ClickhouseMigrator` creates its ledger with a statement ClickHouse 26.8
rejects, and inserts ledger rows before running each migration. That is why this package has
its own runner.)_
